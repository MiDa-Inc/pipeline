/**
 * Hard-coded stand-in for spec/pipelines/reference.yaml. The prototype never reads a file or
 * talks to a server; this is the only source of pipeline data.
 */
export type NodeKind = 'agent' | 'gate' | 'end';

export interface NodeSettings {
  profile?: string;
  permission?: 'edit' | 'read-only';
  verdict?: boolean;
  role?: string;
  run?: string;
  timeout?: string;
}

export interface PipelineNode {
  id: string;
  kind: NodeKind;
  position: { x: number; y: number };
  settings: NodeSettings;
}

export const PIPELINE_NAME = 'feature-loop';
export const MAX_ROUNDS = 5;

export const NODES: PipelineNode[] = [
  {
    id: 'implementer',
    kind: 'agent',
    position: { x: 40, y: 150 },
    settings: {
      profile: 'claude-code',
      permission: 'edit',
      verdict: false,
      role: 'You implement the task. Write code and tests. Stop when finished. Never commit.',
    },
  },
  {
    id: 'test_gate',
    kind: 'gate',
    position: { x: 330, y: 150 },
    settings: { run: 'npm test', timeout: '10m' },
  },
  {
    id: 'reviewer',
    kind: 'agent',
    position: { x: 620, y: 150 },
    settings: {
      profile: 'codex',
      permission: 'read-only',
      verdict: true,
      role: 'You review the current diff against the task. Never edit files.',
    },
  },
  { id: 'done', kind: 'end', position: { x: 910, y: 150 }, settings: {} },
];

/** Five edges. `back` is 0 for forward edges, or the lane depth for an edge looping back. */
export const EDGES = [
  { id: 'e1', source: 'implementer', target: 'test_gate', label: 'done', back: 0 },
  { id: 'e2', source: 'test_gate', target: 'reviewer', label: 'pass', back: 0 },
  { id: 'e3', source: 'reviewer', target: 'done', label: 'approve', back: 0 },
  { id: 'e4', source: 'test_gate', target: 'implementer', label: 'fail', back: 30 },
  { id: 'e5', source: 'reviewer', target: 'implementer', label: 'revise', back: 80 },
];

export const KIND_LABEL: Record<NodeKind, string> = {
  agent: 'Agent',
  gate: 'Gate',
  end: 'End',
};

/* ---------------------------------------------------------------------------
 * Simulated runs. The sequences below mirror the golden scenarios in
 * spec/scenarios/, so what the prototype shows agrees with docs/SPEC.md.
 * run_id, seq and ts are omitted: this is a display model, not a run log.
 * ------------------------------------------------------------------------- */
export type RunStatus = 'running' | 'paused' | 'done' | 'stopped';

export interface RunEvent {
  type:
    | 'run_started'
    | 'node_started'
    | 'handoff_written'
    | 'node_finished'
    | 'escalated'
    | 'resumed'
    | 'run_finished';
  node?: string;
  round?: number;
  outcome?: string;
  reason?: string;
  path?: string;
  status?: 'done' | 'stopped';
}

/** spec/scenarios/approve-round-1.yaml */
const APPROVE: RunEvent[] = [
  { type: 'run_started' },
  { type: 'node_started', node: 'implementer', round: 1 },
  { type: 'node_finished', node: 'implementer', round: 1, outcome: 'done' },
  { type: 'node_started', node: 'test_gate', round: 1 },
  { type: 'handoff_written', node: 'test_gate', round: 1, path: 'handoffs/r1-test_gate-1.txt' },
  { type: 'node_finished', node: 'test_gate', round: 1, outcome: 'pass' },
  { type: 'node_started', node: 'reviewer', round: 1 },
  { type: 'node_finished', node: 'reviewer', round: 1, outcome: 'approve' },
  { type: 'node_started', node: 'done', round: 1 },
  { type: 'run_finished', status: 'done' },
];

/** spec/scenarios/resume-after-blocked.yaml — pauses at the escalation until Resume. */
const BLOCKED: RunEvent[] = [
  ...APPROVE.slice(0, 7),
  { type: 'escalated', node: 'reviewer', round: 1, reason: 'blocked' },
  { type: 'resumed', node: 'reviewer', round: 1 },
  { type: 'node_finished', node: 'reviewer', round: 1, outcome: 'approve' },
  { type: 'node_started', node: 'done', round: 1 },
  { type: 'run_finished', status: 'done' },
];

export const RUNS = {
  approve: { label: 'Approve on round 1', events: APPROVE },
  blocked: { label: 'Reviewer blocked, then resume', events: BLOCKED },
};
export type RunKey = keyof typeof RUNS;

/** Sample handoff contents, opened from the timeline. */
export const HANDOFFS: Record<string, string> = {
  'handoffs/r1-test_gate-1.txt':
    '> npm test\n\n  ✓ limits burst size (12ms)\n  ✓ refills the bucket over time (8ms)\n  ✓ rejects over-limit uploads with 429 (5ms)\n\n  12 passing (241ms)\n\nexit status 0',
};
