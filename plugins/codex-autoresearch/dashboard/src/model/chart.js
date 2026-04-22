import { formatMetric } from "./formatting.js";
import { finiteMetric, round } from "./metrics.js";

export function buildChart(session, readout) {
  const plotted = readout.plottedRuns;
  const clippedCrashes = session.runs.filter((run) => run.status === "crash" && finiteMetric(run.metric)).length;
  if (!plotted.length) {
    return {
      points: [],
      linePath: "",
      baselineY: null,
      bestY: null,
      note: "No finite plotted metrics yet.",
      summary: "No finite plotted metrics yet.",
    };
  }
  const values = plotted.map((run) => run.metric);
  const min = Math.min(...values, readout.baseline ?? values[0], readout.best ?? values[0]);
  const max = Math.max(...values, readout.baseline ?? values[0], readout.best ?? values[0]);
  const span = max - min || Math.max(Math.abs(max), 1);
  const domainPadding = span * 0.12;
  const domain = [round(min - domainPadding), round(max + domainPadding)];
  const xFor = (index) => plotted.length === 1 ? 500 : 52 + (index * 880) / (plotted.length - 1);
  const yFor = (value) => 276 - ((value - min) / span) * 220;
  const bestRun = readout.bestRun;
  const latest = plotted.at(-1);
  const points = plotted.map((run, index) => ({
    run,
    x: round(xFor(index)),
    y: round(yFor(run.metric)),
    best: bestRun?.run === run.run && run.status === "keep",
    latest: latest?.run === run.run,
  }));
  const baselineY = finiteMetric(readout.baseline) ? round(yFor(readout.baseline)) : null;
  const bestY = finiteMetric(readout.best) ? round(yFor(readout.best)) : null;
  const improvesLower = session.config.bestDirection !== "higher";
  const winY = bestY == null ? null : (improvesLower ? 38 : bestY);
  const winHeight = bestY == null ? 0 : (improvesLower ? Math.max(bestY - 38, 0) : Math.max(276 - bestY, 0));
  const summaryParts = [
    `${plotted.length} plotted runs out of ${session.runs.length} logged runs`,
    latest ? `latest plotted #${latest.run} at ${formatMetric(latest.metric, session.config.metricUnit)}` : "",
    bestRun ? `Best #${bestRun.run} at ${formatMetric(bestRun.metric, session.config.metricUnit)}` : "",
    clippedCrashes ? `${clippedCrashes} crash run${clippedCrashes === 1 ? " is" : "s are"} clipped out of the chart scale` : "",
  ].filter(Boolean);
  return {
    points,
    linePath: points.map((point) => `${point.x},${point.y}`).join(" "),
    baselineY,
    bestY,
    baselineValue: readout.baseline,
    bestValue: readout.best,
    domain,
    winZone: bestY == null ? null : { x: 38, y: round(winY), width: 922, height: round(winHeight) },
    winZoneBounds: bestY == null ? null : (improvesLower ? { y1: domain[0], y2: readout.best } : { y1: readout.best, y2: domain[1] }),
    note: `${latest ? `latest plotted #${latest.run}` : "latest plotted -"}${bestRun ? ` / Best ${formatMetric(bestRun.metric, session.config.metricUnit)}` : ""}${clippedCrashes ? ` / clipped ${clippedCrashes} crash` : ""}`,
    summary: summaryParts.join(". "),
  };
}
