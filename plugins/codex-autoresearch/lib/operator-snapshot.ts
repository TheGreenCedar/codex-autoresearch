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
  const actions = [stateRecord, recommendationRecord, doctorRecord]
    .map(publicCanonicalAction)
    .filter((action) => Object.keys(action).length > 0);
  const canonical = actions[0] || {};
  const runs = finiteInteger(stateRecord.runs);
  const kind = text(canonical.kind) || (runs === 0 ? "next-packet" : "inspect-state");
  const blockers = array(record(record(stateRecord.resolvedDecision).loopContract).blockers)
    .map(actionReason)
    .filter(Boolean);
  const commands = record(stateRecord.commands);
  const primaryCommand =
    text(canonical.command) ||
    text(record(recommendationRecord.commands).primary) ||
    text(commands.next) ||
    text(commands.state);
  return {
    stage: stageFor(kind, runs),
    strongestBlocker: blockers[0] || null,
    primaryCommand,
    nextAction: text(canonical.reason) || text(stateRecord.nextAction) || "Inspect state.",
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
    discrepancies: actionDiscrepancies(actions),
    diagnosticCommand: text(commands.state) || text(commands.doctor) || primaryCommand,
  };
}

function publicCanonicalAction(value: UnknownRecord): UnknownRecord {
  const resolved = record(value.resolvedDecision);
  return record(resolved.canonicalNextAction || value.canonicalNextAction);
}

function actionDiscrepancies(actions: UnknownRecord[]): string[] {
  if (actions.length < 2) return [];
  const fields = ["kind", "reason", "command"] as const;
  return fields
    .filter((field) => new Set(actions.map((action) => text(action[field]))).size > 1)
    .map((field) => `canonicalNextAction.${field} differs across public readouts`);
}

function stageFor(kind: string, runs: number): string {
  if (runs === 0 && /next|baseline|setup/.test(kind)) return "needs-baseline";
  if (/log/.test(kind)) return "needs-log-decision";
  if (/finaliz/.test(kind)) return "ready-for-finalization";
  if (/runtime|doctor|drift/.test(kind)) return "needs-runtime-repair";
  if (/block|stale|conflict|safety/.test(kind)) return "blocked";
  return "measured-loop";
}

function actionReason(value: unknown): string {
  const action = record(value);
  return text(action.reason || action.message || action.kind || value);
}

function record(value: unknown): UnknownRecord {
  return isUnknownRecord(value) ? value : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
