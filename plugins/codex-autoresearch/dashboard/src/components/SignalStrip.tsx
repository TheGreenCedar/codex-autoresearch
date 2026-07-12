import { recordFrom } from "../model";
import type { DashboardView } from "../constants";
import type { DashboardViewModel, StrategyLane } from "../types";
import { laneActive, laneCompleted } from "./laneStatus";

interface SignalStripProps {
  view: DashboardView;
  viewModel: DashboardViewModel;
}

interface SignalItem {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: "good" | "neutral" | "warn" | "danger";
  live?: boolean;
}

export function SignalStrip({ view, viewModel }: SignalStripProps) {
  const signals = buildSignals(viewModel);
  const trustItems = buildTrustItems(viewModel);
  return (
    <section
      className={`signal-strip signal-strip--${view}`}
      id="v2-release-signals"
      aria-label="Run readiness signals"
      data-view={view}
    >
      {signals.map((signal) => (
        <details className={`signal-item ${signal.tone}`} key={signal.id}>
          <summary>
            <span className="signal-label">{signal.label}</span>
            <strong>{signal.value}</strong>
          </summary>
          <p>{signal.detail}</p>
          {view === "audit" && signal.id === "watchdog" ? (
            <small>Canonical term: watchdog</small>
          ) : null}
        </details>
      ))}
      {trustItems.length ? (
        <details className="trust-detail-strip">
          <summary>
            Trust review: {trustItems.length} blocker, proof gap, or process warning
            {trustItems.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {trustItems.map((item) => (
              <li className={`trust-detail-item ${item.tone}`} key={item.id}>
                <strong>{item.label}</strong>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function buildSignals(viewModel: DashboardViewModel): SignalItem[] {
  const modeledSignals = Array.isArray(viewModel.signals)
    ? viewModel.signals.map(signalFromModel).filter((item): item is SignalItem => item !== null)
    : [];
  return uniqueSignals([
    ...modeledSignals,
    evidenceSignal(viewModel),
    lanesSignal(viewModel),
    watchdogSignal(viewModel),
    finalizationSignal(viewModel),
  ]);
}

function signalFromModel(value: unknown): SignalItem | null {
  const record = recordFrom(value);
  const id =
    clean(record.id) ||
    clean(record.label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
  const label = clean(record.label);
  const detail = clean(record.detail) || clean(record.message);
  if (!id || !label || !detail) return null;
  const tone = clean(record.tone);
  return {
    id,
    label,
    value: clean(record.value) || label,
    detail,
    tone: ["good", "neutral", "warn", "danger"].includes(tone)
      ? (tone as SignalItem["tone"])
      : "warn",
  };
}

function evidenceSignal(viewModel: DashboardViewModel): SignalItem {
  const readout = recordFrom(viewModel.evidenceReadout);
  const ledger = recordFrom(viewModel.evidenceLedger);
  const counts = recordFrom(ledger.counts);
  const acceptedCurrent = numeric(ledger.acceptedCurrent) ?? numeric(counts.accepted) ?? 0;
  const provisional = numeric(counts.provisional) ?? 0;
  const rejected = numeric(counts.rejected) ?? 0;
  const superseded = numeric(counts.superseded) ?? 0;
  const auditOnly = rejected + superseded;
  const label = clean(readout.title) || clean(readout.label) || "Exploratory";
  const promotable = readout.promotable === true;
  return {
    id: "evidence",
    label: "Evidence",
    value: label,
    detail: evidenceDetail({ acceptedCurrent, auditOnly, provisional }),
    tone: promotable ? "good" : auditOnly > 0 ? "warn" : "neutral",
  };
}

function lanesSignal(viewModel: DashboardViewModel): SignalItem {
  const lanes = strategyLanes(viewModel);
  const completed = lanes.filter((lane) => laneCompleted(lane)).length;
  const active = lanes.filter((lane) => laneActive(lane)).length;
  const fanout = recordFrom(viewModel.fanoutPlan);
  const fanoutStatus = clean(fanout.status) || clean(fanout.state);
  return {
    id: "lanes",
    label: "Lanes",
    value: lanes.length ? `${active} active / ${completed} done` : "No lanes",
    detail: fanoutStatus ? `Fanout ${fanoutStatus}` : "Strategy memory readiness",
    tone: lanes.length ? "good" : "neutral",
  };
}

function watchdogSignal(viewModel: DashboardViewModel): SignalItem {
  const watchdog = recordFrom(viewModel.watchdogSummary);
  const stale = watchdog.stale === true;
  const status = clean(watchdog.status) || (stale ? "stale" : "tracking");
  return {
    id: "watchdog",
    label: "Quiet window",
    value: titleCase(status),
    detail: stale
      ? "Canonical: watchdog. Inspect, finalize, or rescope"
      : "Canonical: watchdog. No quiet-window pressure",
    tone: stale ? "warn" : status === "idle" ? "neutral" : "good",
    live: true,
  };
}

function finalizationSignal(viewModel: DashboardViewModel): SignalItem {
  const pressure = recordFrom(viewModel.finalizationPressure);
  const preview = recordFrom(viewModel.finalizePreview);
  const checklist = recordFrom(viewModel.finalizationChecklist);
  const ready = preview.ready === true || checklist.ready === true;
  const status = clean(pressure.status) || (ready ? "ready" : "gated");
  return {
    id: "finalize",
    label: "Finalize",
    value: ready ? "Preview ready" : "Preview gated",
    detail: finalizationDetail(status, ready, clean(pressure.recommendation)),
    tone: status === "high" || status === "medium" ? "warn" : ready ? "good" : "neutral",
  };
}

function evidenceDetail({
  acceptedCurrent,
  auditOnly,
  provisional,
}: {
  acceptedCurrent: number;
  auditOnly: number;
  provisional: number;
}) {
  const middle = provisional > 0 ? ` / ${provisional} provisional` : "";
  return `${acceptedCurrent} current${middle} / ${auditOnly} audit-only`;
}

function finalizationDetail(status: string, ready: boolean, recommendation: string) {
  if (ready) return "Preview evidence is ready";
  const detail = ["Preview blocked until gates clear."];
  if (status === "high" || status === "medium") {
    detail.push(`Runway pressure: ${titleCase(status)}.`);
  }
  detail.push(recommendation || "Packaging stays in CLI.");
  return detail.join(" ");
}

function buildTrustItems(viewModel: DashboardViewModel) {
  const trustState = recordFrom(viewModel.trustState || viewModel.trust);
  const processHygiene = recordFrom(viewModel.processHygiene);
  const finalizePreview = recordFrom(viewModel.finalizePreview);
  const researchTruth = recordFrom(viewModel.researchTruth || viewModel.truthMeter);
  const items = [
    ...labeledList("Trust blocker", viewModel.trustBlockers, "danger"),
    ...labeledList("Trust reason", trustState.reasons, "warn"),
    ...labeledList("Proof gap", viewModel.proofGaps, "warn"),
    ...labeledList("Process warning", processHygiene.warnings, "warn"),
    ...labeledList("Runtime warning", viewModel.trustWarnings, "warn"),
    ...labeledList("Session warning", viewModel.warnings, "warn"),
    ...labeledList("Finalization warning", finalizePreview.warnings, "warn"),
    ...labeledList("Research proof gap", researchTruth.suspiciousReasons, "warn"),
    ...labeledList("Research proof gap", researchTruth.suspicious_reasons, "warn"),
    ...labeledList("Research warning", researchTruth.suspiciousPerfectWarning, "warn"),
  ];
  return uniqueTrustItems(items);
}

function labeledList(label: string, value: unknown, tone: SignalItem["tone"]) {
  return toList(value).map((text, index) => ({
    id: `${label}-${index}-${text}`,
    label,
    text,
    tone,
  }));
}

function uniqueTrustItems<T extends { label: string; text: string }>(items: T[]) {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = `${item.label}\n${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function uniqueSignals(items: SignalItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function strategyLanes(viewModel: DashboardViewModel): StrategyLane[] {
  const memory = recordFrom(viewModel.experimentMemory);
  if (Array.isArray(viewModel.parallelLanes) && viewModel.parallelLanes.length) {
    return viewModel.parallelLanes;
  }
  return Array.isArray(memory.lanePortfolio) ? (memory.lanePortfolio as StrategyLane[]) : [];
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function numeric(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function titleCase(value: string) {
  const normalized = value.replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Unknown";
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function toList(value: unknown) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return [
          record.label || record.title || record.code || record.kind || "",
          record.detail ||
            record.message ||
            record.reason ||
            record.nextAction ||
            record.text ||
            "",
        ]
          .filter(Boolean)
          .join(": ");
      }
      return String(item || "");
    })
    .map((item) => item.trim())
    .filter(Boolean);
}
