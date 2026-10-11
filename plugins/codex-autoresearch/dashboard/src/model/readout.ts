import type {
  DashboardReadout,
  DashboardViewModel,
  SessionRun,
  SessionSegment,
  DashboardEntry,
} from "../types";
import { asiText } from "./asi";
import { finiteMetric, improvementPercent } from "./metrics";
import { metricValueForRun, resolveMetricDefinition } from "./metric-definition";
import { normalizeRun } from "./entries";
import { bestRunFor } from "../../../lib/dashboard-metric.js";
export { bestRunFor } from "../../../lib/dashboard-metric.js";

export function buildReadout(
  session: SessionSegment,
  viewModel: DashboardViewModel = {},
  invalidLedgerEntryCount = 0,
): DashboardReadout {
  const runs = session.runs || [];
  const summary = viewModel.summary?.segment === session.segment ? viewModel.summary : null;
  const summaryBaseline = finiteMetric(summary?.baseline) ? Number(summary.baseline) : null;
  const metricDefinition =
    (summary ? viewModel.readout?.metricDefinition : null) ||
    resolveMetricDefinition(session, summaryBaseline);
  const kept = runs.filter(
    (run) => isAcceptedCurrentKeep(run) && finiteMetric(metricValueForRun(run, metricDefinition)),
  );
  const evidence = runs.filter(
    (run) => run.status !== "crash" && finiteMetric(metricValueForRun(run, metricDefinition)),
  );
  const baselineRun =
    (summary ? canonicalRunFor(viewModel.readout?.baselineRun, session) : null) ||
    (summaryBaseline == null ? null : evidence.find((run) => run.metric === summaryBaseline)) ||
    evidence.find((run) => run.status === "measure") ||
    evidence[0] ||
    null;
  const allowSummaryMetrics = metricDefinition.mode === "raw";
  const baseline =
    allowSummaryMetrics && summaryBaseline != null
      ? summaryBaseline
      : metricValueForRun(baselineRun, metricDefinition);
  const visibleBestRun = bestRunFor(kept, metricDefinition);
  const canonicalBest = summary
    ? metricDefinition.mode === "weighted_cost"
      ? viewModel.readout?.weightedBestKept
      : viewModel.readout?.bestKept
    : null;
  const canonicalBestRun = canonicalRunFor(canonicalBest, session);
  const bestRun =
    canonicalBestRun &&
    isAcceptedCurrentKeep(canonicalBestRun) &&
    finiteMetric(canonicalBestRun.metric)
      ? canonicalBestRun
      : visibleBestRun;
  const best = metricValueForRun(bestRun, metricDefinition);
  const latestPlottedRun = evidence.at(-1) || null;
  const latestFailure =
    [...runs]
      .reverse()
      .find((run) => ["discard", "crash", "checks_failed"].includes(String(run.status))) || null;
  const nextAction =
    viewModel.readout?.nextAction ||
    viewModel.nextBestAction?.detail ||
    viewModel.experimentMemory?.latestNextAction ||
    [...runs]
      .reverse()
      .map((run) => asiText(run, ["next_action_hint", "nextAction", "next_action"], ""))
      .find(Boolean) ||
    "";
  return {
    baseline,
    baselineRun,
    best,
    bestRun,
    latestPlottedRun,
    latestFailure,
    nextAction,
    confidence: summary?.confidence ?? runs.at(-1)?.confidence ?? null,
    confidenceText:
      viewModel.readout?.confidenceText ||
      "Movement / spread compares improvement with history median absolute deviation across experiments; it is not statistical confidence.",
    improvement: improvementPercent(baseline, best, metricDefinition.bestDirection),
    recentRuns: [...runs].reverse().slice(0, 4),
    plottedRuns: evidence,
    metricDefinition,
    invalidLedgerEntryCount,
  };
}

function isAcceptedCurrentKeep(run: SessionRun): boolean {
  if (run.status !== "keep") return false;
  if (run.quarantined === true) return false;
  const evidenceStatus = String(run.evidenceStatus || "")
    .trim()
    .toLowerCase();
  return !evidenceStatus || evidenceStatus === "accepted";
}

function canonicalRunFor(
  entry: DashboardEntry | null | undefined,
  session: SessionSegment,
): SessionRun | null {
  return entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    entry.segment === session.segment
    ? normalizeRun(entry, session)
    : null;
}
