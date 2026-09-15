import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PaneId } from '../src/adapter.js';
import { createHerdrRuntime, type HerdrRuntime } from '../src/herdr/index.js';

/**
 * The live herdr integration test (PLAN.md step 11, "Done when").
 *
 * Opt-in: it runs only with `PIPELINE_HERDR_IT=1`, because it needs a real herdr on the path.
 *
 *     PIPELINE_HERDR_IT=1 pnpm --filter @pipeline/runtime exec vitest run test/herdr-integration
 *
 * CI has no herdr, so there it skips — visibly, as a skipped suite rather than silently passing.
 * With the flag set and herdr missing or unusable this suite **fails**: the flag is an explicit
 * request to exercise the real thing, and a quiet skip would hide the one thing it exists for.
 *
 * **It never touches the operator's herdr.** Every invocation carries `--session`, and the session
 * is unique per run and created by this suite. An existing session of that name is refused, never
 * adopted: nothing here stops or deletes a server it did not start. With the flag unset, not a
 * single herdr command runs — the name is not even generated.
 */
const LIVE = process.env.PIPELINE_HERDR_IT === '1';
const run = promisify(execFile);
/** What any one herdr command gets. */
const BOUND = 20_000;
/**
 * Timeouts derived from the work, not guessed.
 *
 * Both halves draw on one wall-clock budget rather than a sum of per-command bounds, because a sum
 * is wrong the moment a step is added or a retry loop runs twice — and a hook that expires part-way
 * through cleanup destroys the very diagnostics it exists to collect. Each hook is then given more
 * than its budget, which {@link CLEANUP_HOOK} and {@link SETUP_HOOK} state once and a test checks.
 */
const SETUP_BUDGET = 150_000;
const CLEANUP_BUDGET = 60_000;
const SLACK = 10_000;
/** What the hooks are actually given. The budgets above are what the work inside them may take. */
const SETUP_HOOK = SETUP_BUDGET + SLACK;
const CLEANUP_HOOK = CLEANUP_BUDGET + SLACK;

/** Every herdr call this harness makes itself, bounded and parsed. */
const herdr = async (session: string, argv: string[], bound = BOUND) => {
  // `timeout` is what actually ends the child: execFile kills it and only then settles, so awaiting
  // this awaits the subprocess's own termination rather than merely giving up on waiting for it.
  const { stdout } = await run('herdr', ['--session', session, ...argv], { timeout: bound });
  return JSON.parse(stdout) as { result?: Record<string, unknown>; error?: { code: string } };
};
const resultOf = async (session: string, argv: string[], bound = BOUND) => {
  const answer = await herdr(session, argv, bound);
  if (answer.result === undefined)
    throw new Error(`herdr ${argv.join(' ')} failed: ${JSON.stringify(answer.error)}`);
  return answer.result;
};
/** A pane, workspace or tab as the live server reports it. */
const field = (of: Record<string, unknown>, key: string, name: string): string =>
  String((of[key] as Record<string, unknown>)[name]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bound a runtime call from the outside, because the adapter's own deadline is per-invocation and
 * this suite holds one runtime for the whole scenario.
 *
 * Note what this does *not* do: giving up on the wait leaves the work running. Whatever herdr child
 * was started is still there, which is why {@link tearDown} shuts the runtime down rather than
 * assuming an abandoned call is over.
 */
const within = <T>(work: Promise<T>, what: string, bound = BOUND): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} did not finish within ${bound}ms`)),
        bound,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/** Just enough of a child process for {@link tearDown}; the real one and a test double both fit. */
interface ServerProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(): void;
  once(event: 'exit', listener: () => void): unknown;
}

const hasExited = (server: ServerProcess) => server.exitCode !== null || server.signalCode !== null;

/** Resolves true when the process has actually gone, false if it is still there at `bound`. */
const exits = async (server: ServerProcess, bound: number): Promise<boolean> => {
  if (hasExited(server)) return true;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    new Promise<boolean>((resolve) => server.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), bound);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** Run one cleanup phase, recording what went wrong without letting it stop the rest. */
const phase = async (
  name: string,
  work: (bound: number) => Promise<unknown>,
  bound: number,
  grace: number,
  trouble: string[],
): Promise<void> => {
  try {
    // The work gets `bound`; the race gets a little more, so an effect that honours its bound is
    // awaited to completion and only one that ignores it is abandoned.
    await within(work(bound), name, bound + grace);
  } catch (cause) {
    const why = (cause as Error).message;
    trouble.push(why.startsWith(name) ? why : `${name}: ${why}`);
  }
};

interface Teardown {
  /** The adapter, when one was built. Its own herdr clients are released before anything else. */
  readonly runtime?: { shutdown(): Promise<void> };
  /** The server process, when this run started one. Absent means there is nothing of ours to stop. */
  readonly server?: ServerProcess;
  /**
   * Each effect is handed the time it has left, and must apply it to the work itself — a CLI child
   * given no timeout outlives the phase that gave up on it. Racing the promise is only a backstop.
   */
  stopServer(bound: number): Promise<void>;
  deleteSession(bound: number): Promise<void>;
  stillRunning(bound: number): Promise<boolean>;
  listed(bound: number): Promise<boolean>;
  /** One wall-clock budget for the whole of cleanup, shared by every phase. */
  readonly budget: number;
}

/**
 * Put the machine back as it was, and say everything that went wrong rather than the first thing.
 *
 * Never throws: the caller decides how to report, so a cleanup problem is raised *alongside* the
 * failure that provoked it and never in place of it. It also never overruns `budget`, so the hook
 * running it can be given a timeout that outlives it rather than a sum of phase bounds that does
 * not — a hook killed mid-cleanup loses every diagnostic collected up to that point.
 */
const tearDown = async (t: Teardown): Promise<string[]> => {
  const trouble: string[] = [];
  const started = Date.now();
  // A slice is held back so that forcing the process to go is never the step that runs out of time.
  // A quarter is held back so that forcing the process out is never the step that runs out of
  // time, and the grace the phases may each overrun by together stays inside it.
  const deadline = started + t.budget;
  const reserve = Math.max(2, Math.round(t.budget / 4));
  const grace = Math.max(1, Math.round(t.budget / 20));
  const left = () => Math.max(1, deadline - reserve - Date.now());

  // The adapter first. A layout call this suite gave up waiting for is still running, and deleting
  // the session out from under it would leave a child talking to a server that is going away.
  if (t.runtime !== undefined)
    await phase(
      'shutdown',
      () => t.runtime?.shutdown() ?? Promise.resolve(),
      left(),
      grace,
      trouble,
    );
  const { server } = t;
  if (server === undefined) return trouble;

  await phase('server stop', (b) => t.stopServer(b), left(), grace, trouble);
  // Bounded like every other phase: a status query that hangs would otherwise strand cleanup here
  // and it would never reach the termination the reserve exists for.
  while (left() > 1) {
    const running = await within(t.stillRunning(left()), 'session status', left() + grace).catch(
      () => false,
    );
    if (!running) break;
    await sleep(50);
  }
  await phase('session delete', (b) => t.deleteSession(b), left(), grace, trouble);
  if (await within(t.listed(left()), 'session list', left() + grace).catch(() => true))
    trouble.push('the session is still listed after delete');

  // Waited for, not assumed: a server can stop serving well before its process has finished
  // exiting, and killing it in that window would report a healthy shutdown as a broken one.
  if (!(await exits(server, left()))) {
    server.kill();
    // Measured against the deadline itself, not against the reserve: the phases above may each
    // have overrun their bound by the grace, and spending a full reserve on top of that would
    // carry cleanup past the budget the hook timeout is derived from.
    const remaining = deadline - Date.now();
    trouble.push(
      (remaining > 0 ? await exits(server, remaining) : hasExited(server))
        ? 'the server process had to be killed'
        : 'the server process did not exit even after being killed',
    );
  }
  return trouble;
};

const sessionsNow = async (bound = BOUND) => {
  const { stdout } = await run('herdr', ['session', 'list', '--json'], { timeout: bound });
  return (JSON.parse(stdout) as { sessions: { name: string; running: boolean }[] }).sessions;
};
const listed = async (name: string, bound = BOUND) =>
  (await sessionsNow(bound)).some((s) => s.name === name);
/** A stopped session is still listed until it is deleted, so this waits for it to stop running. */
const stillRunning = async (name: string, bound = BOUND) =>
  (await sessionsNow(bound)).some((s) => s.name === name && s.running);

describe.skipIf(!LIVE)('live herdr', () => {
  let session = '';
  let server: ChildProcess | undefined;
  let serverOutput = '';
  let version = '';
  /** What this run created, so teardown can say whether the session held anything else. */
  const owned = { workspace: '', panes: [] as PaneId[] };
  let runtime: HerdrRuntime | undefined;
  const adapter = (): HerdrRuntime => {
    if (runtime === undefined) throw new Error('the runtime was never built');
    return runtime;
  };
  const cwd = process.cwd();

  beforeAll(async () => {
    // One deadline for the whole of setup, for the reason cleanup has one: counting phases is
    // wrong as soon as a step is added or the readiness loop goes round twice.
    const began = Date.now();
    const left = () => Math.max(1, began + SETUP_BUDGET - Date.now());

    // The flag is set, so herdr must be there and usable. Anything else is a failure, not a skip.
    try {
      version = (await run('herdr', ['--version'], { timeout: left() })).stdout.trim();
    } catch (cause) {
      throw new Error(
        `PIPELINE_HERDR_IT=1 but herdr is not usable. Unset the flag to skip this suite.`,
        { cause },
      );
    }

    session = `pipeline_it_${process.pid}_${randomBytes(4).toString('hex')}`;
    // Refused, never adopted: a name collision means someone else's server, and it is not ours to
    // start, stop or delete.
    if (await listed(session, left()))
      throw new Error(`session ${session} already exists; refusing to adopt it`);

    server = spawn('herdr', ['--session', session, 'server'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk: Buffer) => (serverOutput += String(chunk)));
    server.stderr?.on('data', (chunk: Buffer) => (serverOutput += String(chunk)));
    let exited: number | null | undefined;
    server.once('exit', (code) => (exited = code));

    for (;;) {
      if (exited !== undefined)
        throw new Error(`the herdr server exited with ${exited}: ${serverOutput}`);
      // each poll is bounded by what setup has left, so a retry cannot buy itself another full
      // command timeout past the deadline
      const answer = await herdr(session, ['workspace', 'list'], left()).catch(() => undefined);
      if (answer?.result !== undefined) break;
      if (left() <= 1)
        throw new Error(`${version} did not become ready in ${SETUP_BUDGET}ms: ${serverOutput}`);
      await sleep(100);
    }

    // Printed rather than merely kept for diagnostics: a passing run should say on the record
    // which herdr it exercised, since no CI job ever will.
    console.log(`[herdr integration] ${version}, isolated session ${session}`);

    // The scenario, in order: a workspace, then a tab inside it, then a split of that tab's pane.
    runtime = createHerdrRuntime({ herdr: { session } });
    const root = await within(
      adapter().createLayout({ destination: { kind: 'new_workspace' }, cwd, label: 'it-root' }),
      'createLayout(new_workspace)',
      left(),
    );
    owned.panes.push(root);
    // counted too: reading the workspace back is a command like any other
    owned.workspace = field(
      await resultOf(session, ['pane', 'get', root], left()),
      'pane',
      'workspace_id',
    );
    owned.panes.push(
      await within(
        adapter().createLayout({
          destination: { kind: 'workspace', workspaceId: owned.workspace },
          cwd,
          label: 'it-tab',
        }),
        'createLayout(workspace)',
        left(),
      ),
    );
    owned.panes.push(
      await within(
        adapter().createLayout({
          destination: { kind: 'split', pane: owned.panes[1] as PaneId, direction: 'right' },
          cwd,
          label: 'it-split',
        }),
        'createLayout(split)',
        left(),
      ),
    );
  }, SETUP_HOOK);

  afterAll(async () => {
    // Runs whether the suite passed, failed, or never finished setting up.
    const trouble = await tearDown({
      ...(runtime === undefined ? {} : { runtime }),
      ...(server === undefined ? {} : { server }),
      // each of these applies the remaining time to the child itself, not merely to the wait
      stopServer: async (bound) => {
        await run('herdr', ['--session', session, 'server', 'stop'], { timeout: bound });
      },
      deleteSession: async (bound) => {
        await run('herdr', ['session', 'delete', session], { timeout: bound });
      },
      stillRunning: (bound) => stillRunning(session, bound),
      listed: (bound) => listed(session, bound),
      budget: CLEANUP_BUDGET,
    });
    // Raised in its own right, alongside whatever failure vitest already has, never instead of it.
    if (trouble.length > 0)
      throw new Error(`cleanup of ${session} (${version}) failed: ${trouble.join('; ')}`);
  }, CLEANUP_HOOK);

  it('creates a workspace and reports the pane and label it actually made', async () => {
    const pane = await resultOf(session, ['pane', 'get', owned.panes[0] as string]);
    expect(field(pane, 'pane', 'pane_id')).toBe(owned.panes[0]);
    expect(field(pane, 'pane', 'label')).toBe('it-root'); // the rename reached the live pane
    expect(field(pane, 'pane', 'workspace_id')).toBe(owned.workspace);
    const workspace = await resultOf(session, ['workspace', 'get', owned.workspace]);
    expect(field(workspace, 'workspace', 'label')).toBe('it-root');
  });

  it('creates a tab inside the workspace it was given, carrying the label', async () => {
    const pane = await resultOf(session, ['pane', 'get', owned.panes[1] as string]);
    // the parent relationship the caller asked for, as the server sees it
    expect(field(pane, 'pane', 'workspace_id')).toBe(owned.workspace);
    const tab = field(pane, 'pane', 'tab_id');
    expect(tab).not.toBe(
      field(await resultOf(session, ['pane', 'get', owned.panes[0] as string]), 'pane', 'tab_id'),
    );
    // this destination needs no pane rename: the tab is what carries the label
    expect(field(await resultOf(session, ['tab', 'get', tab]), 'tab', 'label')).toBe('it-tab');
  });

  it('splits the pane it was given, in that pane’s own tab', async () => {
    const parent = await resultOf(session, ['pane', 'get', owned.panes[1] as string]);
    const child = await resultOf(session, ['pane', 'get', owned.panes[2] as string]);
    expect(field(child, 'pane', 'tab_id')).toBe(field(parent, 'pane', 'tab_id'));
    expect(field(child, 'pane', 'workspace_id')).toBe(owned.workspace);
    expect(field(child, 'pane', 'label')).toBe('it-split');
  });

  it('created exactly those three panes and nothing else', async () => {
    const panes = (await resultOf(session, ['pane', 'list'])).panes as { pane_id: string }[];
    expect(panes.map((p) => p.pane_id).sort()).toEqual([...owned.panes].sort());
  });

  it('runs a real gate and reads its real exit status', async () => {
    const launch = adapter().startProcess(
      { node: 'it_gate', command: 'echo ok', cwd },
      Date.now() + BOUND,
    );
    expect(await within(launch.started, 'gate launch')).toEqual({ kind: 'accepted' });
    const observed = await within(
      adapter().observeProcess(launch.executionId, Date.now() + BOUND),
      'gate observation',
    );
    expect(observed).toMatchObject({ kind: 'completed', exitStatus: 0, output: 'ok\n' });
  }, 60_000);

  it('reports a failing gate’s own status, not a fabricated one', async () => {
    const launch = adapter().startProcess(
      { node: 'it_gate', command: 'printf "boom\\n" >&2; exit 3', cwd },
      Date.now() + BOUND,
    );
    await within(launch.started, 'gate launch');
    const observed = await within(
      adapter().observeProcess(launch.executionId, Date.now() + BOUND),
      'gate observation',
    );
    expect(observed).toMatchObject({ kind: 'completed', exitStatus: 3 });
    expect((observed as { output: string }).output).toContain('boom');
  }, 60_000);

  it('leaves the live panes alone when it shuts down, and still replays what it holds', async () => {
    const launch = adapter().startProcess(
      { node: 'it_gate', command: 'echo held', cwd },
      Date.now() + BOUND,
    );
    await within(launch.started, 'gate launch');
    await within(
      adapter().observeProcess(launch.executionId, Date.now() + BOUND),
      'gate observation',
    );

    await within(adapter().shutdown(), 'shutdown');

    // SPEC R13: shutting the adapter down releases the adapter, not the operator's terminal
    const panes = (await resultOf(session, ['pane', 'list'])).panes as { pane_id: string }[];
    expect(panes.map((p) => p.pane_id).sort()).toEqual([...owned.panes].sort());
    // and a result it already holds is still the caller's to collect
    expect(
      await within(
        adapter().observeProcess(launch.executionId, Date.now() + BOUND),
        'observation after shutdown',
      ),
    ).toMatchObject({ kind: 'completed', exitStatus: 0, output: 'held\n' });
    await expect(
      adapter().createLayout({ destination: { kind: 'new_workspace' }, cwd, label: 'never' }),
    ).rejects.toThrow('createLayout after shutdown');
  }, 60_000);
});

/**
 * The cleanup logic itself, on doubles.
 *
 * These need no herdr and run everywhere, including CI — which matters, because the live suite
 * above is the one place a cleanup defect does real damage and the one place no CI job looks.
 */
describe('putting the machine back', () => {
  /** A server process whose exit the test decides. */
  const stubServer = () => {
    let listener: (() => void) | undefined;
    const state = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
    let kills = 0;
    let onKill: (() => void) | undefined;
    const goes = (after: number, how: 'exit' | 'signal') =>
      setTimeout(() => {
        if (how === 'exit') state.exitCode = 0;
        else state.signalCode = 'SIGTERM';
        listener?.();
      }, after);
    return {
      kills: () => kills,
      /** Ignores the stop, and goes only when it is killed — a kill that does work. */
      diesOnKill: (after: number) => (onKill = () => goes(after, 'signal')),
      /** The process finally goes, `after` milliseconds from now. */
      exitsIn: (after: number, how: 'exit' | 'signal' = 'exit') => goes(after, how),
      process: {
        get exitCode() {
          return state.exitCode;
        },
        get signalCode() {
          return state.signalCode;
        },
        kill: () => {
          kills += 1;
          onKill?.();
        },
        once: (_event: 'exit', fn: () => void) => (listener = fn),
      } satisfies ServerProcess,
    };
  };

  const effects = () => {
    const order: string[] = [];
    /** Records the bound each effect was handed, so "the child got the deadline" is checkable. */
    const bounds: Record<string, number> = {};
    return {
      order,
      bounds,
      stopServer: async (bound: number) => {
        bounds['stop'] = bound;
        order.push('stop');
      },
      deleteSession: async (bound: number) => {
        bounds['delete'] = bound;
        order.push('delete');
      },
      stillRunning: async (bound: number) => {
        bounds['status'] = bound;
        return false;
      },
      listed: async (bound: number) => {
        bounds['listed'] = bound;
        return false;
      },
      budget: 600,
    };
  };

  /** An effect that ignores its bound entirely, the way an unbounded CLI child would. */
  const hangs = () => new Promise<never>(() => undefined);

  it('releases the adapter before it stops the server', async () => {
    const server = stubServer();
    server.exitsIn(0);
    const base = effects();
    const trouble = await tearDown({
      ...base,
      runtime: { shutdown: async () => void base.order.push('shutdown') },
      server: server.process,
    });
    expect(trouble).toEqual([]);
    // the abandoned layout call is ended first, so nothing of ours is still talking to a server
    // that is about to be stopped and a session that is about to be deleted
    expect(base.order).toEqual(['shutdown', 'stop', 'delete']);
  });

  it('bounds a shutdown that will not finish, and still stops the server', async () => {
    const server = stubServer();
    server.exitsIn(0);
    const base = effects();
    const trouble = await tearDown({
      ...base,
      runtime: { shutdown: hangs }, // never settles
      server: server.process,
    });
    expect(trouble).toEqual([expect.stringMatching(/^shutdown did not finish within \d+ms$/)]);
    expect(base.order).toEqual(['stop', 'delete']); // reported, not fatal: the rest still happened
  });

  it('waits for a server that is slow to exit rather than killing it', async () => {
    // it stopped serving at once but its process needs another moment; that is a clean exit, and
    // killing it in that window would report a healthy shutdown as a broken one
    const server = stubServer();
    server.exitsIn(300);
    const trouble = await tearDown({ ...effects(), server: server.process });
    expect(trouble).toEqual([]);
    expect(server.kills()).toBe(0);
  });

  it('kills a server that never exits, and waits for that too', async () => {
    const server = stubServer();
    const trouble = await tearDown({ ...effects(), server: server.process });
    expect(server.kills()).toBe(1);
    expect(trouble).toEqual(['the server process did not exit even after being killed']);
  });

  it('reports a kill that did work as a kill, not as a healthy exit', async () => {
    const server = stubServer();
    server.diesOnKill(20); // ignores the stop and goes when killed, well inside the reserve
    const trouble = await tearDown({ ...effects(), server: server.process });
    expect(server.kills()).toBe(1);
    expect(trouble).toEqual(['the server process had to be killed']);
  });

  it('attempts nothing when this run started nothing', async () => {
    const base = effects();
    expect(await tearDown({ ...base })).toEqual([]);
    expect(base.order).toEqual([]); // no server of ours, so no server of anyone else's is touched
  });

  it('hands every phase the time it has left, so the child is bounded and not just the wait', async () => {
    const server = stubServer();
    server.exitsIn(0);
    const base = effects();
    expect(await tearDown({ ...base, server: server.process })).toEqual([]);
    for (const named of ['stop', 'status', 'delete', 'listed']) {
      // drawn from what is left of the budget, never a fixed per-command bound of its own: a
      // child given 20s inside a 600ms cleanup outlives the phase that gave up on it
      expect(base.bounds[named]).toBeGreaterThan(0);
      expect(base.bounds[named]).toBeLessThanOrEqual(base.budget);
    }
    // and it shrinks as it is spent, rather than each phase starting from the full budget again
    expect(base.bounds['listed']).toBeLessThanOrEqual(base.bounds['stop'] as number);
  });

  it('bounds the status query too, and still reaches termination', async () => {
    // a hanging status poll would otherwise strand cleanup before the kill it exists to reach
    const server = stubServer();
    server.diesOnKill(10);
    const started = Date.now();
    const trouble = await tearDown({
      ...effects(),
      server: server.process,
      stillRunning: hangs as unknown as (bound: number) => Promise<boolean>,
    });
    expect(Date.now() - started).toBeLessThan(800);
    expect(server.kills()).toBe(1);
    expect(trouble).toEqual(['the server process had to be killed']);
  });

  it('keeps the hooks longer than the work they run', () => {
    // the relationship the hook arguments rely on, written down once and checked here
    expect(CLEANUP_HOOK).toBeGreaterThan(CLEANUP_BUDGET);
    expect(SETUP_HOOK).toBeGreaterThan(SETUP_BUDGET);
  });

  it('holds its deadline when every effect hangs and the kill does not work', async () => {
    // The worst case: nothing settles, and the process ignores the signal. On a controlled clock,
    // so the margin being checked is the real one rather than whatever the machine was doing.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const server = stubServer(); // never exits, and ignores kill()
      const budget = 600;
      const began = Date.now();
      let trouble: string[] | undefined;
      let took = -1;
      void tearDown({
        runtime: { shutdown: hangs },
        server: server.process,
        stopServer: hangs,
        deleteSession: hangs,
        stillRunning: hangs as unknown as (bound: number) => Promise<boolean>,
        listed: hangs as unknown as (bound: number) => Promise<boolean>,
        budget,
      }).then((met) => {
        trouble = met;
        took = Date.now() - began;
      });
      await vi.advanceTimersByTimeAsync(budget * 4);

      // exactly the budget, not the budget plus whatever the phases overran by
      expect(took).toBeLessThanOrEqual(budget);
      expect(server.kills()).toBe(1);
      expect(trouble).toEqual([
        expect.stringMatching(/^shutdown did not finish within \d+ms$/),
        expect.stringMatching(/^server stop did not finish within \d+ms$/),
        expect.stringMatching(/^session delete did not finish within \d+ms$/),
        'the session is still listed after delete',
        'the server process did not exit even after being killed',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays inside its budget when every phase hangs, with enough held back to kill', async () => {
    // Scaled down from the real thing. What makes `CLEANUP_BUDGET + SLACK` a sufficient hook
    // timeout is this property and only this one: cleanup finishes inside its budget no matter how
    // many phases fail. A sum of per-phase bounds would be several times the budget, overrun any
    // hook derived from it, and lose every diagnostic collected up to that point.
    // (Vitest's own hook timeout is not observable from inside a test; the derivation above is
    // structural, and this is the half that can be checked.)
    const server = stubServer(); // never exits on its own
    server.diesOnKill(10);
    const budget = 600;

    const started = Date.now();
    const trouble = await tearDown({
      runtime: { shutdown: hangs },
      server: server.process,
      stopServer: hangs,
      deleteSession: hangs,
      // every phase, the status poll included: it is the one that used to be unbounded
      stillRunning: hangs as unknown as (bound: number) => Promise<boolean>,
      listed: hangs as unknown as (bound: number) => Promise<boolean>,
      budget,
    });
    const took = Date.now() - started;

    expect(took).toBeLessThan(budget + 200); // and so, comfortably inside budget + SLACK
    expect(server.kills()).toBe(1); // the reserve was still there to force the process out
    expect(trouble).toEqual([
      expect.stringMatching(/^shutdown did not finish within \d+ms$/),
      expect.stringMatching(/^server stop did not finish within \d+ms$/),
      expect.stringMatching(/^session delete did not finish within \d+ms$/),
      'the session is still listed after delete',
      'the server process had to be killed',
    ]);
  });

  it('reports every problem it met, not merely the first', async () => {
    const server = stubServer();
    server.exitsIn(0);
    const trouble = await tearDown({
      ...effects(),
      server: server.process,
      stopServer: () => Promise.reject(new Error('socket gone')),
      deleteSession: () => Promise.reject(new Error('busy')),
      listed: async () => true,
    });
    expect(trouble).toEqual([
      'server stop: socket gone',
      'session delete: busy',
      'the session is still listed after delete',
    ]);
  });
});
