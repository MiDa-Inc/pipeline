import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeRuntime, type ScenarioInput } from '@pipeline/runtime';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { PipelineEvent } from '../src/runlog/events.js';
import { openRunLog, readEvents } from '../src/runlog/log.js';
import { replay } from '../src/runlog/state.js';
import { parseSkeletonConfig } from '../src/skeleton/config.js';
import { runForwardPass, UnsupportedPath } from '../src/skeleton/engine.js';

const spec = (name: string) => fileURLToPath(new URL(`../../../spec/${name}`, import.meta.url));
const golden = (name: string) =>
  parseYaml(readFileSync(spec(`scenarios/${name}.yaml`), 'utf8')) as {
    task: string;
    inputs: ScenarioInput[];
    expect: PipelineEvent[];
  };

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validEvent = ajv.compile(
  JSON.parse(readFileSync(spec('events.schema.json'), 'utf8')) as object,
);

const PANES = { 'w1:p1': 'implementer', 'w1:p2': 'reviewer' };
const config = (name = 'feature-loop', maxRounds = 5) =>
  parseSkeletonConfig(
    `version: 1\nname: ${name}\nlimits: { max_rounds: ${maxRounds}, turn_timeout: 60m }\n` +
      `nodes:\n  implementer: { profile: claude-code }\n` +
      `  test_gate: { run: npm test, timeout: 10m }\n  reviewer: { profile: codex }\n`,
    'test.yaml',
  );

/** `ts` and `run_id` are excluded from determinism comparison (SPEC R15); everything else is not. */
const comparable = (events: readonly PipelineEvent[]) =>
  events.map((event) => {
    const rest: Record<string, unknown> = { ...event };
    delete rest['ts'];
    delete rest['run_id'];
    return rest;
  });

const drive = async (inputs: ScenarioInput[], task = 'A task', extra: object = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-skeleton-'));
  const runtime = createFakeRuntime({ inputs, panes: PANES, ...extra });
  const log = openRunLog(dir, 'run-1');
  const outcome = await runForwardPass({ config: config(), runtime, log, task, cwd: '/repo' })
    .then(() => undefined)
    .catch((error: unknown) => error);
  return { dir, runtime, log, outcome, events: readEvents(log.paths.events).events };
};

describe('a forward pass', () => {
  it('reproduces approve-round-1 exactly', async () => {
    const scenario = golden('approve-round-1');
    const { outcome, events } = await drive(scenario.inputs, scenario.task);
    expect(outcome).toBeUndefined();
    expect(comparable(events)).toEqual(comparable(scenario.expect));
  });

  it('emits only events the schema accepts', async () => {
    const scenario = golden('approve-round-1');
    const { events } = await drive(scenario.inputs, scenario.task);
    for (const event of events) expect(validEvent(event) || validEvent.errors).toBe(true);
  });

  it.each([
    ['an absolute run folder', (dir: string) => dir],
    // the run folder may be given relatively; the reviewer's cwd is not this process's, so a
    // relative path in the prompt would name a file the reviewer cannot open
    ['a relative run folder', (dir: string) => relative(process.cwd(), dir)],
  ])('hands the reviewer a readable path to the gate output, given %s', async (_label, base) => {
    const scenario = golden('approve-round-1');
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-skeleton-'));
    const runtime = createFakeRuntime({ inputs: scenario.inputs, panes: PANES });
    const log = openRunLog(base(dir), 'run-1');

    // Observe from inside the reviewer's own promptAgent call. Checking after the run finished
    // would say nothing about whether the file and its event existed when the prompt was sent.
    let seen: { prompt: string; recorded?: string; contents?: string } | undefined;
    const watched = Object.create(runtime) as typeof runtime;
    watched.promptAgent = (agent, prompt, deadline, signal) => {
      if (prompt.includes('Review the current diff')) {
        const recorded = readEvents(log.paths.events).events.find(
          (e) => e.type === 'handoff_written',
        );
        seen = {
          prompt,
          ...(recorded === undefined
            ? {}
            : {
                recorded: recorded.path,
                contents: readFileSync(resolve(log.paths.root, recorded.path), 'utf8'),
              }),
        };
      }
      return runtime.promptAgent(agent, prompt, deadline, signal);
    };

    await runForwardPass({
      config: config(),
      runtime: watched,
      log,
      task: scenario.task,
      cwd: '/somewhere/else',
    });

    // recorded before the prompt, and stored run-relative whatever the base was
    expect(seen?.recorded).toBe('handoffs/r1-test_gate-1.txt');
    expect(seen?.contents).toBe('12 passing\n');
    // the prompt names an absolute path, so it opens from the reviewer's directory too
    const named = seen?.prompt.match(/output is in (\S+)\./)?.[1] ?? '';
    expect(isAbsolute(named)).toBe(true);
    expect(readFileSync(named, 'utf8')).toBe('12 passing\n');
  });

  it('prompts each agent once and launches the gate once', async () => {
    const scenario = golden('approve-round-1');
    const { runtime } = await drive(scenario.inputs, scenario.task);
    expect(runtime.history.filter((h) => h.call === 'promptAgent')).toHaveLength(2);
    expect(runtime.history.filter((h) => h.call === 'startProcess')).toHaveLength(1);
  });

  it('leaves the guard observation for the engine that owns it', async () => {
    const scenario = golden('approve-round-1');
    const { runtime } = await drive(scenario.inputs, scenario.task);
    expect(runtime.remaining()).toBe(1);
    expect(runtime.peek()).toMatchObject({ kind: 'guard_observation' });
  });

  it('leaves state.json equal to a fresh replay', async () => {
    const scenario = golden('approve-round-1');
    const { log, events } = await drive(scenario.inputs, scenario.task);
    expect(JSON.parse(readFileSync(log.paths.state, 'utf8'))).toEqual(replay(events));
  });

  it('takes its deadlines from the configuration', async () => {
    const scenario = golden('approve-round-1');
    const before = Date.now();
    const { runtime } = await drive(scenario.inputs, scenario.task);
    const prompt = runtime.history.find((h) => h.call === 'promptAgent');
    const gate = runtime.history.find((h) => h.call === 'startProcess');
    expect(prompt?.deadline).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(prompt?.deadline).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(gate?.deadline).toBeGreaterThanOrEqual(before + 600_000);
    expect(gate?.deadline).toBeLessThanOrEqual(Date.now() + 600_000);
  });
});

describe('paths this engine does not take', () => {
  const lastTypes = (events: readonly PipelineEvent[]) => events.map((e) => e.type);

  it.each([
    ['a failing gate', 'gate-fail-then-pass', 'test_gate', 'fail'],
    ['a revise verdict', 'max-rounds', 'reviewer', 'revise'],
  ] as const)('records the outcome of %s, then stops', async (_label, name, node, outcome) => {
    const scenario = golden(name);
    const { outcome: thrown, events } = await drive(scenario.inputs, scenario.task);
    expect(thrown).toBeInstanceOf(UnsupportedPath);
    expect(thrown).toMatchObject({ reason: 'back_edge', node, round: 1 });
    // the outcome it produced is recorded, because it happened
    expect(events.at(-1)).toMatchObject({ type: 'node_finished', node, outcome });
    // and nothing beyond it is: no target entry, no terminal event, no invented escalation
    expect(lastTypes(events)).not.toContain('run_finished');
    expect(lastTypes(events)).not.toContain('escalated');
  });

  it.each([
    [
      'an observation that never settles',
      [{ kind: 'agent_result', node: 'implementer', result: 'blocked' }] as ScenarioInput[],
      'observation',
    ],
    [
      'a reviewer that returned no verdict',
      [
        { kind: 'agent_result', node: 'implementer', result: 'settled', text: 'done\n' },
        { kind: 'gate_result', node: 'test_gate', exit_status: 0, output: 'ok\n' },
        { kind: 'agent_result', node: 'reviewer', result: 'settled', text: 'Looks fine to me.\n' },
      ] as ScenarioInput[],
      'missing_verdict',
    ],
  ])('stops on %s without recording an outcome', async (_label, inputs, reason) => {
    const { outcome, events } = await drive(inputs);
    expect(outcome).toBeInstanceOf(UnsupportedPath);
    expect(outcome).toMatchObject({ reason });
    // whatever entry was open stays open: no outcome was produced, so none is invented
    expect(events.at(-1)?.type).toBe('node_started');
    expect(lastTypes(events)).not.toContain('run_finished');
  });

  it('stops before any node entry when an agent will not start', async () => {
    const { outcome, events } = await drive([], 'A task', {
      launches: { 'w1:p1': { kind: 'not_ready', detail: 'trust prompt' } },
    });
    expect(outcome).toBeInstanceOf(UnsupportedPath);
    expect(outcome).toMatchObject({ node: 'implementer', reason: 'observation' });
    expect(lastTypes(events)).toEqual(['run_started']); // the run opened and went no further
  });
});
