import {
  loadCoherentSessionSnapshot,
  CoherentSnapshotSourceError,
  type CoherentSessionSnapshot,
  type CoherentSnapshotLoadResult,
} from "./coherent-session-snapshot.js";
import {
  compileDecisionPlan,
  decisionDiagnostic,
  type DecisionDiagnostic,
  type DecisionPlan,
} from "./decision-compiler.js";
import {
  continuationCommands,
  continuationLogCommand,
  type ContinuationLogStatus,
} from "./commands/continuation.js";
import { analyzeLedgerHealth } from "./ledger-health.js";
import { lastRunPacketFreshnessFromFacts } from "./last-run-store.js";
import {
  approvalRequirementsFromLaneResults,
  buildApprovalLedgerStatus,
} from "./approval-ledger.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";
import { stateFromSessionRecords } from "./session-core.js";
import type { LastRunPacket } from "./types/packet.js";
import { buildScaffoldHealth } from "./truth-signals.js";
import { operatorWarningsForWorkDir } from "./operator-warnings.js";
import { buildSourceCleanliness } from "./source-cleanliness.js";
import { classifyPacketDiagnostics } from "./packet-diagnostics.js";
import { decisionGuidance } from "./decision-guidance.js";
import { currentQualityGapSummary } from "./research-gaps.js";
import { buildCheapFinalizationPressure } from "./session-read-model.js";
import { isAcceptedCurrentRun } from "./evidence-registry.js";
import {
  contractDerivationError,
  contractStopStatus,
  deriveExperimentContract,
} from "./experiment-contract.js";
import {
  blockedFinalizationDecisionFact,
  isFinalizationDecisionFact,
  type FinalizationDecisionFact,
} from "./finalization-decision-fact.js";

export interface SessionDecisionFacts {
  finalization?: UnknownRecord | null;
  finalizationDecisionFact?: FinalizationDecisionFact | null;
  finalizationClaimRequired?: boolean;
  diagnostics?: readonly DecisionDiagnostic[];
  packetFreshness?: UnknownRecord | null;
}

export class CanonicalSessionSourceError extends CoherentSnapshotSourceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CanonicalSessionSourceError";
  }
}

export interface SessionDecisionFactCollection {
  finalization: UnknownRecord | null;
  finalizationDecisionFact: FinalizationDecisionFact | null;
  finalizationClaimRequired: boolean;
  diagnostics: DecisionDiagnostic[];
  scaffoldHealth: UnknownRecord;
  warningDetails: UnknownRecord[];
  sourceCleanliness: UnknownRecord;
  packetDiagnostics: UnknownRecord;
  packetFreshness: UnknownRecord | null;
  guidance: UnknownRecord;
  qualityGap: UnknownRecord | null;
}

export type CanonicalSessionDecisionResult =
  | {
      ok: true;
      attempts: number;
      snapshot: CoherentSessionSnapshot;
      plan: DecisionPlan;
      factCollection?: SessionDecisionFactCollection;
    }
  | Extract<CoherentSnapshotLoadResult, { ok: false }>;

export async function loadCanonicalSessionDecision({
  requestedCwd,
  allowOutsideWorkdir = false,
  allowLedgerParseErrors = false,
  facts = {},
}: {
  requestedCwd: string;
  allowOutsideWorkdir?: boolean;
  allowLedgerParseErrors?: boolean;
  facts?: SessionDecisionFacts;
}): Promise<CanonicalSessionDecisionResult> {
  let factCollection: SessionDecisionFactCollection | null = null;
  const loaded = await loadCoherentSessionSnapshot({
    requestedCwd,
    allowOutsideWorkdir,
    inspectCapturedSnapshot: async (snapshot) => {
      if (!allowLedgerParseErrors && snapshot.sourceDiagnostics.ledgerIssues.length > 0) {
        throw new CanonicalSessionSourceError(snapshot.sourceDiagnostics.ledgerIssues[0].message);
      }
      factCollection = await collectSessionDecisionFacts(snapshot, facts);
      return sessionDecisionFactCollectionVersion(snapshot, factCollection);
    },
  });
  if (!loaded.ok) return loaded;
  if (!factCollection) {
    throw new Error(
      "Canonical session fact collection was not captured inside the accepted attempt.",
    );
  }
  return {
    ...loaded,
    plan: compileSessionDecision(loaded.snapshot, factCollection),
    factCollection,
  };
}

export function sessionDecisionFactCollectionVersion(
  snapshot: CoherentSessionSnapshot,
  facts: SessionDecisionFactCollection,
): string {
  return compileSessionDecision(snapshot, facts).decisionId;
}

export async function compileCanonicalSessionDecision(
  snapshot: CoherentSessionSnapshot,
  facts: SessionDecisionFacts = {},
): Promise<{ plan: DecisionPlan; factCollection: SessionDecisionFactCollection }> {
  const factCollection = await collectSessionDecisionFacts(snapshot, facts);
  return {
    plan: compileSessionDecision(snapshot, factCollection),
    factCollection,
  };
}

export function compileSessionDecision(
  snapshot: CoherentSessionSnapshot,
  facts: SessionDecisionFacts = {},
): DecisionPlan {
  const packetFreshness = Object.hasOwn(facts, "packetFreshness")
    ? facts.packetFreshness || null
    : packetFreshnessFromSnapshot(snapshot);
  const legacyContractDiagnosticPresent = (facts.diagnostics || []).some(
    ({ code }) =>
      code === "legacy-contract-acceptance-required" || code === "legacy-contract-conflict",
  );
  return compileDecisionPlan(snapshot, [
    ...diagnosticsFromSnapshot(snapshot, packetFreshness, legacyContractDiagnosticPresent),
    ...finalizationDecisionDiagnostics(facts, snapshot.workDir),
    ...(facts.diagnostics || []),
  ]);
}

export async function collectSessionDecisionFacts(
  snapshot: CoherentSessionSnapshot,
  overrides: SessionDecisionFacts = {},
): Promise<SessionDecisionFactCollection> {
  const state = stateFromSessionRecords(snapshot.workDir, snapshot.records);
  const scaffoldHealth = (await buildScaffoldHealth({
    workDir: snapshot.workDir,
    config: snapshot.config,
  })) as UnknownRecord;
  const warningDetails = (await operatorWarningsForWorkDir(
    snapshot.workDir,
    state as UnknownRecord,
    snapshot.config,
    { records: snapshot.records },
  )) as UnknownRecord[];
  const sourceCleanliness = buildSourceCleanliness({ warningDetails }) as unknown as UnknownRecord;
  const packetFreshness = packetFreshnessFromSnapshot(snapshot);
  const lastRun = snapshot.lastRunPacket;
  const lastRunDecision = object(lastRun?.decision);
  const lastRunRecord = object(lastRun?.run);
  const lastRunEvidence = object(lastRun?.packetEvidence);
  const packetDiagnostics = (lastRun
    ? classifyPacketDiagnostics({
        packetEvidence: lastRunEvidence,
        run: lastRunRecord,
        decision: lastRunDecision,
        metrics: objectOrNull(lastRunDecision.metrics) || object(lastRunRecord.parsedMetrics),
        metricName: state.config.metricName,
        command: continuationCommands(snapshot.workDir).partialResults,
      })
    : classifyPacketDiagnostics()) as unknown as UnknownRecord;
  const guidance = (await decisionGuidance({
    workDir: snapshot.workDir,
    config: snapshot.config,
    state,
    scaffoldHealth,
    warningDetails,
  })) as UnknownRecord;
  const qualityGap = (await currentQualityGapSummary(snapshot.workDir).catch(
    (): null => null,
  )) as UnknownRecord | null;
  let finalization: UnknownRecord | null;
  let finalizationDecisionFact: FinalizationDecisionFact | null;
  if (Object.hasOwn(overrides, "finalization")) {
    finalization = overrides.finalization || null;
    finalizationDecisionFact = isFinalizationDecisionFact(overrides.finalizationDecisionFact)
      ? overrides.finalizationDecisionFact
      : finalization
        ? blockedFinalizationDecisionFact()
        : null;
  } else {
    const collectedFinalization = await collectFinalizationFacts({
      snapshot,
      state: state as UnknownRecord,
      qualityGap,
      warningDetails,
    });
    finalization = collectedFinalization.finalization;
    finalizationDecisionFact = collectedFinalization.decisionFact;
  }
  const contractDiagnostics = await contractDecisionDiagnostics(snapshot);
  const diagnostics = [
    ...decisionDiagnosticsForCollectedFacts({
      guidance,
      packetDiagnostics,
      scaffoldHealth,
      sourceCleanliness,
      warningDetails,
      hasFreshPacketAuthority: packetFreshness?.fresh === true,
    }),
    ...contractDiagnostics,
    ...(overrides.diagnostics || []),
  ];
  return {
    finalization,
    finalizationDecisionFact,
    finalizationClaimRequired: overrides.finalizationClaimRequired === true,
    diagnostics,
    scaffoldHealth,
    warningDetails,
    sourceCleanliness,
    packetDiagnostics,
    packetFreshness,
    guidance,
    qualityGap,
  };
}

export function packetFreshnessFromSnapshot(
  snapshot: CoherentSessionSnapshot,
): UnknownRecord | null {
  const packet = snapshot.lastRunPacket;
  if (!packet) return null;
  const state = stateFromSessionRecords(snapshot.workDir, snapshot.records);
  return lastRunPacketFreshnessFromFacts({
    workDir: snapshot.workDir,
    packet: packet as LastRunPacket,
    runtimeConfig: snapshot.config,
    state,
    actualGit: snapshot.gitTrust || {
      inside: snapshot.git.head !== "not-a-repository",
      head: snapshot.git.head === "unborn" ? "" : snapshot.git.head.slice(0, 7),
      statusHash: snapshot.git.statusHash,
    },
  }) as UnknownRecord;
}

function diagnosticsFromSnapshot(
  snapshot: CoherentSessionSnapshot,
  packetFreshness: UnknownRecord | null = packetFreshnessFromSnapshot(snapshot),
  legacyContractDiagnosticPresent = false,
): DecisionDiagnostic[] {
  const diagnostics: DecisionDiagnostic[] = [];
  const commands = continuationCommands(snapshot.workDir);
  const state = ledgerState(snapshot.records);
  const ledgerHealth = analyzeLedgerHealth(snapshot.records, {
    parseErrors: snapshot.sourceDiagnostics.ledgerIssues,
  });
  if (!ledgerHealth.ok) {
    diagnostics.push(
      decisionDiagnostic("ledger-integrity", {
        message: ledgerHealth.warnings[0] || "The session ledger is not structurally sound.",
        command: commands.ledgerDoctor,
      }),
    );
  }
  const approvalLedger = buildApprovalLedgerStatus({
    entries: snapshot.records,
    required: approvalRequirementsFromLaneResults(snapshot.records),
  });
  if (approvalLedger.status === "blocked") {
    diagnostics.push(
      decisionDiagnostic("approval-required", {
        message: approvalLedger.blockers[0] || "A required approval is missing.",
        semantic: {
          requirements: approvalLedger.required
            .map(({ gate, scope }) => ({ gate, scope }))
            .sort((left, right) =>
              `${left.gate}:${left.scope}`.localeCompare(`${right.gate}:${right.scope}`),
            ),
        },
      }),
    );
  }
  if (
    !legacyContractDiagnosticPresent &&
    (!state.config.name || !state.config.metricName || !snapshot.semanticFacts.contractDigest)
  ) {
    diagnostics.push(
      decisionDiagnostic("setup-required", {
        message:
          "Create or repair a complete accepted experiment contract before running a packet.",
        command: commands.setupPlan,
      }),
    );
  } else if (!state.hasMetricRun) {
    diagnostics.push(
      decisionDiagnostic("needs-baseline", {
        message: "Run and log a baseline under the accepted experiment contract.",
        command: commands.next,
      }),
    );
  }
  if (packetFreshness) {
    const logDisposition =
      packetFreshness.fresh === true ? packetLogDisposition(snapshot.lastRunPacket) : null;
    diagnostics.push(
      decisionDiagnostic(packetFreshness.fresh === true ? "pending-packet" : "stale-packet", {
        message: stringValue(packetFreshness.reason),
        command:
          packetFreshness.fresh === true && logDisposition
            ? continuationLogCommand(snapshot.workDir, logDisposition.selected)
            : commands.next,
        ...(logDisposition
          ? {
              semantic: {
                allowedStatuses: logDisposition.allowed,
                selectedStatus: logDisposition.selected,
              },
            }
          : {}),
      }),
    );
    if (logDisposition && !logDisposition.allowed.includes("keep")) {
      diagnostics.push(
        decisionDiagnostic("packet-keep-not-authorized", {
          message: "The accepted packet evidence does not authorize a keep.",
          semantic: { allowedStatuses: logDisposition.allowed },
        }),
      );
    }
  }
  const process = snapshot.processProgress;
  if (process?.exitState === "termination_failed" || process?.terminationFailed === true) {
    diagnostics.push(
      decisionDiagnostic("process-integrity", {
        message: "Process-tree termination is not proven for the latest session process.",
        command: commands.processRecover,
      }),
    );
  } else if (process?.exitState === "running") {
    diagnostics.push(
      decisionDiagnostic("active-process", {
        message: "A session process is still running.",
        command: commands.stateCompact,
      }),
    );
  }
  return diagnostics;
}

function packetLogDisposition(packet: UnknownRecord | null): {
  allowed: ContinuationLogStatus[];
  selected: ContinuationLogStatus;
} | null {
  const decision = object(packet?.decision);
  const allowed = Array.isArray(decision.allowedStatuses)
    ? [...new Set(decision.allowedStatuses.map(String))].filter(isContinuationLogStatus)
    : [];
  if (allowed.length === 0) return null;
  const preferred = [
    decision.safeSuggestedStatus,
    decision.suggestedStatus,
    decision.rawSuggestedStatus,
  ]
    .map(String)
    .find(
      (status): status is ContinuationLogStatus =>
        isContinuationLogStatus(status) && allowed.includes(status),
    );
  return { allowed, selected: preferred ?? allowed[0] };
}

function isContinuationLogStatus(value: string): value is ContinuationLogStatus {
  return ["keep", "discard", "crash", "checks_failed", "measure"].includes(value);
}

async function contractDecisionDiagnostics(
  snapshot: CoherentSessionSnapshot,
): Promise<DecisionDiagnostic[]> {
  const derivation = await deriveExperimentContract({
    workDir: snapshot.workDir,
    config: snapshot.config,
    entries: snapshot.records,
    packet: snapshot.lastRunPacket,
  });
  if (derivation.status === "accepted") {
    const state = stateFromSessionRecords(snapshot.workDir, snapshot.records);
    const resourceStatus = contractStopStatus(derivation.contract, {
      acceptedAt: derivation.event.timestamp,
      currentRuns: state.current,
    });
    if (resourceStatus.status === "allowed") return [];
    return [
      decisionDiagnostic(
        resourceStatus.dimension === "packets" ? "packet-budget-exhausted" : "resource-exhausted",
        {
          message: resourceStatus.message,
          command: continuationCommands(snapshot.workDir).stateCompact,
          semantic: {
            dimension: resourceStatus.dimension,
            limit: resourceStatus.limit,
            used: resourceStatus.used,
          },
        },
      ),
    ];
  }
  if (derivation.status === "derived") {
    return [
      decisionDiagnostic("legacy-contract-acceptance-required", {
        message:
          "Accept the complete legacy experiment contract exactly once before running this packet.",
        command: continuationCommands(snapshot.workDir).next,
        semantic: { contractDigest: derivation.contract.contractDigest },
      }),
    ];
  }
  if (derivation.status === "invalid" && derivation.missing.length === 0) {
    return [
      decisionDiagnostic("legacy-contract-conflict", {
        message: contractDerivationError(derivation).message,
        command: continuationCommands(snapshot.workDir).stateCompact,
        semantic: {
          conflicts: derivation.conflicts.map(({ field, sources }) => ({ field, sources })),
        },
      }),
    ];
  }
  return [];
}

export function finalizationDecisionDiagnostics(
  facts: SessionDecisionFacts,
  workDir = "",
): DecisionDiagnostic[] {
  const finalization = facts.finalization;
  if (!finalization) return [];
  const decisionFact = facts.finalizationDecisionFact;
  if (decisionFact?.code === "finalization-ready") {
    return [decisionDiagnostic("finalization-ready")];
  }
  if (decisionFact?.code === "current-tree-finalization") {
    return [
      decisionDiagnostic("current-tree-finalization", {
        message: "Package the current non-session tree through the exceptional finalization route.",
        ...(workDir ? { command: continuationCommands(workDir).finalizeCurrentTree } : {}),
        semantic: { actionCode: "current-tree-finalization" },
      }),
    ];
  }
  const code = facts.finalizationClaimRequired
    ? "finalization-claim-blocked"
    : "finalization-blocked";
  return [decisionDiagnostic(code)];
}

async function collectFinalizationFacts({
  snapshot,
  state,
  qualityGap,
  warningDetails,
}: {
  snapshot: CoherentSessionSnapshot;
  state: UnknownRecord;
  qualityGap: UnknownRecord | null;
  warningDetails: UnknownRecord[];
}): Promise<{
  finalization: UnknownRecord;
  decisionFact: FinalizationDecisionFact;
}> {
  const cheap = buildCheapFinalizationPressure({
    state,
    qualityGap,
    warningDetails,
  }) as UnknownRecord;
  const runs = Array.isArray(state.results)
    ? state.results
    : Array.isArray(state.current)
      ? state.current
      : [];
  if (!runs.some((run) => isUnknownRecord(run) && isAcceptedCurrentRun(run))) {
    return {
      finalization: cheap,
      decisionFact: blockedFinalizationDecisionFact(),
    };
  }
  try {
    const { finalizePreview } = await import("./finalize-preview.js");
    let decisionFact = blockedFinalizationDecisionFact();
    const finalization = (await finalizePreview({
      cwd: snapshot.workDir,
      capturedRecords: snapshot.records,
      canonicalDecisionProjection: false,
      captureCanonicalDecisionFact: (captured: unknown) => {
        if (isFinalizationDecisionFact(captured)) decisionFact = captured;
      },
    })) as UnknownRecord;
    return { finalization, decisionFact };
  } catch (error: unknown) {
    return {
      finalization: {
        ...cheap,
        ok: false,
        ready: false,
        warnings: [
          ...(Array.isArray(cheap.warnings) ? cheap.warnings : []),
          error instanceof Error ? error.message : String(error),
        ],
        actionCode: "preview-error",
      },
      decisionFact: blockedFinalizationDecisionFact(),
    };
  }
}

function decisionDiagnosticsForCollectedFacts({
  guidance,
  packetDiagnostics,
  scaffoldHealth,
  sourceCleanliness,
  warningDetails,
  hasFreshPacketAuthority,
}: {
  guidance: UnknownRecord;
  packetDiagnostics: UnknownRecord;
  scaffoldHealth: UnknownRecord;
  sourceCleanliness: UnknownRecord;
  warningDetails: UnknownRecord[];
  hasFreshPacketAuthority: boolean;
}): DecisionDiagnostic[] {
  const diagnostics: DecisionDiagnostic[] = [];
  const runtimeAuthority = object(guidance.runtimeAuthority);
  if (runtimeAuthority.blocking === true) {
    diagnostics.push(
      decisionDiagnostic("runtime-integrity", {
        message: stringValue(runtimeAuthority.blocker) || "Runtime authority is not proven.",
      }),
    );
  }
  if (
    (Array.isArray(scaffoldHealth.checks) ? scaffoldHealth.checks : []).some(
      (value) => object(value).severity === "blocker",
    )
  ) {
    diagnostics.push(
      decisionDiagnostic("scaffold-invalid", {
        message: "The session scaffold has a blocking integrity issue.",
      }),
    );
  }
  if (sourceCleanliness.sourceDirty === true && !hasFreshPacketAuthority) {
    diagnostics.push(
      decisionDiagnostic("dirty-source", {
        message: "Review the dirty source tree before authorizing packet evidence.",
      }),
    );
  }
  const evaluatorDrift = warningDetails.find((warning) => {
    const code = stringValue(warning.code);
    return (
      code === "benchmark_contract_changed" ||
      (code.startsWith("protected_benchmark_") && warning.severity === "error")
    );
  });
  if (evaluatorDrift) {
    diagnostics.push(
      decisionDiagnostic("evaluator-drift", {
        message: stringValue(evaluatorDrift.message) || "The accepted evaluator has drifted.",
      }),
    );
  }
  if (packetDiagnostics.unresolved === true && packetDiagnostics.primaryStage) {
    diagnostics.push(
      decisionDiagnostic("packet-diagnostic", {
        message:
          stringValue(packetDiagnostics.recommendation) || "Resolve the latest packet diagnostic.",
        command: stringValue(packetDiagnostics.command),
        semantic: { primaryStage: stringValue(packetDiagnostics.primaryStage) },
      }),
    );
  }
  return diagnostics;
}

function ledgerState(records: readonly UnknownRecord[]): {
  config: UnknownRecord;
  hasMetricRun: boolean;
  runCount: number;
  segment: number;
} {
  let config: UnknownRecord = {
    name: null,
    metricName: "metric",
    metricUnit: "",
    bestDirection: "lower",
  };
  let segment = 0;
  let runCount = 0;
  let hasMetricRun = false;
  for (const record of records) {
    if (record.type === "config") {
      if (runCount > 0) segment += 1;
      config = {
        name: record.name || config.name,
        metricName: record.metricName || config.metricName,
        metricUnit: record.metricUnit ?? config.metricUnit,
        bestDirection: record.bestDirection === "higher" ? "higher" : "lower",
      };
    }
    if (record.run != null) {
      runCount += 1;
      if (
        finiteNumber(record.metric) != null &&
        record.status !== "crash" &&
        record.status !== "checks_failed"
      ) {
        hasMetricRun = true;
      }
    }
  }
  return { config, hasMetricRun, runCount, segment };
}

function object(value: unknown): UnknownRecord {
  return objectOrNull(value) || {};
}

function objectOrNull(value: unknown): UnknownRecord | null {
  return isUnknownRecord(value) ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
