import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertSafeDirectoryTree,
  checkedAppendFile,
  checkedAtomicWriteFile,
} from "../checked-write.js";
import { defaultCommandShell, quoteShellArg } from "../command-rendering.js";
import { boolOption } from "../cli/args.js";
import { enumOption, numberOption, parseJsonFileOption } from "../cli/args.js";
import { resolveAuthorizedWorkDir } from "../cli/workdir-context.js";
import { readActiveProgressSnapshot } from "../active-progress-store.js";
import {
  buildProtectedBenchmarkSnapshot,
  protectedBenchmarkGuardBlocksKeep,
  protectedBenchmarkGuardError,
  protectedBenchmarkGuardForWorkDir,
  protectedBenchmarkPathsFromConfig,
  protectedBenchmarkWarningFromGuard,
} from "../benchmark/contract-guards.js";
import { benchmarkContractSnapshot } from "../benchmark/contract-snapshot.js";
import { evaluateSecondaryMetricConstraints } from "../benchmark/multi-metric-constraints.js";
import {
  acceptedExperimentContractForEvidenceValidation,
  completedContractNoiseRepeats,
  contractCandidateFingerprintForWorkDir,
  contractDerivationError,
  deriveExperimentContract,
  evaluateContractKeepEligibility,
  parseEvidenceAxes,
  type CandidateOrigin,
  type ContractEvaluationEvidence,
  type EvaluationAuthority,
  type ExperimentContract,
  type RunPurpose,
} from "../experiment-contract.js";
import { redactEvidenceText } from "../evidence-redaction.js";
import {
  EVIDENCE_STATUSES,
  artifactEvidenceList,
  defaultEvidenceStatusForRun,
} from "../evidence-registry.js";
import {
  assertNoGitIndexLock,
  gitIndexLockFailure,
  gitIndexLockMessage,
  gitOutput,
  gitPrivatePath,
  gitStatusShort,
  insideGitRepo,
  privateStateCandidatePaths,
  resolveCommitRef,
  resolvePrivateStateTarget,
  runGit,
  shortHead,
  writePrivateStateFile,
  PrivateStateConflictError,
} from "../git-private-state.js";
import { normalizeRelativePaths } from "../literal-paths.js";
import {
  assertFreshLastRunPacket,
  lastRunCandidatePaths,
  readLastRunPacket,
} from "../last-run-store.js";
import { parsePorcelainV1Z } from "../git-paths.js";
import { resolvePackageRoot } from "../runtime-paths.js";
import {
  FAILURE_STATUSES,
  STATUS_VALUES,
  appendJsonlEntries,
  computeConfidence,
  currentState,
  finiteMetric,
  isBaselineEligibleMetricRun,
  iterationLimitInfo,
  pathExists,
  promotionGradeValue,
  readJsonl,
} from "../session-core.js";
import { isMetricEligibleStatus } from "../run-status.js";
import { buildProcessLifecycleRecord, rekeyProcessLifecycleRecords } from "../process-governor.js";
import { parseJsonlRecords } from "../session-records.js";
import { pendingLogTransactionStateSpec } from "../pending-log-transaction-store.js";
import {
  AUTORESEARCH_DASHBOARD_FILE,
  AUTORESEARCH_RESEARCH_DIR,
  AUTORESEARCH_SESSION_FILES,
  resolveSessionPaths,
} from "../session-paths.js";
import type { UnknownRecord } from "../types/json.js";
import {
  isPathInside,
  resolvePathInsideRootSync,
  type PathContainmentResult,
} from "../path-containment.js";

const PENDING_LOG_TRANSACTION_CODE = "pending_log_transaction";
const AUTORESEARCH_OWNED_FILES = [AUTORESEARCH_DASHBOARD_FILE];
const AUTORESEARCH_OWNED_DIRS = [
  AUTORESEARCH_RESEARCH_DIR,
  "target/autoresearch",
  ".autoresearch-cache",
];
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);

export type LogTransactionStage =
  | "prepared"
  | "commit-applied-or-verified"
  | "ledger-event-present"
  | "tracked-cleanup-complete"
  | "untracked-cleanup-complete"
  | "packet-cleanup-complete"
  | "done";

export type LogTransactionFaultPoint =
  | `${"before" | "after"}:${Exclude<LogTransactionStage, "prepared" | "done">}`
  | "after:commit-ref-updated";

export interface LogExperimentOptions {
  faultInjection?: (point: LogTransactionFaultPoint) => void | Promise<void>;
}

export async function logExperiment(
  args: UnknownRecord,
  options: LogExperimentOptions = {},
): Promise<UnknownRecord> {
  const { workDir, config } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  const pendingReceipt = await readPendingLogTransaction(workDir);
  if (pendingReceipt) {
    return await resumePendingLogTransaction({
      args,
      config,
      options,
      receipt: pendingReceipt,
      workDir,
    });
  }
  const lastPacket = boolOption(args.from_last ?? args.fromLast, false)
    ? await readLastRunPacket(workDir)
    : null;
  if (lastPacket) await assertFreshLastRunPacket(workDir, lastPacket, config);
  const packetEvidence = record(lastPacket?.packetEvidence);
  const packetDecision = record(lastPacket?.decision);
  const packetRun = record(lastPacket?.run);
  const packetAxes = lastPacket ? parseEvidenceAxes(packetRun) : null;
  if (packetAxes && !packetAxes.valid) {
    throw new Error(`Last-run packet evidence axes are invalid: ${packetAxes.reasons.join("; ")}.`);
  }
  const packetChecks = record(packetRun.checks);
  const packetHistory = record(lastPacket?.history);
  const packetProcessLifecycle = processLifecycleRecordsFromPacket(lastPacket);
  if (packetProcessLifecycle.some((item) => item.event === "termination-failed")) {
    const retainedProgress = await readActiveProgressSnapshot(workDir);
    if (retainedProgress?.exitState === "termination_failed") {
      throw new Error(
        "Cannot log a packet while process-tree termination remains unproven. Verify the reported PID and descendants, then clear retained progress first.",
      );
    }
    packetProcessLifecycle.push(...terminalReconciliationRecords(packetProcessLifecycle));
  }
  const allowedStatuses = packetDecision.allowedStatuses;
  const hasPacketAllowedStatuses = Array.isArray(allowedStatuses);
  const packetAllowed = hasPacketAllowedStatuses ? allowedStatuses.map(String) : [];
  const status = String(
    args.status || (packetAllowed.length === 1 ? packetDecision.suggestedStatus : "") || "",
  );
  if (!status) {
    throw new Error(
      "status is required; choose keep, discard, or measure explicitly for successful packets.",
    );
  }
  if (!STATUS_VALUES.has(status)) {
    throw new Error(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
  }
  if (lastPacket && hasPacketAllowedStatuses && !packetAllowed.includes(status)) {
    throw new Error(
      `Cannot log status '${status}' for the last run. Allowed statuses: ${packetAllowed.join(", ")}.`,
    );
  }
  const metric = numberOption(args.metric ?? packetDecision.metric, null);
  if (!FAILURE_STATUSES.has(status) && metric == null) {
    throw new Error("metric is required for keep, discard, and measure");
  }
  if (status === "keep" && packetChecks.passed === false) {
    throw new Error(
      "Cannot keep the last run because correctness checks failed. Log it as checks_failed.",
    );
  }
  const description = String(args.description || packetRun.description || "");
  if (!description) throw new Error("description is required");
  const metricsFilePath = optionalString(args.metrics_file ?? args.metricsFile);
  if (metricsFilePath && args.metrics != null) {
    throw new Error("Use either --metrics or --metrics-file, not both.");
  }
  const metricsFromFile = await parseJsonFileOption(metricsFilePath, workDir, "--metrics-file");
  const metrics = record(metricsFromFile ?? args.metrics ?? packetDecision.metrics);
  const artifacts = record(args.artifacts ?? packetRun.artifacts);
  const legacyAsiFilePath = optionalString(args.asi_file ?? args.asiFile);
  const asiJsonFilePath = optionalString(args.asi_json_file ?? args.asiJsonFile);
  if (legacyAsiFilePath && asiJsonFilePath) {
    throw new Error("Use either --asi-json-file or --asi-file, not both.");
  }
  const asiFilePath = asiJsonFilePath ?? legacyAsiFilePath;
  const asiFileOptionName = asiJsonFilePath ? "--asi-json-file" : "--asi-file";
  if (asiFilePath && args.asi != null) {
    throw new Error(`Use either --asi or ${asiFileOptionName}, not both.`);
  }
  const asiFromFile = await parseJsonFileOption(asiFilePath, workDir, asiFileOptionName);
  const asi = record(asiFromFile ?? args.asi ?? packetDecision.asiTemplate);
  const evidenceContract =
    Object.keys(artifacts).length > 0
      ? acceptedExperimentContractForEvidenceValidation(workDir)
      : null;
  const verifiedArtifacts = await verifyEvidenceArtifacts({
    acceptedContract: evidenceContract,
    artifacts,
    config,
    packetRun,
    workDir,
  });
  const verifiedEvidencePaths = verifiedArtifacts.map((artifact) => artifact.path);
  let evidenceStatus =
    enumOption(
      args.evidence_status ?? args.evidenceStatus,
      EVIDENCE_STATUSES,
      defaultEvidenceStatusForRun({ status }),
      "--evidence-status",
    ) || defaultEvidenceStatusForRun({ status });

  const stateBefore = currentState(workDir);
  let contractEvaluationEvidence: ContractEvaluationEvidence | null = null;
  let acceptedContract: ExperimentContract | null = null;
  let preconditionEpoch = "";
  let runPurpose: RunPurpose = manualRunPurpose(status, stateBefore);
  let evaluationAuthority: EvaluationAuthority = "manual";
  let candidateOrigin: CandidateOrigin =
    runPurpose === "candidate" ? { kind: "working-tree" } : { kind: "none" };
  if (lastPacket || status === "keep") {
    const authority = await deriveExperimentContract({
      workDir,
      config,
      packet: lastPacket,
      verifiedEvidencePaths,
    });
    if (authority.status === "invalid") throw contractDerivationError(authority);
    if (authority.status !== "accepted") {
      throw new Error("The last-run packet has no accepted experiment contract authority.");
    }
    if (!lastPacket) {
      throw new Error(
        "Cannot keep without accepted-contract evaluation evidence from the last-run packet. Run next, then log --from-last.",
      );
    }
    const accepted = authority.contract;
    acceptedContract = accepted;
    preconditionEpoch = String(authority.event.eventId || "");
    const candidateFingerprint = await contractCandidateFingerprintForWorkDir(workDir, accepted);
    const packetCandidateFingerprint = packetRun.contractCandidateFingerprint;
    const evaluatedMetric = finiteMetric(packetRun.parsedPrimary);
    const checkRuns = Array.isArray(packetChecks.runs) ? packetChecks.runs : [];
    const checkOutcomes = checkRuns.map((value) => {
      const checkRun = record(value);
      return {
        id: typeof checkRun.id === "string" ? checkRun.id : "",
        executionDigest:
          typeof checkRun.executionDigest === "string" ? checkRun.executionDigest : "",
        passed: checkRun.passed === true,
      };
    });
    const acceptedEvaluation =
      packetAxes?.evaluationAuthority === "accepted-contract" &&
      packetRun.experimentContractDigest === accepted.contractDigest &&
      packetCandidateFingerprint === candidateFingerprint &&
      evaluatedMetric != null &&
      metric === evaluatedMetric;
    if (!packetAxes?.valid) {
      throw new Error("The last-run packet has no validated evidence axes.");
    }
    runPurpose = packetAxes.runPurpose;
    evaluationAuthority = packetAxes.evaluationAuthority;
    candidateOrigin = await candidateOriginForLog(workDir, args, packetAxes.candidateOrigin);
    if (candidateOrigin.kind === "commit") {
      await assertCommitMatchesEvaluatedCandidate(
        workDir,
        candidateOrigin.oid,
        accepted.scope.editable,
      );
    }
    const completedRepeats =
      evaluatedMetric == null
        ? 0
        : completedContractNoiseRepeats(accepted, stateBefore.current, {
            candidateFingerprint,
            metric: evaluatedMetric,
          });
    const keepEligibility = evaluateContractKeepEligibility(accepted, {
      purpose: runPurpose,
      evaluationAuthority,
      candidateOrigin,
      acceptedEvaluation,
      checkOutcomes,
      completedRepeats,
      metric: evaluatedMetric,
      referenceMetric: finiteMetric(stateBefore.best ?? stateBefore.baseline),
    });
    if (status === "keep" && !keepEligibility.eligible) {
      throw new Error(
        `Cannot keep the last run under the accepted experiment contract. ${keepEligibility.reasons.join(" ")}`,
      );
    }
    const allAcceptedChecksPassed =
      checkOutcomes.length === accepted.checks.length &&
      new Set(checkOutcomes.map((outcome) => outcome.id)).size === accepted.checks.length &&
      accepted.checks.every((check) =>
        checkOutcomes.some(
          (outcome) =>
            outcome.id === check.id &&
            outcome.executionDigest === check.execution.executionDigest &&
            outcome.passed,
        ),
      );
    if (acceptedEvaluation && evaluatedMetric != null && allAcceptedChecksPassed) {
      contractEvaluationEvidence = {
        contractDigest: accepted.contractDigest,
        candidateFingerprint,
        acceptedEvaluation: true,
        metric: evaluatedMetric,
        checksPassed: true,
      };
    }
  }
  const constraintRunMetrics = {
    ...metrics,
    [stateBefore.config.metricName || "metric"]: metric,
  };
  const constraintState =
    stateBefore.current.some(isBaselineEligibleMetricRun) || !isMetricEligibleStatus(status)
      ? stateBefore
      : {
          ...stateBefore,
          current: [
            ...stateBefore.current,
            { run: stateBefore.results.length + 1, metric, metrics, status },
          ],
        };
  const secondaryMetricConstraints = evaluateSecondaryMetricConstraints({
    config,
    state: constraintState,
    runMetrics: constraintRunMetrics,
  });
  if (
    status === "keep" &&
    secondaryMetricConstraints.blockPromotion &&
    evidenceStatus === "accepted"
  ) {
    evidenceStatus = "provisional";
  }
  const protectedBenchmarkGuard = await protectedBenchmarkGuardForWorkDir(
    workDir,
    config,
    stateBefore,
  );
  if (status === "keep" && protectedBenchmarkGuardBlocksKeep(protectedBenchmarkGuard)) {
    throw new Error(protectedBenchmarkGuardError(protectedBenchmarkGuard));
  }
  const logWarnings: string[] = [];
  const mutationPlan = await prepareLogMutation({
    acceptedEditablePaths: acceptedContract?.scope.editable || [],
    args,
    config,
    metric,
    metricName: stateBefore.config.metricName || "metric",
    metrics,
    protectedCleanupPaths: verifiedArtifacts.map((artifact) => artifact.path),
    status,
    workDir,
  });
  const experiment: UnknownRecord = {
    run: stateBefore.results.length + 1,
    commit: mutationPlan.commit.slice(0, 12),
    metric,
    metrics,
    metricEligible: isMetricEligibleStatus(status) && finiteMetric(metric) != null,
    status,
    evidenceStatus,
    description,
    timestamp: Date.now(),
    segment: stateBefore.segment,
    confidence: null,
    runPurpose,
    evaluationAuthority,
    candidateOrigin,
    learning: { kind: "none" },
  };
  if (preconditionEpoch) experiment.preconditionEpoch = preconditionEpoch;
  if (contractEvaluationEvidence) {
    experiment.contractEvaluationEvidence = contractEvaluationEvidence;
  }
  copyIfPresent(packetEvidence, experiment, "freshnessFingerprint", "packetFingerprint");
  copyIfPresent(packetEvidence, experiment, "commandExecutionBoundary");
  const protectedPaths = protectedBenchmarkPathsFromConfig(config);
  if (protectedPaths.length > 0 && isBaselineEligibleMetricRun(experiment)) {
    experiment.protectedBenchmarkSnapshot = await buildProtectedBenchmarkSnapshot({
      workDir,
      paths: protectedPaths,
    });
  }
  const protectedBenchmarkWarning = protectedBenchmarkWarningFromGuard(protectedBenchmarkGuard);
  if (protectedBenchmarkWarning) experiment.protectedBenchmarkGuard = protectedBenchmarkWarning;
  if (secondaryMetricConstraints.configured) {
    experiment.secondaryMetricConstraints = secondaryMetricConstraints;
  }
  experiment.promotion = promotionStateForLoggedDecision({
    status,
    metric,
    metrics,
    packetPromotion: packetDecision.promotion,
  });
  if (secondaryMetricConstraints.blockPromotion) {
    experiment.promotion = {
      label: "blocked",
      reasons: [
        "Blocking secondary metric constraints failed or were unavailable.",
        ...secondaryMetricConstraints.messages,
      ],
    };
  }
  if (Object.keys(asi).length > 0) experiment.asi = asi;
  if (
    !acceptedContract &&
    Object.keys(artifacts).length > 0 &&
    readJsonl(workDir).some(
      (entry) =>
        entry.type === "experiment-contract-accepted" &&
        Number(entry.segment) === stateBefore.segment,
    )
  ) {
    const artifactAuthority = await deriveExperimentContract({
      workDir,
      config,
      verifiedEvidencePaths,
    });
    if (artifactAuthority.status === "invalid") throw contractDerivationError(artifactAuthority);
    if (artifactAuthority.status === "accepted") acceptedContract = artifactAuthority.contract;
  }
  if (Object.keys(artifacts).length > 0) {
    experiment.artifacts = artifacts;
    const evidenceByName = new Map(verifiedArtifacts.map((artifact) => [artifact.name, artifact]));
    experiment.artifactEvidence = artifactEvidenceList(artifacts, workDir, evidenceStatus).map(
      (artifact) => ({ ...artifact, ...evidenceByName.get(String(artifact.name || "")) }),
    );
  }
  const taskArtifacts = packetEvidence.taskArtifacts;
  if (taskArtifacts && typeof taskArtifacts === "object" && !Array.isArray(taskArtifacts)) {
    experiment.taskArtifacts = taskArtifacts;
    experiment.taskArtifactsScope = "durable";
  }
  const historicalBenchmarkContract = packetHistory.benchmarkContract;
  const benchmarkContract = historicalBenchmarkContract
    ? record(historicalBenchmarkContract)
    : await benchmarkContractSnapshot(workDir, {
        command: packetHistory.command || "",
        checksCommand: packetChecks.command || "",
      });
  if (benchmarkContract.surfaceHash) experiment.benchmarkContract = benchmarkContract;
  experiment.confidence = computeConfidence(
    [...stateBefore.current, experiment],
    stateBefore.config.bestDirection,
  );
  const mutation = await executePreparedLogTransaction({
    acceptedContract,
    args,
    config,
    contractDigest: acceptedContract?.contractDigest || "",
    experiment,
    mutationPlan,
    options,
    packet: lastPacket,
    packetProcessLifecycle,
    verifiedArtifacts,
    workDir,
  });
  const stateAfter = currentState(workDir);
  const limit = iterationLimitInfo(stateAfter, config);
  try {
    await appendSessionRunNote(workDir, experiment, stateAfter, {
      gitMessage: mutation.gitMessage,
      revertMessage: mutation.revertMessage,
    });
  } catch (error) {
    logWarnings.push(
      `Run was durably logged to autoresearch.jsonl, but autoresearch.md could not be updated: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return {
    ok: true,
    workDir,
    experiment,
    baseline: stateAfter.baseline,
    best: stateAfter.best,
    confidence: stateAfter.confidence,
    limit,
    git: mutation.gitMessage,
    revert: mutation.revertMessage,
    recovery: logWarnings.join(" "),
    warnings: logWarnings,
    warningDetails: [],
    lastRunCleared: Boolean(lastPacket),
  };
}

type UnlinkFn = (filePath: string) => Promise<void>;
type CleanupWarningContext = { workDir?: string };
export type CleanupWarning = { code: string; message: string };

export function pendingReceiptCleanupWarning(
  error: unknown,
  context: CleanupWarningContext = {},
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactEvidenceText(rawMessage, context);
  return `Pending receipt cleanup failed: ${message}.`;
}

export async function clearPendingLogTransaction(
  receiptPath: string | null,
  unlink: UnlinkFn = fsp.unlink,
): Promise<void> {
  if (!receiptPath) return;
  try {
    await unlink(receiptPath);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

export async function clearPendingLogTransactionWithWarning(
  receiptPath: string | null,
  unlink: UnlinkFn = fsp.unlink,
  context: CleanupWarningContext = {},
): Promise<string | null> {
  try {
    await clearPendingLogTransaction(receiptPath, unlink);
    return null;
  } catch (error) {
    return pendingReceiptCleanupWarning(error, context);
  }
}

export async function clearFilesWithWarnings(
  filePaths: Iterable<string>,
  unlink: UnlinkFn = fsp.unlink,
  context: CleanupWarningContext = {},
): Promise<CleanupWarning[]> {
  const warnings: CleanupWarning[] = [];
  for (const filePath of new Set(filePaths)) {
    try {
      await unlink(filePath);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) continue;
      warnings.push({
        code: "last_run_cleanup_failed",
        message: `Last-run cleanup failed: ${redactEvidenceText(
          error instanceof Error ? error.message : String(error),
          context,
        )}.`,
      });
    }
  }
  return warnings;
}

interface LogMutationInput {
  acceptedEditablePaths: string[];
  args: UnknownRecord;
  config: UnknownRecord;
  metric: number | null;
  metricName: string;
  metrics: UnknownRecord;
  protectedCleanupPaths: string[];
  status: string;
  workDir: string;
}

export interface LogMutationResult {
  commit: string;
  gitMessage: string;
  inGit: boolean;
  revertMessage: string;
}

interface LogMutationPlan extends LogMutationResult {
  acceptedEditablePaths: string[];
  allowAddAll: boolean;
  cleanup: {
    broad: boolean;
    scopedPaths: string[];
    trackedPaths: string[];
    untrackedPaths: string[];
  };
  commitPaths: string[];
  explicitCommit: boolean;
  resultData: UnknownRecord;
}

export async function assertNoPendingLogTransaction(workDir: string): Promise<void> {
  const warnings = await pendingLogTransactionWarnings(workDir);
  if (warnings.length > 0) throw new Error(String(warnings[0].message));
}

async function prepareLogMutation({
  acceptedEditablePaths,
  args,
  config,
  metric,
  metricName,
  metrics,
  protectedCleanupPaths,
  status,
  workDir,
}: LogMutationInput): Promise<LogMutationPlan> {
  const inGit = await insideGitRepo(workDir);
  const explicitCommit = args.commit != null && String(args.commit).trim() !== "";
  const allowAddAll = boolOption(args.allow_add_all ?? args.allowAddAll, false);
  if (explicitCommit && !inGit) {
    throw new Error("--commit requires a Git repository so the commit can be verified.");
  }
  if (explicitCommit && status === "measure") {
    throw new Error(
      "--commit is not allowed for measure logs; measure records trend evidence only.",
    );
  }
  let commit = "";
  if (explicitCommit) {
    commit = await resolveCommitRef(workDir, args.commit);
    if (status === "keep") {
      const currentHead = await requiredGitText(workDir, ["rev-parse", "HEAD"], "read HEAD");
      if (commit !== currentHead) {
        throw new Error(
          "An imported keep commit must be the current candidate evaluated by the accepted-contract packet.",
        );
      }
    }
  } else if (inGit && status !== "keep" && status !== "measure") {
    commit = await shortHead(workDir);
  }
  let gitMessage = inGit ? "Git: no commit created." : "Git: not a repo.";
  let revertMessage = "";
  const resultData = { status, [metricName || "metric"]: metric, ...metrics };
  let commitPaths: string[] = [];
  let cleanup: LogMutationPlan["cleanup"] = {
    broad: false,
    scopedPaths: [],
    trackedPaths: [],
    untrackedPaths: [],
  };

  if (status === "keep" && inGit) {
    if (explicitCommit) {
      gitMessage = `Git: recorded existing commit ${commit.slice(0, 12)}.`;
    } else {
      commitPaths = normalizeRelativePaths(
        args.commit_paths ?? args.commitPaths ?? config.commitPaths,
        "commitPaths",
      );
      if (commitPaths.length === 0 && !allowAddAll) {
        throw new Error(
          "Kept runs will not auto-commit because commitPaths is empty. Configure commitPaths, pass --commit-paths, or use --allow-add-all explicitly. Pass --allow-add-all only when every dirty file belongs in the kept commit.",
        );
      }
      if (commitPaths.length > 0) await assertCommitPathsExist(workDir, commitPaths);
      if (
        !allowAddAll &&
        acceptedEditablePaths.some(
          (candidatePath) =>
            !commitPaths.some((commitPath) => pathIsCoveredByScope(candidatePath, commitPath)),
        )
      ) {
        throw new Error(
          "The keep commit scope conflicts with the accepted editable candidate scope. Commit every accepted editable path or use explicit add-all.",
        );
      }
      await assertNoGitIndexLock(workDir, "git add");
    }
  } else if (status !== "keep" && status !== "measure") {
    const discardPlan = inGit
      ? await discardCleanupPlan(workDir, args, config, protectedCleanupPaths)
      : null;
    if (discardPlan) {
      if (!discardPlan.scopedPaths.length && discardPlan.dirtyPaths.length > 0) {
        if (!boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false)) {
          throw new Error(
            "Refusing broad discard cleanup in a dirty Git tree without scoped revert paths. Configure commitPaths/revertPaths or pass --allow-dirty-revert.",
          );
        }
      }
      cleanup = {
        broad: discardPlan.scopedPaths.length === 0,
        scopedPaths: discardPlan.scopedPaths,
        trackedPaths: discardPlan.trackedPaths,
        untrackedPaths: discardPlan.untrackedPaths,
      };
      revertMessage = discardCleanupMessage(discardPlan);
    }
  }
  return {
    acceptedEditablePaths,
    allowAddAll,
    cleanup,
    commit,
    commitPaths,
    explicitCommit,
    gitMessage,
    inGit,
    resultData,
    revertMessage,
  };
}

export function appendLogEvidence(
  workDir: string,
  processLifecycle: UnknownRecord[],
  experiment: UnknownRecord,
): void {
  appendJsonlEntries(workDir, [...processLifecycle, experiment]);
}

export async function appendSessionRunNote(
  workDir: string,
  experiment: UnknownRecord,
  state: UnknownRecord,
  messages: UnknownRecord = {},
): Promise<void> {
  const filePath = path.join(workDir, "autoresearch.md");
  if (!(await pathExists(filePath))) return;
  const startMarker = "<!-- AUTORESEARCH_RUN_LEDGER:START -->";
  const endMarker = "<!-- AUTORESEARCH_RUN_LEDGER:END -->";
  const parts = [
    `- Run ${experiment.run} ${experiment.status}: ${experiment.description}`,
    `metric=${experiment.metric}`,
    `best=${state.best ?? "unknown"}`,
  ];
  if (experiment.commit) parts.push(`commit=${experiment.commit}`);
  if (messages.revertMessage) parts.push(String(messages.revertMessage));
  if (messages.gitMessage && experiment.status === "keep") {
    parts.push(String(messages.gitMessage));
  }
  const line = `${parts.join("; ")}.`;
  const existing = await fsp.readFile(filePath, "utf8");
  if (existing.includes(startMarker) && existing.includes(endMarker)) {
    const next = existing.replace(endMarker, `${line}\n${endMarker}`);
    await checkedAtomicWriteFile(workDir, filePath, next, { mode: 0o600 });
    return;
  }
  const block = ["", "## Run Ledger", "", startMarker, line, endMarker, ""].join("\n");
  await checkedAtomicWriteFile(workDir, filePath, `${existing.trimEnd()}\n${block}`, {
    mode: 0o600,
  });
}

async function pendingLogTransactionCandidatePaths(
  workDir: string,
  _inGit?: boolean,
): Promise<string[]> {
  return await privateStateCandidatePaths(workDir, pendingLogTransactionStateSpec(workDir));
}

interface VerifiedEvidenceArtifact extends UnknownRecord {
  digest: string;
  kind: "directory" | "file";
  name: string;
  path: string;
  root: string;
  size: number;
}

interface CleanupTargetIdentity extends UnknownRecord {
  path: string;
  kind: "absent" | "directory" | "file" | "other" | "symlink";
  digest: string;
  indexDigest: string;
  mode: number;
  size: number;
  worktreeExpectedAbsent?: boolean;
}

type PreparedHeadState =
  | { kind: "none"; ref: "" }
  | { kind: "detached"; ref: "" }
  | { kind: "symbolic"; ref: string };

interface LogTransactionReceipt extends UnknownRecord {
  type: "autoresearch.log.transaction";
  schemaVersion: 2;
  transaction: {
    id: string;
    kind: "keep" | "non-keep";
    createdAt: string;
  };
  input: {
    requestDigest: string;
    configDigest: string;
    status: string;
    description: string;
    metric: number | null;
    metricsDigest: string;
  };
  packet: {
    required: boolean;
    digest: string;
    id: string;
  };
  contract: { digest: string };
  evidence: {
    digest: string;
    experiment: UnknownRecord;
    processLifecycle: UnknownRecord[];
    artifacts: VerifiedEvidenceArtifact[];
  };
  preGit: {
    digest: string;
    headOid: string;
    headState: PreparedHeadState;
    indexTree: string;
    statusDigest: string;
  };
  status: "pending" | "failed" | "done";
  completedStages: LogTransactionStage[];
  checkpointDigest: string;
  commitExpectation: {
    digest: string;
    mode: "create" | "existing" | "none";
    oid: string;
    parentOid: string;
    treeOid: string;
    message: string;
    messageDigest: string;
    paths: string[];
    candidatePaths: string[];
    reconciledIndexTree: string;
    allowAddAll: boolean;
  };
  ledgerEvent: {
    transactionId: string;
    eventDigest: string;
    prefixByteLength: number;
    prefixDigest: string;
    prefixDelimiter: "" | "\n";
  };
  cleanup: {
    digest: string;
    broad: boolean;
    scopedPaths: string[];
    trackedPaths: string[];
    trackedTargets: CleanupTargetIdentity[];
    untrackedPaths: string[];
    untrackedTargets: CleanupTargetIdentity[];
    headOid: string;
    indexTree: string;
    packetPaths: string[];
  };
  failures: Array<{
    at: string;
    stage: string;
    message: string;
    messageDigest: string;
  }>;
  result: LogMutationResult;
  stateStorage: {
    storageMode: string;
    path: string;
    warning: string;
  };
}

async function writeLogTransactionReceipt(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<string> {
  refreshLogTransactionPlanDigests(receipt);
  receipt.checkpointDigest = logTransactionCheckpointDigest(receipt);
  let storedReceipt = receipt;
  const stored = await writePrivateStateFile(
    workDir,
    pendingLogTransactionStateSpec(workDir),
    (stateTarget) => {
      storedReceipt = {
        ...receipt,
        stateStorage: {
          storageMode: stateTarget.storageMode,
          path: stateTarget.path,
          warning: stateTarget.warning,
        },
      };
      return `${JSON.stringify(storedReceipt, null, 2)}\n`;
    },
    { mode: 0o600 },
  );
  receipt.stateStorage = storedReceipt.stateStorage;
  return stored.path;
}

async function readPendingLogTransaction(workDir: string): Promise<LogTransactionReceipt | null> {
  const target = await resolvePrivateStateTarget(workDir, pendingLogTransactionStateSpec(workDir));
  if (!(await pathExists(target.path))) return null;
  const stat = await fsp.lstat(target.path);
  if (stat.isSymbolicLink()) {
    throw new Error("Pending log transaction receipt must not be a symlink or junction.");
  }
  const value: unknown = JSON.parse(await fsp.readFile(target.path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pending receipt for the log transaction is malformed.");
  }
  const receipt = value as LogTransactionReceipt;
  if (receipt.type !== "autoresearch.log.transaction" || receipt.schemaVersion !== 2) {
    throw new Error(
      "The pending log receipt uses the retired schema. Inspect and reconcile it before another log mutation.",
    );
  }
  if (
    !receipt.transaction?.id ||
    !receipt.input?.requestDigest ||
    !Array.isArray(receipt.completedStages) ||
    typeof receipt.checkpointDigest !== "string" ||
    !receipt.evidence?.experiment ||
    !Array.isArray(receipt.evidence.processLifecycle) ||
    !Array.isArray(receipt.evidence.artifacts) ||
    !receipt.packet ||
    !receipt.contract ||
    !receipt.preGit ||
    !isPreparedHeadState(receipt.preGit.headState) ||
    !receipt.commitExpectation ||
    !Array.isArray(receipt.commitExpectation.candidatePaths) ||
    typeof receipt.commitExpectation.reconciledIndexTree !== "string" ||
    !receipt.ledgerEvent ||
    !Number.isSafeInteger(receipt.ledgerEvent.prefixByteLength) ||
    receipt.ledgerEvent.prefixByteLength < 0 ||
    typeof receipt.ledgerEvent.prefixDigest !== "string" ||
    !["", "\n"].includes(receipt.ledgerEvent.prefixDelimiter) ||
    !receipt.cleanup ||
    !Array.isArray(receipt.cleanup.scopedPaths) ||
    !Array.isArray(receipt.cleanup.trackedPaths) ||
    !Array.isArray(receipt.cleanup.trackedTargets) ||
    !Array.isArray(receipt.cleanup.untrackedPaths) ||
    !Array.isArray(receipt.cleanup.untrackedTargets) ||
    !Array.isArray(receipt.cleanup.packetPaths) ||
    !receipt.result ||
    !Array.isArray(receipt.failures)
  ) {
    throw new Error("Pending receipt has a malformed schema-version-2 log transaction.");
  }
  await assertLogTransactionReceiptIntegrity(workDir, receipt);
  receipt.stateStorage = {
    storageMode: target.storageMode,
    path: target.path,
    warning: target.warning,
  };
  return receipt;
}

async function assertLogTransactionReceiptIntegrity(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  const reject = (reason: string): never => {
    throw new Error(
      `Pending receipt failed schema-version-2 log transaction integrity checks: ${reason}`,
    );
  };
  const experiment = record(receipt.evidence.experiment);
  if (
    receipt.transaction.kind !== (experiment.status === "keep" ? "keep" : "non-keep") ||
    receipt.input.status !== experiment.status ||
    receipt.input.description !== experiment.description ||
    receipt.input.metric !== finiteMetric(experiment.metric) ||
    receipt.input.metricsDigest !== sha256Json(experiment.metrics)
  ) {
    reject("the stored input and evidence payload disagree.");
  }
  const preGitDigest = sha256Json({
    headOid: receipt.preGit.headOid,
    headState: receipt.preGit.headState,
    indexTree: receipt.preGit.indexTree,
    statusDigest: receipt.preGit.statusDigest,
  });
  if (receipt.preGit.digest !== preGitDigest) reject("the pre-Git digest changed.");
  const expectedTransactionId = sha256Json({
    requestDigest: receipt.input.requestDigest,
    configDigest: receipt.input.configDigest,
    packetDigest: receipt.packet.digest,
    contractDigest: receipt.contract.digest,
    preGitDigest: receipt.preGit.digest,
    run: experiment.run,
  });
  if (receipt.transaction.id !== expectedTransactionId) reject("the transaction identity changed.");
  const evidenceDigest = logEvidenceDigest(receipt.evidence);
  if (
    receipt.evidence.digest !== evidenceDigest ||
    receipt.ledgerEvent.transactionId !== receipt.transaction.id ||
    receipt.ledgerEvent.eventDigest !== evidenceDigest
  ) {
    reject("the evidence or ledger event digest changed.");
  }
  const expectedMessageDigest = sha256Text(receipt.commitExpectation.message);
  if (
    receipt.commitExpectation.mode === "create" &&
    receipt.commitExpectation.messageDigest !== expectedMessageDigest
  ) {
    reject("the commit message digest changed.");
  }
  if (
    receipt.commitExpectation.digest !== commitExpectationDigest(receipt) ||
    receipt.cleanup.digest !== cleanupPlanDigest(receipt.cleanup)
  ) {
    reject("the commit expectation or cleanup plan digest changed.");
  }
  if (receipt.checkpointDigest !== logTransactionCheckpointDigest(receipt)) {
    reject("the transaction stage checkpoint changed.");
  }
  const stages = logTransactionStageOrder(receipt.transaction.kind);
  const completed = receipt.completedStages;
  const completedIndexes = completed.map((stage) => stages.indexOf(stage));
  if (
    completed[0] !== "prepared" ||
    new Set(completed).size !== completed.length ||
    completedIndexes.some((index) => index < 0) ||
    completedIndexes.some((index, offset) => offset > 0 && index <= completedIndexes[offset - 1])
  ) {
    reject("the completed stage order is invalid.");
  }
  if (
    !["pending", "failed", "done"].includes(receipt.status) ||
    (receipt.status === "done") !== completed.includes("done")
  ) {
    reject("the transaction status is inconsistent with completed stages.");
  }
  for (const [label, paths] of [
    ["commit", receipt.commitExpectation.paths],
    ["candidate", receipt.commitExpectation.candidatePaths],
    ["cleanup scope", receipt.cleanup.scopedPaths],
    ["tracked cleanup", receipt.cleanup.trackedPaths],
    ["untracked cleanup", receipt.cleanup.untrackedPaths],
  ] as const) {
    try {
      normalizeRelativePaths(paths, `${label} paths`);
    } catch {
      reject(`${label} paths are unsafe.`);
    }
  }
  for (const [label, paths, targets] of [
    ["tracked cleanup", receipt.cleanup.trackedPaths, receipt.cleanup.trackedTargets],
    ["untracked cleanup", receipt.cleanup.untrackedPaths, receipt.cleanup.untrackedTargets],
  ] as const) {
    if (
      JSON.stringify(uniqueSorted(paths)) !==
        JSON.stringify(uniqueSorted(targets.map((target) => target.path))) ||
      targets.some(
        (target) =>
          typeof target.digest !== "string" ||
          typeof target.indexDigest !== "string" ||
          target.digest !== cleanupTargetWorktreeDigest(target),
      )
    ) {
      reject(`${label} target identities do not match their cleanup paths.`);
    }
  }
  for (const target of receipt.cleanup.trackedTargets) {
    if (
      typeof target.worktreeExpectedAbsent !== "boolean" ||
      target.worktreeExpectedAbsent !==
        (await cleanupTargetExpectedAbsent(workDir, receipt.cleanup.headOid, target.path))
    ) {
      reject(`tracked cleanup target ${target.path} has a mismatched worktree postcondition.`);
    }
  }
  const expectedPacketPaths = receipt.packet.required ? await lastRunCandidatePaths(workDir) : [];
  if (
    JSON.stringify(uniqueSorted(receipt.cleanup.packetPaths)) !==
    JSON.stringify(uniqueSorted(expectedPacketPaths))
  ) {
    reject("packet cleanup paths do not match private last-run storage.");
  }
  if (receipt.packet.required && !completed.includes("packet-cleanup-complete")) {
    const packetPath = expectedPacketPaths.find((candidate) => fs.existsSync(candidate));
    if (packetPath) {
      const packet = JSON.parse(await fsp.readFile(packetPath, "utf8"));
      if (receipt.packet.digest !== sha256Json(packet))
        reject("the pending packet digest changed.");
    }
  }
}

async function executePreparedLogTransaction({
  acceptedContract,
  args,
  config,
  contractDigest,
  experiment,
  mutationPlan,
  options,
  packet,
  packetProcessLifecycle,
  verifiedArtifacts,
  workDir,
}: {
  acceptedContract: ExperimentContract | null;
  args: UnknownRecord;
  config: UnknownRecord;
  contractDigest: string;
  experiment: UnknownRecord;
  mutationPlan: LogMutationPlan;
  options: LogExperimentOptions;
  packet: UnknownRecord | null;
  packetProcessLifecycle: UnknownRecord[];
  verifiedArtifacts: VerifiedEvidenceArtifact[];
  workDir: string;
}): Promise<LogMutationResult> {
  const receipt = await buildLogTransactionReceipt({
    acceptedContract,
    args,
    config,
    contractDigest,
    experiment,
    mutationPlan,
    packet,
    packetProcessLifecycle,
    verifiedArtifacts,
    workDir,
  });
  await writeLogTransactionReceipt(workDir, receipt);
  await executeLogTransactionStages(workDir, config, receipt, options);
  Object.assign(experiment, receipt.evidence.experiment);
  return receipt.result;
}

async function resumePendingLogTransaction({
  args,
  config,
  options,
  receipt,
  workDir,
}: {
  args: UnknownRecord;
  config: UnknownRecord;
  options: LogExperimentOptions;
  receipt: LogTransactionReceipt;
  workDir: string;
}): Promise<UnknownRecord> {
  const identity = logRequestIdentity(args, config, workDir);
  if (
    identity.requestDigest !== receipt.input.requestDigest ||
    identity.configDigest !== receipt.input.configDigest
  ) {
    throw new Error(
      "A pending receipt contains a log transaction with different or changed inputs. Retry the exact original log request or reconcile the receipt before continuing.",
    );
  }
  await executeLogTransactionStages(workDir, config, receipt, options);
  const experiment = receipt.evidence.experiment;
  const stateAfter = currentState(workDir);
  const warnings: string[] = [];
  try {
    await appendSessionRunNote(workDir, experiment, stateAfter, {
      gitMessage: receipt.result.gitMessage,
      revertMessage: receipt.result.revertMessage,
    });
  } catch (error) {
    warnings.push(
      `Run was durably logged to autoresearch.jsonl, but autoresearch.md could not be updated: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return {
    ok: true,
    workDir,
    experiment,
    baseline: stateAfter.baseline,
    best: stateAfter.best,
    confidence: stateAfter.confidence,
    limit: iterationLimitInfo(stateAfter, config),
    git: receipt.result.gitMessage,
    revert: receipt.result.revertMessage,
    recovery: warnings.join(" "),
    warnings,
    warningDetails: [],
    lastRunCleared: receipt.packet.required,
  };
}

async function verifyAcceptedKeepAuthorityAtMutationBoundary(
  workDir: string,
  config: UnknownRecord,
  receipt: LogTransactionReceipt,
  ledgerEntries?: UnknownRecord[],
): Promise<void> {
  if (receipt.transaction.kind !== "keep") return;
  await assertPreparedHeadState(workDir, receipt.preGit.headState);
  const contractEvidence = record(receipt.evidence.experiment.contractEvaluationEvidence);
  const packet = await readLastRunPacket(workDir);
  const authority = await deriveExperimentContract({
    workDir,
    config,
    entries: ledgerEntries,
    packet,
    verifiedEvidencePaths: receipt.evidence.artifacts.map((artifact) => artifact.path),
  });
  let accepted: ExperimentContract | null = null;
  if (authority.status === "accepted") {
    accepted = authority.contract;
  } else if (authority.status === "invalid") {
    const onlyExpectedHeadChanged =
      authority.conflicts.length > 0 &&
      authority.conflicts.every((conflict) => conflict.field === "repository.expectedHead");
    if (
      !onlyExpectedHeadChanged ||
      !(await pendingCreatedCommitExplainsHeadChange(workDir, receipt))
    ) {
      throw contractDerivationError(authority);
    }
    accepted = acceptedExperimentContractForEvidenceValidation(workDir, ledgerEntries);
  }
  if (
    !accepted ||
    accepted.contractDigest !== receipt.contract.digest ||
    contractEvidence.contractDigest !== accepted.contractDigest ||
    typeof contractEvidence.candidateFingerprint !== "string" ||
    JSON.stringify(uniqueSorted(receipt.commitExpectation.candidatePaths)) !==
      JSON.stringify(uniqueSorted(accepted.scope.editable))
  ) {
    throw new Error("Pending keep candidate authority no longer matches the accepted contract.");
  }
  const candidateFingerprint = await contractCandidateFingerprintForWorkDir(workDir, accepted);
  if (candidateFingerprint !== contractEvidence.candidateFingerprint) {
    throw new Error(
      "Pending keep candidate fingerprint changed after transaction preparation; rerun accepted evaluation instead of committing drifted evidence.",
    );
  }
}

async function pendingCreatedCommitExplainsHeadChange(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<boolean> {
  const expectation = receipt.commitExpectation;
  if (expectation.mode !== "create") return false;
  if (expectation.oid) {
    await verifyRecordedCommitIdentity(workDir, receipt);
    return true;
  }
  const currentHead = await preparedRefOid(workDir, receipt.preGit.headState);
  return await commitMatchesInterruptedCreation(workDir, currentHead, expectation);
}

async function buildLogTransactionReceipt({
  acceptedContract,
  args,
  config,
  contractDigest,
  experiment,
  mutationPlan,
  packet,
  packetProcessLifecycle,
  verifiedArtifacts,
  workDir,
}: {
  acceptedContract: ExperimentContract | null;
  args: UnknownRecord;
  config: UnknownRecord;
  contractDigest: string;
  experiment: UnknownRecord;
  mutationPlan: LogMutationPlan;
  packet: UnknownRecord | null;
  packetProcessLifecycle: UnknownRecord[];
  verifiedArtifacts: VerifiedEvidenceArtifact[];
  workDir: string;
}): Promise<LogTransactionReceipt> {
  const identity = logRequestIdentity(args, config, workDir);
  const preGit = await preGitDigests(workDir, mutationPlan.inGit);
  const packetDigest = sha256Json(packet);
  const transactionId = sha256Json({
    requestDigest: identity.requestDigest,
    configDigest: identity.configDigest,
    packetDigest,
    contractDigest,
    preGitDigest: preGit.digest,
    run: experiment.run,
  });
  const commitMessage = `${String(experiment.description || "")}\n\nResult: ${JSON.stringify(
    mutationPlan.resultData,
  )}\n`;
  const trackedTargets = await cleanupTargetIdentities(
    workDir,
    mutationPlan.cleanup.trackedPaths,
    preGit.headOid,
  );
  const untrackedTargets = await cleanupTargetIdentities(
    workDir,
    mutationPlan.cleanup.untrackedPaths,
  );
  const ledgerPrefix = await snapshotLedgerPrefix(workDir);
  let commitMode: LogTransactionReceipt["commitExpectation"]["mode"] =
    experiment.status === "keep" && mutationPlan.inGit
      ? mutationPlan.explicitCommit
        ? "existing"
        : "create"
      : "none";
  let intendedTreeOid = "";
  let reconciledIndexTree = "";
  if (commitMode === "create") {
    const recordedCandidateFingerprint = String(
      record(experiment.contractEvaluationEvidence).candidateFingerprint || "",
    );
    if (!acceptedContract || !recordedCandidateFingerprint) {
      throw new Error("Create-mode keep lacks accepted evaluated candidate authority.");
    }
    intendedTreeOid = await intendedCommitTree(workDir, preGit.headOid, mutationPlan.commitPaths);
    const currentCandidateFingerprint = await contractCandidateFingerprintForWorkDir(
      workDir,
      acceptedContract,
    );
    if (currentCandidateFingerprint !== recordedCandidateFingerprint) {
      throw new Error(
        "The accepted evaluated candidate changed before keep transaction preparation.",
      );
    }
    await assertTreeContainsEvaluatedCandidate(
      workDir,
      intendedTreeOid,
      mutationPlan.acceptedEditablePaths,
    );
    await assertAcceptedCandidateHasCommitDelta(
      workDir,
      await parentTreeOid(workDir, preGit.headOid),
      intendedTreeOid,
      mutationPlan.acceptedEditablePaths,
    );
    reconciledIndexTree = await expectedReconciledIndexTree(
      workDir,
      preGit.indexTree,
      intendedTreeOid,
      mutationPlan.commitPaths,
    );
  }
  const receipt: LogTransactionReceipt = {
    type: "autoresearch.log.transaction",
    schemaVersion: 2,
    transaction: {
      id: transactionId,
      kind: experiment.status === "keep" ? "keep" : "non-keep",
      createdAt: new Date().toISOString(),
    },
    input: {
      requestDigest: identity.requestDigest,
      configDigest: identity.configDigest,
      status: String(experiment.status || ""),
      description: String(experiment.description || ""),
      metric: finiteMetric(experiment.metric),
      metricsDigest: sha256Json(experiment.metrics),
    },
    packet: {
      required: Boolean(packet),
      digest: packetDigest,
      id: String(record(packet?.packetEvidence).packetId || ""),
    },
    contract: { digest: contractDigest },
    evidence: {
      digest: "",
      experiment,
      processLifecycle: packetProcessLifecycle,
      artifacts: verifiedArtifacts,
    },
    preGit,
    status: "pending",
    completedStages: ["prepared"],
    checkpointDigest: "",
    commitExpectation: {
      digest: "",
      mode: commitMode,
      oid: mutationPlan.commit,
      parentOid: "",
      treeOid: intendedTreeOid,
      message: commitMessage,
      messageDigest: sha256Text(commitMessage),
      paths: mutationPlan.commitPaths,
      candidatePaths: mutationPlan.acceptedEditablePaths,
      reconciledIndexTree,
      allowAddAll: mutationPlan.allowAddAll,
    },
    ledgerEvent: {
      transactionId,
      eventDigest: "",
      prefixByteLength: ledgerPrefix.byteLength,
      prefixDigest: ledgerPrefix.digest,
      prefixDelimiter: ledgerPrefix.delimiter,
    },
    cleanup: {
      digest: "",
      ...mutationPlan.cleanup,
      trackedTargets,
      untrackedTargets,
      headOid: preGit.headOid,
      indexTree: preGit.indexTree,
      packetPaths: packet ? await lastRunCandidatePaths(workDir) : [],
    },
    failures: [],
    result: {
      commit: mutationPlan.commit,
      gitMessage: mutationPlan.gitMessage,
      inGit: mutationPlan.inGit,
      revertMessage: mutationPlan.revertMessage,
    },
    stateStorage: { storageMode: "", path: "", warning: "" },
  };
  if (receipt.commitExpectation.mode === "existing") {
    const metadata = await commitMetadata(workDir, receipt.commitExpectation.oid);
    receipt.commitExpectation.parentOid = metadata.parentOid;
    receipt.commitExpectation.treeOid = metadata.treeOid;
    receipt.commitExpectation.messageDigest = metadata.messageDigest;
  } else if (receipt.commitExpectation.mode === "create") {
    receipt.commitExpectation.parentOid = preGit.headOid;
  }
  refreshLogTransactionPlanDigests(receipt);
  refreshLedgerEventIdentity(receipt);
  return receipt;
}

async function executeLogTransactionStages(
  workDir: string,
  config: UnknownRecord,
  receipt: LogTransactionReceipt,
  options: LogExperimentOptions,
): Promise<void> {
  if (receipt.status === "done") {
    await verifyCompletedLogTransactionStages(workDir, receipt);
    await clearPendingLogTransaction(receipt.stateStorage.path);
    return;
  }
  if (receipt.transaction.kind === "keep") {
    await runLogTransactionStage(
      workDir,
      receipt,
      "commit-applied-or-verified",
      options,
      () => applyOrVerifyKeepCommit(workDir, config, receipt, options),
      () => verifyRecordedCommit(workDir, receipt),
    );
  }
  await runLogTransactionStage(
    workDir,
    receipt,
    "ledger-event-present",
    options,
    () => ensureLedgerEvent(workDir, config, receipt),
    () => verifyLedgerEvent(workDir, receipt),
  );
  if (receipt.transaction.kind === "non-keep") {
    const cleanupErrors: unknown[] = [];
    try {
      await runLogTransactionStage(
        workDir,
        receipt,
        "tracked-cleanup-complete",
        options,
        () => applyTrackedCleanup(workDir, receipt),
        () => verifyTrackedCleanupPostcondition(workDir, receipt),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await runLogTransactionStage(
        workDir,
        receipt,
        "untracked-cleanup-complete",
        options,
        () => applyUntrackedCleanup(workDir, receipt),
        () => verifyUntrackedCleanupPostcondition(workDir, receipt),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 1) {
      receipt.status = "failed";
      await writeLogTransactionReceipt(workDir, receipt);
      throw new AggregateError(
        cleanupErrors,
        cleanupErrors
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join(" "),
      );
    }
    if (cleanupErrors.length === 1) {
      receipt.status = "failed";
      await writeLogTransactionReceipt(workDir, receipt);
      throw cleanupErrors[0];
    }
  }
  await runLogTransactionStage(
    workDir,
    receipt,
    "packet-cleanup-complete",
    options,
    () => cleanupPacketPaths(receipt.cleanup.packetPaths),
    () => verifyPacketCleanupPostcondition(receipt.cleanup.packetPaths),
  );
  completeLogTransactionStage(receipt, "done");
  receipt.status = "done";
  await writeLogTransactionReceipt(workDir, receipt);
  await verifyCompletedLogTransactionStages(workDir, receipt);
  await clearPendingLogTransaction(receipt.stateStorage.path);
}

async function verifyCompletedLogTransactionStages(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  const completed = new Set(receipt.completedStages);
  if (completed.has("commit-applied-or-verified")) await verifyRecordedCommit(workDir, receipt);
  if (completed.has("ledger-event-present")) await verifyLedgerEvent(workDir, receipt);
  if (completed.has("tracked-cleanup-complete")) {
    await verifyTrackedCleanupPostcondition(workDir, receipt);
  }
  if (completed.has("untracked-cleanup-complete")) {
    await verifyUntrackedCleanupPostcondition(workDir, receipt);
  }
  if (completed.has("packet-cleanup-complete")) {
    await verifyPacketCleanupPostcondition(receipt.cleanup.packetPaths);
  }
}

async function runLogTransactionStage(
  workDir: string,
  receipt: LogTransactionReceipt,
  stage: Exclude<LogTransactionStage, "prepared" | "done">,
  options: LogExperimentOptions,
  operation: () => Promise<void>,
  verifyCompleted?: () => Promise<void>,
): Promise<void> {
  try {
    if (receipt.completedStages.includes(stage)) {
      if (verifyCompleted) await verifyCompleted();
      return;
    }
    await options.faultInjection?.(`before:${stage}`);
    await operation();
    completeLogTransactionStage(receipt, stage);
    receipt.status = "pending";
    await writeLogTransactionReceipt(workDir, receipt);
    await options.faultInjection?.(`after:${stage}`);
  } catch (error) {
    const message = redactEvidenceText(error instanceof Error ? error.message : String(error), {
      workDir,
    });
    receipt.status = "failed";
    receipt.failures.push({
      at: new Date().toISOString(),
      stage,
      message,
      messageDigest: sha256Text(message),
    });
    await writeLogTransactionReceipt(workDir, receipt);
    throw error;
  }
}

function completeLogTransactionStage(
  receipt: LogTransactionReceipt,
  stage: LogTransactionStage,
): void {
  if (!receipt.completedStages.includes(stage)) receipt.completedStages.push(stage);
  const order = logTransactionStageOrder(receipt.transaction.kind);
  receipt.completedStages.sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

function logTransactionStageOrder(kind: "keep" | "non-keep"): LogTransactionStage[] {
  return kind === "keep"
    ? [
        "prepared",
        "commit-applied-or-verified",
        "ledger-event-present",
        "packet-cleanup-complete",
        "done",
      ]
    : [
        "prepared",
        "ledger-event-present",
        "tracked-cleanup-complete",
        "untracked-cleanup-complete",
        "packet-cleanup-complete",
        "done",
      ];
}

async function intendedCommitTree(
  workDir: string,
  parentOid: string,
  paths: string[],
): Promise<string> {
  return await withTemporaryGitIndex(workDir, async (indexEnvironment) => {
    const initialize = await runGit(
      parentOid ? ["read-tree", parentOid] : ["read-tree", "--empty"],
      workDir,
      { env: indexEnvironment },
    );
    if (initialize.code !== 0) {
      throw new Error(
        `Git could not initialize the intended commit tree: ${gitOutput(initialize, "unknown error")}`,
      );
    }
    const add = await runGit(
      paths.length > 0 ? ["--literal-pathspecs", "add", "-A", "--", ...paths] : ["add", "-A"],
      workDir,
      { env: indexEnvironment },
    );
    if (add.code !== 0) {
      if (gitIndexLockFailure(add)) {
        const lockPath = await gitPrivatePath(workDir, "index.lock");
        throw new Error(await gitIndexLockMessage(workDir, lockPath, "git add", true));
      }
      throw new Error(`Git add failed: ${gitOutput(add, "unknown error")}`);
    }
    const tree = await runGit(["write-tree"], workDir, { env: indexEnvironment });
    if (tree.code !== 0 || tree.stdoutTruncated) {
      throw new Error(
        `Git could not write the intended commit tree: ${gitOutput(tree, "unknown error")}`,
      );
    }
    return tree.stdout.trim();
  });
}

async function assertTreeContainsEvaluatedCandidate(
  workDir: string,
  treeOid: string,
  candidatePaths: string[],
): Promise<void> {
  if (candidatePaths.length === 0) return;
  await withTemporaryGitIndex(workDir, async (indexEnvironment) => {
    const initialize = await runGit(["read-tree", treeOid], workDir, { env: indexEnvironment });
    if (initialize.code !== 0) {
      throw new Error(
        `Git could not initialize candidate-tree verification: ${gitOutput(initialize, "unknown error")}`,
      );
    }
    const tracked = await runGit(
      ["--literal-pathspecs", "diff", "--quiet", treeOid, "--", ...candidatePaths],
      workDir,
      { env: indexEnvironment },
    );
    if (tracked.code === 1) {
      throw new Error(
        "The keep commit scope omits part of the accepted editable evaluated candidate.",
      );
    }
    if (tracked.code !== 0 || tracked.stdoutTruncated) {
      throw new Error(
        `Git could not compare the intended tree with the evaluated candidate: ${gitOutput(tracked, "unknown error")}`,
      );
    }
    const untrackedCommands = [
      ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--"],
      [
        "--literal-pathspecs",
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
      ],
    ];
    for (const command of untrackedCommands) {
      const untracked = await runGit([...command, ...candidatePaths], workDir, {
        env: indexEnvironment,
      });
      if (untracked.code !== 0 || untracked.stdoutTruncated) {
        throw new Error(
          `Git could not verify the evaluated candidate tree: ${gitOutput(untracked, "unknown error")}`,
        );
      }
      if (untracked.stdout.length > 0) {
        throw new Error(
          "The keep commit scope omits untracked accepted editable evaluated candidate content.",
        );
      }
    }
  });
}

async function assertAcceptedCandidateHasCommitDelta(
  workDir: string,
  parentTreeOid: string,
  intendedTreeOid: string,
  candidatePaths: string[],
): Promise<void> {
  const delta = await runGit(
    [
      "--literal-pathspecs",
      "diff",
      "--quiet",
      parentTreeOid,
      intendedTreeOid,
      "--",
      ...candidatePaths,
    ],
    workDir,
  );
  if (delta.code === 1 && !delta.stdoutTruncated) return;
  if (delta.code === 0 && !delta.stdoutTruncated) {
    throw new Error(
      "Refusing a no-op keep because the accepted evaluated candidate scope has no commit delta.",
    );
  }
  throw new Error(
    `Git could not verify the accepted candidate commit delta: ${gitOutput(delta, "unknown error")}`,
  );
}

async function expectedReconciledIndexTree(
  workDir: string,
  preparedIndexTree: string,
  intendedTree: string,
  paths: string[],
): Promise<string> {
  if (paths.length === 0) return intendedTree;
  return await withTemporaryGitIndex(workDir, async (indexEnvironment) => {
    const initialize = await runGit(["read-tree", preparedIndexTree], workDir, {
      env: indexEnvironment,
    });
    if (initialize.code !== 0) {
      throw new Error(
        `Git could not initialize the reconciled index tree: ${gitOutput(initialize, "unknown error")}`,
      );
    }
    const restore = await runGit(
      ["--literal-pathspecs", "restore", `--source=${intendedTree}`, "--staged", "--", ...paths],
      workDir,
      { env: indexEnvironment },
    );
    if (restore.code !== 0) {
      throw new Error(
        `Git could not prepare the reconciled index tree: ${gitOutput(restore, "unknown error")}`,
      );
    }
    const tree = await runGit(["write-tree"], workDir, { env: indexEnvironment });
    if (tree.code !== 0 || tree.stdoutTruncated) {
      throw new Error(
        `Git could not write the reconciled index tree: ${gitOutput(tree, "unknown error")}`,
      );
    }
    return tree.stdout.trim();
  });
}

async function parentTreeOid(workDir: string, parentOid: string): Promise<string> {
  if (parentOid) {
    return await requiredGitText(
      workDir,
      ["show", "-s", "--format=%T", parentOid],
      "read parent commit tree",
    );
  }
  return await withTemporaryGitIndex(workDir, async (indexEnvironment) => {
    const initialize = await runGit(["read-tree", "--empty"], workDir, {
      env: indexEnvironment,
    });
    if (initialize.code !== 0) {
      throw new Error(
        `Git could not initialize the empty parent tree: ${gitOutput(initialize, "unknown error")}`,
      );
    }
    const tree = await runGit(["write-tree"], workDir, { env: indexEnvironment });
    if (tree.code !== 0 || tree.stdoutTruncated) {
      throw new Error(
        `Git could not read the empty parent tree: ${gitOutput(tree, "unknown error")}`,
      );
    }
    return tree.stdout.trim();
  });
}

async function withTemporaryGitIndex<T>(
  workDir: string,
  operation: (environment: NodeJS.ProcessEnv, indexPath: string) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-git-index-"));
  const indexPath = path.join(temporaryRoot, "index");
  try {
    return await operation({ GIT_INDEX_FILE: indexPath }, indexPath);
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function applyOrVerifyKeepCommit(
  workDir: string,
  config: UnknownRecord,
  receipt: LogTransactionReceipt,
  options: LogExperimentOptions,
): Promise<void> {
  await verifyAcceptedKeepAuthorityAtMutationBoundary(workDir, config, receipt);
  const expectation = receipt.commitExpectation;
  if (expectation.mode === "none") return;
  if (expectation.mode === "existing") {
    await verifyRecordedCommit(workDir, receipt);
    receipt.evidence.experiment.commit = expectation.oid.slice(0, 12);
    receipt.result.commit = expectation.oid;
    refreshLedgerEventIdentity(receipt);
    return;
  }
  if (expectation.oid) {
    await verifyRecordedCommitIdentity(workDir, receipt);
    await reconcileCommittedIndex(workDir, receipt);
    await verifyRecordedCommit(workDir, receipt);
    receipt.evidence.experiment.commit = expectation.oid.slice(0, 12);
    receipt.result.commit = expectation.oid;
    refreshLedgerEventIdentity(receipt);
    return;
  }
  await assertPreparedHeadState(workDir, receipt.preGit.headState);
  const currentHead = await preparedRefOid(workDir, receipt.preGit.headState);
  if (currentHead !== expectation.parentOid) {
    if (await commitMatchesInterruptedCreation(workDir, currentHead, expectation)) {
      expectation.oid = currentHead;
      await reconcileCommittedIndex(workDir, receipt);
      recordCreatedCommit(receipt, currentHead);
      await writeLogTransactionReceipt(workDir, receipt);
      await verifyRecordedCommit(workDir, receipt);
      return;
    }
    throw new Error("Git HEAD changed while the keep transaction was pending.");
  }
  const liveTree = await intendedCommitTree(workDir, expectation.parentOid, expectation.paths);
  if (liveTree !== expectation.treeOid) {
    throw new Error("The intended commit tree changed after transaction preparation.");
  }
  await assertTreeContainsEvaluatedCandidate(workDir, liveTree, expectation.candidatePaths);
  await assertPreparedIndex(workDir, receipt);
  const hooksPath = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-empty-hooks-"));
  let createdOid = "";
  try {
    const commitResult = await runGit(
      [
        "-c",
        `core.hooksPath=${hooksPath}`,
        "commit-tree",
        expectation.treeOid,
        ...(expectation.parentOid ? ["-p", expectation.parentOid] : []),
        "-m",
        expectation.message.trimEnd(),
      ],
      workDir,
    );
    if (commitResult.code !== 0 || commitResult.stdoutTruncated) {
      throw new Error(`Git commit creation failed: ${gitOutput(commitResult, "unknown error")}`);
    }
    createdOid = commitResult.stdout.trim();
    if (!(await commitMatchesInterruptedCreation(workDir, createdOid, expectation))) {
      throw new Error("Git commit creation did not match the immutable intended tree.");
    }
    await advancePreparedRefAtomically(workDir, receipt, createdOid);
    await options.faultInjection?.("after:commit-ref-updated");
  } finally {
    await fsp.rm(hooksPath, { recursive: true, force: true });
  }
  expectation.oid = createdOid;
  await reconcileCommittedIndex(workDir, receipt);
  recordCreatedCommit(receipt, createdOid);
  await writeLogTransactionReceipt(workDir, receipt);
  await verifyRecordedCommit(workDir, receipt);
}

async function advancePreparedRefAtomically(
  workDir: string,
  receipt: LogTransactionReceipt,
  createdOid: string,
): Promise<void> {
  const headState = receipt.preGit.headState;
  const oldOid = receipt.commitExpectation.parentOid || "0".repeat(createdOid.length);
  if (headState.kind === "detached") {
    await advanceDetachedHeadFileAtomically(workDir, oldOid, createdOid);
    return;
  }
  if (headState.kind !== "symbolic") {
    throw new Error("A create-mode keep requires a prepared symbolic or detached Git HEAD.");
  }
  await advanceSymbolicHeadFilesAtomically(workDir, headState.ref, oldOid, createdOid);
}

async function advanceSymbolicHeadFilesAtomically(
  workDir: string,
  intendedRef: string,
  oldOid: string,
  newOid: string,
): Promise<void> {
  await assertFilesReferenceStorage(workDir);
  const headPath = await gitPrivatePath(workDir, "HEAD");
  const refPath = await gitPrivatePath(workDir, intendedRef);
  const headLockPath = `${headPath}.lock`;
  const refLockPath = `${refPath}.lock`;
  const headStat = await fsp.lstat(headPath);
  if (headStat.isSymbolicLink() || !headStat.isFile()) {
    throw new Error("Git symbolic HEAD must be a regular file before an atomic keep update.");
  }
  const refStat = await fsp.lstat(refPath).catch((error) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (refStat && (refStat.isSymbolicLink() || !refStat.isFile())) {
    throw new Error("The prepared Git ref must be a regular file before an atomic keep update.");
  }
  await fsp.mkdir(path.dirname(refPath), { recursive: true });
  let headLock: FileHandle | null = null;
  let refLock: FileHandle | null = null;
  let headLockOwned = false;
  let refLockOwned = false;
  let refInstalled = false;
  try {
    headLock = await fsp.open(headLockPath, "wx", headStat.mode & 0o777);
    headLockOwned = true;
    refLock = await fsp.open(refLockPath, "wx", refStat ? refStat.mode & 0o777 : 0o666);
    refLockOwned = true;
    const liveHead = (await fsp.readFile(headPath, "utf8")).trim();
    if (liveHead !== `ref: ${intendedRef}`) {
      throw new Error(
        "Git atomic prepared-ref transaction failed because symbolic HEAD changed before update.",
      );
    }
    const liveRef = await requiredGitText(
      workDir,
      ["rev-parse", "--verify", intendedRef],
      "verify the locked prepared Git ref",
    );
    if (liveRef !== oldOid) {
      throw new Error(
        "Git atomic prepared-ref transaction failed because the intended ref changed before update.",
      );
    }
    await refLock.writeFile(`${newOid}\n`, "utf8");
    await refLock.sync();
    await refLock.close();
    refLock = null;
    await fsp.rename(refLockPath, refPath);
    refInstalled = true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(
        "Git atomic prepared-ref transaction could not lock symbolic HEAD and its intended ref. Wait for active Git commands to finish, then retry the exact log command.",
      );
    }
    throw error;
  } finally {
    if (refLock) await refLock.close().catch(() => {});
    if (headLock) await headLock.close().catch(() => {});
    if (refLockOwned && !refInstalled) await fsp.rm(refLockPath, { force: true }).catch(() => {});
    if (headLockOwned) await fsp.rm(headLockPath, { force: true }).catch(() => {});
  }
}

async function assertFilesReferenceStorage(workDir: string): Promise<void> {
  const format = await runGit(["rev-parse", "--show-ref-format"], workDir);
  if (format.code === 0 && !format.stdoutTruncated && format.stdout.trim() === "files") return;
  if (format.code !== 0 && /unknown option|usage:/i.test(gitOutput(format, ""))) {
    const configured = await runGit(["config", "--get", "extensions.refStorage"], workDir);
    if (configured.code === 1 && !configured.stdoutTruncated && !configured.stderrTruncated) return;
    if (
      configured.code === 0 &&
      !configured.stdoutTruncated &&
      !configured.stderrTruncated &&
      configured.stdout.trim() === "files"
    ) {
      return;
    }
  }
  const observed = format.code === 0 ? format.stdout.trim() : gitOutput(format, "unknown");
  throw new Error(
    `Git reference storage ${JSON.stringify(observed || "unknown")} cannot provide the required atomic symbolic-HEAD lock boundary. Use the files ref backend or upgrade Git; no ref was updated.`,
  );
}

async function advanceDetachedHeadFileAtomically(
  workDir: string,
  oldOid: string,
  newOid: string,
): Promise<void> {
  const headPath = await gitPrivatePath(workDir, "HEAD");
  const lockPath = `${headPath}.lock`;
  const headStat = await fsp.lstat(headPath);
  if (headStat.isSymbolicLink() || !headStat.isFile()) {
    throw new Error("Git detached HEAD must be a regular file before an atomic keep update.");
  }
  let handle: FileHandle | null = null;
  let lockOwned = false;
  let installed = false;
  try {
    handle = await fsp.open(lockPath, "wx", headStat.mode & 0o777);
    lockOwned = true;
    const live = (await fsp.readFile(headPath, "utf8")).trim();
    if (live !== oldOid || live.startsWith("ref:")) {
      throw new Error(
        "Git atomic prepared-ref transaction failed because detached HEAD changed before update.",
      );
    }
    await handle.writeFile(`${newOid}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(lockPath, headPath);
    installed = true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(
        `Git atomic prepared-ref transaction could not lock detached HEAD: ${lockPath}. Wait for active Git commands to finish, then retry the exact log command.`,
      );
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (lockOwned && !installed) await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function reconcileCommittedIndex(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  const expectation = receipt.commitExpectation;
  const indexPath = await gitPrivatePath(workDir, "index");
  const lockPath = await gitPrivatePath(workDir, "index.lock");
  if (path.resolve(lockPath) !== `${path.resolve(indexPath)}.lock`) {
    throw new Error("Git returned an unexpected index lock path; refusing index reconciliation.");
  }
  const indexStat = await fsp.lstat(indexPath).catch((error) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (indexStat && (indexStat.isSymbolicLink() || !indexStat.isFile())) {
    throw new Error("Git index must be a regular file before atomic reconciliation.");
  }
  let handle: FileHandle | null = null;
  let lockOwned = false;
  let installed = false;
  try {
    handle = await fsp.open(lockPath, "wx", indexStat ? indexStat.mode & 0o777 : 0o600);
    lockOwned = true;
    const liveStat = await fsp.lstat(indexPath).catch((error) => {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    });
    if (liveStat && (liveStat.isSymbolicLink() || !liveStat.isFile())) {
      throw new Error("Git index changed type while acquiring its reconciliation lock.");
    }
    const replacement = await withTemporaryGitIndex(
      workDir,
      async (indexEnvironment, temporaryIndexPath) => {
        if (liveStat) {
          await fsp.copyFile(indexPath, temporaryIndexPath);
        } else {
          const initialize = await runGit(["read-tree", "--empty"], workDir, {
            env: indexEnvironment,
          });
          if (initialize.code !== 0) {
            throw new Error(
              `Git could not initialize the live index snapshot: ${gitOutput(initialize, "unknown error")}`,
            );
          }
        }
        const currentTree = await requiredGitTextWithEnvironment(
          workDir,
          ["write-tree"],
          "verify locked commit index",
          indexEnvironment,
        );
        if (currentTree === expectation.reconciledIndexTree) return null;
        if (currentTree !== receipt.preGit.indexTree) {
          throw new Error(
            "Git index changed from both the prepared and reconciled transaction states; refusing staged drift.",
          );
        }
        const install = await runGit(
          expectation.paths.length > 0
            ? [
                "--literal-pathspecs",
                "restore",
                `--source=${expectation.treeOid}`,
                "--staged",
                "--",
                ...expectation.paths,
              ]
            : ["read-tree", expectation.treeOid],
          workDir,
          { env: indexEnvironment },
        );
        if (install.code !== 0) {
          throw new Error(
            `Git could not prepare the atomic reconciled index: ${gitOutput(install, "unknown error")}`,
          );
        }
        const installedTree = await requiredGitTextWithEnvironment(
          workDir,
          ["write-tree"],
          "verify atomic reconciled index",
          indexEnvironment,
        );
        if (installedTree !== expectation.reconciledIndexTree) {
          throw new Error("Git atomic index replacement did not match the receipt-bound tree.");
        }
        return await fsp.readFile(temporaryIndexPath);
      },
    );
    if (!replacement) return;
    await handle.writeFile(replacement);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(lockPath, indexPath);
    installed = true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(
        await gitIndexLockMessage(workDir, lockPath, "atomic commit index reconciliation", true),
      );
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (lockOwned && !installed) await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function requiredGitTextWithEnvironment(
  workDir: string,
  args: string[],
  label: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runGit(args, workDir, { env });
  if (result.code !== 0 || result.stdoutTruncated) {
    throw new Error(`Git could not ${label}: ${gitOutput(result, "unknown error")}`);
  }
  return result.stdout.trim();
}

async function assertPreparedIndex(workDir: string, receipt: LogTransactionReceipt): Promise<void> {
  const current = await currentIndexTree(workDir, "verify prepared keep index");
  if (current !== receipt.preGit.indexTree) {
    throw new Error("Git index changed after keep transaction preparation; refusing staged drift.");
  }
}

async function currentIndexTree(workDir: string, label: string): Promise<string> {
  return await requiredGitText(workDir, ["write-tree"], label);
}

function recordCreatedCommit(receipt: LogTransactionReceipt, oid: string): void {
  const expectation = receipt.commitExpectation;
  receipt.result.commit = oid;
  receipt.result.gitMessage = `Git: committed ${oid.slice(0, 12)}${
    expectation.allowAddAll ? " using explicit add-all" : ""
  }.`;
  receipt.evidence.experiment.commit = oid.slice(0, 12);
  refreshLedgerEventIdentity(receipt);
}

async function verifyRecordedCommit(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  await verifyRecordedCommitIdentity(workDir, receipt);
  if (receipt.commitExpectation.mode === "create") {
    const indexTree = await currentIndexTree(workDir, "verify recorded keep index");
    if (indexTree !== receipt.commitExpectation.reconciledIndexTree) {
      throw new Error("Recorded keep commit index reconciliation is incomplete or changed.");
    }
  }
}

async function verifyRecordedCommitIdentity(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  const expectation = receipt.commitExpectation;
  if (expectation.mode === "none") return;
  if (!expectation.oid) throw new Error("Pending keep transaction has no recorded commit OID.");
  await assertPreparedHeadState(workDir, receipt.preGit.headState);
  const head = await preparedRefOid(workDir, receipt.preGit.headState);
  if (head !== expectation.oid) {
    throw new Error("Recorded keep commit is no longer on the prepared Git ref.");
  }
  const metadata = await commitMetadata(workDir, expectation.oid);
  if (
    metadata.parentOid !== expectation.parentOid ||
    metadata.treeOid !== expectation.treeOid ||
    metadata.messageDigest !== expectation.messageDigest
  ) {
    throw new Error("Recorded keep commit parent, tree, or message digest changed.");
  }
}

async function preparedRefOid(workDir: string, headState: PreparedHeadState): Promise<string> {
  if (headState.kind === "none") return "";
  const ref = headState.kind === "symbolic" ? headState.ref : "HEAD";
  const result = await runGit(["rev-parse", "--verify", "--quiet", ref], workDir);
  if (result.code === 1 && !result.stdoutTruncated) return "";
  if (result.code !== 0 || result.stdoutTruncated) {
    throw new Error(`Git could not read the prepared ref: ${gitOutput(result, "unknown error")}`);
  }
  return result.stdout.trim();
}

async function commitMatchesInterruptedCreation(
  workDir: string,
  oid: string,
  expectation: LogTransactionReceipt["commitExpectation"],
): Promise<boolean> {
  const metadata = await commitMetadata(workDir, oid).catch(() => null);
  if (
    !metadata ||
    metadata.parentOid !== expectation.parentOid ||
    metadata.treeOid !== expectation.treeOid ||
    metadata.messageDigest !== expectation.messageDigest
  ) {
    return false;
  }
  return true;
}

async function commitMetadata(
  workDir: string,
  oid: string,
): Promise<{
  parentOid: string;
  treeOid: string;
  messageDigest: string;
}> {
  const parentOid = await requiredGitText(
    workDir,
    ["show", "-s", "--format=%P", oid],
    "read commit parent",
  );
  const treeOid = await requiredGitText(
    workDir,
    ["show", "-s", "--format=%T", oid],
    "read commit tree",
  );
  const message = await requiredGitText(
    workDir,
    ["show", "-s", "--format=%B", oid],
    "read commit message",
  );
  return { parentOid, treeOid, messageDigest: sha256Text(`${message.trimEnd()}\n`) };
}

async function ensureLedgerEvent(
  workDir: string,
  config: UnknownRecord,
  receipt: LogTransactionReceipt,
): Promise<void> {
  await reverifyEvidenceArtifacts(workDir, receipt.evidence.artifacts);
  refreshLedgerEventIdentity(receipt);
  await writeLogTransactionReceipt(workDir, receipt);
  const expected = ledgerRowsForReceipt(receipt);
  const suffix = await inspectTransactionLedgerSuffix(workDir, receipt, expected);
  if (suffix.state === "complete") {
    await verifyLedgerEvent(workDir, receipt);
    return;
  }
  const sessionPaths = resolveSessionPaths({ workDir });
  const authorityEntries = parseJsonlRecords(
    suffix.prefix.toString("utf8"),
    sessionPaths.ledgerPath,
  );
  await verifyAcceptedKeepAuthorityAtMutationBoundary(workDir, config, receipt, authorityEntries);
  if (suffix.state === "torn") {
    await checkedAtomicWriteFile(sessionPaths.sessionDir, sessionPaths.ledgerPath, suffix.prefix, {
      mode: 0o600,
    });
  }
  await checkedAppendFile(
    sessionPaths.sessionDir,
    sessionPaths.ledgerPath,
    ledgerSuffixBytes(receipt, expected),
    { mode: 0o600 },
  );
  await verifyLedgerEvent(workDir, receipt);
}

async function verifyLedgerEvent(workDir: string, receipt: LogTransactionReceipt): Promise<void> {
  const expected = ledgerRowsForReceipt(receipt);
  const suffix = await inspectTransactionLedgerSuffix(workDir, receipt, expected);
  if (suffix.state !== "complete") {
    throw new Error("The pending transaction ledger event is incomplete.");
  }
  const existing = transactionLedgerRows(workDir, receipt.transaction.id);
  assertCompatibleTransactionRows(existing, receipt.ledgerEvent.eventDigest, expected);
  const indexes = new Set(existing.map((row) => Number(record(row.logTransaction).entryIndex)));
  if (indexes.size !== expected.length) {
    throw new Error("The pending transaction ledger event is incomplete.");
  }
}

type TransactionLedgerSuffix =
  | { state: "absent"; prefix: Buffer }
  | { state: "complete"; prefix: Buffer }
  | { state: "torn"; prefix: Buffer };

async function inspectTransactionLedgerSuffix(
  workDir: string,
  receipt: LogTransactionReceipt,
  expectedRows: UnknownRecord[],
): Promise<TransactionLedgerSuffix> {
  const current = await readLedgerBytes(workDir);
  const prefixByteLength = receipt.ledgerEvent.prefixByteLength;
  if (current.byteLength < prefixByteLength) {
    throw new Error("The ledger changed before the pending transaction prefix.");
  }
  const prefix = current.subarray(0, prefixByteLength);
  if (sha256Bytes(prefix) !== receipt.ledgerEvent.prefixDigest) {
    throw new Error("The ledger prefix changed while the log transaction was pending.");
  }
  const requiredDelimiter =
    prefix.byteLength > 0 && prefix[prefix.byteLength - 1] !== 0x0a ? "\n" : "";
  if (receipt.ledgerEvent.prefixDelimiter !== requiredDelimiter) {
    throw new Error("The receipt-owned ledger row delimiter does not match the prepared prefix.");
  }
  const suffix = current.subarray(prefixByteLength);
  const expected = ledgerSuffixBytes(receipt, expectedRows);
  if (suffix.equals(expected)) return { state: "complete", prefix };
  if (suffix.byteLength === 0) return { state: "absent", prefix };
  if (
    suffix.byteLength < expected.byteLength &&
    expected.subarray(0, suffix.byteLength).equals(suffix)
  ) {
    return { state: "torn", prefix };
  }
  throw new Error(
    "The ledger suffix is not an unambiguous partial write owned by the pending transaction.",
  );
}

async function snapshotLedgerPrefix(
  workDir: string,
): Promise<{ byteLength: number; delimiter: "" | "\n"; digest: string }> {
  const bytes = await readLedgerBytes(workDir);
  return {
    byteLength: bytes.byteLength,
    delimiter: bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a ? "\n" : "",
    digest: sha256Bytes(bytes),
  };
}

async function readLedgerBytes(workDir: string): Promise<Buffer> {
  const ledgerPath = resolveSessionPaths({ workDir }).ledgerPath;
  try {
    return await fsp.readFile(ledgerPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return Buffer.alloc(0);
    throw error;
  }
}

function serializeLedgerRows(rows: UnknownRecord[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function ledgerSuffixBytes(receipt: LogTransactionReceipt, rows: UnknownRecord[]): Buffer {
  return Buffer.from(`${receipt.ledgerEvent.prefixDelimiter}${serializeLedgerRows(rows)}`, "utf8");
}

function transactionLedgerRows(workDir: string, transactionId: string): UnknownRecord[] {
  return readJsonl(workDir).filter(
    (row) => record(row.logTransaction).id === transactionId,
  ) as UnknownRecord[];
}

function assertCompatibleTransactionRows(
  rows: UnknownRecord[],
  eventDigest: string,
  expectedRows: UnknownRecord[],
): void {
  const indexes = new Set<number>();
  for (const row of rows) {
    const metadata = record(row.logTransaction);
    const index = Number(metadata.entryIndex);
    if (metadata.eventDigest !== eventDigest) {
      throw new Error("The transaction ID already exists with a different ledger event digest.");
    }
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expectedRows.length ||
      indexes.has(index)
    ) {
      throw new Error("The transaction ledger event contains duplicate or invalid row identities.");
    }
    if (sha256Json(row) !== sha256Json(expectedRows[index])) {
      throw new Error("The transaction ledger event content does not match its event digest.");
    }
    indexes.add(index);
  }
}

function refreshLedgerEventIdentity(receipt: LogTransactionReceipt): void {
  const eventDigest = logEvidenceDigest(receipt.evidence);
  receipt.evidence.digest = eventDigest;
  receipt.ledgerEvent = {
    ...receipt.ledgerEvent,
    transactionId: receipt.transaction.id,
    eventDigest,
  };
  receipt.evidence.experiment.logTransaction = {
    id: receipt.transaction.id,
    eventDigest,
  };
}

function refreshLogTransactionPlanDigests(receipt: LogTransactionReceipt): void {
  receipt.commitExpectation.digest = commitExpectationDigest(receipt);
  receipt.cleanup.digest = cleanupPlanDigest(receipt.cleanup);
}

function commitExpectationDigest(receipt: LogTransactionReceipt): string {
  const { digest: _digest, oid: _oid, ...expectation } = receipt.commitExpectation;
  return sha256Json(expectation);
}

function cleanupPlanDigest(cleanup: LogTransactionReceipt["cleanup"]): string {
  const { digest: _digest, ...plan } = cleanup;
  return sha256Json(plan);
}

function logTransactionCheckpointDigest(receipt: LogTransactionReceipt): string {
  return sha256Json({
    transactionId: receipt.transaction.id,
    ledgerEvent: receipt.ledgerEvent,
    status: receipt.status,
    completedStages: receipt.completedStages,
    commitOid: receipt.commitExpectation.oid,
    result: receipt.result,
    failures: receipt.failures,
  });
}

function logEvidenceDigest(evidence: LogTransactionReceipt["evidence"]): string {
  const experiment = { ...evidence.experiment };
  delete experiment.logTransaction;
  const lifecycle = evidence.processLifecycle.map((entry) => {
    const copy = { ...entry };
    delete copy.logTransaction;
    return copy;
  });
  return sha256Json({ artifacts: evidence.artifacts, experiment, processLifecycle: lifecycle });
}

function ledgerRowsForReceipt(receipt: LogTransactionReceipt): UnknownRecord[] {
  const baseRows = [
    ...receipt.evidence.processLifecycle.map((entry) => ({ ...entry })),
    { ...receipt.evidence.experiment },
  ];
  return baseRows.map((row, entryIndex) => ({
    ...row,
    logTransaction: {
      id: receipt.transaction.id,
      eventDigest: receipt.ledgerEvent.eventDigest,
      entryIndex,
      entryCount: baseRows.length,
    },
  }));
}

async function cleanupPacketPaths(paths: string[]): Promise<void> {
  const failures: unknown[] = [];
  for (const filePath of uniqueSorted(paths)) {
    try {
      await fsp.unlink(filePath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Last-run packet cleanup failed.");
  }
}

async function verifyPacketCleanupPostcondition(paths: string[]): Promise<void> {
  const present = uniqueSorted(paths).filter((filePath) => fs.existsSync(filePath));
  if (present.length > 0) {
    throw new Error(
      "Last-run packet cleanup postcondition failed because packet state is present.",
    );
  }
}

async function preGitDigests(
  workDir: string,
  inGit: boolean,
): Promise<LogTransactionReceipt["preGit"]> {
  if (!inGit) {
    const empty = {
      headOid: "",
      headState: { kind: "none" as const, ref: "" as const },
      indexTree: "",
      statusDigest: sha256Text(""),
    };
    return { ...empty, digest: sha256Json(empty) };
  }
  const headState = await gitHeadState(workDir);
  const snapshot = {
    headOid: await preparedRefOid(workDir, headState),
    headState,
    indexTree: await requiredGitText(workDir, ["write-tree"], "read pre-Git index tree"),
    statusDigest: sha256Text(await gitStatusShort(workDir)),
  };
  return { ...snapshot, digest: sha256Json(snapshot) };
}

function isPreparedHeadState(value: unknown): value is PreparedHeadState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as { kind?: unknown; ref?: unknown };
  if (state.kind === "none" || state.kind === "detached") return state.ref === "";
  return (
    state.kind === "symbolic" &&
    typeof state.ref === "string" &&
    state.ref.startsWith("refs/") &&
    state.ref.length > "refs/".length
  );
}

async function gitHeadState(workDir: string): Promise<PreparedHeadState> {
  const symbolic = await runGit(["symbolic-ref", "--quiet", "HEAD"], workDir);
  if (symbolic.code === 0 && !symbolic.stdoutTruncated) {
    const ref = symbolic.stdout.trim();
    if (!ref) throw new Error("Git returned an empty symbolic HEAD reference.");
    return { kind: "symbolic", ref };
  }
  if (symbolic.code === 1 && !symbolic.stdoutTruncated) return { kind: "detached", ref: "" };
  throw new Error(
    `Git could not read symbolic HEAD state: ${gitOutput(symbolic, "unknown error")}`,
  );
}

async function assertPreparedHeadState(
  workDir: string,
  expected: PreparedHeadState,
): Promise<void> {
  if (expected.kind === "none") {
    if (await insideGitRepo(workDir)) {
      throw new Error("Git repository state appeared after transaction preparation.");
    }
    return;
  }
  const current = await gitHeadState(workDir);
  if (sha256Json(current) !== sha256Json(expected)) {
    throw new Error(
      "Git symbolic branch or detached HEAD state changed after transaction preparation.",
    );
  }
}

async function gitHeadOrEmpty(workDir: string): Promise<string> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], workDir);
  if (result.code === 1 && !result.stdoutTruncated) return "";
  if (result.code !== 0 || result.stdoutTruncated) {
    throw new Error(`Git could not read pre-Git HEAD: ${gitOutput(result, "unknown error")}`);
  }
  return result.stdout.trim();
}

function logRequestIdentity(
  args: UnknownRecord,
  config: UnknownRecord,
  workDir: string,
): { requestDigest: string; configDigest: string } {
  const request = { ...args };
  delete request.cwd;
  delete request.working_dir;
  delete request.workingDir;
  return {
    requestDigest: sha256Json({ workDir: path.resolve(workDir), request }),
    configDigest: sha256Json(config),
  };
}

async function requiredGitText(workDir: string, args: string[], label: string): Promise<string> {
  const result = await runGit(args, workDir);
  if (result.code !== 0 || result.stdoutTruncated) {
    throw new Error(`Git could not ${label}: ${gitOutput(result, "unknown error")}`);
  }
  return result.stdout.trim();
}

export async function pendingLogTransactionWarnings(workDir: string, inGit?: boolean) {
  try {
    await resolvePrivateStateTarget(workDir, pendingLogTransactionStateSpec(workDir));
  } catch (error) {
    if (!(error instanceof PrivateStateConflictError)) throw error;
    return [
      {
        code: error.code,
        severity: "blocker",
        message: error.message,
        action: "Reconcile the two pending receipt copies before another packet or log mutation.",
        paths: await pendingLogTransactionCandidatePaths(workDir, inGit),
      },
    ];
  }
  const warnings: UnknownRecord[] = [];
  for (const receiptPath of await pendingLogTransactionCandidatePaths(workDir, inGit)) {
    if (!(await pathExists(receiptPath))) continue;
    warnings.push({
      code: PENDING_LOG_TRANSACTION_CODE,
      severity: "blocker",
      message:
        "A pending receipt records a schema-version-2 log transaction and may require an exact-input retry before another packet or unsafe mutation.",
      action:
        "Retry the exact original log request; changed inputs are rejected while the transaction is pending.",
      path: receiptPath,
      paths: [receiptPath],
    });
  }
  return warnings;
}

async function assertCommitPathsExist(workDir: string, commitPaths: string[]): Promise<void> {
  const missing: string[] = [];
  for (const relative of commitPaths) {
    if (await pathExists(path.join(workDir, relative))) continue;
    const tracked = await runGit(
      ["--literal-pathspecs", "ls-files", "-z", "--", relative],
      workDir,
    );
    if (tracked.code === 0 && tracked.stdout.length > 0) continue;
    missing.push(relative);
  }
  if (!missing.length) return;
  const remaining = commitPaths.filter((item) => !missing.includes(item));
  throw new Error(
    [
      `Configured commitPaths do not exist before git add: ${missing.slice(0, 8).join(", ")}.`,
      remaining.length
        ? `Repair with: node ${quote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} config --cwd ${quote(workDir)} --commit-paths ${quote(remaining.join(","))}`
        : "Repair by configuring commitPaths that exist or by passing --commit-paths for this log.",
      "No git add or commit was attempted.",
    ].join(" "),
  );
}

interface DiscardCleanupPlan extends UnknownRecord {
  dirtyPaths: string[];
  fingerprint: string;
  ownedDirtyPaths: string[];
  scopedPaths: string[];
  trackedPaths: string[];
  unownedDirtyPaths: string[];
  untrackedPaths: string[];
  willRevert: string[];
}

async function discardCleanupPlan(
  workDir: string,
  args: UnknownRecord,
  config: UnknownRecord,
  evidencePaths: string[] = [],
): Promise<DiscardCleanupPlan> {
  const protectedPaths = [
    ...AUTORESEARCH_SESSION_FILES,
    ...AUTORESEARCH_OWNED_FILES,
    ...AUTORESEARCH_OWNED_DIRS,
    ...evidencePaths,
  ];
  await assertProtectedCleanupPathsAreSafe(workDir, protectedPaths);
  const scopedPaths = normalizeRelativePaths(
    args.revert_paths ??
      args.revertPaths ??
      args.commit_paths ??
      args.commitPaths ??
      config.commitPaths,
    "revertPaths",
  );
  const statusShort = await gitStatusShort(workDir);
  const statusEntries = parsePorcelainV1Z(statusShort);
  await assertProtectedContentIdentityNotMoved(workDir, statusEntries, protectedPaths);
  const deletedPaths = uniqueSorted(
    statusEntries.flatMap((entry) => {
      if (entry.originalPath && entry.status.includes("R")) return [entry.originalPath];
      return entry.status.includes("D") ? [entry.path] : [];
    }),
  );
  const possibleDestinationPaths = uniqueSorted(
    statusEntries.flatMap((entry) => {
      if (entry.originalPath && /[RC]/.test(entry.status)) return [entry.path];
      return entry.status === "??" || /[AMTU]/.test(entry.status) ? [entry.path] : [];
    }),
  );
  const deletedProtected = deletedPaths.find((deletedPath) =>
    protectedPaths.some((protectedPath) => pathsOverlap(deletedPath, protectedPath)),
  );
  const protectedDestination = possibleDestinationPaths.find(
    (destinationPath) => destinationPath !== deletedProtected,
  );
  if (deletedProtected && protectedDestination) {
    throw new Error(
      `Refusing a moved protected session or evidence identity: ${deletedProtected} -> ${protectedDestination}.`,
    );
  }
  if (scopedPaths.length > 0) {
    for (const entry of statusEntries) {
      if (!entry.originalPath || !/[RC]/.test(entry.status)) continue;
      const ownership = entry.paths.map((entryPath) =>
        scopedPaths.some((scopePath) => pathIsCoveredByScope(entryPath, scopePath)),
      );
      if (ownership.some(Boolean) && !ownership.every(Boolean)) {
        throw new Error(
          `Refusing a rename or copy across the configured Git-scope ownership boundary: ${entry.paths.join(" -> ")}.`,
        );
      }
    }
    for (const deletedPath of deletedPaths) {
      for (const createdPath of possibleDestinationPaths) {
        const deletedOwned = scopedPaths.some((scopePath) =>
          pathIsCoveredByScope(deletedPath, scopePath),
        );
        const createdOwned = scopedPaths.some((scopePath) =>
          pathIsCoveredByScope(createdPath, scopePath),
        );
        if (deletedOwned !== createdOwned) {
          throw new Error(
            `Refusing an ambiguous edited or split-index rename across the configured Git-scope ownership boundary: ${deletedPath} -> ${createdPath}.`,
          );
        }
      }
    }
  }
  const selectableEntries = statusEntries.filter(
    (entry) =>
      !entry.paths.some((entryPath) =>
        protectedPaths.some((protectedPath) => pathsOverlap(entryPath, protectedPath)),
      ),
  );
  const dirtyPaths = statusEntries
    .flatMap((entry) => entry.paths)
    .sort((left, right) => left.localeCompare(right));
  const selectablePaths = uniqueSorted(selectableEntries.flatMap((entry) => entry.paths));
  const ownedDirtyPaths = selectablePaths.filter(
    (dirtyPath) =>
      scopedPaths.length === 0 ||
      scopedPaths.some((scopedPath) => pathIsCoveredByScope(dirtyPath, scopedPath)),
  );
  const unownedDirtyPaths = dirtyPaths.filter((dirtyPath) => !ownedDirtyPaths.includes(dirtyPath));
  const selectedEntries = selectableEntries.filter((entry) =>
    ownedDirtyPaths.some((dirtyPath) => entry.paths.includes(dirtyPath)),
  );
  const trackedPaths = uniqueSorted(
    selectedEntries.filter((entry) => entry.status !== "??").flatMap((entry) => entry.paths),
  );
  const untrackedPaths = uniqueSorted(
    selectedEntries.filter((entry) => entry.status === "??").flatMap((entry) => entry.paths),
  );
  return {
    scopedPaths,
    dirtyPaths,
    ownedDirtyPaths,
    trackedPaths,
    unownedDirtyPaths,
    untrackedPaths,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ scopedPaths, ownedDirtyPaths, unownedDirtyPaths, statusShort }))
      .digest("hex"),
    willRevert: ownedDirtyPaths,
  };
}

async function assertProtectedContentIdentityNotMoved(
  workDir: string,
  statusEntries: ReturnType<typeof parsePorcelainV1Z>,
  protectedPaths: string[],
): Promise<void> {
  const dirtyProtectedPaths = uniqueSorted(
    statusEntries
      .flatMap((entry) => entry.paths)
      .filter((entryPath) =>
        protectedPaths.some((protectedPath) => pathsOverlap(entryPath, protectedPath)),
      ),
  );
  const dirtyDestinationPaths = uniqueSorted(
    statusEntries
      .flatMap((entry) => entry.paths)
      .filter(
        (entryPath) =>
          !protectedPaths.some((protectedPath) => pathsOverlap(entryPath, protectedPath)),
      ),
  );
  if (dirtyProtectedPaths.length === 0 || dirtyDestinationPaths.length === 0) return;
  const headOid = await gitHeadOrEmpty(workDir);
  for (const protectedPath of dirtyProtectedPaths) {
    const protectedIdentities = new Set<string>([
      ...(await gitIndexBlobOids(workDir, protectedPath)),
      ...(headOid ? await gitTreeBlobOids(workDir, headOid, protectedPath) : []),
    ]);
    if (protectedIdentities.size === 0) continue;
    for (const destinationPath of dirtyDestinationPaths) {
      const destinationIdentities = new Set<string>([
        ...(await gitIndexBlobOids(workDir, destinationPath)),
        ...(await gitWorktreeBlobOids(workDir, destinationPath)),
      ]);
      if ([...destinationIdentities].some((oid) => protectedIdentities.has(oid))) {
        throw new Error(
          `Refusing cleanup because protected content identity moved from ${protectedPath} to ${destinationPath}.`,
        );
      }
    }
  }
}

async function gitIndexBlobOids(workDir: string, relativePath: string): Promise<string[]> {
  const result = await runGit(
    ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", relativePath],
    workDir,
  );
  if (result.code !== 0 || result.stdoutTruncated) {
    throw new Error(
      `Git could not inspect protected index identity for ${relativePath}: ${gitOutput(result, "unknown error")}`,
    );
  }
  return result.stdout
    .split("\0")
    .map((row) => /^\d{6} ([0-9a-f]{40,64}) [0-3]\t/.exec(row)?.[1] || "")
    .filter(Boolean);
}

async function gitTreeBlobOids(
  workDir: string,
  treeish: string,
  relativePath: string,
): Promise<string[]> {
  const result = await runGit(
    ["--literal-pathspecs", "ls-tree", "-z", treeish, "--", relativePath],
    workDir,
  );
  if (result.code !== 0 || result.stdoutTruncated) {
    throw new Error(
      `Git could not inspect protected committed identity for ${relativePath}: ${gitOutput(result, "unknown error")}`,
    );
  }
  return result.stdout
    .split("\0")
    .map((row) => /^\d{6} blob ([0-9a-f]{40,64})\t/.exec(row)?.[1] || "")
    .filter(Boolean);
}

async function gitWorktreeBlobOids(workDir: string, relativePath: string): Promise<string[]> {
  const absolutePath = path.resolve(workDir, relativePath);
  const stat = await fsp.lstat(absolutePath).catch((error) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (!stat?.isFile()) return [];
  const result = await runGit(["hash-object", "--no-filters", "--", relativePath], workDir);
  if (result.code !== 0 || result.stdoutTruncated) {
    throw new Error(
      `Git could not inspect protected worktree identity for ${relativePath}: ${gitOutput(result, "unknown error")}`,
    );
  }
  return [result.stdout.trim()].filter((oid) => /^[0-9a-f]{40,64}$/.test(oid));
}

async function assertProtectedCleanupPathsAreSafe(
  workDir: string,
  protectedPaths: string[],
): Promise<void> {
  for (const relativePath of uniqueSorted(protectedPaths)) {
    const absolutePath = path.resolve(workDir, relativePath);
    if (!isPathInside(workDir, absolutePath) || absolutePath === path.resolve(workDir)) {
      throw new Error(`Protected cleanup path escapes the working directory: ${relativePath}.`);
    }
    const lexicalStat = await fsp.lstat(absolutePath).catch((error) => {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    });
    if (lexicalStat?.isSymbolicLink()) {
      throw new Error(`Protected cleanup path must not be a symlink or junction: ${relativePath}.`);
    }
    const target = resolvePathInsideRootSync(workDir, relativePath);
    if (!target.inside || !target.relativePath) {
      throw new Error(`Protected cleanup path escapes the working directory: ${relativePath}.`);
    }
    if (!lexicalStat) continue;
    if (lexicalStat.isDirectory()) await assertSafeDirectoryTree(workDir, target.absolutePath);
  }
}

function discardCleanupMessage(plan: DiscardCleanupPlan): string {
  if (!plan.dirtyPaths.length) return "Git: clean tree, no discard cleanup needed.";
  if (plan.scopedPaths.length > 0) {
    if (!plan.ownedDirtyPaths.length) {
      return `Git: no scoped experiment changes to revert; preserved ${plan.unownedDirtyPaths.length} unowned dirty path(s). cleanup=${plan.fingerprint.slice(0, 12)}.`;
    }
    return `Git: reverted scoped experiment paths (${plan.scopedPaths.join(", ")}); autoresearch files preserved. Preserved ${plan.unownedDirtyPaths.length} unowned dirty path(s). cleanup=${plan.fingerprint.slice(0, 12)}.`;
  }
  return "Git: reverted non-session changes; autoresearch files preserved.";
}

async function applyTrackedCleanup(workDir: string, receipt: LogTransactionReceipt): Promise<void> {
  if (receipt.cleanup.trackedPaths.length === 0) return;
  if (await trackedCleanupPostconditionSatisfied(workDir, receipt)) return;
  await assertCleanupGitIdentity(workDir, receipt);
  for (const target of receipt.cleanup.trackedTargets) {
    await assertCleanupGitIdentity(workDir, receipt);
    let state = await trackedTargetCleanupState(workDir, receipt.cleanup.headOid, target);
    if (state.indexClean && state.worktreeClean) continue;
    let current = await cleanupTargetIdentity(workDir, target.path);
    if (!state.indexClean && current.indexDigest !== target.indexDigest) {
      throw new Error(
        `The tracked cleanup index target ${target.path} changed after transaction preparation; refusing staged drift.`,
      );
    }
    if (!state.worktreeClean && current.digest !== target.digest) {
      throw new Error(
        `The tracked cleanup worktree target ${target.path} changed after transaction preparation; refusing cleanup drift.`,
      );
    }
    if (!state.indexClean) {
      await assertCleanupGitIdentity(workDir, receipt);
      await cleanupTrackedIndexPath(workDir, receipt.cleanup.headOid, target.path);
      state = await trackedTargetCleanupState(workDir, receipt.cleanup.headOid, target);
      if (!state.indexClean) {
        throw new Error(
          `Tracked index cleanup postcondition is not satisfied for ${target.path}; staged content changed.`,
        );
      }
    }
    if (!state.worktreeClean) {
      current = await cleanupTargetIdentity(workDir, target.path);
      if (current.digest !== target.digest) {
        throw new Error(
          `The tracked cleanup worktree target ${target.path} changed after index cleanup; refusing cleanup drift.`,
        );
      }
      await assertCleanupGitIdentity(workDir, receipt);
      await cleanupTrackedWorktreePath(workDir, receipt.cleanup.headOid, target);
      state = await trackedTargetCleanupState(workDir, receipt.cleanup.headOid, target);
    }
    if (!state.indexClean || !state.worktreeClean) {
      throw new Error(
        `Tracked cleanup postcondition is not satisfied for ${target.path}; index or worktree content changed.`,
      );
    }
  }
  await verifyTrackedCleanupPostcondition(workDir, receipt);
}

async function applyUntrackedCleanup(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  if (receipt.cleanup.untrackedPaths.length === 0) return;
  if (await untrackedCleanupPostconditionSatisfied(workDir, receipt)) return;
  await assertCleanupGitIdentity(workDir, receipt);
  for (const target of receipt.cleanup.untrackedTargets) {
    await assertCleanupGitIdentity(workDir, receipt);
    if (await untrackedTargetCleanupPostconditionSatisfied(workDir, target)) continue;
    await assertCleanupTargetPrepared(workDir, target, "untracked cleanup");
    await cleanupUntrackedPath(workDir, target.path);
    if (!(await untrackedTargetCleanupPostconditionSatisfied(workDir, target))) {
      throw new Error(
        `Untracked cleanup postcondition is not satisfied for ${target.path}; worktree content changed.`,
      );
    }
  }
  await verifyUntrackedCleanupPostcondition(workDir, receipt);
}

async function assertCleanupGitIdentity(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  await assertPreparedHeadState(workDir, receipt.preGit.headState);
  const currentHead = await gitHeadOrEmpty(workDir);
  if (currentHead !== receipt.cleanup.headOid) {
    throw new Error("Git HEAD changed after non-keep cleanup preparation; refusing cleanup drift.");
  }
}

async function assertCleanupTargetPrepared(
  workDir: string,
  expected: CleanupTargetIdentity,
  label: string,
): Promise<void> {
  const current = await cleanupTargetIdentity(workDir, expected.path);
  if (current.digest !== expected.digest || current.indexDigest !== expected.indexDigest) {
    throw new Error(
      `The ${label} target ${expected.path} changed after transaction preparation; refusing cleanup drift.`,
    );
  }
}

async function verifyTrackedCleanupPostcondition(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  if (!(await trackedCleanupPostconditionSatisfied(workDir, receipt))) {
    throw new Error("Tracked cleanup postcondition is not satisfied; worktree content changed.");
  }
}

async function trackedCleanupPostconditionSatisfied(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<boolean> {
  const paths = receipt.cleanup.trackedPaths;
  if (paths.length === 0) return true;
  await assertPreparedHeadState(workDir, receipt.preGit.headState);
  if ((await gitHeadOrEmpty(workDir)) !== receipt.cleanup.headOid) return false;
  for (const target of receipt.cleanup.trackedTargets) {
    const state = await trackedTargetCleanupState(workDir, receipt.cleanup.headOid, target);
    if (!state.indexClean || !state.worktreeClean) return false;
  }
  return true;
}

async function trackedTargetCleanupState(
  workDir: string,
  headOid: string,
  target: CleanupTargetIdentity,
): Promise<{ indexClean: boolean; worktreeClean: boolean }> {
  const relativePath = target.path;
  const [indexClean, worktreeClean] = await Promise.all([
    gitDiffClean(
      workDir,
      ["--literal-pathspecs", "diff", "--cached", "--quiet", headOid, "--", relativePath],
      `verify tracked index cleanup for ${relativePath}`,
    ),
    target.worktreeExpectedAbsent
      ? cleanupTargetPathAbsent(workDir, relativePath)
      : gitDiffClean(
          workDir,
          ["--literal-pathspecs", "diff", "--quiet", headOid, "--", relativePath],
          `verify tracked worktree cleanup for ${relativePath}`,
        ),
  ]);
  return { indexClean, worktreeClean };
}

async function gitDiffClean(workDir: string, args: string[], label: string): Promise<boolean> {
  const clean = await runGit(args, workDir);
  if (clean.code === 0 && !clean.stdoutTruncated && !clean.stderrTruncated) return true;
  if (clean.code === 1 && !clean.stdoutTruncated && !clean.stderrTruncated) return false;
  throw new Error(`Git could not ${label}: ${gitOutput(clean, "unknown error")}`);
}

function cleanupTargetWorktreeDigest(target: CleanupTargetIdentity): string {
  const {
    path: _path,
    digest: _digest,
    indexDigest: _indexDigest,
    worktreeExpectedAbsent: _worktreeExpectedAbsent,
    ...worktreeState
  } = target;
  return sha256Json(worktreeState);
}

async function cleanupTrackedIndexPath(
  workDir: string,
  headOid: string,
  relativePath: string,
): Promise<void> {
  if (!(await insideGitRepo(workDir))) return;
  const restore = await runGit(
    ["--literal-pathspecs", "restore", `--source=${headOid}`, "--staged", "--", relativePath],
    workDir,
  );
  if (restore.code !== 0) {
    throw new Error(`Git tracked index cleanup failed: ${gitOutput(restore, "unknown error")}`);
  }
}

async function verifyUntrackedCleanupPostcondition(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  if (!(await untrackedCleanupPostconditionSatisfied(workDir, receipt))) {
    throw new Error("Untracked cleanup postcondition is not satisfied; worktree content changed.");
  }
}

async function untrackedCleanupPostconditionSatisfied(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<boolean> {
  if (receipt.cleanup.untrackedTargets.length === 0) return true;
  await assertPreparedHeadState(workDir, receipt.preGit.headState);
  if ((await gitHeadOrEmpty(workDir)) !== receipt.cleanup.headOid) return false;
  for (const target of receipt.cleanup.untrackedTargets) {
    if (!(await untrackedTargetCleanupPostconditionSatisfied(workDir, target))) return false;
  }
  return true;
}

async function untrackedTargetCleanupPostconditionSatisfied(
  workDir: string,
  expected: CleanupTargetIdentity,
): Promise<boolean> {
  const current = await cleanupTargetIdentity(workDir, expected.path);
  return current.kind === "absent" && current.indexDigest === expected.indexDigest;
}

async function cleanupTargetIdentities(
  workDir: string,
  paths: string[],
  worktreeHeadOid?: string,
): Promise<CleanupTargetIdentity[]> {
  const identities = await Promise.all(
    uniqueSorted(paths).map((relativePath) =>
      cleanupTargetIdentity(workDir, relativePath, worktreeHeadOid),
    ),
  );
  return identities.sort((left, right) => left.path.localeCompare(right.path));
}

async function cleanupTargetIdentity(
  workDir: string,
  relativePath: string,
  worktreeHeadOid?: string,
): Promise<CleanupTargetIdentity> {
  const target = resolvePathInsideRootSync(workDir, relativePath);
  if (!target.inside || !target.relativePath) {
    throw new Error(`Cleanup target escapes the working directory: ${relativePath}.`);
  }
  const worktreePostcondition =
    worktreeHeadOid === undefined
      ? {}
      : {
          worktreeExpectedAbsent: await cleanupTargetExpectedAbsent(
            workDir,
            worktreeHeadOid,
            target.relativePath,
          ),
        };
  const indexDigest = await cleanupTargetIndexDigest(workDir, target.relativePath);
  const stat = await fsp.lstat(target.absolutePath).catch((error) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (!stat) {
    const state = { kind: "absent" as const, mode: 0, size: 0 };
    return {
      path: target.relativePath,
      ...state,
      ...worktreePostcondition,
      indexDigest,
      digest: sha256Json(state),
    };
  }
  if (stat.isSymbolicLink()) {
    const link = await fsp.readlink(target.absolutePath);
    const state = {
      kind: "symlink" as const,
      mode: stat.mode & 0o777,
      size: Buffer.byteLength(link),
      link,
    };
    return {
      path: target.relativePath,
      ...state,
      ...worktreePostcondition,
      indexDigest,
      digest: sha256Json(state),
    };
  }
  if (stat.isFile()) {
    const bytes = await fsp.readFile(target.absolutePath);
    const state = {
      kind: "file" as const,
      mode: stat.mode & 0o777,
      size: bytes.length,
      contentDigest: createHash("sha256").update(bytes).digest("hex"),
    };
    return {
      path: target.relativePath,
      ...state,
      ...worktreePostcondition,
      indexDigest,
      digest: sha256Json(state),
    };
  }
  if (stat.isDirectory()) {
    const entries = await cleanupDirectoryEntries(target.absolutePath);
    const state = {
      kind: "directory" as const,
      mode: stat.mode & 0o777,
      size: entries.reduce((total, entry) => total + entry.size, 0),
      entries,
    };
    return {
      path: target.relativePath,
      ...state,
      ...worktreePostcondition,
      indexDigest,
      digest: sha256Json(state),
    };
  }
  const state = {
    kind: "other" as const,
    mode: stat.mode & 0o777,
    size: stat.size,
  };
  return {
    path: target.relativePath,
    ...state,
    ...worktreePostcondition,
    indexDigest,
    digest: sha256Json(state),
  };
}

async function cleanupTargetExpectedAbsent(
  workDir: string,
  headOid: string,
  relativePath: string,
): Promise<boolean> {
  if (!headOid) return true;
  const entry = await runGit(
    ["--literal-pathspecs", "ls-tree", "-z", headOid, "--", relativePath],
    workDir,
  );
  if (entry.code !== 0 || entry.stdoutTruncated) {
    throw new Error(
      `Git could not bind tracked cleanup postcondition for ${relativePath}: ${gitOutput(entry, "unknown error")}`,
    );
  }
  return entry.stdout.length === 0;
}

async function cleanupTargetPathAbsent(workDir: string, relativePath: string): Promise<boolean> {
  const target = resolvePathInsideRootSync(workDir, relativePath);
  if (!target.inside || !target.relativePath) {
    throw new Error(`Cleanup target escapes the working directory: ${relativePath}.`);
  }
  return !(await fsp.lstat(target.absolutePath).catch((error) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }));
}

async function cleanupTargetIndexDigest(workDir: string, relativePath: string): Promise<string> {
  const staged = await runGit(
    ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", relativePath],
    workDir,
  );
  if (staged.code !== 0 || staged.stdoutTruncated) {
    throw new Error(
      `Git could not capture cleanup index state for ${relativePath}: ${gitOutput(staged, "unknown error")}`,
    );
  }
  return sha256Text(staged.stdout);
}

async function cleanupDirectoryEntries(
  root: string,
): Promise<Array<{ path: string; digest: string; kind: string; mode: number; size: number }>> {
  const entries: Array<{ path: string; digest: string; kind: string; mode: number; size: number }> =
    [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await fsp.readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entries.length >= 4_096) {
        throw new Error("Cleanup target tree exceeds the 4096-entry verification limit.");
      }
      const childPath = path.join(directory, child.name);
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const stat = await fsp.lstat(childPath);
      if (stat.isSymbolicLink()) {
        const link = await fsp.readlink(childPath);
        entries.push({
          path: relative,
          kind: "symlink",
          mode: stat.mode & 0o777,
          size: Buffer.byteLength(link),
          digest: sha256Text(link),
        });
      } else if (stat.isFile()) {
        const bytes = await fsp.readFile(childPath);
        entries.push({
          path: relative,
          kind: "file",
          mode: stat.mode & 0o777,
          size: bytes.length,
          digest: createHash("sha256").update(bytes).digest("hex"),
        });
      } else if (stat.isDirectory()) {
        entries.push({
          path: relative,
          kind: "directory",
          mode: stat.mode & 0o777,
          size: 0,
          digest: "",
        });
        await visit(childPath, relative);
      } else {
        entries.push({
          path: relative,
          kind: "other",
          mode: stat.mode & 0o777,
          size: stat.size,
          digest: "",
        });
      }
    }
  };
  await visit(root, "");
  return entries;
}

async function cleanupTrackedWorktreePath(
  workDir: string,
  headOid: string,
  target: CleanupTargetIdentity,
): Promise<void> {
  if (!(await insideGitRepo(workDir))) return;
  const relativePath = target.path;
  if (target.worktreeExpectedAbsent) {
    const resolved = resolvePathInsideRootSync(workDir, relativePath);
    if (!resolved.inside || !resolved.relativePath) {
      throw new Error(`Cleanup target escapes the working directory: ${relativePath}.`);
    }
    await fsp.rm(resolved.absolutePath, { recursive: true, force: true });
    return;
  }
  const restore = await runGit(
    ["--literal-pathspecs", "restore", `--source=${headOid}`, "--worktree", "--", relativePath],
    workDir,
  );
  if (restore.code !== 0) {
    throw new Error(`Git tracked worktree cleanup failed: ${gitOutput(restore, "unknown error")}`);
  }
}

async function cleanupUntrackedPath(workDir: string, relativePath: string): Promise<void> {
  if (!(await insideGitRepo(workDir))) return;
  const clean = await runGit(["--literal-pathspecs", "clean", "-fd", "--", relativePath], workDir);
  if (clean.code !== 0) {
    throw new Error(`Git untracked cleanup failed: ${gitOutput(clean, "unknown error")}`);
  }
}

function pathIsCoveredByScope(filePath: string, scopePath: string): boolean {
  const slash = (value: string) => value.replace(/\\/g, "/");
  const file = process.platform === "win32" ? slash(filePath) : filePath;
  const scope = slash(scopePath);
  return file === scope || file.startsWith(`${scope}/`);
}

function quote(value: string): string {
  return quoteShellArg(value, defaultCommandShell());
}

function manualRunPurpose(status: string, state: UnknownRecord): RunPurpose {
  if (status !== "measure") return "candidate";
  return Array.isArray(state.current) && state.current.some(isBaselineEligibleMetricRun)
    ? "diagnostic"
    : "baseline";
}

async function candidateOriginForLog(
  workDir: string,
  args: UnknownRecord,
  packetOrigin: CandidateOrigin,
): Promise<CandidateOrigin> {
  if (args.commit != null && String(args.commit).trim()) {
    return { kind: "commit", oid: await resolveCommitRef(workDir, args.commit) };
  }
  return packetOrigin;
}

async function assertCommitMatchesEvaluatedCandidate(
  workDir: string,
  oid: string,
  editablePaths: string[],
): Promise<void> {
  if (editablePaths.length === 0) return;
  const changed = await runGit(
    ["--literal-pathspecs", "diff", "--quiet", oid, "--", ...editablePaths],
    workDir,
  );
  if (changed.code === 1) {
    throw new Error(
      "An imported keep commit does not contain the evaluated candidate from the accepted-contract packet.",
    );
  }
  if (changed.code !== 0) {
    throw new Error(
      `Git could not compare the imported commit with the evaluated candidate: ${gitOutput(changed, "unknown error")}`,
    );
  }
  for (const ignored of [false, true]) {
    const untracked = await runGit(
      [
        "--literal-pathspecs",
        "ls-files",
        "--others",
        ...(ignored ? ["--ignored"] : []),
        "--exclude-standard",
        "-z",
        "--",
        ...editablePaths,
      ],
      workDir,
    );
    if (untracked.code !== 0 || untracked.stdoutTruncated) {
      throw new Error(
        `Git could not verify untracked evaluated candidate paths: ${gitOutput(untracked, "unknown error")}`,
      );
    }
    if (untracked.stdout.length > 0) {
      throw new Error(
        "An imported keep commit omits untracked editable candidate paths evaluated by the accepted-contract packet.",
      );
    }
  }
}

async function verifyEvidenceArtifacts({
  acceptedContract,
  artifacts,
  config,
  packetRun,
  workDir,
}: {
  acceptedContract: ExperimentContract | null;
  artifacts: UnknownRecord;
  config: UnknownRecord;
  packetRun: UnknownRecord;
  workDir: string;
}): Promise<VerifiedEvidenceArtifact[]> {
  if (Object.keys(artifacts).length === 0) return [];
  const progress = record(packetRun.progressSnapshot);
  const artifactRootValue = String(progress.artifactRoot || ".");
  const artifactRoot = resolvePathInsideRootSync(workDir, artifactRootValue);
  if (!artifactRoot.inside) {
    throw new Error("The approved artifact root escapes the working directory.");
  }
  const artifactRootStat = await fsp.lstat(artifactRoot.absolutePath).catch(() => null);
  if (!artifactRootStat?.isDirectory()) {
    throw new Error("The approved artifact root must be an existing directory.");
  }
  const editable =
    acceptedContract?.scope.editable ||
    normalizeRelativePaths(
      config.editableScope ?? config.filesInScope ?? config.commitPaths,
      "editableScope",
    );
  const protectedScope = [
    ...(acceptedContract?.scope.protected || protectedBenchmarkPathsFromConfig(config)),
    ".git",
    ...AUTORESEARCH_SESSION_FILES,
    ...AUTORESEARCH_OWNED_FILES,
    ...AUTORESEARCH_OWNED_DIRS,
  ];
  const verified: VerifiedEvidenceArtifact[] = [];
  for (const [name, rawPath] of Object.entries(artifacts)) {
    const artifactPath = String(rawPath || "");
    if (!artifactPath || artifactPath === "<outside-workdir>") {
      throw new Error(
        `Evidence artifact ${name} is outside the approved artifact root or quarantined.`,
      );
    }
    const worktreeTarget = resolvePathInsideRootSync(workDir, artifactPath);
    if (!worktreeTarget.inside || !worktreeTarget.relativePath) {
      throw new Error(`Evidence artifact ${name} is outside the working directory.`);
    }
    const rootTarget = resolvePathInsideRootSync(
      artifactRoot.absolutePath,
      worktreeTarget.absolutePath,
    );
    if (!rootTarget.inside) {
      throw new Error(`Evidence artifact ${name} is outside the approved artifact root.`);
    }
    if (
      editable.some((scopePath) => evidencePathOverlapsScope(workDir, worktreeTarget, scopePath))
    ) {
      throw new Error(`Evidence artifact ${name} overlaps editable scope.`);
    }
    if (
      protectedScope.some((scopePath) =>
        evidencePathOverlapsScope(workDir, worktreeTarget, scopePath),
      )
    ) {
      throw new Error(`Evidence artifact ${name} overlaps protected scope.`);
    }
    const fingerprint = await fingerprintEvidencePath(
      artifactRoot.absolutePath,
      worktreeTarget.absolutePath,
    );
    verified.push({
      name,
      path: worktreeTarget.relativePath,
      root: artifactRoot.relativePath || ".",
      digest: fingerprint.digest,
      kind: fingerprint.kind,
      size: fingerprint.size,
    });
  }
  return verified.sort((left, right) => left.name.localeCompare(right.name));
}

async function reverifyEvidenceArtifacts(
  workDir: string,
  artifacts: VerifiedEvidenceArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    const approvedRoot = resolvePathInsideRootSync(workDir, artifact.root);
    if (!approvedRoot.inside) {
      throw new Error(`Evidence artifact ${artifact.name} escaped its approved root.`);
    }
    const rootStat = await fsp.lstat(approvedRoot.absolutePath).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(
        `Evidence artifact ${artifact.name} approved root became a symlink or junction.`,
      );
    }
    const target = resolvePathInsideRootSync(
      approvedRoot.absolutePath,
      path.resolve(workDir, artifact.path),
    );
    if (!target.inside) {
      throw new Error(`Evidence artifact ${artifact.name} escaped its approved root.`);
    }
    const fingerprint = await fingerprintEvidencePath(
      approvedRoot.absolutePath,
      target.absolutePath,
    );
    if (
      fingerprint.digest !== artifact.digest ||
      fingerprint.kind !== artifact.kind ||
      fingerprint.size !== artifact.size
    ) {
      throw new Error(`Evidence artifact ${artifact.name} digest changed after preparation.`);
    }
  }
}

async function fingerprintEvidencePath(
  approvedRoot: string,
  target: string,
): Promise<{ digest: string; kind: "directory" | "file"; size: number }> {
  const entries: Array<{ path: string; digest: string; size: number; type: "directory" | "file" }> =
    [];
  let totalSize = 0;
  const visit = async (absolutePath: string, relativePath: string): Promise<void> => {
    if (entries.length >= 4_096) {
      throw new Error("Evidence artifact tree exceeds the 4096-entry verification limit.");
    }
    const containment = resolvePathInsideRootSync(approvedRoot, absolutePath);
    if (!containment.inside) {
      throw new Error("Evidence artifact contains a symlink or junction escape.");
    }
    const stat = await fsp.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error("Evidence artifact contains a symlink or junction.");
    }
    if (stat.isFile()) {
      const bytes = await fsp.readFile(absolutePath);
      totalSize += bytes.length;
      if (totalSize > 64 * 1024 * 1024) {
        throw new Error("Evidence artifact tree exceeds the 64 MiB verification limit.");
      }
      entries.push({
        path: relativePath,
        digest: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        type: "file",
      });
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error("Evidence artifacts must be regular files or directories.");
    }
    entries.push({ path: relativePath, digest: "", size: 0, type: "directory" });
    const children = await fsp.readdir(absolutePath, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      await visit(
        path.join(absolutePath, child.name),
        relativePath ? `${relativePath}/${child.name}` : child.name,
      );
    }
  };
  const rootStat = await fsp.lstat(target);
  await visit(target, "");
  return {
    digest: sha256Json(entries),
    kind: rootStat.isDirectory() ? "directory" : "file",
    size: totalSize,
  };
}

function pathsOverlap(left: string, right: string): boolean {
  return pathIsCoveredByScope(left, right) || pathIsCoveredByScope(right, left);
}

function evidencePathOverlapsScope(
  workDir: string,
  target: PathContainmentResult,
  scopePath: string,
): boolean {
  if (pathsOverlap(target.relativePath, scopePath)) return true;
  const scope = resolvePathInsideRootSync(workDir, scopePath);
  if (!scope.inside) return true;
  const canonicalTarget = path.relative(target.realRoot, target.realPath).replaceAll("\\", "/");
  const canonicalScope = path.relative(target.realRoot, scope.realPath).replaceAll("\\", "/");
  return pathsOverlap(canonicalTarget, canonicalScope);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(stableJsonValue(value)));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJsonValue(child)]),
  );
}

export async function deleteLastRunPacket(workDir: string): Promise<CleanupWarning[]> {
  return await clearFilesWithWarnings(await lastRunCandidatePaths(workDir), undefined, {
    workDir,
  });
}

function processLifecycleRecordsFromPacket(packet: UnknownRecord | null): UnknownRecord[] {
  const packetEvidence = record(packet?.packetEvidence);
  return rekeyProcessLifecycleRecords(
    packetEvidence.processLifecycle,
    String(packetEvidence.packetId || ""),
  );
}

function terminalReconciliationRecords(records: UnknownRecord[]): UnknownRecord[] {
  const latest = new Map<string, UnknownRecord>();
  for (const item of records) {
    const identity = record(item.identity);
    latest.set(`${String(identity.packetId || "")}\0${String(identity.processId || "")}`, item);
  }
  return [...latest.values()]
    .filter((item) => item.event === "termination-failed")
    .map((item) => {
      const identity = record(item.identity);
      return buildProcessLifecycleRecord({
        packetId: String(identity.packetId),
        processId: String(identity.processId),
        event: "terminated",
        termination: { proven: true, reason: "operator_verified_absent" },
      });
    });
}

function promotionStateForLoggedDecision({
  status,
  metric,
  metrics,
  packetPromotion,
}: {
  status: string;
  metric: number | null;
  metrics: UnknownRecord;
  packetPromotion: unknown;
}): UnknownRecord {
  const existingPromotion = record(packetPromotion);
  if (status === "keep") {
    if (existingPromotion.label) return existingPromotion;
    if (promotionGradeValue({ metrics }) === true) {
      return {
        label: "promotion_eligible",
        reasons: ["Logged keep carries explicit promotion-grade metadata."],
      };
    }
    return finiteMetric(metric) == null
      ? {
          label: "blocked",
          reasons: ["Kept decisions require a finite metric before promotion can be assessed."],
        }
      : {
          label: "exploratory",
          reasons: [
            "Logged keep is exploratory until repeat, holdout, breadth, or promotion-gate metadata is recorded.",
          ],
        };
  }
  if (status === "discard") {
    return {
      label: "invalidated",
      reasons: ["Logged as discard; metric evidence is retained but not promotable."],
    };
  }
  if (status === "measure") {
    return {
      label: "measurement",
      reasons: ["Logged as measure; metric evidence is trend-only and not finalizer evidence."],
    };
  }
  return {
    label: "blocked",
    reasons: [
      status === "checks_failed"
        ? "Correctness checks failed; packet evidence is blocked from promotion."
        : "Crash evidence is retained without sentinel metrics and is blocked from promotion.",
    ],
  };
}

function copyIfPresent(
  source: UnknownRecord,
  target: UnknownRecord,
  sourceKey: string,
  targetKey = sourceKey,
): void {
  if (source[sourceKey]) target[targetKey] = source[sourceKey];
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return value == null || value === "" ? undefined : String(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}
