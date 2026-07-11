import {
  createActiveProgressWriter,
  readActiveProgressSnapshot,
} from "../active-progress-store.js";
import {
  benchmarkCommandFromArgs,
  normalizePowerShellEscapedCommandArg,
} from "../benchmark/command-input.js";
import { benchmarkContractSnapshot } from "../benchmark/contract-snapshot.js";
import { checksPolicyFromArgs, defaultChecksCommand, shouldRunChecks } from "../check-policy.js";
import { COMMAND_EXECUTION_BOUNDARY } from "../command-execution-boundary.js";
import { numberOption } from "../cli/args.js";
import { resolveAuthorizedWorkDir } from "../cli/workdir-context.js";
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
import {
  protectedBenchmarkGuardError,
  protectedBenchmarkGuardForWorkDir,
} from "../benchmark/contract-guards.js";
import { fixedControlBlockForCommand, fixedControlRerunError } from "../fixed-control.js";
import { resolvePathInsideRootSync } from "../path-containment.js";
import { redactPathDisplay } from "../evidence-redaction.js";
import {
  createProgressSnapshot,
  finishProgressSnapshot,
  staleProgressReason,
  updateProgressSnapshot,
  type RunnerProgressSnapshot,
} from "../runner-progress.js";
import { parseMetricLines, runShell, tailText, type ShellRunResult } from "../runner.js";
import { commandDiagnostics } from "../truth-signals.js";
import type { UnknownRecord } from "../types/json.js";
import { runWithRequiredCleanup } from "../required-cleanup.js";

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;
const MAX_PARSED_METRICS = 512;
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
  if (limit.limitReached) {
    throw new Error(
      limit.stopReason ||
        `maxIterations reached (${limit.maxIterations}). Start a new segment with init/setup or raise maxIterations before running more experiments.`,
    );
  }
  const protectedBenchmarkGuard = await protectedBenchmarkGuardForWorkDir(workDir, config, state);
  if (protectedBenchmarkGuard.configured && !protectedBenchmarkGuard.ok) {
    throw new Error(protectedBenchmarkGuardError(protectedBenchmarkGuard));
  }
  const commandInput = await benchmarkCommandFromArgs(args, workDir, config);
  const { command } = commandInput;
  const fixedControlBlock = fixedControlBlockForCommand(command, config, args);
  if (fixedControlBlock) throw fixedControlRerunError(fixedControlBlock);
  const timeoutSeconds = numberOption(
    args.timeout_seconds ?? args.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
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
    stageCommand: string,
    stageTimeoutSeconds: number,
    options: Parameters<typeof runShell>[3],
    timeoutPhase: "benchmark" | "checks",
  ) => {
    try {
      return await runShell(stageCommand, workDir, stageTimeoutSeconds, options);
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
    command,
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
    maxMetrics: MAX_PARSED_METRICS,
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
  let checks = null;
  const rawChecksCommand =
    args.checks_command || args.checksCommand || (await defaultChecksCommand(workDir));
  const checksCommand = rawChecksCommand
    ? normalizePowerShellEscapedCommandArg(rawChecksCommand)
    : "";
  const checksPolicy = checksPolicyFromArgs(args, config);
  const explicitChecksCommand = Boolean(args.checks_command || args.checksCommand);
  if (
    checksCommand &&
    shouldRunChecks(checksPolicy, {
      benchmarkPassed,
      primaryPresent,
      checksCommand,
      improvesPrimary,
      explicitChecksCommand,
    })
  ) {
    checks = await runPacketStage(
      checksCommand,
      numberOption(
        args.checks_timeout_seconds ?? args.checksTimeoutSeconds,
        DEFAULT_CHECKS_TIMEOUT_SECONDS,
      ),
      {
        env: commandInput.env,
        envMode: commandInput.packetEnvMode,
        onProgress: updateProgress,
      },
      "checks",
    );
  }
  const checksPassed = checks ? checks.exitCode === 0 && !checks.timedOut : null;
  const terminationFailed = Boolean(benchmark.terminationFailed || checks?.terminationFailed);
  const termination = checks?.termination ?? benchmark.termination;
  const metricError =
    benchmarkPassed && !primaryPresent
      ? `Benchmark completed but did not print primary metric METRIC ${state.config.metricName}=<number>.`
      : null;
  const checksPassedOrSkipped = checksPassed === null || checksPassed;
  const passed = benchmarkPassed && primaryPresent && checksPassedOrSkipped;
  const failedStatus = benchmarkPassed && primaryPresent ? "checks_failed" : "crash";
  const allowedStatuses = passed ? ["keep", "discard", "measure"] : [failedStatus];
  const suggestedStatus = passed
    ? isBaseline
      ? "measure"
      : improvesPrimary
        ? "keep"
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
        : "Default to discard unless the operator can justify keep with ASI and verification evidence; use measure for non-promotional metric evidence."
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
    processLifecycle: processLifecycleRecordsForRun(packetId, benchmark, checks),
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
  checks: ShellRunResult | null,
) {
  return [
    ...processLifecycleRecordsForStage(packetId, "benchmark", benchmark),
    ...(checks ? processLifecycleRecordsForStage(packetId, "checks", checks) : []),
  ];
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

function metricParseSource(result: ShellRunResult): string {
  const retained = result.retainedMetricOutput || "";
  if (result.metricOutput) {
    return [
      result.metricOutput,
      result.metricOutputTruncated && result.fullOutput ? result.fullOutput : "",
      retained,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [result.fullOutput || result.output || "", retained].filter(Boolean).join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
