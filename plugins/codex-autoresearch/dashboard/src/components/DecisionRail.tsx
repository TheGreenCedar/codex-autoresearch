import { STATUS_LABELS, TONES } from "../constants";
import { recordFrom } from "../model";
import { useCopyText } from "../hooks/useCopyText";
import type { DashboardMode, DashboardReadout, DashboardViewModel, NextBestAction } from "../types";

export function DecisionRail({
  readout,
  viewModel,
  mode,
  auditView,
}: {
  readout: DashboardReadout;
  viewModel: DashboardViewModel;
  mode: DashboardMode;
  auditView: boolean;
}) {
  const action = (viewModel.nextBestAction || {}) as NextBestAction;
  const summary = recordFrom(viewModel.decisionEnvelopeSummary);
  const decisionPlan = recordFrom(viewModel.decisionPlanProjection);
  const operatorDecision = operatorDecisionFor({ action, decisionPlan, readout, summary });
  const chips = evidenceChipsFor(viewModel, action, readout);
  const reportCopy = useCopyText();
  const handoffCopy = useCopyText();
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
          title: "No ledger yet",
          detail: "First safe move: capture a baseline measurement.",
          tone: "neutral",
        },
      ];
  return (
    <section
      className={`decision-panel tone-${action.tone || "focus"}`}
      id="decision-rail"
      tabIndex={-1}
    >
      <div className="decision-copy">
        <p className="eyebrow">Safe next step</p>
        <h2 id="next-action-title">Do this first</h2>
        <div id="decision-envelope-summary">
          <p className="decision-title" id="decision-title">
            {operatorDecision.title}
          </p>
          <dl className="operator-decision-summary">
            <div data-decision-field="status">
              <dt>Status</dt>
              <dd id="decision-status">{operatorDecision.status}</dd>
            </div>
            <div data-decision-field="blocker">
              <dt>Blocker</dt>
              <dd id="decision-blocker">{operatorDecision.blocker}</dd>
            </div>
            <div data-decision-field="action">
              <dt>Next action</dt>
              <dd id="next-action-detail">{operatorDecision.action}</dd>
            </div>
            <div data-decision-field="command">
              <dt>Command</dt>
              <dd id="decision-next-command">
                {operatorDecision.command ? (
                  <code translate="no">{operatorDecision.command}</code>
                ) : (
                  "Continue in the CLI; this readout exposes no safe command."
                )}
              </dd>
            </div>
          </dl>
        </div>
        <details className="decision-details" open={auditView}>
          <summary>{auditView ? "Canonical decision details" : "Why this action"}</summary>
          <div className="decision-envelope-card">
            <span>Canonical decision</span>
            <strong>{String(summary.title || action.title || "Next action")}</strong>
            <em>{canonicalDecisionMeta(summary)}</em>
          </div>
          <div
            className="evidence-chips"
            id="decision-evidence-chips"
            aria-label="Decision evidence"
          >
            {chips.map((chip) => (
              <span
                className={`evidence-chip ${chip.tone || "neutral"} evidence-${chip.status}`}
                data-evidence-status={chip.status}
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
          <div className="decision-list" aria-label="Recent decision history">
            {railItems.map((item) => (
              <div className={`decision-item ${item.tone}`} key={`${item.id}-${item.title}`}>
                <span>{item.id}</span>
                <strong>{item.title}</strong>
                {item.id === "Start" ? <span aria-hidden="true">. </span> : null}
                <em>{item.detail}</em>
              </div>
            ))}
          </div>
          <DecisionCopyActions
            reportCopied={reportCopy.copied}
            handoffCopied={handoffCopy.copied}
            copyReport={() => reportCopy.copy(userReportFor(viewModel, readout, action))}
            copyHandoff={() =>
              handoffCopy.copy(JSON.stringify(viewModel.handoffPacket || {}, null, 2))
            }
          />
        </details>
        <div className="decision-meta">
          <span>{action.utilityCopy || readout.confidenceText}</span>
          <span
            aria-label={
              mode.liveRefresh
                ? "Readout only. CLI does the work. Live refresh can update this readout."
                : "Readout only. CLI does the work. Static snapshots do not mutate session state."
            }
          >
            Readout only. CLI does the work.
          </span>
        </div>
      </div>
    </section>
  );
}

function operatorDecisionFor({
  action,
  decisionPlan,
  readout,
  summary,
}: {
  action: NextBestAction;
  decisionPlan: Record<string, unknown>;
  readout: DashboardReadout;
  summary: Record<string, unknown>;
}) {
  const planAction = recordFrom(decisionPlan.action);
  const display = recordFrom(decisionPlan.display);
  const blocker = cleanText(decisionPlan.primaryBlockerCode);
  return {
    title: String(summary.title || action.title || "Review the next safe step"),
    status: operatorStatus(decisionPlan),
    blocker: blocker || "No blocker reported.",
    action:
      cleanText(display.actionReason) ||
      cleanText(summary.detail) ||
      cleanText(action.detail) ||
      cleanText(readout.nextAction) ||
      "Run a packet to generate the next measured step.",
    command: cleanText(planAction.command),
  };
}

function operatorStatus(decisionPlan: Record<string, unknown>) {
  const loop = recordFrom(decisionPlan.loopDisposition);
  const parent = recordFrom(decisionPlan.parentDisposition);
  if (loop.kind === "blocked" || parent.kind === "block-final-answer") return "Blocked";
  if (loop.kind === "complete") return "Ready for review";
  if (loop.kind === "continue" || loop.kind === "pause") return "Ready to continue";
  return "Needs review";
}

function canonicalDecisionMeta(summary: Record<string, unknown>) {
  return [
    summary.kind ? `kind: ${summary.kind}` : "",
    summary.fresh === false ? "stale packet" : summary.fresh === true ? "fresh packet" : "",
    typeof summary.measurementRuns === "number"
      ? `${summary.measurementRuns} measurement${summary.measurementRuns === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" / ");
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
        {reportCopied ? "Copied report" : "Copy read-only report"}
      </button>
      <button type="button" className="tool-button subtle" onClick={copyHandoff}>
        {handoffCopied ? "Copied handoff" : "Copy read-only handoff"}
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
      tone: evidenceReadout.promotable ? "good" : "neutral",
      status: evidenceStatusKey(evidenceReadout.label || evidenceReadout.title),
    },
    proofGap.detail && {
      label: proofGap.label || "Proof gap",
      value: [proofGap.detail, proofGap.nextAction].filter(Boolean).join(" -> "),
      tone: "warn",
      status: "suspicious",
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
        status: evidenceStatusKey(chip.evidenceStatus || chip.status || chip.tone || chip.state),
      };
    })
    .filter((item) => item.value);
  if (chips.length) return chips.slice(0, 5);
  const explanation = action.explanation || {};
  return [
    explanation.evidence && {
      label: "Evidence",
      value: explanation.evidence,
      tone: "good",
      status: "accepted",
    },
    explanation.avoids && {
      label: "Avoids",
      value: explanation.avoids,
      tone: "warn",
      status: "rejected",
    },
    explanation.proof && {
      label: "Proof",
      value: explanation.proof,
      tone: "neutral",
      status: "provisional",
    },
    readout.confidenceText && {
      label: "Confidence",
      value: readout.confidenceText,
      tone: "neutral",
      status: "provisional",
    },
  ]
    .filter(Boolean)
    .slice(0, 4) as { label: string; value: string; tone: string; status: string }[];
}

function evidenceStatusKey(value: unknown) {
  const key = String(value || "").toLowerCase();
  if (["accepted", "current", "promotion_eligible", "good"].includes(key)) return "accepted";
  if (["rejected", "invalidated", "superseded", "danger"].includes(key)) return "rejected";
  if (["quarantined", "suspicious", "warn", "warning"].includes(key)) return "suspicious";
  if (["provisional", "exploratory", "pending_repeat", "neutral"].includes(key)) {
    return "provisional";
  }
  return "provisional";
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
