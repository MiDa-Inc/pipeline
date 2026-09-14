import type {
  AgentHandle,
  AgentObservation,
  AgentOutput,
  AgentSubmission,
  DeadlineEpochMs,
  PaneId,
  RuntimeAdapter,
  TurnId,
} from './adapter.js';

/**
 * A RuntimeAdapter driven by a golden scenario's `inputs` array instead of a real agent.
 *
 * Progression is scripted, never timed: nothing sleeps and wall-clock time is ignored, so a turn
 * times out because the script says `deadline_expiry`, not because a clock advanced. The `deadline`
 * arguments are still recorded, so tests can assert what the caller asked for.
 *
 * It runs no processes, no herdr commands and no git operations.
 */

/** One entry of a scenario's ordered `inputs` array. Mirrors spec/scenario.schema.json. */
export type ScenarioInput =
  | {
      readonly kind: 'agent_result';
      readonly node: string;
      readonly result: 'settled';
      readonly text: string;
    }
  | {
      readonly kind: 'agent_result';
      readonly node: string;
      readonly result: 'blocked' | 'unconfirmed';
    }
  | {
      readonly kind: 'gate_result';
      readonly node: string;
      readonly exit_status: number;
      readonly output: string;
    }
  | { readonly kind: 'guard_observation'; readonly node: string; readonly changed: boolean }
  | { readonly kind: 'deadline_expiry'; readonly node: string }
  | {
      readonly kind: 'operator_action';
      readonly action: 'resume' | 'stop';
      readonly extra_rounds?: number;
      readonly guard_resolution?: 'accept' | 'stop';
    };

export type GuardObservationInput = Extract<ScenarioInput, { kind: 'guard_observation' }>;
export type OperatorActionInput = Extract<ScenarioInput, { kind: 'operator_action' }>;

/**
 * Pull for the inputs the runtime itself has no business interpreting: the read-only guard is the
 * engine's diff check and operator actions are user decisions. They share the runtime's single
 * ordered cursor so the whole stream is consumed in order, and stay usable while an agent
 * observation is pending — which is what `stop-mid-turn` needs.
 *
 * A request that does not match the head of the stream returns `undefined` and leaves the cursor
 * where it was. Nothing searches ahead.
 */
export interface ScenarioDriver {
  /** The next unconsumed input, without consuming it. */
  peek(): ScenarioInput | undefined;
  /** Consume the head only if it is a guard observation. */
  nextGuardObservation(): GuardObservationInput | undefined;
  /** Consume the head only if it is an operator action. */
  nextOperatorAction(): OperatorActionInput | undefined;
  /** How many inputs remain unconsumed. */
  remaining(): number;
  /**
   * Release results the stream can now satisfy.
   *
   * Consuming a guard observation or an operator action closes a boundary that stays closed until
   * this is called. While it is closed no result reaches any observer — including one registered
   * after the consumption — so the caller can act on the input, asynchronously if it likes, before
   * a later runtime result lands. Without that boundary a `stop` would be overtaken by the very
   * result it was meant to pre-empt.
   */
  release(): void;
}

/** What the fake was asked to do, in order. Tests count real submissions with this. */
export type CallRecord =
  | {
      readonly call: 'promptAgent';
      readonly turnId: TurnId;
      readonly pane: PaneId;
      readonly prompt: string;
      /** Recorded exactly as supplied, so tests can check the initial budget. */
      readonly deadline: DeadlineEpochMs;
    }
  | {
      readonly call: 'observeAgentTurn';
      readonly turnId: TurnId;
      readonly deadline: DeadlineEpochMs;
    }
  | { readonly call: 'readAgentOutput'; readonly turnId: TurnId }
  | { readonly call: 'shutdown' };

export interface FakeRuntimeConfig {
  /** The scenario's ordered inputs, kept whole. Entries for other node types are never removed. */
  readonly inputs: readonly ScenarioInput[];
  /**
   * Which scenario node each pane stands for. Explicit on purpose: `AgentHandle.name` is optional,
   * and an agent adopted after a startup timeout has none, so node identity is never inferred
   * from it.
   */
  readonly panes: Readonly<Record<string, string>>;
}

interface TurnState {
  readonly turnId: TurnId;
  readonly node: string;
  /**
   * A submission cancelled before dispatch. Its identity is kept so observing it reports
   * `cancelled` rather than `unknown_turn`, but it never occupies its node and never consumes a
   * scripted answer: nothing was delivered to the agent.
   */
  readonly undispatched?: boolean;
  settledText?: string;
}

type Waiter = {
  readonly turnId: TurnId;
  readonly node: string;
  /** Resolves at most once and detaches its abort listener, whatever ends the observation. */
  readonly settle: (o: AgentObservation) => void;
};

export type FakeAgentRuntime = Pick<
  RuntimeAdapter,
  'promptAgent' | 'observeAgentTurn' | 'readAgentOutput' | 'shutdown'
> &
  ScenarioDriver & {
    /** Every call made against this fake, in order. */
    readonly history: readonly CallRecord[];
  };

export function createFakeRuntime(config: FakeRuntimeConfig): FakeAgentRuntime {
  const inputs = [...config.inputs];
  let cursor = 0;
  let nextId = 0;
  let closed = false;
  const turns = new Map<string, TurnState>();
  /** The one turn each node is currently running. Only its observers may consume that node's results. */
  const activeTurn = new Map<string, TurnId>();
  const waiters: Waiter[] = [];
  const history: CallRecord[] = [];
  /** Closed by a driver consumption, reopened only by `release()`. See ScenarioDriver.release. */
  let released = true;

  const head = (): ScenarioInput | undefined => inputs[cursor];
  const nodeOf = (pane: PaneId): string | undefined => config.panes[pane];

  /** Resolve any waiter the current head now satisfies. Consumes at most one input per pass. */
  /**
   * Release at most one input per iteration to the observers of the node's **active** turn.
   *
   * Matching on node alone is not enough: a later turn on the same node would otherwise consume an
   * earlier turn's scripted answer. Every observer of the active turn settles from the *same*
   * consumed input, so two observers of one turn never draw two results.
   */
  const pump = (): void => {
    if (!released) return;
    for (;;) {
      const next = head();
      if (next === undefined) return;
      if (next.kind !== 'agent_result' && next.kind !== 'deadline_expiry') return;
      const active = activeTurn.get(next.node);
      if (active === undefined) return;
      const matched = waiters.filter((w) => w.turnId === active);
      if (matched.length === 0) return;
      for (const w of matched) waiters.splice(waiters.indexOf(w), 1);
      cursor += 1;
      const turn = turns.get(active);
      let observation: AgentObservation;
      if (next.kind === 'deadline_expiry') {
        observation = { kind: 'timed_out', turnId: active };
      } else if (next.result === 'settled') {
        if (turn) turn.settledText = next.text;
        activeTurn.delete(next.node);
        observation = { kind: 'settled', turnId: active, text: next.text };
      } else {
        observation = {
          kind: next.result === 'blocked' ? 'blocked' : 'unconfirmed',
          turnId: active,
          detail: `scripted ${next.result} for ${next.node}`,
        };
      }
      for (const w of matched) w.settle(observation);
    }
  };

  return {
    history,

    peek: () => head(),
    remaining: () => inputs.length - cursor,
    // Neither of these pumps; both close the boundary. See ScenarioDriver.release.
    nextGuardObservation: () => {
      const next = head();
      if (next?.kind !== 'guard_observation') return undefined;
      cursor += 1;
      released = false;
      return next;
    },
    nextOperatorAction: () => {
      const next = head();
      if (next?.kind !== 'operator_action') return undefined;
      cursor += 1;
      released = false;
      return next;
    },
    release: () => {
      released = true;
      pump();
    },

    promptAgent(
      agent: AgentHandle,
      prompt: string,
      deadline: DeadlineEpochMs,
      signal?: AbortSignal,
    ) {
      const turnId = `turn-${++nextId}` as TurnId;
      const node = nodeOf(agent.pane);
      history.push({ call: 'promptAgent', turnId, pane: agent.pane, prompt, deadline });
      // An agent runs one turn at a time. An overlapping submission is refused rather than queued,
      // which would otherwise let a second turn consume the first turn's scripted answer.
      const busy = node !== undefined && activeTurn.has(node);
      const cancelled = closed || signal?.aborted === true;
      if (node !== undefined) {
        // Registration order matters: a submission cancelled before dispatch keeps its identity but
        // leaves the node free, so the next valid prompt is accepted and gets its own answer.
        if (cancelled) turns.set(turnId, { turnId, node, undispatched: true });
        else if (!busy) {
          turns.set(turnId, { turnId, node });
          activeTurn.set(node, turnId);
        }
      }
      const outcome = cancelled
        ? { kind: 'cancelled' as const }
        : node === undefined
          ? { kind: 'unconfirmed' as const, detail: `pane ${agent.pane} is not bound to a node` }
          : busy
            ? {
                kind: 'unconfirmed' as const,
                detail: `node ${node} has an unsettled turn; overlapping submissions are unsupported`,
              }
            : { kind: 'accepted' as const };
      const submission: AgentSubmission = { turnId, submitted: Promise.resolve(outcome) };
      return submission;
    },

    observeAgentTurn(turnId: TurnId, deadline: DeadlineEpochMs, signal?: AbortSignal) {
      history.push({ call: 'observeAgentTurn', turnId, deadline });
      const turn = turns.get(turnId);
      if (turn === undefined) {
        return Promise.resolve<AgentObservation>({
          kind: 'unrecoverable',
          turnId,
          reason: 'unknown_turn',
        });
      }
      if (closed || signal?.aborted || turn.undispatched)
        return Promise.resolve<AgentObservation>({ kind: 'cancelled', turnId });
      // A settled turn replays, so a resumed run recovers its answer without another submission.
      if (turn.settledText !== undefined) {
        return Promise.resolve<AgentObservation>({
          kind: 'settled',
          turnId,
          text: turn.settledText,
        });
      }
      return new Promise<AgentObservation>((resolve) => {
        let done = false;
        // One settle path for every ending — result, timeout, abort, shutdown — so the abort
        // listener is always detached and a waiter can never resolve twice.
        const onAbort = () => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
          settle({ kind: 'cancelled', turnId });
        };
        const settle = (o: AgentObservation): void => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(o);
        };
        const waiter: Waiter = { turnId, node: turn.node, settle };
        waiters.push(waiter);
        signal?.addEventListener('abort', onAbort);
        pump();
      });
    },

    readAgentOutput(turnId: TurnId) {
      history.push({ call: 'readAgentOutput', turnId });
      const turn = turns.get(turnId);
      if (turn === undefined) {
        return Promise.resolve<AgentOutput>({
          kind: 'unavailable',
          turnId,
          reason: 'unknown_turn',
        });
      }
      if (turn.settledText === undefined) {
        return Promise.resolve<AgentOutput>({ kind: 'unavailable', turnId, reason: 'not_settled' });
      }
      return Promise.resolve<AgentOutput>({ kind: 'available', turnId, text: turn.settledText });
    },

    shutdown() {
      history.push({ call: 'shutdown' });
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.pop() as Waiter;
        waiter.settle({ kind: 'cancelled', turnId: waiter.turnId });
      }
      return Promise.resolve();
    },
  };
}
