import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  herdrBare,
  herdrEnvelope,
  HerdrError,
  herdrNothing,
  herdrText,
  type HerdrRunner,
} from '../src/herdr/cli.js';

/** Replays a recorded step 02 invocation: its stdout, its stderr and its exit code. */
const fixture = (group: string, name: string): HerdrRunner => {
  const at = (ext: string) =>
    fileURLToPath(new URL(`./fixtures/herdr/${group}/${name}.${ext}`, import.meta.url));
  const meta = readFileSync(at('meta'), 'utf8');
  const code = Number(/^exit: (\d+)$/m.exec(meta)?.[1]);
  return () =>
    Promise.resolve({
      code,
      stdout: readFileSync(at('stdout'), 'utf8'),
      stderr: readFileSync(at('stderr'), 'utf8'),
    });
};
const returning =
  (result: { code: number | null; stdout?: string; stderr?: string }): HerdrRunner =>
  () =>
    Promise.resolve({
      code: result.code,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
const failing =
  (error: Error): HerdrRunner =>
  () =>
    Promise.reject(error);
const caught = async (work: Promise<unknown>): Promise<HerdrError> =>
  work.then(
    () => {
      throw new Error('expected a HerdrError');
    },
    (error: unknown) => error as HerdrError,
  );

describe('what herdr answers with', () => {
  it('parses the standard envelope, leaving its payload for the caller to narrow', async () => {
    const envelope = await herdrEnvelope(['tab', 'create'], {
      run: fixture('tab-create', 'success'),
    });
    expect(envelope.id).toBe('cli:tab:create');
    expect(envelope.result.type).toBe('tab_created');
    // the payload arrives as unknown: nothing has checked it, so nothing claims to have
    const tab = envelope.result['tab'] as { tab_id: string };
    expect(tab.tab_id).toBe('w1:t2');
  });

  it('parses the bare object agent explain returns', async () => {
    // the one command that answers without an envelope, which is why it has its own call
    const body = await herdrBare(['agent', 'explain', '--json'], {
      run: fixture('agent-explain', 'idle-json'),
    });
    expect(body['agent']).toBe('claude');
  });

  it.each([
    ['visible', 155],
    ['raw-mode', 158],
  ])('returns %s terminal text byte for byte', async (name, bytes) => {
    const text = await herdrText(['pane', 'read', 'w1:p1'], { run: fixture('pane-read', name) });
    const recorded = readFileSync(
      fileURLToPath(new URL(`./fixtures/herdr/pane-read/${name}.stdout`, import.meta.url)),
      'utf8',
    );
    expect(text).toBe(recorded); // nothing trimmed, no line endings rewritten
    expect(Buffer.byteLength(text, 'utf8')).toBe(bytes);
  });

  it('accepts a command that writes nothing at all', async () => {
    await expect(
      herdrNothing(['pane', 'run', 'w1:p1', 'echo ok'], { run: fixture('pane-run', 'success') }),
    ).resolves.toBeUndefined();
  });
});

describe('how failures are told apart', () => {
  it('reads herdr error codes off stderr at exit 1', async () => {
    const error = await caught(
      herdrEnvelope(['pane', 'run', 'wA:p999', 'x'], {
        run: fixture('pane-run', 'error-bad-pane'),
      }),
    );
    expect(error).toMatchObject({ fault: 'api_error', code: 'pane_not_found', exitCode: 1 });
    expect(error.message).toContain('pane wA:p999 not found');
  });

  it('never parses exit 2 as JSON', async () => {
    const error = await caught(
      herdrEnvelope(['tab', 'create', '--nonexistent-flag'], {
        run: fixture('tab-create', 'usage'),
      }),
    );
    expect(error).toMatchObject({ fault: 'usage', exitCode: 2 });
    expect(error.code).toBeUndefined();
    expect(error.message).toContain('unknown option: --nonexistent-flag');
  });

  it('still reports an API error when its body will not parse', async () => {
    const error = await caught(
      herdrEnvelope(['pane', 'get', 'x'], { run: returning({ code: 1, stderr: 'not json' }) }),
    );
    expect(error).toMatchObject({ fault: 'api_error', stderr: 'not json' });
    expect(error.code).toBeUndefined();
  });

  it.each([
    ['stdout that is not JSON', { code: 0, stdout: 'not json' }, /not JSON/],
    ['an object with no id', { code: 0, stdout: '{"result":{"type":"x"}}' }, /envelope/],
    ['a result that is not an object', { code: 0, stdout: '{"id":"a","result":3}' }, /envelope/],
    ['a result with no type', { code: 0, stdout: '{"id":"a","result":{}}' }, /carries no type/],
  ])('refuses %s as malformed', async (_label, result, message) => {
    const error = await caught(herdrEnvelope(['pane', 'get', 'x'], { run: returning(result) }));
    expect(error.fault).toBe('malformed');
    expect(error.message).toMatch(message);
  });

  it('refuses unexpected output from a command that should be silent', async () => {
    const error = await caught(
      herdrNothing(['pane', 'run', 'x', 'y'], { run: returning({ code: 0, stdout: 'surprise' }) }),
    );
    expect(error).toMatchObject({ fault: 'malformed' });
  });

  it.each([3, 127, null])('reports exit %s as unexpected', async (code) => {
    const error = await caught(herdrText(['pane', 'read', 'x'], { run: returning({ code }) }));
    expect(error.fault).toBe('unexpected_exit');
  });

  it('reports a child ended by a signal as terminated, not as an odd exit code', async () => {
    const error = await caught(
      herdrText(['pane', 'read', 'x'], {
        run: () => Promise.resolve({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
      }),
    );
    expect(error).toMatchObject({ fault: 'terminated' });
    expect(error.message).toContain('SIGKILL');
  });

  it.each([
    // a spawn error names the syscall that failed; nothing ran
    ['launch_failed', { code: 'ENOENT', syscall: 'spawn herdr' }],
    // these only happen to a child that had already started
    ['terminated', { killed: true, signal: 'SIGTERM' }],
    ['terminated', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }],
  ])('tells a failure to start from a failure after starting: %s', async (fault, shape) => {
    const error = await caught(
      herdrText(['pane', 'read', 'x'], {
        run: failing(Object.assign(new Error('boom'), shape)),
      }),
    );
    expect(error.fault).toBe(fault);
  });
});

describe('the runner that actually spawns', () => {
  const node = (script: string) => ['-e', script];

  it('reports an executable that does not exist as a launch failure', async () => {
    const error = await caught(
      herdrText(node('process.stdout.write("never")'), { executable: '/nonexistent/herdr' }),
    );
    expect(error).toMatchObject({ fault: 'launch_failed' });
    expect(error.message).toContain('ENOENT');
  });

  it('reports a child killed by a signal as terminated, keeping what it printed', async () => {
    const error = await caught(
      herdrText(
        node('process.stderr.write("real diagnostic\\n"); process.kill(process.pid, "SIGTERM")'),
        { executable: process.execPath },
      ),
    );
    expect(error.fault).toBe('terminated'); // it started; it did not fail to start
    expect(error.stderr).toBe('real diagnostic\n'); // the diagnostic, not the manner of death
    expect(error.signal).toBe('SIGTERM'); // which has a field of its own
  });

  it.each([
    ['an option outside its range', { maxBuffer: -1 }],
    ['an argument containing a NUL', { argv: ['-e', 'process.exit(0)\u0000'] }],
  ])('reports %s as a launch failure: nothing was started', async (_label, shape) => {
    const argv = 'argv' in shape ? (shape.argv as string[]) : node('process.exit(0)');
    const error = await caught(
      herdrText(argv, {
        executable: process.execPath,
        ...('maxBuffer' in shape ? { maxBuffer: shape.maxBuffer as number } : {}),
      }),
    );
    expect(error.fault).toBe('launch_failed');
  });

  it('reports output beyond the buffer as terminated', async () => {
    const error = await caught(
      herdrText(node('process.stdout.write("x".repeat(4096))'), {
        executable: process.execPath,
        maxBuffer: 16,
      }),
    );
    expect(error).toMatchObject({ fault: 'terminated' });
  });

  it('returns what a real child printed, byte for byte', async () => {
    const text = await herdrText(node('process.stdout.write("one\\r\\ntwo  ")'), {
      executable: process.execPath,
    });
    expect(text).toBe('one\r\ntwo  ');
  });

  it('classifies a real non-zero exit by its code, not as a failure to run', async () => {
    const error = await caught(
      herdrText(node('process.stderr.write("nope"); process.exit(2)'), {
        executable: process.execPath,
      }),
    );
    expect(error).toMatchObject({ fault: 'usage', exitCode: 2 });
  });
});

describe('deadlines and cancellation', () => {
  const never: HerdrRunner = (_file, _argv, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );

  it('reports a passed deadline as a timeout, claiming nothing about the command', async () => {
    const error = await caught(
      herdrText(['pane', 'read', 'x'], { run: never, deadline: Date.now() + 5 }),
    );
    expect(error.fault).toBe('timed_out');
  });

  it('dispatches nothing when the deadline has already gone', async () => {
    let ran = false;
    const error = await caught(
      herdrText(['pane', 'read', 'x'], {
        run: () => {
          ran = true;
          return Promise.resolve({ code: 0, stdout: 'too late', stderr: '' });
        },
        deadline: Date.now() - 1,
      }),
    );
    expect(error.fault).toBe('timed_out');
    expect(ran).toBe(false); // an expired deadline is not a race an immediate runner can win
  });

  it('refuses a late result even when the overdue timer has not run yet', async () => {
    // a runner that holds the event loop past the deadline: the timer callback cannot have fired,
    // so only the clock can tell that the answer is late
    const blocking: HerdrRunner = () => {
      const until = Date.now() + 60;
      while (Date.now() < until) {
        /* deliberately busy */
      }
      return Promise.resolve({ code: 0, stdout: 'late', stderr: '' });
    };
    const error = await caught(
      herdrText(['pane', 'read', 'x'], { run: blocking, deadline: Date.now() + 20 }),
    );
    expect(error.fault).toBe('timed_out');
  });

  it('refuses a result that arrived after the deadline had passed', async () => {
    // a runner that ignores the abort signal, as a careless one might: the deadline still holds
    const deaf: HerdrRunner = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ code: 0, stdout: 'too late', stderr: '' }), 40),
      );
    const error = await caught(
      herdrText(['pane', 'read', 'x'], { run: deaf, deadline: Date.now() + 10 }),
    );
    expect(error.fault).toBe('timed_out');
  });

  it('does not treat a distant deadline as one that has already expired', async () => {
    // Beyond setTimeout's range, where a single hop fires on the next tick. The runner takes long
    // enough that such a timer would win the race, so an instant answer cannot hide the bug.
    const slow: HerdrRunner = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ code: 0, stdout: 'in time', stderr: '' }), 25),
      );
    const text = await herdrText(['pane', 'read', 'x'], {
      run: slow,
      deadline: Date.now() + 3_000_000_000,
    });
    expect(text).toBe('in time');
  });

  it('reports an aborted invocation separately from a timeout', async () => {
    const controller = new AbortController();
    const work = caught(
      herdrText(['pane', 'read', 'x'], { run: never, signal: controller.signal }),
    );
    controller.abort();
    expect((await work).fault).toBe('cancelled');
  });

  it('spawns nothing for a signal that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const error = await caught(
      herdrText(['pane', 'read', 'x'], {
        run: () => {
          ran = true;
          return Promise.resolve({ code: 0, stdout: '', stderr: '' });
        },
        signal: controller.signal,
      }),
    );
    expect(error.fault).toBe('cancelled');
    expect(ran).toBe(false);
  });
});

describe('how the command line is built', () => {
  it('passes arguments as an array and prefixes the session', async () => {
    let seen: { file: string; argv: readonly string[] } | undefined;
    const capture: HerdrRunner = (file, argv) => {
      seen = { file, argv };
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    await herdrNothing(['pane', 'run', 'w1:p1', 'npm test -- --grep "a b"'], {
      run: capture,
      session: 'pipeline_it',
      executable: '/usr/local/bin/herdr',
    });
    expect(seen?.file).toBe('/usr/local/bin/herdr');
    // one argument per element: a command containing spaces and quotes is never re-split
    expect(seen?.argv).toEqual([
      '--session',
      'pipeline_it',
      'pane',
      'run',
      'w1:p1',
      'npm test -- --grep "a b"',
    ]);
  });
});
