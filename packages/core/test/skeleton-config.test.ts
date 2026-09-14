import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

import { ConfigError, loadSkeletonConfig, parseSkeletonConfig } from '../src/skeleton/config.js';

const example = fileURLToPath(new URL('../../../examples/pipeline.skeleton.yaml', import.meta.url));
type Draft = Record<string, unknown>;

/** A document that loads cleanly, so every rejection below differs from it by one thing. */
const valid = (): Draft => ({
  version: 1,
  name: 'feature-loop-tight',
  limits: { max_rounds: 2, turn_timeout: '60m' },
  nodes: {
    implementer: { profile: 'claude-code' },
    test_gate: { run: 'npm test', timeout: '10m' },
    reviewer: { profile: 'codex' },
  },
});
const parse = (mutate: (draft: Draft) => void = () => undefined) => {
  const draft = valid();
  mutate(draft);
  return parseSkeletonConfig(stringifyYaml(draft), 'case.yaml');
};
const limits = (draft: Draft) => draft['limits'] as Draft;
const nodes = (draft: Draft) => draft['nodes'] as Draft;

describe('the example configuration', () => {
  it('loads with the values the file states, converted once', () => {
    expect(loadSkeletonConfig(example)).toEqual({
      name: 'feature-loop',
      maxRounds: 5,
      turnTimeoutMs: 3_600_000,
      implementer: { profile: 'claude-code' },
      gate: { run: 'npm test', timeoutMs: 600_000 },
      reviewer: { profile: 'codex' },
    });
  });

  it('accepts the tighter shape the max-rounds scenario needs', () => {
    expect(parse()).toMatchObject({ name: 'feature-loop-tight', maxRounds: 2 });
  });

  it('carries the gate command through unchanged', () => {
    const run = '  npm test -- --reporter="json"  ';
    expect(parse((d) => ((nodes(d)['test_gate'] as Draft)['run'] = run)).gate.run).toBe(run);
  });
});

describe('durations', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['10m', 600_000],
    ['1h', 3_600_000],
    ['90m', 5_400_000],
  ])('reads %s as %i milliseconds', (written, ms) => {
    expect(parse((d) => (limits(d)['turn_timeout'] = written)).turnTimeoutMs).toBe(ms);
  });

  it.each(['0s', '0ms', '0h'])('refuses the zero duration %s', (written) => {
    expect(() => parse((d) => (limits(d)['turn_timeout'] = written))).toThrow(/longer than zero/);
  });

  it('refuses a duration too long to hold in milliseconds', () => {
    expect(() => parse((d) => (limits(d)['turn_timeout'] = '9999999999999h'))).toThrow(
      /too long to represent/,
    );
  });
});

describe('rejection', () => {
  it('accepts the document the cases below are built from', () => {
    expect(() => parse()).not.toThrow();
  });

  it.each([
    ['an unknown top-level key', (d: Draft) => (d['notes'] = 'x'), 'notes'],
    ['an unknown key under limits', (d: Draft) => (limits(d)['extra'] = 1), 'limits.extra'],
    [
      'an unknown key on an agent',
      (d: Draft) => ((nodes(d)['reviewer'] as Draft)['run'] = 'x'),
      'nodes.reviewer.run',
    ],
    ['an unexpected node', (d: Draft) => (nodes(d)['deploy'] = {}), 'nodes.deploy'],
    ['a missing node', (d: Draft) => delete nodes(d)['reviewer'], 'nodes.reviewer'],
    ['a missing name', (d: Draft) => delete d['name'], 'name'],
    ['an empty name', (d: Draft) => (d['name'] = ''), 'name'],
    ['a name that is not a string', (d: Draft) => (d['name'] = 7), 'name'],
    ['a missing round limit', (d: Draft) => delete limits(d)['max_rounds'], 'limits.max_rounds'],
    ['a round limit of zero', (d: Draft) => (limits(d)['max_rounds'] = 0), 'limits.max_rounds'],
    [
      'a fractional round limit',
      (d: Draft) => (limits(d)['max_rounds'] = 1.5),
      'limits.max_rounds',
    ],
    [
      'a round limit beyond safe integers',
      (d: Draft) => (limits(d)['max_rounds'] = 2 ** 60),
      'limits.max_rounds',
    ],
    [
      'a missing turn timeout',
      (d: Draft) => delete limits(d)['turn_timeout'],
      'limits.turn_timeout',
    ],
    [
      'a turn timeout in an unknown unit',
      (d: Draft) => (limits(d)['turn_timeout'] = '5 minutes'),
      'limits.turn_timeout',
    ],
    [
      'an empty profile',
      (d: Draft) => ((nodes(d)['implementer'] as Draft)['profile'] = ''),
      'nodes.implementer.profile',
    ],
    [
      'a missing gate command',
      (d: Draft) => delete (nodes(d)['test_gate'] as Draft)['run'],
      'nodes.test_gate.run',
    ],
    [
      'an empty gate command',
      (d: Draft) => ((nodes(d)['test_gate'] as Draft)['run'] = ''),
      'nodes.test_gate.run',
    ],
    [
      'a missing gate timeout',
      (d: Draft) => delete (nodes(d)['test_gate'] as Draft)['timeout'],
      'nodes.test_gate.timeout',
    ],
    ['a version this loader does not know', (d: Draft) => (d['version'] = 2), 'version'],
    ['nodes that are not a mapping', (d: Draft) => (d['nodes'] = ['implementer']), 'nodes'],
    [
      'an agent that is not a mapping',
      (d: Draft) => (nodes(d)['reviewer'] = 'codex'),
      'nodes.reviewer',
    ],
  ])('refuses %s, naming where', (_label, mutate, at) => {
    let thrown: ConfigError | undefined;
    try {
      parse(mutate);
    } catch (error) {
      thrown = error as ConfigError;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown?.at).toBe(at);
    expect(thrown?.path).toBe('case.yaml');
    expect(thrown?.message).toContain('case.yaml');
  });

  it.each(['implementer', 'test_gate', 'reviewer'])(
    'says plainly that the loop needs %s, rather than that it is not a mapping',
    (node) => {
      expect(() => parse((d) => delete nodes(d)[node])).toThrow(/is required by the skeleton loop/);
    },
  );

  it('reports a document that is not a mapping at all', () => {
    expect(() => parseSkeletonConfig('- one\n- two\n', 'case.yaml')).toThrow(/must be a mapping/);
  });

  it('reports a parse failure separately from a schema failure', () => {
    let thrown: ConfigError | undefined;
    try {
      parseSkeletonConfig('nodes: [ unclosed\n', 'case.yaml');
    } catch (error) {
      thrown = error as ConfigError;
    }
    expect(thrown?.at).toBe('/');
    expect(thrown?.message).toMatch(/not valid YAML/);
  });

  it('reports a file it cannot read, naming it', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'pipeline-config-')), 'absent.yaml');
    expect(() => loadSkeletonConfig(missing)).toThrow(new RegExp(missing.replace(/\//g, '.')));
    expect(() => loadSkeletonConfig(missing)).toThrow(/could not be read/);
  });

  it('names the file it was given when loading from disk', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pipeline-config-')), 'broken.yaml');
    writeFileSync(path, stringifyYaml({ ...valid(), name: '' }), 'utf8');
    expect(() => loadSkeletonConfig(path)).toThrow(new RegExp(`${path.replace(/\//g, '.')}: name`));
  });
});
