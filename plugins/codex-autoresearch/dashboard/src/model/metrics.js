export function finiteMetric(value) {
  return Number.isFinite(Number(value));
}

export function numericOrNull(value) {
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
