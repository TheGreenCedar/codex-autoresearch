import { STATUS_VALUES, finiteMetric } from "./session-core.mjs";

export function buildDashboardViewModel({ state, settings = {}, commands = [], setupPlan = null, qualityGap = null, finalizePreview = null, recipes = [] }) {
  const current = state.current || [];
  const kept = current.filter((run) => run.status === "keep");
  const failures = current.filter((run) => ["discard", "crash", "checks_failed"].includes(run.status));
  const bestKept = bestRun(kept, state.config.bestDirection);
  const latestFailure = failures.at(-1) || null;
  const nextAction = [...current].reverse()
    .map((run) => run.asi?.next_action_hint || run.asi?.nextAction || run.asi?.next_action)
    .find(Boolean) || (current.length ? "Choose the next measured hypothesis." : "Run and log a baseline.");
  return {
    setup: setupPlan,
    qualityGap,
    finalizePreview,
    recipes,
    summary: {
      name: state.config.name || "Autoresearch",
      metricName: state.config.metricName,
      metricUnit: state.config.metricUnit,
      direction: state.config.bestDirection,
      segment: state.segment,
      runs: current.length,
      kept: kept.length,
      failed: failures.length,
      baseline: state.baseline,
      best: state.best,
      confidence: state.confidence,
      statusCounts: Object.fromEntries([...STATUS_VALUES].map((status) => [
        status,
        current.filter((run) => run.status === status).length,
      ])),
      settings,
    },
    readout: {
      bestKept: bestKept ? compactRun(bestKept) : null,
      latestFailure: latestFailure ? compactRun(latestFailure) : null,
      nextAction,
      confidenceText: state.confidence == null
        ? "Confidence needs at least three finite metric runs and enough signal over noise."
        : "Confidence compares best movement against median absolute deviation.",
      finalizeText: finalizePreview?.ready
        ? "Ready to preview final review branches."
        : finalizePreview?.nextAction || "Keep evidence or run finalize-preview when ready.",
    },
    commands,
  };
}

function bestRun(runs, direction) {
  let best = null;
  for (const run of runs) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    if (!best || (direction === "higher" ? metric > best.metric : metric < best.metric)) {
      best = { ...run, metric };
    }
  }
  return best;
}

function compactRun(run) {
  return {
    run: run.run,
    metric: run.metric,
    status: run.status,
    description: run.description || "",
    commit: run.commit || "",
    asi: run.asi || {},
  };
}
