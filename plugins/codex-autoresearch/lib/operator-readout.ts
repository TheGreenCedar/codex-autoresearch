import { isUnknownRecord } from "./types/json.js";

export interface OperatorReadout {
  blockers: string[];
  canonicalNextAction: unknown;
  dashboardMutationAllowed: false;
  nextAction: string;
  runtimeProvenance: unknown;
  warnings: string[];
}

export function buildOperatorReadout({
  canonicalNextAction = null,
  loopContract = null,
  runtimeProvenance = null,
}: {
  canonicalNextAction?: unknown;
  loopContract?: unknown;
  runtimeProvenance?: unknown;
} = {}): OperatorReadout {
  const contract = isUnknownRecord(loopContract) ? loopContract : {};
  const action = isUnknownRecord(canonicalNextAction) ? canonicalNextAction : {};
  const blockers = Array.isArray(contract.blockers)
    ? contract.blockers.map(actionReason).filter(Boolean)
    : [];
  const warnings = Array.isArray(contract.warnings)
    ? contract.warnings.map(actionReason).filter(Boolean)
    : [];
  return {
    canonicalNextAction,
    nextAction: actionReason(action) || "Run doctor, then next.",
    blockers,
    warnings,
    runtimeProvenance,
    dashboardMutationAllowed: false,
  };
}

function actionReason(value: unknown): string {
  if (!isUnknownRecord(value)) return String(value ?? "").trim();
  return String(value.reason || value.message || value.kind || "").trim();
}
