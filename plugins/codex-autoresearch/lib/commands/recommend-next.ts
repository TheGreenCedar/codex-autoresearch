import { actionToolNameForKind } from "../action-metadata.js";
import {
  projectCompactDecisionPlan,
  projectResolvedDecision,
  type ProjectedResolvedDecision,
} from "../decision-projection.js";
import type { DecisionPlan } from "../decision-compiler.js";
import { unknownRecordOrNull as recordOrNull } from "../types/json.js";
import {
  assertProjectionBudget,
  projectionBudget,
  type ProjectionBudget,
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
  decisionPlan: DecisionPlan;
  decisionPlanProjection?: unknown;
  operatorChecklist?: unknown;
  runtimeProvenance?: unknown;
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
  decisionPlanProjection?: unknown;
  resolvedDecision?: ProjectedResolvedDecision;
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
  const decisionPlan = input.decisionPlan;
  const resolvedDecision = projectResolvedDecision(decisionPlan);
  const action = {
    ...resolvedDecision.canonicalNextAction,
    toolName: actionToolNameForKind(decisionPlan.action.kind),
  };
  const response: RecommendNextResponse = {
    ok: input.ok ?? true,
    workDir: input.workDir,
    action,
    nextAction: decisionPlan.action.reason,
    whySafe: input.whySafe || DEFAULT_WHY_SAFE,
    avoids: input.avoids || DEFAULT_AVOIDS,
    proof: input.proof || DEFAULT_PROOF,
    blockers: Array.isArray(resolvedDecision.loopContract.blockers)
      ? resolvedDecision.loopContract.blockers
      : [],
    commands: {
      ...input.commands,
      primary: decisionPlan.action.command,
    },
    nextStep: input.nextStep ?? null,
    decisionPlanProjection: projectCompactDecisionPlan(decisionPlan),
    resolvedDecision,
    loopContract: resolvedDecision.loopContract,
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
  const decisionPlanProjection = recordOrNull(compact.decisionPlanProjection);
  if (decisionPlanProjection?.kind !== "decision-plan-projection") {
    throw new TypeError("compact recommend-next requires a canonical decision plan projection.");
  }
  const canonicalNextAction = recordOrNull(decisionPlanProjection?.action);
  const explicitCommand = stringOrEmpty(canonicalNextAction?.command);
  const primaryCommand = explicitCommand;
  const nextAction = stringOrEmpty(compact.nextAction) || "Continue from state.";
  const action = canonicalNextAction
    ? {
        ...canonicalNextAction,
        reason: nextAction,
        toolName: actionToolNameForKind(canonicalNextAction.kind),
        command: primaryCommand,
      }
    : { kind: "compact-state", reason: nextAction, command: primaryCommand };
  const handoff = compactRecommendNextHandoff(compact);
  const response: RecommendNextResponse = {
    ok: compact.ok === false ? false : true,
    workDir: compactHandoffText(workDir),
    action,
    nextAction,
    whySafe: COMPACT_WHY_SAFE,
    avoids: COMPACT_AVOIDS,
    proof: COMPACT_PROOF,
    blockers: [],
    commands: primaryCommand ? { primary: primaryCommand } : {},
    nextStep: null,
    compactState: handoff.compactState,
    decisionPlanProjection,
    operatorReadout: compact.operatorReadout,
    portfolioRecommendation: compact.portfolioRecommendation,
    sessionDecisionCapsule: handoff.sessionDecisionCapsule,
    evidenceNotes: handoff.evidenceNotes,
    frictionSignals: handoff.frictionSignals,
  };
  return enforceCompactHandoffBudget(response);
}

function copyIfProvided<T extends object>(target: T, key: string, value: unknown) {
  if (value !== undefined) (target as JsonObject)[key] = value;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function compactRecommendNextHandoff(compact: JsonObject): {
  compactState: JsonObject;
  sessionDecisionCapsule: JsonObject | null;
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
    sessionDecisionCapsule: compactSessionCapsuleForHandoff(capsule),
    evidenceNotes,
    frictionSignals,
  };
}

function compactSessionCapsuleForHandoff(capsule: JsonObject | null): JsonObject | null {
  if (!capsule) return null;
  const enforcement = recordOrNull(capsule.enforcement);
  return {
    kind: capsule.kind || null,
    status: capsule.status || null,
    enforcement: enforcement
      ? {
          mode: enforcement.mode || null,
          canRunNextPacket: enforcement.canRunNextPacket ?? null,
          allowBoundedNext: enforcement.allowBoundedNext ?? null,
          blocksFinalization: enforcement.blocksFinalization ?? null,
          commandHint: enforcement.commandHint || "",
          triggeredBy: enforcement.triggeredBy || [],
        }
      : null,
    evidence: Array.isArray(capsule.evidence) ? capsule.evidence.slice(0, 3) : [],
    nextExperiment: capsule.nextExperiment || "",
    wrongNextActions: Array.isArray(capsule.wrongNextActions)
      ? capsule.wrongNextActions.slice(0, 3)
      : [],
    doNotRepeat: Array.isArray(capsule.doNotRepeat) ? capsule.doNotRepeat.slice(0, 3) : [],
    commandBudgetWarnings: Array.isArray(capsule.commandBudgetWarnings)
      ? capsule.commandBudgetWarnings.slice(0, 3)
      : [],
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
