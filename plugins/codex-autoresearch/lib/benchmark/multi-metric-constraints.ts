import { unknownRecordOrEmpty, unknownRecordOrNull, type UnknownRecord } from "../types/json.js";

export type SecondaryMetricConstraintMode = "advisory" | "blocking";
export type SecondaryMetricConstraintOperator = "<=" | ">=" | "<" | ">" | "==" | "=";
export type SecondaryMetricConstraintStatus = "passed" | "failed" | "unavailable";

export interface SecondaryMetricConstraint {
  id: string;
  metric: string;
  operator: SecondaryMetricConstraintOperator;
  expression: string;
  threshold: ThresholdExpression;
  mode: SecondaryMetricConstraintMode;
}

export interface SecondaryMetricConstraintResult {
  id: string;
  metric: string;
  operator: SecondaryMetricConstraintOperator;
  expression: string;
  mode: SecondaryMetricConstraintMode;
  status: SecondaryMetricConstraintStatus;
  actual: number | null;
  baseline: number | null;
  threshold: number | null;
  message: string;
}

export interface SecondaryMetricConstraintEvaluation {
  configured: boolean;
  mode: SecondaryMetricConstraintMode;
  status: "not_configured" | "passed" | "failed" | "unavailable";
  blockPromotion: boolean;
  results: SecondaryMetricConstraintResult[];
  failed: SecondaryMetricConstraintResult[];
  unavailable: SecondaryMetricConstraintResult[];
  messages: string[];
}

type ThresholdExpression =
  | { kind: "literal"; value: number; display: string }
  | {
      kind: "baseline";
      multiplier: number;
      offset: number;
      display: string;
    };

const CONSTRAINT_PATTERN = /^([^=\s<>]+)\s*(<=|>=|<|>|==|=)\s*(.+)$/;
const METRIC_NAME_PATTERN = /^[^=\s<>]+$/;

export function normalizeSecondaryMetricConstraintMode(
  value: unknown,
  fallback: SecondaryMetricConstraintMode = "advisory",
): SecondaryMetricConstraintMode {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "advisory" || normalized === "blocking") return normalized;
  throw new Error(
    `secondaryMetricConstraintMode must be advisory or blocking. Got ${String(value)}`,
  );
}

export function normalizeSecondaryMetricConstraints(
  value: unknown,
  defaultMode: SecondaryMetricConstraintMode = "advisory",
): SecondaryMetricConstraint[] {
  const items = constraintItems(value);
  return items.map((item, index) =>
    normalizeSecondaryMetricConstraint(item, defaultMode, index + 1),
  );
}

export function evaluateSecondaryMetricConstraints({
  config = {},
  state = {},
  runMetrics = {},
}: {
  config?: UnknownRecord;
  state?: UnknownRecord;
  runMetrics?: UnknownRecord;
}): SecondaryMetricConstraintEvaluation {
  const mode = normalizeSecondaryMetricConstraintMode(
    config.secondaryMetricConstraintMode ?? config.secondary_metric_constraint_mode,
    "advisory",
  );
  const constraints = normalizeSecondaryMetricConstraints(
    config.secondaryMetricConstraints ?? config.secondary_metric_constraints,
    mode,
  );
  if (constraints.length === 0) {
    return {
      configured: false,
      mode,
      status: "not_configured",
      blockPromotion: false,
      results: [],
      failed: [],
      unavailable: [],
      messages: [],
    };
  }

  const baselineMetrics = baselineMetricMap(state);
  const results = constraints.map((constraint) =>
    evaluateConstraint(constraint, runMetrics, baselineMetrics),
  );
  const failed = results.filter((result) => result.status === "failed");
  const unavailable = results.filter((result) => result.status === "unavailable");
  const blockPromotion = results.some(
    (result) => result.mode === "blocking" && result.status !== "passed",
  );
  const status = failed.length ? "failed" : unavailable.length ? "unavailable" : "passed";
  return {
    configured: true,
    mode,
    status,
    blockPromotion,
    results,
    failed,
    unavailable,
    messages: results
      .filter((result) => result.status !== "passed")
      .map((result) => result.message),
  };
}

function normalizeSecondaryMetricConstraint(
  value: unknown,
  defaultMode: SecondaryMetricConstraintMode,
  index: number,
): SecondaryMetricConstraint {
  if (typeof value === "string") return parseConstraintString(value, defaultMode, index);
  const record = unknownRecordOrNull(value);
  if (!record) {
    throw new Error("secondaryMetricConstraints entries must be strings or objects.");
  }
  const expression = String(record.expression ?? record.rule ?? "").trim();
  const parsed = expression ? parseConstraintString(expression, defaultMode, index) : null;
  const metric = String(record.metric ?? parsed?.metric ?? "").trim();
  const operator = normalizeOperator(record.operator ?? record.op ?? parsed?.operator ?? "<=");
  const mode = normalizeSecondaryMetricConstraintMode(record.mode, parsed?.mode ?? defaultMode);
  if (!METRIC_NAME_PATTERN.test(metric)) {
    throw new Error(`Invalid secondary metric constraint metric: ${metric || "<empty>"}`);
  }
  const threshold = parsed?.threshold || thresholdFromRecord(record);
  const display = `${metric} ${operator} ${threshold.display}`;
  return {
    id: String(record.id ?? parsed?.id ?? safeConstraintId(metric, index)),
    metric,
    operator,
    expression: display,
    threshold,
    mode,
  };
}

function thresholdFromRecord(record: UnknownRecord): ThresholdExpression {
  const thresholdInput = record.threshold ?? record.value ?? record.limit ?? "baseline";
  return typeof thresholdInput === "object"
    ? thresholdFromObject(unknownRecordOrEmpty(thresholdInput))
    : parseThresholdExpression(String(thresholdInput));
}

function parseConstraintString(
  value: string,
  defaultMode: SecondaryMetricConstraintMode,
  index: number,
): SecondaryMetricConstraint {
  const text = value.trim();
  const match = text.match(CONSTRAINT_PATTERN);
  if (!match) {
    throw new Error(
      `Invalid secondary metric constraint '${value}'. Use a form like 'memory_mb <= baseline * 1.05'.`,
    );
  }
  const metric = match[1].trim();
  if (!METRIC_NAME_PATTERN.test(metric)) {
    throw new Error(`Invalid secondary metric constraint metric: ${metric}`);
  }
  const operator = normalizeOperator(match[2]);
  const threshold = parseThresholdExpression(match[3]);
  return {
    id: safeConstraintId(metric, index),
    metric,
    operator,
    expression: `${metric} ${operator} ${threshold.display}`,
    threshold,
    mode: defaultMode,
  };
}

function parseThresholdExpression(value: string): ThresholdExpression {
  const expression = value.trim();
  const literal = numberValue(expression);
  if (literal != null) return { kind: "literal", value: literal, display: String(literal) };
  if (/^baseline$/i.test(expression)) {
    return { kind: "baseline", multiplier: 1, offset: 0, display: "baseline" };
  }
  const multiply = expression.match(/^baseline\s*\*\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/i);
  if (multiply) {
    const multiplier = Number(multiply[1]);
    return {
      kind: "baseline",
      multiplier,
      offset: 0,
      display: `baseline * ${multiplier}`,
    };
  }
  const multiplyPrefix = expression.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*\*\s*baseline$/i);
  if (multiplyPrefix) {
    const multiplier = Number(multiplyPrefix[1]);
    return {
      kind: "baseline",
      multiplier,
      offset: 0,
      display: `${multiplier} * baseline`,
    };
  }
  const offset = expression.match(/^baseline\s*([+-])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/i);
  if (offset) {
    const signedOffset = Number(offset[2]) * (offset[1] === "-" ? -1 : 1);
    return {
      kind: "baseline",
      multiplier: 1,
      offset: signedOffset,
      display: `baseline ${offset[1]} ${Number(offset[2])}`,
    };
  }
  throw new Error(
    `Invalid secondary metric constraint threshold '${value}'. Supported thresholds are numbers, baseline, baseline * N, N * baseline, and baseline +/- N.`,
  );
}

function thresholdFromObject(record: UnknownRecord): ThresholdExpression {
  if (record.kind === "literal" || Object.hasOwn(record, "value")) {
    const value = numberValue(record.value);
    if (value == null) throw new Error("literal secondary metric threshold must be numeric.");
    return { kind: "literal", value, display: String(value) };
  }
  const multiplier = numberValue(record.multiplier) ?? 1;
  const offset = numberValue(record.offset) ?? 0;
  return {
    kind: "baseline",
    multiplier,
    offset,
    display:
      multiplier === 1 && offset === 0
        ? "baseline"
        : `baseline * ${multiplier}${offset ? ` ${offset > 0 ? "+" : "-"} ${Math.abs(offset)}` : ""}`,
  };
}

function evaluateConstraint(
  constraint: SecondaryMetricConstraint,
  runMetrics: UnknownRecord,
  baselineMetrics: UnknownRecord,
): SecondaryMetricConstraintResult {
  const actual = numberValue(runMetrics[constraint.metric]);
  const baseline = numberValue(baselineMetrics[constraint.metric]);
  const threshold =
    constraint.threshold.kind === "literal"
      ? constraint.threshold.value
      : baseline == null
        ? null
        : baseline * constraint.threshold.multiplier + constraint.threshold.offset;
  if (actual == null) {
    return constraintResult(
      constraint,
      "unavailable",
      actual,
      baseline,
      threshold,
      `Secondary metric constraint unavailable: ${constraint.metric} was not emitted.`,
    );
  }
  if (threshold == null) {
    return constraintResult(
      constraint,
      "unavailable",
      actual,
      baseline,
      threshold,
      `Secondary metric constraint unavailable: ${constraint.metric} has no baseline metric.`,
    );
  }
  const passed = compare(actual, constraint.operator, threshold);
  return constraintResult(
    constraint,
    passed ? "passed" : "failed",
    actual,
    baseline,
    threshold,
    passed
      ? `Secondary metric constraint passed: ${constraint.expression}.`
      : `Secondary metric constraint failed: ${constraint.metric}=${actual} does not satisfy ${constraint.operator} ${threshold}.`,
  );
}

function constraintResult(
  constraint: SecondaryMetricConstraint,
  status: SecondaryMetricConstraintStatus,
  actual: number | null,
  baseline: number | null,
  threshold: number | null,
  message: string,
): SecondaryMetricConstraintResult {
  return {
    id: constraint.id,
    metric: constraint.metric,
    operator: constraint.operator,
    expression: constraint.expression,
    mode: constraint.mode,
    status,
    actual,
    baseline,
    threshold,
    message,
  };
}

function baselineMetricMap(state: UnknownRecord): UnknownRecord {
  const current = Array.isArray(state.current) ? state.current : [];
  const config = unknownRecordOrEmpty(state.config);
  const metricName = String(config.metricName || config.metric_name || "");
  const baseline = current.find((run) => baselineEligibleRun(run));
  const record = unknownRecordOrEmpty(baseline);
  const metrics = unknownRecordOrEmpty(record.metrics);
  return {
    ...metrics,
    ...(metricName ? { [metricName]: record.metric } : {}),
  };
}

function baselineEligibleRun(value: unknown): boolean {
  const record = unknownRecordOrNull(value);
  if (!record) return false;
  const status = String(record.status || "");
  if (status === "crash" || status === "checks_failed") return false;
  return numberValue(record.metric) != null;
}

function constraintItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [value];
}

function normalizeOperator(value: unknown): SecondaryMetricConstraintOperator {
  const operator = String(value || "").trim();
  if (operator === "<=" || operator === ">=" || operator === "<" || operator === ">") {
    return operator;
  }
  if (operator === "==" || operator === "=") return operator;
  throw new Error(`Unsupported secondary metric constraint operator: ${operator || "<empty>"}`);
}

function compare(actual: number, operator: SecondaryMetricConstraintOperator, threshold: number) {
  if (operator === "<=") return actual <= threshold;
  if (operator === "<") return actual < threshold;
  if (operator === ">=") return actual >= threshold;
  if (operator === ">") return actual > threshold;
  return actual === threshold;
}

function numberValue(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeConstraintId(metric: string, index: number): string {
  return `${
    metric
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "metric"
  }-${index}`;
}
