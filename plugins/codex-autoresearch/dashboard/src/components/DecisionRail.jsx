import { STATUS_LABELS, TONES } from "../constants.js";

export function DecisionRail({ readout, viewModel, mode }) {
  const action = viewModel.nextBestAction || {};
  const chips = evidenceChipsFor(viewModel, action, readout);
  const suspiciousWarning = suspiciousPerfectMessage(viewModel.researchTruth || {});
  const railItems = readout.recentRuns.length
    ? readout.recentRuns.map((run) => ({
      id: `#${run.run}`,
      title: STATUS_LABELS[run.status] || run.status || "Run",
      detail: run.description || "No description",
      tone: TONES[run.status] || "neutral",
    }))
    : [{ id: "Start", title: "No decisions yet", detail: "Capture a baseline packet.", tone: "neutral" }];
  return (
    <section className={`decision-panel tone-${action.tone || "focus"}`} id="decision-rail" tabIndex="-1">
      <div className="decision-copy">
        <p className="eyebrow">{action.priority || "Next move"}</p>
        <h2 id="next-action-title">{readout.nextAction ? "Next action" : action.title || "Choose next hypothesis"}</h2>
        <p id="next-action-detail" className="next-action-text">{readout.nextAction || action.detail || "Add ASI next_action_hint to make the next session obvious."}</p>
        <div className="evidence-chips" id="decision-evidence-chips" aria-label="Decision evidence">
          {chips.map((chip) => (
            <span className={`evidence-chip ${chip.tone || "neutral"}`} key={`${chip.label}-${chip.value}`}>
              <strong>{chip.label}</strong>
              <em>{chip.value}</em>
            </span>
          ))}
        </div>
        <p className="form-error decision-warning" id="decision-suspicious-perfect" role="alert" hidden={!suspiciousWarning}>
          {suspiciousWarning}
        </p>
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

function suspiciousPerfectMessage(truth) {
  const defaultMessage = "Suspicious-perfect check: verify freshness, evidence breadth, and promotion proof before treating this round as complete.";
  const suspiciousReason = toList(truth.suspiciousReasons || truth.suspicious_reasons)[0];
  if (suspiciousReason) return suspiciousReason;
  if (typeof truth.suspiciousPerfectWarning === "string" && truth.suspiciousPerfectWarning.trim()) {
    return truth.suspiciousPerfectWarning;
  }
  if (typeof truth.suspiciousPerfect === "string" && truth.suspiciousPerfect.trim()) {
    return truth.suspiciousPerfect;
  }
  if (truth.suspiciousPerfect && typeof truth.suspiciousPerfect === "object") {
    return truth.suspiciousPerfect.message || truth.suspiciousPerfect.detail || defaultMessage;
  }
  return truth.suspiciousPerfect ? defaultMessage : "";
}

function evidenceChipsFor(viewModel, action, readout) {
  const modeled = Array.isArray(viewModel.evidenceChips) ? viewModel.evidenceChips : [];
  const actionModeled = Array.isArray(action.evidenceChips) ? action.evidenceChips : [];
  const chips = [...modeled, ...actionModeled].map((item) => ({
    label: item.label || item.title || item.kind || "Evidence",
    value: item.value || item.detail || item.text || item.message || "",
    tone: item.tone || item.state || "neutral",
  })).filter((item) => item.value);
  if (chips.length) return chips.slice(0, 4);
  const explanation = action.explanation || {};
  return [
    explanation.evidence && { label: "Evidence", value: explanation.evidence, tone: "good" },
    explanation.avoids && { label: "Avoids", value: explanation.avoids, tone: "warn" },
    explanation.proof && { label: "Proof", value: explanation.proof, tone: "neutral" },
    readout.confidenceText && { label: "Confidence", value: readout.confidenceText, tone: "neutral" },
  ].filter(Boolean).slice(0, 4);
}

function toList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => typeof item === "object" ? String(item.message || item.code || item.title || "") : String(item || ""))
    .filter(Boolean);
}
