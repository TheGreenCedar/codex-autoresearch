import { createHash } from "node:crypto";

import type { CoherentSessionSnapshot } from "./coherent-session-snapshot.js";
import { parseEvidenceAxes } from "./evidence-axes.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

export const DECISION_COMPILER_SCHEMA_VERSION = 1 as const;

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

export type DecisionDiagnosticCode =
  | "active-process"
  | "approval-required"
  | "benchmark-required"
  | "checks-required"
  | "coherent-snapshot-unavailable"
  | "context-distillation"
  | "dirty-source"
  | "evaluator-drift"
  | "finalization-blocked"
  | "finalization-claim-blocked"
  | "finalization-ready"
  | "goal-mismatch"
  | "ledger-integrity"
  | "needs-baseline"
  | "no-learning-pause"
  | "packet-budget-exhausted"
  | "packet-diagnostic"
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
  actionKind: string;
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
  "coherent-snapshot-unavailable": recoveryPolicy(0, DECISION_CAPABILITIES),
  "pending-log-transaction-inconsistent": recoveryPolicy(1, ALL_EXCEPT_MUTATE, ["mutate-session"]),
  "pending-log-transaction": recoveryPolicy(2, ALL_EXCEPT_MUTATE, ["mutate-session"]),
  "ledger-integrity": recoveryPolicy(3, ALL_EXCEPT_MUTATE, ["mutate-session"]),
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
  "stale-packet": {
    priority: 18,
    phase: "packet",
    actionKind: "replace-packet",
    blocked: [],
    recoveryOnly: PACKET_ONLY,
    primaryBlocker: true,
    loop: "blocked",
  },
  "packet-diagnostic": blockedPolicy(19, "packet", "inspect-packet", PACKET_ONLY),
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
  "finalization-blocked": blockedPolicy(
    41,
    "direct-work",
    "direct-work",
    FINALIZE_ONLY,
    "continue",
  ),
  "finalization-ready": guidancePolicy(50, "finalization", "finalize"),
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

export interface DecisionPlan {
  kind: "decision-plan";
  compilerSchemaVersion: 1;
  generationId: string;
  decisionId: string;
  phase: DecisionPhase;
  action: {
    kind: string;
    reason: string;
    command: string;
    commandDigest: string;
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
  outcome: {
    kind: "improved" | "invalid" | "regressed" | "threshold-met" | "unknown";
  };
  learning: {
    latest: { kind: "causal" | "discriminating" | "none" };
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

export function compileDecisionPlan(
  snapshot: CoherentSessionSnapshot,
  diagnostics: readonly DecisionDiagnostic[],
): DecisionPlan {
  const learning = classifyLearning(snapshot);
  const failures = classifyFailures(snapshot);
  const automatic: DecisionDiagnostic[] = [];
  if (snapshot.pendingTransaction) {
    automatic.push(decisionDiagnostic(snapshot.pendingTransaction.diagnosticCode));
  }
  if (learning.consecutiveNoLearningCandidates >= 2) {
    automatic.push(decisionDiagnostic("no-learning-pause"));
  }
  if (failures.consecutive >= 2) {
    automatic.push(
      decisionDiagnostic("same-layer-failure-pause", {
        semantic: { layer: failures.layer },
      }),
    );
  }
  const normalizedDiagnostics = normalizeDiagnostics([...diagnostics, ...automatic]);
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
    contractDigest: snapshot.semanticFacts.contractDigest,
    evaluatorIdentity: snapshot.semanticFacts.evaluatorIdentity,
    requiredEvidence: {
      preconditionEpoch: snapshot.semanticFacts.preconditionEpoch,
      acceptedCheckIdentities: snapshot.semanticFacts.acceptedCheckIdentities,
      diagnosticCodes: normalizedDiagnostics.map((diagnostic) => diagnostic.code),
      capabilityEffectCodes: Object.entries(compiledCapabilities).flatMap(([capability, value]) =>
        value.diagnosticCodes.map((code) => `${code}:${capability}:${value.status}`),
      ),
      failureLayer: failures.layer,
      failurePreconditions: failures.layer ? failureLayerPreconditions[failures.layer] : [],
    },
    outcome: classifyOutcome(snapshot),
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
  actionKind: string,
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
  actionKind: string,
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

function normalizeDiagnostics(diagnostics: readonly DecisionDiagnostic[]): DecisionDiagnostic[] {
  const byIdentity = new Map<string, DecisionDiagnostic>();
  for (const diagnostic of diagnostics) {
    if (!decisionDiagnosticRegistry[diagnostic.code]) {
      throw new Error(`Unknown decision diagnostic code: ${String(diagnostic.code)}`);
    }
    const identity = diagnosticSemanticIdentity(diagnostic);
    if (!byIdentity.has(identity)) byIdentity.set(identity, diagnostic);
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

function diagnosticSemanticIdentity(diagnostic: DecisionDiagnostic): string {
  return canonicalJson({
    code: diagnostic.code,
    semantic: diagnostic.semantic || null,
  });
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
  const eligible = eligibleCandidateRuns(snapshot);
  let consecutive = 0;
  let latest: DecisionPlan["learning"]["latest"] = { kind: "none" };
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const record = eligible[index];
    const learning = validatedLearning(record.learning);
    if (index === eligible.length - 1) latest = learning;
    if (learning.kind !== "none") break;
    consecutive += 1;
  }
  return { latest, consecutiveNoLearningCandidates: consecutive };
}

function validatedLearning(value: unknown): DecisionPlan["learning"]["latest"] {
  if (!isUnknownRecord(value)) return { kind: "none" };
  if (value.kind !== "causal" && value.kind !== "discriminating") return { kind: "none" };
  if (value.changedBelief !== true) return { kind: "none" };
  if (!Array.isArray(value.evidence) || value.evidence.filter(nonEmptyString).length === 0) {
    return { kind: "none" };
  }
  return { kind: value.kind };
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
  if (layer === "external-infrastructure") return "";
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
  return canonicalJson(Object.fromEntries(required.map((name) => [name, preconditions[name]])));
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
    return failure?.layer !== "external-infrastructure";
  });
}

function classifyOutcome(snapshot: CoherentSessionSnapshot): DecisionPlan["outcome"] {
  const eligible = eligibleCandidateRuns(snapshot);
  const latest = eligible.at(-1);
  if (!latest) return { kind: "unknown" };
  const failure = isUnknownRecord(latest.failure) ? latest.failure : null;
  if (failure && failure.layer !== "external-infrastructure") return { kind: "invalid" };
  const metric = finiteNumber(latest.metric);
  if (metric == null) return { kind: "invalid" };
  const contract = acceptedContract(snapshot.records, snapshot.semanticFacts.contractDigest);
  const semantics = isUnknownRecord(contract?.metric) ? contract.metric : null;
  if (!semantics) return { kind: "unknown" };
  if (semantics.kind === "threshold") {
    const target = finiteNumber(semantics.target);
    const comparator = String(semantics.comparator || "");
    if (target == null || !["<", "<=", "=", ">=", ">"].includes(comparator)) {
      return { kind: "unknown" };
    }
    return thresholdSatisfied(metric, comparator, target)
      ? { kind: "threshold-met" }
      : { kind: "regressed" };
  }
  if (semantics.kind !== "minimize" && semantics.kind !== "maximize") {
    return { kind: "unknown" };
  }
  const referenceValues = eligible
    .slice(0, -1)
    .filter(isAcceptedReferenceRun)
    .map((record) => finiteNumber(record.metric))
    .filter((value): value is number => value != null);
  if (referenceValues.length === 0) return { kind: "unknown" };
  const reference =
    semantics.kind === "minimize" ? Math.min(...referenceValues) : Math.max(...referenceValues);
  const improvement = semantics.kind === "minimize" ? reference - metric : metric - reference;
  const minimumImprovement = finiteNumber(semantics.minimumImprovement) ?? 0;
  const noise = isUnknownRecord(contract?.noise) ? contract.noise : null;
  const tolerance = noise?.kind === "bounded" ? (finiteNumber(noise.tolerance) ?? 0) : 0;
  return improvement > 0 && improvement >= minimumImprovement && improvement > tolerance
    ? { kind: "improved" }
    : { kind: "regressed" };
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

function thresholdSatisfied(metric: number, comparator: string, target: number): boolean {
  if (comparator === "<") return metric < target;
  if (comparator === "<=") return metric <= target;
  if (comparator === "=") return metric === target;
  if (comparator === ">=") return metric >= target;
  return metric > target;
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
      },
      primaryBlockerCode: plan.primaryBlockerCode,
      diagnostics: diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        semantic: diagnostic.semantic || null,
        blockedCapabilities: decisionDiagnosticRegistry[diagnostic.code].blocked,
        recoveryOnlyCapabilities: decisionDiagnosticRegistry[diagnostic.code].recoveryOnly || [],
      })),
      capabilities: plan.capabilities,
      loopDisposition: plan.loopDisposition,
      parentDisposition: plan.parentDisposition,
      contractDigest: plan.contractDigest,
      evaluatorIdentity: plan.evaluatorIdentity,
      requiredEvidence: plan.requiredEvidence,
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
