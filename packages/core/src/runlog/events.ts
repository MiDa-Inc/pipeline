/**
 * The seven event types of `events.jsonl`, mirroring `spec/events.schema.json` and SPEC section 3.
 *
 * Field names are the wire names, snake_case included: these objects are serialised verbatim, and a
 * separate presentation shape would be one more place for the log format to drift from its schema.
 */

/** Matches `nodeName` in the schema: a pipeline node identifier. */
export type NodeName = string;

/** 1-based, as in the schema. */
export type Round = number;

export type NodeOutcome = 'done' | 'approve' | 'revise' | 'pass' | 'fail';

export type EscalationReason =
  'blocked' | 'timeout' | 'missing_verdict' | 'max_rounds' | 'guard_violation' | 'unrouted';

/** A run reaches exactly one of these, and only through `run_finished`. */
export type TerminalStatus = 'done' | 'stopped';

/**
 * What a caller supplies. `run_id`, `seq` and `ts` are the log's to assign — `seq` must be gapless
 * and strictly increasing, which only the appender can guarantee.
 */
export type EventPayload =
  | { readonly type: 'run_started'; readonly pipeline: string; readonly task: string }
  | { readonly type: 'node_started'; readonly node: NodeName; readonly round: Round }
  | {
      readonly type: 'handoff_written';
      readonly node: NodeName;
      readonly round: Round;
      /** Relative to the run folder. Never absolute, never escaping it (SPEC section 3). */
      readonly path: string;
    }
  | {
      readonly type: 'node_finished';
      readonly node: NodeName;
      readonly round: Round;
      readonly outcome: NodeOutcome;
    }
  | {
      readonly type: 'escalated';
      readonly node: NodeName;
      readonly round: Round;
      readonly reason: EscalationReason;
    }
  | {
      /** `extra_rounds` is present only when the resume granted rounds (SPEC R12). */
      readonly type: 'resumed';
      readonly node: NodeName;
      readonly round: Round;
      readonly extra_rounds?: number;
    }
  | { readonly type: 'run_finished'; readonly status: TerminalStatus };

export type EventType = EventPayload['type'];

/** Common fields every event carries. `ts` and `run_id` are excluded from determinism (SPEC R15). */
export interface EventEnvelope {
  readonly run_id: string;
  readonly seq: number;
  readonly ts: string;
}

export type PipelineEvent = EventEnvelope & EventPayload;
