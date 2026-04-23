import { useEffect, useMemo, useState } from "react";
import { actionLabel, fallbackMissionControl } from "../model.js";

export function MissionPanel({ viewModel, mode, runLiveAction, actionsById = {}, lastReceipt = null }) {
  const mission = viewModel.missionControl || fallbackMissionControl(viewModel);
  const active = mission.steps?.find((step) => step.id === mission.activeStep) || mission.steps?.[0];
  const canRunLive = mode.liveActions;
  return (
    <section className="panel mission-panel" id="mission-panel" aria-label="Mission control">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Mission control</p>
          <h2>Guided flow</h2>
        </div>
        <span id="mission-note" className="panel-note">{active ? `Active: ${active.title}` : "No active step"}</span>
      </div>
      <div className="mission-grid" id="mission-control-grid">
        {(mission.steps || []).map((step) => (
          <div className={`mission-step ${step.state || "idle"}`} key={step.id || step.title}>
            <span>{step.state || "idle"}</span>
            <strong>{step.title}</strong>
            <p>{step.detail}</p>
            {canRunLive && step.safeAction && (
              <button className="tool-button mission-run" type="button" data-mission-action={step.safeAction} disabled={Boolean(actionsById[step.safeAction]?.pending)} onClick={() => runLiveAction(step.safeAction)}>
                {actionsById[step.safeAction]?.pending ? "Running..." : actionLabel(step.safeAction)}
              </button>
            )}
          </div>
        ))}
      </div>
      <LogDecision mission={mission} mode={mode} runLiveAction={runLiveAction} actionsById={actionsById} lastReceipt={lastReceipt} />
    </section>
  );
}

function LogDecision({ mission, mode, runLiveAction, actionsById, lastReceipt }) {
  const logDecision = mission.logDecision || {};
  const available = Boolean(logDecision.available);
  const statuses = Array.isArray(logDecision.allowedStatuses) && logDecision.allowedStatuses.length
    ? logDecision.allowedStatuses
    : ["keep", "discard"];
  const [status, setStatus] = useState(logDecision.suggestedStatus || statuses[0] || "keep");
  const [description, setDescription] = useState(logDecision.defaultDescription || "");
  const [asi, setAsi] = useState(() => logDecision.asiTemplate ? JSON.stringify(logDecision.asiTemplate, null, 2) : "");
  const [error, setError] = useState("");
  const action = `log-${String(status || "").replaceAll("_", "-")}`;
  const pending = Boolean(actionsById[action]?.pending);
  const packetFingerprint = logDecision.lastRunFingerprint || logDecision.fingerprint || "";
  const formKey = useMemo(() => [
    logDecision.command || "",
    logDecision.suggestedStatus || "",
    packetFingerprint,
  ].join("|"), [logDecision.command, logDecision.suggestedStatus, packetFingerprint]);
  useEffect(() => {
    setStatus(logDecision.suggestedStatus || statuses[0] || "keep");
    setDescription(logDecision.defaultDescription || "");
    setAsi(logDecision.asiTemplate ? JSON.stringify(logDecision.asiTemplate, null, 2) : "");
    setError("");
  }, [formKey]);
  useEffect(() => {
    if (lastReceipt?.ok && String(lastReceipt.action || "").startsWith("log-")) {
      setDescription("");
      setAsi(logDecision.asiTemplate ? JSON.stringify(logDecision.asiTemplate, null, 2) : "");
      setError("");
    }
  }, [lastReceipt?.receiptId, lastReceipt?.ok, lastReceipt?.action, logDecision.asiTemplate]);
  const liveAvailable = mode.liveActions && available;
  const hidden = !mode.liveActions;
  const submit = async () => {
    const parsed = parseAsi(asi, status);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError("");
    const result = await runLiveAction(action, {
      confirm: action,
      lastRunFingerprint: packetFingerprint,
      description,
      asi: parsed.value,
    });
    if (!result?.ok && result?.receipt?.stderrSummary) setError(result.receipt.stderrSummary);
  };
  return (
    <div className="log-decision-panel">
      <div className="log-field" id="log-status-field" hidden={hidden}>
        <label htmlFor="log-decision-status">Status</label>
        <select id="log-decision-status" value={status} disabled={!liveAvailable || pending} onChange={(event) => setStatus(event.target.value)}>
          {statuses.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      <div className="log-field" id="log-description-field" hidden={hidden}>
        <label htmlFor="log-decision-description">Description</label>
        <input id="log-decision-description" type="text" autoComplete="off" value={description} disabled={!liveAvailable || pending} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="log-field" id="log-asi-field" hidden={hidden}>
        <label htmlFor="log-decision-asi">ASI</label>
        <textarea
          id="log-decision-asi"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "log-decision-error" : undefined}
          value={asi}
          disabled={!liveAvailable || pending}
          onChange={(event) => setAsi(event.target.value)}
        />
      </div>
      <p id="log-decision-error" className="form-error" role="alert" hidden={!error}>{error}</p>
      <button
        id="run-log-decision"
        className="tool-button primary"
        type="button"
        hidden={hidden}
        disabled={!liveAvailable || pending}
        onClick={submit}
      >
        {pending ? "Logging..." : "Log decision"}
      </button>
    </div>
  );
}

function parseAsi(text, status) {
  let value;
  try {
    value = JSON.parse(text || "{}");
  } catch (error) {
    return { ok: false, error: `ASI must be valid JSON: ${error.message}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "ASI must be a JSON object." };
  }
  const has = (key) => String(value[key] || "").trim().length > 0;
  if (status === "keep" && (!has("hypothesis") || !has("evidence"))) {
    return { ok: false, error: "Keep decisions require ASI hypothesis and evidence." };
  }
  if (status !== "keep" && !has("evidence") && !has("rollback_reason")) {
    return { ok: false, error: "Rejected or failed decisions require ASI evidence or rollback_reason." };
  }
  return { ok: true, value };
}
