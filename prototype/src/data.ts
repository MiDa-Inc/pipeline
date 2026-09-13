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
