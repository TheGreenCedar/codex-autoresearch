import { finiteMetric, improvementPercent } from "./metrics.js";

export function formatImprovement(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function formatConfidence(value) {
  if (!finiteMetric(value)) return "-";
  const number = Number(value);
  return number.toFixed(2).replace(/\.?0+$/, "");
}

export function formatMetric(value, unit = "") {
  if (!finiteMetric(value)) return "-";
  const number = Number(value);
  const rounded = Number.isInteger(number) ? String(number) : number.toFixed(Math.abs(number) < 10 ? 3 : 2).replace(/\.?0+$/, "");
  return `${rounded}${unit || ""}`;
}

export function formatChartRunValue(value, unit = "") {
  return formatMetric(value, unit);
}

export function formatDelta(value, baseline, direction = "lower") {
  if (!finiteMetric(value) || !finiteMetric(baseline) || Number(baseline) === 0) return "0%";
  return formatImprovement(improvementPercent(baseline, value, direction));
}

export function directionLabel(direction) {
  return direction === "higher" ? "higher is better" : "lower is better";
}

export function formatDisplayTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function actionLabel(action) {
  return String(action || "Action").split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ");
}
