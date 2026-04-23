import { actionLabel, fallbackAiSummary, formatDisplayTime } from "../model.js";

export function TrustStrip({ mode, meta, viewModel }) {
  const trust = viewModel.trustState || viewModel.trust || meta.trustState || {};
  const warnings = [
    ...toList(trust.reasons),
    ...toList(trust.warnings),
    ...toList(viewModel.trustWarnings),
    ...toList(viewModel.warnings),
  ].slice(0, 2);
  const generated = trust.generatedAt || meta.generatedAt || "";
  const modeLabel = trust.modeLabel || trustModeLabel(trust.mode, mode);
  const detail = trust.detail || trust.summary || mode.detail;
  const actionState = trust.actionState || trust.actions || (mode.liveActions
    ? "Guarded local actions are enabled."
    : "No usable live mutation controls are exposed.");
  const evidenceState = trust.evidenceState || trust.evidence || (viewModel.summary?.runs
    ? `${viewModel.summary.runs} run${viewModel.summary.runs === 1 ? "" : "s"} embedded.`
    : "No run evidence embedded yet.");
  return (
    <section className={`trust-strip ${mode.liveActions ? "trust-live" : "trust-static"}`} id="trust-strip" aria-label="Dashboard trust state" tabIndex="-1">
      <div>
        <p className="eyebrow">Trust state</p>
        <h2 id="trust-title">{modeLabel}</h2>
        <p id="trust-detail">{detail}</p>
      </div>
      <div className="trust-cells" id="trust-cells">
        <TrustCell label="Actions" value={actionState} />
        <TrustCell label="Evidence" value={evidenceState} />
        <TrustCell label="Generated" value={generated ? formatDisplayTime(generated) : "embedded snapshot"} />
      </div>
      <div className="trust-warning-list" id="trust-warnings" hidden={!warnings.length}>
        {warnings.map((warning) => <span key={warning}>{warning}</span>)}
      </div>
    </section>
  );
}

function trustModeLabel(value, mode) {
  const key = String(value || "").toLowerCase();
  if (key === "static-export" || key === "static" || key === "snapshot") return "Static read-only export";
  if (key === "live-server" || key === "live") return "Live local runboard";
  return mode.liveActions ? "Live local runboard" : "Static read-only export";
}

function TrustCell({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ResearchTruthMeter({ viewModel }) {
  const gap = viewModel.qualityGap || {};
  const truth = viewModel.researchTruth || viewModel.truthMeter || {};
  const open = numeric(truth.open ?? gap.open);
  const closed = numeric(truth.closed ?? gap.closed);
  const total = numeric(truth.total ?? gap.total);
  const score = truth.score ?? truth.percent ?? (Number.isFinite(total) && total > 0
    ? (Number.isFinite(open) ? Math.max(0, total - open) / total : closed / total)
    : null);
  const percent = normalizePercent(score);
  const label = truth.label || truth.title || (percent == null ? "Research state unknown" : `${percent}% accepted checklist closed`);
  const detail = truth.detail || truth.summary || (Number.isFinite(total) && total > 0
    ? `${Number.isFinite(open) ? open : 0} open / ${total} total accepted gap${total === 1 ? "" : "s"}.`
    : "No accepted research checklist is embedded in this snapshot.");
  const suspiciousReason = toList(truth.suspiciousReasons || truth.suspicious_reasons)[0] || "";
  const suspiciousWarning = suspiciousPerfectMessage(truth, suspiciousReason || (Number.isFinite(open) && open === 0 && Number.isFinite(total) && total > 0
    ? "Suspicious-perfect check: quality_gap=0 closes the accepted checklist for this round; rerun discovery before calling the product complete."
    : ""));
  return (
    <section className="panel truth-panel" id="research-truth-meter" aria-label="Research truth meter" tabIndex="-1">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Research truth</p>
          <h2 id="research-truth-title">{label}</h2>
        </div>
        <span className="panel-note">{truth.source || gap.slug || "dashboard state"}</span>
      </div>
      <div
        className="truth-meter"
        id="research-truth-bar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent == null ? undefined : percent}
        aria-valuetext={percent == null ? `${label}: unknown progress` : label}
      >
        <span style={{ width: `${percent ?? 0}%` }} />
      </div>
      <p className="truth-detail" id="research-truth-detail">{detail}</p>
      <p className="form-error truth-warning" id="suspicious-perfect-warning" role="alert" hidden={!suspiciousWarning}>
        {suspiciousWarning}
      </p>
    </section>
  );
}

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

export function FinalizationChecklist({ viewModel }) {
  const checklist = normalizeChecklist(viewModel.finalizationChecklist || viewModel.finalizePreview?.checklist, viewModel.finalizePreview);
  return (
    <section className="panel finalize-panel" id="finalization-checklist" aria-label="Finalization checklist" tabIndex="-1">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Finalization</p>
          <h2 id="finalization-checklist-title">{checklist.title}</h2>
        </div>
        <span className="panel-note">{checklist.ready ? "Preview ready" : "Preview gated"}</span>
      </div>
      <div className="checklist" id="finalization-checklist-items">
        {checklist.items.map((item) => (
          <div className={`checklist-item ${item.state}`} key={item.id || item.label}>
            <span aria-hidden="true">{item.state === "done" ? "OK" : item.state === "blocked" ? "!" : "..."}</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function LiveActions({ mode, runLiveAction }) {
  const actions = [
    { id: "doctor", detail: "Check setup and benchmark health." },
    { id: "setup-plan", detail: "Inspect setup guidance." },
    { id: "guide", detail: "Open the guided next step." },
    { id: "recipes", detail: "Preview recipe ideas." },
    { id: "gap-candidates", detail: "Preview research gap candidates." },
    { id: "finalize-preview", detail: "Read-only finalization preview." },
    { id: "export", detail: "Write a static dashboard snapshot." },
  ];
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
          <button className="tool-button live-action" type="button" key={action.id} data-action={action.id} title={action.detail} onClick={() => runLiveAction(action.id)}>
            <span>{actionLabel(action.id)}</span>
            <small>{action.detail}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function normalizeChecklist(source, finalizePreview = {}) {
  const rawItems = Array.isArray(source?.items) ? source.items : Array.isArray(source) ? source : [];
  const ready = Boolean(source?.ready ?? finalizePreview?.ready);
  const warnings = toList(source?.warnings).concat(toList(finalizePreview?.warnings));
  const items = rawItems.length ? rawItems.map((item, index) => ({
    id: item.id || `check-${index}`,
    label: item.label || item.title || `Check ${index + 1}`,
    detail: item.detail || item.message || item.reason || "Review this finalization prerequisite.",
    state: normalizeState(item.state || item.status || (item.complete ? "done" : "idle")),
  })) : [
    {
      id: "kept-evidence",
      label: "Kept evidence",
      detail: finalizePreview?.ready ? "Finalize preview found reviewable kept work." : "Keep at least one evidenced run before packaging review branches.",
      state: finalizePreview?.ready ? "done" : "idle",
    },
    {
      id: "warnings",
      label: "Warnings",
      detail: warnings.length ? warnings[0] : "No finalization warnings embedded.",
      state: warnings.length ? "blocked" : "done",
    },
    {
      id: "preview",
      label: "Preview only",
      detail: finalizePreview?.nextAction || "Dashboard exposes finalize-preview only; branch creation stays outside this UI.",
      state: ready ? "done" : "idle",
    },
  ];
  return {
    title: source?.title || (ready ? "Review packet can be previewed" : "Review packet needs evidence"),
    ready,
    items,
  };
}

function normalizeState(value) {
  const key = String(value || "").toLowerCase();
  if (["done", "pass", "passed", "ok", "complete", "ready"].includes(key)) return "done";
  if (["blocked", "fail", "failed", "error", "warn", "warning"].includes(key)) return "blocked";
  return "idle";
}

function toList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => typeof item === "object" ? String(item.message || item.code || item.title || "") : String(item || ""))
    .filter(Boolean);
}

function numeric(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePercent(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const percent = number <= 1 ? number * 100 : number;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function suspiciousPerfectMessage(truth, fallback) {
  const defaultMessage = fallback || "Suspicious-perfect check: verify freshness, evidence breadth, and promotion proof before treating this round as complete.";
  if (typeof truth.suspiciousPerfectWarning === "string" && truth.suspiciousPerfectWarning.trim()) {
    return truth.suspiciousPerfectWarning;
  }
  if (typeof truth.suspiciousPerfect === "string" && truth.suspiciousPerfect.trim()) {
    return truth.suspiciousPerfect;
  }
  if (truth.suspiciousPerfect && typeof truth.suspiciousPerfect === "object") {
    return truth.suspiciousPerfect.message || truth.suspiciousPerfect.detail || defaultMessage;
  }
  return truth.suspiciousPerfect ? defaultMessage : fallback;
}
