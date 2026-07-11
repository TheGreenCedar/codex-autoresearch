import type {
  ChartModel,
  DashboardReadout,
  SessionRun,
  SessionSegment,
  WeightedMetricDefinition,
} from "../types";
import { formatMetricValue } from "./formatting";
import { finiteMetric, round } from "./metrics";
import { metricValueForRun } from "./metric-definition";

interface MeasuredRun {
  run: SessionRun;
  value: number;
}

export function buildChart(session: SessionSegment, readout: DashboardReadout): ChartModel {
  const definition = readout.metricDefinition;
  const measured = measuredRuns(readout, definition);
  const crashRuns = session.runs.filter((run) => run.status === "crash");
  if (!measured.length) {
    return emptyChart(readout);
  }
  const bestRun = readout.bestRun;
  const chartRuns = chartRunsFor(session, definition);
  const values = measured.map((item) => item.value);
  const { domain } = metricDomain(values, readout);
  const latest = chartRuns.at(-1);
  const finiteMetricRunCount = measured.length;
  const points = buildChartPoints({
    allRuns: session.runs,
    bestRun,
    chartRuns,
    definition,
    latest,
  });
  const candidateCrashCount = points.filter((point) => point.run.status === "crash").length;
  const improvesLower = definition.bestDirection !== "higher";
  const winZoneBounds = chartWinZoneBounds(improvesLower, domain, readout.best);
  const latestPoint = points.at(-1);
  const summaryParts = chartSummaryParts({
    bestRun,
    chartRuns,
    crashRuns,
    definition,
    finiteMetricRunCount,
    latest,
    latestPoint,
    candidateCrashCount,
    readout,
    session,
  });
  return {
    points,
    baselineValue: readout.baseline,
    bestValue: readout.best,
    domain,
    winZoneBounds,
    note: chartNote({ crashRuns, finiteMetricRunCount }),
    summary: summaryParts.join(". "),
  };
}

function measuredRuns(
  readout: DashboardReadout,
  definition: WeightedMetricDefinition,
): MeasuredRun[] {
  return readout.plottedRuns
    .map((run) => ({ run, value: metricValueForRun(run, definition) }))
    .filter((item): item is MeasuredRun => finiteMetric(item.value));
}

function chartRunsFor(session: SessionSegment, definition: WeightedMetricDefinition): SessionRun[] {
  return session.runs.filter(
    (run) =>
      run.status === "crash" ||
      run.status === "checks_failed" ||
      finiteMetric(metricValueForRun(run, definition)),
  );
}

function buildChartPoints({
  allRuns,
  bestRun,
  chartRuns,
  definition,
  latest,
}: {
  allRuns: SessionRun[];
  bestRun: SessionRun | null;
  chartRuns: SessionRun[];
  definition: WeightedMetricDefinition;
  latest: SessionRun | undefined;
}) {
  const failureMetrics = heldFailureMetrics(allRuns, definition);
  return chartRuns.map((run) => {
    const heldMetric = holdsNearestMetric(run, definition);
    const chartMetric = heldMetric ? failureMetrics.get(run) : metricValueForRun(run, definition);
    const safeMetric = finiteMetric(chartMetric) ? chartMetric : 0;
    return {
      run,
      chartMetric: safeMetric,
      heldMetric,
      best: bestRun?.run === run.run && run.status === "keep",
      latest: latest?.run === run.run,
    };
  });
}

function chartSummaryParts({
  bestRun,
  chartRuns,
  crashRuns,
  definition,
  finiteMetricRunCount,
  latest,
  latestPoint,
  candidateCrashCount,
  readout,
  session,
}: {
  bestRun: SessionRun | null;
  chartRuns: SessionRun[];
  crashRuns: SessionRun[];
  definition: WeightedMetricDefinition;
  finiteMetricRunCount: number;
  latest: SessionRun | undefined;
  latestPoint: { chartMetric: number } | undefined;
  candidateCrashCount: number;
  readout: DashboardReadout;
  session: SessionSegment;
}): string[] {
  if (finiteMetricRunCount === 1) {
    return [
      "No trend or comparison exists yet",
      "This segment has 1 finite metric run, so the chart only shows the current point",
      "Log another measured run to compare movement",
    ];
  }
  return [
    `${chartRuns.length} chart-eligible runs out of ${session.runs.length} logged runs`,
    latest
      ? `latest plotted #${latest.run} at ${formatMetricValue(latestPoint?.chartMetric ?? null, definition)}`
      : "",
    bestRun
      ? `Best #${bestRun.run} at ${formatMetricValue(readout.best, definition)}`
      : finiteMetric(readout.best)
        ? `Best value ${formatMetricValue(readout.best, definition)} is outside the visible ledger window`
        : "",
    crashSummary(crashRuns.length, candidateCrashCount),
  ].filter(Boolean);
}

function crashSummary(visibleCrashCount: number, candidateCrashCount: number): string {
  if (!visibleCrashCount) return "";
  if (visibleCrashCount !== candidateCrashCount) {
    return `${visibleCrashCount} crash run${visibleCrashCount === 1 ? "" : "s"} in available history; ${candidateCrashCount} chart-eligible at the nearest successful metric level`;
  }
  return `${candidateCrashCount} crash run${
    candidateCrashCount === 1 ? " is" : "s are"
  } available to the adaptive chart at the nearest successful metric level`;
}

function chartNote({
  crashRuns,
  finiteMetricRunCount,
}: {
  crashRuns: SessionRun[];
  finiteMetricRunCount: number;
}) {
  if (finiteMetricRunCount === 1) return "No trend yet: 1 finite metric run.";
  if (crashRuns.length) {
    return `${finiteMetricRunCount} finite measurements; crashes held out of best evidence.`;
  }
  return `${finiteMetricRunCount} finite measurements.`;
}

function emptyChart(readout: DashboardReadout): ChartModel {
  return {
    points: [],
    baselineValue: readout.baseline,
    bestValue: readout.best,
    domain: null,
    winZoneBounds: null,
    note: "No finite plotted metrics yet.",
    summary: "No finite plotted metrics yet.",
  };
}

function metricDomain(values: number[], readout: DashboardReadout) {
  let min = readout.baseline ?? values[0] ?? 0;
  let max = readout.baseline ?? values[0] ?? 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (finiteMetric(readout.best)) {
    min = Math.min(min, readout.best);
    max = Math.max(max, readout.best);
  }
  const rawSpan = max - min;
  const zeroSpanPadding = Math.max(Math.abs(max) * 0.01, 1);
  const domainPadding = rawSpan === 0 ? zeroSpanPadding : rawSpan * 0.12;
  const domain: [number, number] = [round(min - domainPadding), round(max + domainPadding)];
  return { domain };
}

function chartWinZoneBounds(improvesLower: boolean, domain: [number, number], best: number | null) {
  if (!finiteMetric(best)) return null;
  return improvesLower ? { y1: domain[0], y2: best } : { y1: best, y2: domain[1] };
}

function heldFailureMetrics(
  runs: SessionRun[],
  definition: WeightedMetricDefinition,
): Map<SessionRun, number | null> {
  const metrics = new Map<SessionRun, number | null>();
  let nearest: number | null = null;
  for (const run of runs) {
    const candidate = metricValueForRun(run, definition);
    if (!isFailedRun(run) && finiteMetric(candidate)) nearest = candidate;
    else if (holdsNearestMetric(run, definition)) metrics.set(run, nearest);
  }
  nearest = null;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    const candidate = metricValueForRun(run, definition);
    if (!isFailedRun(run) && finiteMetric(candidate)) nearest = candidate;
    else if (holdsNearestMetric(run, definition) && metrics.get(run) == null)
      metrics.set(run, nearest);
  }
  return metrics;
}

function holdsNearestMetric(run: SessionRun, definition: WeightedMetricDefinition): boolean {
  return (
    run.status === "crash" ||
    (run.status === "checks_failed" && !finiteMetric(metricValueForRun(run, definition)))
  );
}

function isFailedRun(run: SessionRun): boolean {
  return run.status === "crash" || run.status === "checks_failed";
}
