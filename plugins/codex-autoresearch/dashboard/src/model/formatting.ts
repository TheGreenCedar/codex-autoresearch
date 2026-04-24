import type { MetricDirection, WeightedMetricDefinition } from "../types";
import { finiteMetric, improvementPercent } from "./metrics";

export function formatImprovement(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function formatConfidence(value: number | null | undefined): string {
  if (!finiteMetric(value)) return "-";
  return Number(value)
    .toFixed(2)
    .replace(/\.?0+$/, "");
}

export function formatMetric(value: number | null | undefined, unit = ""): string {
  if (!finiteMetric(value)) return "-";
  const number = Number(value);
  const rounded = Number.isInteger(number)
    ? String(number)
    : number.toFixed(Math.abs(number) < 10 ? 3 : 2).replace(/\.?0+$/, "");
  return `${rounded}${unit || ""}`;
}

export function formatMetricValue(
  value: number | null | undefined,
  definition: WeightedMetricDefinition,
): string {
  if (definition.mode === "weighted_cost") return formatScore(value);
  return formatMetric(value, definition.displayUnit);
}

export function formatChartRunValue(value: number | null | undefined, unit = ""): string {
  return formatMetric(value, unit);
}

export function formatChartPercentValue(
  value: number | null | undefined,
  definition: WeightedMetricDefinition,
): string {
  return definition.mode === "weighted_cost"
    ? formatPercentOfBaseline(value)
    : formatImprovement(value);
}

export function formatCompactMetricTick(
  value: number | null | undefined,
  unit: string | undefined,
  domain: [number, number] | null,
): string {
  if (!Number.isFinite(value)) return "-";
  const number = Number(value);
  const abs = Math.abs(number);
  const divisor = abs >= 1_000_000 ? 1_000_000 : abs >= 1_000 ? 1_000 : 1;
  const suffix = divisor === 1_000_000 ? "M" : divisor === 1_000 ? "k" : "";
  const span = domain ? Math.abs(domain[1] - domain[0]) / divisor : null;
  const compact = `${formatAxisNumber(number / divisor, span)}${suffix}`;
  const unitSuffix = axisUnitSuffix(unit, suffix);
  return `${compact}${unitSuffix}`;
}

export function formatPercentOfBaseline(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "-";
  return `${Number(value)
    .toFixed(Math.abs(Number(value)) < 10 ? 2 : 1)
    .replace(/\.?0+$/, "")}%`;
}

export function formatDelta(
  value: number | null | undefined,
  baseline: number | null | undefined,
  direction: MetricDirection = "lower",
): string {
  if (!finiteMetric(value) || !finiteMetric(baseline) || Number(baseline) === 0) return "-";
  return formatImprovement(improvementPercent(baseline, value, direction));
}

export function directionLabel(direction: MetricDirection | undefined): string {
  return direction === "higher" ? "higher is better" : "lower is better";
}

export function formatDisplayTime(value: Date | string | number | null | undefined): string {
  const date = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function actionLabel(action: string | null | undefined): string {
  const labels: Record<string, string> = {
    doctor: "Run doctor",
    "doctor-explain": "Explain doctor",
    "onboarding-packet": "Build handoff",
    "recommend-next": "Recommend next",
    "benchmark-lint": "Lint benchmark",
    "setup-plan": "Review setup",
    guide: "Show guide",
    recipes: "Show recipes",
    "gap-candidates": "Preview gaps",
    "finalize-preview": "Preview finalization",
    export: "Export snapshot",
    "new-segment-dry-run": "Preview segment",
    "log-keep": "Log keep",
    "log-discard": "Log discard",
    "log-crash": "Log crash",
    "log-checks-failed": "Log failed checks",
  };
  if (action && labels[action]) return labels[action];
  return String(action || "Action")
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatScore(value: number | null | undefined): string {
  if (!finiteMetric(value)) return "-";
  return Number(value).toFixed(2);
}

function formatAxisNumber(value: number, span: number | null): string {
  const absSpan = Math.abs(span ?? value);
  const digits = absSpan < 0.01 ? 3 : absSpan < 0.1 ? 2 : absSpan < 10 ? 1 : 0;
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function axisUnitSuffix(unit: string | undefined, compactSuffix: string): string {
  const trimmed = (unit || "").trim();
  if (!trimmed || compactSuffix || trimmed.toLowerCase() === "score" || trimmed.length > 3)
    return "";
  return trimmed;
}
