//#region dashboard/src/model/formatting.ts
function formatCompactMetricTick(value, unit, domain) {
	if (!Number.isFinite(value)) return "-";
	const number = Number(value);
	const abs = Math.abs(number);
	const divisor = abs >= 1e6 ? 1e6 : abs >= 1e3 ? 1e3 : 1;
	const suffix = divisor === 1e6 ? "M" : divisor === 1e3 ? "k" : "";
	const span = domain ? Math.abs(domain[1] - domain[0]) / divisor : null;
	return `${`${formatAxisNumber(number / divisor, span)}${suffix}`}${axisUnitSuffix(unit, suffix)}`;
}
function formatAxisNumber(value, span) {
	const absSpan = Math.abs(span ?? value);
	const digits = absSpan < .01 ? 3 : absSpan < .1 ? 2 : absSpan < 10 ? 1 : 0;
	return value.toFixed(digits).replace(/\.?0+$/, "");
}
function axisUnitSuffix(unit, compactSuffix) {
	const trimmed = (unit || "").trim();
	if (!trimmed || compactSuffix || trimmed.toLowerCase() === "score" || trimmed.length > 3) return "";
	return trimmed;
}
//#endregion
export { formatCompactMetricTick };
