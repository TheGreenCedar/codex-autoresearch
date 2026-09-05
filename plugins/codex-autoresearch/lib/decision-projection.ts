import type {
  CapabilityStatus,
  DecisionCapability,
  DecisionDiagnosticCode,
  DecisionPlan,
} from "./decision-compiler.js";
import type { UnknownRecord } from "./types/json.js";

export type DecisionProjectionSurface = "dashboard" | "doctor" | "finalization" | "terminal";

export interface DecisionSemanticProjection extends UnknownRecord {
  decisionId: string;
  generationId: string;
  compilerSchemaVersion: number;
  phase: string;
  actionKind: string;
  primaryBlockerCode: string | null;
  parentDisposition: string;
  contractDigest: string;
  evaluatorIdentity: string;
  command: string;
  commandDigest: string;
  commandRedacted: boolean;
}

export interface ProjectedResolvedDecision extends UnknownRecord {
  version: 1;
  compilerSchemaVersion: 1;
  decisionId: string;
  generationId: string;
  phase: string;
  actionKind: string;
  primaryBlockerCode: string | null;
  parentDisposition: string;
  contractDigest: string;
  evaluatorIdentity: string;
  status: "blocked" | "complete" | "ready" | "unknown";
  strongestBlocker: string | null;
  nextAction: string;
  command: string;
  commandDigest: string;
  canonicalNextAction: UnknownRecord;
  loopContract: UnknownRecord;
  runtimeProvenance: null;
  runtimeAuthority: null;
  finalizationPressure: UnknownRecord;
  capabilities: DecisionPlan["capabilities"];
}

export function projectDecisionPlan(
  plan: DecisionPlan,
  surface: DecisionProjectionSurface,
): DecisionSemanticProjection {
  const commandRedacted = surface === "dashboard";
  return {
    decisionId: plan.decisionId,
    generationId: plan.generationId,
    compilerSchemaVersion: plan.compilerSchemaVersion,
    phase: plan.phase,
    actionKind: plan.action.kind,
    primaryBlockerCode: plan.primaryBlockerCode,
    parentDisposition: plan.parentDisposition.kind,
    contractDigest: plan.contractDigest,
    evaluatorIdentity: plan.evaluatorIdentity,
    command: commandRedacted ? "" : plan.action.command,
    commandDigest: plan.action.commandDigest,
    commandRedacted,
  };
}

export interface CompactDecisionPlanProjection extends UnknownRecord {
  kind: "decision-plan-projection";
  projection: "compact";
  compilerSchemaVersion: 1;
  generationId: string;
  decisionId: string;
  phase: string;
  action: UnknownRecord;
  primaryBlockerCode: DecisionDiagnosticCode | null;
  capabilities: Record<DecisionCapability, CapabilityStatus>;
  requiredEvidence: UnknownRecord;
  loopDisposition: DecisionPlan["loopDisposition"];
  parentDisposition: DecisionPlan["parentDisposition"];
  contractDigest: string;
  evaluatorIdentity: string;
  outcome: DecisionPlan["outcome"]["kind"];
  result: DecisionPlan["outcome"];
  learning: UnknownRecord;
}

export interface DashboardDecisionPlanProjection extends UnknownRecord {
  kind: "dashboard-decision-plan-projection";
  projection: "dashboard";
  compilerSchemaVersion: 1;
  generationId: string;
  decisionId: string;
  phase: string;
  action: UnknownRecord;
  primaryBlockerCode: DecisionDiagnosticCode | null;
  capabilities: Record<DecisionCapability, CapabilityStatus>;
  requiredEvidence: UnknownRecord;
  loopDisposition: DecisionPlan["loopDisposition"];
  parentDisposition: DecisionPlan["parentDisposition"];
  contractDigest: string;
  evaluatorIdentity: string;
  outcome: DecisionPlan["outcome"]["kind"];
  result: DecisionPlan["outcome"];
  learning: UnknownRecord;
  display: {
    actionReason: string;
  };
}

export function projectCompactDecisionPlan(
  plan: DecisionPlan,
  options: { redactCommand?: boolean } = {},
): CompactDecisionPlanProjection {
  const redactCommand = options.redactCommand === true;
  return {
    kind: "decision-plan-projection",
    projection: "compact",
    compilerSchemaVersion: plan.compilerSchemaVersion,
    generationId: plan.generationId,
    decisionId: plan.decisionId,
    phase: plan.phase,
    action: {
      kind: plan.action.kind,
      command: redactCommand ? "" : plan.action.command,
      commandDigest: plan.action.commandDigest,
    },
    primaryBlockerCode: plan.primaryBlockerCode,
    capabilities: plan.capabilities,
    requiredEvidence: {
      preconditionEpoch: plan.requiredEvidence.preconditionEpoch,
      acceptedCheckIdentities: plan.requiredEvidence.acceptedCheckIdentities,
      diagnosticCodes: plan.requiredEvidence.diagnosticCodes,
      capabilityEffectCodes: plan.requiredEvidence.capabilityEffectCodes,
      ...(plan.requiredEvidence.failureLayer
        ? {
            failureLayer: plan.requiredEvidence.failureLayer,
            failurePreconditionCodes: plan.requiredEvidence.failurePreconditions,
          }
        : {}),
    },
    loopDisposition: plan.loopDisposition,
    parentDisposition: plan.parentDisposition,
    contractDigest: plan.contractDigest,
    evaluatorIdentity: plan.evaluatorIdentity,
    outcome: plan.outcome.kind,
    result: plan.outcome,
    learning: {
      kind: plan.learning.latest.kind,
      changedBelief: plan.learning.latest.changedBelief,
      evidence: plan.learning.latest.evidence,
      consecutiveNoLearningCandidates: plan.learning.consecutiveNoLearningCandidates,
    },
  };
}

export function projectDashboardDecisionPlan(plan: DecisionPlan): DashboardDecisionPlanProjection {
  const compact = projectCompactDecisionPlan(plan, { redactCommand: true });
  return {
    ...compact,
    kind: "dashboard-decision-plan-projection",
    projection: "dashboard",
    display: {
      actionReason: plan.action.reason,
    },
  };
}

export function projectResolvedDecision(
  plan: DecisionPlan,
  options: { redactCommand?: boolean } = {},
): ProjectedResolvedDecision {
  const command = options.redactCommand === true ? "" : plan.action.command;
  const strongestBlocker = plan.primaryBlockerCode || null;
  const status = resolvedStatus(plan);
  const blockerMessages = plan.primaryBlockerCode ? [plan.primaryBlockerCode] : [];
  return {
    version: 1,
    compilerSchemaVersion: plan.compilerSchemaVersion,
    decisionId: plan.decisionId,
    generationId: plan.generationId,
    phase: plan.phase,
    actionKind: plan.action.kind,
    primaryBlockerCode: plan.primaryBlockerCode,
    parentDisposition: plan.parentDisposition.kind,
    contractDigest: plan.contractDigest,
    evaluatorIdentity: plan.evaluatorIdentity,
    status,
    strongestBlocker,
    nextAction: plan.action.reason,
    command,
    commandDigest: plan.action.commandDigest,
    canonicalNextAction: {
      kind: plan.action.kind,
      reason: plan.action.reason,
      command,
      commandDigest: plan.action.commandDigest,
      triggeredBy: plan.requiredEvidence.diagnosticCodes,
    },
    loopContract: {
      ok: plan.loopDisposition.kind !== "blocked",
      complete: plan.loopDisposition.kind === "complete",
      canRunNextPacket: plan.loopDisposition.canRunPacket,
      blockers: blockerMessages,
      warnings: plan.requiredEvidence.diagnosticCodes.filter(
        (code) => code !== plan.primaryBlockerCode,
      ),
      strongestAction: {
        kind: plan.action.kind,
        reason: plan.action.reason,
        command,
      },
    },
    runtimeProvenance: null,
    runtimeAuthority: null,
    finalizationPressure: {
      available: true,
      ready: plan.capabilities.finalize === "allowed" && plan.action.kind === "finalize",
      blockedBy:
        plan.requiredEvidence.capabilityEffectCodes
          .find((effect) => effect.includes(":finalize:"))
          ?.split(":", 1)[0] || null,
      nextAction: plan.action.reason,
    },
    capabilities: plan.capabilities,
  };
}

export function projectLoopContinuation(plan: DecisionPlan): UnknownRecord {
  return {
    mode: "decision-plan",
    stage: plan.phase,
    shouldContinue: plan.loopDisposition.shouldContinue,
    canRunNextPacket: plan.loopDisposition.canRunPacket,
    activeBudget: plan.loopDisposition.kind === "continue",
    forbidFinalAnswer: plan.parentDisposition.kind === "block-final-answer",
    finalAnswerPolicy: plan.parentDisposition.kind,
    loopDisposition: plan.loopDisposition.kind,
    parentDisposition: plan.parentDisposition.kind,
    nextAction: plan.action.reason,
  };
}

function resolvedStatus(plan: DecisionPlan): ProjectedResolvedDecision["status"] {
  if (plan.loopDisposition.kind === "complete") return "complete";
  if (
    plan.loopDisposition.kind === "blocked" ||
    plan.parentDisposition.kind === "block-final-answer"
  ) {
    return "blocked";
  }
  return "ready";
}
