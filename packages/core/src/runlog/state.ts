import type { EscalationReason, NodeName, PipelineEvent, Round, TerminalStatus } from './events.js';

/**
 * The projection of a run log onto the state it describes.
 *
 * Every field is a fact the events carry. Nothing is inferred from the rules that produced them:
 * the pending entry R3 retains after a refused `max_rounds` is **not** here, because the escalation
 * records the stored round rather than the refused candidate, and recovering the candidate means
 * applying R3 rather than reading the log. Runtime identities, deadlines and guard baselines are
 * absent for the same reason — the engine owns them, and no event states them.
 *
 * Replay is pure. It cannot tell whether its input is a whole log or the valid prefix of a damaged
 * one; that distinction lives with the reader, which reports it as `ReadResult.complete`.
 */

/** A node entry that has begun and not yet ended. Survives escalation and resume. */
export interface OpenEntry {
  readonly node: NodeName;
  readonly round: Round;
}

/** Why the run is paused, and where. Present exactly while `status` is `paused`. */
export interface Escalation {
  readonly node: NodeName;
  readonly round: Round;
  readonly reason: EscalationReason;
}

export interface HandoffRecord {
  readonly node: NodeName;
  readonly round: Round;
  readonly path: string;
}

export type RunStatus = 'running' | 'paused' | TerminalStatus;

export interface RunState {
  /** Absent until `run_started`: an empty log establishes no run lifecycle state at all. */
  readonly runId?: string;
  readonly pipeline?: string;
  readonly task?: string;
  readonly status?: RunStatus;
  /** The `seq` of the last event, 0 for an empty log. */
  readonly lastSeq: number;
  readonly eventCount: number;
  /** The `ts` of the last event. */
  readonly updatedAt?: string;
  /** The latest explicitly recorded round. Absent until a round-bearing event appears. */
  readonly round?: Round;
  readonly openEntry?: OpenEntry;
  readonly escalation?: Escalation;
  /** The running total of every grant in the log (SPEC R12: grants accumulate). */
  readonly extraRoundsGranted: number;
  /** In emission order, carrying the producing node (SPEC section 3). */
  readonly handoffs: readonly HandoffRecord[];
}

/** A stream that cannot be projected honestly. Raised instead of returning a partial state. */
export class ReplayError extends Error {
  constructor(
    readonly position: number,
    readonly seq: number,
    detail: string,
  ) {
    super(`event ${position} (seq ${seq}): ${detail}`);
    this.name = 'ReplayError';
  }
}

/**
 * Project events onto a {@link RunState}.
 *
 * An unfinished prefix is valid input: an open entry, a paused run, and a granted `resumed` that
 * precedes its `node_started` all project cleanly. What is rejected is a stream that contradicts
 * SPEC section 3 — a broken sequence, a second run, an event after `run_finished`, a `resumed` with
 * nothing to resume, or an entry event outside an entry.
 */
export function replay(events: readonly PipelineEvent[]): RunState {
  let runId: string | undefined;
  let pipeline: string | undefined;
  let task: string | undefined;
  let status: RunStatus | undefined;
  let updatedAt: string | undefined;
  let round: Round | undefined;
  let openEntry: OpenEntry | undefined;
  let escalation: Escalation | undefined;
  let extraRoundsGranted = 0;
  let lastSeq = 0;
  let finished = false;
  /**
   * Set only by the event immediately before the current one, and only when that was a
   * `node_finished`. `unrouted` is emitted straight after the outcome it could not route, so a
   * finish from earlier in the run must not be able to justify one later.
   */
  let justFinished: OpenEntry | undefined;
  const handoffs: HandoffRecord[] = [];

  events.forEach((event, index) => {
    const reject = (detail: string): ReplayError => new ReplayError(index + 1, event.seq, detail);
    if (event.seq !== index + 1)
      throw reject(`seq ${event.seq} breaks the sequence at ${index + 1}`);
    if (finished) throw reject(`${event.type} follows run_finished, which ends the log`);
    if (index === 0 && event.type !== 'run_started')
      throw reject(`a run log opens with run_started, not ${event.type}`);
    if (index > 0 && event.type === 'run_started') throw reject('run_started occurs once');
    if (runId !== undefined && event.run_id !== runId)
      throw reject(`run_id ${event.run_id} does not match ${runId}`);
    // A paused run progresses only by being resumed or stopped. Without this, a later entry would
    // silently inherit the escalation belonging to the entry that paused the run.
    if (escalation !== undefined && event.type !== 'resumed' && event.type !== 'run_finished')
      throw reject(
        `${event.type} while the run is paused at ${escalation.node} round ${escalation.round}`,
      );

    // Consumed by this event alone. Only `node_finished` sets it again, at the end of the switch.
    const precededByFinish = justFinished;
    justFinished = undefined;

    /** Entry events name the entry they belong to; taking the open one on trust loses ownership. */
    const owns = (node: NodeName, round: Round): boolean =>
      openEntry !== undefined && openEntry.node === node && openEntry.round === round;
    const mismatch = (): string =>
      openEntry === undefined
        ? 'no entry is open'
        : `the open entry is ${openEntry.node} round ${openEntry.round}`;

    switch (event.type) {
      case 'run_started':
        runId = event.run_id;
        pipeline = event.pipeline;
        task = event.task;
        status = 'running';
        break;
      case 'node_started':
        if (openEntry !== undefined)
          throw reject(
            `node_started for ${event.node} round ${event.round} while ${openEntry.node} round ${openEntry.round} is still open`,
          );
        round = event.round;
        openEntry = { node: event.node, round: event.round };
        break;
      case 'handoff_written':
        if (!owns(event.node, event.round))
          throw reject(`handoff_written for ${event.node} round ${event.round}, but ${mismatch()}`);
        handoffs.push({ node: event.node, round: event.round, path: event.path });
        break;
      case 'node_finished':
        if (!owns(event.node, event.round))
          throw reject(`node_finished for ${event.node} round ${event.round}, but ${mismatch()}`);
        round = event.round;
        justFinished = openEntry;
        openEntry = undefined; // an entry ends at its own terminator
        break;
      case 'escalated':
        // Three shapes, all from SPEC section 3. A refused max-round entry was never accepted, so
        // nothing may be open; `unrouted` follows the node_finished whose outcome would not route;
        // every other reason interrupts the entry it names, which stays open for a resume.
        if (event.reason === 'max_rounds') {
          if (openEntry !== undefined)
            throw reject(
              `max_rounds refuses an entry, but ${openEntry.node} round ${openEntry.round} is open`,
            );
        } else if (event.reason === 'unrouted') {
          // Immediately after its own node_finished, which also means no entry can be open.
          if (precededByFinish?.node !== event.node || precededByFinish.round !== event.round)
            throw reject(
              `unrouted for ${event.node} round ${event.round} does not directly follow its node_finished`,
            );
        } else if (!owns(event.node, event.round)) {
          throw reject(
            `escalated ${event.reason} for ${event.node} round ${event.round}, but ${mismatch()}`,
          );
        }
        round = event.round;
        escalation = { node: event.node, round: event.round, reason: event.reason };
        status = 'paused';
        break;
      case 'resumed':
        if (escalation === undefined) throw reject('resumed with no escalation to resume');
        // SPEC R12: `unrouted` is a pipeline defect, not a pause to be resumed, and a max-round
        // resume exists only to carry a grant. Both are recorded facts, not reconstructions.
        if (escalation.reason === 'unrouted') throw reject('an unrouted run cannot be resumed');
        if (escalation.reason === 'max_rounds' && event.extra_rounds === undefined)
          throw reject('resuming max_rounds requires a grant of extra rounds');
        if (escalation.node !== event.node)
          throw reject(`resumed ${event.node}, but the run is paused at ${escalation.node}`);
        // A max-round grant accepts the candidate round, so it legitimately differs from the
        // stored round the escalation recorded. Every other resume continues the same entry.
        if (escalation.reason !== 'max_rounds' && escalation.round !== event.round)
          throw reject(
            `resumed ${event.node} round ${event.round}, but the escalation is at round ${escalation.round}`,
          );
        // A grant carries the newly accepted round, and precedes the node_started that uses it.
        round = event.round;
        extraRoundsGranted += event.extra_rounds ?? 0;
        escalation = undefined;
        status = 'running';
        break;
      case 'run_finished':
        status = event.status;
        openEntry = undefined;
        escalation = undefined;
        finished = true;
        break;
    }
    lastSeq = event.seq;
    updatedAt = event.ts;
  });

  return {
    lastSeq,
    eventCount: events.length,
    extraRoundsGranted,
    handoffs,
    ...(runId !== undefined && { runId }),
    ...(pipeline !== undefined && { pipeline }),
    ...(task !== undefined && { task }),
    ...(status !== undefined && { status }),
    ...(updatedAt !== undefined && { updatedAt }),
    ...(round !== undefined && { round }),
    ...(openEntry !== undefined && { openEntry }),
    ...(escalation !== undefined && { escalation }),
  };
}
