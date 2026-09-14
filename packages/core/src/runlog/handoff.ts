import { closeSync, mkdirSync, openSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { join, relative as relativeTo } from 'node:path';

import type { NodeName, Round } from './events.js';
import type { RunPaths } from './log.js';
import type { HandoffRecord } from './state.js';

/**
 * Handoff files: where a node's output is written for the next node to read (SPEC R11).
 *
 * These are the file primitives only. Choosing a path from the recorded handoffs and then writing
 * to it is safe against a concurrent writer only while the run's lock is held across both, and
 * that serialisation belongs with the recording step. Nothing here is exported from the package.
 */

/** Matches `nodeName` in spec/events.schema.json. A name outside it could reshape the path. */
const NODE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The only shape a handoff path may take, checked against the string **as supplied**.
 *
 * Resolving first and inspecting afterwards is not equivalent: `handoffs/sub/../r1-a-1.txt`
 * normalises to something acceptable while remaining a path the event schema rejects, and the
 * value recorded in `handoff_written` is the caller's string, not the normalised one.
 */
const HANDOFF_PATH = /^handoffs\/([^/\\]+)$/;

export type HandoffFault =
  /** The node or round does not name a handoff this code would ever write. */
  | 'invalid_target'
  /** Something is already at the destination. It is left exactly as it was. */
  | 'destination_exists'
  /** The file could not be written. Anything this call created has been cleared. */
  | 'write_failed';

export class HandoffError extends Error {
  /** A partial file left behind because clearing it failed too. */
  readonly residue?: string;
  constructor(
    readonly fault: HandoffFault,
    readonly path: string,
    message: string,
    residue?: string,
  ) {
    super(`${path}: ${message}${residue === undefined ? '' : `; ${residue} remains`}`);
    this.name = 'HandoffError';
    if (residue !== undefined) this.residue = residue;
  }
}

/**
 * The path the next handoff for this node and round takes: `handoffs/r<round>-<node>-<n>.txt`,
 * with `n` counting the handoffs already **recorded** for that node and round, from 1.
 *
 * Recorded, not present on disk. A file with no event behind it never advances the count — the
 * writer refuses such a collision rather than skipping past evidence of an earlier failure.
 */
export function nextHandoffPath(
  handoffs: readonly HandoffRecord[],
  node: NodeName,
  round: Round,
): string {
  if (!NODE_NAME.test(node)) throw new HandoffError('invalid_target', node, 'is not a node name');
  if (!Number.isInteger(round) || round < 1)
    throw new HandoffError('invalid_target', String(round), 'is not a round');
  const taken = handoffs.filter((h) => h.node === node && h.round === round).length;
  return `handoffs/r${round}-${node}-${taken + 1}.txt`;
}

export interface WriteHandoffOptions {
  /**
   * The write primitive, returning how many bytes it wrote. Injectable so tests can produce a
   * short write, which is the failure that looks most like success.
   */
  readonly write?: (fd: number, buffer: Buffer, offset: number) => number;
  readonly close?: (fd: number) => void;
  readonly remove?: (path: string) => void;
}

/**
 * Write a handoff, creating it exclusively.
 *
 * `wx` makes "refuse if something is already there" one atomic step rather than a check followed by
 * a write, so a file that appears in between is still refused rather than overwritten. The two
 * failures are kept apart: a destination that already existed is never touched, while a file this
 * call created and then failed to finish is cleared — and if clearing fails, the leftover is named.
 */
export function writeHandoffFile(
  paths: RunPaths,
  path: string,
  contents: string,
  options: WriteHandoffOptions = {},
): string {
  const name = HANDOFF_PATH.exec(path)?.[1];
  if (name === undefined || name === '.' || name === '..')
    throw new HandoffError('invalid_target', path, 'is not of the form handoffs/<name>');

  try {
    mkdirSync(paths.handoffs, { recursive: true });
  } catch (cause) {
    throw new HandoffError(
      'write_failed',
      paths.handoffs,
      `could not be created: ${(cause as Error).message}`,
    );
  }
  // Where the directory *really* is, not where it is named: a symlinked handoffs/ would otherwise
  // carry an acceptable-looking path to a file outside the run folder entirely.
  let root: string;
  let directory: string;
  try {
    root = realpathSync(paths.root);
    directory = realpathSync(paths.handoffs);
  } catch (cause) {
    throw new HandoffError(
      'write_failed',
      paths.handoffs,
      `could not be resolved: ${(cause as Error).message}`,
    );
  }
  if (relativeTo(root, directory) !== 'handoffs')
    throw new HandoffError('invalid_target', paths.handoffs, `does not resolve inside ${root}`);

  const absolute = join(directory, name);
  let fd: number;
  try {
    fd = openSync(absolute, 'wx');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST')
      throw new HandoffError(
        'destination_exists',
        absolute,
        'already exists, and is left as it is; nothing recorded it, so it is not this handoff',
      );
    throw new HandoffError(
      'write_failed',
      absolute,
      `could not be created: ${(cause as Error).message}`,
    );
  }

  const write =
    options.write ??
    ((handle: number, buffer: Buffer, offset: number) => writeSync(handle, buffer, offset));
  const close = options.close ?? ((handle: number) => closeSync(handle));
  const remove = options.remove ?? ((target: string) => rmSync(target, { force: true }));
  let closed = false;
  /** Undo this call's own work. It only ever touches the file this call created. */
  const clear = (): string | undefined => {
    if (!closed) {
      closed = true;
      try {
        close(fd);
      } catch {
        /* already failing; the close result adds nothing to the reason */
      }
    }
    try {
      remove(absolute);
      return undefined;
    } catch {
      return absolute;
    }
  };

  const buffer = Buffer.from(contents, 'utf8');
  try {
    // A short write is not a failure and not a success: it has to be finished, or the file is
    // silently truncated. Multi-byte characters make that especially easy to miss.
    let written = 0;
    while (written < buffer.length) {
      const wrote = write(fd, buffer, written);
      if (!(wrote > 0)) throw new Error(`stalled after ${written} of ${buffer.length} bytes`);
      written += wrote;
    }
  } catch (cause) {
    throw new HandoffError(
      'write_failed',
      absolute,
      `could not be written: ${(cause as Error).message}`,
      clear(),
    );
  }

  try {
    closed = true;
    close(fd);
  } catch (cause) {
    // Buffered bytes are flushed on close, so a close that fails leaves the file unfinished.
    throw new HandoffError(
      'write_failed',
      absolute,
      `could not be closed: ${(cause as Error).message}`,
      clear(),
    );
  }
  return path;
}
