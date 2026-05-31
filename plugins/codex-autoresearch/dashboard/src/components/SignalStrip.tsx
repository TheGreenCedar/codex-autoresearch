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
  return (
    <section
      className={`signal-strip signal-strip--${view}`}
      id="v2-release-signals"
      aria-label="Run readiness signals"
      data-view={view}
    >
      {signals.map((signal) => (
        <article className={`signal-item ${signal.tone}`} key={signal.id}>
          <span className="signal-label">{signal.label}</span>
          <strong aria-live={signal.live ? "polite" : undefined}>{signal.value}</strong>
          <em>{signal.detail}</em>
        </article>
      ))}
    </section>
  );
}

function buildSignals(viewModel: DashboardViewModel): SignalItem[] {
  return [
    nextSignal(viewModel),
    evidenceSignal(viewModel),
    lanesSignal(viewModel),
    watchdogSignal(viewModel),
    finalizationSignal(viewModel),
  ];
}

function nextSignal(viewModel: DashboardViewModel): SignalItem {
  const action = recordFrom(viewModel.nextBestAction);
  const envelope = recordFrom(viewModel.decisionEnvelopeSummary);
  const title = clean(action.title) || clean(envelope.title) || "Choose next action";
  return {
    id: "next",
    label: "Next",
    value: truncate(title, 34),
    detail: truncate(clean(action.priority) || clean(envelope.kind) || "Decision envelope", 58),
    tone: action.tone === "warn" ? "warn" : "neutral",
    live: true,
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
    value: truncate(label, 34),
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
    detail: truncate(fanoutStatus ? `Fanout ${fanoutStatus}` : "Strategy memory readiness", 58),
    tone: lanes.length ? "good" : "neutral",
  };
}

function watchdogSignal(viewModel: DashboardViewModel): SignalItem {
  const watchdog = recordFrom(viewModel.watchdogSummary);
  const stale = watchdog.stale === true;
  const status = clean(watchdog.status) || (stale ? "stale" : "tracking");
  return {
    id: "watchdog",
    label: "Watchdog",
    value: titleCase(status),
    detail: stale ? "Inspect, finalize, or rescope" : "No quiet-window pressure",
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
    value: ready ? "Preview ready" : titleCase(status),
    detail: finalizationDetail(status, ready),
    tone: status === "high" ? "warn" : ready ? "good" : "neutral",
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

function finalizationDetail(status: string, ready: boolean) {
  if (ready) return "Preview evidence is ready";
  if (status === "high") return "Run preview or rescope";
  if (status === "medium") return "Preview soon";
  return "Packaging stays in CLI";
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

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trim()}...`;
}
