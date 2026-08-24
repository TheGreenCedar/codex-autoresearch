import { type UnknownRecord, unknownRecordOrNull as recordOrNull } from "../types/json.js";
import {
  missingBenchmarkCommandMessage,
  packetEnvModeFromArgs,
  resolveBenchmarkCommandSource,
} from "../benchmark/command-input.js";
import { COMMAND_EXECUTION_BOUNDARY } from "../command-execution-boundary.js";
import { withCommandDecisionDiagnostics } from "../command-decision-protocol.js";
import { boolOption, numberOption } from "../cli/args.js";
import { loadCoherentSessionSnapshot } from "../coherent-session-snapshot.js";
import { decisionDiagnostic, type DecisionDiagnostic } from "../decision-compiler.js";
import { projectLoopContinuation } from "../decision-projection.js";
import { decisionGuidance } from "../decision-guidance.js";
import { buildDriftReport, runtimeProvenance } from "../drift-doctor.js";
import { fixedControlBlockForCommand } from "../fixed-control.js";
import { insideGitRepo } from "../git-private-state.js";
import { latestBenchmarkContractEntry } from "../operator-warnings.js";
import { benchmarkContractDiagnostics } from "../packet-diagnostics.js";
import { PLUGIN_VERSION } from "../plugin-version.js";
import { resolvePackageRoot } from "../runtime-paths.js";
import { finiteMetric, listOption } from "../session-core.js";
import { inspectRuntimeDrift } from "../runtime-drift-doctor.js";
import { metricParseSource, parseMetricLines, runShell } from "../runner.js";
import { projectDoctorReadModel } from "../session-read-model.js";
import { compileSessionDecision, finalizationDecisionDiagnostics } from "../session-decision.js";
import { redactCommandDisplay, redactEvidenceObject } from "../evidence-redaction.js";
import { revalidateRecipeCatalogProvenance } from "../recipes.js";
import { buildRunProgress } from "./run.js";
import { publicState } from "./state.js";

type CommandRecord = UnknownRecord;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);

export async function doctorSession(args: CommandRecord): Promise<CommandRecord> {
  const requestedCwd = String(args.working_dir || args.cwd || "");
  const loaded = await loadCoherentSessionSnapshot({
    requestedCwd,
    allowOutsideWorkdir: boolOption(args.allowOutsideWorkdir ?? args.allow_outside_workdir, false),
  });
  if (!loaded.ok) {
    return {
      ok: false,
      code: loaded.diagnostic.code,
      diagnostic: loaded.diagnostic,
      attempts: loaded.attempts,
    };
  }
  const snapshot = loaded.snapshot;
  const { sessionCwd, workDir, config } = snapshot;
  const jsonFull = boolOption(args.jsonFull ?? args.json_full ?? args.full, false);
  const state: CommandRecord = await publicState({
    ...args,
    compact: false,
    jsonFull: true,
    coherentSnapshot: snapshot,
  });
  const stateConfig = recordOrEmpty(state.config);
  const stateMemory = recordOrEmpty(state.memory);
  const scaffoldHealth = recordOrEmpty(state.scaffoldHealth);
  const researchIntegrity = recordOrEmpty(state.researchIntegrity);
  const sourceCleanliness = recordOrEmpty(state.sourceCleanliness);
  const primaryMetricName = String(
    args.metric_name || args.metricName || config.metricName || stateConfig.metricName || "metric",
  );
  const issues: string[] = [];
  const warnings: string[] = [];
  const warningDetails: UnknownRecord[] = [];
  const inGit = await insideGitRepo(workDir);

  if (!stateConfig.metricName) issues.push("No primary metric is configured.");
  if (state.runs === 0)
    warnings.push("No runs are logged yet. Run a baseline before experimenting.");
  warnings.push(...stringArray(stateMemory.warnings));
  if (!inGit)
    warnings.push(
      "Working directory is not a Git repository; keep commits and discard reverts are unavailable.",
    );
  const operatorDetails = Array.isArray(state.warningDetails) ? state.warningDetails : [];
  for (const item of operatorDetails) {
    const detail = recordOrEmpty(item);
    if (!detail.message) continue;
    warningDetails.push(detail);
    if (
      detail.code === "benchmark_contract_changed" ||
      String(detail.code || "").startsWith("protected_benchmark_")
    ) {
      if (detail.severity === "error" || detail.code === "benchmark_contract_changed") {
        issues.push(String(detail.message));
      } else {
        warnings.push(String(detail.message));
      }
    } else warnings.push(String(detail.message));
  }
  for (const item of arrayValue(scaffoldHealth.checks)) {
    const check = recordOrEmpty(item);
    if (!check.message) continue;
    warningDetails.push(check);
    warnings.push(String(check.message));
    if (check.severity === "blocker") issues.push(String(check.message));
  }
  warnings.push(...stringArray(researchIntegrity.warnings));
  issues.push(...stringArray(researchIntegrity.blockers));
  const revalidateCatalog = boolOption(args.revalidate_catalog ?? args.revalidateCatalog, false);
  const catalogTrust = revalidateCatalog
    ? await catalogTrustCheck(config, sessionCwd).catch((error: unknown) => ({
        ok: false,
        issues: [`Trusted recipe catalog could not be revalidated: ${errorMessage(error)}`],
      }))
    : { ok: true, issues: [] as string[], skipped: true };
  if (!catalogTrust.ok) issues.push(...catalogTrust.issues);
  const drift = await buildDriftReport({
    pluginRoot: PLUGIN_ROOT,
    includeInstalled: boolOption(args.check_installed ?? args.checkInstalled, false),
  });
  const checkInstalledRuntime = boolOption(args.check_installed ?? args.checkInstalled, false);
  const runtimeDriftSummary = await inspectRuntimeDrift({
    packageRoot: PLUGIN_ROOT,
    sourceVersion: PLUGIN_VERSION,
  });
  let benchmarkCommandHint = "";
  let benchmarkCommandSource: Awaited<ReturnType<typeof resolveBenchmarkCommandSource>> | null =
    null;
  try {
    benchmarkCommandSource = await resolveBenchmarkCommandSource(args, workDir, {
      fallbackToDefault: true,
      config,
    });
    benchmarkCommandHint = String(benchmarkCommandSource.command || "");
  } catch (error: unknown) {
    pushUniqueMessage(issues, errorMessage(error));
  }
  warnings.push(...drift.warnings);
  const guidance = await decisionGuidance({
    workDir,
    config,
    state,
    scaffoldHealth,
    warningDetails,
    runtimeDriftSummary,
    runtimeTrustScope: checkInstalledRuntime ? "installed-plugin" : "source-checkout",
    benchmarkCommand: benchmarkCommandHint,
  });
  const publicCommandAuthority = publicCommandPayload(guidance.commandAuthority);
  const publicPreflight = publicCommandPayload(guidance.preflight);
  const runtimeAuthority = (guidance.runtimeAuthority || null) as CommandRecord | null;
  if (runtimeAuthority?.blocking === true) {
    pushUniqueMessage(issues, runtimeAuthority.blocker);
  }
  for (const blocker of guidanceBlockers(guidance)) {
    pushUniqueMessage(issues, blocker);
  }
  for (const warning of guidanceWarnings(guidance)) pushUniqueMessage(warnings, warning);
  const benchmark: CommandRecord = {
    checked: false,
    command: String(args.command || ""),
    packetEnvMode: null,
    emitsPrimary: null,
    parsedMetrics: {},
    exitCode: null,
    timedOut: false,
    metricError: null,
    progress: null,
  };

  if (boolOption(args.check_benchmark ?? args.checkBenchmark, false)) {
    benchmark.checked = true;
    benchmarkCommandSource =
      benchmarkCommandSource ||
      (await resolveBenchmarkCommandSource(args, workDir, {
        fallbackToDefault: true,
        requireCommand: false,
        config,
      }));
    benchmark.command = benchmarkCommandSource.command;
    if (!benchmark.command) {
      benchmark.metricError =
        benchmarkCommandSource.missingReason || missingBenchmarkCommandMessage();
      issues.push(String(benchmark.metricError));
    } else {
      const fixedControlBlock = fixedControlBlockForCommand(benchmark.command, config, args);
      if (fixedControlBlock) {
        benchmark.fixedControlViolation = fixedControlBlock.fixedControlViolation;
        benchmark.metricError = fixedControlBlock.issue;
        issues.push(String(fixedControlBlock.issue));
      } else {
        const latestContract = recordOrNull(
          latestBenchmarkContractEntry(workDir, state)?.benchmarkContract,
        );
        const explicitPacketEnvMode = args.packet_env_mode != null || args.packetEnvMode != null;
        const doctorPacketEnvMode = explicitPacketEnvMode
          ? packetEnvModeFromArgs(args)
          : latestContract && Object.hasOwn(latestContract, "packetEnvMode")
            ? packetEnvModeFromArgs({ packetEnvMode: latestContract.packetEnvMode })
            : "minimal";
        benchmark.packetEnvMode = doctorPacketEnvMode;
        const run = await runShell(
          String(benchmark.command || ""),
          workDir,
          numberOption(args.timeout_seconds ?? args.timeoutSeconds, 60),
          {
            envMode: doctorPacketEnvMode,
            retainMetricNames: [primaryMetricName],
          },
        );
        benchmark.exitCode = run.exitCode;
        benchmark.timedOut = run.timedOut;
        benchmark.termination = run.termination;
        benchmark.terminationFailed = run.terminationFailed;
        const parsedMetrics = parseMetricLines(metricParseSource(run));
        benchmark.parsedMetrics = parsedMetrics;
        benchmark.emitsPrimary = finiteMetric(parsedMetrics[primaryMetricName]) != null;
        benchmark.progress = buildRunProgress({
          benchmark: { ...run },
          checks: null,
          checksCommand: null,
          passed: run.exitCode === 0 && !run.timedOut && benchmark.emitsPrimary === true,
        });
        if (run.exitCode !== 0 || run.timedOut) {
          issues.push(
            `Benchmark command failed during doctor check: exit ${run.exitCode ?? "none"}${run.timedOut ? " (timed out)" : ""}.`,
          );
          if (run.terminationFailed) {
            warnings.push(
              "Process-tree termination could not be proven; verify the reported PID and descendants before another command.",
            );
          }
        } else if (!benchmark.emitsPrimary) {
          benchmark.metricError = `Benchmark did not emit primary metric METRIC ${primaryMetricName}=<number>.`;
          issues.push(String(benchmark.metricError));
        }
        const driftWarning = benchmarkDriftWarning({
          currentMetric: parsedMetrics[primaryMetricName],
          bestMetric: state.best,
          direction: stateConfig.bestDirection,
          metricName: primaryMetricName,
        });
        if (driftWarning) warnings.push(driftWarning);
      }
    }
  }

  const commandExecutionBoundary = benchmarkCommandHint
    ? {
        mode: COMMAND_EXECUTION_BOUNDARY.mode,
        note: COMMAND_EXECUTION_BOUNDARY.note,
        recommendation: COMMAND_EXECUTION_BOUNDARY.recommendation,
      }
    : null;
  const activeBenchmarkContractEntry =
    state.code === "ledger_jsonl_invalid" ? null : latestBenchmarkContractEntry(workDir, state);
  const contractDiagnostics = benchmarkContractDiagnostics({
    state,
  });
  const benchmarkContractChanged = warningDetails.some(
    (detail) => detail.code === "benchmark_contract_changed",
  );
  const commandDiagnostics = doctorDecisionDiagnostics({
    benchmark,
    issues,
    runtimeAuthority,
    scaffoldHealth,
    sourceCleanliness,
    warningDetails,
    suppressEvaluatorDrift:
      typeof args.acceptedContractDigest === "string" &&
      args.acceptedContractDigest === snapshot.semanticFacts.contractDigest,
  });
  const finalizationFacts = { finalization: recordOrNull(state.finalizationPressure) };
  const decisionPlan = compileSessionDecision(snapshot, {
    ...finalizationFacts,
    diagnostics: commandDiagnostics,
  });
  const nextAction = decisionPlan.action.reason;
  const publicBenchmark = {
    ...benchmark,
    command: redactCommandDisplay(benchmark.command),
  };

  const result: CommandRecord = {
    ok: issues.length === 0,
    workDir,
    config: state.config,
    state,
    git: {
      inside: inGit,
      clean: sourceCleanliness.sourceDirty !== true,
    },
    benchmarkContract: {
      ok: benchmarkContractChanged === false,
      activeSource: contractDiagnostics.activeSource,
      activeContract: contractDiagnostics.activeContract,
      historicalContracts: contractDiagnostics.historicalContracts,
      historical: contractDiagnostics.historicalContracts.length > 0,
      segmentEntry: activeBenchmarkContractEntry?.benchmarkContractScope === "segment",
    },
    benchmark: publicBenchmark,
    drift,
    runtimeDriftSummary,
    runtimeAuthority: guidance.runtimeAuthority,
    gateQuality: guidance.gateQuality,
    commandAuthority: publicCommandAuthority,
    preflight: publicPreflight,
    decisionPlan,
    commandExecutionBoundary,
    runtimeProvenance: runtimeProvenance(drift),
    scaffoldHealth: state.scaffoldHealth,
    researchIntegrity: state.researchIntegrity,
    catalogTrust,
    issues,
    warnings,
    warningDetails,
    nextAction,
    continuation: projectLoopContinuation(decisionPlan),
  };
  if (boolOption(args.explain, false)) result.explanation = doctorExplanation(result);
  return withCommandDecisionDiagnostics(projectDoctorReadModel(result, { full: jsonFull }), [
    ...finalizationDecisionDiagnostics(finalizationFacts),
    ...commandDiagnostics,
  ]);
}

async function catalogTrustCheck(config: CommandRecord, sessionCwd: string) {
  const provenance = config.recipeCatalogProvenance || config.recipe_catalog_provenance || null;
  if (!provenance) return { ok: true, issues: [] as string[] };
  return await revalidateRecipeCatalogProvenance(provenance, { catalogBaseDir: sessionCwd });
}

function publicCommandPayload<T>(value: T): T {
  return redactEvidenceObject(value) as T;
}

function benchmarkDriftWarning({
  currentMetric,
  bestMetric,
  direction,
  metricName,
}: CommandRecord) {
  const current = finiteMetric(currentMetric);
  const best = finiteMetric(bestMetric);
  if (current == null || best == null || best === 0) return "";
  const worse =
    direction === "higher"
      ? current < best && Math.abs((best - current) / best) >= 0.25
      : current > best && Math.abs((current - best) / best) >= 0.25;
  if (!worse) return "";
  return `Benchmark drift: current ${metricName}=${current} is far worse than historical best ${best}. Treat the old best as historical evidence, not current runtime proof.`;
}

function doctorExplanation(result: CommandRecord): CommandRecord {
  const runtimeSummary = recordOrNull(result.runtimeDriftSummary);
  return {
    verdict: result.ok
      ? "Doctor found no blocking issues."
      : "Doctor found issues that must be fixed before trusting the loop.",
    priorityFixes: [
      ...stringArray(result.issues),
      ...stringArray(result.warnings).filter((warning) =>
        /dirty|drift|benchmark|missing|stale|commitPaths/i.test(String(warning)),
      ),
    ].slice(0, 5),
    runtimeDriftSummary: runtimeSummary
      ? {
          installedRuntime: runtimeSummary.installedRuntime,
          builtRuntime: runtimeSummary.builtRuntime,
          smokeCheck: runtimeSummary.smokeCheck,
          nextActionHint: runtimeSummary.nextActionHint,
        }
      : null,
    runtimeAuthority: result.runtimeAuthority || null,
    gateQuality: result.gateQuality || null,
    preflight: result.preflight || null,
    nextSafeAction: result.nextAction,
    commandExecutionBoundary: result.commandExecutionBoundary || null,
    readAs:
      "Issues block the loop. Warnings reduce trust and should be resolved before keeping results when they affect evidence, Git, or runtime drift.",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(items: unknown[]): string[] {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function guidanceBlockers(guidance: CommandRecord): string[] {
  const gateQuality = recordOrEmpty(guidance.gateQuality);
  const preflight = recordOrEmpty(guidance.preflight);
  const blockers = [
    ...listOption(gateQuality.blockers),
    ...(preflight.status === "blocked" ? listOption(preflight.blockers) : []),
  ]
    .map((blocker) => String(blocker || "").trim())
    .filter(Boolean);
  if (preflight.status === "blocked" && blockers.length === 0) {
    blockers.push("Preflight readiness is blocked.");
  }
  return uniqueStrings(blockers);
}

function guidanceWarnings(guidance: CommandRecord): string[] {
  const gateQuality = recordOrEmpty(guidance.gateQuality);
  const preflight = recordOrEmpty(guidance.preflight);
  return uniqueStrings([...listOption(gateQuality.warnings), ...listOption(preflight.warnings)]);
}

function pushUniqueMessage(target: string[], message: unknown) {
  const text = String(message || "").trim();
  if (text && !target.includes(text)) target.push(text);
}

function hasScaffoldBlocker(scaffoldHealth: unknown): boolean {
  return arrayValue(recordOrEmpty(scaffoldHealth).checks).some(
    (check) => recordOrEmpty(check).severity === "blocker",
  );
}

function recordOrEmpty(value: unknown): UnknownRecord {
  return recordOrNull(value) || {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).map(String);
}

function doctorDecisionDiagnostics({
  benchmark,
  issues,
  runtimeAuthority,
  scaffoldHealth,
  sourceCleanliness,
  warningDetails,
  suppressEvaluatorDrift,
}: {
  benchmark: CommandRecord;
  issues: string[];
  runtimeAuthority: CommandRecord | null;
  scaffoldHealth: CommandRecord;
  sourceCleanliness: CommandRecord;
  warningDetails: CommandRecord[];
  suppressEvaluatorDrift: boolean;
}): DecisionDiagnostic[] {
  const diagnostics: DecisionDiagnostic[] = [];
  if (runtimeAuthority?.blocking === true) {
    diagnostics.push(
      decisionDiagnostic("runtime-integrity", {
        message: String(runtimeAuthority.blocker || "Runtime authority is not proven."),
      }),
    );
  }
  if (hasScaffoldBlocker(scaffoldHealth)) {
    diagnostics.push(
      decisionDiagnostic("scaffold-invalid", {
        message: "The session scaffold has a blocking integrity issue.",
      }),
    );
  }
  if (sourceCleanliness.sourceDirty === true) {
    diagnostics.push(
      decisionDiagnostic("dirty-source", {
        message: "Review the dirty source tree before authorizing packet evidence.",
      }),
    );
  }
  const drift = warningDetails.find((detail) => {
    const code = String(detail.code || "");
    return (
      code === "benchmark_contract_changed" ||
      (code.startsWith("protected_benchmark_") && detail.severity === "error")
    );
  });
  if (drift && !suppressEvaluatorDrift) {
    diagnostics.push(
      decisionDiagnostic("evaluator-drift", {
        message: String(drift.message || "The accepted evaluator has drifted."),
      }),
    );
  }
  if (
    benchmark.checked === true &&
    (benchmark.exitCode !== 0 || benchmark.timedOut === true || benchmark.emitsPrimary !== true)
  ) {
    diagnostics.push(
      decisionDiagnostic("packet-diagnostic", {
        message:
          String(benchmark.metricError || "") ||
          issues.find((issue) => /benchmark|metric/i.test(issue)) ||
          "The doctor benchmark check did not produce accepted evaluator evidence.",
        semantic: {
          stage: benchmark.timedOut === true ? "timeout" : "evaluator-check",
        },
      }),
    );
  }
  return diagnostics;
}
