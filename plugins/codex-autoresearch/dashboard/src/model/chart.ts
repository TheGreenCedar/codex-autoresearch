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

export function buildChart(session: SessionSegment, readout: DashboardReadout): ChartModel {
  const definition = readout.metricDefinition;
  const measured = readout.plottedRuns
    .map((run) => ({ run, value: metricValueForRun(run, definition) }))
    .filter((item) => finiteMetric(item.value));
  const crashRuns = session.runs.filter((run) => run.status === "crash");
  if (!measured.length) {
    return {
      points: [],
      linePath: "",
      baselineY: null,
      bestY: null,
      baselineValue: readout.baseline,
      bestValue: readout.best,
      domain: null,
      winZone: null,
      winZoneBounds: null,
      note: "No finite plotted metrics yet.",
      summary: "No finite plotted metrics yet.",
    };
  }
  const chartRuns = session.runs.filter(
    (run) => run.status === "crash" || finiteMetric(metricValueForRun(run, definition)),
  );
  const values = measured.map((item) => item.value as number);
  const min = Math.min(...values, readout.baseline ?? values[0], readout.best ?? values[0]);
  const max = Math.max(...values, readout.baseline ?? values[0], readout.best ?? values[0]);
  const span = max - min || Math.max(Math.abs(max), 1);
  const domainPadding = span * 0.12;
  const domain: [number, number] = [round(min - domainPadding), round(max + domainPadding)];
  const xFor = (index: number) =>
    chartRuns.length === 1 ? 500 : 52 + (index * 880) / (chartRuns.length - 1);
  const yFor = (value: number) => 276 - ((value - min) / span) * 220;
  const bestRun = readout.bestRun;
  const latest = chartRuns.at(-1);
  const points = chartRuns.map((run, index) => {
    const heldMetric = run.status === "crash";
    const chartMetric = heldMetric
      ? heldCrashMetric(session.runs, run, definition)
      : metricValueForRun(run, definition);
    const safeMetric = finiteMetric(chartMetric) ? chartMetric : 0;
    return {
      run,
      chartMetric: safeMetric,
      heldMetric,
      x: round(xFor(index)),
      y: round(yFor(safeMetric)),
      best: bestRun?.run === run.run && run.status === "keep",
      latest: latest?.run === run.run,
    };
  });
  const baselineY = finiteMetric(readout.baseline) ? round(yFor(readout.baseline)) : null;
  const bestY = finiteMetric(readout.best) ? round(yFor(readout.best)) : null;
  const improvesLower = definition.bestDirection !== "higher";
  const winY = bestY == null ? null : improvesLower ? 38 : bestY;
  const winHeight =
    bestY == null ? 0 : improvesLower ? Math.max(bestY - 38, 0) : Math.max(276 - bestY, 0);
  const latestPoint = points.at(-1);
  const summaryParts = [
    `${chartRuns.length} plotted runs out of ${session.runs.length} logged runs`,
    latest
      ? `latest plotted #${latest.run} at ${formatMetricValue(latestPoint?.chartMetric ?? null, definition)}`
      : "",
    bestRun ? `Best #${bestRun.run} at ${formatMetricValue(readout.best, definition)}` : "",
    crashRuns.length
      ? `${crashRuns.length} crash run${crashRuns.length === 1 ? " is" : "s are"} plotted at the nearest successful metric level`
      : "",
  ].filter(Boolean);
  return {
    points,
    linePath: points.map((point) => `${point.x},${point.y}`).join(" "),
    baselineY,
    bestY,
    baselineValue: readout.baseline,
    bestValue: readout.best,
    domain,
    winZone:
      bestY == null
        ? null
        : { x: 38, y: round(winY as number), width: 922, height: round(winHeight) },
    winZoneBounds:
      bestY == null
        ? null
        : improvesLower
          ? { y1: domain[0], y2: readout.best as number }
          : { y1: readout.best as number, y2: domain[1] },
    note: `${latest ? `latest plotted #${latest.run}` : "latest plotted -"}${bestRun ? ` / Best ${formatMetricValue(readout.best, definition)}` : ""}${crashRuns.length ? ` / ${crashRuns.length} crash held` : ""}`,
    summary: summaryParts.join(". "),
  };
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
