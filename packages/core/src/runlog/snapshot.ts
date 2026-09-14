import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { readEvents, RunLogError, type RunPaths } from './log.js';
import { replay, type RunState } from './state.js';

/**
 * `state.json`: a cache of what `events.jsonl` already says.
 *
 * Nothing here is exported from the package yet. Publishing safely means holding the run's lock
 * across reading the log, replaying it and writing the result, and only the writer holds that lock
 * — so an unlocked public rebuild would be an invitation to overwrite a newer snapshot with an
 * older projection. Integration is the next slice's job.
 */

export type SnapshotFault =
  /** The log could not be read: a filesystem failure, not a statement about its contents. */
  | 'log_unreadable'
  /** The log was read, and is established to be something this code did not write. */
  | 'log_corrupt'
  /** The log has a damaged tail, so it describes no complete run. */
  | 'log_incomplete'
  /** The log was read whole but contradicts itself. */
  | 'log_unreplayable'
  /** The snapshot could not be written. Any previous snapshot is untouched. */
  | 'publish_failed';

export class SnapshotError extends Error {
  /** A temporary file left behind because its cleanup failed too. */
  readonly residue?: string;
  constructor(
    readonly fault: SnapshotFault,
    readonly path: string,
    message: string,
    residue?: string,
  ) {
    super(`${path}: ${message}${residue === undefined ? '' : `; ${residue} remains`}`);
    this.name = 'SnapshotError';
    if (residue !== undefined) this.residue = residue;
  }
}

export interface PublishOptions {
  /** Injectable so tests can fail each half of the publish separately. */
  readonly write?: (path: string, text: string) => void;
  readonly rename?: (from: string, to: string) => void;
}

/**
 * Write the snapshot, or leave the previous one exactly as it was.
 *
 * The state goes to a temporary file first and is renamed into place, so a reader never sees a
 * half-written snapshot and a failed publish costs nothing: the rename is the only step that
 * replaces anything, and it either happens or does not.
 */
export function publishSnapshot(
  paths: RunPaths,
  state: RunState,
  options: PublishOptions = {},
): void {
  const temp = `${paths.state}.tmp`;
  const write =
    options.write ?? ((path: string, text: string) => writeFileSync(path, text, 'utf8'));
  const rename = options.rename ?? ((from: string, to: string) => renameSync(from, to));
  try {
    write(temp, `${JSON.stringify(state, null, 2)}\n`);
    rename(temp, paths.state);
  } catch (cause) {
    // Clear the temporary file, but never at the cost of the reason we are here: if cleanup fails
    // too, the original failure still surfaces and the leftover is named alongside it.
    let residue: string | undefined;
    try {
      rmSync(temp, { force: true });
    } catch {
      residue = temp;
    }
    throw new SnapshotError(
      'publish_failed',
      paths.state,
      `could not publish the snapshot: ${(cause as Error).message}`,
      residue,
    );
  }
}

/**
 * The cached snapshot as parsed JSON, or `undefined` when there is none and it cannot be read.
 *
 * The return type is `unknown` on purpose. This returns what the file says and nothing more: it
 * does not establish that the snapshot matches the authoritative log — a snapshot can be
 * syntactically fine, carry a plausible `lastSeq`, and still describe a different run — and it does
 * not establish that the file is a {@link RunState} at all. `null`, a number and an array are all
 * valid JSON. Typing this as `RunState` would hand a caller a shape nothing had checked. Only
 * {@link projectLog} speaks for the events.
 */
export function readSnapshot(paths: RunPaths): unknown {
  try {
    return JSON.parse(readFileSync(paths.state, 'utf8'));
  } catch {
    return undefined; // missing or unreadable: a cache miss, not an error
  }
}

/**
 * Project the authoritative log, or refuse.
 *
 * Refusal writes nothing, so whatever snapshot exists survives untouched rather than being replaced
 * by a projection of a prefix. A damaged log's valid prefix is never a recovered run.
 */
export function projectLog(paths: RunPaths): RunState {
  let read;
  try {
    read = readEvents(paths.events);
  } catch (cause) {
    // The reader distinguishes "I could not read this file" from "I read it and it is not a log".
    // Collapsing the two would report established corruption as an I/O problem.
    const corrupt = cause instanceof RunLogError && cause.fault === 'corrupt';
    const prefix = `${paths.events}: `;
    const said = (cause as Error).message;
    const detail = said.startsWith(prefix) ? said.slice(prefix.length) : said;
    throw new SnapshotError(
      corrupt ? 'log_corrupt' : 'log_unreadable',
      paths.events,
      corrupt ? `the log is corrupt: ${detail}` : `the log could not be read: ${detail}`,
    );
  }
  if (!read.complete)
    throw new SnapshotError(
      'log_incomplete',
      paths.events,
      `the log has a damaged tail (${read.damagedTail?.detail ?? 'unknown'}), so it describes no complete run`,
    );
  try {
    return replay(read.events);
  } catch (cause) {
    throw new SnapshotError(
      'log_unreplayable',
      paths.events,
      `the log cannot be replayed: ${(cause as Error).message}`,
    );
  }
}
