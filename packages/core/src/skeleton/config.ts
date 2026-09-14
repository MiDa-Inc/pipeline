import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

/**
 * The skeleton engine's configuration: a hard-coded implementer → gate → reviewer loop, so the
 * file names exactly those three nodes and nothing else.
 *
 * Durations are written the way `spec/pipelines/*.yaml` writes them and are converted here, once.
 * Every converted field is named `...Ms` so a caller cannot mistake the unit. The gate's command is
 * carried through byte for byte: it is what will be run.
 *
 * The working directory is deliberately absent. A pipeline definition describes a pipeline, not the
 * machine it runs on, so the caller supplies the cwd.
 */

/** How a duration may be written. Anything else is refused rather than guessed at. */
const DURATION = /^(\d+)(ms|s|m|h)$/;
const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

export interface SkeletonAgent {
  readonly profile: string;
}

export interface SkeletonGate {
  /** Exactly as written in the file. */
  readonly run: string;
  readonly timeoutMs: number;
}

export interface SkeletonConfig {
  /** Recorded as `run_started.pipeline`. */
  readonly name: string;
  readonly maxRounds: number;
  /** The observation budget for one agent turn, in milliseconds. */
  readonly turnTimeoutMs: number;
  readonly implementer: SkeletonAgent;
  readonly gate: SkeletonGate;
  readonly reviewer: SkeletonAgent;
}

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    /** Where in the document, as a dotted field path, or `/` for the document itself. */
    readonly at: string,
    message: string,
  ) {
    super(`${path}: ${at}: ${message}`);
    this.name = 'ConfigError';
  }
}

const fields = (
  value: unknown,
  at: string,
  allowed: readonly string[],
  path: string,
): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ConfigError(path, at, 'must be a mapping');
  const record = value as Record<string, unknown>;
  // Unknown keys are refused at every level: a misspelled one would otherwise be silently ignored,
  // and a configuration that quietly means something else is worse than one that is rejected.
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      throw new ConfigError(path, at === '/' ? key : `${at}.${key}`, 'is not a known key');
  return record;
};

const text = (value: unknown, at: string, path: string): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw new ConfigError(path, at, 'must be a non-empty string');
  return value;
};

const rounds = (value: unknown, at: string, path: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ConfigError(path, at, 'must be a positive whole number of rounds');
  return value;
};

const durationMs = (value: unknown, at: string, path: string): number => {
  const written = text(value, at, path);
  const matched = DURATION.exec(written);
  if (matched === null)
    throw new ConfigError(path, at, `is not a duration like 30s, 10m or 1h: ${written}`);
  const amount = Number(matched[1]);
  const scale = UNITS[matched[2] as string] as number;
  const total = amount * scale;
  // A duration that cannot be represented exactly would silently become a different deadline.
  if (!Number.isSafeInteger(total))
    throw new ConfigError(path, at, `is too long to represent in milliseconds: ${written}`);
  if (total === 0) throw new ConfigError(path, at, 'must be longer than zero');
  return total;
};

/** Parse a configuration document. `path` only names the source in errors. */
export function parseSkeletonConfig(source: string, path: string): SkeletonConfig {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (cause) {
    throw new ConfigError(path, '/', `is not valid YAML: ${(cause as Error).message}`);
  }
  const root = fields(document, '/', ['version', 'name', 'limits', 'nodes'], path);
  if (root['version'] !== 1) throw new ConfigError(path, 'version', 'must be 1');
  const limits = fields(root['limits'], 'limits', ['max_rounds', 'turn_timeout'], path);
  const nodes = fields(root['nodes'], 'nodes', ['implementer', 'test_gate', 'reviewer'], path);
  for (const required of ['implementer', 'test_gate', 'reviewer'])
    if (nodes[required] === undefined)
      throw new ConfigError(path, `nodes.${required}`, 'is required by the skeleton loop');
  const gate = fields(nodes['test_gate'], 'nodes.test_gate', ['run', 'timeout'], path);
  return {
    name: text(root['name'], 'name', path),
    maxRounds: rounds(limits['max_rounds'], 'limits.max_rounds', path),
    turnTimeoutMs: durationMs(limits['turn_timeout'], 'limits.turn_timeout', path),
    implementer: {
      profile: text(
        fields(nodes['implementer'], 'nodes.implementer', ['profile'], path)['profile'],
        'nodes.implementer.profile',
        path,
      ),
    },
    gate: {
      run: text(gate['run'], 'nodes.test_gate.run', path),
      timeoutMs: durationMs(gate['timeout'], 'nodes.test_gate.timeout', path),
    },
    reviewer: {
      profile: text(
        fields(nodes['reviewer'], 'nodes.reviewer', ['profile'], path)['profile'],
        'nodes.reviewer.profile',
        path,
      ),
    },
  };
}

export function loadSkeletonConfig(path: string): SkeletonConfig {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(path, '/', `could not be read: ${(cause as Error).message}`);
  }
  return parseSkeletonConfig(source, path);
}
