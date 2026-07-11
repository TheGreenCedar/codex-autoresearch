import { resolveActionCommand } from "../action-metadata.js";
import {
  assertProjectionBudget,
  projectionBudget,
  resolveSessionDecision,
  type ProjectionBudget,
  type ResolvedDecision,
} from "../session-read-model.js";

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
  resolvedDecision?: unknown;
  operatorChecklist?: unknown;
  runtimeProvenance?: unknown;
  loopContract?: unknown;
  approvalLedger?: unknown;
  resourcePreflight?: unknown;
  evidenceMaturity?: unknown;
  laneOrchestration?: unknown;
  finalizationRunway?: unknown;
  operatorReadout?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  portfolioRecommendation?: unknown;
  sessionDecisionCapsule?: unknown;
  evidenceNotes?: unknown[];
  frictionSignals?: unknown[];
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
  resolvedDecision: ResolvedDecision;
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
  resolvedDecision: ResolvedDecision;
  operatorChecklist?: unknown;
  runtimeProvenance?: unknown;
  loopContract?: unknown;
  approvalLedger?: unknown;
  resourcePreflight?: unknown;
  evidenceMaturity?: unknown;
  laneOrchestration?: unknown;
  finalizationRunway?: unknown;
  operatorReadout?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  portfolioRecommendation?: unknown;
  sessionDecisionCapsule?: unknown;
  evidenceNotes?: unknown[];
  frictionSignals?: unknown[];
}

const DEFAULT_WHY_SAFE =
  "Derived from state, doctor warnings, ASI memory, and dashboard trust state.";
const DEFAULT_AVOIDS =
  "Avoids running a packet before setup, stale-last-run, or trust blockers are resolved.";
const DEFAULT_PROOF = "The next command should update state or clear the blocker.";
const COMPACT_WHY_SAFE =
  "Derived from compact state with the shared resolved decision and finalization authority.";
const COMPACT_AVOIDS =
  "Avoids loading dashboard-only fields while handing off the compact loop contract.";
const COMPACT_PROOF =
  "The primary command comes from compact canonical next action, falling back to compact state.";
const COMPACT_HANDOFF_MAX: ProjectionBudget = { bytes: 5_200, lines: 120, tokens: 1_300 };
const OPTIONAL_RECOMMEND_NEXT_FIELDS = [
  "compactState",
  "operatorChecklist",
  "runtimeProvenance",
  "loopContract",
  "approvalLedger",
  "resourcePreflight",
  "evidenceMaturity",
  "laneOrchestration",
  "finalizationRunway",
  "operatorReadout",
  "laneLifecycle",
  "packetDiagnostics",
  "portfolioRecommendation",
  "sessionDecisionCapsule",
  "evidenceNotes",
  "frictionSignals",
] as const satisfies readonly (keyof RecommendNextResponseInput)[];

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
    resolvedDecision: resolveSessionDecision({
      state: {
        resolvedDecision: input.resolvedDecision,
        decisionEnvelope: input.decisionEnvelope,
        resumeAudit: input.resumeAudit,
        blockers: input.blockers,
        nextAction: input.nextAction,
        runtimeProvenance: input.runtimeProvenance,
        loopContract: input.loopContract,
      },
      decisionEnvelope: input.decisionEnvelope ?? input.resumeAudit,
      commands: input.commands,
      runtimeProvenance: input.runtimeProvenance,
      finalization: input.finalizationRunway,
    }),
  };

  for (const field of OPTIONAL_RECOMMEND_NEXT_FIELDS) {
    copyIfProvided(response, field, input[field]);
  }

  return response;
}

export function buildCompactRecommendNextResponse({
  workDir,
  compactState,
}: CompactRecommendNextResponseInput): RecommendNextResponse {
  const compact = recordOrNull(compactState) || {};
  const resolvedDecision = resolveSessionDecision({
    state: compact,
    decisionEnvelope: compact.decisionEnvelope || compact.resumeAudit,
    commands: compact.commands,
    runtimeProvenance: compact.runtimeProvenance,
  });
  const canonicalNextAction = recordOrNull(resolvedDecision.canonicalNextAction);
  const commands = recordOrNull(compact.commands) || {};
  const explicitCommand = stringOrEmpty(canonicalNextAction?.command);
  const primaryCommand = resolveActionCommand(canonicalNextAction?.kind, commands, {
    explicitCommand,
  });
  const nextAction =
    resolvedDecision.nextAction || stringOrEmpty(compact.nextAction) || "Continue from state.";
  const action = canonicalNextAction
    ? { ...canonicalNextAction, command: primaryCommand }
    : { kind: "compact-state", reason: nextAction, command: primaryCommand };
  const handoff = compactRecommendNextHandoff(compact);
  return enforceCompactHandoffBudget(
    buildRecommendNextResponse({
      ok: compact.ok === false ? false : true,
      workDir: compactHandoffText(workDir),
      action,
      nextAction,
      whySafe: COMPACT_WHY_SAFE,
      avoids: COMPACT_AVOIDS,
      proof: COMPACT_PROOF,
      blockers: Array.isArray(compact.blockers) ? compact.blockers : [],
      commands: primaryCommand ? { primary: primaryCommand } : {},
      nextStep: null,
      compactState: handoff.compactState,
      resolvedDecision,
      operatorReadout: compact.operatorReadout,
      portfolioRecommendation: compact.portfolioRecommendation,
      sessionDecisionCapsule: compact.sessionDecisionCapsule,
      evidenceNotes: handoff.evidenceNotes,
      frictionSignals: handoff.frictionSignals,
    }),
  );
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
  const resolvedDecision = resolveSessionDecision({
    state: {
      resolvedDecision: viewRuntimeBlocker ? undefined : compact?.resolvedDecision,
      decisionEnvelope,
      blockers: compact?.blockers,
      nextAction: compact?.nextAction,
      runtimeProvenance: compact?.runtimeProvenance,
    },
    decisionEnvelope,
    commands: compact?.commands,
    runtimeProvenance: viewRuntimeProvenance || compact?.runtimeProvenance,
  });

  return {
    resolvedDecision,
    decisionEnvelope,
    canonicalNextAction:
      resolvedDecision.canonicalNextAction ||
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

function compactRecommendNextHandoff(compact: JsonObject): {
  compactState: JsonObject;
  evidenceNotes: string[];
  frictionSignals: string[];
} {
  const capsule = recordOrNull(compact.sessionDecisionCapsule);
  const evidenceNotes = stringArray(capsule?.evidence)
    .map((value) => compactHandoffText(value))
    .filter(Boolean)
    .slice(0, 3);
  const frictionSignals = Array.isArray(compact.workflowFriction)
    ? compact.workflowFriction
        .map((value) => compactHandoffText(recordOrNull(value)?.reason || value))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  return {
    compactState: {
      ok: compact.ok !== false,
      workDir: compact.workDir || "",
      name: compact.name || "Autoresearch",
      goal: compact.goal || "",
      metric: compact.metric || "metric",
      direction: compact.direction || "lower",
      segment: compact.segment || 0,
      runs: compact.runs || 0,
      kept: compact.kept || 0,
      discarded: compact.discarded || 0,
      measured: compact.measured || 0,
      blockers: Array.isArray(compact.blockers) ? compact.blockers.slice(0, 3) : [],
      compatibility: compact.compatibility || null,
    },
    evidenceNotes,
    frictionSignals,
  };
}

function enforceCompactHandoffBudget(response: RecommendNextResponse): RecommendNextResponse {
  if (withinCompactHandoffBudget(response)) return response;
  const reduced: RecommendNextResponse = {
    ...response,
    operatorReadout: undefined,
    portfolioRecommendation: undefined,
    sessionDecisionCapsule: undefined,
    evidenceNotes: undefined,
    frictionSignals: undefined,
    action: compactAction(recordOrNull(response.action)) ?? response.action,
  };
  if (withinCompactHandoffBudget(reduced)) return reduced;
  const minimal: RecommendNextResponse = {
    ...reduced,
    whySafe: "Derived from the bounded session read model.",
    avoids: "Drops nonessential handoff detail.",
    proof: "Run commands.primary, then reread state.",
    compactState: null,
    blockers: [],
  };
  assertProjectionBudget(minimal, COMPACT_HANDOFF_MAX, "compact recommend-next");
  return minimal;
}

function compactAction(action: JsonObject | null): JsonObject | null {
  if (!action) return null;
  return {
    kind: action.kind || "unknown",
    reason: compactHandoffText(action.reason),
    command: stringOrEmpty(action.command),
  };
}

function compactHandoffText(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (
    /RAW_TOOL_OUTPUT_BODY_SENTINEL|Original token count:|Chunk ID:|Total output lines:/i.test(text)
  ) {
    return "Large tool output omitted from compact handoff.";
  }
  return text.length <= 360 ? text : `${text.slice(0, 357)}...`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function withinCompactHandoffBudget(value: unknown): boolean {
  const actual = projectionBudget(value);
  return (
    actual.bytes <= COMPACT_HANDOFF_MAX.bytes &&
    actual.lines <= COMPACT_HANDOFF_MAX.lines &&
    actual.tokens <= COMPACT_HANDOFF_MAX.tokens
  );
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
