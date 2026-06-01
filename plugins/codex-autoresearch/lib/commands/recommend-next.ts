type JsonObject = Record<string, unknown>;

export interface RecommendNextResponseInput {
  ok?: boolean;
  workDir: string;
  action?: unknown;
  nextAction?: string;
  whySafe?: string;
  avoids?: string;
  proof?: string;
  blockers?: unknown[];
  commands?: JsonObject;
  nextStep?: unknown;
  compactState?: unknown;
  resumeAudit?: unknown;
  decisionEnvelope?: unknown;
  operatorChecklist?: unknown;
  runtimeProvenance?: unknown;
  loopContract?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  sessionDecisionCapsule?: unknown;
}

interface RecommendNextAuthorityInput {
  viewModel?: JsonObject | null;
  compact?: JsonObject | null;
}

export interface RecommendNextRuntimeAuthority {
  decisionEnvelope: JsonObject | null;
  canonicalNextAction: unknown;
  runtimeProvenance: unknown;
  loopContract: unknown;
}

export interface RecommendNextResponse {
  ok: boolean;
  workDir: string;
  action: unknown;
  nextAction: string;
  whySafe: string;
  avoids: string;
  proof: string;
  blockers: unknown[];
  commands: JsonObject;
  nextStep: unknown;
  compactState?: unknown;
  resumeAudit: unknown;
  decisionEnvelope: unknown;
  operatorChecklist?: unknown;
  runtimeProvenance?: unknown;
  loopContract?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  sessionDecisionCapsule?: unknown;
}

const DEFAULT_WHY_SAFE =
  "Derived from state, doctor warnings, ASI memory, and dashboard trust state.";
const DEFAULT_AVOIDS =
  "Avoids running a packet before setup, stale-last-run, or trust blockers are resolved.";
const DEFAULT_PROOF = "The next command should update state or clear the blocker.";

export function buildRecommendNextResponse(
  input: RecommendNextResponseInput,
): RecommendNextResponse {
  const response: RecommendNextResponse = {
    ok: input.ok ?? true,
    workDir: input.workDir,
    action: input.action ?? null,
    nextAction: input.nextAction || "",
    whySafe: input.whySafe || DEFAULT_WHY_SAFE,
    avoids: input.avoids || DEFAULT_AVOIDS,
    proof: input.proof || DEFAULT_PROOF,
    blockers: Array.isArray(input.blockers) ? input.blockers : [],
    commands: input.commands || {},
    nextStep: input.nextStep ?? null,
    resumeAudit: input.resumeAudit ?? null,
    decisionEnvelope: input.decisionEnvelope ?? input.resumeAudit ?? null,
  };

  copyIfProvided(response, "compactState", input.compactState);
  copyIfProvided(response, "operatorChecklist", input.operatorChecklist);
  copyIfProvided(response, "runtimeProvenance", input.runtimeProvenance);
  copyIfProvided(response, "loopContract", input.loopContract);
  copyIfProvided(response, "laneLifecycle", input.laneLifecycle);
  copyIfProvided(response, "packetDiagnostics", input.packetDiagnostics);
  copyIfProvided(response, "sessionDecisionCapsule", input.sessionDecisionCapsule);

  return response;
}

export function selectRecommendNextRuntimeAuthority({
  viewModel = null,
  compact = null,
}: RecommendNextAuthorityInput): RecommendNextRuntimeAuthority {
  const viewEnvelope = recordOrNull(viewModel?.decisionEnvelope);
  const compactEnvelope =
    recordOrNull(compact?.decisionEnvelope) || recordOrNull(compact?.resumeAudit);
  const viewRuntimeProvenance =
    recordOrNull(viewEnvelope?.runtimeProvenance) ||
    recordOrNull(recordOrNull(viewModel?.processHygiene)?.runtimeDrift);
  const viewRuntimeBlocker = hasRuntimeProvenanceBlocker(viewEnvelope, viewRuntimeProvenance);
  const decisionEnvelope = viewRuntimeBlocker ? viewEnvelope : compactEnvelope || viewEnvelope;

  return {
    decisionEnvelope,
    canonicalNextAction:
      decisionEnvelope?.canonicalNextAction ||
      compact?.canonicalNextAction ||
      compactEnvelope?.canonicalNextAction ||
      null,
    runtimeProvenance: viewRuntimeProvenance || recordOrNull(compact?.runtimeProvenance) || null,
    loopContract: decisionEnvelope?.loopContract || compact?.loopContract || null,
  };
}

function copyIfProvided<T extends object>(target: T, key: string, value: unknown) {
  if (value !== undefined) (target as JsonObject)[key] = value;
}

function recordOrNull(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function hasRuntimeProvenanceBlocker(
  envelope: JsonObject | null,
  runtimeProvenance: JsonObject | null,
): boolean {
  if (
    runtimeProvenance?.drifted === true ||
    runtimeProvenance?.mismatched === true ||
    runtimeProvenance?.stale === true ||
    runtimeProvenance?.needsInspection === true
  ) {
    return true;
  }
  const loopContract = recordOrNull(envelope?.loopContract);
  const blockers = Array.isArray(loopContract?.blockers) ? loopContract.blockers : [];
  return blockers.some((blocker) => recordOrNull(blocker)?.kind === "runtime-provenance");
}
