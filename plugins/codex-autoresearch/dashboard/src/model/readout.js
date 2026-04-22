import { asiText } from "./asi.js";
import { finiteMetric, improvementPercent } from "./metrics.js";

export function buildReadout(session, viewModel = {}) {
  const runs = session.runs || [];
  const kept = runs.filter((run) => run.status === "keep" && finiteMetric(run.metric));
  const evidence = runs.filter((run) => run.status !== "crash" && finiteMetric(run.metric));
  const baselineRun = kept[0] || evidence[0] || null;
  const summary = viewModel.summary?.segment === session.segment ? viewModel.summary : null;
  const baseline = finiteMetric(summary?.baseline) ? Number(summary.baseline) : baselineRun?.metric ?? null;
  const bestRun = bestRunFor(kept, session.config.bestDirection);
  const best = finiteMetric(summary?.best)
    ? Number(summary.best)
    : bestRun?.metric ?? null;
  const latestFailure = [...runs].reverse().find((run) => run.status && run.status !== "keep") || null;
  const nextAction = viewModel.readout?.nextAction
    || viewModel.nextBestAction?.detail
    || viewModel.experimentMemory?.latestNextAction
    || [...runs].reverse().map((run) => asiText(run, ["next_action_hint", "nextAction", "next_action"], "")).find(Boolean)
    || "";
  const recentRuns = [...runs].reverse().slice(0, 4);
  return {
    baseline,
    best,
    bestRun,
    latestFailure,
    nextAction,
    confidence: summary?.confidence ?? runs.at(-1)?.confidence ?? null,
    confidenceText: viewModel.readout?.confidenceText || "Confidence compares best movement against observed metric noise.",
    improvement: improvementPercent(baseline, best, session.config.bestDirection),
    recentRuns,
    plottedRuns: evidence,
  };
}

export function bestRunFor(runs, direction = "lower") {
  let best = null;
  for (const run of runs) {
    if (!finiteMetric(run.metric)) continue;
    if (!best) {
      best = run;
      continue;
    }
    if (direction === "higher" ? run.metric > best.metric : run.metric < best.metric) best = run;
  }
  return best;
}
