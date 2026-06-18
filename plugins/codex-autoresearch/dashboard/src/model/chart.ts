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

export const DASHBOARD_CHART_MAX_POINTS = 500;

export function buildChart(session: SessionSegment, readout: DashboardReadout): ChartModel {
  const definition = readout.metricDefinition;
  const measured = measuredRuns(readout, definition);
  const crashRuns = session.runs.filter((run) => run.status === "crash");
  if (!measured.length) {
    return emptyChart(readout);
  }
  const bestRun = readout.bestRun;
  const chartRuns = chartRunsFor(session, definition, bestRun ? [bestRun] : []);
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
  const plottedCrashCount = points.filter((point) => point.heldMetric).length;
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
    plottedCrashCount,
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

function chartRunsFor(
  session: SessionSegment,
  definition: WeightedMetricDefinition,
  anchors: SessionRun[] = [],
): SessionRun[] {
  return downsampleChartRuns(
    session.runs.filter(
      (run) => run.status === "crash" || finiteMetric(metricValueForRun(run, definition)),
    ),
    anchors,
  );
}

function downsampleChartRuns(runs: SessionRun[], anchors: SessionRun[]): SessionRun[] {
  if (runs.length <= DASHBOARD_CHART_MAX_POINTS) return runs;
  const selected = new Set<SessionRun>();
  const runSet = new Set(runs);
  const add = (run: SessionRun | null | undefined) => {
    if (run && runSet.has(run)) selected.add(run);
  };
  add(runs[0]);
  add(runs.at(-1));
  for (const anchor of anchors) add(anchor);
  const remainingSlots = Math.max(1, DASHBOARD_CHART_MAX_POINTS - selected.size);
  const step = Math.max(1, Math.ceil((runs.length - selected.size) / remainingSlots));
  for (
    let index = 1;
    index < runs.length - 1 && selected.size < DASHBOARD_CHART_MAX_POINTS;
    index += step
  ) {
    selected.add(runs[index]);
  }
  return runs.filter((run) => selected.has(run));
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
  return chartRuns.map((run) => {
    const heldMetric = run.status === "crash";
    const chartMetric = heldMetric
      ? heldCrashMetric(allRuns, run, definition)
      : metricValueForRun(run, definition);
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
  plottedCrashCount,
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
  plottedCrashCount: number;
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
    `${chartRuns.length} plotted runs out of ${session.runs.length} logged runs`,
    latest
      ? `latest plotted #${latest.run} at ${formatMetricValue(latestPoint?.chartMetric ?? null, definition)}`
      : "",
    bestRun
      ? `Best #${bestRun.run} at ${formatMetricValue(readout.best, definition)}`
      : finiteMetric(readout.best)
        ? `Best value ${formatMetricValue(readout.best, definition)} is outside the visible ledger window`
        : "",
    crashSummary(crashRuns.length, plottedCrashCount),
  ].filter(Boolean);
}

function crashSummary(visibleCrashCount: number, plottedCrashCount: number): string {
  if (!visibleCrashCount) return "";
  if (visibleCrashCount !== plottedCrashCount) {
    return `${visibleCrashCount} crash run${visibleCrashCount === 1 ? "" : "s"} in visible history; ${plottedCrashCount} plotted after downsampling at the nearest successful metric level`;
  }
  return `${plottedCrashCount} crash run${
    plottedCrashCount === 1 ? " is" : "s are"
  } plotted at the nearest successful metric level`;
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

function heldCrashMetric(
  runs: SessionRun[],
  crashRun: SessionRun,
  definition: WeightedMetricDefinition,
): number | null {
  const index = runs.indexOf(crashRun);
  for (let offset = index - 1; offset >= 0; offset -= 1) {
    const candidate = metricValueForRun(runs[offset], definition);
    if (runs[offset]?.status !== "crash" && finiteMetric(candidate)) return candidate;
  }
  for (let offset = index + 1; offset < runs.length; offset += 1) {
    const candidate = metricValueForRun(runs[offset], definition);
    if (runs[offset]?.status !== "crash" && finiteMetric(candidate)) return candidate;
  }
  return readNumber(metricValueForRun(crashRun, definition));
}

function readNumber(value: number | null): number {
  return Number.isFinite(value) ? Number(value) : 0;
}
