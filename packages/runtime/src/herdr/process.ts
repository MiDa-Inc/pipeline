import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type {
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
 * Nothing here is exported from the package yet: a complete `RuntimeAdapter` needs the observation
 * and shutdown behaviour that slice 11c-2 adds, and half of one with ignored deadlines would be
 * worse than none.
 *
 * **Output.** `ProcessSpec.command` is a shell command string, so it runs through a shell and keeps
 * its quoting and pipelines. stdout and stderr are decoded **separately** — each stream has its own
 * decoder, because a multibyte character arriving in two stdout chunks can have a stderr chunk
 * between them, and decoding one interleaved buffer would corrupt it — and the decoded pieces are
 * appended in arrival order, so `output` reads as the terminal showed it.
 */

/** Bytes of combined stdout and stderr retained before the result is refused rather than truncated. */
export const DEFAULT_OUTPUT_LIMIT = 8 * 1024 * 1024;

export interface GateRunnerOptions {
  /** The shell that interprets `ProcessSpec.command`. */
  readonly shell?: string;
  /** Raw bytes across both streams. Past this, output stops being retained (see the module note). */
  readonly outputLimit?: number;
  /** How a child is started. Injectable so tests can observe *when* dispatch happens. */
  readonly spawn?: typeof spawn;
}

interface Execution {
  readonly executionId: ExecutionId;
  /** Set once the process ended, in whatever way. Retained and replayed unchanged. */
  settled: Promise<ProcessObservation>;
}

export interface GateRunner {
  /** Synchronous and identity-first: the id exists before any I/O, as the adapter requires. */
  start(spec: ProcessSpec): ProcessLaunch;
  /** Waits for the execution to end. Deadlines and cancellation arrive in 11c-2. */
  observe(executionId: ExecutionId): Promise<ProcessObservation>;
}

export function createGateRunner(options: GateRunnerOptions = {}): GateRunner {
  const shell = options.shell ?? '/bin/sh';
  const start = options.spawn ?? spawn;
  const limit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const executions = new Map<string, Execution>();
  let nextId = 0;

  return {
    start(spec: ProcessSpec): ProcessLaunch {
      const executionId = `gate-${++nextId}` as ExecutionId;
      let announceStart: (outcome: SubmissionOutcome) => void = () => undefined;
      const started = new Promise<SubmissionOutcome>((resolve) => (announceStart = resolve));
      let publish: (observation: ProcessObservation) => void = () => undefined;
      const settled = new Promise<ProcessObservation>((resolve) => (publish = resolve));
      executions.set(executionId, { executionId, settled });

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
        // backgrounds a long-lived process keeps its execution open — bounded by the deadline that
        // slice 11c-2 adds, and by the output cap above.
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

    observe(executionId: ExecutionId): Promise<ProcessObservation> {
      const execution = executions.get(executionId);
      if (execution === undefined)
        return Promise.resolve({ kind: 'unrecoverable', executionId, reason: 'unknown_execution' });
      return execution.settled;
    },
  };
}
