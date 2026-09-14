import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { writeSync as writeSyncReal } from 'node:fs';

import { HandoffError, nextHandoffPath, writeHandoffFile } from '../src/runlog/handoff.js';
import { createRunFolder, type RunPaths } from '../src/runlog/log.js';
import type { HandoffRecord } from '../src/runlog/state.js';

const paths = (): RunPaths =>
  createRunFolder(mkdtempSync(join(tmpdir(), 'pipeline-handoff-')), 'r');
const recorded = (...pairs: [string, number][]): HandoffRecord[] =>
  pairs.map(([node, round]) => ({ node, round, path: 'recorded' }));

/** The pattern the event schema requires of every handoff path. */
const relativePath = new RegExp(
  (
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../spec/events.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as { $defs: { relativePath: { pattern: string } } }
  ).$defs.relativePath.pattern,
);

describe('choosing the next path', () => {
  it.each([
    ['nothing recorded', [] as [string, number][], 'handoffs/r1-test_gate-1.txt'],
    [
      'one for this node and round',
      [['test_gate', 1]] as [string, number][],
      'handoffs/r1-test_gate-2.txt',
    ],
    [
      'two for this node and round',
      [
        ['test_gate', 1],
        ['test_gate', 1],
      ] as [string, number][],
      'handoffs/r1-test_gate-3.txt',
    ],
    [
      'others for a different node',
      [
        ['reviewer', 1],
        ['reviewer', 1],
      ] as [string, number][],
      'handoffs/r1-test_gate-1.txt',
    ],
    [
      'others for a different round',
      [
        ['test_gate', 2],
        ['test_gate', 3],
      ] as [string, number][],
      'handoffs/r1-test_gate-1.txt',
    ],
  ])('counts from 1 with %s', (_label, pairs, expected) => {
    expect(nextHandoffPath(recorded(...pairs), 'test_gate', 1)).toBe(expected);
  });

  it('numbers each node and round independently', () => {
    const log = recorded(['a', 1], ['b', 1], ['a', 1], ['a', 2]);
    expect(nextHandoffPath(log, 'a', 1)).toBe('handoffs/r1-a-3.txt');
    expect(nextHandoffPath(log, 'b', 1)).toBe('handoffs/r1-b-2.txt');
    expect(nextHandoffPath(log, 'a', 2)).toBe('handoffs/r2-a-2.txt');
    expect(nextHandoffPath(log, 'a', 9)).toBe('handoffs/r9-a-1.txt');
  });

  it('produces a path the event schema accepts', () => {
    for (const node of ['a', 'test_gate', 'Review-2', '_x'])
      expect(nextHandoffPath([], node, 3)).toMatch(relativePath);
  });

  it.each([
    ['a node name with a separator', '../escape', 1],
    ['a node name starting with a digit', '1bad', 1],
    ['an empty node name', '', 1],
    ['round zero', 'a', 0],
    ['a fractional round', 'a', 1.5],
  ])('refuses %s', (_label, node, round) => {
    expect(() => nextHandoffPath([], node, round)).toThrow(HandoffError);
  });
});

describe('writing the file', () => {
  // the real location, since a handoff is written where the directory actually is
  const at = (p: RunPaths, path: string) =>
    join(realpathSync(p.handoffs), path.replace('handoffs/', ''));

  it.each([
    ['a single line', 'VERDICT: APPROVE\n'],
    ['no trailing newline', 'no newline here'],
    ['several lines and unicode', 'first\n\nthird — ⏺\n'],
    ['nothing at all', ''],
  ])('writes %s exactly, adding nothing', (_label, contents) => {
    const p = paths();
    const path = nextHandoffPath([], 'a', 1);
    expect(writeHandoffFile(p, path, contents)).toBe(path);
    expect(readFileSync(at(p, path), 'utf8')).toBe(contents);
  });

  it('refuses a destination that already exists, leaving it untouched', () => {
    const p = paths();
    const path = nextHandoffPath([], 'a', 1);
    writeFileSync(at(p, path), 'written by someone else', 'utf8');
    let thrown: HandoffError | undefined;
    try {
      writeHandoffFile(p, path, 'the new contents');
    } catch (error) {
      thrown = error as HandoffError;
    }
    expect(thrown?.fault).toBe('destination_exists');
    expect(thrown?.message).toContain(at(p, path));
    expect(readFileSync(at(p, path), 'utf8')).toBe('written by someone else');
  });

  it('refuses even when the existing contents are identical', () => {
    const p = paths();
    const path = nextHandoffPath([], 'a', 1);
    writeHandoffFile(p, path, 'same');
    expect(() => writeHandoffFile(p, path, 'same')).toThrow(/already exists/);
    expect(readFileSync(at(p, path), 'utf8')).toBe('same');
  });

  it('never clears a file it did not create', () => {
    const p = paths();
    const path = nextHandoffPath([], 'a', 1);
    writeFileSync(at(p, path), 'not mine', 'utf8');
    expect(() =>
      writeHandoffFile(p, path, 'x', {
        remove: () => {
          throw new Error('cleanup must not run for a pre-existing file');
        },
      }),
    ).toThrow(/already exists/);
    expect(existsSync(at(p, path))).toBe(true);
  });

  it.each([
    ['one byte at a time', 1],
    ['two bytes at a time', 2],
    ['seven bytes at a time', 7],
  ])('finishes a write that only takes %s', (_label, chunk) => {
    const p = paths();
    const path = nextHandoffPath([], 'a', 1);
    // multibyte on purpose: a short write can land mid-character, and counting characters rather
    // than bytes would truncate here
    const contents = 'VERDICT: APPROVE — ⏺ ✓\nsecond line\n';
    writeHandoffFile(p, path, contents, {
      write: (fd, buffer, offset) =>
        writeSyncReal(fd, buffer, offset, Math.min(chunk, buffer.length - offset)),
    });
    expect(readFileSync(at(p, path), 'utf8')).toBe(contents);
    expect(readFileSync(at(p, path)).length).toBe(Buffer.byteLength(contents, 'utf8'));
  });

  it('refuses a write that makes no progress rather than looping', () => {
    const p = paths();
    const path = nextHandoffPath([], 'a', 1);
    let thrown: HandoffError | undefined;
    try {
      writeHandoffFile(p, path, 'some contents', { write: () => 0 });
    } catch (error) {
      thrown = error as HandoffError;
    }
    expect(thrown?.fault).toBe('write_failed');
    expect(thrown?.message).toMatch(/stalled after 0 of 13 bytes/);
    expect(existsSync(at(p, path))).toBe(false);
  });

  it('reports a close that fails, clearing the unfinished file', () => {
    const p = paths();
    const path = nextHandoffPath([], 'a', 1);
    let thrown: HandoffError | undefined;
    try {
      writeHandoffFile(p, path, 'contents', {
        close: () => {
          throw new Error('EIO: input/output error');
        },
      });
    } catch (error) {
      thrown = error as HandoffError;
    }
    expect(thrown?.fault).toBe('write_failed');
    expect(thrown?.message).toMatch(/could not be closed/);
    expect(thrown?.message).toMatch(/EIO/);
    expect(existsSync(at(p, path))).toBe(false); // not left behind as if it had been written
  });

  it('clears the partial file it created when the write fails', () => {
    const p = paths();
    const path = nextHandoffPath([], 'a', 1);
    let thrown: HandoffError | undefined;
    try {
      writeHandoffFile(p, path, 'x', {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      });
    } catch (error) {
      thrown = error as HandoffError;
    }
    expect(thrown?.fault).toBe('write_failed');
    expect(thrown?.message).toMatch(/ENOSPC/);
    expect(thrown?.residue).toBeUndefined();
    expect(existsSync(at(p, path))).toBe(false); // nothing half-written is left behind
  });

  it('names the leftover when clearing the partial file also fails', () => {
    const p = paths();
    const path = nextHandoffPath([], 'a', 1);
    let thrown: HandoffError | undefined;
    try {
      writeHandoffFile(p, path, 'x', {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
        remove: () => {
          throw new Error('EACCES: permission denied');
        },
      });
    } catch (error) {
      thrown = error as HandoffError;
    }
    expect(thrown?.fault).toBe('write_failed');
    expect(thrown?.message).toMatch(/ENOSPC/); // the reason we are here
    expect(thrown?.residue).toBe(at(p, path));
    expect(thrown?.message).toMatch(/remains/);
  });

  it.each([
    ['climbs out of the run folder', '../escape.txt'],
    ['climbs out of handoffs', 'escape.txt'],
    ['is absolute', '/etc/passwd'],
    ['is the handoffs directory itself', 'handoffs'],
    ['nests below handoffs', 'handoffs/sub/x.txt'],
    ['walks back through handoffs', 'handoffs/../escape.txt'],
    ['normalises onto an acceptable one', 'handoffs/sub/../r1-a-1.txt'],
    ['is absolute but inside handoffs', join(tmpdir(), 'x', 'handoffs', 'r1-a-1.txt')],
  ])('refuses a path that %s, before normalising it', (_label, path) => {
    const p = paths();
    expect(() => writeHandoffFile(p, path, 'x')).toThrow(/is not of the form/);
    expect(existsSync(join(p.handoffs, 'r1-a-1.txt'))).toBe(false); // nothing was created
  });

  it('refuses a handoffs directory that has been redirected outside the run', () => {
    const p = paths();
    const elsewhere = mkdtempSync(join(tmpdir(), 'pipeline-elsewhere-'));
    rmSync(p.handoffs, { recursive: true });
    symlinkSync(elsewhere, p.handoffs);
    expect(() => writeHandoffFile(p, 'handoffs/r1-a-1.txt', 'x')).toThrow(
      /does not resolve inside/,
    );
    expect(existsSync(join(elsewhere, 'r1-a-1.txt'))).toBe(false);
  });

  it('reports a creation failure that is not a collision', () => {
    const p = paths();
    chmodSync(p.handoffs, 0o500); // readable, but nothing new may be created in it
    try {
      let thrown: HandoffError | undefined;
      try {
        writeHandoffFile(p, 'handoffs/r1-a-1.txt', 'x');
      } catch (error) {
        thrown = error as HandoffError;
      }
      expect(thrown?.fault).toBe('write_failed');
      expect(thrown?.message).toMatch(/could not be created/);
      expect(thrown?.message).not.toMatch(/already exists/);
    } finally {
      chmodSync(p.handoffs, 0o700);
    }
  });

  it('reports a directory that cannot be created', () => {
    const p = paths();
    rmSync(p.handoffs, { recursive: true });
    writeFileSync(p.handoffs, 'a file where the directory belongs', 'utf8');
    expect(() => writeHandoffFile(p, 'handoffs/r1-a-1.txt', 'x')).toThrow(/could not be created/);
  });
});

describe('the module stays internal', () => {
  it('is not exported from the package', async () => {
    const runlog = (await import('../src/runlog/index.js')) as Record<string, unknown>;
    for (const name of ['nextHandoffPath', 'writeHandoffFile'])
      expect(runlog[name]).toBeUndefined();
    // the error is reachable from RunLog.writeHandoff, so callers need it
    expect(runlog['HandoffError']).toBeDefined();
  });
});
