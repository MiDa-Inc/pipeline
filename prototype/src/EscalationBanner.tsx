interface Props {
  reason: string;
  node: string;
  onResume: () => void;
  onStop: () => void;
}

/**
 * Shown while the run is paused. Per docs/SPEC.md R12 resume continues observing the same turn
 * without re-prompting, and per R13 stop finalises the run and leaves agent panes running.
 */
export function EscalationBanner({ reason, node, onResume, onStop }: Props) {
  return (
    <div className="banner" role="alert">
      <div className="banner__text">
        <strong>Run paused — {reason}</strong>
        <span>
          {node} needs attention. Resume continues watching the same turn; it does not re-send the
          prompt. Stop ends the run and leaves the agent pane open.
        </span>
      </div>
      <button type="button" className="btn btn--primary" onClick={onResume}>
        Resume
      </button>
      <button type="button" className="btn" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}
