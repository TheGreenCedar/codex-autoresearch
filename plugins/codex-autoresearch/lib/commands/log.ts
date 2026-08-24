import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertSafeDirectoryTree,
  checkedAtomicWriteFile,
  checkedReplaceDirectory,
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
  type CandidateOrigin,
  type ContractEvaluationEvidence,
  type EvaluationAuthority,
  type ExperimentContract,
  type RunPurpose,
} from "../experiment-contract.js";
import { loopContinuation } from "./continuation.js";
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
  hasStagedChanges,
  hasStagedChangesInPaths,
  insideGitRepo,
  privateStateCandidatePaths,
  resolveCommitRef,
  resolvePrivateStateTarget,
  runGit,
  shortHead,
  writePrivateStateFile,
  PrivateStateConflictError,
  type PrivateStateSpec,
} from "../git-private-state.js";
import { normalizeRelativePaths } from "../literal-paths.js";
import {
  assertFreshLastRunPacket,
  lastRunCandidatePaths,
  readLastRunPacket,
} from "../last-run-store.js";
import { parseNulPathList, parsePorcelainV1Z } from "../git-paths.js";
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
import {
  AUTORESEARCH_DASHBOARD_FILE,
  AUTORESEARCH_RESEARCH_DIR,
  AUTORESEARCH_SESSION_FILES,
  resolveSessionPaths,
} from "../session-paths.js";
import type { UnknownRecord } from "../types/json.js";
import { resolvePathInsideRootSync, type PathContainmentResult } from "../path-containment.js";

const PENDING_LOG_TRANSACTION_CODE = "pending_log_transaction";
const PENDING_LOG_TRANSACTION_GIT_PATH = "autoresearch/pending-log-transaction.json";
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

export type LogTransactionFaultPoint = `${"before" | "after"}:${Exclude<
  LogTransactionStage,
  "prepared" | "done"
>}`;

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
      packetRun.executionAuthority === "accepted-contract" &&
      packetRun.experimentContractDigest === accepted.contractDigest &&
      packetCandidateFingerprint === candidateFingerprint &&
      evaluatedMetric != null &&
      metric === evaluatedMetric;
    runPurpose = normalizeRunPurpose(packetRun.runPurpose, stateBefore);
    evaluationAuthority = normalizeEvaluationAuthority(packetRun.executionAuthority);
    candidateOrigin = await candidateOriginForLog(workDir, args, packetRun);
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
    args,
    config,
    metric,
    metricName: stateBefore.config.metricName || "metric",
    metrics,
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
  };
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
    continuation: loopContinuation(workDir, stateAfter, config, "logged"),
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
  args: UnknownRecord;
  config: UnknownRecord;
  metric: number | null;
  metricName: string;
  metrics: UnknownRecord;
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
  args,
  config,
  metric,
  metricName,
  metrics,
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
      await assertNoGitIndexLock(workDir, "git add");
    }
  } else if (status !== "keep" && status !== "measure") {
    const discardPlan = inGit ? await discardCleanupPlan(workDir, args, config) : null;
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

function fallbackPendingLogTransactionPath(workDir: string): string {
  return resolveSessionPaths({ workDir }).pendingLogTransactionFallbackPath;
}

function pendingLogTransactionSpec(workDir: string): PrivateStateSpec {
  return {
    fallbackPath: fallbackPendingLogTransactionPath(workDir),
    gitRelativePath: PENDING_LOG_TRANSACTION_GIT_PATH,
    label: "pending log receipt",
  };
}

async function pendingLogTransactionCandidatePaths(
  workDir: string,
  _inGit?: boolean,
): Promise<string[]> {
  return await privateStateCandidatePaths(workDir, pendingLogTransactionSpec(workDir));
}

interface VerifiedEvidenceArtifact extends UnknownRecord {
  digest: string;
  kind: "directory" | "file";
  name: string;
  path: string;
  root: string;
  size: number;
}

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
    indexTree: string;
    statusDigest: string;
  };
  status: "pending" | "failed" | "done";
  completedStages: LogTransactionStage[];
  commitExpectation: {
    digest: string;
    mode: "create" | "existing" | "none";
    oid: string;
    parentOid: string;
    treeOid: string;
    message: string;
    messageDigest: string;
    paths: string[];
    allowAddAll: boolean;
  };
  ledgerEvent: { transactionId: string; eventDigest: string };
  cleanup: {
    digest: string;
    broad: boolean;
    scopedPaths: string[];
    trackedPaths: string[];
    untrackedPaths: string[];
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
  let storedReceipt = receipt;
  const stored = await writePrivateStateFile(
    workDir,
    pendingLogTransactionSpec(workDir),
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
  const target = await resolvePrivateStateTarget(workDir, pendingLogTransactionSpec(workDir));
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
    !receipt.evidence?.experiment ||
    !Array.isArray(receipt.evidence.processLifecycle) ||
    !Array.isArray(receipt.evidence.artifacts) ||
    !receipt.packet ||
    !receipt.contract ||
    !receipt.preGit ||
    !receipt.commitExpectation ||
    !receipt.ledgerEvent ||
    !receipt.cleanup ||
    !Array.isArray(receipt.cleanup.scopedPaths) ||
    !Array.isArray(receipt.cleanup.trackedPaths) ||
    !Array.isArray(receipt.cleanup.untrackedPaths) ||
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
    !receipt.commitExpectation.oid &&
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
  await executeLogTransactionStages(workDir, receipt, options);
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
  await verifyPendingKeepCandidate(workDir, config, receipt);
  await executeLogTransactionStages(workDir, receipt, options);
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
    continuation: loopContinuation(workDir, stateAfter, config, "logged"),
  };
}

async function verifyPendingKeepCandidate(
  workDir: string,
  config: UnknownRecord,
  receipt: LogTransactionReceipt,
): Promise<void> {
  if (
    receipt.transaction.kind !== "keep" ||
    receipt.completedStages.includes("commit-applied-or-verified")
  ) {
    return;
  }
  const contractEvidence = record(receipt.evidence.experiment.contractEvaluationEvidence);
  const packet = await readLastRunPacket(workDir);
  const authority = await deriveExperimentContract({
    workDir,
    config,
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
    accepted = acceptedExperimentContractForEvidenceValidation(workDir);
  }
  if (
    !accepted ||
    accepted.contractDigest !== receipt.contract.digest ||
    contractEvidence.contractDigest !== accepted.contractDigest ||
    typeof contractEvidence.candidateFingerprint !== "string"
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
    await verifyRecordedCommit(workDir, receipt);
    return true;
  }
  const currentHead = await requiredGitText(workDir, ["rev-parse", "HEAD"], "read pending HEAD");
  return await commitMatchesInterruptedCreation(workDir, currentHead, expectation);
}

async function buildLogTransactionReceipt({
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
    commitExpectation: {
      digest: "",
      mode:
        experiment.status === "keep" && mutationPlan.inGit
          ? mutationPlan.explicitCommit
            ? "existing"
            : "create"
          : "none",
      oid: mutationPlan.commit,
      parentOid: "",
      treeOid: "",
      message: commitMessage,
      messageDigest: sha256Text(commitMessage),
      paths: mutationPlan.commitPaths,
      allowAddAll: mutationPlan.allowAddAll,
    },
    ledgerEvent: { transactionId, eventDigest: "" },
    cleanup: {
      digest: "",
      ...mutationPlan.cleanup,
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
  receipt: LogTransactionReceipt,
  options: LogExperimentOptions,
): Promise<void> {
  if (receipt.status === "done") {
    await clearPendingLogTransaction(receipt.stateStorage.path);
    return;
  }
  if (receipt.transaction.kind === "keep") {
    await runLogTransactionStage(
      workDir,
      receipt,
      "commit-applied-or-verified",
      options,
      () => applyOrVerifyKeepCommit(workDir, receipt),
      () => verifyRecordedCommit(workDir, receipt),
    );
  }
  await runLogTransactionStage(
    workDir,
    receipt,
    "ledger-event-present",
    options,
    () => ensureLedgerEvent(workDir, receipt),
    () => verifyLedgerEvent(workDir, receipt),
  );
  if (receipt.transaction.kind === "non-keep") {
    const cleanupErrors: unknown[] = [];
    try {
      await runLogTransactionStage(workDir, receipt, "tracked-cleanup-complete", options, () =>
        cleanupTrackedChanges(workDir, receipt.cleanup, receipt.evidence.artifacts),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await runLogTransactionStage(workDir, receipt, "untracked-cleanup-complete", options, () =>
        cleanupUntrackedChanges(workDir, receipt.cleanup, receipt.evidence.artifacts),
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
  await runLogTransactionStage(workDir, receipt, "packet-cleanup-complete", options, () =>
    cleanupPacketPaths(receipt.cleanup.packetPaths),
  );
  completeLogTransactionStage(receipt, "done");
  receipt.status = "done";
  await writeLogTransactionReceipt(workDir, receipt);
  await clearPendingLogTransaction(receipt.stateStorage.path);
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

async function applyOrVerifyKeepCommit(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  const expectation = receipt.commitExpectation;
  if (expectation.mode === "none") return;
  if (expectation.mode === "existing" || expectation.oid) {
    await verifyRecordedCommit(workDir, receipt);
    receipt.evidence.experiment.commit = expectation.oid.slice(0, 12);
    receipt.result.commit = expectation.oid;
    refreshLedgerEventIdentity(receipt);
    return;
  }
  const currentHead = await requiredGitText(workDir, ["rev-parse", "HEAD"], "read HEAD");
  if (currentHead !== expectation.parentOid) {
    if (await commitMatchesInterruptedCreation(workDir, currentHead, expectation)) {
      expectation.oid = currentHead;
      expectation.treeOid = await requiredGitText(
        workDir,
        ["show", "-s", "--format=%T", currentHead],
        "read interrupted commit tree",
      );
      receipt.result.commit = currentHead;
      receipt.result.gitMessage = `Git: committed ${currentHead.slice(0, 12)}${
        expectation.allowAddAll ? " using explicit add-all" : ""
      }.`;
      receipt.evidence.experiment.commit = currentHead.slice(0, 12);
      refreshLedgerEventIdentity(receipt);
      await writeLogTransactionReceipt(workDir, receipt);
      return;
    }
    throw new Error("Git HEAD changed while the keep transaction was pending.");
  }
  const addResult =
    expectation.paths.length > 0
      ? await runGit(["--literal-pathspecs", "add", "--", ...expectation.paths], workDir)
      : await runGit(["add", "-A"], workDir);
  if (addResult.code !== 0) {
    if (gitIndexLockFailure(addResult)) {
      const lockPath = await gitPrivatePath(workDir, "index.lock");
      throw new Error(await gitIndexLockMessage(workDir, lockPath, "git add", true));
    }
    throw new Error(`Git add failed: ${gitOutput(addResult, "unknown error")}`);
  }
  const stagedChanges = expectation.paths.length
    ? await hasStagedChangesInPaths(workDir, expectation.paths)
    : await hasStagedChanges(workDir);
  if (!stagedChanges) {
    expectation.mode = "none";
    receipt.result.gitMessage = "Git: nothing to commit.";
    refreshLedgerEventIdentity(receipt);
    await writeLogTransactionReceipt(workDir, receipt);
    return;
  }
  await writeLogTransactionReceipt(workDir, receipt);
  const description = receipt.input.description;
  const resultBody = expectation.message.slice(expectation.message.indexOf("\n\n") + 2).trimEnd();
  const commitResult = await runGit(
    expectation.paths.length > 0
      ? [
          "--literal-pathspecs",
          "commit",
          "--only",
          "-m",
          description,
          "-m",
          resultBody,
          "--",
          ...expectation.paths,
        ]
      : ["commit", "-m", description, "-m", resultBody],
    workDir,
  );
  if (commitResult.code !== 0) {
    throw new Error(`Git commit failed: ${gitOutput(commitResult, "unknown error")}`);
  }
  expectation.oid = await requiredGitText(workDir, ["rev-parse", "HEAD"], "read committed HEAD");
  const metadata = await commitMetadata(workDir, expectation.oid);
  expectation.parentOid = metadata.parentOid;
  expectation.treeOid = metadata.treeOid;
  expectation.messageDigest = metadata.messageDigest;
  receipt.result.commit = expectation.oid;
  receipt.result.gitMessage = `Git: committed ${expectation.oid.slice(0, 12)}${
    expectation.allowAddAll ? " using explicit add-all" : ""
  }.`;
  receipt.evidence.experiment.commit = expectation.oid.slice(0, 12);
  refreshLedgerEventIdentity(receipt);
  await writeLogTransactionReceipt(workDir, receipt);
  await verifyRecordedCommit(workDir, receipt);
}

async function verifyRecordedCommit(
  workDir: string,
  receipt: LogTransactionReceipt,
): Promise<void> {
  const expectation = receipt.commitExpectation;
  if (expectation.mode === "none") return;
  if (!expectation.oid) throw new Error("Pending keep transaction has no recorded commit OID.");
  const head = await requiredGitText(workDir, ["rev-parse", "HEAD"], "verify committed HEAD");
  if (head !== expectation.oid) {
    throw new Error("Recorded keep commit is no longer the current Git HEAD.");
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

async function commitMatchesInterruptedCreation(
  workDir: string,
  oid: string,
  expectation: LogTransactionReceipt["commitExpectation"],
): Promise<boolean> {
  const metadata = await commitMetadata(workDir, oid).catch(() => null);
  if (
    !metadata ||
    metadata.parentOid !== expectation.parentOid ||
    metadata.messageDigest !== expectation.messageDigest
  ) {
    return false;
  }
  if (expectation.allowAddAll) return true;
  const changed = await runGit(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", oid],
    workDir,
  );
  if (changed.code !== 0 || changed.stdoutTruncated) return false;
  const changedPaths = changed.stdout ? parseNulPathList(changed.stdout) : [];
  return changedPaths.every((changedPath) =>
    expectation.paths.some((scopePath) => pathIsCoveredByScope(changedPath, scopePath)),
  );
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

async function ensureLedgerEvent(workDir: string, receipt: LogTransactionReceipt): Promise<void> {
  await reverifyEvidenceArtifacts(workDir, receipt.evidence.artifacts);
  refreshLedgerEventIdentity(receipt);
  await writeLogTransactionReceipt(workDir, receipt);
  const expected = ledgerRowsForReceipt(receipt);
  const existing = transactionLedgerRows(workDir, receipt.transaction.id);
  assertCompatibleTransactionRows(existing, receipt.ledgerEvent.eventDigest, expected);
  const existingIndexes = new Set(
    existing.map((row) => Number(record(row.logTransaction).entryIndex)),
  );
  appendJsonlEntries(
    workDir,
    expected.filter((row) => !existingIndexes.has(Number(record(row.logTransaction).entryIndex))),
  );
  await verifyLedgerEvent(workDir, receipt);
}

async function verifyLedgerEvent(workDir: string, receipt: LogTransactionReceipt): Promise<void> {
  const expected = ledgerRowsForReceipt(receipt);
  const existing = transactionLedgerRows(workDir, receipt.transaction.id);
  assertCompatibleTransactionRows(existing, receipt.ledgerEvent.eventDigest, expected);
  const indexes = new Set(existing.map((row) => Number(record(row.logTransaction).entryIndex)));
  if (indexes.size !== expected.length) {
    throw new Error("The pending transaction ledger event is incomplete.");
  }
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
  const { digest: _digest, ...expectation } = receipt.commitExpectation;
  return sha256Json({ expectation, result: receipt.result });
}

function cleanupPlanDigest(cleanup: LogTransactionReceipt["cleanup"]): string {
  const { digest: _digest, ...plan } = cleanup;
  return sha256Json(plan);
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

async function preGitDigests(
  workDir: string,
  inGit: boolean,
): Promise<LogTransactionReceipt["preGit"]> {
  if (!inGit) {
    const empty = { headOid: "", indexTree: "", statusDigest: sha256Text("") };
    return { ...empty, digest: sha256Json(empty) };
  }
  const snapshot = {
    headOid: await gitHeadOrEmpty(workDir),
    indexTree: await requiredGitText(workDir, ["write-tree"], "read pre-Git index tree"),
    statusDigest: sha256Text(await gitStatusShort(workDir)),
  };
  return { ...snapshot, digest: sha256Json(snapshot) };
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
    await resolvePrivateStateTarget(workDir, pendingLogTransactionSpec(workDir));
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
): Promise<DiscardCleanupPlan> {
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
  const dirtyPaths = statusEntries
    .flatMap((entry) => entry.paths)
    .sort((left, right) => left.localeCompare(right));
  const ownedDirtyPaths = dirtyPaths.filter((dirtyPath) =>
    scopedPaths.some((scopedPath) => pathIsCoveredByScope(dirtyPath, scopedPath)),
  );
  const unownedDirtyPaths = dirtyPaths.filter((dirtyPath) => !ownedDirtyPaths.includes(dirtyPath));
  const selectedEntries = statusEntries.filter((entry) =>
    (scopedPaths.length > 0 ? ownedDirtyPaths : dirtyPaths).some((dirtyPath) =>
      entry.paths.includes(dirtyPath),
    ),
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
    willRevert: scopedPaths.length > 0 ? ownedDirtyPaths : dirtyPaths,
  };
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

async function cleanupTrackedChanges(
  workDir: string,
  cleanup: LogMutationPlan["cleanup"],
  evidenceArtifacts: VerifiedEvidenceArtifact[],
): Promise<void> {
  if (!(await insideGitRepo(workDir))) return;
  const paths = cleanup.broad ? ["."] : cleanup.trackedPaths;
  if (paths.length === 0) return;
  await withPreservedSessionFiles(workDir, evidenceArtifacts, async () => {
    const restore = await runGit(
      ["--literal-pathspecs", "restore", "--worktree", "--staged", "--", ...paths],
      workDir,
    );
    if (restore.code !== 0) {
      throw new Error(`Git tracked cleanup failed: ${gitOutput(restore, "unknown error")}`);
    }
  });
}

async function cleanupUntrackedChanges(
  workDir: string,
  cleanup: LogMutationPlan["cleanup"],
  evidenceArtifacts: VerifiedEvidenceArtifact[],
): Promise<void> {
  if (!(await insideGitRepo(workDir))) return;
  const paths = cleanup.broad ? [] : cleanup.untrackedPaths;
  if (!cleanup.broad && paths.length === 0) return;
  await withPreservedSessionFiles(workDir, evidenceArtifacts, async () => {
    const clean = await runGit(
      cleanup.broad ? ["clean", "-fd"] : ["--literal-pathspecs", "clean", "-fd", "--", ...paths],
      workDir,
    );
    if (clean.code !== 0) {
      throw new Error(`Git untracked cleanup failed: ${gitOutput(clean, "unknown error")}`);
    }
  });
}

async function withPreservedSessionFiles(
  workDir: string,
  evidenceArtifacts: VerifiedEvidenceArtifact[],
  operation: () => Promise<void>,
): Promise<void> {
  const saved = await preserveSessionFiles(
    workDir,
    evidenceArtifacts.map((artifact) => artifact.path),
  );
  let operationError: unknown = null;
  try {
    await operation();
  } catch (error) {
    operationError = error;
  }
  let restoreError: unknown = null;
  try {
    await restoreSessionFiles(workDir, saved);
  } catch (error) {
    restoreError = error;
  }
  if (operationError && restoreError) {
    throw new AggregateError(
      [operationError, restoreError],
      "Git cleanup and Autoresearch session restoration both failed.",
    );
  }
  if (operationError) throw operationError;
  if (restoreError) throw restoreError;
}

type PreservedArtifact = { type: "file"; bytes: Buffer } | { type: "dir"; tempPath: string };

async function preserveSessionFiles(
  workDir: string,
  evidencePaths: string[] = [],
): Promise<Map<string, PreservedArtifact>> {
  const saved = new Map<string, PreservedArtifact>();
  for (const file of new Set([
    ...AUTORESEARCH_SESSION_FILES,
    ...AUTORESEARCH_OWNED_FILES,
    ...evidencePaths,
  ])) {
    const filePath = path.join(workDir, file);
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Session artifact must not be a symlink or junction: ${filePath}`);
    }
    if (stat.isFile()) {
      saved.set(file, { type: "file", bytes: fs.readFileSync(filePath) });
    } else if (stat.isDirectory()) {
      await assertSafeDirectoryTree(workDir, filePath);
      const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-preserve-"));
      fs.cpSync(filePath, tempPath, { recursive: true });
      saved.set(file, { type: "dir", tempPath });
    }
  }
  for (const dir of AUTORESEARCH_OWNED_DIRS) {
    const researchPath = path.join(workDir, dir);
    if (!fs.existsSync(researchPath)) continue;
    await assertSafeDirectoryTree(workDir, researchPath);
    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-preserve-"));
    fs.cpSync(researchPath, tempPath, { recursive: true });
    saved.set(dir, { type: "dir", tempPath });
  }
  return saved;
}

async function restoreSessionFiles(
  workDir: string,
  saved: Map<string, PreservedArtifact>,
): Promise<void> {
  for (const [file, artifact] of saved.entries()) {
    const filePath = path.join(workDir, file);
    if (artifact.type === "dir") {
      await checkedReplaceDirectory(workDir, filePath, artifact.tempPath);
      await fsp.rm(artifact.tempPath, { recursive: true, force: true });
    } else {
      await checkedAtomicWriteFile(workDir, filePath, artifact.bytes, { mode: 0o600 });
    }
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

function normalizeRunPurpose(value: unknown, state: UnknownRecord): RunPurpose {
  if (
    value === "baseline" ||
    value === "candidate" ||
    value === "holdout" ||
    value === "diagnostic"
  ) {
    return value;
  }
  return Array.isArray(state.current) && state.current.some(isBaselineEligibleMetricRun)
    ? "candidate"
    : "baseline";
}

function manualRunPurpose(status: string, state: UnknownRecord): RunPurpose {
  if (status !== "measure") return "candidate";
  return Array.isArray(state.current) && state.current.some(isBaselineEligibleMetricRun)
    ? "diagnostic"
    : "baseline";
}

function normalizeEvaluationAuthority(value: unknown): EvaluationAuthority {
  if (value === "accepted-contract" || value === "external") return value;
  return "manual";
}

async function candidateOriginForLog(
  workDir: string,
  args: UnknownRecord,
  packetRun: UnknownRecord,
): Promise<CandidateOrigin> {
  if (args.commit != null && String(args.commit).trim()) {
    return { kind: "commit", oid: await resolveCommitRef(workDir, args.commit) };
  }
  const packetOrigin = record(packetRun.candidateOrigin);
  if (packetOrigin.kind === "commit" && typeof packetOrigin.oid === "string") {
    return { kind: "commit", oid: packetOrigin.oid };
  }
  if (packetOrigin.kind === "none") return { kind: "none" };
  return { kind: "working-tree" };
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
  const untracked = await runGit(
    [
      "--literal-pathspecs",
      "ls-files",
      "--others",
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
