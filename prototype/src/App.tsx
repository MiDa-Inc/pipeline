import { useEffect, useMemo, useState } from 'react';
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

import {
  EDGES,
  MAX_ROUNDS,
  NODES,
  PIPELINE_NAME,
  RUNS,
  type NodeSettings,
  type RunEvent,
  type RunKey,
  type RunStatus,
} from './data';
import { EscalationBanner } from './EscalationBanner';
import { Inspector } from './Inspector';
import { PipelineNode, type PipelineNodeData } from './PipelineNode';
import { Timeline } from './Timeline';

const STEP_MS = 900;
const STOPPED: RunEvent = { type: 'run_finished', status: 'stopped' };

const nodeTypes = { pipeline: PipelineNode };

const subtitleOf = (s: NodeSettings): string =>
  s.run ?? [s.profile, s.permission].filter(Boolean).join(' · ') ?? '';

export function App() {
  const [nodes, setNodes] = useState(NODES);
  const [selectedId, setSelectedId] = useState<string | undefined>('reviewer');
  const [mode, setMode] = useState<'design' | 'run'>('design');
  const [runKey, setRunKey] = useState<RunKey>('approve');
  const [step, setStep] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [openHandoff, setOpenHandoff] = useState<string | undefined>();

  const script = RUNS[runKey].events;
  const events = stopped ? [...script.slice(0, step), STOPPED] : script.slice(0, step);
  const last = events[events.length - 1];

  const status: RunStatus = stopped
    ? 'stopped'
    : last?.type === 'run_finished'
      ? 'done'
      : last?.type === 'escalated'
        ? 'paused'
        : step > 0
          ? 'running'
          : 'running';

  // The simulation advances on a timer and halts on its own at an escalation.
  useEffect(() => {
    if (mode !== 'run' || status !== 'running' || step >= script.length) return;
    const id = setTimeout(() => setStep((s) => s + 1), step === 0 ? 250 : STEP_MS);
    return () => clearTimeout(id);
  }, [mode, status, step, script.length]);

  const round = [...events].reverse().find((e) => e.round)?.round ?? 1;
  // The node the run is sitting on. Kept highlighted while paused too, so an escalation is
  // locatable on the canvas rather than only in the timeline.
  const currentNode = [...events].reverse().find((e) => e.type === 'node_started')?.node;
  const activeNode = status === 'running' || status === 'paused' ? currentNode : undefined;
  // Derive from node_started, not node_finished: an end node emits node_started then run_finished
  // and never a node_finished (docs/SPEC.md section 3), so it would otherwise stay dimmed.
  const visited = new Set(
    events.filter((e) => e.type === 'node_started' && e.node !== activeNode).map((e) => e.node),
  );

  const startRun = (key: RunKey) => {
    setRunKey(key);
    setMode('run');
    setStep(0);
    setStopped(false);
    setOpenHandoff(undefined);
  };

  const flowNodes: Node<PipelineNodeData>[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: 'pipeline',
        position: n.position,
        selected: n.id === selectedId,
        data: {
          label: n.id,
          kind: n.kind,
          subtitle: subtitleOf(n.settings),
          runState:
            mode !== 'run'
              ? undefined
              : n.id === activeNode
                ? status === 'paused'
                  ? 'paused'
                  : 'active'
                : visited.has(n.id)
                  ? 'visited'
                  : 'pending',
        },
      })),
    [nodes, selectedId, mode, activeNode, visited, status],
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

        <div className="modes" role="group" aria-label="Mode">
          <button type="button" aria-pressed={mode === 'design'} onClick={() => setMode('design')}>
            Design
          </button>
          <button type="button" aria-pressed={mode === 'run'} onClick={() => startRun(runKey)}>
            Run
          </button>
        </div>

        {mode === 'run' && (
          <>
            <span className="topbar__run">
              round {round} · <span className={`pill pill--${status}`}>{status}</span>
            </span>
            <button type="button" className="btn" onClick={() => startRun('approve')}>
              Replay: approve
            </button>
            <button type="button" className="btn" onClick={() => startRun('blocked')}>
              Replay: escalation
            </button>
          </>
        )}
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

      {mode === 'run' ? (
        <Timeline
          events={events}
          status={status}
          openHandoff={openHandoff}
          onOpenHandoff={setOpenHandoff}
        />
      ) : (
        <Inspector node={nodes.find((n) => n.id === selectedId)} onChange={updateSettings} />
      )}

      {mode === 'run' && status === 'paused' && last?.type === 'escalated' && (
        <EscalationBanner
          reason={last.reason ?? 'unknown'}
          node={last.node ?? ''}
          onResume={() => setStep((s) => s + 1)}
          onStop={() => setStopped(true)}
        />
      )}
    </div>
  );
}
