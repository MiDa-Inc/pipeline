import { Handle, Position, type NodeProps } from '@xyflow/react';

import { KIND_LABEL, type NodeKind } from './data';

export interface PipelineNodeData extends Record<string, unknown> {
  label: string;
  kind: NodeKind;
  subtitle: string;
  runState?: 'active' | 'paused' | 'visited' | 'pending' | undefined;
}

/**
 * Four handles so the two loop-back edges can leave and enter along the bottom
 * instead of cutting through the row of nodes.
 */
export function PipelineNode({ data, selected }: NodeProps & { data: PipelineNodeData }) {
  return (
    <div
      className={`node node--${data.kind}`}
      data-selected={selected || undefined}
      data-run={data.runState}
    >
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="target" position={Position.Bottom} id="loop-in" />
      <span className="node__kind">{KIND_LABEL[data.kind]}</span>
      <span className="node__name">{data.label}</span>
      <span className="node__subtitle">{data.subtitle}</span>
      <Handle type="source" position={Position.Right} id="out" />
      <Handle type="source" position={Position.Bottom} id="loop-out" />
    </div>
  );
}
