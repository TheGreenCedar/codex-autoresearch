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
  completedContractNoiseRepeats,
  contractCandidateFingerprintForWorkDir,
  contractDerivationError,
  deriveExperimentContract,
  evaluateContractKeepEligibility,
  type ContractEvaluationEvidence,
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
import { parsePorcelainV1Z } from "../git-paths.js";
import { resolvePackageRoot } from "../runtime-paths.js";
import {
  FAILURE_STATUSES,
  STATUS_VALUES,
  appendJsonl,
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

const PENDING_LOG_TRANSACTION_CODE = "pending_log_transaction";
const PENDING_LOG_TRANSACTION_GIT_PATH = "autoresearch/pending-log-transaction.json";
const AUTORESEARCH_OWNED_FILES = [AUTORESEARCH_DASHBOARD_FILE];
const AUTORESEARCH_OWNED_DIRS = [
  AUTORESEARCH_RESEARCH_DIR,
  "target/autoresearch",
  ".autoresearch-cache",
];
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);

export async function logExperiment(args: UnknownRecord): Promise<UnknownRecord> {
  const { workDir, config } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  await assertNoPendingLogTransaction(workDir);
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
  let evidenceStatus =
    enumOption(
      args.evidence_status ?? args.evidenceStatus,
      EVIDENCE_STATUSES,
      defaultEvidenceStatusForRun({ status }),
      "--evidence-status",
    ) || defaultEvidenceStatusForRun({ status });

  const stateBefore = currentState(workDir);
  let contractEvaluationEvidence: ContractEvaluationEvidence | null = null;
  const acceptedContractExists = readJsonl(workDir).some(
    (entry) =>
      entry.type === "experiment-contract-accepted" &&
      Number(entry.segment) === stateBefore.segment,
  );
  if (lastPacket || (status === "keep" && acceptedContractExists)) {
    const authority = await deriveExperimentContract({
      workDir,
      config,
      packet: lastPacket,
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
    const completedRepeats =
      evaluatedMetric == null
        ? 0
        : completedContractNoiseRepeats(accepted, stateBefore.current, {
            candidateFingerprint,
            metric: evaluatedMetric,
          });
    const keepEligibility = evaluateContractKeepEligibility(accepted, {
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
  const mutation = await applyLogMutation({
    args,
    config,
    description,
    metric,
    metricName: stateBefore.config.metricName || "metric",
    metrics,
    nextRun: stateBefore.results.length + 1,
    status,
    workDir,
  });
  const experiment: UnknownRecord = {
    run: stateBefore.results.length + 1,
    commit: mutation.commit.slice(0, 12),
    metric,
    metrics,
    metricEligible: isMetricEligibleStatus(status) && finiteMetric(metric) != null,
    status,
    evidenceStatus,
    description,
    timestamp: Date.now(),
    segment: stateBefore.segment,
    confidence: null,
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
  if (Object.keys(artifacts).length > 0) {
    experiment.artifacts = artifacts;
    experiment.artifactEvidence = artifactEvidenceList(artifacts, workDir, evidenceStatus);
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
  appendLogEvidence(workDir, packetProcessLifecycle, experiment);
  let pendingLogReceiptWarning = "";
  if (mutation.pendingLogReceiptPath) {
    const cleanupWarning = await clearPendingLogTransactionWithWarning(
      mutation.pendingLogReceiptPath,
      undefined,
      { workDir },
    );
    if (cleanupWarning) {
      pendingLogReceiptWarning = cleanupWarning;
      logWarnings.push(cleanupWarning);
    }
  }
  const lastRunCleanupWarnings = lastPacket ? await deleteLastRunPacket(workDir) : [];
  logWarnings.push(...lastRunCleanupWarnings.map((warning) => warning.message));
  const stateAfter = currentState(workDir);
  const limit = iterationLimitInfo(stateAfter, config);
  try {
    await appendSessionRunNote(workDir, experiment, stateAfter, {
      gitMessage: [mutation.gitMessage, pendingLogReceiptWarning].filter(Boolean).join(" "),
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
    warningDetails: lastRunCleanupWarnings,
    lastRunCleared: Boolean(lastPacket) && lastRunCleanupWarnings.length === 0,
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

export interface LogMutationInput {
  args: UnknownRecord;
  config: UnknownRecord;
  description: string;
  metric: number | null;
  metricName: string;
  metrics: UnknownRecord;
  nextRun: number;
  status: string;
  workDir: string;
}

export interface LogMutationResult {
  commit: string;
  gitMessage: string;
  inGit: boolean;
  pendingLogReceiptPath: string | null;
  revertMessage: string;
}

export async function assertNoPendingLogTransaction(workDir: string): Promise<void> {
  const warnings = await pendingLogTransactionWarnings(workDir);
  if (warnings.length > 0) throw new Error(String(warnings[0].message));
}

export async function applyLogMutation({
  args,
  config,
  description,
  metric,
  metricName,
  metrics,
  nextRun,
  status,
  workDir,
}: LogMutationInput): Promise<LogMutationResult> {
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
    commit = (await resolveCommitRef(workDir, args.commit)).slice(0, 12);
  } else if (inGit && status !== "keep" && status !== "measure") {
    commit = await shortHead(workDir);
  }
  let gitMessage = inGit ? "Git: no commit created." : "Git: not a repo.";
  let revertMessage = "";
  let pendingLogReceiptPath: string | null = null;

  if (status === "keep" && inGit) {
    if (explicitCommit) {
      gitMessage = `Git: recorded existing commit ${commit}.`;
    } else {
      const resultData = { status, [metricName || "metric"]: metric, ...metrics };
      const commitPaths = normalizeRelativePaths(
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
      pendingLogReceiptPath = await writePendingLogTransaction(workDir, {
        run: nextRun,
        status,
        description,
        metric,
        mutation: "keep-commit",
        commitPaths,
        allowAddAll,
        explicitCommit: false,
      });
      const addResult =
        commitPaths.length > 0
          ? await runGit(["--literal-pathspecs", "add", "--", ...commitPaths], workDir)
          : await runGit(["add", "-A"], workDir);
      if (addResult.code !== 0) {
        if (gitIndexLockFailure(addResult)) {
          const lockPath = await gitPrivatePath(workDir, "index.lock");
          throw new Error(await gitIndexLockMessage(workDir, lockPath, "git add", true));
        }
        throw new Error(`Git add failed: ${gitOutput(addResult, "unknown error")}`);
      }
      const stagedChanges = commitPaths.length
        ? await hasStagedChangesInPaths(workDir, commitPaths)
        : await hasStagedChanges(workDir);
      if (stagedChanges) {
        const commitResult = await runGit(
          commitPaths.length
            ? [
                "--literal-pathspecs",
                "commit",
                "--only",
                "-m",
                description,
                "-m",
                `Result: ${JSON.stringify(resultData)}`,
                "--",
                ...commitPaths,
              ]
            : ["commit", "-m", description, "-m", `Result: ${JSON.stringify(resultData)}`],
          workDir,
        );
        if (commitResult.code !== 0) {
          throw new Error(`Git commit failed: ${gitOutput(commitResult, "unknown error")}`);
        }
        commit = await shortHead(workDir);
        gitMessage = allowAddAll
          ? `Git: committed ${commit} using explicit add-all.`
          : `Git: committed ${commit}.`;
      } else {
        gitMessage = "Git: nothing to commit.";
      }
    }
  } else if (status !== "keep" && status !== "measure") {
    const discardPlan = inGit ? await discardCleanupPlan(workDir, args, config) : null;
    if (discardPlan && discardCleanupWillMutate(discardPlan, args)) {
      pendingLogReceiptPath = await writePendingLogTransaction(workDir, {
        run: nextRun,
        status,
        description,
        metric,
        mutation: "discard-cleanup",
        revertPaths: discardPlan.scopedPaths,
        willRevert: discardPlan.willRevert.slice(0, 50),
        cleanupFingerprint: discardPlan.fingerprint,
        allowDirtyRevert: boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false),
      });
    }
    revertMessage = await cleanupDiscardChanges(workDir, args, config, discardPlan);
  }
  return { commit, gitMessage, inGit, pendingLogReceiptPath, revertMessage };
}

export function appendLogEvidence(
  workDir: string,
  processLifecycle: UnknownRecord[],
  experiment: UnknownRecord,
): void {
  for (const lifecycle of processLifecycle) appendJsonl(workDir, lifecycle);
  appendJsonl(workDir, experiment);
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

async function writePendingLogTransaction(
  workDir: string,
  receipt: UnknownRecord,
): Promise<string> {
  const stored = await writePrivateStateFile(
    workDir,
    pendingLogTransactionSpec(workDir),
    (stateTarget) =>
      `${JSON.stringify(
        {
          type: "autoresearch.log.pending",
          version: 1,
          createdAt: new Date().toISOString(),
          workDir,
          ledgerPath: resolveSessionPaths({ workDir }).ledgerPath,
          stateStorage: {
            storageMode: stateTarget.storageMode,
            path: stateTarget.path,
            warning: stateTarget.warning,
          },
          ...receipt,
        },
        null,
        2,
      )}\n`,
    { mode: 0o600 },
  );
  return stored.path;
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
        "A previous log mutation has a pending receipt and may not be recorded in autoresearch.jsonl; inspect the receipt before another packet.",
      action:
        "Compare the receipt with git status and autoresearch.jsonl, then remove the receipt after recovery.",
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
  unownedDirtyPaths: string[];
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
  const dirtyPaths = parsePorcelainV1Z(statusShort)
    .flatMap((entry) => entry.paths)
    .sort((left, right) => left.localeCompare(right));
  const ownedDirtyPaths = dirtyPaths.filter((dirtyPath) =>
    scopedPaths.some((scopedPath) => pathIsCoveredByScope(dirtyPath, scopedPath)),
  );
  const unownedDirtyPaths = dirtyPaths.filter((dirtyPath) => !ownedDirtyPaths.includes(dirtyPath));
  return {
    scopedPaths,
    dirtyPaths,
    ownedDirtyPaths,
    unownedDirtyPaths,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ scopedPaths, ownedDirtyPaths, unownedDirtyPaths, statusShort }))
      .digest("hex"),
    willRevert: scopedPaths.length > 0 ? ownedDirtyPaths : dirtyPaths,
  };
}

function discardCleanupWillMutate(plan: DiscardCleanupPlan, args: UnknownRecord): boolean {
  if (plan.scopedPaths.length > 0) return plan.ownedDirtyPaths.length > 0;
  return (
    plan.dirtyPaths.length > 0 &&
    boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false)
  );
}

async function cleanupDiscardChanges(
  workDir: string,
  args: UnknownRecord,
  config: UnknownRecord,
  precomputedPlan: DiscardCleanupPlan | null,
): Promise<string> {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const plan = precomputedPlan || (await discardCleanupPlan(workDir, args, config));
  if (plan.scopedPaths.length > 0) {
    if (!plan.ownedDirtyPaths.length) {
      return `Git: no scoped experiment changes to revert; preserved ${plan.unownedDirtyPaths.length} unowned dirty path(s). cleanup=${plan.fingerprint.slice(0, 12)}.`;
    }
    const message = await revertScopedPathsExceptSessionFiles(workDir, plan.scopedPaths);
    return `${message} Preserved ${plan.unownedDirtyPaths.length} unowned dirty path(s). cleanup=${plan.fingerprint.slice(0, 12)}.`;
  }
  if (!plan.dirtyPaths.length) return "Git: clean tree, no discard cleanup needed.";
  if (boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false)) {
    return await revertExceptSessionFiles(workDir);
  }
  throw new Error(
    "Refusing broad discard cleanup in a dirty Git tree without scoped revert paths. Configure commitPaths/revertPaths or pass --allow-dirty-revert.",
  );
}

async function revertExceptSessionFiles(workDir: string): Promise<string> {
  const saved = await preserveSessionFiles(workDir);
  const restore = await runGit(
    ["--literal-pathspecs", "restore", "--worktree", "--staged", "--", "."],
    workDir,
  );
  if (restore.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git restore failed during discard cleanup: ${gitOutput(restore, "unknown error")}`,
    );
  }
  const clean = await runGit(["clean", "-fd"], workDir);
  if (clean.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git clean failed during discard cleanup: ${gitOutput(clean, "unknown error")}`,
    );
  }
  await restoreSessionFiles(workDir, saved);
  return "Git: reverted non-session changes; autoresearch files preserved.";
}

async function revertScopedPathsExceptSessionFiles(
  workDir: string,
  paths: string[],
): Promise<string> {
  const safePaths = normalizeRelativePaths(paths, "revertPaths");
  if (!safePaths.length) throw new Error("No scoped paths were provided for discard cleanup.");
  const saved = await preserveSessionFiles(workDir);
  const restore = await runGit(
    ["--literal-pathspecs", "restore", "--worktree", "--staged", "--", ...safePaths],
    workDir,
  );
  if (restore.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git scoped restore failed during discard cleanup: ${gitOutput(restore, "unknown error")}`,
    );
  }
  const clean = await runGit(["--literal-pathspecs", "clean", "-fd", "--", ...safePaths], workDir);
  if (clean.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git scoped clean failed during discard cleanup: ${gitOutput(clean, "unknown error")}`,
    );
  }
  await restoreSessionFiles(workDir, saved);
  return `Git: reverted scoped experiment paths (${safePaths.join(", ")}); autoresearch files preserved.`;
}

type PreservedArtifact = { type: "file"; bytes: Buffer } | { type: "dir"; tempPath: string };

async function preserveSessionFiles(workDir: string): Promise<Map<string, PreservedArtifact>> {
  const saved = new Map<string, PreservedArtifact>();
  for (const file of [...AUTORESEARCH_SESSION_FILES, ...AUTORESEARCH_OWNED_FILES]) {
    const filePath = path.join(workDir, file);
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Session artifact must not be a symlink or junction: ${filePath}`);
    }
    if (stat.isFile()) saved.set(file, { type: "file", bytes: fs.readFileSync(filePath) });
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
