import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { PaneId } from './adapter.js';
import {
  createScenarioRuntime,
  discoverScenarios,
  loadScenario,
  type Scenario,
} from './scenario.js';

const PANE = 'w1:p1' as PaneId;
const OTHER = 'w1:p2' as PaneId;
const panes = { [PANE]: 'implementer', [OTHER]: 'reviewer' };
const all = discoverScenarios();
const byName = (name: string): Scenario => {
  const found = all.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no scenario named ${name}`);
  return found;
};
const deadline = () => Date.now() + 60_000;
const scenarioPath = (name: string) =>
  fileURLToPath(new URL(`../../../spec/scenarios/${name}.yaml`, import.meta.url));

/** A scenario file written to a temp directory, for the cases no checked-in scenario should have. */
const written = (body: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'pipeline-scenario-')), 'case.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
};

describe('discovery', () => {
  it('finds all twelve checked-in scenarios, in filename order', () => {
    expect(all).toHaveLength(12);
    expect(all.map((s) => s.name)).toEqual([
      'approve-round-1',
      'blocked',
      'gate-fail-then-pass',
      'guard-violation',
      'max-rounds',
      'missing-verdict',
      'resume-after-blocked',
      'resume-with-extra-rounds',
      'revise-twice',
      'stop-mid-turn',
      'timeout',
      'unrouted-port',
    ]);
  });

  it.each(all.map((s) => [s.name, s] as const))(
    '%s validates and carries its inputs, expectations and covered rules',
    (_name, scenario) => {
      expect(scenario.inputs.length).toBeGreaterThan(0);
      expect(scenario.expect.length).toBeGreaterThan(0);
      expect(scenario.covers.every((rule) => /^R\d+$/.test(rule))).toBe(true);
      expect(scenario.pipeline).toBeTruthy();
    },
  );
});

describe('input order and completeness', () => {
  it.each(all.map((s) => [s.name, s] as const))(
    '%s keeps its file order, and reaches a fake whole',
    (name, scenario) => {
      // compared against an independent parse, with no schema and no loader in the way
      const raw = parseYaml(readFileSync(scenarioPath(name), 'utf8')) as { inputs: unknown[] };
      expect(scenario.inputs).toEqual(raw.inputs);
      const r = createScenarioRuntime(scenario, { panes });
      expect(r.remaining()).toBe(scenario.inputs.length);
      expect(r.peek()).toEqual(scenario.inputs[0]);
    },
  );

  it('keeps gate entries the agent methods never touch', () => {
    const scenario = byName('gate-fail-then-pass');
    const kinds = scenario.inputs.map((i) => i.kind);
    expect(kinds).toEqual([
      'agent_result',
      'gate_result',
      'agent_result',
      'gate_result',
      'agent_result',
      'guard_observation',
    ]);
    expect(createScenarioRuntime(scenario, { panes }).remaining()).toBe(6);
  });
});

describe('driving a fake from a scenario', () => {
  it('replays timeout end to end from its single input', async () => {
    const r = createScenarioRuntime(byName('timeout'), { panes });
    const { turnId } = r.promptAgent({ pane: PANE }, 'go', deadline());
    await expect(r.observeAgentTurn(turnId, deadline())).resolves.toEqual({
      kind: 'timed_out',
      turnId,
    });
    expect(r.remaining()).toBe(0);
  });

  it('replays gate-fail-then-pass, one run per gate entry', async () => {
    const r = createScenarioRuntime(byName('gate-fail-then-pass'), { panes });
    const statuses: number[] = [];
    for (const round of [1, 2]) {
      const turn = r.promptAgent({ pane: PANE }, `round ${round}`, deadline());
      await r.observeAgentTurn(turn.turnId, deadline());
      const run = r.startProcess(
        { node: 'test_gate', command: 'npm test', cwd: '/repo' },
        deadline(),
      );
      const observed = await r.observeProcess(run.executionId, deadline());
      if (observed.kind === 'completed') statuses.push(observed.exitStatus);
    }
    expect(statuses).toEqual([1, 0]); // the failing run, then the passing rerun
    expect(r.history.filter((h) => h.call === 'startProcess')).toHaveLength(2);
  });

  it('treats expect as an oracle: no runtime behaviour is derived from it', () => {
    const scenario = byName('approve-round-1');
    const r = createScenarioRuntime(scenario, { panes });
    expect(scenario.expect.length).toBeGreaterThan(scenario.inputs.length);
    expect(r.remaining()).toBe(scenario.inputs.length); // events never enter the stream
    expect(r.history).toEqual([]);
  });
});

describe('rejection', () => {
  type Draft = Record<string, unknown>;
  /**
   * A scenario that loads cleanly, so every case below differs from it by exactly one defect.
   * `expect` has minItems 1, so an empty one is itself a violation and would mask the real case.
   */
  const valid = (): Draft => ({
    name: 'base',
    covers: ['R1'],
    pipeline: 'reference',
    task: 'A task',
    inputs: [{ kind: 'agent_result', node: 'implementer', result: 'settled', text: 'done\n' }],
    expect: [
      {
        type: 'run_started',
        run_id: 'r1',
        seq: 1,
        ts: '2026-09-13T09:00:00Z',
        pipeline: 'feature-loop',
        task: 'A task',
      },
    ],
  });
  const defective = (introduce: (draft: Draft) => void): string => {
    const draft = valid();
    introduce(draft);
    return written(stringifyYaml(draft));
  };

  it('accepts the base the cases below are built from', () => {
    expect(() => loadScenario(written(stringifyYaml(valid())))).not.toThrow();
  });

  it('reports a YAML parse failure separately from a schema failure', () => {
    expect(() => loadScenario(written('inputs: [ unclosed\n'))).toThrow(/not valid YAML/);
  });

  it.each([
    [
      'a missing required field',
      (d: Draft) => delete d['expect'],
      /must have required property 'expect'/,
    ],
    [
      'an unknown input kind',
      (d: Draft) => (d['inputs'] = [{ kind: 'teleport', node: 'implementer' }]),
      /\/inputs\/0/,
    ],
    [
      'a settled result with no text',
      (d: Draft) =>
        (d['inputs'] = [{ kind: 'agent_result', node: 'implementer', result: 'settled' }]),
      /\/inputs\/0/,
    ],
    [
      'an unknown top-level property',
      (d: Draft) => (d['notes'] = 'hello'),
      /must NOT have additional properties/,
    ],
    [
      // every required event field present, so only the type itself is wrong
      'an unknown event type',
      (d: Draft) =>
        (d['expect'] = [
          {
            type: 'node_paused',
            run_id: 'r1',
            seq: 1,
            ts: '2026-09-13T09:00:00Z',
            node: 'implementer',
            round: 1,
          },
        ]),
      /\/expect\/0/,
    ],
    [
      'a malformed event timestamp',
      (d: Draft) =>
        (d['expect'] = [
          { type: 'run_finished', run_id: 'r1', seq: 1, ts: 'yesterday', status: 'done' },
        ]),
      /\/expect\/0\/ts/,
    ],
  ])('refuses %s, and says where', (_label, introduce, where) => {
    const path = defective(introduce);
    expect(() => loadScenario(path)).toThrow(/does not match scenario\.schema\.json/);
    expect(() => loadScenario(path)).toThrow(where);
  });

  it('names the file it refused', () => {
    const path = defective((d) => delete d['expect']);
    expect(() => loadScenario(path)).toThrow(new RegExp(path.replace(/[/\\]/g, '.')));
  });
});
