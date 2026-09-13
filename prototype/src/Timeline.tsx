import { HANDOFFS, type RunEvent, type RunStatus } from './data';

interface Props {
  events: RunEvent[];
  status: RunStatus;
  openHandoff: string | undefined;
  onOpenHandoff: (path: string | undefined) => void;
}

const describe = (e: RunEvent): string => {
  if (e.type === 'run_started') return 'run started';
  if (e.type === 'run_finished') return `run finished — ${e.status}`;
  if (e.type === 'node_finished') return `${e.node} → ${e.outcome}`;
  if (e.type === 'escalated') return `${e.node} escalated — ${e.reason}`;
  if (e.type === 'handoff_written') return `handoff written`;
  if (e.type === 'resumed') return `${e.node} resumed`;
  return `${e.node} started`;
};

export function Timeline({ events, status, openHandoff, onOpenHandoff }: Props) {
  return (
    <section className="timeline" aria-label="Run timeline">
      <header className="timeline__head">
        <h2>Timeline</h2>
        <span className={`pill pill--${status}`}>{status}</span>
      </header>

      <ol className="timeline__list">
        {events.map((e, i) => (
          <li key={i} className={`ev ev--${e.type}`}>
            <span className="ev__round">{e.round ? `r${e.round}` : ''}</span>
            {e.type === 'handoff_written' && e.path ? (
              <button
                type="button"
                className="ev__handoff"
                aria-expanded={openHandoff === e.path}
                onClick={() => onOpenHandoff(openHandoff === e.path ? undefined : e.path)}
              >
                handoff · {e.path.split('/').pop()}
              </button>
            ) : (
              <span className="ev__text">{describe(e)}</span>
            )}
          </li>
        ))}
        {events.length === 0 && (
          <li className="ev ev--empty">Press Run to start the simulation.</li>
        )}
      </ol>

      {openHandoff && (
        <figure className="handoff">
          <figcaption>
            {openHandoff}
            <button
              type="button"
              onClick={() => onOpenHandoff(undefined)}
              aria-label="Close handoff"
            >
              ✕
            </button>
          </figcaption>
          <pre>{HANDOFFS[openHandoff] ?? '(no sample text for this handoff)'}</pre>
        </figure>
      )}
    </section>
  );
}
