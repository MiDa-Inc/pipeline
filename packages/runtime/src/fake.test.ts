import { describe, expect, it } from 'vitest';

import type { AgentHandle, PaneId, TurnId } from './adapter.js';
import { createFakeRuntime, type ScenarioInput } from './fake.js';

const PANE = 'w1:p1' as PaneId;
const OTHER = 'w1:p2' as PaneId;
const agent: AgentHandle = { pane: PANE }; // unnamed on purpose: names are optional
const named: AgentHandle = { pane: OTHER, name: 'reviewer' };

const settled = (node: string, text: string): ScenarioInput => ({
  kind: 'agent_result',
  node,
  result: 'settled',
  text,
});
const make = (inputs: ScenarioInput[]) =>
  createFakeRuntime({ inputs, panes: { [PANE]: 'implementer', [OTHER]: 'reviewer' } });
const prompts = (r: { history: readonly { call: string }[] }) =>
  r.history.filter((h) => h.call === 'promptAgent').length;
const deadline = () => Date.now() + 60_000;

describe('submission and observation', () => {
  it('exposes the turn id before any awaiting, and accepts the submission', async () => {
    const r = make([settled('implementer', 'done\n')]);
    const sub = r.promptAgent(agent, 'go', deadline());
    expect(sub.turnId).toBeTruthy(); // available synchronously
    await expect(sub.submitted).resolves.toEqual({ kind: 'accepted' });
  });

  it('reports settled with the scripted text', async () => {
    const r = make([settled('implementer', 'VERDICT: APPROVE\n')]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    await expect(r.observeAgentTurn(turnId, deadline())).resolves.toEqual({
      kind: 'settled',
      turnId,
      text: 'VERDICT: APPROVE\n',
    });
  });

  it.each(['blocked', 'unconfirmed'] as const)(
    'reports %s without settling the turn',
    async (result) => {
      const r = make([{ kind: 'agent_result', node: 'implementer', result }]);
      const { turnId } = r.promptAgent(agent, 'go', deadline());
      const observed = await r.observeAgentTurn(turnId, deadline());
      expect(observed.kind).toBe(result);
      await expect(r.readAgentOutput(turnId)).resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'not_settled',
      });
    },
  );

  it('treats an unconfirmed turn as pending until a later deadline expiry', async () => {
    const r = make([
      { kind: 'agent_result', node: 'implementer', result: 'unconfirmed' },
      { kind: 'deadline_expiry', node: 'implementer' },
    ]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    expect((await r.observeAgentTurn(turnId, deadline())).kind).toBe('unconfirmed');
    expect((await r.observeAgentTurn(turnId, deadline())).kind).toBe('timed_out');
    expect(prompts(r)).toBe(1); // never resubmitted
  });

  it('refuses an unknown turn instead of inventing a timeout', async () => {
    const r = make([]);
    await expect(r.observeAgentTurn('nope' as TurnId, deadline())).resolves.toEqual({
      kind: 'unrecoverable',
      turnId: 'nope',
      reason: 'unknown_turn',
    });
  });
});

describe('continued observation', () => {
  it.each([
    ['blocked', { kind: 'agent_result', node: 'implementer', result: 'blocked' } as ScenarioInput],
    ['timeout', { kind: 'deadline_expiry', node: 'implementer' } as ScenarioInput],
  ])(
    'keeps one identity and one submission across %s, and recovers the answer',
    async (_label, first) => {
      const r = make([first, settled('implementer', 'finished\n')]);
      const { turnId } = r.promptAgent(agent, 'go', deadline());
      const before = await r.observeAgentTurn(turnId, deadline());
      const after = await r.observeAgentTurn(turnId, deadline() + 1000);
      expect(before.turnId).toBe(turnId);
      expect(after).toEqual({ kind: 'settled', turnId, text: 'finished\n' });
      expect(prompts(r)).toBe(1);
      await expect(r.readAgentOutput(turnId)).resolves.toEqual({
        kind: 'available',
        turnId,
        text: 'finished\n',
      });
    },
  );
});

describe('output isolation', () => {
  it('never returns an earlier turn answer for a later turn on the same agent', async () => {
    const r = make([settled('implementer', 'first\n'), settled('implementer', 'second\n')]);
    const one = r.promptAgent(agent, 'a', deadline()).turnId;
    await r.observeAgentTurn(one, deadline());
    const two = r.promptAgent(agent, 'b', deadline()).turnId;
    await expect(r.readAgentOutput(two)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'not_settled',
    });
    await r.observeAgentTurn(two, deadline());
    await expect(r.readAgentOutput(one)).resolves.toMatchObject({ text: 'first\n' });
    await expect(r.readAgentOutput(two)).resolves.toMatchObject({ text: 'second\n' });
  });
});

describe('ordered cursor and driver', () => {
  const stream: ScenarioInput[] = [
    settled('implementer', 'done\n'),
    { kind: 'gate_result', node: 'test_gate', exit_status: 0, output: '12 passing\n' },
    { kind: 'guard_observation', node: 'reviewer', changed: false },
    { kind: 'operator_action', action: 'resume', extra_rounds: 1 },
  ];

  it('keeps deferred gate entries in the stream rather than filtering them out', async () => {
    const r = make(stream);
    await r.observeAgentTurn(r.promptAgent(agent, 'go', deadline()).turnId, deadline());
    expect(r.peek()).toMatchObject({ kind: 'gate_result', node: 'test_gate' });
    expect(r.remaining()).toBe(3);
  });

  it('does not advance the cursor on a mismatched request', () => {
    const r = make(stream);
    expect(r.nextGuardObservation()).toBeUndefined();
    expect(r.nextOperatorAction()).toBeUndefined();
    expect(r.remaining()).toBe(stream.length);
  });

  it('leaves a wrong-node observation pending without consuming anything', async () => {
    const r = make([settled('implementer', 'done\n')]);
    const wrong = r.promptAgent(named, 'go', deadline()).turnId; // reviewer, but the head is implementer
    let done = false;
    void r.observeAgentTurn(wrong, deadline()).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    expect(r.remaining()).toBe(1);
  });

  it('stays usable while an agent observation is pending, as stop-mid-turn needs', async () => {
    const r = make([{ kind: 'operator_action', action: 'stop' }]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    const pending = r.observeAgentTurn(turnId, deadline());
    expect(r.nextOperatorAction()).toMatchObject({ action: 'stop' });
    await r.shutdown();
    await expect(pending).resolves.toEqual({ kind: 'cancelled', turnId });
  });

  it('reports exhaustion and leaves observations pending', async () => {
    const r = make([]);
    expect(r.peek()).toBeUndefined();
    expect(r.remaining()).toBe(0);
    let done = false;
    void r
      .observeAgentTurn(r.promptAgent(agent, 'go', deadline()).turnId, deadline())
      .then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
  });
});

describe('cancellation and shutdown', () => {
  it('cancels one observation via its signal, distinct from a timeout', async () => {
    const r = make([settled('reviewer', 'x\n')]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    const controller = new AbortController();
    const pending = r.observeAgentTurn(turnId, deadline(), controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: 'cancelled', turnId });
    expect(r.remaining()).toBe(1); // cancelling consumed nothing
  });

  it('is idempotent and leaves turn identities readable afterwards', async () => {
    const r = make([settled('implementer', 'kept\n')]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    await r.observeAgentTurn(turnId, deadline());
    await r.shutdown();
    await r.shutdown();
    await expect(r.readAgentOutput(turnId)).resolves.toEqual({
      kind: 'available',
      turnId,
      text: 'kept\n',
    });
  });
});

describe('turn binding (regressions)', () => {
  it('never hands an earlier turn answer to a later turn, even observed in reverse order', async () => {
    const r = make([settled('implementer', 'first\n'), settled('implementer', 'second\n')]);
    const one = r.promptAgent(agent, 'a', deadline());
    const two = r.promptAgent(agent, 'b', deadline());
    // the agent is mid-turn, so the second submission is refused rather than queued
    await expect(two.submitted).resolves.toMatchObject({ kind: 'unconfirmed' });
    const second = await r.observeAgentTurn(two.turnId, deadline());
    expect(second).toEqual({ kind: 'unrecoverable', turnId: two.turnId, reason: 'unknown_turn' });
    await expect(r.observeAgentTurn(one.turnId, deadline())).resolves.toMatchObject({
      text: 'first\n',
    });
  });

  it('settles two observers of one turn from a single result without double-consuming', async () => {
    // the guard at the head holds both observers pending, so neither replays a cached answer
    const r = make([
      { kind: 'guard_observation', node: 'implementer', changed: false },
      settled('implementer', 'once\n'),
      settled('implementer', 'should not be used\n'),
    ]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    const first = r.observeAgentTurn(turnId, deadline());
    const second = r.observeAgentTurn(turnId, deadline());
    let settledYet = false;
    void Promise.all([first, second]).then(() => (settledYet = true));
    expect(r.nextGuardObservation()).toMatchObject({ changed: false });
    await Promise.resolve();
    expect(settledYet).toBe(false); // both genuinely pending, not cached replays
    r.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ kind: 'settled', turnId, text: 'once\n' });
    expect(b).toEqual(a);
    expect(r.remaining()).toBe(1); // only one of the two results consumed
    await expect(r.readAgentOutput(turnId)).resolves.toMatchObject({ text: 'once\n' });
  });
});

describe('progression boundary (regressions)', () => {
  it('does not release a later result when the driver takes an operator action', async () => {
    const r = make([
      { kind: 'operator_action', action: 'stop' },
      settled('implementer', 'late answer\n'),
    ]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    const pending = r.observeAgentTurn(turnId, deadline());
    expect(r.nextOperatorAction()).toMatchObject({ action: 'stop' });
    await new Promise((res) => setTimeout(res, 0)); // the caller handles stop asynchronously
    await r.shutdown();
    await expect(pending).resolves.toEqual({ kind: 'cancelled', turnId });
    expect(r.remaining()).toBe(1); // the late result was never released
  });

  it('holds an observer registered after a driver consumption until release', async () => {
    const r = make([
      { kind: 'guard_observation', node: 'implementer', changed: false },
      settled('implementer', 'after guard\n'),
      settled('implementer', 'should not be used\n'),
    ]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    expect(r.nextGuardObservation()).toMatchObject({ changed: false });
    let settledYet = false;
    const pending = r.observeAgentTurn(turnId, deadline()).then((o) => ((settledYet = true), o));
    await Promise.resolve();
    expect(settledYet).toBe(false); // registered after the consumption, still held
    expect(r.remaining()).toBe(2);
    r.release();
    await expect(pending).resolves.toMatchObject({ text: 'after guard\n' });
    expect(r.remaining()).toBe(1); // exactly one result released
  });

  it('releases pending results only when release() is called', async () => {
    const r = make([
      { kind: 'guard_observation', node: 'implementer', changed: false },
      settled('implementer', 'after guard\n'),
    ]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    let settledYet = false;
    const pending = r.observeAgentTurn(turnId, deadline()).then((o) => ((settledYet = true), o));
    expect(r.nextGuardObservation()).toMatchObject({ changed: false });
    await Promise.resolve();
    expect(settledYet).toBe(false);
    r.release();
    await expect(pending).resolves.toMatchObject({ text: 'after guard\n' });
  });
});

describe('undispatched submissions (regressions)', () => {
  it.each([
    [
      'an aborted signal',
      (r: ReturnType<typeof make>) => {
        const c = new AbortController();
        c.abort();
        return r.promptAgent(agent, 'never sent', deadline(), c.signal);
      },
    ],
    [
      'shutdown',
      (r: ReturnType<typeof make>) => {
        void r.shutdown();
        return r.promptAgent(agent, 'never sent', deadline());
      },
    ],
  ])('a submission cancelled by %s leaves the agent free', async (_label, cancel) => {
    const r = make([settled('implementer', 'for the live turn\n')]);
    const dead = cancel(r);
    await expect(dead.submitted).resolves.toEqual({ kind: 'cancelled' });
    // distinguishable from a possibly delivered submission, and it consumed nothing
    await expect(r.observeAgentTurn(dead.turnId, deadline())).resolves.toEqual({
      kind: 'cancelled',
      turnId: dead.turnId,
    });
    expect(r.remaining()).toBe(1);
  });

  it('accepts the next prompt and gives it its own answer', async () => {
    const r = make([settled('implementer', 'for the live turn\n')]);
    const c = new AbortController();
    c.abort();
    r.promptAgent(agent, 'never sent', deadline(), c.signal);
    const live = r.promptAgent(agent, 'go', deadline()); // not refused as overlapping
    await expect(live.submitted).resolves.toEqual({ kind: 'accepted' });
    await expect(r.observeAgentTurn(live.turnId, deadline())).resolves.toEqual({
      kind: 'settled',
      turnId: live.turnId,
      text: 'for the live turn\n',
    });
  });
});

describe('abort listener hygiene (regressions)', () => {
  const counted = () => {
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
    return { c, live: () => live };
  };

  it('detaches the listener after each completed observation on a shared signal', async () => {
    const inputs: ScenarioInput[] = [];
    for (let i = 0; i < 6; i++) inputs.push(settled('implementer', `t${i}\n`));
    const r = make(inputs);
    const { c, live } = counted();
    for (let i = 0; i < 6; i++) {
      const { turnId } = r.promptAgent(agent, `p${i}`, deadline());
      await r.observeAgentTurn(turnId, deadline(), c.signal);
    }
    expect(live()).toBe(0);
  });

  it('detaches on cancellation and on shutdown, and allows observing again afterwards', async () => {
    // a guard observation sits at the head, so the result is not releasable yet and the
    // observation genuinely pends long enough to be cancelled
    const r = make([
      { kind: 'guard_observation', node: 'implementer', changed: false },
      settled('implementer', 'eventual\n'),
    ]);
    const { turnId } = r.promptAgent(agent, 'go', deadline());
    const { c, live } = counted();
    const cancelled = r.observeAgentTurn(turnId, deadline(), c.signal);
    c.abort();
    await expect(cancelled).resolves.toEqual({ kind: 'cancelled', turnId });
    expect(live()).toBe(0);
    // the turn survives its cancelled observation and can be observed again
    r.nextGuardObservation();
    r.release();
    await expect(r.observeAgentTurn(turnId, deadline())).resolves.toMatchObject({
      text: 'eventual\n',
    });

    const r2 = make([]);
    const t2 = r2.promptAgent(agent, 'go', deadline()).turnId;
    const { c: c2, live: live2 } = counted();
    const pending = r2.observeAgentTurn(t2, deadline(), c2.signal);
    await r2.shutdown();
    await expect(pending).resolves.toEqual({ kind: 'cancelled', turnId: t2 });
    expect(live2()).toBe(0);
  });
});

describe('history records deadlines', () => {
  it('preserves the supplied initial and resumed deadlines exactly', async () => {
    const r = make([
      { kind: 'agent_result', node: 'implementer', result: 'blocked' },
      settled('implementer', 'done\n'),
    ]);
    const initial = 1_700_000_000_000;
    const resumed = 1_700_000_999_000;
    const { turnId } = r.promptAgent(agent, 'go', initial);
    await r.observeAgentTurn(turnId, initial);
    await r.observeAgentTurn(turnId, resumed);
    expect(r.history.filter((h) => h.call === 'promptAgent')).toEqual([
      { call: 'promptAgent', turnId, pane: PANE, prompt: 'go', deadline: initial },
    ]);
    expect(r.history.filter((h) => h.call === 'observeAgentTurn').map((h) => h.deadline)).toEqual([
      initial,
      resumed,
    ]);
  });
});
