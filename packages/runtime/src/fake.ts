import type {
  AgentHandle,
  AgentInspection,
  AgentObservation,
  AgentOutput,
  AgentSubmission,
  DeadlineEpochMs,
  ExecutionId,
  LaunchResult,
  LayoutSpec,
  PaneId,
  ProcessLaunch,
  ProcessObservation,
  ProcessSpec,
  RuntimeAdapter,
  SubmissionOutcome,
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

/**
 * How a configured pane answers {@link RuntimeAdapter.launchAgent}. Absent means `ready`.
 *
 * `startup_unconfirmed` is the orphan case from docs/herdr-notes.md: nothing is registered, so the
 * pane is later adopted through {@link RuntimeAdapter.inspectAgent} with no name.
 */
export type LaunchScript =
  | { readonly kind: 'ready' }
  | { readonly kind: 'not_ready'; readonly detail: string }
  | { readonly kind: 'startup_unconfirmed'; readonly detail: string };

/**
 * One scripted answer from {@link RuntimeAdapter.inspectAgent}, and equally the state a pane is
 * left in. Entries are consumed one per call; once a pane's queue runs out, inspection reports the
 * state the pane was last *observed* in rather than deriving a fresh one.
 *
 * `timed_out` is the exception: an inspection that failed to conclude claims nothing about the
 * pane, so it is reported without disturbing the held state.
 */
export type InspectionScript =
  | { readonly kind: 'ready' }
  | { readonly kind: 'working' }
  | { readonly kind: 'not_ready'; readonly detail: string }
  | { readonly kind: 'state_unknown'; readonly detail: string }
  | { readonly kind: 'no_agent' }
  | { readonly kind: 'unknown_pane' }
  | { readonly kind: 'timed_out' };

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
  | {
      /** The whole spec is kept: workspace id, cwd, split target and direction are all targeting. */
      readonly call: 'createLayout';
      readonly pane: PaneId;
      readonly spec: LayoutSpec;
    }
  | {
      readonly call: 'launchAgent';
      readonly pane: PaneId;
      readonly profile: string;
      readonly deadline: DeadlineEpochMs;
    }
  | { readonly call: 'inspectAgent'; readonly pane: PaneId; readonly deadline: DeadlineEpochMs }
  | {
      readonly call: 'startProcess';
      readonly executionId: ExecutionId;
      readonly node: string;
      readonly command: string;
      readonly cwd: string;
      readonly deadline: DeadlineEpochMs;
    }
  | {
      readonly call: 'observeProcess';
      readonly executionId: ExecutionId;
      readonly deadline: DeadlineEpochMs;
    }
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
  /**
   * The panes `createLayout` hands out, in call order. Defaults to the keys of `panes`.
   *
   * The fake invents no pane ids and never reads node identity from `LayoutSpec.label`: `panes`
   * stays the single binding authority, and this only says which of those panes is returned when.
   */
  readonly layout?: readonly string[];
  /** How each pane answers `launchAgent`. A pane with no entry launches `ready`. */
  readonly launches?: Readonly<Record<string, LaunchScript>>;
  /** Per-pane queues of scripted `inspectAgent` answers. See {@link InspectionScript}. */
  readonly inspections?: Readonly<Record<string, readonly InspectionScript[]>>;
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

/** One gate execution. `node` is the identity: command and cwd may repeat across gate nodes. */
interface ExecutionState {
  readonly executionId: ExecutionId;
  readonly node: string;
  /** Cancelled before dispatch: never ran, never occupies its node. See {@link TurnState}. */
  readonly undispatched?: boolean;
  result?: { readonly exitStatus: number; readonly output: string };
}

type ProcessWaiter = {
  readonly executionId: ExecutionId;
  readonly settle: (o: ProcessObservation) => void;
};

/** The complete adapter surface, so conformance is a compile-time fact rather than a claim. */
export type FakeAgentRuntime = RuntimeAdapter &
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
  const executions = new Map<string, ExecutionState>();
  /** The one execution each gate node is currently running, on the same terms as `activeTurn`. */
  const activeExecution = new Map<string, ExecutionId>();
  const processWaiters: ProcessWaiter[] = [];
  let nextExecution = 0;
  const history: CallRecord[] = [];
  /** Closed by a driver consumption, reopened only by `release()`. See ScenarioDriver.release. */
  let released = true;
  const layoutPanes = config.layout ?? Object.keys(config.panes);
  layoutPanes.forEach((pane, index) => {
    if (config.panes[pane] === undefined)
      throw new Error(`layout[${index}] pane ${pane} is not bound to a node in panes`);
    if (layoutPanes.indexOf(pane) !== index)
      throw new Error(`layout[${index}] repeats pane ${pane}; createLayout hands out each once`);
  });
  let layoutCursor = 0;
  /** Names the runtime assigned. A pane whose start was never confirmed has none, by design. */
  const names = new Map<string, string>();
  let nextAgent = 0;
  const inspections = new Map<string, InspectionScript[]>(
    Object.entries(config.inspections ?? {}).map(([pane, queue]) => [pane, [...queue]]),
  );
  /**
   * What each pane was last observed to be. A bound pane starts `ready` — that is the premise of
   * binding it — and nothing else moves it: no inspection infers a transition the fake was never
   * told about, so `blocked` stays `not_ready` and an unconfirmed start stays unestablished.
   *
   * `unestablished` is internal and is never an {@link AgentInspection}. An unconfirmed start
   * establishes neither recognition nor startup, so it cannot be reported as `state_unknown`,
   * which per the adapter means a *recognised* agent of undetermined readiness. Until a scripted
   * inspection says what is actually there, inspecting concludes nothing.
   */
  const paneState = new Map<string, InspectionScript | { readonly kind: 'unestablished' }>();
  const panesOfNode = new Map<string, string[]>();
  for (const [pane, node] of Object.entries(config.panes))
    panesOfNode.set(node, [...(panesOfNode.get(node) ?? []), pane]);
  const observeNode = (node: string, state: InspectionScript): void => {
    for (const pane of panesOfNode.get(node) ?? []) paneState.set(pane, state);
  };

  const head = (): ScenarioInput | undefined => inputs[cursor];
  const nodeOf = (pane: PaneId): string | undefined => config.panes[pane];
  /** `name` is omitted, never empty, when no start was confirmed for this pane. */
  const handleFor = (pane: PaneId): AgentHandle => {
    const name = names.get(pane);
    return name === undefined ? { pane } : { pane, name };
  };

  /** Resolve any waiter the current head now satisfies. Consumes at most one input per pass. */
  /**
   * Release at most one input per iteration to the observers of the node's **active** turn.
   *
   * Matching on node alone is not enough: a later turn on the same node would otherwise consume an
   * earlier turn's scripted answer. Every observer of the active turn settles from the *same*
   * consumed input, so two observers of one turn never draw two results.
   */
  /**
   * What a node currently has in flight, across both kinds of work.
   *
   * A node runs one operation at a time, and never one of each: `deadline_expiry` carries only a
   * node, so an overlapping turn and gate execution would make it ambiguous which of them a
   * scripted timeout belongs to. Refusing the second keeps that routing well defined.
   */
  const occupiedBy = (node: string): 'turn' | 'gate execution' | undefined =>
    activeTurn.has(node) ? 'turn' : activeExecution.has(node) ? 'gate execution' : undefined;

  const releaseTurn = (
    next: Extract<ScenarioInput, { kind: 'agent_result' | 'deadline_expiry' }>,
  ): boolean => {
    const active = activeTurn.get(next.node);
    if (active === undefined) return false;
    const matched = waiters.filter((w) => w.turnId === active);
    if (matched.length === 0) return false;
    for (const w of matched) waiters.splice(waiters.indexOf(w), 1);
    cursor += 1;
    const turn = turns.get(active);
    let observation: AgentObservation;
    if (next.kind === 'deadline_expiry') {
      // The turn's deadline passed, so readiness is undetermined — not a settled pane, and not
      // an inspection timeout, which is about the inspection rather than the agent.
      observeNode(next.node, { kind: 'state_unknown', detail: 'the turn deadline passed' });
      observation = { kind: 'timed_out', turnId: active };
    } else if (next.result === 'settled') {
      if (turn) turn.settledText = next.text;
      activeTurn.delete(next.node);
      observeNode(next.node, { kind: 'ready' });
      observation = { kind: 'settled', turnId: active, text: next.text };
    } else {
      const detail = `scripted ${next.result} for ${next.node}`;
      // A blocked turn is an agent waiting at a dialog; an unconfirmed one is uncertainty.
      // Neither is an agent quietly working, and neither resolves itself.
      observeNode(
        next.node,
        next.result === 'blocked'
          ? { kind: 'not_ready', detail }
          : { kind: 'state_unknown', detail },
      );
      observation = {
        kind: next.result === 'blocked' ? 'blocked' : 'unconfirmed',
        turnId: active,
        detail,
      };
    }
    for (const w of matched) w.settle(observation);
    return true;
  };

  /**
   * Release a gate result to the observers of the node's **active** execution, on exactly the terms
   * `releaseTurn` uses: bound by execution rather than by node, so a later execution on the same
   * gate node cannot take an earlier one's result, and every observer of one execution settles from
   * the same consumed input.
   */
  const releaseGate = (
    next: Extract<ScenarioInput, { kind: 'gate_result' | 'deadline_expiry' }>,
  ): boolean => {
    const active = activeExecution.get(next.node);
    if (active === undefined) return false;
    const matched = processWaiters.filter((w) => w.executionId === active);
    if (matched.length === 0) return false;
    for (const w of matched) processWaiters.splice(processWaiters.indexOf(w), 1);
    cursor += 1;
    let observation: ProcessObservation;
    if (next.kind === 'deadline_expiry') {
      // No exit status is invented: SPEC R7 routes on it, and a timeout is not a failure.
      observation = { kind: 'timed_out', executionId: active };
    } else {
      const result = { exitStatus: next.exit_status, output: next.output };
      const execution = executions.get(active);
      if (execution) execution.result = result;
      activeExecution.delete(next.node);
      observation = { kind: 'completed', executionId: active, ...result };
    }
    for (const w of matched) w.settle(observation);
    return true;
  };

  /** Release at most one input per iteration, to whichever work the node has in flight. */
  const pump = (): void => {
    if (!released) return;
    for (;;) {
      const next = head();
      if (next === undefined) return;
      if (next.kind === 'agent_result') {
        if (!releaseTurn(next)) return;
      } else if (next.kind === 'gate_result') {
        if (!releaseGate(next)) return;
      } else if (next.kind === 'deadline_expiry') {
        // A node is either an agent or a gate, so at most one of these has anything to release.
        if (!(activeTurn.has(next.node) ? releaseTurn(next) : releaseGate(next))) return;
      } else return;
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

    /**
     * Hand out the next configured pane. Creates nothing and consumes no scenario input: layout is
     * configuration, not script, so the ordered cursor is untouched.
     */
    createLayout(spec: LayoutSpec) {
      if (closed) return Promise.reject(new Error('createLayout after shutdown'));
      const target = spec.destination;
      if (target.kind === 'split' && nodeOf(target.pane) === undefined)
        return Promise.reject(new Error(`cannot split unknown pane ${target.pane}`));
      const pane = layoutPanes[layoutCursor] as PaneId | undefined;
      if (pane === undefined)
        return Promise.reject(
          new Error(`no pane configured for createLayout call ${layoutCursor + 1}`),
        );
      layoutCursor += 1;
      // Snapshot, nested destination included: a caller that reuses and mutates one spec object
      // must not rewrite the record of the calls it already made.
      history.push({ call: 'createLayout', pane, spec: { ...spec, destination: { ...target } } });
      return Promise.resolve(pane);
    },

    launchAgent(pane: PaneId, profile: string, deadline: DeadlineEpochMs) {
      history.push({ call: 'launchAgent', pane, profile, deadline });
      const unconfirmed = (detail: string): Promise<LaunchResult> => {
        // Whether anything launched is unknown, and inspecting does not make it known.
        paneState.set(pane, { kind: 'unestablished' });
        return Promise.resolve({ kind: 'startup_unconfirmed', pane, detail });
      };
      if (closed) return unconfirmed('the runtime was shut down before readiness was established');
      if (nodeOf(pane) === undefined) return unconfirmed(`pane ${pane} is not bound to a node`);
      const scripted = config.launches?.[pane] ?? { kind: 'ready' as const };
      if (scripted.kind === 'startup_unconfirmed') return unconfirmed(scripted.detail);
      // Only a confirmed start registers a name; an unconfirmed one leaves the agent adoptable
      // by pane alone, which is why AgentHandle.name is optional.
      if (!names.has(pane)) names.set(pane, `agent-${++nextAgent}`);
      const agent = handleFor(pane);
      if (scripted.kind === 'not_ready') {
        // The dialog stays until something explicitly clears it; inspecting is not that something.
        paneState.set(pane, { kind: 'not_ready', detail: scripted.detail });
        return Promise.resolve<LaunchResult>({ kind: 'not_ready', agent, detail: scripted.detail });
      }
      paneState.set(pane, { kind: 'ready' });
      return Promise.resolve<LaunchResult>({ kind: 'ready', agent });
    },

    /**
     * Report what a pane holds. Launches nothing, consumes no scenario input, and invents no
     * transition: it reports the state the pane was last observed in, or the next scripted answer.
     */
    inspectAgent(pane: PaneId, deadline: DeadlineEpochMs, signal?: AbortSignal) {
      history.push({ call: 'inspectAgent', pane, deadline });
      if (closed || signal?.aborted)
        return Promise.resolve<AgentInspection>({ kind: 'cancelled', pane });
      const node = nodeOf(pane);
      if (node === undefined)
        return Promise.resolve<AgentInspection>({ kind: 'unknown_pane', pane });
      const scripted = inspections.get(pane)?.shift();
      // A scripted answer is itself an explicit transition, except an inspection timeout, which
      // concludes nothing and so leaves the pane where it was.
      if (scripted !== undefined && scripted.kind !== 'timed_out') paneState.set(pane, scripted);
      const state = scripted ?? paneState.get(pane) ?? { kind: 'ready' as const };
      switch (state.kind) {
        case 'not_ready':
        case 'state_unknown':
          return Promise.resolve<AgentInspection>({
            kind: state.kind,
            agent: handleFor(pane),
            detail: state.detail,
          });
        case 'ready':
        case 'working':
          return Promise.resolve<AgentInspection>({ kind: state.kind, agent: handleFor(pane) });
        case 'unestablished':
          // Nothing is known and nothing is claimed: the inspection simply did not conclude.
          // A scripted entry is what establishes ready, state_unknown or no_agent from here.
          return Promise.resolve<AgentInspection>({ kind: 'timed_out', pane });
        default:
          return Promise.resolve<AgentInspection>({ kind: state.kind, pane });
      }
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
      // A node runs one operation at a time. An overlapping submission is refused rather than
      // queued, which would otherwise let a second turn consume the first turn's scripted answer.
      const occupied = node === undefined ? undefined : occupiedBy(node);
      const busy = occupied !== undefined;
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
                detail: `node ${node} already has an unsettled ${occupied}; one operation per node`,
              }
            : { kind: 'accepted' as const };
      if (outcome.kind === 'accepted' && node !== undefined) observeNode(node, { kind: 'working' });
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

    /**
     * Start a gate. Synchronous and identity-first, like `promptAgent`, and bound to `spec.node`:
     * two gate nodes sharing a command and working directory stay distinct.
     */
    startProcess(
      spec: ProcessSpec,
      deadline: DeadlineEpochMs,
      signal?: AbortSignal,
    ): ProcessLaunch {
      const executionId = `exec-${++nextExecution}` as ExecutionId;
      history.push({
        call: 'startProcess',
        executionId,
        node: spec.node,
        command: spec.command,
        cwd: spec.cwd,
        deadline,
      });
      const occupied = occupiedBy(spec.node);
      const busy = occupied !== undefined;
      const cancelled = closed || signal?.aborted === true;
      // A launch cancelled before dispatch keeps its identity but never occupies the node, so the
      // next valid launch is accepted and takes its own result.
      if (cancelled)
        executions.set(executionId, { executionId, node: spec.node, undispatched: true });
      else if (!busy) {
        executions.set(executionId, { executionId, node: spec.node });
        activeExecution.set(spec.node, executionId);
      }
      const outcome: SubmissionOutcome = cancelled
        ? { kind: 'cancelled' }
        : busy
          ? {
              kind: 'unconfirmed',
              detail: `node ${spec.node} already has an unsettled ${occupied}; one operation per node`,
            }
          : { kind: 'accepted' };
      return { executionId, started: Promise.resolve(outcome) };
    },

    observeProcess(executionId: ExecutionId, deadline: DeadlineEpochMs, signal?: AbortSignal) {
      history.push({ call: 'observeProcess', executionId, deadline });
      const execution = executions.get(executionId);
      if (execution === undefined) {
        return Promise.resolve<ProcessObservation>({
          kind: 'unrecoverable',
          executionId,
          reason: 'unknown_execution',
        });
      }
      if (signal?.aborted)
        return Promise.resolve<ProcessObservation>({ kind: 'cancelled', executionId });
      // Retained and replayed, so a paused run recovers a gate result without rerunning the gate.
      // Ahead of `closed` deliberately: what shutdown ends is waiting, not memory. A caller after
      // shutdown can still collect a result this runtime is holding — it just cannot install a new
      // wait for one that has not arrived, which is the case below.
      const retained = execution.result;
      if (retained !== undefined)
        return Promise.resolve<ProcessObservation>({ kind: 'completed', executionId, ...retained });
      if (closed || execution.undispatched)
        return Promise.resolve<ProcessObservation>({ kind: 'cancelled', executionId });
      return new Promise<ProcessObservation>((resolve) => {
        let done = false;
        const onAbort = () => {
          const i = processWaiters.indexOf(waiter);
          if (i !== -1) processWaiters.splice(i, 1);
          settle({ kind: 'cancelled', executionId });
        };
        const settle = (o: ProcessObservation): void => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(o);
        };
        const waiter: ProcessWaiter = { executionId, settle };
        processWaiters.push(waiter);
        signal?.addEventListener('abort', onAbort);
        pump();
      });
    },

    shutdown() {
      history.push({ call: 'shutdown' });
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.pop() as Waiter;
        waiter.settle({ kind: 'cancelled', turnId: waiter.turnId });
      }
      while (processWaiters.length > 0) {
        const waiter = processWaiters.pop() as ProcessWaiter;
        waiter.settle({ kind: 'cancelled', executionId: waiter.executionId });
      }
      return Promise.resolve();
    },
  };
}
