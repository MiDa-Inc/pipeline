import { resolve } from 'node:path';

import type {
  AgentHandle,
  DeadlineEpochMs,
  PaneId,
  RuntimeAdapter,
  TurnId,
} from '@pipeline/runtime';

import type { NodeName, Round } from '../runlog/events.js';
import type { RunLog } from '../runlog/log.js';
import { parseVerdict, type Verdict } from '../verdict.js';
import type { SkeletonConfig } from './config.js';

/**
 * The skeleton engine's hard-coded loop: implementer, gate, reviewer, and back again.
 *
 * Both back edges — a failing gate and a `revise` verdict — return to the implementer, and each
 * re-entry is checked against the round limit first (SPEC R3): the candidate round is compared with
 * `max_rounds`, and if it exceeds it the run escalates `max_rounds` before any prompt is sent and
 * before `node_started` is emitted, recording the **stored** round rather than the refused one.
 *
 * It is still deliberately partial. What the runtime reports outside the settled path — a blocked
 * turn, a missing verdict, an agent that will not start — stops the run with {@link UnsupportedPath}
 * rather than being handled. An `unrouted` escalation is never written: that would claim the
 * pipeline is defective when only this engine is.
 */

export type UnsupportedReason =
  /** A valid outcome this engine cannot route. Its `node_finished` has been recorded. */
  | 'back_edge'
  /** The runtime reported something the forward path has no answer for. Nothing was recorded. */
  | 'observation'
  /** A verdict node settled without a verdict. No outcome exists to record. */
  | 'missing_verdict';

export class UnsupportedPath extends Error {
  constructor(
    readonly reason: UnsupportedReason,
    readonly node: NodeName,
    readonly round: Round,
    detail: string,
  ) {
    super(`${node} round ${round}: ${detail}`);
    this.name = 'UnsupportedPath';
  }
}

export interface SkeletonRun {
  readonly config: SkeletonConfig;
  readonly runtime: RuntimeAdapter;
  readonly log: RunLog;
  readonly task: string;
  /** Where agents and the gate run. Not part of the pipeline definition. */
  readonly cwd: string;
}

/**
 * A run that finished, or one left paused with the entry R3 refused.
 *
 * `pendingEntry.round` is the **candidate** — the round that was refused — because that is what a
 * grant of extra rounds would accept. The `escalated` event and the replayed state keep the stored
 * round, so the log never claims a round the run did not reach.
 */
export type SkeletonOutcome =
  | { readonly status: 'done' }
  | {
      readonly status: 'paused';
      readonly pendingEntry: { readonly node: NodeName; readonly round: Round };
    };

/** Hard-coded for the skeleton; step 11 replaces these with the pipeline's own messages. */
const PROMPTS = {
  implementer: (task: string, findings?: string) =>
    findings === undefined
      ? `${task}\n\nImplement this. Write code and tests, then stop.`
      : `${task}\n\nAddress the findings in ${findings}. Write code and tests, then stop.`,
  /** `gateOutput` is absolute, so it resolves from the reviewer's working directory. */
  reviewer: (task: string, gateOutput: string) =>
    `${task}\n\nThe gate's output is in ${gateOutput}.\n\nReview the current diff. Finish with exactly one line, either "VERDICT: APPROVE" or "VERDICT: REVISE".`,
};

export async function runSkeleton(run: SkeletonRun): Promise<SkeletonOutcome> {
  const { config, runtime, log, task, cwd } = run;
  let round: Round = 1;
  /** The handoff the next implementer prompt points at, absolute so it opens from any directory. */
  let findings: string | undefined;
  const turnDeadline = (): DeadlineEpochMs => Date.now() + config.turnTimeoutMs;

  const start = async (label: NodeName, profile: string, into?: PaneId): Promise<AgentHandle> => {
    const pane = await runtime.createLayout({
      destination:
        into === undefined
          ? { kind: 'new_workspace' }
          : { kind: 'split', pane: into, direction: 'right' },
      cwd,
      label,
    });
    const launched = await runtime.launchAgent(pane, profile, turnDeadline());
    if (launched.kind !== 'ready')
      throw new UnsupportedPath('observation', label, round, `launched ${launched.kind}`);
    return launched.agent;
  };

  /** One agent turn, from prompt to settled text. Anything else stops the run. */
  const ask = async (node: NodeName, agent: AgentHandle, prompt: string): Promise<TurnId> => {
    const deadline = turnDeadline();
    const submission = runtime.promptAgent(agent, prompt, deadline);
    const submitted = await submission.submitted;
    if (submitted.kind !== 'accepted')
      throw new UnsupportedPath('observation', node, round, `submission was ${submitted.kind}`);
    const observed = await runtime.observeAgentTurn(submission.turnId, deadline);
    if (observed.kind !== 'settled')
      throw new UnsupportedPath('observation', node, round, `turn was ${observed.kind}`);
    return submission.turnId;
  };

  /**
   * Re-enter the start node, or refuse (SPEC R3).
   *
   * The candidate is computed first and checked against the limit, and only an accepted candidate
   * becomes the stored round. A refusal escalates with the round still stored, before anything is
   * prompted and before the entry is announced.
   */
  const reenter = (): SkeletonOutcome | undefined => {
    const candidate = round + 1;
    if (candidate <= config.maxRounds) {
      round = candidate;
      return undefined;
    }
    log.append({ type: 'escalated', node: 'implementer', round, reason: 'max_rounds' });
    return { status: 'paused', pendingEntry: { node: 'implementer', round: candidate } };
  };

  log.append({ type: 'run_started', pipeline: config.name, task });
  const implementer = await start('implementer', config.implementer.profile);
  const reviewer = await start('reviewer', config.reviewer.profile, implementer.pane);

  for (;;) {
    log.append({ type: 'node_started', node: 'implementer', round });
    await ask('implementer', implementer, PROMPTS.implementer(task, findings));
    log.append({ type: 'node_finished', node: 'implementer', round, outcome: 'done' });

    log.append({ type: 'node_started', node: 'test_gate', round });
    const gateDeadline = Date.now() + config.gate.timeoutMs;
    const launch = runtime.startProcess(
      { node: 'test_gate', command: config.gate.run, cwd },
      gateDeadline,
    );
    const started = await launch.started;
    if (started.kind !== 'accepted')
      throw new UnsupportedPath('observation', 'test_gate', round, `launch was ${started.kind}`);
    const ran = await runtime.observeProcess(launch.executionId, gateDeadline);
    if (ran.kind !== 'completed')
      throw new UnsupportedPath('observation', 'test_gate', round, `execution was ${ran.kind}`);
    // The gate's output is written before the outcome that routes on it, so whatever reads it next
    // is reading a file that already exists (SPEC R11).
    const report = log.writeHandoff('test_gate', round, ran.output);
    const passed = ran.exitStatus === 0;
    log.append({
      type: 'node_finished',
      node: 'test_gate',
      round,
      outcome: passed ? 'pass' : 'fail',
    });
    if (!passed) {
      // `resolve` rather than `join`: the run folder may itself be relative, and the implementer's
      // working directory is not this process's. The recorded event keeps its run-relative path.
      findings = resolve(log.paths.root, report.path);
      const refused = reenter();
      if (refused !== undefined) return refused;
      continue;
    }

    log.append({ type: 'node_started', node: 'reviewer', round });
    const turn = await ask(
      'reviewer',
      reviewer,
      PROMPTS.reviewer(task, resolve(log.paths.root, report.path)),
    );
    const output = await runtime.readAgentOutput(turn);
    if (output.kind !== 'available')
      throw new UnsupportedPath('observation', 'reviewer', round, `output was ${output.reason}`);
    const verdict: Verdict = parseVerdict(output.text);
    if (verdict === 'missing')
      throw new UnsupportedPath(
        'missing_verdict',
        'reviewer',
        round,
        'the turn carried no verdict',
      );

    if (verdict === 'revise') {
      // The findings are on disk before the outcome that routes on them, and before the prompt
      // that will point at them.
      const review = log.writeHandoff('reviewer', round, output.text);
      log.append({ type: 'node_finished', node: 'reviewer', round, outcome: 'revise' });
      findings = resolve(log.paths.root, review.path);
      const refused = reenter();
      if (refused !== undefined) return refused;
      continue;
    }

    log.append({ type: 'node_finished', node: 'reviewer', round, outcome: 'approve' });
    log.append({ type: 'node_started', node: 'done', round });
    log.append({ type: 'run_finished', status: 'done' });
    return { status: 'done' };
  }
}
