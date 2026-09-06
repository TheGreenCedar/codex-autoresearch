import { isUnknownRecord } from "./types/json.js";

/** Independent dimensions: a valid counterexample is neither an execution failure nor a keep. */
export interface ResultSemantics {
  execution: "completed" | "failed" | "unknown";
  validity: "valid" | "invalid" | "unknown";
  conclusion: "supported" | "refuted" | "inconclusive";
  movement: "improved" | "regressed" | "neutral" | "unknown";
  attainment: "satisfied" | "unsatisfied" | "unknown" | "not-assessed";
  codeAcceptance: "accepted" | "rejected" | "unassessed";
}

export type EvaluatorObservation =
  | { kind: "invalid"; execution: ResultSemantics["execution"] }
  | { kind: "predicate"; observed: "satisfied" | "counterexample" | "inconclusive" }
  | {
      kind: "metric";
      value: number;
      reference: number | null;
      direction: "lower" | "higher" | "none";
      minimumImprovement: number;
      tolerance: number;
      target: null | { comparator: "<" | "<=" | "=" | ">=" | ">"; value: number };
    };

export function classifyResult(
  observation: EvaluatorObservation,
  codeAcceptance: ResultSemantics["codeAcceptance"] = "unassessed",
): ResultSemantics {
  const base: ResultSemantics = {
    execution: "unknown",
    validity: "unknown",
    conclusion: "inconclusive",
    movement: "unknown",
    attainment: "unknown",
    codeAcceptance,
  };
  if (observation.kind === "invalid")
    return {
      ...base,
      execution: observation.execution,
      validity: observation.execution === "unknown" ? "unknown" : "invalid",
    };
  if (observation.kind === "predicate")
    return {
      ...base,
      execution: "completed",
      validity: "valid",
      conclusion:
        observation.observed === "satisfied"
          ? "supported"
          : observation.observed === "counterexample"
            ? "refuted"
            : "inconclusive",
      attainment:
        observation.observed === "satisfied"
          ? "satisfied"
          : observation.observed === "counterexample"
            ? "unsatisfied"
            : "unknown",
    };
  if (
    ![observation.value, observation.minimumImprovement, observation.tolerance].every(
      Number.isFinite,
    ) ||
    (observation.reference !== null && !Number.isFinite(observation.reference)) ||
    (observation.target !== null && !Number.isFinite(observation.target.value)) ||
    observation.minimumImprovement < 0 ||
    observation.tolerance < 0
  )
    return { ...base, execution: "completed", validity: "invalid" };
  const difference =
    observation.reference === null || observation.direction === "none"
      ? null
      : observation.direction === "lower"
        ? observation.reference - observation.value
        : observation.value - observation.reference;
  const movement: ResultSemantics["movement"] =
    difference === null
      ? "unknown"
      : difference > 0 &&
          difference >= observation.minimumImprovement &&
          difference > observation.tolerance
        ? "improved"
        : difference < -observation.tolerance
          ? "regressed"
          : "neutral";
  const attainment =
    observation.target === null
      ? "not-assessed"
      : meetsTarget(observation.value, observation.target.comparator, observation.target.value)
        ? "satisfied"
        : "unsatisfied";
  return { ...base, execution: "completed", validity: "valid", movement, attainment };
}

export function meetsTarget(value: number, comparator: string, target: number): boolean {
  switch (comparator) {
    case "<":
      return value < target;
    case "<=":
      return value <= target;
    case "=":
      return value === target;
    case ">=":
      return value >= target;
    case ">":
      return value > target;
    default:
      throw new Error("Unsupported criterion comparator.");
  }
}

export function isResultSemantics(value: unknown): value is ResultSemantics {
  if (!isUnknownRecord(value)) return false;
  return [
    ["execution", ["completed", "failed", "unknown"]],
    ["validity", ["valid", "invalid", "unknown"]],
    ["conclusion", ["supported", "refuted", "inconclusive"]],
    ["movement", ["improved", "regressed", "neutral", "unknown"]],
    ["attainment", ["satisfied", "unsatisfied", "unknown", "not-assessed"]],
    ["codeAcceptance", ["accepted", "rejected", "unassessed"]],
  ].every(
    ([key, values]) =>
      Array.isArray(values) &&
      typeof key === "string" &&
      typeof value[key] === "string" &&
      values.includes(value[key]),
  );
}
