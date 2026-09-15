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
 * Nothing here is exported from the package yet: what the package exports is an adapter-shaped
 * object, which slice 11c-2b-2 composes from this and the layout module.
 *
 * **A launch and its execution are two different things.** `deadline` and `signal` bound the
 * *acknowledgement* — whether the command was handed to a shell — exactly as `adapter.ts` says a
 * submission's do. They say nothing about the command itself. So a launch whose deadline passes
 * while the acknowledgement is outstanding is `unconfirmed` rather than failed: a shell may well be
 * running, and its result is still collected and retained for whoever observes it.
 *
 * Once an acknowledgement settles it stays settled. A `spawn` event arriving after shutdown has
 * cancelled the launch cannot turn it back into `accepted`, because the caller has already been
 * told, and told once.
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

/**
 * One caller waiting on one execution.
 *
 * The two ways a wait ends from outside are kept apart: `deliver` carries the execution's own
 * result, which the waiter still measures against its deadline, while `cancel` ends the waiting
 * and claims nothing about the execution at all.
 */
interface Waiter {
  deliver(result: ProcessObservation): void;
  cancel(): void;
}

interface Execution {
  readonly executionId: ExecutionId;
  /** Set once the process ended, in whatever way. Retained and replayed unchanged. */
  result?: ProcessObservation;
  /** Observers waiting on this execution. Each settles on its own terms; none of them owns it. */
  readonly waiters: Set<Waiter>;
  /** Settles this launch's acknowledgement. First call wins; later ones are ignored. */
  acknowledge(outcome: SubmissionOutcome): void;
}

export interface GateRunner {
  /**
   * Synchronous and identity-first: the id exists before any I/O, as the adapter requires.
   *
   * `deadline` and `signal` bound the acknowledgement, never the command:
   *
   * | before dispatch                    | `started`                                    |
   * | ---------------------------------- | -------------------------------------------- |
   * | shut down, or already aborted      | `cancelled`, and no shell is started         |
   * | the deadline has passed            | `failed`, and no shell is started            |
   *
   * | while the acknowledgement is outstanding | `started`                               |
   * | ---------------------------------------- | --------------------------------------- |
   * | the deadline passes                      | `unconfirmed`; collection continues     |
   * | aborted, or the runtime shuts down       | `cancelled`; the child keeps running    |
   */
  start(spec: ProcessSpec, deadline: DeadlineEpochMs, signal?: AbortSignal): ProcessLaunch;
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
  /**
   * Stop waiting on everything and start nothing further. Idempotent.
   *
   * Every outstanding observation settles `cancelled`, and so does every acknowledgement still in
   * flight — the id stays valid either way, so a caller still knows what it had registered. An
   * execution that never reached a shell is `cancelled` too, so an issued identity never becomes
   * something that waits forever.
   *
   * It kills nothing. Children keep running and keep writing to the working tree, which SPEC R13
   * requires callers to assume, and a result one of them already produced is still replayed.
   */
  shutdown(): Promise<void>;
}

export function createGateRunner(options: GateRunnerOptions = {}): GateRunner {
  const shell = options.shell ?? '/bin/sh';
  const start = options.spawn ?? spawn;
  const limit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const now = options.now ?? Date.now;
  const executions = new Map<string, Execution>();
  let nextId = 0;
  let closed = false;

  return {
    start(spec: ProcessSpec, deadline: DeadlineEpochMs, signal?: AbortSignal): ProcessLaunch {
      const executionId = `gate-${++nextId}` as ExecutionId;
      let settleStart: (outcome: SubmissionOutcome) => void = () => undefined;
      const started = new Promise<SubmissionOutcome>((resolve) => (settleStart = resolve));
      let disarmAck: () => void = () => undefined;
      let acknowledged = false;
      const acknowledge = (outcome: SubmissionOutcome): void => {
        if (acknowledged) return; // told once: a late `spawn` cannot undo a cancellation
        acknowledged = true;
        disarmAck();
        signal?.removeEventListener('abort', onAbort);
        settleStart(outcome);
      };
      const execution: Execution = { executionId, waiters: new Set(), acknowledge };
      executions.set(executionId, execution);

      const publish = (observation: ProcessObservation): void => {
        if (execution.result !== undefined) return; // the first ending is the ending
        execution.result = observation;
        // Copied before delivery: a waiter settles synchronously and would otherwise mutate the set
        // being iterated. Everyone waiting at this moment is entitled to this result.
        const waiting = [...execution.waiters];
        execution.waiters.clear();
        for (const waiter of waiting) waiter.deliver(observation);
      };

      const failedToStart = (detail: string): void => {
        acknowledge({ kind: 'failed', detail });
        publish({ kind: 'unrecoverable', executionId, reason: 'spawn_failed', detail });
      };

      /** Nothing was handed to a shell and nothing will be, so the identity settles here. */
      const neverDispatched = (): void => {
        acknowledge({ kind: 'cancelled' });
        publish({ kind: 'cancelled', executionId });
      };

      let dispatched = false;
      function onAbort(): void {
        // The signal bounds the submission, not the command: a child already started is left alone
        // and keeps being collected, and only a launch that never reached a shell is settled.
        if (dispatched) return acknowledge({ kind: 'cancelled' });
        neverDispatched();
      }
      signal?.addEventListener('abort', onAbort);

      const dispatch = (): void => {
        // Re-checked here rather than in `start`: this runs a microtask later, and the caller may
        // have aborted, the runtime may have shut down or the deadline may have passed in between.
        // One check covers both moments; two copies of it would only drift apart.
        if (closed || signal?.aborted === true) return neverDispatched();
        if (deadline - now() <= 0)
          return failedToStart(
            'the deadline passed before dispatch; no shell was started and nothing ran',
          );

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
        dispatched = true;
        // From here a shell may be running, so the deadline can no longer claim that nothing did.
        disarmAck = armDeadline(deadline, now, () =>
          acknowledge({
            kind: 'unconfirmed',
            detail:
              'the deadline passed before the launch was acknowledged; a shell may be running',
          }),
        );
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
          // Against the clock, not the timer: an overdue callback must not permit a late `accepted`.
          acknowledge(
            now() >= deadline
              ? {
                  kind: 'unconfirmed',
                  // *Acknowledged* late, which is all that is established. A child can write its
                  // first line well before the deadline while its parent is slow to process the
                  // `spawn` event, so nothing here may claim when the shell itself started.
                  detail:
                    'the launch was acknowledged only after the deadline; a shell may be running',
                }
              : { kind: 'accepted' },
          );
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
      // A shut-down runtime is not waiting for anything, so an execution that has not ended is
      // cancelled rather than timed out, whatever the caller's deadline says.
      if (closed) return Promise.resolve({ kind: 'cancelled', executionId });
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

        const waiter: Waiter = {
          deliver: (result) =>
            // Checked against the clock rather than trusting the timer: an overdue callback may not
            // have run yet, and a waiter whose budget is spent must not be handed a late success.
            // The execution keeps its result regardless, so a later observation still replays it.
            finish(now() >= deadline ? { kind: 'timed_out', executionId } : result),
          cancel: () => finish({ kind: 'cancelled', executionId }),
        };
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

    shutdown(): Promise<void> {
      if (closed) return Promise.resolve(); // idempotent: the second call has nothing left to do
      closed = true;
      for (const execution of executions.values()) {
        // Acknowledgements first, so a caller still holding `started` is released; a launch that
        // already reached a shell is left running and goes on being collected.
        execution.acknowledge({ kind: 'cancelled' });
        const waiting = [...execution.waiters];
        execution.waiters.clear();
        for (const waiter of waiting) waiter.cancel();
      }
      return Promise.resolve();
    },
  };
}
