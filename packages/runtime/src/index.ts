/** RuntimeAdapter interface and the fake and herdr runtimes. */
export type {
  AgentHandle,
  AgentInspection,
  AgentObservation,
  AgentOutput,
  AgentSubmission,
  DeadlineEpochMs,
  ExecutionId,
  LaunchResult,
  LayoutDestination,
  LayoutSpec,
  PaneId,
  ProcessLaunch,
  ProcessObservation,
  ProcessSpec,
  RuntimeAdapter,
  SubmissionOutcome,
  TurnId,
} from './adapter.js';

export type {
  CallRecord,
  FakeAgentRuntime,
  FakeRuntimeConfig,
  GuardObservationInput,
  InspectionScript,
  LaunchScript,
  OperatorActionInput,
  ScenarioDriver,
  ScenarioInput,
} from './fake.js';
export { createFakeRuntime } from './fake.js';

export const packageName = '@pipeline/runtime';
