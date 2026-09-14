import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { openRunLog, readEvents } from '../src/runlog/index.js';

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
        openRunLog(${JSON.stringify(dir)}, 'busy').append({
          type: 'node_started', node: 'implementer', round: 1,
        });
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

    const read = readEvents(openRunLog(dir, 'busy').paths.events);
    expect(read.complete).toBe(true);
    // contiguous, one per append, no duplicates: exactly what a lost check-and-write race breaks
    expect(read.events.map((e) => e.seq)).toEqual(
      Array.from({ length: WRITERS * EACH + 1 }, (_, i) => i + 1),
    );
  }, 120_000);
});
