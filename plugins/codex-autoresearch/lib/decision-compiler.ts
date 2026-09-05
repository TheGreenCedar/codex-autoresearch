import { createHash } from "node:crypto";
import path from "node:path";
import { renderShellCommand } from "./command-rendering.js";
import { resolvePackageRoot } from "./runtime-paths.js";
import { hashOutcomeValue, outcomeUsage, type DeliveryEndpoint } from "./outcome-contract.js";
import {
  classifyResult,
  isResultSemantics,
  type ResultSemantics,
  type EvaluatorObservation,
} from "./result-semantics.js";
import { isAcceptedCurrentRun } from "./evidence-registry.js";

import type { CoherentSessionSnapshot } from "./coherent-session-snapshot.js";
import { parseEvidenceAxes } from "./evidence-axes.js";
import {
  buildFinalizationProductClaimCoverageFromLedger,
  productClaimCoverageFingerprintMaterial,
} from "./product-claim-coverage.js";
import { productGradeFinalizationIssue } from "./finalization-acceptance.js";
import {
  FINALIZATION_EVIDENCE_COMPONENT_KEYS,
  type FinalizationEvidenceFingerprint,
} from "./finalization-plan.js";
import { DECISION_COMPILER_SCHEMA_VERSION } from "./decision-schema-versions.js";

export { DECISION_COMPILER_SCHEMA_VERSION } from "./decision-schema-versions.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

export const DECISION_CAPABILITIES = [
  "mutate-session",
  "run-packet",
  "authorize-keep",
  "transition-segment",
  "finalize",
  "parent-final-answer",
] as const;

export type DecisionCapability = (typeof DECISION_CAPABILITIES)[number];
export type CapabilityStatus = "allowed" | "blocked" | "recovery-only";

export const DECISION_ACTION_KINDS = [
  "propose-action",
  "execute-ticket",
  "resume-execution",
  "stopped-unmet",
  "accept-legacy-contract",
  "collect-evidence",
  "complete",
  "configure-benchmark",
  "configure-checks",
  "direct-work",
  "distill-context",
  "finalize",
  "inspect-packet",
  "inspect-process",
  "log-decision",
  "pause-packets",
  "recover-session",
  "repair-contract-conflict",
  "repair-goal",
  "repair-scaffold",
  "replace-packet",
  "request-approval",
  "resolve-finalization",
  "review-dirty-source",
  "run-baseline",
  "run-packet",
  "setup",
  "transition-segment",
] as const;

export type DecisionActionKind = (typeof DECISION_ACTION_KINDS)[number];

export const DECISION_OUTCOME_KINDS = [
  "improved",
  "regressed",
  "neutral",
  "uncompared",
  "invalid",
] as const;
export type DecisionOutcomeKind = (typeof DECISION_OUTCOME_KINDS)[number];

export type DecisionDiagnosticCode =
  | "outcome-active"
  | "outcome-ticket"
  | "outcome-outstanding"
  | "outcome-stopped"
  | "outcome-budget-exhausted"
  | "outcome-input-drift"
  | "active-process"
  | "approval-required"
  | "benchmark-required"
  | "checks-required"
  | "coherent-snapshot-unavailable"
  | "coherent-snapshot-source-invalid"
  | "completion-ready"
  | "context-distillation"
  | "current-tree-finalization"
  | "dirty-source"
  | "evaluator-drift"
  | "finalization-blocked"
  | "finalization-claim-blocked"
  | "finalization-ready"
  | "goal-mismatch"
  | "ledger-integrity"
  | "legacy-contract-acceptance-required"
  | "legacy-contract-conflict"
  | "needs-baseline"
  | "no-learning-pause"
  | "packet-budget-exhausted"
  | "packet-diagnostic"
  | "packet-keep-not-authorized"
  | "packet-status-authority-invalid"
  | "pending-log-transaction"
  | "pending-log-transaction-inconsistent"
  | "pending-packet"
  | "process-integrity"
  | "quality-evidence-required"
  | "resource-exhausted"
  | "runtime-integrity"
  | "same-layer-failure-pause"
  | "scaffold-invalid"
  | "segment-transition-available"
  | "setup-required"
  | "stale-packet"
  | "termination-unproven";

export interface DecisionDiagnostic {
  code: DecisionDiagnosticCode;
  message?: string;
  observedAt?: string;
  command?: string;
  actionSemanticId?: string;
  semantic?: UnknownRecord;
}

type DecisionPhase =
  | "complete"
  | "direct-work"
  | "finalization"
  | "packet"
  | "paused"
  | "recovery"
  | "setup";

interface DiagnosticPolicy {
  priority: number;
  phase: DecisionPhase;
  actionKind: DecisionActionKind;
  blocked: readonly DecisionCapability[];
  recoveryOnly?: readonly DecisionCapability[];
  primaryBlocker: boolean;
  loop: "blocked" | "complete" | "continue" | "pause";
}

const ALL_EXCEPT_MUTATE = DECISION_CAPABILITIES.filter(
  (capability) => capability !== "mutate-session",
);
const PACKET_AND_KEEP: readonly DecisionCapability[] = ["run-packet", "authorize-keep"];
const PACKET_ONLY: readonly DecisionCapability[] = ["run-packet"];
const KEEP_ONLY: readonly DecisionCapability[] = ["authorize-keep"];
const FINALIZE_ONLY: readonly DecisionCapability[] = ["finalize"];

export const decisionDiagnosticRegistry = {
  "outcome-active": {
    ...guidancePolicy(35, "direct-work", "propose-action"),
    blocked: ["authorize-keep", "finalize"],
  },
  "outcome-ticket": {
    ...guidancePolicy(30, "direct-work", "execute-ticket"),
    blocked: ["run-packet", "authorize-keep", "finalize"],
  },
  "outcome-outstanding": blockedPolicy(5, "recovery", "resume-execution", [
    "run-packet",
    "authorize-keep",
    "finalize",
  ]),
  "outcome-stopped": blockedPolicy(
    24,
    "paused",
    "stopped-unmet",
    ["run-packet", "authorize-keep", "finalize"],
    "pause",
  ),
  "outcome-budget-exhausted": blockedPolicy(
    24,
    "paused",
    "stopped-unmet",
    ["run-packet", "authorize-keep", "finalize"],
    "pause",
  ),
  "outcome-input-drift": blockedPolicy(4, "recovery", "recover-session", [
    "run-packet",
    "authorize-keep",
    "finalize",
  ]),
  "coherent-snapshot-unavailable": recoveryPolicy(0, DECISION_CAPABILITIES),
  "coherent-snapshot-source-invalid": recoveryPolicy(0, DECISION_CAPABILITIES),
  "pending-log-transaction-inconsistent": recoveryPolicy(1, ALL_EXCEPT_MUTATE, ["mutate-session"]),
  "pending-log-transaction": recoveryPolicy(2, ALL_EXCEPT_MUTATE, ["mutate-session"]),
  "ledger-integrity": recoveryPolicy(3, ALL_EXCEPT_MUTATE, ["mutate-session"]),
  "legacy-contract-acceptance-required": {
    priority: 9,
    phase: "recovery",
    actionKind: "accept-legacy-contract",
    blocked: KEEP_ONLY,
    recoveryOnly: PACKET_ONLY,
    primaryBlocker: true,
    loop: "blocked",
  },
  "legacy-contract-conflict": {
    priority: 9,
    phase: "recovery",
    actionKind: "repair-contract-conflict",
    blocked: KEEP_ONLY,
    recoveryOnly: PACKET_ONLY,
    primaryBlocker: true,
    loop: "blocked",
  },
  "process-integrity": recoveryPolicy(4, ALL_EXCEPT_MUTATE, ["mutate-session"]),
  "termination-unproven": recoveryPolicy(5, ALL_EXCEPT_MUTATE, ["mutate-session"]),
  "runtime-integrity": recoveryPolicy(6, ALL_EXCEPT_MUTATE, ["mutate-session"]),
  "goal-mismatch": blockedPolicy(10, "direct-work", "repair-goal", [
    "run-packet",
    "authorize-keep",
    "finalize",
    "parent-final-answer",
  ]),
  "approval-required": blockedPolicy(11, "direct-work", "request-approval", [
    "run-packet",
    "authorize-keep",
    "finalize",
  ]),
  "resource-exhausted": blockedPolicy(12, "paused", "pause-packets", PACKET_ONLY, "pause"),
  "scaffold-invalid": blockedPolicy(13, "setup", "repair-scaffold", PACKET_AND_KEEP),
  "dirty-source": blockedPolicy(14, "direct-work", "review-dirty-source", KEEP_ONLY, "continue"),
  "evaluator-drift": blockedPolicy(15, "direct-work", "transition-segment", PACKET_AND_KEEP),
  "active-process": blockedPolicy(16, "recovery", "inspect-process", PACKET_ONLY),
  "pending-packet": blockedPolicy(17, "packet", "log-decision", PACKET_ONLY),
  "packet-status-authority-invalid": {
    priority: 17,
    phase: "packet",
    actionKind: "replace-packet",
    blocked: KEEP_ONLY,
    recoveryOnly: PACKET_ONLY,
    primaryBlocker: true,
    loop: "blocked",
  },
  "packet-keep-not-authorized": {
    priority: 18,
    phase: "packet",
    actionKind: "log-decision",
    blocked: KEEP_ONLY,
    recoveryOnly: [],
    primaryBlocker: false,
    loop: "blocked",
  },
  "stale-packet": {
    priority: 19,
    phase: "packet",
    actionKind: "replace-packet",
    blocked: [],
    recoveryOnly: PACKET_ONLY,
    primaryBlocker: true,
    loop: "blocked",
  },
  "packet-diagnostic": blockedPolicy(20, "packet", "inspect-packet", PACKET_ONLY),
  "setup-required": blockedPolicy(20, "setup", "setup", PACKET_AND_KEEP),
  "benchmark-required": blockedPolicy(21, "setup", "configure-benchmark", PACKET_AND_KEEP),
  "checks-required": blockedPolicy(22, "setup", "configure-checks", PACKET_AND_KEEP),
  "quality-evidence-required": blockedPolicy(23, "direct-work", "collect-evidence", [
    "authorize-keep",
    "finalize",
    "parent-final-answer",
  ]),
  "needs-baseline": guidancePolicy(30, "packet", "run-baseline"),
  "packet-budget-exhausted": blockedPolicy(24, "paused", "pause-packets", PACKET_ONLY, "pause"),
  "same-layer-failure-pause": blockedPolicy(25, "paused", "pause-packets", PACKET_ONLY, "pause"),
  "no-learning-pause": blockedPolicy(26, "paused", "pause-packets", PACKET_ONLY, "pause"),
  "context-distillation": blockedPolicy(33, "direct-work", "distill-context", PACKET_ONLY),
  "segment-transition-available": guidancePolicy(34, "direct-work", "transition-segment"),
  "finalization-claim-blocked": blockedPolicy(40, "finalization", "resolve-finalization", [
    "finalize",
    "parent-final-answer",
  ]),
  "current-tree-finalization": {
    priority: 41,
    phase: "direct-work",
    actionKind: "resolve-finalization",
    blocked: [],
    recoveryOnly: FINALIZE_ONLY,
    primaryBlocker: true,
    loop: "continue",
  },
  "finalization-blocked": blockedPolicy(
    42,
    "direct-work",
    "direct-work",
    FINALIZE_ONLY,
    "continue",
  ),
  "finalization-ready": guidancePolicy(50, "finalization", "finalize"),
  "completion-ready": completePolicy(60),
} satisfies Record<DecisionDiagnosticCode, DiagnosticPolicy>;

export type FailureLayer =
  | "accepted-check"
  | "contract"
  | "evaluator"
  | "external-infrastructure"
  | "process"
  | "repository";

export const failureLayerPreconditions: Record<FailureLayer, readonly string[]> = {
  contract: ["contractDigest", "preconditionEpoch"],
  evaluator: ["acceptedEvaluatorIdentity", "acceptedEvaluatorExecutionDigest", "preconditionEpoch"],
  "accepted-check": ["acceptedCheckIdentity", "acceptedCheckExecutionDigest", "preconditionEpoch"],
  repository: ["expectedHead", "acceptedEditableScopeDigest", "candidateFingerprint"],
  process: ["processLifecycleIdentity", "terminationProof"],
  "external-infrastructure": ["externalDependencyIdentity", "externalObservation"],
};

export interface OutcomeDecisionProjection {
  id: string;
  objective: string;
  status: "active" | "blocked" | "satisfied" | "stopped-unmet";
  question: string | null;
  executionId: string | null;
  remaining: {
    actions: number | null;
    executionSeconds: number | null;
    deadline: string | null;
    unknownExecutions: number;
  };
  unresolvedCriteria: string[];
  delivery: { endpoint: DeliveryEndpoint; status: "pending" | "ready" | "delivered" };
  inputDigest: string | null;
}

export interface DecisionPlan {
  kind: "decision-plan";
  compilerSchemaVersion: 1;
  generationId: string;
  decisionId: string;
  phase: DecisionPhase;
  action: {
    kind: DecisionActionKind;
    reason: string;
    command: string;
    commandDigest: string;
    commandSemanticId: string;
  };
  primaryBlockerCode: DecisionDiagnosticCode | null;
  capabilities: Record<DecisionCapability, CapabilityStatus>;
  loopDisposition: {
    kind: "blocked" | "complete" | "continue" | "pause";
    canRunPacket: boolean;
    shouldContinue: boolean;
  };
  parentDisposition: {
    kind: "block-final-answer" | "complete" | "continue-working" | "hand-back";
    mayAnswer: boolean;
    mayClaimCompletion: boolean;
  };
  contractDigest: string;
  evaluatorIdentity: string;
  requiredEvidence: {
    preconditionEpoch: string;
    acceptedCheckIdentities: string[];
    diagnosticCodes: DecisionDiagnosticCode[];
    capabilityEffectCodes: string[];
    failureLayer: FailureLayer | null;
    failurePreconditions: readonly string[];
  };
  investigation: OutcomeDecisionProjection | null;
  outcome: ResultSemantics & {
    /** Compatibility alias for metric movement; inspect validity and attainment separately. */
    kind: DecisionOutcomeKind;
  };
  learning: {
    latest: {
      kind: "causal" | "discriminating" | "none";
      changedBelief: string | null;
      evidence: string[];
    };
    consecutiveNoLearningCandidates: number;
  };
  failures: { layer: FailureLayer | null; consecutive: number };
}

export function decisionDiagnostic(
  code: DecisionDiagnosticCode,
  input: Omit<DecisionDiagnostic, "code"> = {},
): DecisionDiagnostic {
  return { code, ...input };
}

export function isDecisionPlan(value: unknown): value is DecisionPlan {
  if (!isUnknownRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "kind",
      "compilerSchemaVersion",
      "generationId",
      "decisionId",
      "phase",
      "action",
      "primaryBlockerCode",
      "capabilities",
      "loopDisposition",
      "parentDisposition",
      "contractDigest",
      "evaluatorIdentity",
      "requiredEvidence",
      "outcome",
      "learning",
      "failures",
      "investigation",
    ]) ||
    value.kind !== "decision-plan" ||
    value.compilerSchemaVersion !== DECISION_COMPILER_SCHEMA_VERSION ||
    !nonEmptyString(value.generationId) ||
    !nonEmptyString(value.decisionId) ||
    !["complete", "direct-work", "finalization", "packet", "paused", "recovery", "setup"].includes(
      String(value.phase),
    ) ||
    (value.primaryBlockerCode !== null &&
      !Object.hasOwn(decisionDiagnosticRegistry, String(value.primaryBlockerCode))) ||
    typeof value.contractDigest !== "string" ||
    typeof value.evaluatorIdentity !== "string"
  ) {
    return false;
  }
  const action = isUnknownRecord(value.action) ? value.action : null;
  if (
    !action ||
    !hasExactKeys(action, ["kind", "reason", "command", "commandDigest", "commandSemanticId"]) ||
    !DECISION_ACTION_KINDS.includes(action.kind as DecisionActionKind) ||
    ![action.reason, action.command, action.commandDigest, action.commandSemanticId].every(
      (item) => typeof item === "string",
    )
  ) {
    return false;
  }
  const capabilities = isUnknownRecord(value.capabilities) ? value.capabilities : null;
  if (
    !capabilities ||
    !hasExactKeys(capabilities, DECISION_CAPABILITIES) ||
    !DECISION_CAPABILITIES.every((capability) =>
      ["allowed", "blocked", "recovery-only"].includes(String(capabilities[capability])),
    )
  ) {
    return false;
  }
  const loop = isUnknownRecord(value.loopDisposition) ? value.loopDisposition : null;
  if (
    !loop ||
    !hasExactKeys(loop, ["kind", "canRunPacket", "shouldContinue"]) ||
    !["blocked", "complete", "continue", "pause"].includes(String(loop.kind)) ||
    typeof loop.canRunPacket !== "boolean" ||
    typeof loop.shouldContinue !== "boolean"
  ) {
    return false;
  }
  const parent = isUnknownRecord(value.parentDisposition) ? value.parentDisposition : null;
  if (
    !parent ||
    !hasExactKeys(parent, ["kind", "mayAnswer", "mayClaimCompletion"]) ||
    !["block-final-answer", "complete", "continue-working", "hand-back"].includes(
      String(parent.kind),
    ) ||
    typeof parent.mayAnswer !== "boolean" ||
    typeof parent.mayClaimCompletion !== "boolean"
  ) {
    return false;
  }
  const requiredEvidence = isUnknownRecord(value.requiredEvidence) ? value.requiredEvidence : null;
  if (
    !requiredEvidence ||
    !hasExactKeys(requiredEvidence, [
      "preconditionEpoch",
      "acceptedCheckIdentities",
      "diagnosticCodes",
      "capabilityEffectCodes",
      "failureLayer",
      "failurePreconditions",
    ]) ||
    typeof requiredEvidence.preconditionEpoch !== "string" ||
    !isStringArray(requiredEvidence.acceptedCheckIdentities) ||
    !Array.isArray(requiredEvidence.diagnosticCodes) ||
    !requiredEvidence.diagnosticCodes.every(
      (code) => typeof code === "string" && Object.hasOwn(decisionDiagnosticRegistry, code),
    ) ||
    !isStringArray(requiredEvidence.capabilityEffectCodes) ||
    (requiredEvidence.failureLayer !== null && !isFailureLayer(requiredEvidence.failureLayer)) ||
    !isStringArray(requiredEvidence.failurePreconditions)
  ) {
    return false;
  }
  if (value.investigation !== null && !isOutcomeDecisionProjection(value.investigation))
    return false;
  const outcome = isUnknownRecord(value.outcome) ? value.outcome : null;
  if (
    !outcome ||
    !hasExactKeys(outcome, [
      "kind",
      "execution",
      "validity",
      "conclusion",
      "movement",
      "attainment",
      "codeAcceptance",
    ]) ||
    !isResultSemantics(outcome) ||
    !DECISION_OUTCOME_KINDS.includes(outcome.kind as DecisionOutcomeKind)
  ) {
    return false;
  }
  const learning = isUnknownRecord(value.learning) ? value.learning : null;
  const latestLearning = isUnknownRecord(learning?.latest) ? learning.latest : null;
  if (
    !learning ||
    !hasExactKeys(learning, ["latest", "consecutiveNoLearningCandidates"]) ||
    !latestLearning ||
    !hasExactKeys(latestLearning, ["kind", "changedBelief", "evidence"]) ||
    !["causal", "discriminating", "none"].includes(String(latestLearning.kind)) ||
    (latestLearning.kind === "none"
      ? latestLearning.changedBelief !== null ||
        !Array.isArray(latestLearning.evidence) ||
        latestLearning.evidence.length !== 0
      : !nonEmptyString(latestLearning.changedBelief) ||
        !isNonEmptyStringArray(latestLearning.evidence)) ||
    !isNonnegativeInteger(learning.consecutiveNoLearningCandidates)
  ) {
    return false;
  }
  const failures = isUnknownRecord(value.failures) ? value.failures : null;
  return Boolean(
    failures &&
    hasExactKeys(failures, ["layer", "consecutive"]) &&
    (failures.layer === null || isFailureLayer(failures.layer)) &&
    isNonnegativeInteger(failures.consecutive),
  );
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function compileDecisionPlan(
  snapshot: CoherentSessionSnapshot,
  diagnostics: readonly DecisionDiagnostic[],
): DecisionPlan {
  const learning: DecisionPlan["learning"] = snapshot.outcome
    ? {
        latest: { kind: "none", changedBelief: null, evidence: [] },
        consecutiveNoLearningCandidates: 0,
      }
    : classifyLearning(snapshot);
  const failures: DecisionPlan["failures"] = snapshot.outcome
    ? { layer: null, consecutive: 0 }
    : classifyFailures(snapshot);
  const governed = snapshot.outcome ? compileOutcomeInvestigation(snapshot) : null;
  const automatic: DecisionDiagnostic[] = governed ? governed.diagnostics : [];
  if (snapshot.pendingTransaction) {
    automatic.push(decisionDiagnostic(snapshot.pendingTransaction.diagnosticCode));
  }
  // Legacy learning is retained as history, never as continuation authority.
  const contract = acceptedContract(snapshot.records, snapshot.semanticFacts.contractDigest);
  const stopPolicy = isUnknownRecord(contract?.stopPolicy) ? contract.stopPolicy : null;
  const failurePolicy = isUnknownRecord(stopPolicy?.repeatedFailures)
    ? stopPolicy.repeatedFailures
    : null;
  const failureLimit = failurePolicy?.limit;
  if (
    typeof failureLimit === "number" &&
    Number.isSafeInteger(failureLimit) &&
    failureLimit > 0 &&
    failures.consecutive >= failureLimit
  ) {
    automatic.push(
      decisionDiagnostic("same-layer-failure-pause", {
        semantic: { layer: failures.layer },
      }),
    );
  }
  const completionReady = snapshot.outcome ? null : validatedCompletionEvidence(snapshot);
  if (completionReady)
    automatic.push(decisionDiagnostic("completion-ready", { semantic: completionReady }));
  if (
    diagnostics.some((diagnostic) => diagnostic.code === "completion-ready") &&
    !completionReady
  ) {
    throw new Error("completion-ready requires validated post-finalization evidence");
  }
  const effectiveDiagnostics = completionReady
    ? diagnostics.filter(
        (diagnostic) =>
          ![
            "current-tree-finalization",
            "finalization-blocked",
            "finalization-claim-blocked",
            "finalization-ready",
          ].includes(diagnostic.code),
      )
    : diagnostics;
  const normalizedDiagnostics = normalizeDiagnostics([...effectiveDiagnostics, ...automatic]);
  const compiledCapabilities = compileCapabilities(normalizedDiagnostics);
  const capabilities = Object.fromEntries(
    Object.entries(compiledCapabilities).map(([capability, value]) => [capability, value.status]),
  ) as DecisionPlan["capabilities"];
  const authority = normalizedDiagnostics[0] || null;
  const authorityPolicy = authority ? decisionDiagnosticRegistry[authority.code] : null;
  const primaryBlocker =
    normalizedDiagnostics.find(
      (diagnostic) => decisionDiagnosticRegistry[diagnostic.code].primaryBlocker,
    ) || null;
  const loopKind = authorityPolicy?.loop || "continue";
  const parentBlocked = capabilities["parent-final-answer"] !== "allowed";
  const phase = authorityPolicy?.phase || "packet";
  const action = {
    kind: authorityPolicy?.actionKind || "run-packet",
    reason: authority?.message || defaultReason(authority?.code),
    command: authority?.command || "",
    commandDigest: sha256(authority?.command || ""),
    commandSemanticId: commandSemanticIdentity(authority),
  };
  const loopDisposition: DecisionPlan["loopDisposition"] = {
    kind: loopKind,
    canRunPacket: capabilities["run-packet"] === "allowed",
    shouldContinue: loopKind === "continue",
  };
  const parentDisposition: DecisionPlan["parentDisposition"] = parentBlocked
    ? {
        kind: "block-final-answer",
        mayAnswer: false,
        mayClaimCompletion: false,
      }
    : loopKind === "complete"
      ? { kind: "complete", mayAnswer: true, mayClaimCompletion: true }
      : loopKind === "continue" && !primaryBlocker
        ? { kind: "hand-back", mayAnswer: true, mayClaimCompletion: false }
        : { kind: "hand-back", mayAnswer: true, mayClaimCompletion: false };
  const planWithoutId = {
    kind: "decision-plan" as const,
    compilerSchemaVersion: DECISION_COMPILER_SCHEMA_VERSION,
    generationId: snapshot.generationId,
    phase,
    action,
    primaryBlockerCode: primaryBlocker?.code || null,
    capabilities,
    loopDisposition,
    parentDisposition,
    contractDigest: snapshot.outcome?.contract.digest ?? snapshot.semanticFacts.contractDigest,
    evaluatorIdentity: snapshot.outcome
      ? (snapshot.outcome.executions.at(-1)?.action.evaluator?.digest ?? "")
      : snapshot.semanticFacts.evaluatorIdentity,
    requiredEvidence: {
      preconditionEpoch: snapshot.outcome
        ? `${snapshot.outcome.contract.digest}@${snapshot.outcomeFacts?.input?.digest ?? "unknown"}`
        : snapshot.semanticFacts.preconditionEpoch,
      acceptedCheckIdentities: snapshot.outcome
        ? snapshot.outcome.executions.at(-1)?.action.evaluator?.checkArgv.length
          ? [hashOutcomeValue(snapshot.outcome.executions.at(-1)!.action.evaluator!.checkArgv)]
          : []
        : snapshot.semanticFacts.acceptedCheckIdentities,
      diagnosticCodes: normalizedDiagnostics.map((diagnostic) => diagnostic.code),
      capabilityEffectCodes: Object.entries(compiledCapabilities).flatMap(([capability, value]) =>
        value.diagnosticCodes.map((code) => `${code}:${capability}:${value.status}`),
      ),
      failureLayer: failures.layer,
      failurePreconditions: failures.layer ? failureLayerPreconditions[failures.layer] : [],
    },
    investigation: governed?.projection ?? null,
    outcome: snapshot.outcome
      ? resultOutcome(
          snapshot.outcome.executions.at(-1)?.result ??
            classifyResult({ kind: "invalid", execution: "unknown" }),
        )
      : classifyOutcome(snapshot),
    learning,
    failures,
  };
  return {
    ...planWithoutId,
    decisionId: decisionIdForPlan(planWithoutId, normalizedDiagnostics),
  };
}

function recoveryPolicy(
  priority: number,
  blocked: readonly DecisionCapability[],
  recoveryOnly: readonly DecisionCapability[] = [],
): DiagnosticPolicy {
  return {
    priority,
    phase: "recovery",
    actionKind: "recover-session",
    blocked,
    recoveryOnly,
    primaryBlocker: true,
    loop: "blocked",
  };
}

function blockedPolicy(
  priority: number,
  phase: DecisionPhase,
  actionKind: DecisionActionKind,
  blocked: readonly DecisionCapability[],
  loop: DiagnosticPolicy["loop"] = "blocked",
): DiagnosticPolicy {
  return {
    priority,
    phase,
    actionKind,
    blocked,
    primaryBlocker: true,
    loop,
  };
}

function guidancePolicy(
  priority: number,
  phase: DecisionPhase,
  actionKind: DecisionActionKind,
): DiagnosticPolicy {
  return {
    priority,
    phase,
    actionKind,
    blocked: [],
    primaryBlocker: false,
    loop: "continue",
  };
}

function completePolicy(priority: number): DiagnosticPolicy {
  return {
    priority,
    phase: "complete",
    actionKind: "complete",
    blocked: [],
    primaryBlocker: false,
    loop: "complete",
  };
}

function validatedCompletionEvidence(snapshot: CoherentSessionSnapshot): UnknownRecord | null {
  const completed = [...snapshot.records]
    .reverse()
    .find((record) => record.type === "finalization-completed");
  if (!completed || completed.schemaVersion !== 1) return null;
  if (completed.sourceHead !== snapshot.git.head) return null;
  if (completed.sourceIndexTree !== snapshot.git.indexTree) return null;
  if (completed.sourceStatusHash !== snapshot.git.statusHash) return null;
  if (completed.contractDigest !== snapshot.semanticFacts.contractDigest) return null;
  if (completed.preconditionEpoch !== snapshot.semanticFacts.preconditionEpoch) return null;
  if (completed.productGradeReady !== true) return null;
  const productClaimCoverage = buildFinalizationProductClaimCoverageFromLedger(snapshot.records);
  if (productGradeFinalizationIssue(productClaimCoverage)) return null;
  const productClaimCoverageHash = createHash("sha256")
    .update(JSON.stringify(productClaimCoverageFingerprintMaterial(productClaimCoverage)))
    .digest("hex");
  if (completed.productClaimCoverageHash !== productClaimCoverageHash) return null;
  const acceptedEvidenceFingerprint = finalizationEvidenceFingerprint(
    completed.acceptedEvidenceFingerprint,
  );
  if (!acceptedEvidenceFingerprint) return null;
  if (
    typeof completed.acceptedEvidenceBase !== "string" ||
    !completed.acceptedEvidenceBase ||
    !Array.isArray(completed.acceptedEvidenceCommitDomain) ||
    !completed.acceptedEvidenceCommitDomain.every(nonEmptyString)
  ) {
    return null;
  }
  if (!Array.isArray(completed.evidence) || !completed.evidence.every(nonEmptyString)) return null;
  const evidence = completed.evidence as string[];
  if (!validCompletionEvidenceItems(evidence, String(completed.sourceHead))) return null;
  const completionAudit = snapshot.completionAudit;
  if (!completionAudit) return null;
  if (
    completed.acceptedEvidenceBase !== completionAudit.acceptedEvidenceBase ||
    JSON.stringify(completed.acceptedEvidenceCommitDomain) !==
      JSON.stringify(completionAudit.acceptedEvidenceCommitDomain) ||
    JSON.stringify(acceptedEvidenceFingerprint) !==
      JSON.stringify(completionAudit.acceptedEvidenceFingerprint)
  ) {
    return null;
  }
  const expectedSummaryHash = evidence
    .find((item) => item.startsWith("review-summary-sha256:"))
    ?.slice("review-summary-sha256:".length);
  if (
    typeof completed.reviewSummary !== "string" ||
    !completed.reviewSummary ||
    expectedSummaryHash !== completionAudit.summaryHash
  ) {
    return null;
  }
  const branchHeads = completionAudit.branchHeads;
  for (const item of evidence) {
    const match = item.match(/^review-branch:(.+)@([0-9a-f]{40}(?:[0-9a-f]{24})?)$/);
    if (match && branchHeads[match[1]] !== match[2]) return null;
  }
  const expectedEventId = `finalization-completed:${createHash("sha256")
    .update(
      JSON.stringify({
        sourceHead: completed.sourceHead,
        sourceIndexTree: completed.sourceIndexTree,
        sourceStatusHash: completed.sourceStatusHash,
        contractDigest: completed.contractDigest,
        preconditionEpoch: completed.preconditionEpoch,
        acceptedEvidenceBase: completed.acceptedEvidenceBase,
        acceptedEvidenceCommitDomain: completed.acceptedEvidenceCommitDomain,
        acceptedEvidenceFingerprint,
        productClaimCoverageHash: completed.productClaimCoverageHash,
        productGradeReady: completed.productGradeReady,
        reviewSummary: completed.reviewSummary,
        evidence,
      }),
    )
    .digest("hex")}`;
  if (completed.eventId !== expectedEventId) return null;
  return {
    sourceHead: completed.sourceHead,
    contractDigest: completed.contractDigest,
    preconditionEpoch: completed.preconditionEpoch,
    acceptedEvidenceFingerprint: acceptedEvidenceFingerprint.fingerprint,
    reviewSummary: completed.reviewSummary,
    evidence: [...evidence].sort(),
  };
}

function finalizationEvidenceFingerprint(value: unknown): FinalizationEvidenceFingerprint | null {
  if (!isUnknownRecord(value) || value.schema_version !== 1) return null;
  if (typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.fingerprint)) {
    return null;
  }
  const rawComponents = isUnknownRecord(value.components) ? value.components : null;
  if (!rawComponents) return null;
  const components = Object.fromEntries(
    FINALIZATION_EVIDENCE_COMPONENT_KEYS.map((key) => [key, rawComponents[key]]),
  ) as Record<(typeof FINALIZATION_EVIDENCE_COMPONENT_KEYS)[number], string>;
  if (
    Object.keys(rawComponents).length !== FINALIZATION_EVIDENCE_COMPONENT_KEYS.length ||
    Object.values(components).some(
      (component) => typeof component !== "string" || !/^[0-9a-f]{64}$/.test(component),
    )
  ) {
    return null;
  }
  return { schema_version: 1, fingerprint: value.fingerprint, components };
}

function validCompletionEvidenceItems(evidence: string[], sourceHead: string): boolean {
  if (new Set(evidence).size !== evidence.length) return false;
  const summary = evidence.filter((item) => /^review-summary-sha256:[0-9a-f]{64}$/.test(item));
  const finalTree = evidence.filter((item) => item === `verified-final-tree:${sourceHead}`);
  const branches = evidence.filter((item) =>
    /^review-branch:\S+@[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(item),
  );
  return (
    summary.length === 1 &&
    finalTree.length === 1 &&
    branches.length > 0 &&
    evidence.length === summary.length + finalTree.length + branches.length
  );
}

function normalizeDiagnostics(diagnostics: readonly DecisionDiagnostic[]): DecisionDiagnostic[] {
  const byIdentity = new Map<string, DecisionDiagnostic>();
  for (const diagnostic of diagnostics) {
    if (!decisionDiagnosticRegistry[diagnostic.code]) {
      throw new Error(`Unknown decision diagnostic code: ${String(diagnostic.code)}`);
    }
    const identity = diagnosticSemanticIdentity(diagnostic);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, diagnostic);
      continue;
    }
    const existingAction = commandSemanticIdentity(existing);
    const candidateAction = commandSemanticIdentity(diagnostic);
    if (existingAction && candidateAction && existingAction !== candidateAction) {
      throw new Error(
        `Decision diagnostic ${diagnostic.code} has conflicting action semantics: ${existingAction} and ${candidateAction}.`,
      );
    }
    byIdentity.set(identity, mergeDuplicateDiagnostic(existing, diagnostic));
  }
  return [...byIdentity.values()].sort((left, right) => {
    const priority =
      decisionDiagnosticRegistry[left.code].priority -
      decisionDiagnosticRegistry[right.code].priority;
    return (
      priority ||
      left.code.localeCompare(right.code) ||
      diagnosticSemanticIdentity(left).localeCompare(diagnosticSemanticIdentity(right))
    );
  });
}

function mergeDuplicateDiagnostic(
  left: DecisionDiagnostic,
  right: DecisionDiagnostic,
): DecisionDiagnostic {
  const commands = [left.command, right.command].filter(nonEmptyString).sort();
  const messages = [left.message, right.message].filter(nonEmptyString).sort();
  const actionSemanticIds = [left.actionSemanticId, right.actionSemanticId]
    .filter(nonEmptyString)
    .sort();
  return {
    code: left.code,
    ...(messages[0] ? { message: messages[0] } : {}),
    ...(commands[0] ? { command: commands[0] } : {}),
    ...(actionSemanticIds[0] ? { actionSemanticId: actionSemanticIds[0] } : {}),
    ...(left.semantic
      ? { semantic: left.semantic }
      : right.semantic
        ? { semantic: right.semantic }
        : {}),
  };
}

function diagnosticSemanticIdentity(diagnostic: DecisionDiagnostic): string {
  return canonicalJson({
    code: diagnostic.code,
    semantic: diagnostic.semantic || null,
  });
}

function commandSemanticIdentity(diagnostic: DecisionDiagnostic | null | undefined): string {
  if (!diagnostic) return "";
  if (nonEmptyString(diagnostic.actionSemanticId)) return diagnostic.actionSemanticId.trim();
  if (!nonEmptyString(diagnostic.command)) return "";
  const tokens = tokenizeCommand(diagnostic.command);
  const launcherIndex = tokens.findIndex((token) =>
    /(?:^|[\\/])(?:autoresearch|finalize-autoresearch)\.mjs$/i.test(token),
  );
  const commandIndex = launcherIndex >= 0 ? launcherIndex + 1 : 0;
  const command = String(tokens[commandIndex] || "")
    .replaceAll("_", "-")
    .toLowerCase();
  const parameters: Array<{ flag: string; value: string | null }> = [];
  const positional: string[] = [];
  const args = tokens.slice(commandIndex + 1);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positional.push(normalizeCommandSemanticValue(token));
      continue;
    }
    const separator = token.indexOf("=");
    const rawFlag = separator < 0 ? token : token.slice(0, separator);
    const flag = rawFlag.replaceAll("_", "-").toLowerCase();
    const inlineValue = separator < 0 ? null : token.slice(separator + 1);
    if (flag === "--cwd" || flag === "--working-dir") {
      if (inlineValue == null && args[index + 1] && !args[index + 1].startsWith("--")) index += 1;
      continue;
    }
    let value = inlineValue;
    if (value == null && args[index + 1] && !args[index + 1].startsWith("--")) {
      value = args[index + 1];
      index += 1;
    }
    parameters.push({
      flag,
      value: value == null ? null : normalizeCommandSemanticValue(value),
    });
  }
  parameters.sort((left, right) =>
    `${left.flag}\0${left.value || ""}`.localeCompare(`${right.flag}\0${right.value || ""}`),
  );
  return canonicalJson({ command, parameters, positional });
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (quote === '"' && character === "\\" && index + 1 < command.length) {
        token += character + command[index + 1];
        index += 1;
      } else {
        token += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (isCommandWhitespace(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (token) tokens.push(token);
  return tokens.length > 0 ? tokens : [command.trim()].filter(Boolean);
}

function isCommandWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r";
}

function normalizeCommandSemanticValue(value: string): string {
  return value.replaceAll("\\", "/");
}

type CompiledCapabilities = Record<
  DecisionCapability,
  { status: CapabilityStatus; diagnosticCodes: DecisionDiagnosticCode[] }
>;

function compileCapabilities(diagnostics: readonly DecisionDiagnostic[]): CompiledCapabilities {
  return Object.fromEntries(
    DECISION_CAPABILITIES.map((capability) => {
      const blockedCodes = diagnostics
        .filter((diagnostic) =>
          (decisionDiagnosticRegistry[diagnostic.code] as DiagnosticPolicy).blocked.includes(
            capability,
          ),
        )
        .map((diagnostic) => diagnostic.code);
      const recoveryCodes = diagnostics
        .filter((diagnostic) =>
          (decisionDiagnosticRegistry[diagnostic.code] as DiagnosticPolicy).recoveryOnly?.includes(
            capability,
          ),
        )
        .map((diagnostic) => diagnostic.code);
      return [
        capability,
        blockedCodes.length > 0
          ? { status: "blocked" as const, diagnosticCodes: blockedCodes }
          : recoveryCodes.length > 0
            ? {
                status: "recovery-only" as const,
                diagnosticCodes: recoveryCodes,
              }
            : { status: "allowed" as const, diagnosticCodes: [] },
      ];
    }),
  ) as CompiledCapabilities;
}

function classifyLearning(snapshot: CoherentSessionSnapshot): DecisionPlan["learning"] {
  const eligible = learningCandidateRuns(snapshot);
  let consecutive = 0;
  let latest: DecisionPlan["learning"]["latest"] = {
    kind: "none",
    changedBelief: null,
    evidence: [],
  };
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const record = eligible[index];
    const learning = validatedLearning(record.learning);
    if (index === eligible.length - 1) latest = learning;
    if (learning.kind !== "none") break;
    consecutive += 1;
  }
  return { latest, consecutiveNoLearningCandidates: consecutive };
}

function learningCandidateRuns(snapshot: CoherentSessionSnapshot): UnknownRecord[] {
  const eligible = eligibleCandidateRuns(snapshot);
  const contract = acceptedContract(snapshot.records, snapshot.semanticFacts.contractDigest);
  const noise = isUnknownRecord(contract?.noise) ? contract.noise : null;
  const repeats =
    noise?.kind === "bounded"
      ? noise.repeats
      : noise?.kind === "unknown"
        ? noise.qualificationRepeats
        : 1;
  if (typeof repeats !== "number" || !Number.isInteger(repeats) || repeats <= 1) return eligible;

  const fingerprint = (record: UnknownRecord): string | null => {
    const evidence = isUnknownRecord(record.contractEvaluationEvidence)
      ? record.contractEvaluationEvidence
      : null;
    if (
      !["measure", "keep", "discard"].includes(String(record.status)) ||
      record.failure != null ||
      record.quarantined === true ||
      (record.evidenceStatus === "rejected" && record.status !== "discard") ||
      record.evidenceStatus === "superseded" ||
      !evidence ||
      evidence.contractDigest !== snapshot.semanticFacts.contractDigest ||
      evidence.acceptedEvaluation !== true ||
      evidence.checksPassed !== true ||
      typeof evidence.metric !== "number" ||
      !Number.isFinite(evidence.metric) ||
      evidence.metric !== record.metric ||
      !nonEmptyString(evidence.candidateFingerprint)
    )
      return null;
    return evidence.candidateFingerprint;
  };
  const baseline = snapshot.records.find((record) => {
    const axes = parseEvidenceAxes(record);
    return (
      axes.valid &&
      axes.runPurpose === "baseline" &&
      axes.evaluationAuthority === "accepted-contract" &&
      record.preconditionEpoch === snapshot.semanticFacts.preconditionEpoch &&
      fingerprint(record) != null
    );
  });
  const referenceFingerprint = baseline ? fingerprint(baseline) : null;
  let referenceRepeats = baseline ? 1 : 0;
  const experiments: UnknownRecord[] = [];
  let group: UnknownRecord[] = [];
  let groupFingerprint: string | null = null;
  const flush = (pending: boolean) => {
    if (group.length && (!pending || group.length >= repeats)) {
      // Preserve real learning from any required repeat without multiplying its votes.
      const qualification = group.slice(0, repeats);
      experiments.push(
        [...qualification]
          .reverse()
          .find((record) => validatedLearning(record.learning).kind !== "none") ??
          qualification.at(-1)!,
      );
      experiments.push(...group.slice(repeats));
    }
    group = [];
    groupFingerprint = null;
  };
  for (const record of eligible) {
    const identity = fingerprint(record);
    if (
      record.status === "measure" &&
      identity &&
      identity === referenceFingerprint &&
      referenceRepeats < repeats
    ) {
      flush(false);
      referenceRepeats += 1;
      continue;
    }
    if (!identity) {
      flush(false);
      experiments.push(record);
    } else {
      if (groupFingerprint && groupFingerprint !== identity) flush(false);
      groupFingerprint = identity;
      group.push(record);
      if (record.status !== "measure") flush(false);
    }
  }
  // The current unfinished cohort is still collecting the contract-required evidence.
  flush(true);
  return experiments;
}

function validatedLearning(value: unknown): DecisionPlan["learning"]["latest"] {
  const none = { kind: "none" as const, changedBelief: null, evidence: [] };
  if (!isUnknownRecord(value)) return none;
  if (value.kind !== "causal" && value.kind !== "discriminating") return none;
  if (!nonEmptyString(value.changedBelief)) return none;
  if (!isNonEmptyStringArray(value.evidence)) return none;
  return {
    kind: value.kind,
    changedBelief: value.changedBelief.trim(),
    evidence: [...new Set(value.evidence.map((item) => item.trim()))].sort(),
  };
}

function classifyFailures(snapshot: CoherentSessionSnapshot): DecisionPlan["failures"] {
  const eligible = eligibleCandidateRuns(snapshot);
  let layer: FailureLayer | null = null;
  let preconditionIdentity = "";
  let consecutive = 0;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const failureValue = eligible[index].failure;
    if (!isUnknownRecord(failureValue)) break;
    const failure: UnknownRecord = failureValue;
    const rawLayer = failure["layer"];
    const candidateLayer = isFailureLayer(rawLayer) ? rawLayer : null;
    if (!candidateLayer) break;
    const candidateIdentity = validatedFailurePreconditionIdentity(
      candidateLayer,
      failure,
      snapshot,
    );
    if (!candidateIdentity) break;
    if (layer == null) layer = candidateLayer;
    if (candidateLayer !== layer) break;
    if (!preconditionIdentity) preconditionIdentity = candidateIdentity;
    if (candidateIdentity !== preconditionIdentity) break;
    consecutive += 1;
  }
  return { layer, consecutive };
}

function validatedFailurePreconditionIdentity(
  layer: FailureLayer,
  failure: UnknownRecord,
  snapshot: CoherentSessionSnapshot,
): string {
  const preconditions = isUnknownRecord(failure.preconditions) ? failure.preconditions : null;
  if (!preconditions) return "";
  const required = failureLayerPreconditions[layer];
  if (required.some((name) => !nonEmptyString(preconditions[name]))) return "";
  if (
    required.includes("preconditionEpoch") &&
    preconditions.preconditionEpoch !== snapshot.semanticFacts.preconditionEpoch
  ) {
    return "";
  }
  if (
    required.includes("contractDigest") &&
    preconditions.contractDigest !== snapshot.semanticFacts.contractDigest
  ) {
    return "";
  }
  if (layer === "evaluator") {
    const identity = `${preconditions.acceptedEvaluatorIdentity}@${preconditions.acceptedEvaluatorExecutionDigest}`;
    if (identity !== snapshot.semanticFacts.evaluatorIdentity) return "";
  }
  if (layer === "accepted-check") {
    const identity = `${preconditions.acceptedCheckIdentity}@${preconditions.acceptedCheckExecutionDigest}`;
    if (!snapshot.semanticFacts.acceptedCheckIdentities.includes(identity)) return "";
  }
  return nonEmptyString(failure.code)
    ? canonicalJson({
        code: failure.code,
        preconditions: Object.fromEntries(required.map((name) => [name, preconditions[name]])),
      })
    : "";
}

function eligibleCandidateRuns(snapshot: CoherentSessionSnapshot): UnknownRecord[] {
  const contractDigest = snapshot.semanticFacts.contractDigest;
  const preconditionEpoch = snapshot.semanticFacts.preconditionEpoch;
  return snapshot.records.filter((record) => {
    const axes = parseEvidenceAxes(record);
    if (
      !axes.valid ||
      axes.runPurpose !== "candidate" ||
      axes.evaluationAuthority !== "accepted-contract" ||
      axes.candidateOrigin.kind === "none"
    ) {
      return false;
    }
    const evaluation = isUnknownRecord(record.contractEvaluationEvidence)
      ? record.contractEvaluationEvidence
      : null;
    if ((record.experimentContractDigest || evaluation?.contractDigest) !== contractDigest) {
      return false;
    }
    if (record.preconditionEpoch !== preconditionEpoch) return false;
    const failure = isUnknownRecord(record.failure) ? record.failure : null;
    return !isProvenExternalInfrastructureFailure(failure, snapshot);
  });
}

function isProvenExternalInfrastructureFailure(
  failure: UnknownRecord | null,
  snapshot: CoherentSessionSnapshot,
): boolean {
  return Boolean(
    failure?.layer === "external-infrastructure" &&
    validatedFailurePreconditionIdentity("external-infrastructure", failure, snapshot),
  );
}

function resultOutcome(result: ResultSemantics): DecisionPlan["outcome"] {
  return {
    ...result,
    kind:
      result.movement === "unknown"
        ? result.validity === "valid"
          ? "uncompared"
          : "invalid"
        : result.movement,
  };
}

function classifyOutcome(snapshot: CoherentSessionSnapshot): DecisionPlan["outcome"] {
  const unknown = () => resultOutcome(classifyResult({ kind: "invalid", execution: "unknown" }));
  const latest = latestAcceptedCandidateRun(snapshot);
  if (!latest) return unknown();
  const acceptance = isAcceptedCurrentRun(latest)
    ? "accepted"
    : ["discard", "crash", "checks_failed"].includes(String(latest.status))
      ? "rejected"
      : "unassessed";
  const failure = isUnknownRecord(latest.failure) ? latest.failure : null;
  // Legacy checks_failed includes timeout and harness failure; a predicate
  // observation is required to establish a valid counterexample.
  if (failure || latest.status === "crash" || latest.status === "checks_failed")
    return resultOutcome(classifyResult({ kind: "invalid", execution: "failed" }, acceptance));
  const metric = finiteNumber(latest.metric);
  if (metric === null)
    return resultOutcome(classifyResult({ kind: "invalid", execution: "completed" }, acceptance));
  const contract = acceptedContract(snapshot.records, snapshot.semanticFacts.contractDigest);
  const semantics = isUnknownRecord(contract?.metric) ? contract.metric : null;
  if (!semantics) return unknown();
  let target: Extract<EvaluatorObservation, { kind: "metric" }>["target"] = null;
  if (semantics.kind === "threshold") {
    const value = finiteNumber(semantics.target);
    const comparator = semantics.comparator;
    if (
      value === null ||
      (comparator !== "<" &&
        comparator !== "<=" &&
        comparator !== "=" &&
        comparator !== ">=" &&
        comparator !== ">")
    )
      return unknown();
    target = { value, comparator };
  } else if (semantics.kind !== "minimize" && semantics.kind !== "maximize") return unknown();
  const direction =
    semantics.kind === "minimize" || target?.comparator === "<" || target?.comparator === "<="
      ? "lower"
      : semantics.kind === "maximize" || target?.comparator === ">" || target?.comparator === ">="
        ? "higher"
        : "none";
  const latestRecordIndex = snapshot.records.lastIndexOf(latest as never);
  const referenceValues = snapshot.records
    .slice(0, latestRecordIndex < 0 ? undefined : latestRecordIndex)
    .filter((record) => isEligibleOutcomeReference(record, snapshot))
    .filter(isAcceptedReferenceRun)
    .map((record) => finiteNumber(record.metric))
    .filter((value): value is number => value != null);
  const reference =
    referenceValues.length === 0
      ? null
      : direction === "lower"
        ? Math.min(...referenceValues)
        : Math.max(...referenceValues);
  const noise = isUnknownRecord(contract?.noise) ? contract.noise : null;
  return resultOutcome(
    classifyResult(
      {
        kind: "metric",
        value: metric,
        reference,
        direction,
        minimumImprovement: finiteNumber(semantics.minimumImprovement) ?? 0,
        tolerance: noise?.kind === "bounded" ? (finiteNumber(noise.tolerance) ?? 0) : 0,
        target,
      },
      acceptance,
    ),
  );
}

function latestAcceptedCandidateRun(snapshot: CoherentSessionSnapshot): UnknownRecord | null {
  const contractDigest = snapshot.semanticFacts.contractDigest;
  const preconditionEpoch = snapshot.semanticFacts.preconditionEpoch;
  return (
    [...snapshot.records].reverse().find((record) => {
      const axes = parseEvidenceAxes(record);
      if (
        !axes.valid ||
        axes.runPurpose !== "candidate" ||
        axes.evaluationAuthority !== "accepted-contract" ||
        axes.candidateOrigin.kind === "none"
      ) {
        return false;
      }
      const evaluation = isUnknownRecord(record.contractEvaluationEvidence)
        ? record.contractEvaluationEvidence
        : null;
      return (
        (record.experimentContractDigest || evaluation?.contractDigest) === contractDigest &&
        record.preconditionEpoch === preconditionEpoch
      );
    }) || null
  );
}

function isEligibleOutcomeReference(
  record: UnknownRecord,
  snapshot: CoherentSessionSnapshot,
): boolean {
  const axes = parseEvidenceAxes(record);
  if (
    !axes.valid ||
    axes.evaluationAuthority !== "accepted-contract" ||
    (axes.runPurpose !== "baseline" && axes.runPurpose !== "candidate")
  ) {
    return false;
  }
  const evaluation = isUnknownRecord(record.contractEvaluationEvidence)
    ? record.contractEvaluationEvidence
    : null;
  return (
    (record.experimentContractDigest || evaluation?.contractDigest) ===
      snapshot.semanticFacts.contractDigest &&
    record.preconditionEpoch === snapshot.semanticFacts.preconditionEpoch
  );
}

function acceptedContract(
  records: readonly UnknownRecord[],
  contractDigest: string,
): UnknownRecord | null {
  const event = [...records]
    .reverse()
    .find(
      (record) =>
        record.type === "experiment-contract-accepted" &&
        isUnknownRecord(record.contract) &&
        record.contract.contractDigest === contractDigest,
    );
  return isUnknownRecord(event?.contract) ? event.contract : null;
}

function isAcceptedReferenceRun(record: UnknownRecord): boolean {
  if (record.status !== "keep" && record.status !== "measure") return false;
  if (record.evidenceStatus === "rejected" || record.evidenceStatus === "superseded") return false;
  return !isUnknownRecord(record.failure);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFailureLayer(value: unknown): value is FailureLayer {
  return typeof value === "string" && Object.hasOwn(failureLayerPreconditions, value);
}

function decisionIdForPlan(
  plan: Omit<DecisionPlan, "decisionId">,
  diagnostics: readonly DecisionDiagnostic[],
): string {
  return sha256(
    canonicalJson({
      compilerSchemaVersion: plan.compilerSchemaVersion,
      phase: plan.phase,
      action: {
        kind: plan.action.kind,
        commandSemanticId: plan.action.commandSemanticId,
      },
      primaryBlockerCode: plan.primaryBlockerCode,
      diagnostics: diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        semantic: diagnostic.semantic || null,
        commandSemanticId: commandSemanticIdentity(diagnostic),
        blockedCapabilities: decisionDiagnosticRegistry[diagnostic.code].blocked,
        recoveryOnlyCapabilities: decisionDiagnosticRegistry[diagnostic.code].recoveryOnly || [],
      })),
      capabilities: plan.capabilities,
      loopDisposition: plan.loopDisposition,
      parentDisposition: plan.parentDisposition,
      contractDigest: plan.contractDigest,
      evaluatorIdentity: plan.evaluatorIdentity,
      requiredEvidence: plan.requiredEvidence,
      investigation: plan.investigation,
      outcome: plan.outcome,
      learning: plan.learning,
      failures: plan.failures,
    }),
  );
}

function defaultReason(code: DecisionDiagnosticCode | undefined): string {
  if (!code) return "Run the next accepted packet when direct work is complete.";
  return code.replaceAll("-", " ");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isUnknownRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function compileOutcomeInvestigation(snapshot: CoherentSessionSnapshot): {
  projection: OutcomeDecisionProjection;
  diagnostics: DecisionDiagnostic[];
} {
  const state = snapshot.outcome!;
  const usage = outcomeUsage(state);
  const budget = state.contract.budget;
  const outstanding = state.executions.find(
    (receipt) => !["completed", "failed", "cancelled"].includes(receipt.status.kind),
  );
  const remaining = {
    actions: budget.actions === null ? null : Math.max(0, budget.actions - usage.actions),
    executionSeconds:
      budget.executionSeconds === null
        ? null
        : Math.max(0, budget.executionSeconds - usage.measuredSeconds - usage.reservedSeconds),
    deadline: budget.deadline,
    unknownExecutions: usage.unknownExecutions,
  };
  const exhausted =
    remaining.actions === 0 ||
    remaining.executionSeconds === 0 ||
    (budget.deadline !== null && Date.parse(budget.deadline) <= Date.now());
  const drift =
    snapshot.outcomeFacts?.drift ??
    (!snapshot.outcomeFacts?.input ? "Complete current input provenance is unavailable." : null);
  let code: DecisionDiagnosticCode = drift
    ? "outcome-input-drift"
    : state.lifecycle.kind === "stopped-unmet"
      ? "outcome-stopped"
      : outstanding
        ? outstanding.status.kind === "ticket"
          ? "outcome-ticket"
          : "outcome-outstanding"
        : exhausted
          ? "outcome-budget-exhausted"
          : "outcome-active";
  if (usage.unknownExecutions && !drift) code = "outcome-outstanding";
  const status = ["outcome-stopped", "outcome-budget-exhausted"].includes(code)
    ? "stopped-unmet"
    : ["outcome-input-drift", "outcome-outstanding"].includes(code)
      ? "blocked"
      : "active";
  const question =
    state.investigations.find((item) => item.id === outstanding?.action.investigation.id)
      ?.question ??
    [...state.investigations].reverse().find((item) => item.resolution === "active")?.question ??
    null;
  const projection: OutcomeDecisionProjection = {
    id: state.contract.id,
    objective: state.contract.objective,
    status,
    question,
    executionId: outstanding?.id ?? null,
    remaining,
    unresolvedCriteria: state.contract.criteria.map((criterion) => criterion.id),
    delivery: { endpoint: state.contract.authorization.delivery, status: "pending" },
    inputDigest: snapshot.outcomeFacts?.input?.digest ?? null,
  };
  const messages: Partial<Record<DecisionDiagnosticCode, string>> = {
    "outcome-active": "Propose the next bounded action within the accepted outcome grant.",
    "outcome-ticket": "Complete the authorized action ticket, then log its observation.",
    "outcome-outstanding": "Resume and reconcile the existing execution; do not relaunch it.",
    "outcome-stopped":
      "This outcome stopped unmet. Preserve unresolved criteria and the remaining allowance for a resumable handoff.",
    "outcome-budget-exhausted":
      "The accepted cumulative allowance is exhausted. Hand back unresolved criteria; renewed work requires an explicit amendment.",
    "outcome-input-drift": drift ?? "Input provenance changed.",
  };
  const args = outstanding
    ? ["next", "--cwd", outstanding.worktree, "--resume", outstanding.id]
    : code === "outcome-active"
      ? ["next", "--cwd", snapshot.workDir, "--action-file", "<action.json>"]
      : [
          "outcome",
          "amend",
          "--cwd",
          snapshot.workDir,
          "--contract-file",
          "<contract.json>",
          "--authorization",
          "<reference>",
          "--reason",
          "<reason>",
        ];
  const command = renderShellCommand([
    process.execPath,
    path.join(resolvePackageRoot(import.meta.url), "scripts", "autoresearch.mjs"),
    ...args,
  ]);
  return {
    projection,
    diagnostics: [
      decisionDiagnostic(code, {
        message: messages[code],
        command,
        semantic: { outcome: projection },
      }),
    ],
  };
}

function isOutcomeDecisionProjection(value: unknown): value is OutcomeDecisionProjection {
  if (
    !isUnknownRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "objective",
      "status",
      "question",
      "executionId",
      "remaining",
      "unresolvedCriteria",
      "delivery",
      "inputDigest",
    ])
  )
    return false;
  const remaining = isUnknownRecord(value.remaining) ? value.remaining : null;
  const delivery = isUnknownRecord(value.delivery) ? value.delivery : null;
  return (
    nonEmptyString(value.id) &&
    nonEmptyString(value.objective) &&
    typeof value.status === "string" &&
    ["active", "blocked", "satisfied", "stopped-unmet"].includes(value.status) &&
    (value.question === null || nonEmptyString(value.question)) &&
    (value.executionId === null || nonEmptyString(value.executionId)) &&
    (value.inputDigest === null || nonEmptyString(value.inputDigest)) &&
    isStringArray(value.unresolvedCriteria) &&
    remaining !== null &&
    hasExactKeys(remaining, ["actions", "executionSeconds", "deadline", "unknownExecutions"]) &&
    (remaining.actions === null || isNonnegativeInteger(remaining.actions)) &&
    (remaining.executionSeconds === null ||
      (typeof remaining.executionSeconds === "number" &&
        Number.isFinite(remaining.executionSeconds) &&
        remaining.executionSeconds >= 0)) &&
    (remaining.deadline === null || nonEmptyString(remaining.deadline)) &&
    isNonnegativeInteger(remaining.unknownExecutions) &&
    delivery !== null &&
    hasExactKeys(delivery, ["endpoint", "status"]) &&
    typeof delivery.endpoint === "string" &&
    ["answer", "patch", "integrated", "deployed"].includes(delivery.endpoint) &&
    typeof delivery.status === "string" &&
    ["pending", "ready", "delivered"].includes(delivery.status)
  );
}
