import { useEffect, useMemo, useState } from "react";
import { actionLabel, fallbackMissionControl } from "../model.js";

export function MissionPanel({ viewModel, mode, runLiveAction, actionsById = {}, lastReceipt = null }) {
  const mission = viewModel.missionControl || fallbackMissionControl(viewModel);
  const active = mission.steps?.find((step) => step.id === mission.activeStep) || mission.steps?.[0];
  const canRunLive = mode.liveActions;
  return (
    <section className="panel mission-panel" id="mission-panel" aria-label="Mission control" tabIndex="-1">
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
              <button
                className="tool-button mission-run"
                type="button"
                data-mission-action={step.safeAction}
                aria-describedby={`${step.id || step.safeAction}-disabled-reason`}
                disabled={Boolean(actionsById[step.safeAction]?.pending)}
                onClick={() => runLiveAction(step.safeAction)}
              >
                {actionsById[step.safeAction]?.pending ? "Running..." : actionLabel(step.safeAction)}
              </button>
            )}
            {canRunLive && step.safeAction ? (
              <small className="disabled-reason" id={`${step.id || step.safeAction}-disabled-reason`}>
                {actionsById[step.safeAction]?.pending ? `${actionLabel(step.safeAction)} is already running.` : "Guarded local action; no finalizer mutation."}
              </small>
            ) : null}
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
  const [structuredAsi, setStructuredAsi] = useState(() => structuredAsiFrom(logDecision.asiTemplate));
  const [asi, setAsi] = useState(() => stringifyAsi(logDecision.asiTemplate));
  const [rawDirty, setRawDirty] = useState(false);
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
    setStructuredAsi(structuredAsiFrom(logDecision.asiTemplate));
    setAsi(stringifyAsi(logDecision.asiTemplate));
    setRawDirty(false);
    setError("");
  }, [formKey]);
  useEffect(() => {
    if (lastReceipt?.ok && String(lastReceipt.action || "").startsWith("log-")) {
      setDescription("");
      setStructuredAsi(structuredAsiFrom(logDecision.asiTemplate));
      setAsi(stringifyAsi(logDecision.asiTemplate));
      setRawDirty(false);
      setError("");
    }
  }, [lastReceipt?.receiptId, lastReceipt?.ok, lastReceipt?.action, logDecision.asiTemplate]);
  const liveAvailable = mode.liveActions && available;
  const hidden = !mode.liveActions;
  const updateStructuredAsi = (key, value) => {
    setStructuredAsi((current) => {
      const next = { ...current, [key]: value };
      if (!rawDirty) setAsi(stringifyAsi(cleanAsi(next)));
      return next;
    });
  };
  const submit = async () => {
    const parsed = parseAsi(asi, status, structuredAsi, rawDirty);
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
    <div className="log-decision-panel" id="log-decision-panel" tabIndex="-1">
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
      <fieldset className="asi-structured" id="log-asi-field" hidden={hidden}>
        <legend>ASI</legend>
        <label className="log-field" htmlFor="asi-hypothesis">
          <span>Hypothesis</span>
          <input id="asi-hypothesis" type="text" value={structuredAsi.hypothesis} disabled={!liveAvailable || pending} onChange={(event) => updateStructuredAsi("hypothesis", event.target.value)} />
        </label>
        <label className="log-field" htmlFor="asi-evidence">
          <span>Evidence</span>
          <textarea id="asi-evidence" value={structuredAsi.evidence} disabled={!liveAvailable || pending} onChange={(event) => updateStructuredAsi("evidence", event.target.value)} />
        </label>
        <label className="log-field" htmlFor="asi-rollback-reason">
          <span>Rollback reason</span>
          <input id="asi-rollback-reason" type="text" value={structuredAsi.rollback_reason} disabled={!liveAvailable || pending} onChange={(event) => updateStructuredAsi("rollback_reason", event.target.value)} />
        </label>
        <label className="log-field" htmlFor="asi-next-action-hint">
          <span>Next action hint</span>
          <input id="asi-next-action-hint" type="text" value={structuredAsi.next_action_hint} disabled={!liveAvailable || pending} onChange={(event) => updateStructuredAsi("next_action_hint", event.target.value)} />
        </label>
        <details className="raw-asi-panel">
          <summary>Raw JSON</summary>
          <label htmlFor="log-decision-asi">ASI JSON</label>
          <textarea
            id="log-decision-asi"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "log-decision-error" : undefined}
            value={asi}
            disabled={!liveAvailable || pending}
            onChange={(event) => {
              setRawDirty(true);
              setAsi(event.target.value);
            }}
          />
        </details>
      </fieldset>
      <div className="command-preview" hidden={hidden || !logDecision.commandsByStatus?.[status]}>
        <span>Command preview</span>
        <code>{logDecision.commandsByStatus?.[status]}</code>
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

function parseAsi(text, status, structuredAsi, rawDirty = false) {
  let value;
  try {
    value = JSON.parse(text || "{}");
  } catch (error) {
    return { ok: false, error: `ASI must be valid JSON: ${error.message}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "ASI must be a JSON object." };
  }
  value = rawDirty
    ? cleanAsi(value)
    : { ...value, ...cleanAsi(structuredAsi) };
  const has = (key) => String(value[key] || "").trim().length > 0;
  if (status === "keep" && (!has("hypothesis") || !has("evidence"))) {
    return { ok: false, error: "Keep decisions require ASI hypothesis and evidence." };
  }
  if (status !== "keep" && !has("evidence") && !has("rollback_reason")) {
    return { ok: false, error: "Rejected or failed decisions require ASI evidence or rollback_reason." };
  }
  return { ok: true, value };
}

function structuredAsiFrom(template = {}) {
  return {
    hypothesis: String(template?.hypothesis || ""),
    evidence: String(template?.evidence || ""),
    rollback_reason: String(template?.rollback_reason || template?.rollbackReason || ""),
    next_action_hint: String(template?.next_action_hint || template?.nextAction || template?.next_action || ""),
  };
}

function cleanAsi(value = {}) {
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, typeof item === "string" ? item.trim() : item])
    .filter(([, item]) => item != null && String(item).trim().length > 0));
}

function stringifyAsi(value = {}) {
  return JSON.stringify(cleanAsi(value), null, 2);
}
