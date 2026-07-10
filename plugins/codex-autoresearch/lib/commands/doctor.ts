import type { UnknownRecord } from "../types/json.js";

type CommandRecord = UnknownRecord & Record<string, any>;

export type DoctorCommandServiceDeps = Record<string, any>;

export function createDoctorCommandService(deps: DoctorCommandServiceDeps) {
  const {
    actionMessage,
    benchmarkContractDiagnostics,
    boolOption,
    buildDecisionEnvelope,
    buildDriftReport,
    buildRunProgress,
    continuationCommands,
    currentState,
    decisionGuidance,
    errorMessage,
    finiteMetric,
    fixedControlBlockForCommand,
    insideGitRepo,
    inspectRuntimeDrift,
    latestBenchmarkContractEntry,
    listOption,
    loopContinuation,
    metricParseSource,
    missingBenchmarkCommandMessage,
    numberOption,
    packetEnvModeFromArgs,
    parseMetricLines,
    publicState,
    redactCommandDisplay,
    redactEvidenceObject,
    revalidateRecipeCatalogProvenance,
    resolveBenchmarkCommandSource,
    resolveWorkDir,
    runShell,
    runtimeProvenance,
    shouldSuppressPreflightGateBlockerForCapsule,
    uniqueStrings,
    withCanonicalActionCommand,
  } = deps;
  const COMMAND_EXECUTION_BOUNDARY = deps.commandExecutionBoundary;
  const PLUGIN_ROOT = deps.pluginRoot;
  const PLUGIN_VERSION = deps.pluginVersion;

  async function doctorSession(args: CommandRecord): Promise<CommandRecord> {
    const { sessionCwd, workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
    const state: CommandRecord = await publicState({ ...args, compact: false });
    const primaryMetricName =
      args.metric_name ||
      args.metricName ||
      config.metricName ||
      state.config.metricName ||
      "metric";
    const issues = [];
    const warnings = [];
    const warningDetails = [];
    const inGit = await insideGitRepo(workDir);

    if (!state.config.metricName) issues.push("No primary metric is configured.");
    if (state.runs === 0)
      warnings.push("No runs are logged yet. Run a baseline before experimenting.");
    warnings.push(...(state.memory?.warnings || []));
    if (!inGit)
      warnings.push(
        "Working directory is not a Git repository; keep commits and discard reverts are unavailable.",
      );
    const operatorDetails = Array.isArray(state.warningDetails) ? state.warningDetails : [];
    for (const detail of operatorDetails) {
      if (!detail?.message) continue;
      warningDetails.push(detail);
      if (
        detail.code === "benchmark_contract_changed" ||
        String(detail.code || "").startsWith("protected_benchmark_")
      ) {
        if (detail.severity === "error" || detail.code === "benchmark_contract_changed") {
          issues.push(detail.message);
        } else {
          warnings.push(detail.message);
        }
      } else warnings.push(detail.message);
    }
    for (const check of state.scaffoldHealth?.checks || []) {
      if (!check?.message) continue;
      warningDetails.push(check);
      warnings.push(check.message);
      if (check.severity === "blocker") issues.push(check.message);
    }
    for (const warning of state.researchIntegrity?.warnings || []) {
      warnings.push(warning);
    }
    for (const blocker of state.researchIntegrity?.blockers || []) {
      issues.push(blocker);
    }
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
      benchmarkCommandHint = benchmarkCommandSource.command;
    } catch (error: unknown) {
      pushUniqueMessage(issues, errorMessage(error));
    }
    warnings.push(...drift.warnings);
    const guidance = await decisionGuidance({
      workDir,
      config,
      state,
      scaffoldHealth: state.scaffoldHealth,
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
      if (!hasSharperDoctorBlocker(state, blocker)) {
        pushUniqueMessage(issues, blocker);
      }
    }
    for (const warning of guidanceWarnings(guidance)) pushUniqueMessage(warnings, warning);
    const loopAuthority = doctorLoopContractAuthority(
      withCanonicalActionCommand(
        buildDecisionEnvelope({
          state: {
            ...state,
            gateQuality: guidance.gateQuality,
            preflight: publicPreflight,
            portfolioRecommendation: null,
            runtimeDriftSummary,
            runtimeAuthority: guidance.runtimeAuthority,
            scaffoldHealth: state.scaffoldHealth,
          },
          nextAction: "Run the next experiment, then log keep or discard with ASI.",
          finalization: state.decisionEnvelope?.finalizationReadiness || null,
        }),
        continuationCommands(workDir),
      ),
    );
    for (const blocker of loopAuthority.blockers) pushUniqueMessage(issues, blocker);

    const benchmark: CommandRecord = {
      checked: false,
      command: args.command || "",
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
        issues.push(benchmark.metricError);
      } else {
        const fixedControlBlock = fixedControlBlockForCommand(benchmark.command, config, args);
        if (fixedControlBlock) {
          benchmark.fixedControlViolation = fixedControlBlock.fixedControlViolation;
          benchmark.metricError = fixedControlBlock.issue;
          issues.push(fixedControlBlock.issue);
        } else {
          const latestContract = latestBenchmarkContractEntry(workDir, state)?.benchmarkContract;
          const explicitPacketEnvMode = args.packet_env_mode != null || args.packetEnvMode != null;
          const doctorPacketEnvMode = explicitPacketEnvMode
            ? packetEnvModeFromArgs(args)
            : latestContract && Object.hasOwn(latestContract, "packetEnvMode")
              ? packetEnvModeFromArgs({ packetEnvMode: latestContract.packetEnvMode })
              : "minimal";
          benchmark.packetEnvMode = doctorPacketEnvMode;
          const run = await runShell(
            benchmark.command,
            workDir,
            numberOption(args.timeout_seconds ?? args.timeoutSeconds, 60),
            {
              envMode: doctorPacketEnvMode,
              retainMetricNames: [primaryMetricName],
            },
          );
          benchmark.exitCode = run.exitCode;
          benchmark.timedOut = run.timedOut;
          benchmark.parsedMetrics = parseMetricLines(metricParseSource(run));
          benchmark.emitsPrimary = finiteMetric(benchmark.parsedMetrics[primaryMetricName]) != null;
          benchmark.progress = buildRunProgress({
            benchmark: run,
            checks: null,
            checksCommand: null,
            passed: run.exitCode === 0 && !run.timedOut && benchmark.emitsPrimary,
          });
          if (run.exitCode !== 0 || run.timedOut) {
            issues.push(
              `Benchmark command failed during doctor check: exit ${run.exitCode ?? "none"}${run.timedOut ? " (timed out)" : ""}.`,
            );
          } else if (!benchmark.emitsPrimary) {
            benchmark.metricError = `Benchmark did not emit primary metric METRIC ${primaryMetricName}=<number>.`;
            issues.push(benchmark.metricError);
          }
          const driftWarning = benchmarkDriftWarning({
            currentMetric: benchmark.parsedMetrics[primaryMetricName],
            bestMetric: state.best,
            direction: state.config.bestDirection,
            metricName: primaryMetricName,
          });
          if (driftWarning) warnings.push(driftWarning);
        }
      }
    }

    let nextAction = "Run the next experiment, then log keep or discard with ASI.";
    if (runtimeAuthority?.blocking === true) {
      nextAction =
        String(runtimeAuthority.blocker || "").trim() ||
        "Inspect or refresh the installed plugin runtime before claiming installed behavior.";
    } else if (loopAuthority.canonicalNextAction?.safeAction === "ledger-doctor") {
      nextAction = "Run ledger-doctor before another packet.";
    } else if (loopAuthority.nextAction) {
      nextAction = loopAuthority.nextAction;
    } else if (issues.some((issue: any) => /contract changed/i.test(issue))) {
      nextAction =
        "Start a new segment or explicitly invalidate the old evidence before running another packet.";
    } else if (issues.some((issue: any) => /primary metric|benchmark/i.test(issue))) {
      nextAction =
        "Fix the benchmark command so it emits the configured primary metric before continuing.";
    } else if (issues.some((issue: any) => /fixed_control_rerun_blocked/i.test(String(issue)))) {
      nextAction = "Reuse the fixed control artifact instead of running the benchmark check.";
    } else if (state.runs === 0) {
      nextAction = "Run and log a baseline before trying optimizations.";
    } else if (state.limit.limitReached) {
      nextAction = "Iteration limit reached; export the dashboard or start a new segment.";
    } else if (warnings.some((warning: any) => /dirty/.test(String(warning)))) {
      nextAction = "Review the dirty Git state before logging a kept result.";
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
    const continuationState =
      state.code === "ledger_jsonl_invalid"
        ? { current: [], allRecords: [], ...state }
        : currentState(workDir);
    const benchmarkContractChanged = warningDetails.some(
      (detail: any) => detail?.code === "benchmark_contract_changed",
    );
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
        clean: state.decisionEnvelope?.dirtySourceDrift?.dirty === true ? false : true,
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
      decisionEnvelope: loopAuthority.decisionEnvelope,
      loopContract: loopAuthority.loopContract,
      canonicalNextAction: loopAuthority.canonicalNextAction,
      commandExecutionBoundary,
      runtimeProvenance: runtimeProvenance(drift),
      scaffoldHealth: state.scaffoldHealth,
      researchIntegrity: state.researchIntegrity,
      catalogTrust,
      issues,
      warnings,
      warningDetails,
      nextAction,
      continuation: loopContinuation(workDir, continuationState, config, "doctor"),
    };
    if (boolOption(args.explain, false)) result.explanation = doctorExplanation(result);
    return result;
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
    const runtimeSummary = result.runtimeDriftSummary || null;
    return {
      verdict: result.ok
        ? "Doctor found no blocking issues."
        : "Doctor found issues that must be fixed before trusting the loop.",
      priorityFixes: [
        ...(result.issues || []),
        ...(result.warnings || []).filter((warning: any) =>
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

  function guidanceBlockers(guidance: CommandRecord): string[] {
    const blockers = [
      ...listOption(guidance.gateQuality?.blockers),
      ...(guidance.preflight?.status === "blocked" ? listOption(guidance.preflight?.blockers) : []),
    ]
      .map((blocker: any) => String(blocker || "").trim())
      .filter(Boolean);
    if (guidance.preflight?.status === "blocked" && blockers.length === 0) {
      blockers.push("Preflight readiness is blocked.");
    }
    return uniqueStrings(blockers);
  }

  function guidanceWarnings(guidance: CommandRecord): string[] {
    return uniqueStrings([
      ...listOption(guidance.gateQuality?.warnings),
      ...listOption(guidance.preflight?.warnings),
    ]);
  }

  function doctorLoopContractAuthority(decisionEnvelope: CommandRecord | null | undefined) {
    const envelope = decisionEnvelope || {};
    const loopContract = envelope.loopContract || null;
    const canonicalNextAction = envelope.canonicalNextAction || null;
    const blockers = Array.isArray(loopContract?.blockers)
      ? loopContract.blockers.map(actionMessage).filter(Boolean)
      : [];
    const strongestActionMessage = actionMessage(loopContract?.strongestAction);
    if (blockers.length === 0 && strongestActionMessage && loopContract?.ok === false) {
      blockers.push(strongestActionMessage);
    }
    return {
      decisionEnvelope: envelope,
      loopContract,
      canonicalNextAction,
      blockers: uniqueStrings(blockers),
      nextAction:
        blockers.length > 0
          ? actionMessage(canonicalNextAction) || strongestActionMessage || blockers[0]
          : "",
    };
  }

  function pushUniqueMessage(target: any[], message: unknown) {
    const text = String(message || "").trim();
    if (text && !target.includes(text)) target.push(text);
  }

  function hasSharperDoctorBlocker(state: CommandRecord, blocker: unknown = ""): boolean {
    if (hasScaffoldBlocker(state.scaffoldHealth)) return true;
    if (
      blocker &&
      shouldSuppressPreflightGateBlockerForCapsule(
        { sessionDecisionCapsule: state.sessionDecisionCapsule },
        blocker,
      )
    ) {
      return true;
    }
    if (
      blocker &&
      shouldSuppressPreflightGateBlockerForCapsule(
        { sessionDecisionCapsule: state.decisionEnvelope?.sessionDecisionCapsule },
        blocker,
      )
    ) {
      return true;
    }
    return false;
  }

  function hasScaffoldBlocker(scaffoldHealth: unknown): boolean {
    const checks = Array.isArray((scaffoldHealth as CommandRecord | null)?.checks)
      ? (scaffoldHealth as CommandRecord).checks
      : [];
    return checks.some((check: any) => check?.severity === "blocker");
  }

  return { doctorSession };
}
