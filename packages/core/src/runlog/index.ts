export type {
  EscalationReason,
  EventEnvelope,
  EventPayload,
  EventType,
  NodeName,
  NodeOutcome,
  PipelineEvent,
  Round,
  TerminalStatus,
} from './events.js';
export type {
  DamagedTail,
  HandoffEvent,
  LogBytes,
  ReadResult,
  RunLog,
  RunLogFault,
  RunLogOptions,
  RunPaths,
} from './log.js';
export { createRunFolder, openRunLog, readEvents, RunLogError, runPaths } from './log.js';

// The handoff file primitives stay internal; only the error a caller can catch from
// RunLog.writeHandoff is part of the package's surface.
export type { HandoffFault } from './handoff.js';
export { HandoffError } from './handoff.js';

export type { Escalation, HandoffRecord, OpenEntry, RunState, RunStatus } from './state.js';
export { replay, ReplayError } from './state.js';
