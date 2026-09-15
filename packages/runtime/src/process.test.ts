import { describe, expect, it } from 'vitest';

import type { ExecutionId, PaneId, ProcessSpec, RuntimeAdapter } from './adapter.js';
import { createFakeRuntime, type ScenarioInput } from './fake.js';

const PANE = 'w1:p1' as PaneId;
const make = (inputs: ScenarioInput[]) =>
  createFakeRuntime({ inputs, panes: { [PANE]: 'implementer' } });
const gate = (node: string, command = 'npm test', cwd = '/repo'): ProcessSpec => ({
  node,
  command,
  cwd,
});
const ran = (node: string, exit_status: number, output: string): ScenarioInput => ({
  kind: 'gate_result',
  node,
  exit_status,
  output,
});
const starts = (r: { history: readonly { call: string }[] }) =>
  r.history.filter((h) => h.call === 'startProcess').length;
const deadline = () => Date.now() + 60_000;

describe('gate execution', () => {
  it('exposes the execution id synchronously and accepts the launch', async () => {
    const r = make([ran('test_gate', 0, '12 passing\n')]);
    const launch = r.startProcess(gate('test_gate'), deadline());
    expect(launch.executionId).toBeTruthy(); // before any awaiting
    await expect(launch.started).resolves.toEqual({ kind: 'accepted' });
  });

  it.each([
    [0, '12 passing\n'],
    [1, '1 failing: upload times out\n'],
    [0, ''], // empty output is a real result, not an absent one
  ])('reports exit status %i and its output verbatim', async (exit_status, output) => {
    const r = make([ran('test_gate', exit_status, output)]);
    const { executionId } = r.startProcess(gate('test_gate'), deadline());
    await expect(r.observeProcess(executionId, deadline())).resolves.toEqual({
      kind: 'completed',
      executionId,
      exitStatus: exit_status,
      output,
    });
  });

  it('refuses an unknown execution instead of inventing a timeout', async () => {
    await expect(make([]).observeProcess('nope' as ExecutionId, deadline())).resolves.toEqual({
      kind: 'unrecoverable',
      executionId: 'nope',
      reason: 'unknown_execution',
    });
  });
});

describe('identity and retention', () => {
  it('keeps one identity and one run across a timeout, and replays the retained result', async () => {
    const r = make([
      { kind: 'deadline_expiry', node: 'test_gate' },
      ran('test_gate', 0, '12 passing\n'),
    ]);
    const { executionId } = r.startProcess(gate('test_gate'), deadline());
    await expect(r.observeProcess(executionId, deadline())).resolves.toEqual({
      kind: 'timed_out',
      executionId, // no invented exit status: a timeout is not a failure
    });
    const finished = { kind: 'completed', executionId, exitStatus: 0, output: '12 passing\n' };
    // resumed observation on a fresh deadline, then the retained result replays unchanged
    await expect(r.observeProcess(executionId, deadline() + 1000)).resolves.toEqual(finished);
    await expect(r.observeProcess(executionId, deadline())).resolves.toEqual(finished);
    expect(starts(r)).toBe(1); // never rerun, which is what SPEC R7 forbids
  });

  it('never hands one gate node result to another sharing its command and directory', async () => {
    const r = make([ran('lint_gate', 0, 'lint clean\n'), ran('test_gate', 1, '1 failing\n')]);
    const lint = r.startProcess(gate('lint_gate', 'npm test', '/repo'), deadline());
    const test = r.startProcess(gate('test_gate', 'npm test', '/repo'), deadline());
    expect(test.executionId).not.toBe(lint.executionId);
    // both watched at once: each result reaches its own execution, in the scripted order
    const [watchedTest, watchedLint] = await Promise.all([
      r.observeProcess(test.executionId, deadline()),
      r.observeProcess(lint.executionId, deadline()),
    ]);
    expect(watchedLint).toMatchObject({ executionId: lint.executionId, output: 'lint clean\n' });
    expect(watchedTest).toMatchObject({ executionId: test.executionId, output: '1 failing\n' });
  });

  it('runs one gate node again in a later round, with its own identity and result', async () => {
    const r = make([ran('test_gate', 1, '1 failing\n'), ran('test_gate', 0, '12 passing\n')]);
    const first = r.startProcess(gate('test_gate'), deadline());
    await expect(r.observeProcess(first.executionId, deadline())).resolves.toMatchObject({
      exitStatus: 1,
    });
    const second = r.startProcess(gate('test_gate'), deadline()); // the node is free again
    await expect(second.started).resolves.toEqual({ kind: 'accepted' });
    expect(second.executionId).not.toBe(first.executionId);
    await expect(r.observeProcess(second.executionId, deadline())).resolves.toMatchObject({
      exitStatus: 0,
    });
    // the earlier round's result is still its own, not overwritten by the rerun
    await expect(r.observeProcess(first.executionId, deadline())).resolves.toMatchObject({
      exitStatus: 1,
      output: '1 failing\n',
    });
  });

  it('refuses an overlapping run on one gate node rather than queueing it', async () => {
    const r = make([ran('test_gate', 0, 'first\n')]);
    const first = r.startProcess(gate('test_gate'), deadline());
    const second = r.startProcess(gate('test_gate'), deadline());
    await expect(second.started).resolves.toMatchObject({ kind: 'unconfirmed' });
    await expect(r.observeProcess(second.executionId, deadline())).resolves.toMatchObject({
      reason: 'unknown_execution',
    });
    await expect(r.observeProcess(first.executionId, deadline())).resolves.toMatchObject({
      output: 'first\n',
    });
  });
});

describe('ordering and the shared cursor', () => {
  it('leaves a wrong-node execution pending without consuming anything', async () => {
    const r = make([ran('lint_gate', 0, 'lint clean\n')]);
    const { executionId } = r.startProcess(gate('test_gate'), deadline());
    let done = false;
    void r.observeProcess(executionId, deadline()).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    expect(r.remaining()).toBe(1);
  });

  it('settles two observers of one execution from a single result', async () => {
    const r = make([
      { kind: 'guard_observation', node: 'implementer', changed: false },
      ran('test_gate', 0, 'once\n'),
      ran('test_gate', 1, 'should not be used\n'),
    ]);
    const { executionId } = r.startProcess(gate('test_gate'), deadline());
    const first = r.observeProcess(executionId, deadline());
    const second = r.observeProcess(executionId, deadline());
    let settledYet = false;
    void Promise.all([first, second]).then(() => (settledYet = true));
    expect(r.nextGuardObservation()).toMatchObject({ changed: false });
    await Promise.resolve();
    expect(settledYet).toBe(false); // the release boundary holds gate results too
    r.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ output: 'once\n' });
    expect(b).toEqual(a);
    expect(r.remaining()).toBe(1); // one input consumed, not two
  });

  it('does not let a gate result overtake an operator action', async () => {
    const r = make([{ kind: 'operator_action', action: 'stop' }, ran('test_gate', 0, 'late\n')]);
    const { executionId } = r.startProcess(gate('test_gate'), deadline());
    const pending = r.observeProcess(executionId, deadline());
    expect(r.nextOperatorAction()).toMatchObject({ action: 'stop' });
    await r.shutdown();
    await expect(pending).resolves.toEqual({ kind: 'cancelled', executionId });
    expect(r.remaining()).toBe(1);
  });
});

describe('cancellation and shutdown', () => {
  it('cancels one observation via its signal, distinct from a timeout', async () => {
    const r = make([
      { kind: 'guard_observation', node: 'implementer', changed: false },
      ran('test_gate', 0, 'eventual\n'),
    ]);
    const { executionId } = r.startProcess(gate('test_gate'), deadline());
    const c = new AbortController();
    const pending = r.observeProcess(executionId, deadline(), c.signal);
    c.abort();
    await expect(pending).resolves.toEqual({ kind: 'cancelled', executionId });
    expect(r.remaining()).toBe(2); // cancelling consumed nothing
    // the execution survives its cancelled observation and can be watched again
    r.nextGuardObservation();
    r.release();
    await expect(r.observeProcess(executionId, deadline())).resolves.toMatchObject({
      output: 'eventual\n',
    });
  });

  it('detaches the abort listener on every ending, including shutdown', async () => {
    const r = make([ran('test_gate', 0, 'done\n')]);
    const c = new AbortController();
    let live = 0;
    const add = c.signal.addEventListener.bind(c.signal);
    const remove = c.signal.removeEventListener.bind(c.signal);
    c.signal.addEventListener = ((...a: Parameters<typeof add>) => (
      live++,
      add(...a)
    )) as typeof add;
    c.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (
      live--,
      remove(...a)
    )) as typeof remove;
    const first = r.startProcess(gate('test_gate'), deadline());
    await r.observeProcess(first.executionId, deadline(), c.signal);
    expect(live).toBe(0);
    const second = r.startProcess(gate('lint_gate'), deadline());
    const pending = r.observeProcess(second.executionId, deadline(), c.signal);
    await r.shutdown();
    await expect(pending).resolves.toEqual({ kind: 'cancelled', executionId: second.executionId });
    expect(live).toBe(0);
  });

  it('still hands back a result it holds after shutdown, and cancels one it does not', async () => {
    // What shutdown ends is waiting, not memory. Withholding a result already collected would make
    // a resumed run rerun a gate it has already run, which SPEC R12 exists to prevent.
    const r = make([ran('test_gate', 0, 'collected\n')]);
    const finished = r.startProcess(gate('test_gate'), deadline());
    await expect(r.observeProcess(finished.executionId, deadline())).resolves.toMatchObject({
      kind: 'completed',
      output: 'collected\n',
    });
    const unfinished = r.startProcess(gate('lint_gate'), deadline());
    await r.shutdown();

    expect(await r.observeProcess(finished.executionId, deadline())).toMatchObject({
      kind: 'completed',
      exitStatus: 0,
      output: 'collected\n',
    });
    // and one that never produced a result is cancelled, because no new wait is installed for it
    expect(await r.observeProcess(unfinished.executionId, deadline())).toEqual({
      kind: 'cancelled',
      executionId: unfinished.executionId,
    });
    // an identity this runtime never issued is still decided first, shut down or not, and an
    // aborted caller is answered before the retained result: it asked to stop, not to collect
    expect(await r.observeProcess('nope' as ExecutionId, deadline())).toMatchObject({
      kind: 'unrecoverable',
      reason: 'unknown_execution',
    });
    expect(await r.observeProcess(finished.executionId, deadline(), AbortSignal.abort())).toEqual({
      kind: 'cancelled',
      executionId: finished.executionId,
    });
  });

  it('does not let a launch cancelled before dispatch occupy the gate node', async () => {
    const r = make([ran('test_gate', 0, 'for the live run\n')]);
    const c = new AbortController();
    c.abort();
    const dead = r.startProcess(gate('test_gate'), deadline(), c.signal);
    await expect(dead.started).resolves.toEqual({ kind: 'cancelled' });
    await expect(r.observeProcess(dead.executionId, deadline())).resolves.toEqual({
      kind: 'cancelled',
      executionId: dead.executionId,
    });
    const live = r.startProcess(gate('test_gate'), deadline()); // accepted, not refused
    await expect(live.started).resolves.toEqual({ kind: 'accepted' });
    await expect(r.observeProcess(live.executionId, deadline())).resolves.toMatchObject({
      output: 'for the live run\n',
    });
  });

  it('records the node, command, working directory and deadline of every launch', async () => {
    const r = make([]);
    const { executionId } = r.startProcess(
      gate('test_gate', 'npm test', '/repo'),
      1_700_000_000_000,
    );
    expect(r.history.filter((h) => h.call === 'startProcess')).toEqual([
      {
        call: 'startProcess',
        executionId,
        node: 'test_gate',
        command: 'npm test',
        cwd: '/repo',
        deadline: 1_700_000_000_000,
      },
    ]);
  });
});

describe('one operation per node', () => {
  const DEADLINE = 1_700_000_000_000;
  // one pane, one node, one scripted timeout: whichever operation is accepted owns it
  const shared = () =>
    createFakeRuntime({
      inputs: [{ kind: 'deadline_expiry', node: 'shared' }],
      panes: { [PANE]: 'shared' },
    });

  it('refuses a gate run on a node whose agent is mid-turn', async () => {
    const r = shared();
    const turn = r.promptAgent({ pane: PANE }, 'go', DEADLINE);
    const run = r.startProcess(gate('shared'), 999);
    await expect(turn.submitted).resolves.toEqual({ kind: 'accepted' });
    await expect(run.started).resolves.toMatchObject({ kind: 'unconfirmed' });
    // the refused run was never registered, so it can never consume a result
    await expect(r.observeProcess(run.executionId, 999)).resolves.toMatchObject({
      reason: 'unknown_execution',
    });
    expect(r.remaining()).toBe(1);
    // and the sole timeout belongs to the accepted turn, unambiguously
    await expect(r.observeAgentTurn(turn.turnId, DEADLINE)).resolves.toEqual({
      kind: 'timed_out',
      turnId: turn.turnId,
    });
    expect(r.remaining()).toBe(0);
    expect(r.history.find((h) => h.call === 'promptAgent')).toMatchObject({ deadline: DEADLINE });
  });

  it('refuses a prompt on a node whose gate is still running', async () => {
    const r = shared();
    const run = r.startProcess(gate('shared'), DEADLINE);
    const turn = r.promptAgent({ pane: PANE }, 'go', 999);
    await expect(run.started).resolves.toEqual({ kind: 'accepted' });
    await expect(turn.submitted).resolves.toMatchObject({ kind: 'unconfirmed' });
    await expect(r.observeAgentTurn(turn.turnId, 999)).resolves.toMatchObject({
      reason: 'unknown_turn',
    });
    expect(r.remaining()).toBe(1);
    await expect(r.observeProcess(run.executionId, DEADLINE)).resolves.toEqual({
      kind: 'timed_out',
      executionId: run.executionId,
    });
    expect(r.remaining()).toBe(0);
    expect(r.history.find((h) => h.call === 'startProcess')).toMatchObject({ deadline: DEADLINE });
  });
});

describe('adapter conformance', () => {
  it('satisfies the whole RuntimeAdapter surface', () => {
    // the annotation is the assertion: this fails to compile if any method is missing or mistyped
    const adapter: RuntimeAdapter = make([]);
    const methods: (keyof RuntimeAdapter)[] = [
      'createLayout',
      'launchAgent',
      'inspectAgent',
      'promptAgent',
      'observeAgentTurn',
      'readAgentOutput',
      'startProcess',
      'observeProcess',
      'shutdown',
    ];
    for (const method of methods) expect(adapter[method]).toBeTypeOf('function');
  });
});
