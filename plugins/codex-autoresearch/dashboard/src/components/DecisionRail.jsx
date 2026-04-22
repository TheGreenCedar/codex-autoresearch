import { STATUS_LABELS, TONES } from "../constants.js";

export function DecisionRail({ readout, viewModel, mode }) {
  const action = viewModel.nextBestAction || {};
  const railItems = readout.recentRuns.length
    ? readout.recentRuns.map((run) => ({
      id: `#${run.run}`,
      title: STATUS_LABELS[run.status] || run.status || "Run",
      detail: run.description || "No description",
      tone: TONES[run.status] || "neutral",
    }))
    : [{ id: "Start", title: "No decisions yet", detail: "Capture a baseline packet.", tone: "neutral" }];
  return (
    <section className={`decision-panel tone-${action.tone || "focus"}`} id="decision-rail">
      <div className="decision-copy">
        <p className="eyebrow">{action.priority || "Next move"}</p>
        <h2 id="next-action-title">{readout.nextAction ? "Next action" : action.title || "Choose next hypothesis"}</h2>
        <p id="next-action-detail" className="next-action-text">{readout.nextAction || action.detail || "Add ASI next_action_hint to make the next session obvious."}</p>
        <div className="readout-facts">
          <span className="readout-label">Best kept change</span>
          <strong id="best-kept-detail">{readout.bestRun?.description || "No kept anchor yet."}</strong>
          <span className="readout-label">Recent failures</span>
          <strong id="recent-failure-detail">{readout.latestFailure?.description || "No recent failure."}</strong>
        </div>
        <div className="decision-meta">
          <span>{action.utilityCopy || readout.confidenceText}</span>
          <span>{mode.liveActions ? "Live actions available" : "Read-only snapshot"}</span>
        </div>
      </div>
      <div className="decision-list" aria-label="Recent decision history">
        {railItems.map((item) => (
          <div className={`decision-item ${item.tone}`} key={`${item.id}-${item.title}`}>
            <span>{item.id}</span>
            <strong>{item.title}</strong>
            <em>{item.detail}</em>
          </div>
        ))}
      </div>
    </section>
  );
}
