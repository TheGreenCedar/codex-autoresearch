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
): DashboardReadout {
  const runs = session.runs || [];
  const metricDefinition = resolveMetricDefinition(session);
  const kept = runs.filter(
    (run) => run.status === "keep" && finiteMetric(metricValueForRun(run, metricDefinition)),
  );
  const evidence = runs.filter(
    (run) => run.status !== "crash" && finiteMetric(metricValueForRun(run, metricDefinition)),
  );
  const baselineRun = kept[0] || evidence[0] || null;
  const summary = viewModel.summary?.segment === session.segment ? viewModel.summary : null;
  const allowSummaryMetrics = metricDefinition.mode === "raw";
  const baseline =
    allowSummaryMetrics && finiteMetric(summary?.baseline)
      ? Number(summary.baseline)
      : metricValueForRun(baselineRun, metricDefinition);
  const bestRun = bestRunFor(kept, metricDefinition);
  const best =
    allowSummaryMetrics && finiteMetric(summary?.best)
      ? Number(summary.best)
      : metricValueForRun(bestRun, metricDefinition);
  const latestFailure =
    [...runs].reverse().find((run) => run.status && run.status !== "keep") || null;
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
    best,
    bestRun,
    latestFailure,
    nextAction,
    confidence: summary?.confidence ?? runs.at(-1)?.confidence ?? null,
    confidenceText:
      viewModel.readout?.confidenceText ||
      "Confidence compares best movement against observed metric noise.",
    improvement: improvementPercent(baseline, best, metricDefinition.bestDirection),
    recentRuns: [...runs].reverse().slice(0, 4),
    plottedRuns: evidence,
    metricDefinition,
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
