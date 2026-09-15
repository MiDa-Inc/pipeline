import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ExecutionId, ProcessObservation } from '../src/adapter.js';
import { createGateRunner, type GateRunnerOptions } from '../src/herdr/process.js';

const dir = mkdtempSync(join(tmpdir(), 'pipeline-gate-'));
/** A node script on disk, so the shell command stays readable and quoting stays honest. */
const script = (name: string, body: string) => {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, body, 'utf8');
  return `${process.execPath} ${path}`;
};

/** Bounded wait for a marker file, so a hung child fails the test instead of the suite. */
const waitFor = async (path: string, within = 5_000) => {
  const until = Date.now() + within;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const marker = (name: string) => {
  const path = join(dir, name);
  rmSync(path, { force: true });
  return path;
};

const run = async (command: string, options: GateRunnerOptions = {}) => {
  const runner = createGateRunner(options);
  const launch = runner.start({ node: 'test_gate', command, cwd: dir });
  return {
    launch,
    started: await launch.started,
    observed: await runner.observe(launch.executionId),
    observeAgain: () => runner.observe(launch.executionId),
    runner,
  };
};
const completed = (observation: ProcessObservation) => {
  if (observation.kind !== 'completed')
    throw new Error(`expected completed, got ${observation.kind}`);
  return observation;
};

describe('running a gate', () => {
  it('hands back an identity before any output, and accepts the launch', async () => {
    const runner = createGateRunner();
    const launch = runner.start({ node: 'test_gate', command: 'echo ok', cwd: dir });
    expect(launch.executionId).toBeTruthy(); // available synchronously
    await expect(launch.started).resolves.toEqual({ kind: 'accepted' });
  });

  it('returns the handle before it dispatches anything', async () => {
    let dispatched = 0;
    const runner = createGateRunner({
      spawn: (...args: Parameters<typeof spawn>) => {
        dispatched += 1;
        return spawn(...args);
      },
    });
    const launch = runner.start({ node: 'test_gate', command: 'echo ok', cwd: dir });
    expect(launch.executionId).toBeTruthy();
    expect(dispatched).toBe(0); // nothing is started while the caller has no handle yet
    await expect(launch.started).resolves.toEqual({ kind: 'accepted' });
    expect(dispatched).toBe(1); // and it is dispatched once, afterwards
  });

  it('completes a command that reads to end of input', async () => {
    // stdin is not inherited, so a gate that reads it sees EOF instead of waiting forever
    const { observed } = await run('cat; printf "read\n"');
    expect(completed(observed)).toMatchObject({ exitStatus: 0, output: 'read\n' });
  });

  it.each([
    ['a passing gate', 'printf "12 passing\\n"; exit 0', 0, '12 passing\n'],
    ['a failing gate', 'printf "1 failing\\n" >&2; exit 1', 1, '1 failing\n'],
    ['an unusual status', 'exit 42', 42, ''],
  ])('reports %s as a real result', async (_label, command, status, output) => {
    const { observed } = await run(command);
    expect(completed(observed)).toMatchObject({ exitStatus: status, output });
  });

  it('interprets the command as a shell string, quoting and pipelines intact', async () => {
    const { observed } = await run(`printf 'a b\\nc d\\n' | grep 'c d' | wc -l | tr -d ' '`);
    expect(completed(observed).output).toBe('1\n');
  });

  it('treats a missing inner command as a launch that happened and failed', async () => {
    const { started, observed } = await run('definitely-not-a-command; exit $?');
    expect(started).toEqual({ kind: 'accepted' }); // the shell started, so something ran
    const result = completed(observed);
    expect(result.exitStatus).toBe(127);
    expect(result.output).toMatch(/not found/);
  });

  it('keeps every byte the gate wrote, published after the streams close', async () => {
    // far more than a pipe buffer holds, so output is still in flight when the child exits:
    // publishing on `exit` rather than `close` would report a truncated result here
    const lines = 20_000;
    const { observed } = await run(
      script('bulk', `for (let i = 0; i < ${lines}; i++) process.stdout.write(\`line \${i}\\n\`);`),
    );
    const result = completed(observed);
    const expected = Array.from({ length: lines }, (_, i) => `line ${i}\n`).join('');
    expect(result.output).toHaveLength(expected.length);
    expect(result.output).toBe(expected);
  });

  it('waits for the streams to close, not merely for the shell to exit', async () => {
    // the shell exits immediately while a background job still holds its stdout: publishing on
    // `exit` would report only what had been written by then
    const { observed } = await run(`( sleep 0.3; printf 'late\n' ) & printf 'early\n'`);
    const result = completed(observed);
    expect(result.output).toContain('early');
    expect(result.output).toContain('late');
  });

  it('decodes each stream on its own, so an interleaved chunk cannot corrupt a character', async () => {
    // the halves of one 4-byte character arrive with a stderr write between them
    const { observed } = await run(
      script(
        'straddle',
        `const c = Buffer.from('🙂', 'utf8');
         process.stdout.write(c.subarray(0, 2));
         process.stderr.write('X');
         setTimeout(() => process.stdout.write(c.subarray(2)), 20);`,
      ),
    );
    const result = completed(observed);
    expect(result.output).toContain('🙂'); // not two replacement characters
    expect(result.output).toContain('X');
    expect(result.output).not.toContain('�');
  });

  it('replays the same result to a later observation', async () => {
    const { observed, observeAgain } = await run('printf "once\\n"');
    await expect(observeAgain()).resolves.toEqual(observed);
  });

  it('refuses an execution it never started', async () => {
    const runner = createGateRunner();
    await expect(runner.observe('gate-999' as ExecutionId)).resolves.toEqual({
      kind: 'unrecoverable',
      executionId: 'gate-999',
      reason: 'unknown_execution',
    });
  });
});

describe('ends that produce no exit status', () => {
  it.each([
    ['a command the runtime rejects outright', { command: 'echo \u0000 bad' }],
    ['a shell that cannot be named', { shell: '' }],
  ])('still hands back an identity when %s', async (_label, shape) => {
    const runner = createGateRunner('shell' in shape ? { shell: shape.shell as string } : {});
    const command = 'command' in shape ? (shape.command as string) : 'echo ok';
    // the handle exists before anything is dispatched, so there is always something to observe
    const launch = runner.start({ node: 'test_gate', command, cwd: dir });
    expect(launch.executionId).toBeTruthy();
    const started = await launch.started;
    expect(started).toMatchObject({ kind: 'failed' });
    expect((started as { detail: string }).detail.length).toBeGreaterThan(0);
    const observed = await runner.observe(launch.executionId);
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'spawn_failed' });
  });

  it('refuses an overflowing gate before that gate is able to finish', async () => {
    const release = marker('overflow-release');
    const finished = marker('overflow-finished');
    const runner = createGateRunner({ outputLimit: 1024 });
    const launch = runner.start({
      node: 'test_gate',
      cwd: dir,
      // floods past the cap, then cannot finish until this test says so
      command: script(
        'barrier',
        `import { existsSync, writeFileSync } from 'node:fs';
         process.stdout.write('x'.repeat(64 * 1024));
         const until = Date.now() + 5000;
         const tick = () => {
           if (existsSync(RELEASE) || Date.now() > until) {
             writeFileSync(FINISHED, '1');
             process.exit(0);
           }
           setTimeout(tick, 10);
         };
         tick();`
          .replace('RELEASE', JSON.stringify(release))
          .replace('FINISHED', JSON.stringify(finished)),
      ),
    });

    const observed = await runner.observe(launch.executionId);
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'output_limit_exceeded' });
    // the gate had not ended, so this refusal cannot have been published at close
    expect(existsSync(finished)).toBe(false);
    writeFileSync(release, '1', 'utf8');
    await waitFor(finished);
    await expect(runner.observe(launch.executionId)).resolves.toEqual(observed); // retained
  });

  it('keeps draining after the refusal, so the gate is never stuck on a full pipe', async () => {
    const wrote = marker('drain-wrote');
    const runner = createGateRunner({ outputLimit: 1024 });
    const launch = runner.start({
      node: 'test_gate',
      cwd: dir,
      // far more than any pipe buffer: these writes only complete if the parent keeps reading
      command: script(
        'backpressure',
        `import { writeFileSync } from 'node:fs';
         const chunk = 'y'.repeat(64 * 1024);
         for (let i = 0; i < 40; i++) process.stdout.write(chunk);
         process.stdout.end(() => {
           writeFileSync(WROTE, '1');
           process.exit(0);
         });`.replace('WROTE', JSON.stringify(wrote)),
      ),
    });

    const observed = await runner.observe(launch.executionId);
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'output_limit_exceeded' });
    expect(existsSync(wrote)).toBe(false); // 2.5 MB cannot already be through
    await waitFor(wrote); // progress continued after the refusal: the pipes were still read
    await expect(runner.observe(launch.executionId)).resolves.toEqual(observed); // survives close
  });

  it('reports a shell that could not start, and retains that', async () => {
    const { started, observed, observeAgain } = await run('echo ok', {
      shell: '/nonexistent/sh',
    });
    expect(started).toMatchObject({ kind: 'failed' });
    expect((started as { detail: string }).detail).toContain('ENOENT');
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'spawn_failed' });
    expect((observed as { detail: string }).detail).toContain('ENOENT');
    await expect(observeAgain()).resolves.toEqual(observed); // retained, not recomputed
  });

  it('names the signal that ended a gate, and invents no exit status', async () => {
    const { started, observed } = await run(
      script('killed', 'process.stdout.write("started\\n"); process.kill(process.pid, "SIGKILL");'),
    );
    expect(started).toEqual({ kind: 'accepted' }); // it ran; it just did not finish
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'signal_terminated' });
    expect((observed as { detail: string }).detail).toContain('SIGKILL');
    expect(observed).not.toHaveProperty('exitStatus');
  });

  it('refuses a result it could not hold whole, even when the gate then exits zero', async () => {
    const { observed, observeAgain } = await run(
      script(
        'flood',
        'for (let i = 0; i < 400; i++) process.stdout.write("x".repeat(1024));\nprocess.exit(0);',
      ),
      { outputLimit: 1024 },
    );
    // the child exited rather than blocking on a full pipe, so the pipes were still drained
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'output_limit_exceeded' });
    expect((observed as { detail: string }).detail).toContain('1024');
    expect(observed).not.toHaveProperty('output'); // refused whole, never truncated
    await expect(observeAgain()).resolves.toEqual(observed);
  });

  it('counts the cap across both streams together', async () => {
    const { observed } = await run(
      script(
        'both',
        'process.stdout.write("a".repeat(600)); process.stderr.write("b".repeat(600));',
      ),
      { outputLimit: 1000 },
    );
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'output_limit_exceeded' });
  });
});
