import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EventPayload } from '../src/runlog/events.js';
import { openRunLog, type RunPaths } from '../src/runlog/log.js';
import {
  projectLog,
  publishSnapshot,
  readSnapshot,
  SnapshotError,
} from '../src/runlog/snapshot.js';
import type { RunState } from '../src/runlog/state.js';

const base = () => mkdtempSync(join(tmpdir(), 'pipeline-snapshot-'));
const clock = () => {
  let t = Date.parse('2026-09-13T09:00:00Z');
  return () => new Date((t += 1000));
};
const script: EventPayload[] = [
  { type: 'run_started', pipeline: 'feature-loop', task: 'Add rate limiting' },
  { type: 'node_started', node: 'implementer', round: 1 },
  { type: 'handoff_written', node: 'implementer', round: 1, path: 'handoffs/r1-implementer-1.txt' },
  { type: 'node_finished', node: 'implementer', round: 1, outcome: 'done' },
  { type: 'node_started', node: 'reviewer', round: 1 },
  { type: 'escalated', node: 'reviewer', round: 1, reason: 'blocked' },
];
/** A real log, written by the approved writer, since that is what a snapshot must describe. */
const written = (howMany = script.length): RunPaths => {
  const log = openRunLog(base(), 'run-1', { now: clock() });
  for (const payload of script.slice(0, howMany)) log.append(payload);
  return log.paths;
};
const some: RunState = { lastSeq: 9, eventCount: 9, extraRoundsGranted: 0, handoffs: [] };

describe('publishing', () => {
  it('writes a snapshot that reads back as the same state, leaving no temporary file', () => {
    const paths = written();
    publishSnapshot(paths, projectLog(paths));
    expect(readSnapshot(paths)).toEqual(projectLog(paths));
    expect(existsSync(`${paths.state}.tmp`)).toBe(false);
    expect(readFileSync(paths.state, 'utf8').endsWith('\n')).toBe(true);
  });

  it.each([
    [
      'the write',
      {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      },
    ],
    [
      'the rename',
      {
        rename: () => {
          throw new Error('EXDEV: cross-device link');
        },
      },
    ],
  ])('preserves the previous snapshot when %s fails, and clears the temporary file', (_l, opts) => {
    const paths = written();
    publishSnapshot(paths, projectLog(paths));
    const before = readFileSync(paths.state, 'utf8');
    let thrown: SnapshotError | undefined;
    try {
      publishSnapshot(paths, some, opts);
    } catch (error) {
      thrown = error as SnapshotError;
    }
    expect(thrown?.fault).toBe('publish_failed');
    expect(readFileSync(paths.state, 'utf8')).toBe(before); // the old snapshot survives
    expect(existsSync(`${paths.state}.tmp`)).toBe(false);
    expect(thrown?.residue).toBeUndefined();
  });

  it('never lets a half-written snapshot reach state.json', () => {
    const paths = written();
    publishSnapshot(paths, projectLog(paths));
    const before = readFileSync(paths.state, 'utf8');
    expect(() =>
      publishSnapshot(paths, some, {
        // a write that emits part of the file and then fails, which is what a full disk looks like
        write: (path, text) => {
          writeFileSync(path, text.slice(0, 12), 'utf8');
          throw new Error('ENOSPC: no space left on device');
        },
      }),
    ).toThrow(SnapshotError);
    // the partial bytes went to the temporary file, so the readable snapshot never changed
    expect(readFileSync(paths.state, 'utf8')).toBe(before);
    expect(readSnapshot(paths)).toEqual(projectLog(paths));
    expect(existsSync(`${paths.state}.tmp`)).toBe(false);
  });

  it('keeps the original failure when clearing the temporary file also fails', () => {
    const paths = written();
    publishSnapshot(paths, projectLog(paths));
    const before = readFileSync(paths.state, 'utf8');
    // a non-empty directory where the temporary file belongs: the write fails, and so does the
    // cleanup that follows it
    const temp = `${paths.state}.tmp`;
    mkdirSync(temp);
    writeFileSync(join(temp, 'occupied'), '', 'utf8');
    let thrown: SnapshotError | undefined;
    try {
      publishSnapshot(paths, some, {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      });
    } catch (error) {
      thrown = error as SnapshotError;
    }
    expect(thrown?.fault).toBe('publish_failed');
    expect(thrown?.message).toMatch(/ENOSPC/); // the reason we are here, not the cleanup
    expect(thrown?.residue).toBe(temp); // and the leftover is named
    expect(thrown?.message).toMatch(/remains/);
    expect(readFileSync(paths.state, 'utf8')).toBe(before); // still the previous snapshot
  });
});

describe('reading the cache', () => {
  it('returns nothing when there is no snapshot', () => {
    // a run folder that exists but has never been appended to, so nothing has published yet
    expect(readSnapshot(openRunLog(base(), 'run-1', { now: clock() }).paths)).toBeUndefined();
  });

  it('returns nothing when the snapshot cannot be parsed', () => {
    const paths = written();
    writeFileSync(paths.state, '{ not json', 'utf8');
    expect(readSnapshot(paths)).toBeUndefined();
  });

  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['an array', '[]'],
    ['an object with the wrong field types', '{"handoffs":null,"lastSeq":"x"}'],
  ])('returns %s as parsed, without pretending it is a RunState', (_label, body) => {
    const paths = written();
    writeFileSync(paths.state, body, 'utf8');
    // the value comes back as written; the type is `unknown`, so a caller has to look before
    // reaching into it, which is the whole point
    expect(readSnapshot(paths)).toEqual(JSON.parse(body));
  });

  it('returns a wrong snapshot as written, claiming nothing about the log', () => {
    const paths = written();
    const lying: RunState = {
      lastSeq: 6, // the right sequence, and nothing else right
      eventCount: 6,
      extraRoundsGranted: 0,
      handoffs: [],
      runId: 'someone-else',
      task: 'a different task',
      status: 'done',
    };
    writeFileSync(paths.state, JSON.stringify(lying), 'utf8');
    expect(readSnapshot(paths)).toEqual(lying); // a cache read, not an authority
    expect(projectLog(paths)).not.toEqual(lying); // the log says otherwise
  });
});

describe('projecting the log', () => {
  it('projects a complete log to the state its events describe', () => {
    const state = projectLog(written());
    expect(state).toMatchObject({
      runId: 'run-1',
      pipeline: 'feature-loop',
      task: 'Add rate limiting',
      status: 'paused',
      round: 1,
      lastSeq: 6,
      eventCount: 6,
      openEntry: { node: 'reviewer', round: 1 },
      escalation: { node: 'reviewer', round: 1, reason: 'blocked' },
    });
    expect(state.handoffs).toEqual([
      { node: 'implementer', round: 1, path: 'handoffs/r1-implementer-1.txt' },
    ]);
  });

  it.each([
    ['a damaged tail', 'log_incomplete', (p: RunPaths) => `${readFileSync(p.events, 'utf8')}{"ty`],
    [
      'a history that contradicts itself',
      'log_unreplayable',
      (p: RunPaths) =>
        `${readFileSync(p.events, 'utf8')}${JSON.stringify({
          type: 'node_started',
          node: 'b',
          round: 1,
          run_id: 'run-1',
          seq: 3,
          ts: '2026-09-13T09:00:09Z',
        })}\n`,
    ],
    [
      'a line that is not JSON before the end',
      'log_corrupt',
      (p: RunPaths) => `not json\n${readFileSync(p.events, 'utf8')}`,
    ],
    [
      'a record the event schema rejects',
      'log_corrupt',
      (p: RunPaths) =>
        `${readFileSync(p.events, 'utf8')}${JSON.stringify({
          type: 'node_started',
          node: 'a',
          round: 0,
          run_id: 'run-1',
          seq: 3,
          ts: '2026-09-13T09:00:09Z',
        })}\n`,
    ],
    [
      'a gap in the sequence',
      'log_corrupt',
      (p: RunPaths) =>
        `${readFileSync(p.events, 'utf8')}${JSON.stringify({
          type: 'node_finished',
          node: 'implementer',
          round: 1,
          outcome: 'done',
          run_id: 'run-1',
          seq: 9,
          ts: '2026-09-13T09:00:09Z',
        })}\n`,
    ],
  ])('refuses %s, leaving any existing snapshot untouched', (_label, fault, damage) => {
    const paths = written(2);
    publishSnapshot(paths, projectLog(paths));
    const snapshot = readFileSync(paths.state, 'utf8');
    writeFileSync(paths.events, damage(paths), 'utf8');
    let thrown: SnapshotError | undefined;
    try {
      projectLog(paths);
    } catch (error) {
      thrown = error as SnapshotError;
    }
    expect(thrown).toBeInstanceOf(SnapshotError);
    expect(thrown?.fault).toBe(fault);
    expect(readFileSync(paths.state, 'utf8')).toBe(snapshot); // a prefix never replaces it
  });

  it('reserves log_unreadable for a filesystem failure', () => {
    const paths = written(2);
    publishSnapshot(paths, projectLog(paths));
    const snapshot = readFileSync(paths.state, 'utf8');
    rmSync(paths.events);
    mkdirSync(paths.events); // a directory where the log was: reading fails, nothing is claimed
    let thrown: SnapshotError | undefined;
    try {
      projectLog(paths);
    } catch (error) {
      thrown = error as SnapshotError;
    }
    expect(thrown?.fault).toBe('log_unreadable');
    expect(thrown?.message).not.toMatch(/corrupt/);
    expect(readFileSync(paths.state, 'utf8')).toBe(snapshot);
  });

  it('never presents a damaged log as a recovered run', () => {
    const paths = written(3);
    writeFileSync(paths.events, `${readFileSync(paths.events, 'utf8')}{"partial`, 'utf8');
    expect(() => projectLog(paths)).toThrow(/describes no complete run/);
  });
});

describe('the module stays internal for now', () => {
  it('is not exported from the package', async () => {
    const runlog = (await import('../src/runlog/index.js')) as Record<string, unknown>;
    for (const name of ['publishSnapshot', 'readSnapshot', 'projectLog', 'SnapshotError'])
      expect(runlog[name]).toBeUndefined();
  });
});
