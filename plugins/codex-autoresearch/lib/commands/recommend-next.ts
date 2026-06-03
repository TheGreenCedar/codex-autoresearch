import { resolveActionCommand } from "../action-metadata.js";

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
  portfolioRecommendation?: unknown;
  sessionDecisionCapsule?: unknown;
}

export interface CompactRecommendNextResponseInput {
  workDir: string;
  compactState: unknown;
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
  portfolioRecommendation?: unknown;
  sessionDecisionCapsule?: unknown;
}

const DEFAULT_WHY_SAFE =
  "Derived from state, doctor warnings, ASI memory, and dashboard trust state.";
const DEFAULT_AVOIDS =
  "Avoids running a packet before setup, stale-last-run, or trust blockers are resolved.";
const DEFAULT_PROOF = "The next command should update state or clear the blocker.";
const COMPACT_WHY_SAFE =
  "Derived from compact state without dashboard-grade rendering or live finalization preview.";
const COMPACT_AVOIDS =
  "Avoids loading dashboard-only fields while handing off the compact loop contract.";
const COMPACT_PROOF =
  "The primary command comes from compact canonical next action, falling back to compact state.";

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
  copyIfProvided(response, "portfolioRecommendation", input.portfolioRecommendation);
  copyIfProvided(response, "sessionDecisionCapsule", input.sessionDecisionCapsule);

  return response;
}

export function buildCompactRecommendNextResponse({
  workDir,
  compactState,
}: CompactRecommendNextResponseInput): RecommendNextResponse {
  const compact = recordOrNull(compactState) || {};
  const canonicalNextAction = recordOrNull(compact.canonicalNextAction);
  const commands = recordOrNull(compact.commands) || {};
  const primaryCommand =
    resolveActionCommand(canonicalNextAction?.kind, commands, {
      explicitCommand: canonicalNextAction?.command,
    }) || stringOrEmpty(commands.state);
  const nextAction =
    stringOrEmpty(canonicalNextAction?.reason) ||
    stringOrEmpty(compact.nextAction) ||
    "Continue from compact state.";
  const action = canonicalNextAction
    ? { ...canonicalNextAction, command: primaryCommand }
    : {
        kind: "compact-state",
        reason: nextAction,
        command: primaryCommand,
      };
  const decisionEnvelope = compact.decisionEnvelope ?? compact.resumeAudit ?? null;

  return buildRecommendNextResponse({
    ok: compact.ok === false ? false : true,
    workDir,
    action,
    nextAction,
    whySafe: COMPACT_WHY_SAFE,
    avoids: COMPACT_AVOIDS,
    proof: COMPACT_PROOF,
    blockers: Array.isArray(compact.blockers) ? compact.blockers : [],
    commands: { ...commands, primary: primaryCommand },
    nextStep: null,
    compactState,
    resumeAudit: compact.resumeAudit ?? decisionEnvelope,
    decisionEnvelope,
    runtimeProvenance: compact.runtimeProvenance,
    loopContract: compact.loopContract,
    laneLifecycle: compact.laneLifecycle,
    packetDiagnostics: compact.packetDiagnostics,
    portfolioRecommendation: compact.portfolioRecommendation,
    sessionDecisionCapsule: compact.sessionDecisionCapsule,
  });
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
  const viewLoopContract = recordOrNull(viewEnvelope?.loopContract);
  const viewLoopBlocker = loopContractBlocksNextPacket(viewLoopContract);
  const decisionEnvelope =
    viewRuntimeBlocker || viewLoopBlocker ? viewEnvelope : compactEnvelope || viewEnvelope;

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

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
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

function loopContractBlocksNextPacket(loopContract: JsonObject | null): boolean {
  if (!loopContract) return false;
  const blockers = Array.isArray(loopContract.blockers) ? loopContract.blockers : [];
  const warnings = Array.isArray(loopContract.warnings) ? loopContract.warnings : [];
  return loopContract.canRunNextPacket === false || blockers.length > 0 || warnings.length > 0;
}
