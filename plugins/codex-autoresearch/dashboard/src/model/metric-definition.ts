import type {
  RunMetricBreakdown,
  SessionConfig,
  SessionRun,
  SessionSegment,
  WeightedMetricDefinition,
} from "../types";
import { finiteMetric, improvementPercent, numericOrNull, round } from "./metrics";

const DEFAULT_MEMORY_KEY = "memory_mb";
const DEFAULT_WEIGHTS = Object.freeze({ time: 0.7, memory: 0.3 });

export function resolveMetricDefinition(session: SessionSegment): WeightedMetricDefinition {
  const requestedMode = requestedMetricMode(session.config);
  const baselineRun = baselineCandidate(session.runs);
  const normalizedWeights = normalizedWeightsFor(session.config);
  const memoryKey = memoryKeyFor(session.config);
  const baselineTime = baselineRun?.metric ?? null;
  const baselineMemory = metricValueFromRun(baselineRun, memoryKey);
  const missingMemoryRun = session.runs.find(
    (run) => needsWeightedEvidence(run) && !finiteMetric(metricValueFromRun(run, memoryKey)),
  );
  const fallbackNote =
    requestedMode !== "weighted_cost"
      ? ""
      : !finiteMetric(baselineTime) || !finiteMetric(baselineMemory)
        ? "Memory component unavailable for the baseline packet, so this session is rendering the raw primary metric."
        : missingMemoryRun
          ? `Memory component unavailable for run #${missingMemoryRun.run}, so this session is rendering the raw primary metric.`
          : "";
  const mode = requestedMode === "weighted_cost" && !fallbackNote ? "weighted_cost" : "raw";
  const metricName =
    mode === "weighted_cost" ? "Weighted cost" : session.config.metricName || "metric";
  const formulaText = configuredFormula(session.config);
  return {
    requestedMode,
    mode,
    metricName,
    displayUnit: mode === "weighted_cost" ? "" : session.config.metricUnit || "",
    bestDirection: session.config.bestDirection || "lower",
    valueLabel: mode === "weighted_cost" ? "Score" : "Real value",
    percentLabel: mode === "weighted_cost" ? "% of baseline" : "Percent",
    weights: normalizedWeights,
    memoryKey,
    formulaInline:
      mode === "weighted_cost" ? "score = 0.7 * time_score + 0.3 * memory_score" : formulaText,
    formulaDetails: formulaText,
    fallbackNote,
    baselineMetric: mode === "weighted_cost" && !fallbackNote ? 1 : (baselineRun?.metric ?? null),
    baselineTime,
    baselineMemory,
  };
}

export function breakdownForRun(
  run: SessionRun | null | undefined,
  definition: WeightedMetricDefinition,
): RunMetricBreakdown | null {
  if (!run) return null;
  const timeValue = run.metric;
  const memoryValue = metricValueFromRun(run, definition.memoryKey);
  const timeScore = scoreComponent(timeValue, definition.baselineTime);
  const memoryScore = scoreComponent(memoryValue, definition.baselineMemory);
  const metricValue = metricValueForRun(run, definition);
  return {
    run,
    metricValue,
    chartPercentValue: chartPercentValue(metricValue, definition),
    improvement: improvementPercent(
      definition.baselineMetric,
      metricValue,
      definition.bestDirection,
    ),
    timeValue,
    timeScore,
    memoryValue,
    memoryScore,
    weightedTime:
      definition.mode === "weighted_cost" && timeScore != null
        ? round(definition.weights.time * timeScore)
        : null,
    weightedMemory:
      definition.mode === "weighted_cost" && memoryScore != null
        ? round(definition.weights.memory * memoryScore)
        : null,
  };
}

export function metricValueForRun(
  run: SessionRun | null | undefined,
  definition: WeightedMetricDefinition,
): number | null {
  if (!run) return null;
  if (definition.mode !== "weighted_cost") return run.metric;
  const timeScore = scoreComponent(run.metric, definition.baselineTime);
  const memoryScore = scoreComponent(
    metricValueFromRun(run, definition.memoryKey),
    definition.baselineMemory,
  );
  if (timeScore == null || memoryScore == null) return null;
  return round(definition.weights.time * timeScore + definition.weights.memory * memoryScore);
}

export function chartPercentValue(
  metricValue: number | null,
  definition: WeightedMetricDefinition,
): number | null {
  if (definition.mode !== "weighted_cost") return metricValue;
  if (
    !finiteMetric(metricValue) ||
    !finiteMetric(definition.baselineMetric) ||
    Number(definition.baselineMetric) === 0
  )
    return null;
  return round((Number(metricValue) / Number(definition.baselineMetric)) * 100);
}

function baselineCandidate(runs: SessionRun[]): SessionRun | null {
  const kept = runs.find((run) => run.status === "keep" && finiteMetric(run.metric));
  if (kept) return kept;
  return runs.find((run) => run.status !== "crash" && finiteMetric(run.metric)) || null;
}

function requestedMetricMode(config: SessionConfig): "raw" | "weighted_cost" {
  const nested = config.metricDefinition?.mode;
  if (nested === "raw" || nested === "weighted_cost") return nested;
  return config.metricMode === "weighted_cost" ? "weighted_cost" : "raw";
}

function memoryKeyFor(config: SessionConfig): string {
  return String(
    config.metricDefinition?.memoryKey ||
      config.metricMemoryKey ||
      config.memoryKey ||
      DEFAULT_MEMORY_KEY,
  );
}

function normalizedWeightsFor(config: SessionConfig) {
  const source = config.metricDefinition?.weights || config.metricWeights || DEFAULT_WEIGHTS;
  const time = numericOrNull(source?.time) ?? DEFAULT_WEIGHTS.time;
  const memory = numericOrNull(source?.memory) ?? DEFAULT_WEIGHTS.memory;
  const total = time + memory;
  if (!Number.isFinite(total) || total <= 0) return { ...DEFAULT_WEIGHTS };
  return {
    time: round(time / total),
    memory: round(memory / total),
  };
}

function configuredFormula(config: SessionConfig): string {
  const configured =
    config.metricDefinition?.formulaText ||
    config.formulaText ||
    config.metricFormula ||
    config.metric_formula;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const metricName = config.metricName || "metric";
  return `${metricName} = primary benchmark value emitted as METRIC ${metricName}=<number>; ${config.bestDirection === "higher" ? "higher is better" : "lower is better"}.`;
}

function metricValueFromRun(run: SessionRun | null | undefined, key: string): number | null {
  if (!run) return null;
  return numericOrNull(run.metrics?.[key]);
}

function needsWeightedEvidence(run: SessionRun): boolean {
  return run.status !== "crash" && finiteMetric(run.metric);
}

function scoreComponent(value: number | null, baseline: number | null): number | null {
  if (!finiteMetric(value) || !finiteMetric(baseline) || Number(baseline) === 0) return null;
  return round(Number(value) / Number(baseline));
}
