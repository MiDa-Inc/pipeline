import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';

import type { EventPayload, NodeName, PipelineEvent, Round } from './events.js';
import { nextHandoffPath, writeHandoffFile, type WriteHandoffOptions } from './handoff.js';
import { publishSnapshot, type PublishOptions } from './snapshot.js';
import { replay, type RunState } from './state.js';

// See packages/runtime/src/scenario.ts: both packages are CommonJS with ESM-style declarations,
// and this repository compiles NodeNext with no esModuleInterop.
const addFormats: ajvFormats.FormatsPlugin = ajvFormats.default.default;

/**
 * The run folder and its append-only event log.
 *
 * `events.jsonl` is authoritative. Everything else in the folder is a projection that can be
 * rebuilt from it, so nothing here ever rewrites, truncates or repairs the log.
 */

/** How long a writer waits for the log's lock before reporting it as held: 100 x 10ms. */
const LOCK_ATTEMPTS = 100;
const LOCK_WAIT_MS = 10;

/** Run ids become a directory name, so they may not reach outside the runs directory. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Persisted records are validated against the checked-in schema rather than a hand-written guard,
 * so there is one description of an event rather than two that can drift apart.
 */
let compiled: ValidateFunction | undefined;
const eventValidator = (): ValidateFunction => {
  if (compiled === undefined) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv); // date-time is a plugin rather than built in
    const schema = new URL('../../../../spec/events.schema.json', import.meta.url);
    compiled = ajv.compile(JSON.parse(readFileSync(fileURLToPath(schema), 'utf8')) as object);
  }
  return compiled;
};

export interface RunPaths {
  readonly root: string;
  readonly events: string;
  readonly state: string;
  readonly handoffs: string;
}

/**
 * A tail that was being written when something stopped.
 *
 * `unterminated` covers a final record that parses but has no closing newline. Its content may well
 * be intact, but the framing is not, and an intact-looking object is exactly what a torn write can
 * leave behind — so it is reported as damage rather than accepted as the last event.
 */
export interface DamagedTail {
  readonly kind: 'unparsable' | 'unterminated';
  /** 1-based line number in the file. */
  readonly line: number;
  /** Where the damaged line starts, in bytes, so the file can be inspected. */
  readonly byteOffset: number;
  readonly text: string;
  readonly detail: string;
}

/** The events that were read, and whether they are all of them. */
export interface ReadResult {
  /** The valid prefix. When `complete` is false this is a prefix, not the whole log. */
  readonly events: readonly PipelineEvent[];
  /** False whenever a damaged tail was found, so a prefix cannot be mistaken for a clean log. */
  readonly complete: boolean;
  readonly damagedTail?: DamagedTail;
}

/** Thrown when an appender is asked to reopen a log whose tail is damaged. */
/**
 * What went wrong with a log, as a fault a caller can branch on.
 *
 * The line between `damaged_tail` and `corrupt` is what an interrupted append can actually produce.
 * A torn write leaves a truncated or unterminated final line and nothing else, so those two are
 * recoverable tail damage. A record that is not a valid event, a `seq` that skips, or a `run_id`
 * that disagrees cannot come from a torn append: the file has been rewritten or damaged some other
 * way, and no part of it is trustworthy.
 */
/** The event `writeHandoff` records, narrowed so a caller can read the path it chose. */
export type HandoffEvent = Extract<PipelineEvent, { type: 'handoff_written' }>;

export type RunLogFault =
  /** The last line is torn. The prefix before it is sound. */
  | 'damaged_tail'
  /** The file is not a log this code wrote. Nothing in it is trusted. */
  | 'corrupt'
  /** Another writer advanced the log past this handle's sequence state. */
  | 'stale_writer'
  /** This handle already failed a write, and may not append again until the run is reopened. */
  | 'writer_invalid'
  /** The event the caller asked to append is not a valid event. Nothing was attempted. */
  | 'invalid_event'
  /** Another writer holds the log's lock. Nothing was attempted. */
  | 'lock_unavailable'
  /**
   * An event was committed, but the lock could not be released afterwards. The append succeeded;
   * what failed is cleanup, and the stale lock now blocks later writers until it is removed.
   */
  | 'lock_residue'
  /**
   * An event was committed, but `state.json` could not be republished from it. The log is intact
   * and authoritative; only its cache is behind, so the fix is to project again, never to append
   * the event a second time.
   */
  | 'snapshot_failed'
  /**
   * The snapshot could not be rebuilt when the run was opened. Nothing was appended, so the log is
   * byte-identical and whatever snapshot already existed is untouched.
   */
  | 'rebuild_failed';

/**
 * What became of the log's bytes when a fault was raised. Three states, not two: a fault can follow
 * a write that fully succeeded, and calling that either "untouched" or "possibly partial" is wrong.
 */
export type LogBytes =
  /** Nothing was written. The file is byte-identical. */
  | 'unchanged'
  /** The event was written in full. The failure is in what happened afterwards. */
  | 'committed'
  /** A write was in flight and may have emitted part of a line. */
  | 'uncertain';

const BYTES_NOTE: Record<LogBytes, string> = {
  unchanged: 'The log was left untouched.',
  committed: 'The event was written; the log itself is intact.',
  uncertain: 'Part of a line may have been written; re-read the log.',
};

export class RunLogError extends Error {
  readonly damagedTail?: DamagedTail;
  /**
   * A handoff file that was written but never recorded, because the append that would have
   * recorded it failed. The file is deliberately left in place; it is evidence, and the next
   * handoff for that node and round refuses rather than writing over it.
   */
  handoff?: string;
  constructor(
    readonly fault: RunLogFault,
    readonly path: string,
    message: string,
    readonly bytes: LogBytes,
    damagedTail?: DamagedTail,
  ) {
    super(`${path}: ${message}. ${BYTES_NOTE[bytes]}`);
    this.name = 'RunLogError';
    if (damagedTail !== undefined) this.damagedTail = damagedTail;
  }

  /** True only when the file is known to be byte-identical. */
  get bytesUnchanged(): boolean {
    return this.bytes === 'unchanged';
  }
}

const corrupt = (path: string, line: number, detail: string): RunLogError =>
  new RunLogError('corrupt', path, `line ${line}: ${detail}`, 'unchanged');

export function runPaths(baseDir: string, runId: string): RunPaths {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)}`);
  const root = join(baseDir, '.pipeline', 'runs', runId);
  return {
    root,
    events: join(root, 'events.jsonl'),
    state: join(root, 'state.json'),
    handoffs: join(root, 'handoffs'),
  };
}

/**
 * Create the run folder if it is not there. Existing runs are preserved: directories are created
 * recursively and no file is opened for writing, so reopening a run never clobbers its log.
 */
export function createRunFolder(baseDir: string, runId: string): RunPaths {
  const paths = runPaths(baseDir, runId);
  mkdirSync(paths.handoffs, { recursive: true });
  return paths;
}

/**
 * Read a log, reporting a damaged tail rather than throwing.
 *
 * Damage anywhere earlier is a hard error: a torn final line is what an interrupted append leaves,
 * while a torn line in the middle means the file was rewritten or corrupted, and no prefix of it
 * can be trusted.
 */
/** The first few Ajv errors. A failed `oneOf` reports every branch, which is unreadable in full. */
const describe = (validate: ValidateFunction): string =>
  (validate.errors ?? [])
    .slice(0, 3)
    .map((e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? 'invalid'}`)
    .join('; ');

export function readEvents(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // Only "there is no log yet" is not damage. Anything else — a directory in its place, a
    // permission failure — must surface rather than masquerade as an empty run.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { events: [], complete: true };
  }
  if (text === '') return { events: [], complete: true };
  const terminated = text.endsWith('\n');
  const lines = text.split('\n');
  if (terminated) lines.pop();

  const events: PipelineEvent[] = [];
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    const damaged = (kind: DamagedTail['kind'], detail: string): ReadResult => ({
      events,
      complete: false,
      damagedTail: { kind, line: index + 1, byteOffset: offset, text: line, detail },
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (!last) throw corrupt(path, index + 1, 'not valid JSON, and not the last line');
      return damaged('unparsable', `line ${index + 1} is not valid JSON`);
    }
    if (last && !terminated)
      return damaged('unterminated', `line ${index + 1} has no closing newline`);
    const validate = eventValidator();
    if (!validate(parsed))
      throw corrupt(path, index + 1, `not a valid event: ${describe(validate)}`);
    const event = parsed as PipelineEvent;
    // `seq` is 1-based, strictly increasing and gapless (SPEC section 3), and every event in a log
    // belongs to one run. Both are checked here so nothing downstream has to assume them.
    if (event.seq !== events.length + 1)
      throw corrupt(
        path,
        index + 1,
        `seq ${event.seq} breaks the sequence at ${events.length + 1}`,
      );
    const first = events[0];
    if (first !== undefined && event.run_id !== first.run_id)
      throw corrupt(path, index + 1, `run_id ${event.run_id} does not match ${first.run_id}`);
    events.push(event);
    offset += Buffer.byteLength(line, 'utf8') + 1;
  }
  return { events, complete: true };
}

export interface RunLogOptions {
  /** Injectable so tests can pin `ts`. Defaults to the wall clock. */
  readonly now?: () => Date;
  /**
   * The append primitive. Injectable so tests can simulate a write that fails after emitting a
   * prefix, which is the failure that turns a recoverable tail into buried corruption.
   */
  readonly writeLine?: (path: string, line: string) => void;
  /**
   * Lock primitives. Injectable for the same reason as `writeLine`: a lock that cannot be claimed
   * or released is otherwise only reachable with a full disk or an unwritable directory.
   */
  readonly lock?: {
    readonly stamp?: (fd: number) => void;
    readonly remove?: (path: string) => void;
  };
  /** Passed through to snapshot publication, so tests can fail it. */
  readonly snapshot?: PublishOptions;
  /** Passed through to handoff file writing, so tests can fail it. */
  readonly handoff?: WriteHandoffOptions;
}

export interface RunLog {
  readonly paths: RunPaths;
  /** The events already in the log when it was opened. */
  readonly existing: readonly PipelineEvent[];
  /** The `seq` the next append will use. */
  readonly nextSeq: number;
  /**
   * Why this handle can no longer write, readable without appending again. Set for a cleanup
   * failure that left the append itself intact, so the caller can learn about a stale lock.
   */
  readonly fault?: RunLogError | undefined;
  /**
   * The last publication failure, if the most recent append committed its event but could not
   * republish `state.json`. Separate from {@link fault} because the handle is still usable and the
   * log is still authoritative: both can be set at once, and both need to be discoverable.
   */
  readonly snapshotFault?: RunLogError | undefined;
  append(payload: EventPayload): PipelineEvent;
  /**
   * Write a handoff for `node` in `round`, then record it.
   *
   * The path is `handoffs/r<round>-<node>-<n>.txt`, with `n` counting the handoffs already recorded
   * for that node and round. Allocation, the file write, the event and the republished snapshot all
   * happen under one lock, so no other writer can take the same path or the same `seq` in between.
   *
   * The file is written **before** the event, because an event must never name a file that is not
   * there. The reverse is possible and is reported rather than hidden: if the append then fails,
   * the file stays and the error carries its path in {@link RunLogError.handoff}.
   *
   * Throws {@link HandoffError} for a destination that already exists or a file that could not be
   * written, and {@link RunLogError} for everything that goes wrong once the file is on disk.
   */
  writeHandoff(node: NodeName, round: Round, contents: string): HandoffEvent;
}

/**
 * Open a run for appending, creating its folder if needed.
 *
 * Refuses a log with an unresolved damaged tail: appending past one would bury the damage in the
 * middle of the file, where it stops being recoverable. Also refuses a log belonging to a different
 * run, which would otherwise gain a second run's events.
 */
export function openRunLog(baseDir: string, runId: string, options: RunLogOptions = {}): RunLog {
  const paths = createRunFolder(baseDir, runId);
  const now = options.now ?? (() => new Date());
  const writeLine = options.writeLine ?? ((path, line) => appendFileSync(path, line));
  const lockPath = `${paths.events}.lock`;
  const stampLock = options.lock?.stamp ?? ((fd: number) => void writeSync(fd, `${process.pid}\n`));
  const removeLock = options.lock?.remove ?? ((path: string) => rmSync(path, { force: true }));
  const discard = (fd: number): void => {
    try {
      closeSync(fd);
    } finally {
      removeLock(lockPath);
    }
  };
  /**
   * Take the log's lock, or fail rather than proceed unlocked. `wx` is atomic across processes, so
   * exactly one writer holds it; a short bounded wait absorbs ordinary contention, and anything
   * longer is reported with the lock's path so a lock left by a killed process can be removed.
   */
  const acquire = (): (() => string | undefined) => {
    for (let attempt = 0; ; attempt += 1) {
      let fd: number;
      try {
        fd = openSync(lockPath, 'wx');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= LOCK_ATTEMPTS)
          throw new RunLogError(
            'lock_unavailable',
            paths.events,
            `another writer holds ${lockPath}`,
            'unchanged',
          );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
        continue;
      }
      try {
        stampLock(fd);
      } catch (cause) {
        // The lock file exists but this writer never took ownership of it. Leaving it behind would
        // lock the run out for good, and report the wrong reason to every later writer — so clean
        // up, and if cleanup also fails, say so *alongside* the claim failure rather than instead
        // of it. The original cause is what a caller needs; the stale lock is what an operator does.
        let stranded: string | undefined;
        try {
          discard(fd);
        } catch (secondary) {
          stranded = (secondary as Error).message;
        }
        throw new RunLogError(
          'lock_unavailable',
          paths.events,
          `could not claim ${lockPath}: ${(cause as Error).message}` +
            (stranded === undefined
              ? ''
              : `; ${lockPath} could not be removed either (${stranded}) and remains`),
          'unchanged',
        );
      }
      // Releasing never throws; it reports. Cleanup must not overwrite an append's own outcome.
      return () => {
        try {
          discard(fd);
          return undefined;
        } catch (cause) {
          return (cause as Error).message;
        }
      };
    }
  };
  /** Set once this handle may no longer write. Recovery is reopening the run, never continuing. */
  let invalid: RunLogError | undefined;
  /** The last publication failure. It does not stop the handle writing again. */
  let snapshotFault: RunLogError | undefined;

  /**
   * Run one operation with the log's lock held throughout, and release it afterwards without ever
   * replacing what the operation itself concluded. A lock that could not be released is reported
   * either way: as a fault on the handle when the operation succeeded, and appended to the failure
   * when it did not, so the stranded lock is discoverable in both cases.
   *
   * `append` keeps its own release handling: its residue must report the event's bytes as
   * `committed`, which this helper has no way to know.
   */
  const withLock = <T>(body: () => T): T => {
    const release = acquire();
    let result: T | undefined;
    let failure: unknown;
    try {
      result = body();
    } catch (cause) {
      failure = cause;
    }
    const stuck = release();
    if (stuck !== undefined) {
      const note = `${lockPath} could not be released (${stuck}) and remains`;
      if (failure === undefined)
        invalid ??= new RunLogError('lock_residue', paths.events, note, 'unchanged');
      else (failure as Error).message += `; ${note}`;
    }
    if (failure !== undefined) throw failure;
    return result as T;
  };

  /**
   * One locked read supplies everything this handle starts from: the events it reports as
   * `existing`, the `seq` it will append next, and the snapshot republished from them. Reading
   * once under the lock is what stops an older projection being published over a newer one — a
   * second, earlier read would let this handle publish a log state that has since moved on.
   *
   * A run with no events and no snapshot has nothing to project, so it is left alone entirely.
   */
  const read = withLock((): ReadResult => {
    const seen = readEvents(paths.events);
    if (seen.damagedTail !== undefined)
      throw new RunLogError(
        'damaged_tail',
        paths.events,
        seen.damagedTail.detail,
        'unchanged',
        seen.damagedTail,
      );
    const owner = seen.events[0]?.run_id;
    if (owner !== undefined && owner !== runId)
      throw corrupt(paths.events, 1, `log belongs to run ${owner}, not ${runId}`);
    if (seen.events.length > 0 || existsSync(paths.state)) {
      try {
        publishSnapshot(paths, replay(seen.events), options.snapshot ?? {});
      } catch (cause) {
        // Nothing was appended, so the log's bytes are exactly as they were; an unprojectable or
        // unpublishable log simply keeps whatever snapshot it already had.
        snapshotFault = new RunLogError(
          'rebuild_failed',
          paths.events,
          `the snapshot could not be rebuilt: ${(cause as Error).message}`,
          'unchanged',
        );
      }
    }
    return seen;
  });

  let nextSeq = (read.events.at(-1)?.seq ?? 0) + 1;

  const stop = (fault: RunLogFault, message: string): RunLogError => {
    invalid = new RunLogError(fault, paths.events, message, 'unchanged');
    return invalid;
  };

  /**
   * Read the log afresh and repeat the checks every write depends on.
   *
   * **The caller must hold the lock.** What comes back describes the log only while that lock is
   * held: releasing it and reacquiring before using the result would reintroduce exactly the
   * interleaving the lock exists to prevent, so the read and the write it authorises belong to one
   * acquisition.
   */
  const readUnderLock = (): ReadResult => {
    // Allocation is serialised against the file, not against this handle's cached counter.
    let observed;
    try {
      observed = readEvents(paths.events);
    } catch (cause) {
      throw stop('corrupt', `the log no longer reads cleanly: ${(cause as Error).message}`);
    }
    if (observed.damagedTail !== undefined)
      throw stop('damaged_tail', `the log has a damaged tail: ${observed.damagedTail.detail}`);
    // Ownership is rechecked every time: the file underneath a handle can be replaced by a
    // different run's log that happens to sit at the same seq.
    const owner = observed.events[0]?.run_id;
    if (owner !== undefined && owner !== runId)
      throw stop('corrupt', `the log now belongs to run ${owner}, not ${runId}`);
    const found = observed.events.at(-1)?.seq ?? 0;
    if (found !== nextSeq - 1)
      throw stop(
        'stale_writer',
        `the log is at seq ${found}, but this writer expects ${nextSeq - 1}`,
      );
    return observed;
  };

  /**
   * Check that `event` may join the history `observed` describes, and return the projection the log
   * would have once it lands. Writes nothing.
   *
   * **The caller must hold the lock**, and `observed` must come from that same acquisition — see
   * {@link readUnderLock}.
   */
  const projectCandidate = (event: PipelineEvent, observed: ReadResult): RunState => {
    // An accepted append must leave the log projectable. Schema validity is not enough: an
    // event can be well formed and still contradict the history it lands on. The projection is
    // kept: it is exactly what the log will say once this event lands, computed under the lock.
    let projected;
    try {
      projected = replay([...observed.events, event]);
    } catch (cause) {
      // Two different failures wear the same exception. If the history alone cannot be
      // projected, the file is already broken and this handle is finished; if only the
      // candidate breaks it, that is the caller's event and the run is untouched.
      try {
        replay(observed.events);
      } catch {
        throw stop('corrupt', `the existing log cannot be replayed: ${(cause as Error).message}`);
      }
      throw new RunLogError(
        'invalid_event',
        paths.events,
        `refusing an event that would make the log unreplayable: ${(cause as Error).message}`,
        'unchanged',
      );
    }
    return projected;
  };

  /**
   * Write one validated event and republish the projection it produces. **The caller must hold the
   * lock**, and `projected` must come from {@link projectCandidate} for this same event and read.
   */
  const writeAndPublish = (event: PipelineEvent, projected: RunState): void => {
    try {
      writeLine(paths.events, `${JSON.stringify(event)}\n`);
    } catch (cause) {
      // The write may have emitted a prefix. This handle can no longer know where the file
      // ends, so it never writes again; reopening reports whatever was left behind.
      invalid = new RunLogError(
        'writer_invalid',
        paths.events,
        `an append failed: ${(cause as Error).message}`,
        'uncertain',
      );
      throw invalid;
    }
    // seq advances the moment the bytes are on disk, before any cleanup can fail.
    nextSeq += 1;

    // Still holding the lock, so the projection published here is the one for the log as it
    // now stands. A failure here does not un-commit anything: it is recorded and returned
    // alongside the event, because appending again would duplicate it.
    try {
      publishSnapshot(paths, projected, options.snapshot ?? {});
      snapshotFault = undefined;
    } catch (cause) {
      snapshotFault = new RunLogError(
        'snapshot_failed',
        paths.events,
        `seq ${event.seq} was committed, but its projection could not be published: ${(cause as Error).message}`,
        'committed',
      );
    }
  };

  const commitUnderLock = (event: PipelineEvent, observed: ReadResult): void =>
    writeAndPublish(event, projectCandidate(event, observed));

  const validateCandidate = (event: PipelineEvent): void => {
    const validate = eventValidator();
    if (!validate(event))
      throw new RunLogError(
        'invalid_event',
        paths.events,
        `refusing to append an invalid event: ${describe(validate)}`,
        'unchanged',
      );
  };

  /**
   * Run one writing operation with the lock held from the authoritative read through publication,
   * then release it without ever replacing what the operation concluded.
   *
   * A lock that could not be released is reported as a fault on the handle, describing the log's
   * bytes as `committed` when an event landed and `unchanged` when none did.
   */
  const locked = (body: (observed: ReadResult) => PipelineEvent): PipelineEvent => {
    if (invalid !== undefined) throw invalid;
    const release = acquire();
    let committed: PipelineEvent | undefined;
    let outcome: unknown;
    try {
      committed = body(readUnderLock());
    } catch (cause) {
      outcome = cause;
    }
    // Cleanup runs after the outcome is settled and can never replace it: a failed release of a
    // committed event is not a rejected write, and must not be reported as one.
    const stuck = release();
    // The lock is still on disk, so this handle cannot write again either way. `??=` keeps a
    // more serious fault, such as a torn write, as the reason the handle is finished.
    if (stuck !== undefined)
      invalid ??= new RunLogError(
        'lock_residue',
        paths.events,
        committed === undefined
          ? `${lockPath} could not be released: ${stuck}`
          : `seq ${committed.seq} was committed, but ${lockPath} could not be released: ${stuck}`,
        committed === undefined ? 'unchanged' : 'committed',
      );
    if (outcome !== undefined) throw outcome;
    return committed as PipelineEvent;
  };

  return {
    paths,
    existing: read.events,
    get nextSeq() {
      return nextSeq;
    },
    get fault() {
      return invalid;
    },
    get snapshotFault() {
      return snapshotFault;
    },

    append(payload: EventPayload): PipelineEvent {
      if (invalid !== undefined) throw invalid;
      // Refuse an event the reader would reject before anything is locked or written: the writer
      // must never be able to persist a record that makes its own log unreadable. A caller's bad
      // event is not corruption, so the handle stays usable and `nextSeq` does not move.
      const event = { ...payload, run_id: runId, seq: nextSeq, ts: now().toISOString() };
      validateCandidate(event);
      return locked((observed) => {
        commitUnderLock(event, observed);
        return event;
      });
    },

    writeHandoff(node: NodeName, round: Round, contents: string): HandoffEvent {
      return locked((observed) => {
        // Allocation reads the handoffs this log has recorded, under the same lock that will
        // record the next one, so two writers cannot be handed the same path.
        const recorded = observed.events
          .filter((e) => e.type === 'handoff_written')
          .map((e) => ({ node: e.node, round: e.round, path: e.path }));
        const path = nextHandoffPath(recorded, node, round);
        // Everything that can refuse this handoff happens before the file exists — the timestamp,
        // the schema and the history it would land on — so a refusal leaves nothing behind. Only
        // the file write itself, and the event write after it, can orphan anything.
        const stamped = {
          type: 'handoff_written' as const,
          node,
          round,
          path,
          run_id: runId,
          seq: nextSeq,
          ts: now().toISOString(),
        };
        validateCandidate(stamped);
        const projected = projectCandidate(stamped, observed);
        writeHandoffFile(paths, path, contents, options.handoff ?? {});
        try {
          writeAndPublish(stamped, projected);
        } catch (cause) {
          // The file is on disk and nothing records it. The append's own fault and byte state are
          // what the caller needs — a torn line still leaves the log uncertain — so they are kept
          // and the orphan is named alongside them rather than replacing them.
          if (cause instanceof RunLogError) cause.handoff = path;
          throw cause;
        }
        return stamped;
      }) as HandoffEvent;
    },
  };
}
