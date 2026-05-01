import { useEffect, useMemo, useState } from "react";
import { actionLabel, fallbackMissionControl } from "../model";
import type {
  ActionReceipt,
  ActionState,
  DashboardMode,
  DashboardViewModel,
  MissionControlModel,
  MissionStep,
  RunAsi,
} from "../types";

type RunLiveAction = (
  action: string,
  bodyOverride?: Record<string, unknown> | null,
) => Promise<{ ok?: boolean; receipt?: ActionReceipt | null } | undefined>;
type StructuredAsi = ReturnType<typeof structuredAsiFrom>;
type LogDecisionSetters = {
  setAsi: (value: string) => void;
  setError: (value: string) => void;
  setRawDirty: (value: boolean) => void;
  setStructuredAsi: (value: StructuredAsi) => void;
};

export function MissionPanel({
  viewModel,
  mode,
  runLiveAction,
  actionsById = {},
  lastReceipt = null,
}: {
  viewModel: DashboardViewModel;
  mode: DashboardMode;
  runLiveAction: RunLiveAction;
  actionsById?: Record<string, ActionState>;
  lastReceipt?: ActionReceipt | null;
}) {
  const mission = viewModel.missionControl || fallbackMissionControl(viewModel);
  const active =
    mission.steps?.find((step) => step.id === mission.activeStep) || mission.steps?.[0];
  const canRunLive = mode.liveActions;
  return (
    <section
      className="panel mission-panel"
      id="mission-panel"
      aria-label="Mission control"
      tabIndex={-1}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Mission control</p>
          <h2>Guided flow</h2>
        </div>
        <span id="mission-note" className="panel-note">
          {active ? `Active: ${active.title}` : "No active step"}
        </span>
      </div>
      <div className="mission-grid" id="mission-control-grid">
        {(mission.steps || []).map((step) => {
          const isActive = Boolean(
            active && (step.id === active.id || step.title === active.title),
          );
          return (
            <MissionStepCard
              key={step.id || step.title}
              step={step}
              active={isActive}
              canRunLive={canRunLive}
              actionState={step.safeAction ? actionsById[step.safeAction] : undefined}
              runLiveAction={runLiveAction}
            />
          );
        })}
      </div>
      <LogDecision
        mission={mission}
        mode={mode}
        runLiveAction={runLiveAction}
        actionsById={actionsById}
        lastReceipt={lastReceipt}
      />
    </section>
  );
}

function MissionStepCard({
  step,
  active,
  canRunLive,
  actionState,
  runLiveAction,
}: {
  step: MissionStep;
  active: boolean;
  canRunLive: boolean;
  actionState?: ActionState;
  runLiveAction: RunLiveAction;
}) {
  const action = step.safeAction || "";
  const disabledReasonId = `${step.id || action}-disabled-reason`;
  const pending = Boolean(actionState?.pending);
  return (
    <div
      className={`mission-step ${step.state || "idle"} ${active ? "active-step" : "inactive-step"}`}
      aria-current={active ? "step" : undefined}
    >
      <span>{step.state || "idle"}</span>
      <strong>{step.title}</strong>
      <p>{step.detail}</p>
      {canRunLive && action && (
        <button
          className="tool-button mission-run"
          type="button"
          data-mission-action={action}
          aria-describedby={disabledReasonId}
          disabled={pending}
          onClick={() => runLiveAction(action)}
        >
          {pending ? "Running..." : actionLabel(action)}
        </button>
      )}
      {canRunLive && action ? (
        <small className="disabled-reason" id={disabledReasonId}>
          {pending
            ? `${actionLabel(action)} is already running.`
            : "Guarded local action; no finalizer mutation."}
        </small>
      ) : null}
    </div>
  );
}

function LogDecision({
  mission,
  mode,
  runLiveAction,
  actionsById,
  lastReceipt,
}: {
  mission: MissionControlModel;
  mode: DashboardMode;
  runLiveAction: RunLiveAction;
  actionsById: Record<string, ActionState>;
  lastReceipt?: ActionReceipt | null;
}) {
  const logDecision = mission.logDecision || {};
  const available = Boolean(logDecision.available);
  const statuses = useMemo(
    () => defaultStatusesFor(logDecision.allowedStatuses),
    [logDecision.allowedStatuses],
  );
  const [status, setStatus] = useState(() => logDecisionStatusFor(logDecision, statuses));
  const [description, setDescription] = useState(() => logDecision.defaultDescription || "");
  const [structuredAsi, setStructuredAsi] = useState(() =>
    structuredAsiFrom(logDecision.asiTemplate),
  );
  const [asi, setAsi] = useState(() => stringifyAsi(logDecision.asiTemplate));
  const [rawDirty, setRawDirty] = useState(false);
  const [error, setError] = useState("");
  const action = `log-${String(status || "").replaceAll("_", "-")}`;
  const pending = Boolean(actionsById[action]?.pending);
  const packetFingerprint = logDecision.lastRunFingerprint || logDecision.fingerprint || "";
  const formKey = useMemo(
    () =>
      [logDecision.command || "", logDecision.suggestedStatus || "", packetFingerprint].join("|"),
    [logDecision.command, logDecision.suggestedStatus, packetFingerprint],
  );
  useEffect(() => {
    resetLogDecisionForm(
      {
        asiTemplate: logDecision.asiTemplate,
        defaultDescription: logDecision.defaultDescription,
        suggestedStatus: logDecision.suggestedStatus,
      },
      statuses,
      {
        setDescription,
        setStatus,
        setAsi,
        setError,
        setRawDirty,
        setStructuredAsi,
      },
    );
  }, [
    formKey,
    logDecision.asiTemplate,
    logDecision.defaultDescription,
    logDecision.suggestedStatus,
    statuses,
  ]);
  useEffect(() => {
    if (lastReceipt?.ok && String(lastReceipt.action || "").startsWith("log-")) {
      setDescription("");
      resetAsiFields(logDecision.asiTemplate, {
        setAsi,
        setError,
        setRawDirty,
        setStructuredAsi,
      });
    }
  }, [lastReceipt?.receiptId, lastReceipt?.ok, lastReceipt?.action, logDecision.asiTemplate]);
  const liveAvailable = mode.liveActions && available;
  const hidden = !mode.liveActions;
  const updateStructuredAsi = (key: keyof RunAsi, value: string) => {
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
    const result = await runLiveAction(
      action,
      buildLogDecisionBody(action, packetFingerprint, description, parsed.value),
    );
    if (!result?.ok && result?.receipt?.stderrSummary) setError(result.receipt.stderrSummary);
  };
  return (
    <div className="log-decision-panel" id="log-decision-panel" tabIndex={-1}>
      <div className="log-field" id="log-status-field" hidden={hidden}>
        <label htmlFor="log-decision-status">Status</label>
        <select
          id="log-decision-status"
          value={status}
          disabled={!liveAvailable || pending}
          onChange={(event) => setStatus(event.target.value)}
        >
          {statuses.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>
      <div className="log-field" id="log-description-field" hidden={hidden}>
        <label htmlFor="log-decision-description">Description</label>
        <input
          id="log-decision-description"
          type="text"
          autoComplete="off"
          value={description}
          disabled={!liveAvailable || pending}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <fieldset className="asi-structured" id="log-asi-field" hidden={hidden}>
        <legend>ASI</legend>
        <AsiTextField
          id="asi-hypothesis"
          label="Hypothesis"
          value={structuredAsi.hypothesis}
          disabled={!liveAvailable || pending}
          onChange={(value) => updateStructuredAsi("hypothesis", value)}
        />
        <AsiTextField
          id="asi-evidence"
          label="Evidence"
          value={structuredAsi.evidence}
          disabled={!liveAvailable || pending}
          multiline
          onChange={(value) => updateStructuredAsi("evidence", value)}
        />
        <AsiTextField
          id="asi-rollback-reason"
          label="Rollback reason"
          value={structuredAsi.rollback_reason}
          disabled={!liveAvailable || pending}
          onChange={(value) => updateStructuredAsi("rollback_reason", value)}
        />
        <AsiTextField
          id="asi-next-action-hint"
          label="Next action hint"
          value={structuredAsi.next_action_hint}
          disabled={!liveAvailable || pending}
          onChange={(value) => updateStructuredAsi("next_action_hint", value)}
        />
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
      <p id="log-decision-error" className="form-error" role="alert" hidden={!error}>
        {error}
      </p>
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

function defaultStatusesFor(allowedStatuses: unknown): string[] {
  return Array.isArray(allowedStatuses) && allowedStatuses.length
    ? (allowedStatuses as string[])
    : ["keep", "discard"];
}

function logDecisionStatusFor(logDecision: MissionControlModel["logDecision"], statuses: string[]) {
  return logDecision?.suggestedStatus || statuses[0] || "keep";
}

function resetLogDecisionForm(
  logDecision: {
    asiTemplate?: RunAsi;
    defaultDescription?: string;
    suggestedStatus?: string;
  },
  statuses: string[],
  setters: LogDecisionSetters & {
    setDescription: (value: string) => void;
    setStatus: (value: string) => void;
  },
) {
  setters.setStatus(logDecisionStatusFor(logDecision, statuses));
  setters.setDescription(logDecision?.defaultDescription || "");
  resetAsiFields(logDecision?.asiTemplate, setters);
}

function resetAsiFields(asiTemplate: RunAsi | undefined, setters: LogDecisionSetters) {
  setters.setStructuredAsi(structuredAsiFrom(asiTemplate));
  setters.setAsi(stringifyAsi(asiTemplate));
  setters.setRawDirty(false);
  setters.setError("");
}

function AsiTextField({
  id,
  label,
  value,
  disabled,
  multiline = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="log-field" htmlFor={id}>
      <span>{label}</span>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function parseAsi(text: string, status: string, structuredAsi: RunAsi, rawDirty = false) {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text || "{}") as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: `ASI must be valid JSON: ${error.message}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "ASI must be a JSON object." };
  }
  value = rawDirty ? cleanAsi(value) : { ...value, ...cleanAsi(structuredAsi) };
  const has = (key: string) => String(value[key] || "").trim().length > 0;
  if (status === "keep" && (!has("hypothesis") || !has("evidence"))) {
    return { ok: false, error: "Keep decisions require ASI hypothesis and evidence." };
  }
  if (status !== "keep" && !has("evidence") && !has("rollback_reason")) {
    return {
      ok: false,
      error: "Rejected or failed decisions require ASI evidence or rollback_reason.",
    };
  }
  return { ok: true, value };
}

function buildLogDecisionBody(
  action: string,
  lastRunFingerprint: string,
  description: string,
  asi: Record<string, unknown>,
) {
  return {
    confirm: action,
    lastRunFingerprint,
    description,
    asi,
  };
}

function structuredAsiFrom(template: RunAsi = {}) {
  return {
    hypothesis: String(template?.hypothesis || ""),
    evidence: String(template?.evidence || ""),
    rollback_reason: String(template?.rollback_reason || template?.rollbackReason || ""),
    next_action_hint: String(
      template?.next_action_hint || template?.nextAction || template?.next_action || "",
    ),
  };
}

function cleanAsi(value: Record<string, unknown> = {}) {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, typeof item === "string" ? item.trim() : item])
      .filter(([, item]) => item != null && String(item).trim().length > 0),
  );
}

function stringifyAsi(value: Record<string, unknown> = {}) {
  return JSON.stringify(cleanAsi(value), null, 2);
}
