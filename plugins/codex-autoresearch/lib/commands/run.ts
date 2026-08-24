import path from "node:path";

import {
  createActiveProgressWriter,
  readActiveProgressSnapshot,
} from "../active-progress-store.js";
import { benchmarkContractSnapshot } from "../benchmark/contract-snapshot.js";
import { COMMAND_EXECUTION_BOUNDARY } from "../command-execution-boundary.js";
import { numberOption } from "../cli/args.js";
import { resolveAuthorizedWorkDir } from "../cli/workdir-context.js";
import {
  acceptedExperimentContractForMutation,
  completedContractNoiseRepeats,
  contractCandidateFingerprintForWorkDir,
  contractStopStatus,
  evaluateContractKeepEligibility,
  executionCommandText,
  materializeExecutionEnvironment,
  type CandidateOrigin,
  type ExecutionSpec,
} from "../experiment-contract.js";
import {
  currentState,
  finiteMetric,
  isBaselineEligibleMetricRun,
  isBetter,
  iterationLimitInfo,
  readJsonl,
} from "../session-core.js";
import {
  buildActiveRunPacketId,
  assertRunResourcePreflight,
  buildProcessLifecycleRecord,
} from "../process-governor.js";
import { protectedBenchmarkGuardForWorkDir } from "../benchmark/contract-guards.js";
import { fixedControlBlockForCommand, fixedControlRerunError } from "../fixed-control.js";
import { resolvePathInsideRootSync } from "../path-containment.js";
import { redactPathDisplay } from "../evidence-redaction.js";
import {
  createProgressSnapshot,
  finishProgressSnapshot,
  staleProgressReason,
  updateProgressSnapshot,
} from "../runner-progress.js";
import {
  metricParseSource,
  parseMetricLines,
  runExecutableCommand,
  tailText,
  type ShellRunOptions,
  type ShellRunResult,
} from "../runner.js";
import { commandDiagnostics } from "../truth-signals.js";
import type { UnknownRecord } from "../types/json.js";
import { runWithRequiredCleanup } from "../required-cleanup.js";

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;
type ProgressStageResult = {
  durationSeconds: number;
  exitCode: number | null;
  label: string;
  outputTail: string;
  stage: string;
  status: string;
  termination?: unknown;
  terminationFailed?: boolean;
  timedOut: boolean;
};

export async function runExperiment(args: UnknownRecord) {
  const { workDir } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  const progressWriter = await createActiveProgressWriter(workDir);
  return await runWithRequiredCleanup(
    () => runExperimentWithProgressWriter(args, progressWriter),
    () => progressWriter.close(),
    "Failed to close active progress writer",
  );
}

async function runExperimentWithProgressWriter(
  args: UnknownRecord,
  progressWriter: Awaited<ReturnType<typeof createActiveProgressWriter>>,
) {
  const { workDir, config } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  const state = currentState(workDir);
  const limit = iterationLimitInfo(state, config);
  const contractAuthority = await acceptedExperimentContractForMutation({
    workDir,
    args,
    config,
  });
  const experimentContract = contractAuthority.contract;
  const stopPolicyStatus = contractStopStatus(experimentContract, {
    acceptedAt: contractAuthority.event.timestamp,
    currentRuns: state.current,
  });
  if (stopPolicyStatus.status === "exhausted") {
    throw new Error(stopPolicyStatus.message);
  }
  const contractCandidateFingerprint = await contractCandidateFingerprintForWorkDir(
    workDir,
    experimentContract,
  );
  const protectedBenchmarkGuard = await protectedBenchmarkGuardForWorkDir(workDir, config, state);
  const evaluatorExecution = experimentContract.evaluator.execution;
  const command = executionCommandText(evaluatorExecution.command);
  const commandInput = {
    command,
    commandFile: "",
    env: undefined,
    envFile: "",
    envKeys: evaluatorExecution.environment.declared.map((item) => item.name),
    explicitEnvKeys: evaluatorExecution.environment.declared.map((item) => item.name),
    packetEnvMode: evaluatorExecution.environment.inheritance,
    separatorCommand: evaluatorExecution.command.kind === "argv",
  };
  const fixedControlBlock = fixedControlBlockForCommand(command, config, args);
  if (fixedControlBlock) throw fixedControlRerunError(fixedControlBlock);
  const timeoutSeconds = evaluatorExecution.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
  const retainedProcessProgress = await readActiveProgressSnapshot(workDir, config);
  const resourcePreflight = assertRunResourcePreflight({
    command,
    config,
    entries: [
      ...readJsonl(workDir),
      ...(retainedProcessProgress
        ? [{ packetEvidence: { progressSnapshot: retainedProcessProgress } }]
        : []),
    ],
  });
  const packetId = buildActiveRunPacketId(state.results.length + 1);
  let progressSnapshot = createProgressSnapshot({
    packetId,
    command,
    startedAt: new Date().toISOString(),
    timeoutSeconds,
    artifactRoot: ".",
  });
  progressSnapshot = progressWriter.queue(progressSnapshot);
  await progressWriter.flush();
  const updateProgress = ({ observedAt, output }: { observedAt: string; output: string }) => {
    progressSnapshot = updateProgressSnapshot(progressSnapshot, { output, observedAt });
    progressSnapshot = {
      ...progressSnapshot,
      staleProgressReason: staleProgressReason(progressSnapshot, {
        now: observedAt,
        staleAfterSeconds: numberOption(
          config.staleProgressSeconds ?? config.progressStaleSeconds,
          300,
        ),
      }),
    };
    progressSnapshot = progressWriter.queue(progressSnapshot);
  };
  const runPacketStage = async (
    execution: ExecutionSpec,
    stageTimeoutSeconds: number,
    options: ShellRunOptions,
    timeoutPhase: "benchmark" | "checks",
  ) => {
    try {
      const env = await materializeExecutionEnvironment(workDir, execution.environment);
      return await runExecutableCommand(
        execution.command,
        path.resolve(workDir, execution.relativeWorkingDirectory),
        stageTimeoutSeconds,
        { ...options, env, envMode: execution.environment.inheritance },
      );
    } catch (error) {
      progressSnapshot = finishProgressSnapshot(progressSnapshot, {
        exitCode: null,
        timedOut: true,
        terminationFailed: true,
        termination: {
          attempted: false,
          escalated: false,
          method: "none",
          pid: null,
          platform: process.platform,
          proven: false,
          reason: "runner_rejected_before_outcome",
          remainingPids: [],
          trackedPids: [],
        },
        timeoutPhase,
        completedAt: new Date().toISOString(),
      });
      progressSnapshot = progressWriter.queue(progressSnapshot);
      await progressWriter.flush();
      throw error;
    }
  };
  const benchmark = await runPacketStage(
    evaluatorExecution,
    timeoutSeconds,
    {
      env: commandInput.env,
      envMode: commandInput.packetEnvMode,
      onProgress: updateProgress,
      retainMetricNames: [state.config.metricName],
    },
    "benchmark",
  );
  const benchmarkPassed = benchmark.exitCode === 0 && !benchmark.timedOut;
  const parseSource = metricParseSource(benchmark);
  const parsedMetricResult = parseMetricLines(parseSource, {
    primaryMetricName: state.config.metricName,
    maxMetrics: evaluatorExecution.runner.metricLimit,
    withTruncation: true,
  });
  const { artifacts, artifactWarnings } = parseArtifactLines(
    benchmark.fullOutput || benchmark.output || parseSource,
    workDir,
  );
  const parsedMetrics = parsedMetricResult.metrics;
  const primary = parsedMetrics[state.config.metricName] ?? null;
  const primaryPresent = finiteMetric(primary) != null;
  const primaryMetric = finiteMetric(primary);
  const improvesPrimary =
    primaryMetric != null &&
    (state.best == null || isBetter(primaryMetric, state.best, state.config.bestDirection));
  const isBaseline = state.current.filter(isBaselineEligibleMetricRun).length === 0;
  const runPurpose = isBaseline ? "baseline" : "candidate";
  const candidateOrigin: CandidateOrigin = isBaseline ? { kind: "none" } : { kind: "working-tree" };
  const checkRuns: Array<{
    check: (typeof experimentContract.checks)[number];
    result: ShellRunResult;
  }> = [];
  const checksCommand = experimentContract.checks
    .map((check) => executionCommandText(check.execution.command))
    .join(" && ");
  const checksPolicy = "always";
  if (checksCommand && benchmarkPassed && primaryPresent) {
    for (const check of experimentContract.checks) {
      const result = await runPacketStage(
        check.execution,
        check.execution.timeoutSeconds || DEFAULT_CHECKS_TIMEOUT_SECONDS,
        {
          env: commandInput.env,
          envMode: commandInput.packetEnvMode,
          onProgress: updateProgress,
        },
        "checks",
      );
      checkRuns.push({ check, result });
      if (result.terminationFailed) break;
    }
  }
  const checks = aggregateCheckRuns(checkRuns);
  const checksPassed =
    benchmarkPassed && primaryPresent
      ? checkRuns.length === experimentContract.checks.length &&
        checkRuns.every(({ result }) => result.exitCode === 0 && !result.timedOut)
      : null;
  const terminationFailed = Boolean(
    benchmark.terminationFailed || checkRuns.some(({ result }) => result.terminationFailed),
  );
  const termination =
    checkRuns.find(({ result }) => result.terminationFailed || result.timedOut)?.result
      .termination ??
    checkRuns.at(-1)?.result.termination ??
    benchmark.termination;
  const metricError =
    benchmarkPassed && !primaryPresent
      ? `Benchmark completed but did not print primary metric METRIC ${state.config.metricName}=<number>.`
      : null;
  const checksPassedOrSkipped = checksPassed === null || checksPassed;
  const passed = benchmarkPassed && primaryPresent && checksPassedOrSkipped;
  const failedStatus = benchmarkPassed && primaryPresent ? "checks_failed" : "crash";
  const contractCheckOutcomes = checkRuns.map(({ check, result }) => ({
    id: check.id,
    executionDigest: check.execution.executionDigest,
    passed: result.exitCode === 0 && !result.timedOut && !result.terminationFailed,
  }));
  const completedNoiseRepeats =
    primaryMetric == null
      ? 0
      : completedContractNoiseRepeats(experimentContract, state.current, {
          candidateFingerprint: contractCandidateFingerprint,
          metric: primaryMetric,
        });
  const contractKeepEligibility = evaluateContractKeepEligibility(experimentContract, {
    purpose: runPurpose,
    evaluationAuthority: "accepted-contract",
    candidateOrigin,
    acceptedEvaluation: benchmarkPassed && primaryPresent,
    checkOutcomes: contractCheckOutcomes,
    completedRepeats: completedNoiseRepeats,
    metric: primaryMetric,
    referenceMetric: finiteMetric(state.best ?? state.baseline),
  });
  const allowedStatuses = passed
    ? contractKeepEligibility.eligible
      ? ["keep", "discard", "measure"]
      : ["discard", "measure"]
    : [failedStatus];
  const suggestedStatus = passed
    ? contractKeepEligibility.eligible
      ? "keep"
      : isBaseline
        ? "measure"
        : "discard"
    : failedStatus;
  const checksWereVerified = checksPassed === true;
  const safeSuggestedStatus = passed
    ? suggestedStatus === "keep" && !isBaseline && !checksWereVerified
      ? "discard"
      : suggestedStatus
    : failedStatus;
  const statusGuidance = passed
    ? safeSuggestedStatus === "keep"
      ? "Safe to consider keep because this is a checked improvement; still review ASI before logging."
      : safeSuggestedStatus === "measure"
        ? "Log this as measure because it is a baseline or diagnostic packet without a prior improvement comparison; use keep only when real improvement evidence exists."
        : `Keep is unavailable under the accepted contract: ${contractKeepEligibility.reasons.join(" ")} Log discard, or measure when retaining non-promotional evidence.`
    : `Only ${failedStatus} is allowed because the benchmark or checks failed.`;
  const progress = buildRunProgress({ benchmark, checks, checksCommand, passed });
  if (terminationFailed) {
    progressSnapshot = finishProgressSnapshot(progressSnapshot, {
      exitCode: null,
      timedOut: true,
      terminationFailed: true,
      termination,
      timeoutPhase: benchmark.terminationFailed ? "benchmark" : "checks",
      completedAt: checks?.finishedAt || benchmark.finishedAt,
      artifacts,
    });
    progressSnapshot = progressWriter.queue(progressSnapshot);
    await progressWriter.flush();
  } else {
    progressSnapshot = finishProgressSnapshot(progressSnapshot, {
      exitCode: checks?.exitCode ?? benchmark.exitCode,
      timedOut: benchmark.timedOut || Boolean(checks?.timedOut),
      termination,
      timeoutPhase: benchmark.timedOut ? "benchmark" : checks?.timedOut ? "checks" : "none",
      completedAt: checks?.finishedAt || benchmark.finishedAt,
      artifacts,
    });
    progressSnapshot = progressWriter.queue(progressSnapshot);
    await progressWriter.flush();
  }
  return {
    ok: passed,
    workDir,
    command,
    executionAuthority: "accepted-contract",
    runPurpose,
    evaluationAuthority: "accepted-contract",
    candidateOrigin,
    experimentContractDigest: experimentContract.contractDigest,
    contractCandidateFingerprint,
    contractKeepEligibility,
    stopPolicyStatus,
    acceptedEvaluator: experimentContract.evaluator,
    acceptedChecks: experimentContract.checks,
    commandExecutionBoundary: COMMAND_EXECUTION_BOUNDARY.mode,
    commandExecutionBoundaryNote: COMMAND_EXECUTION_BOUNDARY.note,
    timeoutSeconds,
    commandFile: commandInput.commandFile,
    envFile: commandInput.envFile,
    envKeys: commandInput.envKeys,
    explicitEnvKeys: commandInput.explicitEnvKeys,
    packetEnvMode: commandInput.packetEnvMode,
    commandDiagnostics: commandDiagnostics({
      command,
      commandFile: commandInput.commandFile,
      envFile: commandInput.envFile,
      separatorCommand: commandInput.separatorCommand,
      result: benchmark,
    }),
    startedAt: benchmark.startedAt,
    finishedAt: checks?.finishedAt || benchmark.finishedAt,
    lastOutputAt: checks?.lastOutputAt || benchmark.lastOutputAt,
    processLifecycle: processLifecycleRecordsForRun(packetId, benchmark, checkRuns),
    progressSnapshot,
    exitCode: benchmark.exitCode,
    timedOut: benchmark.timedOut || Boolean(checks?.timedOut),
    termination,
    terminationFailed,
    timeoutPhase: benchmark.timedOut ? "benchmark" : checks?.timedOut ? "checks" : "none",
    durationSeconds: benchmark.durationSeconds,
    parsedMetrics,
    artifacts,
    artifactWarnings,
    parsedPrimary: primary,
    metricError,
    checksPolicy,
    improvesPrimary,
    outputTruncated: Boolean(
      benchmark.outputTruncated ||
      benchmark.fullOutputTruncated ||
      benchmark.metricOutputTruncated ||
      checks?.outputTruncated ||
      checks?.fullOutputTruncated ||
      checks?.metricOutputTruncated,
    ),
    metricsTruncated: Boolean(parsedMetricResult.truncated || benchmark.metricOutputTruncated),
    metricName: state.config.metricName,
    metricUnit: state.config.metricUnit,
    progress,
    protectedBenchmarkGuard,
    resourcePreflight,
    checks: checks
      ? {
          command: checksCommand,
          exitCode: checks.exitCode,
          timedOut: checks.timedOut,
          termination: checks.termination,
          terminationFailed: checks.terminationFailed,
          durationSeconds: checks.durationSeconds,
          passed: checksPassed,
          tailOutput: tailText(checks.output, 80, 16000),
          runs: checkRuns.map(({ check, result }) => ({
            id: check.id,
            authority: check.authority,
            executionDigest: check.execution.executionDigest,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            terminationFailed: result.terminationFailed,
            durationSeconds: result.durationSeconds,
            passed: result.exitCode === 0 && !result.timedOut,
            tailOutput: tailText(result.output, 80, 16000),
          })),
        }
      : null,
    contractEvaluationEvidence:
      benchmarkPassed && primaryMetric != null && checksPassed === true
        ? {
            contractDigest: experimentContract.contractDigest,
            candidateFingerprint: contractCandidateFingerprint,
            acceptedEvaluation: true,
            metric: primaryMetric,
            checksPassed: true,
          }
        : null,
    tailOutput: tailText(benchmark.output),
    logHint: {
      metric: primary,
      metrics: Object.fromEntries(
        Object.entries(parsedMetrics).filter(
          ([key]: [string, unknown]) => key !== state.config.metricName,
        ),
      ),
      status: passed ? null : failedStatus,
      suggestedStatus,
      safeSuggestedStatus,
      statusGuidance,
      needsDecision: passed,
      allowedStatuses,
    },
    limit,
    benchmarkContract: await benchmarkContractSnapshot(workDir, {
      command,
      checksCommand,
      commandFile: commandInput.commandFile,
      envFile: commandInput.envFile,
      packetEnvMode: commandInput.packetEnvMode,
    }),
  };
}

function processLifecycleRecordsForRun(
  packetId: string,
  benchmark: ShellRunResult,
  checks: Array<{ check: { id: string }; result: ShellRunResult }>,
) {
  return [
    ...processLifecycleRecordsForStage(packetId, "benchmark", benchmark),
    ...checks.flatMap(({ check, result }, index) =>
      processLifecycleRecordsForStage(
        packetId,
        checks.length === 1 ? "checks" : `checks:${check.id || index + 1}`,
        result,
      ),
    ),
  ];
}

function aggregateCheckRuns(runs: Array<{ result: ShellRunResult }>): ShellRunResult | null {
  if (runs.length === 0) return null;
  const results = runs.map(({ result }) => result);
  const first = results[0];
  const last = results.at(-1) ?? first;
  const combinedOutput = results
    .map((result) => result.output)
    .filter(Boolean)
    .join("\n");
  const combinedFullOutput = results
    .map((result) => result.fullOutput)
    .filter(Boolean)
    .join("\n");
  const failed = results.find((result) => result.exitCode !== 0 || result.timedOut);
  return {
    command: results.map((result) => result.command).join(" && "),
    durationSeconds: results.reduce((total, result) => total + result.durationSeconds, 0),
    exitCode: failed?.exitCode ?? last.exitCode,
    finishedAt: last.finishedAt,
    fullOutput: combinedFullOutput,
    fullOutputTruncated: results.some((result) => result.fullOutputTruncated),
    lastOutputAt:
      [...results].reverse().find((result) => result.lastOutputAt)?.lastOutputAt ?? null,
    metricOutput: results
      .map((result) => result.metricOutput)
      .filter(Boolean)
      .join("\n"),
    metricOutputTruncated: results.some((result) => result.metricOutputTruncated),
    output: combinedOutput,
    outputTruncated: results.some((result) => result.outputTruncated),
    parsedMetrics: Object.assign(
      Object.create(null),
      ...results.map((result) => result.parsedMetrics),
    ),
    retainedMetricOutput: results
      .map((result) => result.retainedMetricOutput)
      .filter(Boolean)
      .join("\n"),
    startedAt: first.startedAt,
    termination:
      results.find((result) => result.terminationFailed || result.timedOut)?.termination ??
      last.termination,
    terminationFailed: results.some((result) => result.terminationFailed),
    timedOut: results.some((result) => result.timedOut),
  };
}

function processLifecycleRecordsForStage(
  packetId: string,
  processId: string,
  result: ShellRunResult,
) {
  const records = [
    buildProcessLifecycleRecord({
      packetId,
      processId,
      event: "started",
      at: String(result.startedAt),
    }),
  ];
  if (result.lastOutputAt) {
    records.push(
      buildProcessLifecycleRecord({
        packetId,
        processId,
        event: "observed-live",
        at: String(result.lastOutputAt),
      }),
    );
  }
  records.push(
    buildProcessLifecycleRecord({
      packetId,
      processId,
      event: result.terminationFailed ? "termination-failed" : "terminated",
      at: String(result.finishedAt),
      ...(result.termination ? { termination: result.termination } : {}),
    }),
  );
  return records;
}

export function buildRunProgress({
  benchmark,
  checks,
  checksCommand,
  passed,
}: {
  benchmark: ShellRunResult;
  checks: ShellRunResult | null;
  checksCommand: string | null;
  passed: boolean;
}) {
  const stages: ProgressStageResult[] = [
    progressStage("benchmark", "Run benchmark command", benchmark),
  ];
  if (checksCommand) {
    stages.push(
      checks
        ? progressStage("checks", "Run correctness checks", checks)
        : {
            stage: "checks",
            label: "Run correctness checks",
            status: "skipped",
            durationSeconds: 0,
            exitCode: null,
            timedOut: false,
            outputTail: "",
          },
    );
  }
  const timedOut = stages.some((stage) => stage.timedOut);
  const terminationFailed = stages.some((stage) => stage.terminationFailed);
  return {
    mode: "synchronous",
    status: terminationFailed
      ? "termination_failed"
      : timedOut
        ? "timed_out"
        : passed
          ? "completed"
          : "failed",
    cancellable: false,
    cancelStatus: terminationFailed
      ? "termination-failed"
      : timedOut
        ? "timeout-terminated"
        : "not_requested",
    elapsedSeconds: Number(
      stages.reduce((total, stage) => total + Number(stage.durationSeconds || 0), 0).toFixed(3),
    ),
    stages,
    latestOutputTail: [...stages].reverse().find((stage) => stage.outputTail)?.outputTail || "",
  };
}

function progressStage(stage: string, label: string, result: ShellRunResult): ProgressStageResult {
  return {
    stage,
    label,
    status: result.terminationFailed
      ? "termination_failed"
      : result.timedOut
        ? "timed_out"
        : result.exitCode === 0
          ? "completed"
          : "failed",
    durationSeconds: Number(result.durationSeconds || 0),
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    termination: result.termination || null,
    terminationFailed: Boolean(result.terminationFailed),
    outputTail: tailText(result.output || ""),
  };
}

function parseArtifactLines(output: string, workDir: string) {
  const artifacts: Record<string, string> = {};
  const artifactWarnings: string[] = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^ARTIFACT\s+([A-Za-z_][A-Za-z0-9_.:-]*)=(.+)$/);
    if (!match) continue;
    const name = match[1];
    const value = match[2].trim();
    if (!value) continue;
    const resolved = resolvePathInsideRootSync(workDir, value);
    if (resolved.inside && resolved.relativePath) {
      artifacts[name] = resolved.relativePath;
    } else {
      artifacts[name] = "<outside-workdir>";
      artifactWarnings.push(
        `ARTIFACT ${name} points outside the working directory and was quarantined: ${redactPathDisplay(value, workDir)}.`,
      );
    }
  }
  return { artifacts, artifactWarnings };
}
