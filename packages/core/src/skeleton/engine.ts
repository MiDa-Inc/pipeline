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
 * The skeleton engine's single forward pass: implementer, gate, reviewer, end.
 *
 * It is deliberately partial. Only the path that goes forward is implemented, so a `fail` or a
 * `revise` — both legitimate outcomes — stop the run with {@link UnsupportedPath} rather than being
 * routed. A completed node still records the outcome it produced before that happens: the outcome
 * is a fact, and refusing to route it is this engine's limitation, not the run's. What is never
 * written is a `node_started` for the target, a `run_finished`, or an `unrouted` escalation — the
 * last of those would claim the pipeline is defective when only this engine is.
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

export interface ForwardPass {
  readonly config: SkeletonConfig;
  readonly runtime: RuntimeAdapter;
  readonly log: RunLog;
  readonly task: string;
  /** Where agents and the gate run. Not part of the pipeline definition. */
  readonly cwd: string;
}

/** Hard-coded for the skeleton; step 11 replaces these with the pipeline's own messages. */
const PROMPTS = {
  implementer: (task: string) => `${task}\n\nImplement this. Write code and tests, then stop.`,
  /** `gateOutput` is absolute, so it resolves from the reviewer's working directory. */
  reviewer: (task: string, gateOutput: string) =>
    `${task}\n\nThe gate's output is in ${gateOutput}.\n\nReview the current diff. Finish with exactly one line, either "VERDICT: APPROVE" or "VERDICT: REVISE".`,
};

export async function runForwardPass(pass: ForwardPass): Promise<void> {
  const { config, runtime, log, task, cwd } = pass;
  const round: Round = 1;
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

  /** One agent turn, from prompt to settled text. Anything else stops the pass. */
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

  log.append({ type: 'run_started', pipeline: config.name, task });
  const implementer = await start('implementer', config.implementer.profile);
  const reviewer = await start('reviewer', config.reviewer.profile, implementer.pane);

  log.append({ type: 'node_started', node: 'implementer', round });
  await ask('implementer', implementer, PROMPTS.implementer(task));
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
  if (!passed)
    throw new UnsupportedPath('back_edge', 'test_gate', round, 'fail routes back to implementer');

  log.append({ type: 'node_started', node: 'reviewer', round });
  // The prompt names the file written above, so the reviewer is told where to read it rather than
  // being handed a path it would have to guess (SPEC R11). `resolve` rather than `join`: the run
  // folder may itself be relative, and the reviewer's working directory is not this process's.
  // Only the prompt is absolute — the recorded event keeps its run-relative path.
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
    throw new UnsupportedPath('missing_verdict', 'reviewer', round, 'the turn carried no verdict');
  log.append({ type: 'node_finished', node: 'reviewer', round, outcome: verdict });
  if (verdict === 'revise')
    throw new UnsupportedPath('back_edge', 'reviewer', round, 'revise routes back to implementer');

  log.append({ type: 'node_started', node: 'done', round });
  log.append({ type: 'run_finished', status: 'done' });
}
