import type {
  DashboardReadout,
  DashboardViewModel,
  SessionRun,
  SessionSegment,
  WeightedMetricDefinition,
} from "../types";
import { asiText } from "./asi";
import { finiteMetric, improvementPercent } from "./metrics";
import { metricValueForRun, resolveMetricDefinition } from "./metric-definition";

export function buildReadout(
  session: SessionSegment,
  viewModel: DashboardViewModel = {},
  invalidLedgerEntryCount = 0,
): DashboardReadout {
  const runs = session.runs || [];
  const summary = viewModel.summary?.segment === session.segment ? viewModel.summary : null;
  const summaryBaseline = finiteMetric(summary?.baseline) ? Number(summary.baseline) : null;
  const metricDefinition = resolveMetricDefinition(session, summaryBaseline);
  const kept = runs.filter(
    (run) => isAcceptedCurrentKeep(run) && finiteMetric(metricValueForRun(run, metricDefinition)),
  );
  const evidence = runs.filter(
    (run) => run.status !== "crash" && finiteMetric(metricValueForRun(run, metricDefinition)),
  );
  const baselineRun =
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
  const visibleBestValue = metricValueForRun(visibleBestRun, metricDefinition);
  const bestRun = visibleBestRun;
  const best = visibleBestValue;
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

export function bestRunFor(
  runs: SessionRun[],
  metricDefinition: WeightedMetricDefinition,
): SessionRun | null {
  let best: SessionRun | null = null;
  for (const run of runs) {
    const value = metricValueForRun(run, metricDefinition);
    if (!finiteMetric(value)) continue;
    if (!best) {
      best = run;
      continue;
    }
    const bestValue = metricValueForRun(best, metricDefinition);
    if (!finiteMetric(bestValue)) {
      best = run;
      continue;
    }
    if (metricDefinition.bestDirection === "higher" ? value > bestValue : value < bestValue)
      best = run;
  }
  return best;
}

function isAcceptedCurrentKeep(run: SessionRun): boolean {
  if (run.status !== "keep") return false;
  if (run.quarantined === true) return false;
  const evidenceStatus = String(run.evidenceStatus || "")
    .trim()
    .toLowerCase();
  return !evidenceStatus || evidenceStatus === "accepted";
}
