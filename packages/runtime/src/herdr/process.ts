import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type {
  DeadlineEpochMs,
  ExecutionId,
  ProcessLaunch,
  ProcessObservation,
  ProcessSpec,
  SubmissionOutcome,
} from '../adapter.js';

/**
 * Running gates as real processes.
 *
 * herdr's `pane run` reports that keystrokes were delivered, never that a command ran, and exposes
 * no exit status anywhere — see the departure recorded in PLAN.md step 11. SPEC R7 routes on a real
 * exit status, so gates are spawned directly.
 *
 * Nothing here is exported from the package yet: a complete `RuntimeAdapter` still needs the
 * shutdown behaviour that slice 11c-2b adds, and half of one would be worse than none.
 *
 * **Waiting is the caller's, the result is the execution's.** An execution ends once and keeps that
 * ending; observers come and go around it. A deadline or an abort ends only the waiting it was given
 * to — the child keeps running, its eventual result is still recorded, and every later observer
 * replays it unchanged. So one observer's timeout cannot deny another observer the real answer, and
 * cancelling one cannot disturb the rest.
 *
 * **Output.** `ProcessSpec.command` is a shell command string, so it runs through a shell and keeps
 * its quoting and pipelines. stdout and stderr are decoded **separately** — each stream has its own
 * decoder, because a multibyte character arriving in two stdout chunks can have a stderr chunk
 * between them, and decoding one interleaved buffer would corrupt it — and the decoded pieces are
 * appended in arrival order, so `output` reads as the terminal showed it.
 */

/** Bytes of combined stdout and stderr retained before the result is refused rather than truncated. */
export const DEFAULT_OUTPUT_LIMIT = 8 * 1024 * 1024;

/** `setTimeout` treats anything larger as zero, so long waits are reached in steps. */
const MAX_TIMEOUT = 2_147_483_647;

/**
 * Call `expire` when `deadline` arrives, and hand back the way to stop waiting for it.
 *
 * A distant deadline is reached in steps: `setTimeout` fires immediately for anything past
 * 2^31-1 ms, so scheduling one hop for a deadline weeks away would expire it at once.
 */
const armDeadline = (
  deadline: DeadlineEpochMs,
  now: () => number,
  expire: () => void,
): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = (): void => {
    const left = deadline - now();
    if (left <= 0) return expire();
    timer = setTimeout(step, Math.min(left, MAX_TIMEOUT));
  };
  step();
  return () => clearTimeout(timer);
};

export interface GateRunnerOptions {
  /** The shell that interprets `ProcessSpec.command`. */
  readonly shell?: string;
  /** Raw bytes across both streams. Past this, output stops being retained (see the module note). */
  readonly outputLimit?: number;
  /** How a child is started. Injectable so tests can observe *when* dispatch happens. */
  readonly spawn?: typeof spawn;
  /**
   * The clock deadlines are measured against. Injectable for the same reason `spawn` is: a timer
   * callback that runs after its due time is a real hazard and is otherwise unobservable.
   */
  readonly now?: () => number;
}

interface Execution {
  readonly executionId: ExecutionId;
  /** Set once the process ended, in whatever way. Retained and replayed unchanged. */
  result?: ProcessObservation;
  /** Observers waiting on this execution. Each settles on its own terms; none of them owns it. */
  readonly waiters: Set<(result: ProcessObservation) => void>;
}

export interface GateRunner {
  /** Synchronous and identity-first: the id exists before any I/O, as the adapter requires. */
  start(spec: ProcessSpec): ProcessLaunch;
  /**
   * Waits for the execution to end, for as long as `deadline` and `signal` allow.
   *
   * The order the answers are decided in, which is the whole contract:
   *
   * 1. an identity this runtime never issued cannot be observed at all;
   * 2. a caller that has already aborted is told so, and nothing is started for it;
   * 3. an execution that already ended replays its result at once — a spent deadline does not hide
   *    an answer the runtime is holding, and no waiting is set up to be torn down;
   * 4. only then does a deadline matter: a spent one is `timed_out`, a live one permits waiting.
   */
  observe(
    executionId: ExecutionId,
    deadline: DeadlineEpochMs,
    signal?: AbortSignal,
  ): Promise<ProcessObservation>;
}

export function createGateRunner(options: GateRunnerOptions = {}): GateRunner {
  const shell = options.shell ?? '/bin/sh';
  const start = options.spawn ?? spawn;
  const limit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const now = options.now ?? Date.now;
  const executions = new Map<string, Execution>();
  let nextId = 0;

  return {
    start(spec: ProcessSpec): ProcessLaunch {
      const executionId = `gate-${++nextId}` as ExecutionId;
      let announceStart: (outcome: SubmissionOutcome) => void = () => undefined;
      const started = new Promise<SubmissionOutcome>((resolve) => (announceStart = resolve));
      const execution: Execution = { executionId, waiters: new Set() };
      executions.set(executionId, execution);

      const publish = (observation: ProcessObservation): void => {
        if (execution.result !== undefined) return; // the first ending is the ending
        execution.result = observation;
        // Copied before delivery: a waiter settles synchronously and would otherwise mutate the set
        // being iterated. Everyone waiting at this moment is entitled to this result.
        const waiting = [...execution.waiters];
        execution.waiters.clear();
        for (const waiter of waiting) waiter(observation);
      };

      const failedToStart = (detail: string): void => {
        announceStart({ kind: 'failed', detail });
        publish({ kind: 'unrecoverable', executionId, reason: 'spawn_failed', detail });
      };

      const dispatch = (): void => {
        let output = '';
        let bytes = 0;
        let overflowed = false;
        const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };

        // `spawn` can also throw synchronously — a NUL in the command, an empty executable — which
        // is the same fact as an asynchronous spawn error and is reported the same way.
        let child;
        try {
          // stdin is ignored: this API offers no way to supply input, and an inherited pipe would
          // leave a command that reads to EOF waiting for one that never comes.
          child = start(shell, ['-c', spec.command], {
            cwd: spec.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (cause) {
          return failedToStart((cause as Error).message);
        }
        let spawned = false;

        const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
          bytes += chunk.byteLength;
          const text = decoders[stream].write(chunk);
          if (overflowed) return;
          if (bytes > limit) {
            overflowed = true;
            // Published at once, not at close: the refusal is already irreversible, and a runaway
            // gate would otherwise keep the observation pending for as long as it runs. Draining
            // continues so the child is never blocked on a full pipe.
            publish({
              kind: 'unrecoverable',
              executionId,
              reason: 'output_limit_exceeded',
              detail: `output passed ${limit} bytes; the result is refused rather than truncated`,
            });
            return;
          }
          output += text;
        };
        child.stdout.on('data', collect('stdout'));
        child.stderr.on('data', collect('stderr'));

        child.once('spawn', () => {
          spawned = true;
          announceStart({ kind: 'accepted' });
        });
        child.once('error', (error: Error) => {
          // Before `spawn`, this is the shell failing to start, so nothing ran. A missing *inner*
          // command is not this: the shell starts fine and exits non-zero, which is a real result.
          if (!spawned) failedToStart(error.message);
        });

        // `close` rather than `exit`: it waits for the streams themselves to end, so output written
        // by anything the gate left running is still captured. The consequence is that a gate which
        // backgrounds a long-lived process keeps its execution open; an observer's deadline bounds
        // that observer's waiting, and the output cap above bounds what is held.
        child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
          if (!spawned || overflowed) return; // a refusal already published stands
          output += decoders.stdout.end() + decoders.stderr.end();
          if (signal !== null)
            return publish({
              kind: 'unrecoverable',
              executionId,
              reason: 'signal_terminated',
              detail: `ended on ${signal} with no exit status`,
            });
          return publish({ kind: 'completed', executionId, exitStatus: code ?? 0, output });
        });
      };

      // The handle is returned before anything is dispatched, so an identity always exists to
      // observe — including when starting the shell fails immediately.
      queueMicrotask(dispatch);
      return { executionId, started };
    },

    observe(
      executionId: ExecutionId,
      deadline: DeadlineEpochMs,
      signal?: AbortSignal,
    ): Promise<ProcessObservation> {
      const execution = executions.get(executionId);
      // The precedence documented on GateRunner.observe, in that order.
      if (execution === undefined)
        return Promise.resolve({ kind: 'unrecoverable', executionId, reason: 'unknown_execution' });
      if (signal?.aborted === true) return Promise.resolve({ kind: 'cancelled', executionId });
      if (execution.result !== undefined) return Promise.resolve(execution.result);
      if (deadline - now() <= 0) return Promise.resolve({ kind: 'timed_out', executionId });

      return new Promise<ProcessObservation>((resolve) => {
        // Every ending runs the same teardown, so no waiter, timer or abort listener outlives the
        // observation that installed it, whichever way that observation ended.
        const teardown: Array<() => void> = [];
        let ended = false;
        const finish = (observation: ProcessObservation): void => {
          if (ended) return;
          ended = true;
          for (const undo of teardown) undo();
          resolve(observation);
        };

        const waiter = (result: ProcessObservation): void =>
          // Checked against the clock rather than trusting the timer: an overdue callback may not
          // have run yet, and a waiter whose budget is spent must not be handed a late success.
          // The execution keeps its result regardless, so a later observation still replays it.
          finish(now() >= deadline ? { kind: 'timed_out', executionId } : result);
        execution.waiters.add(waiter);
        teardown.push(() => execution.waiters.delete(waiter));

        if (signal !== undefined) {
          const onAbort = (): void => finish({ kind: 'cancelled', executionId });
          signal.addEventListener('abort', onAbort);
          teardown.push(() => signal.removeEventListener('abort', onAbort));
        }

        // Armed last, so that a deadline the clock has passed in the meantime tears down everything
        // installed above rather than expiring before the rest of it exists.
        teardown.push(armDeadline(deadline, now, () => finish({ kind: 'timed_out', executionId })));
      });
    },
  };
}
