import { describe, expect, it } from 'vitest';

import type { LayoutSpec, PaneId } from './adapter.js';
import {
  createFakeRuntime,
  type FakeRuntimeConfig,
  type InspectionScript,
  type ScenarioInput,
} from './fake.js';

const PANE = 'w1:p1' as PaneId;
const OTHER = 'w1:p2' as PaneId;
const STRANGER = 'w9:p9' as PaneId;

const settled = (node: string, text: string): ScenarioInput => ({
  kind: 'agent_result',
  node,
  result: 'settled',
  text,
});
const make = (extra: Partial<FakeRuntimeConfig> = {}, inputs: ScenarioInput[] = []) =>
  createFakeRuntime({
    inputs,
    panes: { [PANE]: 'implementer', [OTHER]: 'reviewer' },
    ...extra,
  });
const deadline = () => Date.now() + 60_000;
const spec = (destination: LayoutSpec['destination'], label = 'implementer'): LayoutSpec => ({
  destination,
  cwd: '/repo',
  label,
});

describe('createLayout', () => {
  it('hands out the configured panes in order, recording each target explicitly', async () => {
    const r = make({}, [settled('implementer', 'x\n')]);
    await expect(r.createLayout(spec({ kind: 'new_workspace' }))).resolves.toBe(PANE);
    await expect(
      r.createLayout(spec({ kind: 'split', pane: PANE, direction: 'right' }, 'reviewer')),
    ).resolves.toBe(OTHER);
    expect(r.history.filter((h) => h.call === 'createLayout')).toEqual([
      { call: 'createLayout', pane: PANE, spec: spec({ kind: 'new_workspace' }) },
      {
        call: 'createLayout',
        pane: OTHER,
        spec: spec({ kind: 'split', pane: PANE, direction: 'right' }, 'reviewer'),
      },
    ]);
    expect(r.remaining()).toBe(1); // layout is configuration, not script
  });

  it('records the whole target, so mistargeted calls are distinguishable', async () => {
    const r = make({ layout: [PANE, OTHER] });
    await r.createLayout({ ...spec({ kind: 'workspace', workspaceId: 'w1' }), cwd: '/repo' });
    await r.createLayout({
      ...spec({ kind: 'workspace', workspaceId: 'elsewhere' }),
      cwd: '/wrong',
    });
    const [first, second] = r.history.filter((h) => h.call === 'createLayout');
    expect(first).not.toEqual(second);
    expect(second).toMatchObject({
      spec: { destination: { kind: 'workspace', workspaceId: 'elsewhere' }, cwd: '/wrong' },
    });
    // a split records both which pane it split and which way
    const r2 = make({ layout: [OTHER] });
    await r2.createLayout(spec({ kind: 'split', pane: PANE, direction: 'down' }));
    expect(r2.history.at(-1)).toMatchObject({
      spec: { destination: { kind: 'split', pane: PANE, direction: 'down' } },
    });
  });

  it('snapshots the spec, so a caller reusing one object cannot rewrite earlier records', async () => {
    const r = make({ layout: [PANE, OTHER] });
    const reused = spec({ kind: 'workspace', workspaceId: 'w1' }, 'first');
    await r.createLayout(reused);
    const mutable = reused as { destination: { workspaceId: string }; cwd: string; label: string };
    mutable.destination.workspaceId = 'w2';
    mutable.cwd = '/different';
    mutable.label = 'second';
    await r.createLayout(reused);
    expect(r.history.filter((h) => h.call === 'createLayout')).toEqual([
      {
        call: 'createLayout',
        pane: PANE,
        spec: {
          destination: { kind: 'workspace', workspaceId: 'w1' },
          cwd: '/repo',
          label: 'first',
        },
      },
      {
        call: 'createLayout',
        pane: OTHER,
        spec: {
          destination: { kind: 'workspace', workspaceId: 'w2' },
          cwd: '/different',
          label: 'second',
        },
      },
    ]);
  });

  it.each([
    ['is not bound to a node', [STRANGER], /not bound to a node/],
    ['repeats a pane', [PANE, PANE], /repeats pane/],
  ])('refuses configuration whose layout %s', (_label, layout, message) => {
    expect(() => make({ layout })).toThrow(message);
  });

  it('respects an explicit layout order rather than the binding order', async () => {
    const r = make({ layout: [OTHER, PANE] });
    await expect(r.createLayout(spec({ kind: 'workspace', workspaceId: 'w1' }))).resolves.toBe(
      OTHER,
    );
  });

  it('refuses to split a pane it does not know', async () => {
    const r = make();
    await expect(
      r.createLayout(spec({ kind: 'split', pane: STRANGER, direction: 'down' })),
    ).rejects.toThrow(/unknown pane/);
  });

  it('refuses once the configured panes run out, rather than inventing one', async () => {
    const r = make({ layout: [PANE] });
    await r.createLayout(spec({ kind: 'new_workspace' }));
    await expect(r.createLayout(spec({ kind: 'new_workspace' }))).rejects.toThrow(
      /no pane configured/,
    );
  });

  it('refuses after shutdown', async () => {
    const r = make();
    await r.shutdown();
    await expect(r.createLayout(spec({ kind: 'new_workspace' }))).rejects.toThrow(/after shutdown/);
  });
});

describe('launchAgent', () => {
  it('launches ready by default and names the agent', async () => {
    const r = make();
    await expect(r.launchAgent(PANE, 'claude-code', deadline())).resolves.toEqual({
      kind: 'ready',
      agent: { pane: PANE, name: 'agent-1' },
    });
  });

  it('reports a startup dialog without answering it, keeping the agent addressable', async () => {
    const r = make({ launches: { [PANE]: { kind: 'not_ready', detail: 'trust prompt' } } });
    await expect(r.launchAgent(PANE, 'claude-code', deadline())).resolves.toEqual({
      kind: 'not_ready',
      agent: { pane: PANE, name: 'agent-1' },
      detail: 'trust prompt',
    });
  });

  it('leaves an unconfirmed start unnamed, and adoption by pane yields a nameless handle', async () => {
    const r = make({ launches: { [PANE]: { kind: 'startup_unconfirmed', detail: 'slow start' } } });
    await expect(r.launchAgent(PANE, 'claude-code', deadline())).resolves.toEqual({
      kind: 'startup_unconfirmed',
      pane: PANE,
      detail: 'slow start',
    });
    // an unconfirmed start establishes neither recognition nor startup, so inspecting concludes
    // nothing at all — not a recognised agent of unknown readiness, and not a ready one
    for (let i = 0; i < 2; i++)
      await expect(r.inspectAgent(PANE, deadline())).resolves.toEqual({
        kind: 'timed_out',
        pane: PANE,
      });
  });

  it.each([
    [
      'a recognised orphan',
      { kind: 'state_unknown', detail: 'lifecycle status unknown' } as InspectionScript,
      { kind: 'state_unknown', agent: { pane: PANE }, detail: 'lifecycle status unknown' },
    ],
    [
      'no recognised agent',
      { kind: 'no_agent' } as InspectionScript,
      { kind: 'no_agent', pane: PANE },
    ],
    [
      'a recovered agent',
      { kind: 'ready' } as InspectionScript,
      { kind: 'ready', agent: { pane: PANE } },
    ],
  ])('resolves an unconfirmed start into %s only when told', async (_label, script, expected) => {
    const r = make({
      launches: { [PANE]: { kind: 'startup_unconfirmed', detail: 'slow start' } },
      inspections: { [PANE]: [script] },
    });
    await r.launchAgent(PANE, 'claude-code', deadline());
    await expect(r.inspectAgent(PANE, deadline())).resolves.toEqual(expected);
    // adopted by pane alone, so still nameless, and the established state now holds
    await expect(r.inspectAgent(PANE, deadline())).resolves.toEqual(expected);
  });

  it('keeps a startup dialog until something explicitly clears it', async () => {
    const r = make({ launches: { [PANE]: { kind: 'not_ready', detail: 'trust prompt' } } }, [
      settled('implementer', 'done\n'),
    ]);
    await r.launchAgent(PANE, 'claude-code', deadline());
    // inspecting twice must not quietly answer the dialog
    for (let i = 0; i < 2; i++)
      await expect(r.inspectAgent(PANE, deadline())).resolves.toMatchObject({
        kind: 'not_ready',
        detail: 'trust prompt',
      });
  });

  it.each([
    ['an unbound pane', (r: ReturnType<typeof make>) => r.launchAgent(STRANGER, 'x', 1)],
    [
      'a shut-down runtime',
      async (r: ReturnType<typeof make>) => (await r.shutdown(), r.launchAgent(PANE, 'x', 1)),
    ],
  ])('reports %s as unconfirmed rather than a pretend success', async (_label, launch) => {
    expect((await launch(make())).kind).toBe('startup_unconfirmed');
  });

  it('records the profile and deadline exactly as supplied', async () => {
    const r = make();
    await r.launchAgent(PANE, 'codex', 1_700_000_000_000);
    expect(r.history.filter((h) => h.call === 'launchAgent')).toEqual([
      { call: 'launchAgent', pane: PANE, profile: 'codex', deadline: 1_700_000_000_000 },
    ]);
  });
});

describe('inspectAgent', () => {
  it.each([
    ['blocked', { kind: 'agent_result', node: 'implementer', result: 'blocked' }, 'not_ready'],
    [
      'unconfirmed',
      { kind: 'agent_result', node: 'implementer', result: 'unconfirmed' },
      'state_unknown',
    ],
    ['timed out', { kind: 'deadline_expiry', node: 'implementer' }, 'state_unknown'],
  ] as [string, ScenarioInput, string][])(
    'holds a %s turn in its observed state rather than calling it working',
    async (_label, input, expected) => {
      const r = make({}, [input]);
      const { turnId } = r.promptAgent({ pane: PANE }, 'go', deadline());
      expect((await r.inspectAgent(PANE, deadline())).kind).toBe('working');
      await r.observeAgentTurn(turnId, deadline());
      expect((await r.inspectAgent(PANE, deadline())).kind).toBe(expected);
      expect((await r.inspectAgent(PANE, deadline())).kind).toBe(expected); // and stays there
    },
  );

  it('derives working while a turn is unsettled and ready once it is not', async () => {
    const r = make({}, [settled('implementer', 'done\n')]);
    await expect(r.inspectAgent(PANE, deadline())).resolves.toMatchObject({ kind: 'ready' });
    const { turnId } = r.promptAgent({ pane: PANE }, 'go', deadline());
    await expect(r.inspectAgent(PANE, deadline())).resolves.toMatchObject({ kind: 'working' });
    await r.observeAgentTurn(turnId, deadline());
    await expect(r.inspectAgent(PANE, deadline())).resolves.toMatchObject({ kind: 'ready' });
    // a mid-turn pane is never confused with a free one, and never with another pane's turn
    expect((await r.inspectAgent(OTHER, deadline())).kind).toBe('ready');
  });

  it('consumes its scripted queue in order, then holds the last state it was left in', async () => {
    const r = make({
      inspections: {
        [PANE]: [
          { kind: 'no_agent' },
          { kind: 'not_ready', detail: 'trust prompt' },
          { kind: 'state_unknown', detail: 'lifecycle status unknown' },
          { kind: 'timed_out' },
        ],
      },
    });
    const kinds: string[] = [];
    for (let i = 0; i < 6; i++) kinds.push((await r.inspectAgent(PANE, deadline())).kind);
    // the inspection timeout concludes nothing, so once the queue is spent the pane stays where
    // the last conclusive answer left it — it never drifts back to ready on its own
    expect(kinds).toEqual([
      'no_agent',
      'not_ready',
      'state_unknown',
      'timed_out',
      'state_unknown',
      'state_unknown',
    ]);

    // only an explicit entry moves it on, and then that state holds in turn
    const recovered = make({ inspections: { [PANE]: [{ kind: 'no_agent' }, { kind: 'ready' }] } });
    const after: string[] = [];
    for (let i = 0; i < 3; i++) after.push((await recovered.inspectAgent(PANE, deadline())).kind);
    expect(after).toEqual(['no_agent', 'ready', 'ready']);
  });

  it('reports an unknown pane as established absence, not as a timeout', async () => {
    await expect(make().inspectAgent(STRANGER, deadline())).resolves.toEqual({
      kind: 'unknown_pane',
      pane: STRANGER,
    });
  });

  it('reports cancellation, from an aborted signal and after shutdown, as neither timeout nor absence', async () => {
    const r = make();
    const c = new AbortController();
    c.abort();
    await expect(r.inspectAgent(PANE, deadline(), c.signal)).resolves.toEqual({
      kind: 'cancelled',
      pane: PANE,
    });
    await r.shutdown();
    await expect(r.inspectAgent(PANE, deadline())).resolves.toEqual({
      kind: 'cancelled',
      pane: PANE,
    });
  });

  it('never consumes a scenario input nor reopens the release boundary', async () => {
    const r = make({}, [
      { kind: 'guard_observation', node: 'implementer', changed: false },
      settled('implementer', 'after guard\n'),
    ]);
    const { turnId } = r.promptAgent({ pane: PANE }, 'go', deadline());
    let settledYet = false;
    const pending = r.observeAgentTurn(turnId, deadline()).then((o) => ((settledYet = true), o));
    expect(r.nextGuardObservation()).toMatchObject({ changed: false });
    await r.inspectAgent(PANE, deadline());
    await r.launchAgent(PANE, 'claude-code', deadline());
    await r.createLayout(spec({ kind: 'new_workspace' }));
    expect(settledYet).toBe(false);
    expect(r.remaining()).toBe(1);
    r.release();
    await expect(pending).resolves.toMatchObject({ text: 'after guard\n' });
  });
});
