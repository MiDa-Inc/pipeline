import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { openRunLog, readEvents, replay, runPaths } from '../src/runlog/index.js';

/**
 * Separate processes, not separate handles: the check-and-write window is only observable when two
 * operating-system processes race for it, so this suite builds the package and drives the built
 * output from real children.
 */
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const entry = pathToFileURL(join(pkgRoot, 'dist', 'runlog', 'index.js')).href;

const WRITERS = 4;
const EACH = 15;

const child = (dir: string) => `
  const { openRunLog } = await import(${JSON.stringify(entry)});
  for (let i = 0; i < ${EACH}; i++) {
    for (;;) {
      try {
        const log = openRunLog(${JSON.stringify(dir)}, 'busy');
        // The payload is derived from the very handle that will append it, so it is bound to the
        // sequence that handle holds. Reading the log separately could bind it to another writer's.
        // The log alternates entry and terminator, so its length says which comes next.
        const seen = log.existing.length;
        log.append(seen % 2 === 1
          ? { type: 'node_started', node: 'implementer', round: (seen + 1) / 2 }
          : { type: 'node_finished', node: 'implementer', round: seen / 2, outcome: 'done' });
        break;
      } catch (error) {
        // losing a race is fine and expected; anything else is the defect under test
        if (error.fault === 'stale_writer' || error.fault === 'lock_unavailable') continue;
        throw error;
      }
    }
  }
`;

describe('concurrent writer processes', () => {
  beforeAll(() => {
    execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: pkgRoot, stdio: 'pipe' });
  }, 120_000);

  it('never lets two processes claim the same sequence number', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-race-'));
    openRunLog(dir, 'busy').append({ type: 'run_started', pipeline: 'p', task: 't' });

    const spawn = promisify(execFile);
    await Promise.all(
      Array.from({ length: WRITERS }, () =>
        spawn(process.execPath, ['--input-type=module', '-e', child(dir)]),
      ),
    );

    // runPaths, not openRunLog: opening would rebuild the snapshot and this would then be
    // checking the parent's own repair rather than what the competing processes left behind
    const paths = runPaths(dir, 'busy');
    const read = readEvents(paths.events);
    expect(read.complete).toBe(true);
    // contiguous, one per append, no duplicates: exactly what a lost check-and-write race breaks
    expect(read.events.map((e) => e.seq)).toEqual(
      Array.from({ length: WRITERS * EACH + 1 }, (_, i) => i + 1),
    );
    // and the interleaved result is a projectable run, not merely a well-numbered file
    expect(replay(read.events)).toMatchObject({ status: 'running', runId: 'busy' });
    // every child reopened the run before each append, so rebuilds and publications interleaved
    // throughout. The surviving snapshot must be the newest, never one an older rebuild restored.
    expect(JSON.parse(readFileSync(paths.state, 'utf8'))).toEqual(replay(read.events));
  }, 120_000);

  it('never lets a standalone rebuild overwrite a concurrent append', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-rebuild-race-'));
    const seed = openRunLog(dir, 'r');
    seed.append({ type: 'run_started', pipeline: 'p', task: 't' });
    seed.append({ type: 'node_started', node: 'a', round: 1 });
    const paths = runPaths(dir, 'r');

    // File markers rather than timing: the two processes tell each other where they are, so the
    // interleaving under test happens on purpose instead of by luck.
    const marker = (name: string) => join(dir, name);
    const signal = (name: string) => writeFileSync(marker(name), 'ready', 'utf8');
    const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const waitSync = (name: string) => {
      const until = Date.now() + 5_000;
      while (!existsSync(marker(name))) {
        if (Date.now() > until) throw new Error(`timed out waiting for ${name}`);
        sleep(5);
      }
    };

    const writer = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import { existsSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const { openRunLog } = await import(${JSON.stringify(entry)});
        const dir = ${JSON.stringify(dir)};
        const log = openRunLog(dir, 'r');
        if (log.existing.length !== 2) throw new Error('writer opened at ' + log.existing.length);
        writeFileSync(join(dir, 'writer-ready'), 'ready');
        const until = Date.now() + 5000;
        while (!existsSync(join(dir, 'writer-go'))) {
          if (Date.now() > until) throw new Error('writer timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        writeFileSync(join(dir, 'writer-attempting'), 'ready');
        log.append({ type: 'node_finished', node: 'a', round: 1, outcome: 'done' });
      `,
    ]);
    let stderr = '';
    writer.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const exited = new Promise<number | null>((resolve) => writer.on('exit', resolve));

    try {
      waitSync('writer-ready'); // established, holding no lock, parked before its append

      let lockHeld = false;
      let eventsWhileHeld = 0;
      const rebuilt = openRunLog(dir, 'r', {
        snapshot: {
          rename: (from, to) => {
            // the rebuild is at its publication, still holding the lock: let the writer contend
            lockHeld = existsSync(`${paths.events}.lock`);
            signal('writer-go');
            waitSync('writer-attempting');
            sleep(100); // long enough for the writer to reach the lock and block on it
            eventsWhileHeld = readEvents(paths.events).events.length;
            renameSync(from, to);
          },
        },
      });

      expect(lockHeld).toBe(true);
      expect(eventsWhileHeld).toBe(2); // the writer could not append while the rebuild held it
      expect(rebuilt.existing).toHaveLength(2); // and this rebuild only ever saw two events

      expect(await exited).toBe(0);
      expect(stderr).toBe('');
    } finally {
      writer.kill();
    }

    // read the files directly: reopening here would rebuild and hide the very thing under test
    const events = readEvents(paths.events).events;
    expect(events).toHaveLength(3);
    expect(JSON.parse(readFileSync(paths.state, 'utf8'))).toEqual(replay(events));
    expect(JSON.parse(readFileSync(paths.state, 'utf8'))).toMatchObject({ lastSeq: 3 });
  }, 120_000);
});
