import { readFileSync } from 'node:fs';
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
 * Fixture discovery, cross-file reference resolution, unique names, R1-R15 coverage and the
 * twelve required scenarios are 05c.
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
