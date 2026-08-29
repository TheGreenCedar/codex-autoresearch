import { isUnknownRecord } from "./types/json.js";

type UnknownRecord = Record<string, unknown>;

export interface OperatorSnapshot {
  stage: string;
  strongestBlocker: string | null;
  primaryCommand: string;
  nextAction: string;
  metricEvidence: {
    metric: string;
    direction: string;
    runs: number;
    best: number | null;
    qualityGap: unknown;
  };
  runtimeTrust: unknown;
  stateStorage: unknown;
  dirtyClassification: unknown;
  discrepancies: string[];
  diagnosticCommand: string;
}

export function buildOperatorSnapshot({
  state,
  recommendation,
  doctor,
}: {
  state: unknown;
  recommendation?: unknown;
  doctor?: unknown;
}): OperatorSnapshot {
  const stateRecord = record(state);
  const recommendationRecord = record(recommendation);
  const doctorRecord = record(doctor);
  const decisions = [doctorRecord, recommendationRecord, stateRecord]
    .map(publicDecisionPlan)
    .filter((decision) => Object.keys(decision).length > 0);
  const canonical = decisions[0] || {};
  const action = record(canonical.action);
  const runs = finiteInteger(stateRecord.runs);
  const blocker = text(canonical.primaryBlockerCode) || null;
  const commands = record(stateRecord.commands);
  const primaryCommand =
    text(action.command) || text(record(recommendationRecord.commands).primary) || "";
  return {
    stage: text(canonical.phase) || "recovery",
    strongestBlocker: blocker,
    primaryCommand,
    nextAction:
      text(action.reason) ||
      matchingProjectedText(canonical, recommendationRecord, "nextAction") ||
      "Decision unavailable.",
    metricEvidence: {
      metric: text(stateRecord.metric) || text(record(stateRecord.config).metricName) || "metric",
      direction:
        text(stateRecord.direction) || text(record(stateRecord.config).bestDirection) || "lower",
      runs,
      best: finiteNumber(stateRecord.best),
      qualityGap: stateRecord.qualityGap ?? null,
    },
    runtimeTrust:
      stateRecord.runtimeProvenance ||
      doctorRecord.runtimeProvenance ||
      doctorRecord.runtimeDriftSummary ||
      null,
    stateStorage:
      stateRecord.stateStorage ||
      stateRecord.privateState ||
      doctorRecord.stateStorage ||
      doctorRecord.privateState ||
      null,
    dirtyClassification: stateRecord.sourceCleanliness || null,
    discrepancies: decisionDiscrepancies(decisions),
    diagnosticCommand: text(commands.state) || text(commands.doctor) || primaryCommand,
  };
}

function publicDecisionPlan(value: UnknownRecord): UnknownRecord {
  const plan = record(value.decisionPlan);
  if (plan.kind === "decision-plan") return plan;
  const projection = record(value.decisionPlanProjection);
  return projection.kind === "decision-plan-projection" ||
    projection.kind === "dashboard-decision-plan-projection"
    ? projection
    : {};
}

function decisionDiscrepancies(decisions: UnknownRecord[]): string[] {
  if (decisions.length < 2) return [];
  const fields = ["decisionId", "generationId", "phase", "primaryBlockerCode"] as const;
  return fields
    .filter((field) => new Set(decisions.map((decision) => text(decision[field]))).size > 1)
    .map((field) => `decisionPlan.${field} differs across public readouts`);
}

function matchingProjectedText(
  canonical: UnknownRecord,
  projection: UnknownRecord,
  field: string,
): string {
  const projectedPlan = publicDecisionPlan(projection);
  return text(projectedPlan.decisionId) === text(canonical.decisionId)
    ? text(projection[field])
    : "";
}

function record(value: unknown): UnknownRecord {
  return isUnknownRecord(value) ? value : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 4_000) : "";
}

function finiteInteger(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
