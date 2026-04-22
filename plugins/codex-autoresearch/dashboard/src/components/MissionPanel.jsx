import { useState } from "react";
import { actionLabel, fallbackMissionControl, parseJsonObject } from "../model.js";

export function MissionPanel({ viewModel, mode, runLiveAction }) {
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
              <button className="tool-button mission-run" type="button" data-mission-action={step.safeAction} onClick={() => runLiveAction(step.safeAction)}>
                {actionLabel(step.safeAction)}
              </button>
            )}
          </div>
        ))}
      </div>
      <LogDecision mission={mission} mode={mode} runLiveAction={runLiveAction} />
    </section>
  );
}

function LogDecision({ mission, mode, runLiveAction }) {
  const logDecision = mission.logDecision || {};
  const available = Boolean(logDecision.available);
  const statuses = Array.isArray(logDecision.allowedStatuses) && logDecision.allowedStatuses.length
    ? logDecision.allowedStatuses
    : ["keep", "discard"];
  const [status, setStatus] = useState(logDecision.suggestedStatus || statuses[0] || "keep");
  const [description, setDescription] = useState(logDecision.defaultDescription || "");
  const [asi, setAsi] = useState(() => logDecision.asiTemplate ? JSON.stringify(logDecision.asiTemplate, null, 2) : "");
  const liveAvailable = mode.liveActions && available;
  const hidden = !mode.liveActions;
  return (
    <div className="log-decision-panel">
      <div className="log-field" id="log-status-field" hidden={hidden}>
        <span>Status</span>
        <select id="log-decision-status" aria-label="Log decision status" value={status} disabled={!liveAvailable} onChange={(event) => setStatus(event.target.value)}>
          {statuses.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      <div className="log-field" id="log-description-field" hidden={hidden}>
        <span>Description</span>
        <input id="log-decision-description" type="text" autoComplete="off" aria-label="Log decision description" value={description} disabled={!liveAvailable} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="log-field" id="log-asi-field" hidden={hidden}>
        <span>ASI</span>
        <textarea id="log-decision-asi" aria-label="Log decision ASI JSON" value={asi} disabled={!liveAvailable} onChange={(event) => setAsi(event.target.value)} />
      </div>
      <button
        id="run-log-decision"
        className="tool-button primary"
        type="button"
        hidden={hidden}
        disabled={!liveAvailable}
        onClick={() => runLiveAction(`log-${status.replaceAll("_", "-")}`, {
          confirm: true,
          description,
          asi: parseJsonObject(asi),
        })}
      >
        Log decision
      </button>
    </div>
  );
}
