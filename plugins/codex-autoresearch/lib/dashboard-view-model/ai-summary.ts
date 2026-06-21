import { finiteMetric } from "../session-core.js";
import type { UnknownRecord } from "../types/json.js";

type Direction = "lower" | "higher" | string;

export function buildAiSummary(input: UnknownRecord) {
  const state = recordValue(input.state);
  const current = recordArray(input.current);
  const kept = recordArray(input.kept);
  const failures = recordArray(input.failures);
  const bestKept = recordOrNull(input.bestKept);
  const latestFailure = recordOrNull(input.latestFailure);
  const qualityGap = recordOrNull(input.qualityGap);
  const finalizePreview = recordOrNull(input.finalizePreview);
  const experimentMemory = recordOrNull(input.experimentMemory);
  const warnings = Array.isArray(input.warnings) ? input.warnings : [];
  const nextAction = input.nextAction;
  const nextTitle = cleanText(input.nextTitle);
  const context = summaryMetricContext({ state, current });
  const metricName = recordValue(state.config).metricName || "metric";
  const blockers = [
    ...warnings.map((warning: unknown) => warningMessage(warning)),
    ...(Array.isArray(finalizePreview?.warnings) ? finalizePreview.warnings : []),
  ].filter(Boolean);

  return {
    title: current.length ? "Next move is ready." : "Run a baseline.",
    subtitle: nextTitle || "Ledger, ASI, gap state, and finalization preview.",
    happened: buildSummaryHappened({ current, kept, failures, metricName, ...context }).slice(0, 3),
    plan: unique(
      buildSummaryPlan({ bestKept, latestFailure, qualityGap, nextAction, finalizePreview }),
    ).slice(0, 3),
    blockers: blockers.slice(0, 2),
    generatedFrom: {
      runs: current.length,
      latestRun: context.latest?.run || null,
      latestActionHint: experimentMemory?.latestNextAction || "",
    },
  };
}

function summaryMetricContext({
  state,
  current,
}: {
  state: UnknownRecord;
  current: UnknownRecord[];
}) {
  const config = recordValue(state.config);
  const baseline = finiteMetric(state.baseline);
  const bestMetric = finiteMetric(state.best);
  const latest = current.at(-1) || null;
  return {
    unit: config.metricUnit ? ` ${config.metricUnit}` : "",
    direction: config.bestDirection === "higher" ? "higher is better" : "lower is better",
    baseline,
    bestMetric,
    latest,
    latestMetric: finiteMetric(latest?.metric),
    delta:
      baseline != null && bestMetric != null
        ? percentChange(bestMetric, baseline, String(config.bestDirection || "lower"))
        : null,
  };
}

function buildSummaryHappened({
  current,
  kept,
  failures,
  metricName,
  unit,
  direction,
  baseline,
  bestMetric,
  latest,
  latestMetric,
  delta,
}: UnknownRecord) {
  const currentRuns = Array.isArray(current) ? current : [];
  const keptRuns = Array.isArray(kept) ? kept : [];
  const failedRuns = Array.isArray(failures) ? failures : [];
  const baselineMetric = numberOrNull(baseline);
  const bestMetricValue = numberOrNull(bestMetric);
  const deltaValue = numberOrNull(delta);
  const latestRecord = recordOrNull(latest);
  const latestMetricValue = numberOrNull(latestMetric);
  const metricUnit = cleanText(unit);
  if (!currentRuns.length) {
    return ["No experiments have been logged yet; the loop needs a measured baseline."];
  }
  const happened = [
    `${currentRuns.length} run${currentRuns.length === 1 ? "" : "s"} logged: ${keptRuns.length} kept and ${failedRuns.length} rejected or failed.`,
  ];
  if (baselineMetric != null && bestMetricValue != null) {
    const movement =
      deltaValue == null ? "" : ` (${deltaValue >= 0 ? "+" : ""}${round(deltaValue)}%)`;
    happened.push(
      `The best ${metricName} is ${formatSummaryMetric(bestMetricValue, metricUnit)} against a ${formatSummaryMetric(baselineMetric, metricUnit)} baseline${movement}; ${direction}.`,
    );
  }
  if (latestRecord) {
    happened.push(
      `Most recent run #${latestRecord.run} was ${latestRecord.status}${latestMetricValue == null ? "" : ` at ${formatSummaryMetric(latestMetricValue, metricUnit)}`}.`,
    );
  }
  return happened;
}

function buildSummaryPlan({
  bestKept,
  latestFailure,
  qualityGap,
  nextAction,
  finalizePreview,
}: UnknownRecord) {
  const plan = [];
  const bestKeptRecord = recordOrNull(bestKept);
  const latestFailureRecord = recordOrNull(latestFailure);
  const qualityGapRecord = recordOrNull(qualityGap);
  const finalizePreviewRecord = recordOrNull(finalizePreview);
  if (bestKeptRecord) {
    plan.push(
      `Use kept run #${bestKeptRecord.run} as the comparison anchor unless the next packet beats it.`,
    );
  }
  if (latestFailureRecord) {
    plan.push(
      `Avoid repeating #${latestFailureRecord.run}: ${recordValue(latestFailureRecord.asi).rollback_reason || latestFailureRecord.description || "it did not improve the primary metric"}.`,
    );
  }
  if (qualityGapRecord) {
    plan.push(
      Number(qualityGapRecord.open) > 0
        ? `Work the next accepted gap in ${qualityGapRecord.slug}; ${qualityGapRecord.open} remain open.`
        : `Treat ${qualityGapRecord.slug} as closed unless a fresh gap pass finds credible new work.`,
    );
  }
  if (nextAction) {
    plan.push(nextAction);
  }
  if (finalizePreviewRecord?.ready) {
    plan.push("Preview finalization and package the kept evidence for review.");
  }
  if (!plan.length) {
    plan.push(
      "Capture a clean baseline, then log the decision with ASI before the next experiment.",
    );
  }
  return plan;
}

function percentChange(best: number, baseline: number, direction: Direction): number | null {
  if (!Number.isFinite(best) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return null;
  const raw = ((best - baseline) / Math.abs(baseline)) * 100;
  return direction === "higher" ? raw : -raw;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatSummaryMetric(value: number, unit: string): string {
  return `${round(value)}${unit}`;
}

function unique<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item: T) => {
    const key = String(item || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function warningMessage(warning: unknown): string {
  if (warning && typeof warning === "object") {
    const payload = warning as UnknownRecord;
    return String(payload.message || payload.code || "Warning");
  }
  return String(warning || "");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function recordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(recordValue) : [];
}

function recordValue(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function recordOrNull(value: unknown): UnknownRecord | null {
  const record = recordValue(value);
  return Object.keys(record).length ? record : null;
}
