import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

// Both packages are CommonJS with ESM-style declarations, and this repository compiles with
// NodeNext and no esModuleInterop: Ajv is reached by its named export, and the formats plugin
// through the module object Node hands to a default import. No cast, so the types stay honest.
const addFormats: ajvFormats.FormatsPlugin = ajvFormats.default.default;

import {
  createFakeRuntime,
  type FakeAgentRuntime,
  type FakeRuntimeConfig,
  type ScenarioInput,
} from './fake.js';

/**
 * Loading the golden scenarios in `spec/scenarios/` and turning them into fakes.
 *
 * Nothing here interprets a scenario. `inputs` is handed to the runtime whole and in order —
 * entries for nodes this runtime never touches are kept, because the cursor is shared — and
 * `expect` is carried through untouched as a test oracle: it describes what an engine should
 * write, and no runtime behaviour is derived from it.
 */

/** One expected event. Deliberately opaque here; `spec/events.schema.json` is its contract. */
export type ExpectedEvent = Readonly<Record<string, unknown>>;

export interface Scenario {
  readonly name: string;
  /** The SPEC rules this scenario exercises, e.g. `['R4', 'R10']`. */
  readonly covers: readonly string[];
  readonly pipeline: string;
  readonly task: string;
  readonly inputs: readonly ScenarioInput[];
  /** The event log an engine is expected to write. An oracle for tests, never an input. */
  readonly expect: readonly ExpectedEvent[];
  readonly side_effects?: readonly Readonly<{ assert: string; detail: string }>[];
}

export interface LoadOptions {
  /** Where the checked-in schemas live. Defaults to the repository's `spec/`. */
  readonly specDir?: string;
}

const repoSpecDir = (): string => fileURLToPath(new URL('../../../spec/', import.meta.url));
const readJson = (path: string): object => JSON.parse(readFileSync(path, 'utf8')) as object;

/** One compiled validator per spec directory: Ajv compilation is not cheap, and this is hot in tests. */
const validators = new Map<string, ValidateFunction>();

const validatorFor = (specDir: string): ValidateFunction => {
  const cached = validators.get(specDir);
  if (cached !== undefined) return cached;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv); // date-time is a plugin rather than built in
  // The scenario schema references the event schema by its absolute $id. Registering it here
  // resolves that locally: nothing is ever fetched.
  ajv.addSchema(readJson(join(specDir, 'events.schema.json')));
  const compiled = ajv.compile(readJson(join(specDir, 'scenario.schema.json')));
  validators.set(specDir, compiled);
  return compiled;
};

const describeErrors = (validate: ValidateFunction): string =>
  (validate.errors ?? [])
    .map((e) => `  ${e.instancePath === '' ? '/' : e.instancePath}: ${e.message ?? 'invalid'}`)
    .join('\n');

/**
 * Read one scenario file, and refuse anything the schema does not accept.
 *
 * Parse failures and schema failures are reported separately, each naming the file: a scenario that
 * is not valid YAML is a different mistake from one that parses but is not a scenario.
 */
export function loadScenario(path: string, options: LoadOptions = {}): Scenario {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`${path}: not valid YAML`, { cause });
  }
  const validate = validatorFor(options.specDir ?? repoSpecDir());
  if (!validate(parsed))
    throw new Error(`${path}: does not match scenario.schema.json\n${describeErrors(validate)}`);
  return parsed as Scenario;
}

/** Every scenario in a directory, in filename order so a run is reproducible. */
export function discoverScenarios(dir?: string, options: LoadOptions = {}): Scenario[] {
  const from = dir ?? join(options.specDir ?? repoSpecDir(), 'scenarios');
  return readdirSync(from)
    .filter((file) => file.endsWith('.yaml'))
    .sort()
    .map((file) => loadScenario(join(from, file), options));
}

/** Everything a fake needs beyond the scenario itself: which pane stands for which node, and so on. */
export type ScenarioRuntimeConfig = Omit<FakeRuntimeConfig, 'inputs'>;

/**
 * Build a fake driven by a scenario's inputs, whole and in order. Nothing is filtered or reordered:
 * a gate entry the caller has not reached yet stays in the stream, because the cursor is shared.
 */
export function createScenarioRuntime(
  scenario: Scenario,
  config: ScenarioRuntimeConfig,
): FakeAgentRuntime {
  return createFakeRuntime({ ...config, inputs: scenario.inputs });
}
