import { useMemo, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { EDGES, MAX_ROUNDS, NODES, PIPELINE_NAME, type NodeSettings } from './data';
import { Inspector } from './Inspector';
import { PipelineNode, type PipelineNodeData } from './PipelineNode';

const nodeTypes = { pipeline: PipelineNode };

const subtitleOf = (s: NodeSettings): string =>
  s.run ?? [s.profile, s.permission].filter(Boolean).join(' · ') ?? '';

export function App() {
  const [nodes, setNodes] = useState(NODES);
  const [selectedId, setSelectedId] = useState<string | undefined>('reviewer');

  const flowNodes: Node<PipelineNodeData>[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: 'pipeline',
        position: n.position,
        selected: n.id === selectedId,
        data: { label: n.id, kind: n.kind, subtitle: subtitleOf(n.settings) },
      })),
    [nodes, selectedId],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      EDGES.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        sourceHandle: e.back ? 'loop-out' : 'out',
        targetHandle: e.back ? 'loop-in' : 'in',
        type: e.back ? 'smoothstep' : 'default',
        className: e.back ? 'edge edge--back' : 'edge',
        pathOptions: e.back ? { offset: e.back, borderRadius: 8 } : undefined,
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
      })),
    [],
  );

  const onNodeClick: NodeMouseHandler = (_event, node) => setSelectedId(node.id);

  /**
   * `nodes` is controlled, so React Flow reports changes here instead of applying them. Selection
   * arrives through this callback when the user picks a node with the keyboard, which is why
   * onNodeClick alone leaves the inspector stale.
   *
   * Dragging is switched off (`nodesDraggable={false}`) rather than handled: the prototype has no
   * persistence, so a moved node would snap back on reload. Layout comes from data.ts.
   */
  const onNodesChange = (changes: NodeChange<Node<PipelineNodeData>>[]) => {
    const selects = changes.filter((c) => c.type === 'select');
    if (selects.length === 0) return;

    // One batch can deselect the old node and select the new one, so a selection anywhere in the
    // batch wins. Only when the batch is deselections alone does the inspector close.
    const picked = selects.find((c) => c.selected);
    if (picked) {
      setSelectedId(picked.id);
      return;
    }
    setSelectedId((current) =>
      current !== undefined && selects.some((c) => c.id === current) ? undefined : current,
    );
  };

  const updateSettings = (id: string, patch: Partial<NodeSettings>) =>
    setNodes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, settings: { ...n.settings, ...patch } } : n)),
    );

  return (
    <div className="app">
      <header className="topbar">
        <h1>{PIPELINE_NAME}</h1>
        <span className="topbar__meta">
          {nodes.length} nodes · {EDGES.length} edges · max_rounds {MAX_ROUNDS}
        </span>
      </header>

      <main className="canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onNodesChange={onNodesChange}
          nodesDraggable={false}
          onPaneClick={() => setSelectedId(undefined)}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </main>

      <Inspector node={nodes.find((n) => n.id === selectedId)} onChange={updateSettings} />
    </div>
  );
}
