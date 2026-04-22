import { actionLabel, fallbackAiSummary } from "../model.js";

export function CodexBrief({ session, viewModel }) {
  const summary = viewModel.aiSummary || fallbackAiSummary(session, viewModel);
  const source = summary.source
    || (summary.generatedFrom?.latestRun ? `latest #${summary.generatedFrom.latestRun} / dashboard state` : "dashboard state");
  return (
    <section className="panel brief-panel" aria-label="Codex brief">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Codex brief</p>
          <h2 id="ai-summary-title">{summary.title}</h2>
        </div>
      </div>
      <div id="ai-summary-happened" className="brief-lines">
        {(summary.happened || []).map((item) => <span key={item}>{item}</span>)}
      </div>
      <div id="ai-summary-plan" className="brief-plan">
        {(summary.plan || []).map((item) => <p key={item}>{item}</p>)}
      </div>
      <p className="source-line" id="ai-summary-source">{source}</p>
    </section>
  );
}

export function StrategyMemory({ viewModel }) {
  const memory = viewModel.experimentMemory || {};
  const lanes = Array.isArray(memory.lanePortfolio) ? memory.lanePortfolio.slice(0, 4) : [];
  return (
    <section className="panel memory-panel" aria-label="Strategy memory">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Strategy memory</p>
          <h2>Experiment portfolio</h2>
        </div>
        <span className="panel-note">{memory.plateau?.detected ? "Plateau detected" : "No plateau"}</span>
      </div>
      <div className="memory-list">
        {lanes.length ? lanes.map((lane) => (
          <div className="memory-lane" key={lane.id || lane.title}>
            <strong>{lane.title || lane.id || "Lane"}</strong>
            <span>{lane.status || "tracking"}</span>
            <p>{lane.nextActionHint || lane.recommendation || "Use ASI to choose the next measured hypothesis."}</p>
          </div>
        )) : <div className="empty">No strategy lanes embedded in this export.</div>}
      </div>
    </section>
  );
}

export function QualityGapPanel({ viewModel }) {
  const gap = viewModel.qualityGap || null;
  const title = gap ? `${gap.open ?? 0} open / ${gap.total ?? 0} total` : "No quality gap file";
  const detail = gap
    ? (Number(gap.open) === 0 && Number(gap.total) > 0
      ? `Accepted gaps closed. ${gap.roundGuidance?.requiredRefresh || "Start a fresh research round before declaring the domain permanently complete."}`
      : `${gap.slug || "research"} has ${gap.open ?? 0} open accepted gap${Number(gap.open) === 1 ? "" : "s"}.`)
    : "Run a project study or gap-candidates pass to create a measurable quality checklist.";
  return (
    <section className="panel gap-panel" aria-label="Quality gap">
      <p className="eyebrow">Quality gap</p>
      <h2 id="quality-gap-title">{title}</h2>
      <p id="quality-gap-detail">{detail}</p>
    </section>
  );
}

export function LiveActions({ mode, runLiveAction }) {
  const actions = ["doctor", "setup-plan", "guide", "recipes", "gap-candidates", "finalize-preview", "export"];
  return (
    <section className="panel live-actions-panel" id="live-actions-panel" aria-label="Live actions" hidden={!mode.liveActions}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">Live actions</p>
          <h2>Guarded tools</h2>
        </div>
        <span id="action-note" className="panel-note">{mode.actionNote}</span>
      </div>
      <div className="action-grid" id="action-grid">
        {actions.map((action) => (
          <button className="tool-button live-action" type="button" key={action} data-action={action} onClick={() => runLiveAction(action)}>
            {actionLabel(action)}
          </button>
        ))}
      </div>
    </section>
  );
}
