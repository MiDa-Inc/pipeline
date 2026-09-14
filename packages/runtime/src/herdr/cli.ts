import { execFile } from 'node:child_process';

import type { DeadlineEpochMs } from '../adapter.js';

/**
 * Invoking the herdr CLI and classifying what comes back.
 *
 * Three exit classes, from docs/herdr-notes.md: `0` succeeds with JSON, plain text or nothing on
 * stdout; `1` is a server error carrying JSON on **stderr**; `2` is client-side argument validation
 * carrying one line of plain text on stderr. Exit 2 is never JSON-parsed.
 *
 * Arguments are passed as an array and never through a shell, so a pane id or a command containing
 * spaces, quotes or `$` cannot be reinterpreted.
 */

export type HerdrFault =
  /** Exit 1: the server refused. `code` carries herdr's own error code. */
  | 'api_error'
  /** Exit 2: argument validation, decided before the socket call. Plain text, never JSON. */
  | 'usage'
  /** Exit 0, but the output was not the shape the caller asked for. */
  | 'malformed'
  /** An exit code outside the three documented classes. */
  | 'unexpected_exit'
  /** The executable could not be started at all. Nothing ran. */
  | 'launch_failed'
  /** It started and then ended abnormally — killed by a signal, or drowned in output. */
  | 'terminated'
  /** The deadline passed. Says nothing about whether the command took effect. */
  | 'timed_out'
  /** The caller aborted. Distinct from a timeout; claims nothing. */
  | 'cancelled';

export class HerdrError extends Error {
  /** herdr's own error code on exit 1, such as `pane_not_found`. */
  readonly code?: string;
  readonly exitCode?: number;
  /** Whatever the command printed on stderr, kept as captured. */
  readonly stderr?: string;
  /** The signal that ended the child, when one did. Never folded into {@link stderr}. */
  readonly signal?: string;
  constructor(
    readonly fault: HerdrFault,
    readonly argv: readonly string[],
    message: string,
    details: { code?: string; exitCode?: number; stderr?: string; signal?: string } = {},
  ) {
    super(`herdr ${argv.join(' ')}: ${message}`);
    this.name = 'HerdrError';
    if (details.code !== undefined) this.code = details.code;
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    if (details.stderr !== undefined) this.stderr = details.stderr;
    if (details.signal !== undefined) this.signal = details.signal;
  }
}

/**
 * The common response shape: `{"id":"cli:<area>:<verb>","result":{...,"type":"<event>"}}`.
 *
 * Only what has actually been checked is typed. Payload fields are `unknown`, so a caller narrows
 * them deliberately instead of being handed a shape nothing verified.
 */
export interface HerdrEnvelope {
  readonly id: string;
  readonly result: { readonly type: string } & Readonly<Record<string, unknown>>;
}

export interface HerdrProcessResult {
  readonly code: number | null;
  /** Set when the child was ended by a signal rather than exiting on its own. */
  readonly signal?: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** How the process is actually run. Injectable so tests can replay the step 02 fixtures. */
export type HerdrRunner = (
  file: string,
  argv: readonly string[],
  signal: AbortSignal,
) => Promise<HerdrProcessResult>;

export interface HerdrOptions {
  /** The executable. Defaults to `herdr` on the path. */
  readonly executable?: string;
  /** Prefixed as `--session <name>`, which is how the spike isolated its own server. */
  readonly session?: string;
  readonly deadline?: DeadlineEpochMs;
  readonly signal?: AbortSignal;
  /** Bytes of stdout to accept before giving up. `agent read` can return a lot. */
  readonly maxBuffer?: number;
  readonly run?: HerdrRunner;
}

const makeRunner =
  (maxBuffer: number): HerdrRunner =>
  (file, argv, signal) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...argv],
        { encoding: 'utf8', signal, maxBuffer },
        (error, stdout, stderr) => {
          if (error === null) return resolve({ code: 0, stdout, stderr });
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          // A non-zero exit is a result, not a failure to run.
          if (typeof failure.code === 'number')
            return resolve({ code: failure.code, stdout, stderr });
          // Everything else is rejected, carrying what the child managed to print, so a caller
          // sees the diagnostic and not just the manner of death.
          return reject(Object.assign(error, { stdout, stderr }));
        },
      );
    });

/** `setTimeout` treats anything larger as zero, so long waits are reached in steps. */
const MAX_TIMEOUT = 2_147_483_647;
/** Generous enough for `agent read`'s thousand-line window. */
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function invoke(argv: readonly string[], options: HerdrOptions): Promise<HerdrProcessResult> {
  const full = options.session === undefined ? argv : ['--session', options.session, ...argv];
  // Nothing is spawned for a request the caller has already given up on.
  if (options.signal?.aborted === true)
    throw new HerdrError('cancelled', full, 'the caller aborted the invocation');
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    controller.abort();
  };
  options.signal?.addEventListener('abort', onAbort);
  const { deadline } = options;
  // A deadline that has already passed is not a race to lose: nothing is dispatched.
  if (deadline !== undefined && deadline - Date.now() <= 0) {
    options.signal?.removeEventListener('abort', onAbort);
    throw new HerdrError('timed_out', full, 'the deadline had already passed');
  }
  // The two reasons an invocation stops early are kept apart deliberately: a deadline says the
  // command may still be taking effect, an abort says the caller stopped caring.
  let timer: ReturnType<typeof setTimeout> | undefined;
  // setTimeout fires immediately for anything past 2^31-1 ms, so a distant deadline is reached in
  // steps rather than scheduled in one hop that would expire at once.
  const arm = (until: DeadlineEpochMs): void => {
    const left = until - Date.now();
    if (left <= 0) {
      timedOut = true;
      controller.abort();
      return;
    }
    timer = setTimeout(() => arm(until), Math.min(left, MAX_TIMEOUT));
  };
  if (deadline !== undefined) arm(deadline);
  try {
    const result = await (options.run ?? makeRunner(options.maxBuffer ?? DEFAULT_MAX_BUFFER))(
      options.executable ?? 'herdr',
      full,
      controller.signal,
    );
    // Checked against the clock on the way out, not against the timer: a runner that blocks past
    // the deadline can return before an overdue callback has had a chance to run.
    if (timedOut || (deadline !== undefined && Date.now() >= deadline))
      throw new HerdrError('timed_out', full, 'the deadline passed');
    if (cancelled) throw new HerdrError('cancelled', full, 'the caller aborted the invocation');
    return result;
  } catch (cause) {
    if (cause instanceof HerdrError) throw cause;
    if (timedOut) throw new HerdrError('timed_out', full, 'the deadline passed');
    if (cancelled) throw new HerdrError('cancelled', full, 'the caller aborted the invocation');
    const failure = cause as NodeJS.ErrnoException & {
      signal?: string;
      killed?: boolean;
      stderr?: string;
    };
    // `terminated` is claimed only on evidence that a child actually ran: it was killed, it ended
    // on a signal, or it outgrew the buffer. Everything else — a failed spawn, a rejected argument,
    // an out-of-range option — never started anything, whatever its shape.
    const started =
      failure.killed === true ||
      typeof failure.signal === 'string' ||
      failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    if (!started)
      throw new HerdrError('launch_failed', full, `could not be started: ${failure.message}`);
    throw new HerdrError('terminated', full, `ended abnormally: ${failure.message}`, {
      ...(failure.stderr === undefined ? {} : { stderr: failure.stderr }),
      ...(failure.signal === undefined ? {} : { signal: failure.signal }),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function classify(argv: readonly string[], run: HerdrProcessResult): void {
  if (run.code === 0) return;
  if (run.code === 1) {
    // JSON on stderr. A body that will not parse is still an API error; what is lost is the code.
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stderr);
    } catch {
      throw new HerdrError('api_error', argv, 'failed without a readable error body', {
        exitCode: 1,
        stderr: run.stderr,
      });
    }
    const error = isObject(parsed) && isObject(parsed['error']) ? parsed['error'] : undefined;
    const code = typeof error?.['code'] === 'string' ? error['code'] : undefined;
    const message = typeof error?.['message'] === 'string' ? error['message'] : run.stderr.trim();
    throw new HerdrError('api_error', argv, message, {
      exitCode: 1,
      stderr: run.stderr,
      ...(code === undefined ? {} : { code }),
    });
  }
  if (run.code === 2)
    // Never parsed as JSON: exit 2 is one line of plain text, decided before the socket call.
    throw new HerdrError('usage', argv, run.stderr.trim(), { exitCode: 2, stderr: run.stderr });
  if (run.code === null && typeof run.signal === 'string')
    throw new HerdrError('terminated', argv, `ended on ${run.signal}`, { stderr: run.stderr });
  throw new HerdrError('unexpected_exit', argv, `exited with ${run.code}`, {
    ...(run.code === null ? {} : { exitCode: run.code }),
    stderr: run.stderr,
  });
}

const parsedJson = (argv: readonly string[], stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new HerdrError('malformed', argv, `stdout is not JSON: ${(cause as Error).message}`);
  }
};

/** A command answering with the standard envelope. */
export async function herdrEnvelope(
  argv: readonly string[],
  options: HerdrOptions = {},
): Promise<HerdrEnvelope> {
  const run = await invoke(argv, options);
  classify(argv, run);
  const body = parsedJson(argv, run.stdout);
  if (!isObject(body) || typeof body['id'] !== 'string' || !isObject(body['result']))
    throw new HerdrError('malformed', argv, 'stdout is not an {id, result} envelope');
  if (typeof body['result']['type'] !== 'string')
    throw new HerdrError('malformed', argv, 'the envelope result carries no type');
  return body as unknown as HerdrEnvelope;
}

/**
 * A command answering with a bare JSON object rather than an envelope.
 *
 * Only `agent explain --json` does this
 * (test/fixtures/herdr/agent-explain/idle-json.stdout), which is why it is a separate call rather
 * than a fallback inside {@link herdrEnvelope}.
 */
export async function herdrBare(
  argv: readonly string[],
  options: HerdrOptions = {},
): Promise<Readonly<Record<string, unknown>>> {
  const run = await invoke(argv, options);
  classify(argv, run);
  const body = parsedJson(argv, run.stdout);
  if (!isObject(body)) throw new HerdrError('malformed', argv, 'stdout is not a JSON object');
  return body;
}

/**
 * A command answering with terminal text, returned exactly as written.
 *
 * Nothing is trimmed: `pane read --raw` preserves `\r\n` and trailing spaces on purpose, and the
 * verdict parser downstream strips decoration itself.
 */
export async function herdrText(
  argv: readonly string[],
  options: HerdrOptions = {},
): Promise<string> {
  const run = await invoke(argv, options);
  classify(argv, run);
  return run.stdout;
}

/** A command answering with nothing at all, such as `pane run`. */
export async function herdrNothing(
  argv: readonly string[],
  options: HerdrOptions = {},
): Promise<void> {
  const run = await invoke(argv, options);
  classify(argv, run);
  if (run.stdout.length > 0)
    throw new HerdrError('malformed', argv, 'expected no output, but stdout was not empty');
}
