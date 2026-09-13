import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Structural validation of the specification artifacts in spec/.
 *
 * These tests check that the schemas accept well-formed data and reject malformed data.
 * They do NOT execute a pipeline and prove nothing about whether an engine obeys docs/SPEC.md.
 */
const specUrl = (name: string) => fileURLToPath(new URL(`../../../spec/${name}`, import.meta.url));
const fixtureUrl = (name: string) =>
  fileURLToPath(new URL(`./fixtures/spec/${name}`, import.meta.url));
const readJson = (path: string): object => JSON.parse(readFileSync(path, 'utf8')) as object;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv); // standard formats (date-time) are a plugin, not built in
ajv.addSchema(readJson(specUrl('events.schema.json')));
const validateEvent = ajv.getSchema('https://pipeline.local/spec/events.schema.json');
const validateScenario = ajv.compile(readJson(specUrl('scenario.schema.json')));

const base = { run_id: 'r1', seq: 1, ts: '2026-09-13T10:00:00Z' };
const event = (extra: object) => ({ ...base, ...extra });

const validEvents: Record<string, object> = {
  run_started: event({ type: 'run_started', pipeline: 'feature-loop', task: 'Add rate limiting' }),
  node_started: event({ type: 'node_started', node: 'implementer', round: 1 }),
  handoff_written: event({
    type: 'handoff_written',
    node: 'test_gate',
    round: 2,
    path: 'handoffs/test_gate-1.txt',
  }),
  node_finished: event({ type: 'node_finished', node: 'reviewer', round: 3, outcome: 'revise' }),
  escalated: event({ type: 'escalated', node: 'reviewer', round: 3, reason: 'missing_verdict' }),
  resumed: event({ type: 'resumed', node: 'implementer', round: 6, extra_rounds: 2 }),
  run_finished: event({ type: 'run_finished', status: 'stopped' }),
};

const invalidEvents: Record<string, object> = {
  'unknown event type': event({ type: 'node_paused', node: 'a', round: 1 }),
  'missing required payload': event({ type: 'node_finished', node: 'a', round: 1 }),
  'missing common field ts': { run_id: 'r1', seq: 1, type: 'run_finished', status: 'done' },
  'unknown extra property': event({ type: 'run_finished', status: 'done', note: 'x' }),
  'invalid outcome': event({ type: 'node_finished', node: 'a', round: 1, outcome: 'maybe' }),
  'invalid escalation reason': event({
    type: 'escalated',
    node: 'a',
    round: 1,
    reason: 'exploded',
  }),
  'invalid terminal status': event({ type: 'run_finished', status: 'paused' }),
  'round below one': event({ type: 'node_started', node: 'a', round: 0 }),
  'non-integer seq': { ...base, seq: 1.5, type: 'run_finished', status: 'done' },
  'extra_rounds not positive': event({ type: 'resumed', node: 'a', round: 1, extra_rounds: 0 }),
  'malformed timestamp': { ...base, ts: 'yesterday', type: 'run_finished', status: 'done' },
  'absolute handoff path': event({
    type: 'handoff_written',
    node: 'a',
    round: 1,
    path: '/etc/passwd',
  }),
  'handoff path escaping the run folder': event({
    type: 'handoff_written',
    node: 'a',
    round: 1,
    path: '../x.txt',
  }),
  'payload from another event type': event({
    type: 'node_started',
    node: 'a',
    round: 1,
    outcome: 'done',
  }),
};

describe('events.schema.json', () => {
  it('compiles with local references resolved', () => {
    expect(validateEvent).toBeTypeOf('function');
  });

  it.each(Object.keys(validEvents))('accepts a valid %s event', (type) => {
    expect(validateEvent?.(validEvents[type])).toBe(true);
  });

  it.each(Object.keys(invalidEvents))('rejects %s', (name) => {
    expect(validateEvent?.(invalidEvents[name])).toBe(false);
  });

  it('declares exactly the seven approved event types, in the root enum and in every branch', () => {
    const approved = [
      'run_started',
      'node_started',
      'handoff_written',
      'node_finished',
      'escalated',
      'resumed',
      'run_finished',
    ].sort();
    const schema = readJson(specUrl('events.schema.json')) as {
      properties: { type: { enum: string[] } };
      oneOf: { properties: { type: { const: string } } }[];
    };
    expect([...schema.properties.type.enum].sort()).toEqual(approved);
    expect(schema.oneOf.map((b) => b.properties.type.const).sort()).toEqual(approved);
    expect(Object.keys(validEvents).sort()).toEqual(approved);
  });
});

const scenario = (overrides: object = {}) => ({
  ...(parseYaml(readFileSync(fixtureUrl('valid-scenario.yaml'), 'utf8')) as object),
  ...overrides,
});
const input = (extra: object) => scenario({ inputs: [extra] });

const validInputs: Record<string, object> = {
  'agent_result settled carrying text': {
    kind: 'agent_result',
    node: 'a',
    result: 'settled',
    text: 'VERDICT: APPROVE\n',
  },
  'agent_result blocked with no text': { kind: 'agent_result', node: 'a', result: 'blocked' },
  'gate_result with non-empty output': {
    kind: 'gate_result',
    node: 'a',
    exit_status: 1,
    output: 'FAIL: expected 200, got 500\n',
  },
  'gate_result with empty output': { kind: 'gate_result', node: 'a', exit_status: 0, output: '' },
};

const invalidScenarios: Record<string, object> = {
  'unknown rule in covers': scenario({ covers: ['R16'] }),
  'empty covers': scenario({ covers: [] }),
  'missing expect': (() => {
    const s = scenario() as Record<string, unknown>;
    delete s.expect;
    return s;
  })(),
  'unknown top-level property': scenario({ verdict: true }),
  'expected event that is not a valid event': scenario({ expect: [{ type: 'node_started' }] }),
  'settled agent result without turn-attributable text': input({
    kind: 'agent_result',
    node: 'a',
    result: 'settled',
  }),
  'blocked agent result carrying text': input({
    kind: 'agent_result',
    node: 'a',
    result: 'blocked',
    text: 'x',
  }),
  'unconfirmed agent result carrying text': input({
    kind: 'agent_result',
    node: 'a',
    result: 'unconfirmed',
    text: 'x',
  }),
  'gate result without an exit status': input({ kind: 'gate_result', node: 'a', output: '' }),
  'gate result without output': input({ kind: 'gate_result', node: 'a', exit_status: 0 }),
  'gate result with non-string output': input({
    kind: 'gate_result',
    node: 'a',
    exit_status: 0,
    output: 1,
  }),
  'gate result carrying agent-only text, otherwise valid': input({
    kind: 'gate_result',
    node: 'a',
    exit_status: 0,
    output: 'ok\n',
    text: 'x',
  }),
  'unknown input kind': input({ kind: 'telepathy', node: 'a' }),
  'side effect without detail': scenario({ side_effects: [{ assert: 'no_git_writes' }] }),
};

describe('scenario.schema.json', () => {
  it('accepts a valid scenario parsed from YAML, including its expected events', () => {
    expect(validateScenario(scenario())).toBe(true);
  });

  it.each(Object.keys(validInputs))('accepts %s', (name) => {
    expect(validateScenario(input(validInputs[name]))).toBe(true);
  });

  it.each(Object.keys(invalidScenarios))('rejects %s', (name) => {
    expect(validateScenario(invalidScenarios[name])).toBe(false);
  });

  it('rejects the invalid YAML fixture', () => {
    const broken = parseYaml(readFileSync(fixtureUrl('invalid-scenario.yaml'), 'utf8')) as object;
    expect(validateScenario(broken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture discovery and cross-file checks (05c)
// ---------------------------------------------------------------------------

interface Pipeline {
  name: string;
  start: string;
  nodes: Record<string, { type: string; next?: Record<string, string | { to: string }> }>;
}
interface Scenario {
  name: string;
  covers: string[];
  pipeline: string;
  inputs: { node?: string }[];
  expect: { type: string; node?: string }[];
}

const loadDir = <T>(dir: string): [string, T][] =>
  readdirSync(specUrl(dir))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => [f, parseYaml(readFileSync(specUrl(`${dir}/${f}`), 'utf8')) as T]);

const pipelines = loadDir<Pipeline>('pipelines');
const scenarios = loadDir<Scenario>('scenarios');
const byBasename = new Map(pipelines.map(([f, p]) => [f.replace(/\.yaml$/, ''), p]));
const validatePipeline = ajv.compile(readJson(specUrl('pipelines/reference.schema.json')));

const REQUIRED = [
  'approve-round-1',
  'gate-fail-then-pass',
  'revise-twice',
  'max-rounds',
  'blocked',
  'timeout',
  'missing-verdict',
  'guard-violation',
  'unrouted-port',
  'resume-after-blocked',
  'resume-with-extra-rounds',
  'stop-mid-turn',
];
const ALL_RULES = Array.from({ length: 15 }, (_, i) => `R${i + 1}`);
const edgeTarget = (e: string | { to: string }) => (typeof e === 'string' ? e : e.to);

describe('fixture discovery', () => {
  it('finds at least one pipeline and the twelve scenarios', () => {
    expect(pipelines.length).toBeGreaterThan(0);
    expect(scenarios.length).toBe(REQUIRED.length);
  });

  it.each(pipelines.map(([f]) => f))('validates pipeline %s', (file) => {
    expect(validatePipeline(byBasename.get(file.replace(/\.yaml$/, '')))).toBe(true);
  });

  it.each(scenarios.map(([f]) => f))('validates scenario %s', (file) => {
    expect(validateScenario(scenarios.find(([n]) => n === file)?.[1])).toBe(true);
  });

  it.each(scenarios.map(([f]) => f))(
    'validates every expected event of %s individually',
    (file) => {
      const s = scenarios.find(([n]) => n === file)?.[1];
      for (const e of s?.expect ?? []) expect(validateEvent?.(e)).toBe(true);
    },
  );
});

const unresolvedPipeline = (s: Scenario, known: Map<string, Pipeline>) =>
  known.has(s.pipeline) ? [] : [s.pipeline];
const unknownNodes = (s: Scenario, p: Pipeline) => {
  const nodes = new Set(Object.keys(p.nodes));
  const named = [...s.inputs.map((i) => i.node), ...s.expect.map((e) => e.node)];
  return named.filter((n): n is string => typeof n === 'string' && !nodes.has(n));
};
const danglingEdges = (p: Pipeline) => {
  const nodes = new Set(Object.keys(p.nodes));
  const targets = Object.values(p.nodes).flatMap((n) =>
    Object.values(n.next ?? {}).map(edgeTarget),
  );
  return [...targets, p.start].filter((target) => !nodes.has(target));
};
const missingRules = (list: Scenario[]) => {
  const covered = new Set(list.flatMap((s) => s.covers));
  return ALL_RULES.filter((r) => !covered.has(r));
};
const duplicateNames = (list: Scenario[]) => {
  const seen = new Set<string>();
  return list.map((s) => s.name).filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
};

describe('cross-file references', () => {
  it('gives every scenario a unique name matching its filename', () => {
    expect(duplicateNames(scenarios.map(([, s]) => s))).toEqual([]);
    for (const [file, s] of scenarios) expect(`${s.name}.yaml`).toBe(file);
  });

  it.each(scenarios.map(([, s]) => s.name))('resolves the pipeline named by %s', (name) => {
    const s = scenarios.find(([, x]) => x.name === name)![1];
    expect(unresolvedPipeline(s, byBasename)).toEqual([]);
  });

  it.each(scenarios.map(([, s]) => s.name))('names only existing nodes in %s', (name) => {
    const s = scenarios.find(([, x]) => x.name === name)![1];
    expect(unknownNodes(s, byBasename.get(s.pipeline)!)).toEqual([]);
  });

  it.each(pipelines.map(([f]) => f))('routes every edge of %s to an existing node', (file) => {
    expect(danglingEdges(byBasename.get(file.replace(/\.yaml$/, ''))!)).toEqual([]);
  });
});

const pipelineWith = (mutate: (p: Record<string, never>) => void) => {
  const p = structuredClone(byBasename.get('reference')) as unknown as Record<string, never>;
  mutate(p);
  return p;
};

const invalidPipelines: Record<string, object> = {
  'gate missing its required run field': pipelineWith((p) => {
    delete (p.nodes as Record<string, Record<string, unknown>>).test_gate.run;
  }),
  'gate missing its required timeout': pipelineWith((p) => {
    delete (p.nodes as Record<string, Record<string, unknown>>).test_gate.timeout;
  }),
  'unknown node type': pipelineWith((p) => {
    (p.nodes as Record<string, Record<string, unknown>>).test_gate.type = 'webhook';
  }),
  'invalid agent permission': pipelineWith((p) => {
    (p.nodes as Record<string, Record<string, unknown>>).reviewer.permission = 'write';
  }),
  'malformed duration': pipelineWith((p) => {
    (p.nodes as Record<string, Record<string, unknown>>).test_gate.timeout = '10 minutes';
  }),
  'non-positive round limit': pipelineWith((p) => {
    (p.limits as Record<string, unknown>).max_rounds = 0;
  }),
  'unexpected top-level property': pipelineWith((p) => {
    (p as Record<string, unknown>).retries = 3;
  }),
  'unexpected node property': pipelineWith((p) => {
    (p.nodes as Record<string, Record<string, unknown>>).reviewer.model = 'sonnet';
  }),
  'port that the node type does not define': pipelineWith((p) => {
    (
      (p.nodes as Record<string, Record<string, Record<string, unknown>>>).test_gate.next as Record<
        string,
        unknown
      >
    ).approve = 'done';
  }),
  'edge long form missing its message': pipelineWith((p) => {
    (
      (p.nodes as Record<string, Record<string, Record<string, unknown>>>).reviewer.next as Record<
        string,
        unknown
      >
    ).revise = {
      to: 'implementer',
    };
  }),
  'wrong schema version': pipelineWith((p) => {
    (p as Record<string, unknown>).version = 2;
  }),
  'empty object': {},
};

describe('reference.schema.json rejects malformed pipelines', () => {
  it('accepts the unmodified reference pipeline, so each mutation is the only defect', () => {
    expect(validatePipeline(pipelineWith(() => {}))).toBe(true);
  });

  it.each(Object.keys(invalidPipelines))('rejects a pipeline with %s', (name) => {
    expect(validatePipeline(invalidPipelines[name])).toBe(false);
  });
});

describe('rule coverage', () => {
  it('covers every rule R1-R15 across the scenario set', () => {
    const covered = new Set(scenarios.flatMap(([, s]) => s.covers));
    expect(ALL_RULES.filter((r) => !covered.has(r))).toEqual([]);
  });

  it('contains all twelve required scenarios and no extras', () => {
    expect(scenarios.map(([, s]) => s.name).sort()).toEqual([...REQUIRED].sort());
  });
});

describe('cross-file checks reject broken fixtures', () => {
  const good = scenarios.find(([, s]) => s.name === 'approve-round-1')![1];
  const reference = byBasename.get('reference')!;

  it('flags a scenario naming a pipeline that does not exist', () => {
    expect(unresolvedPipeline({ ...good, pipeline: 'no-such-pipeline' }, byBasename)).toEqual([
      'no-such-pipeline',
    ]);
  });

  it('flags a scenario naming a node the pipeline does not define', () => {
    const broken = { ...good, inputs: [...good.inputs, { node: 'reviewer_2' }] };
    expect(unknownNodes(broken, reference)).toEqual(['reviewer_2']);
  });

  it('flags an expected event naming an unknown node', () => {
    const broken = { ...good, expect: [...good.expect, { type: 'node_started', node: 'ghost' }] };
    expect(unknownNodes(broken, reference)).toEqual(['ghost']);
  });

  it('flags an edge pointing at a node that does not exist', () => {
    const broken: Pipeline = {
      ...reference,
      nodes: { ...reference.nodes, test_gate: { type: 'gate', next: { pass: 'nowhere' } } },
    };
    expect(danglingEdges(broken)).toEqual(['nowhere']);
  });

  it('flags an incomplete covers set', () => {
    expect(missingRules([{ ...good, covers: ['R1', 'R2'] }])).toHaveLength(13);
  });

  it('flags a duplicate scenario name', () => {
    expect(duplicateNames([good, { ...good }])).toEqual(['approve-round-1']);
  });
});
