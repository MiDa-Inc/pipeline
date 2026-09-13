import { KIND_LABEL, type NodeSettings, type PipelineNode } from './data';

interface Props {
  node: PipelineNode | undefined;
  onChange: (id: string, patch: Partial<NodeSettings>) => void;
}

/** Edits live in the App's component state only. Nothing is persisted or validated. */
export function Inspector({ node, onChange }: Props) {
  if (!node) {
    return (
      <aside className="inspector" aria-label="Node inspector">
        <p className="inspector__empty">Select a node on the canvas to edit its settings.</p>
      </aside>
    );
  }
  const s = node.settings;
  const set = (patch: Partial<NodeSettings>) => onChange(node.id, patch);

  return (
    <aside className="inspector" aria-label={`Settings for ${node.id}`}>
      <header className="inspector__head">
        <span className="inspector__kind">{KIND_LABEL[node.kind]}</span>
        <h2>{node.id}</h2>
      </header>

      {node.kind === 'agent' && (
        <>
          <label>
            Profile
            <input value={s.profile ?? ''} onChange={(e) => set({ profile: e.target.value })} />
          </label>
          <label>
            Permission
            <select
              value={s.permission ?? 'edit'}
              onChange={(e) => set({ permission: e.target.value as 'edit' | 'read-only' })}
            >
              <option value="edit">edit</option>
              <option value="read-only">read-only</option>
            </select>
          </label>
          <label className="inspector__check">
            <input
              type="checkbox"
              checked={s.verdict ?? false}
              onChange={(e) => set({ verdict: e.target.checked })}
            />
            Requires a verdict (approve / revise)
          </label>
          <label>
            Role
            <textarea
              rows={4}
              value={s.role ?? ''}
              onChange={(e) => set({ role: e.target.value })}
            />
          </label>
        </>
      )}

      {node.kind === 'gate' && (
        <>
          <label>
            Command
            <input value={s.run ?? ''} onChange={(e) => set({ run: e.target.value })} />
          </label>
          <label>
            Timeout
            <input value={s.timeout ?? ''} onChange={(e) => set({ timeout: e.target.value })} />
          </label>
        </>
      )}

      {node.kind === 'end' && (
        <p className="inspector__empty">
          An end node has no settings and no outgoing ports. Reaching it finishes the run.
        </p>
      )}
    </aside>
  );
}
