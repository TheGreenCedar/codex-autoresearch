export function finiteMetric(value) {
  return numericOrNull(value) != null;
}

export function numericOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function improvementPercent(baseline, best, direction = "lower") {
  if (!finiteMetric(baseline) || !finiteMetric(best) || Number(baseline) === 0) return null;
  const raw = direction === "higher"
    ? (Number(best) - Number(baseline)) / Math.abs(Number(baseline))
    : (Number(baseline) - Number(best)) / Math.abs(Number(baseline));
  return raw * 100;
}

export function round(value) {
  return Math.round(value * 100) / 100;
}
