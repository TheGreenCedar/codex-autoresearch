import { STATUS_LABELS, TONES } from "../constants";
import { recordFrom } from "../model";
import { useCopyText } from "../hooks/useCopyText";
import type { DashboardMode, DashboardReadout, DashboardViewModel, NextBestAction } from "../types";

export function DecisionRail({
  readout,
  viewModel,
  mode,
  layout = "full",
}: {
  readout: DashboardReadout;
  viewModel: DashboardViewModel;
  mode: DashboardMode;
  layout?: "hero" | "full";
}) {
  const hero = layout === "hero";
  const action = (viewModel.nextBestAction || {}) as NextBestAction;
  const envelope = recordFrom(viewModel.decisionEnvelopeSummary);
  const chips = evidenceChipsFor(viewModel, action, readout);
  const reportCopy = useCopyText();
  const handoffCopy = useCopyText();
  const commandCopy = useCopyText();
  const command = typeof action.command === "string" ? action.command : "";
  const showCommandCopy = mode.liveRefresh && command;
  const railItems = readout.recentRuns.length
    ? readout.recentRuns.map((run) => ({
        id: `#${run.run}`,
        title: STATUS_LABELS[run.status] || run.status || "Run",
        detail: run.description || "No description",
        tone: TONES[run.status] || "neutral",
      }))
    : [
        {
          id: "Start",
          title: "No decisions yet",
          detail: "Capture a baseline packet.",
          tone: "neutral",
        },
      ];
  return (
    <section
      className={`decision-panel tone-${action.tone || "focus"}${hero ? " decision-panel--hero" : ""}`}
      id="decision-rail"
      tabIndex={-1}
    >
      <div className="decision-copy">
        {!hero ? <p className="eyebrow">{action.priority || "Next move"}</p> : null}
        <h2 id="next-action-title">
          {String(envelope.title || action.title || readout.nextAction || "Choose next step")}
        </h2>
        {!hero ? (
          <div className="decision-envelope-card" id="decision-envelope-summary">
            <span>Decision basis</span>
            <strong>{String(envelope.title || action.title || "Next action")}</strong>
            <em>
              {[
                envelope.kind ? `source: ${envelope.kind}` : "",
                envelope.fresh === false
                  ? "stale packet"
                  : envelope.fresh === true
                    ? "fresh packet"
                    : "",
                typeof envelope.measurementRuns === "number"
                  ? `${envelope.measurementRuns} measurement${envelope.measurementRuns === 1 ? "" : "s"}`
                  : "",
              ]
                .filter(Boolean)
                .join(" / ")}
            </em>
          </div>
        ) : (
          <p className="decision-hero-kicker" id="decision-envelope-summary">
            {[
              String(envelope.title || action.priority || "Next move"),
              envelope.kind ? `source: ${envelope.kind}` : "",
              envelope.fresh === false ? "stale packet" : "",
              typeof envelope.measurementRuns === "number"
                ? `${envelope.measurementRuns} measurement${envelope.measurementRuns === 1 ? "" : "s"}`
                : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        <p id="next-action-detail" className="next-action-text">
          {readout.nextAction ||
            action.detail ||
            "No next step recorded yet. Run a packet to generate one."}
        </p>
        {showCommandCopy ? (
          <div className="next-command-copy" id="decision-next-command">
            <div>
              <span>
                {(action as Record<string, unknown>).primaryCommand
                  ? (((action as Record<string, unknown>).primaryCommand as Record<string, unknown>)
                      .label as string)
                  : "Next command"}
              </span>
              <code translate="no">{command}</code>
            </div>
            <button
              type="button"
              className="tool-button subtle"
              onClick={() => commandCopy.copy(command)}
            >
              {commandCopy.copied ? "Copied" : "Copy"}
            </button>
            {commandCopy.copied ? (
              <span className="copy-status" aria-live="polite">
                Command copied to clipboard.
              </span>
            ) : null}
          </div>
        ) : null}
        {hero ? (
          <details className="decision-details">
            <summary>Why this is safe</summary>
            <div
              className="evidence-chips"
              id="decision-evidence-chips"
              aria-label="Decision evidence"
            >
              {chips.map((chip) => (
                <span
                  className={`evidence-chip ${chip.tone || "neutral"}`}
                  key={`${chip.label}-${chip.value}`}
                >
                  <strong>{chip.label}</strong>
                  <em>{chip.value}</em>
                </span>
              ))}
            </div>
            <div className="readout-facts">
              <span className="readout-label">Best result so far</span>
              <strong id="best-kept-detail">
                {readout.bestRun?.description || "No kept result yet."}
              </strong>
              <span className="readout-label">Most recent setback</span>
              <strong id="recent-failure-detail">
                {readout.latestFailure?.description || "No recent failure."}
              </strong>
            </div>
          </details>
        ) : (
          <>
            <div
              className="evidence-chips"
              id="decision-evidence-chips"
              aria-label="Decision evidence"
            >
              {chips.map((chip) => (
                <span
                  className={`evidence-chip ${chip.tone || "neutral"}`}
                  key={`${chip.label}-${chip.value}`}
                >
                  <strong>{chip.label}</strong>
                  <em>{chip.value}</em>
                </span>
              ))}
            </div>
            <div className="readout-facts">
              <span className="readout-label">Best result so far</span>
              <strong id="best-kept-detail">
                {readout.bestRun?.description || "No kept result yet."}
              </strong>
              <span className="readout-label">Most recent setback</span>
              <strong id="recent-failure-detail">
                {readout.latestFailure?.description || "No recent failure."}
              </strong>
            </div>
          </>
        )}
        {!hero ? (
          <DecisionCopyActions
            reportCopied={reportCopy.copied}
            handoffCopied={handoffCopy.copied}
            copyReport={() => reportCopy.copy(userReportFor(viewModel, readout, action))}
            copyHandoff={() =>
              handoffCopy.copy(JSON.stringify(viewModel.handoffPacket || {}, null, 2))
            }
          />
        ) : null}
        {!hero ? (
          <div className="decision-meta">
            <span>{action.utilityCopy || readout.confidenceText}</span>
            <span>{mode.liveRefresh ? "Live data available" : "Read-only snapshot"}</span>
          </div>
        ) : null}
      </div>
      {!hero ? (
        <div className="decision-list" aria-label="Recent decision history">
          {railItems.map((item) => (
            <div className={`decision-item ${item.tone}`} key={`${item.id}-${item.title}`}>
              <span>{item.id}</span>
              <strong>{item.title}</strong>
              <em>{item.detail}</em>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function DecisionCopyActions({
  reportCopied,
  handoffCopied,
  copyReport,
  copyHandoff,
}: {
  reportCopied: boolean;
  handoffCopied: boolean;
  copyReport: () => Promise<boolean>;
  copyHandoff: () => Promise<boolean>;
}) {
  return (
    <div className="decision-copy-actions" aria-label="Copyable decision outputs">
      <button type="button" className="tool-button subtle" onClick={copyReport}>
        {reportCopied ? "Copied report" : "Copy report"}
      </button>
      <button type="button" className="tool-button subtle" onClick={copyHandoff}>
        {handoffCopied ? "Copied handoff" : "Copy handoff"}
      </button>
    </div>
  );
}

function userReportFor(
  viewModel: DashboardViewModel,
  readout: DashboardReadout,
  action: NextBestAction,
) {
  const receipt = recordFrom(viewModel.decisionReceipt);
  const summary = recordFrom(viewModel.summary);
  const diagnostics = toList(viewModel.trustBlockers).length;
  return [
    `Autoresearch: ${summary.runs ?? 0} run(s), best=${readout.best ?? "none"}, baseline=${readout.baseline ?? "none"}.`,
    `Next: ${action.title || receipt.title || "Next action"} - ${action.detail || receipt.summary || readout.nextAction || "No next action"}.`,
    `Why safe: ${action.explanation?.evidence || action.utilityCopy || receipt.whySafe || "dashboard state"}.`,
    diagnostics
      ? `Codex handoff includes ${diagnostics} diagnostic note${diagnostics === 1 ? "" : "s"}.`
      : "No Codex diagnostics are pending.",
  ].join("\n");
}

function evidenceChipsFor(
  viewModel: DashboardViewModel,
  action: NextBestAction,
  readout: DashboardReadout,
) {
  const modeled = Array.isArray(viewModel.evidenceChips) ? viewModel.evidenceChips : [];
  const actionModeled = Array.isArray(action.evidenceChips) ? action.evidenceChips : [];
  const evidenceReadout = recordFrom(viewModel.evidenceReadout);
  const proofGap = Array.isArray(viewModel.proofGaps) ? recordFrom(viewModel.proofGaps[0]) : {};
  const chips = [
    evidenceReadout.label && {
      label: "Evidence label",
      value: String(evidenceReadout.title || evidenceReadout.label),
      tone: evidenceReadout.promotable ? "good" : "warn",
    },
    proofGap.detail && {
      label: proofGap.label || "Proof gap",
      value: [proofGap.detail, proofGap.nextAction].filter(Boolean).join(" -> "),
      tone: "warn",
    },
    ...modeled,
    ...actionModeled,
  ]
    .filter(Boolean)
    .map((item) => {
      const chip = item as Record<string, unknown>;
      return {
        label: String(chip.label || chip.title || chip.kind || "Evidence"),
        value: String(chip.value || chip.detail || chip.text || chip.message || ""),
        tone: String(chip.tone || chip.state || "neutral"),
      };
    })
    .filter((item) => item.value);
  if (chips.length) return chips.slice(0, 5);
  const explanation = action.explanation || {};
  return [
    explanation.evidence && { label: "Evidence", value: explanation.evidence, tone: "good" },
    explanation.avoids && { label: "Avoids", value: explanation.avoids, tone: "warn" },
    explanation.proof && { label: "Proof", value: explanation.proof, tone: "neutral" },
    readout.confidenceText && {
      label: "Confidence",
      value: readout.confidenceText,
      tone: "neutral",
    },
  ]
    .filter(Boolean)
    .slice(0, 4) as { label: string; value: string; tone: string }[];
}

function toList(value: unknown) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return String(record.message || record.code || record.title || record.detail || "");
      }
      return String(item || "");
    })
    .filter(Boolean);
}
