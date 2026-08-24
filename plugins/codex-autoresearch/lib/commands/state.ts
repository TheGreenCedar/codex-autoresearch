import { type UnknownRecord, unknownRecordOrNull as recordOrNull } from "../types/json.js";
import { COMMAND_EXECUTION_BOUNDARY } from "../command-execution-boundary.js";
import {
  loadCoherentSessionSnapshot,
  type CoherentSessionSnapshot,
} from "../coherent-session-snapshot.js";
import { decisionDiagnostic, type DecisionDiagnostic } from "../decision-compiler.js";
import { projectLoopContinuation, projectResolvedDecision } from "../decision-projection.js";
import {
  buildCheapFinalizationPressure,
  buildSessionReadModel,
  buildSessionReadModelState,
  projectFullState,
  projectStateReadModel,
  statusCountsFromState,
} from "../session-read-model.js";
import { analyzeExperimentEconomics } from "../experiment-economics.js";
import { analyzeLedgerHealth } from "../ledger-health.js";
import { analyzeWorkflowFriction } from "../workflow-friction.js";
import { boolOption } from "../cli/args.js";
import { iterationLimitInfo, stateFromSessionRecords } from "../session-core.js";
import { isAcceptedCurrentRun } from "../evidence-registry.js";
import { buildLaneLifecycle } from "../lane-lifecycle.js";
import { buildScaffoldHealth, buildResearchIntegrity } from "../truth-signals.js";
import { buildServeRegistryHealthInput, readServeRegistry } from "../dashboard-server-registry.js";
import { buildSourceCleanliness } from "../source-cleanliness.js";
import { buildTerminalReport } from "../terminal-report.js";
import { classifyPacketDiagnostics } from "../packet-diagnostics.js";
import { currentQualityGapSummary } from "../research-gaps.js";
import { buildDashboardSettings, dashboardCommands } from "./dashboard.js";
import { decisionGuidance } from "../decision-guidance.js";
import { continuationCommands } from "./continuation.js";
import { fixedControlStateSummary } from "../fixed-control.js";
import { listBuiltInRecipes } from "../recipes.js";
import { recommendPortfolioDirection } from "../portfolio-advisor.js";
import { redactCommandDisplay, redactEvidenceObject } from "../evidence-redaction.js";
import { verifyDashboardHealthSummary } from "../dashboard-health.js";
import { replacementNextCommandForLastRun } from "../last-run-store.js";
import { compileSessionDecision } from "../session-decision.js";
import { operatorWarningsForWorkDir } from "../operator-warnings.js";
import { buildParallelOrchestrationContext } from "../parallel-orchestration.js";
import { PLUGIN_VERSION } from "../plugin-version.js";
import { runtimeProvenance } from "../drift-doctor.js";
import { resolvePackageRoot } from "../runtime-paths.js";

export interface CompactStateBuilderInput extends UnknownRecord {
  workDir: string;
}

export type CompactStateResponse = UnknownRecord;

export function buildCompactStateResponse(input: CompactStateBuilderInput): CompactStateResponse {
  return projectStateReadModel(input, "compact");
}

type CommandRecord = UnknownRecord;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
type FinalizePreviewModule = typeof import("../finalize-preview.js");

async function buildFinalizePreviewLazy(
  ...args: Parameters<FinalizePreviewModule["finalizePreview"]>
): Promise<Awaited<ReturnType<FinalizePreviewModule["finalizePreview"]>>> {
  return (await import("../finalize-preview.js")).finalizePreview(...args);
}

async function discoverLastRunPartialResultsLazy(
  workDir: string,
  state: CommandRecord,
  lastRun: CommandRecord | null,
) {
  return await (
    await import("../partial-results.js")
  ).discoverLastRunPartialResults({
    workDir,
    primaryMetricName: String(recordOrEmpty(state.config).metricName || "metric"),
    lastRunPacket: lastRun,
  });
}

export async function publicState(args: CommandRecord): Promise<CommandRecord> {
  const requestedCwd = String(args.working_dir || args.cwd || "");
  const compact = boolOption(args.compact, false);
  const report = boolOption(args.report, false);
  const jsonFull = boolOption(args.jsonFull ?? args.json_full ?? args.full, false);
  const bounded = boolOption(args.bounded, false);
  const codexGoalObjective = args.codexGoalObjective || args.codex_goal_objective;
  let snapshot = coherentSnapshotOrNull(args.coherentSnapshot);
  if (!snapshot) {
    const loaded = await loadCoherentSessionSnapshot({
      requestedCwd,
      allowOutsideWorkdir: boolOption(
        args.allowOutsideWorkdir ?? args.allow_outside_workdir,
        false,
      ),
    });
    if (!loaded.ok) {
      return {
        ok: false,
        code: loaded.diagnostic.code,
        diagnostic: loaded.diagnostic,
        attempts: loaded.attempts,
      };
    }
    snapshot = loaded.snapshot;
  }
  const { workDir, config } = snapshot;
  if (compact || report) {
    const compactState = await publicCompactState({ snapshot, codexGoalObjective });
    if (!report) return compactState;
    const response: CommandRecord = {
      ok: compactState.ok !== false,
      workDir,
      report: buildTerminalReport(compactState),
    };
    if (compact) response.compactState = compactState;
    return response;
  }

  const records = snapshot.records;
  const state = stateFromSessionRecords(workDir, records);
  const ledgerHealth = analyzeLedgerHealth(records, {
    parseErrors: snapshot.sourceDiagnostics.ledgerIssues,
  });
  const scaffoldHealth = await buildScaffoldHealth({ workDir, config });
  const researchIntegrity = buildResearchIntegrity({ state, config });
  const warningDetails = await operatorWarningsForWorkDir(workDir, state);
  const lastRun = snapshot.lastRunPacket;
  const activeProgress = snapshot.processProgress;
  const qualityGap = await currentQualityGapSummary(workDir);
  const finalization = await finalizationPressureForWorkDir({
    workDir,
    state,
    qualityGap,
    warningDetails,
  });
  const settings = buildDashboardSettings(config);
  const orchestration = buildParallelOrchestrationContext({
    workDir,
    state,
    config,
    settings,
    records,
  });
  const { memory, fanoutPlan, fanoutProvenance, parallelLanes, watchdogSummary } = orchestration;
  const laneLifecycle = buildLaneLifecycle({
    state,
    records,
    fanoutPlan,
    parallelLanes,
    laneResults: orchestration.laneResults,
    workDir,
    pluginRoot: PLUGIN_ROOT,
  });
  const lastRunDecision = recordOrEmpty(lastRun?.decision);
  const lastRunRecord = recordOrEmpty(lastRun?.run);
  const lastRunEvidence = recordOrEmpty(lastRun?.packetEvidence);
  const packetDiagnostics = lastRun
    ? classifyPacketDiagnostics({
        packetEvidence: lastRunEvidence,
        run: lastRunRecord,
        decision: lastRunDecision,
        metrics:
          recordOrNull(lastRunDecision.metrics) || recordOrEmpty(lastRunRecord.parsedMetrics),
        metricName: state.config.metricName,
        command: continuationCommands(workDir).partialResults,
      })
    : classifyPacketDiagnostics();
  const currentRuntimeProvenance = runtimeProvenance();
  const dashboardHealth = await dashboardHealthForWorkDir(workDir, PLUGIN_VERSION);
  const sourceCleanliness = buildSourceCleanliness({ warningDetails });
  const guidance = await decisionGuidance({
    workDir,
    config,
    state,
    scaffoldHealth,
    warningDetails,
  });
  const publicCommandAuthority = publicCommandPayload(guidance.commandAuthority);
  const publicPreflight = publicCommandPayload(guidance.preflight);
  const stateWithQualityGap = {
    ...buildSessionReadModelState({
      state,
      qualityGap,
      laneLifecycle,
      packetDiagnostics,
      runtimeProvenance: currentRuntimeProvenance,
      runtimeDriftSummary: guidance.runtimeDriftSummary,
      dashboardHealth,
      sourceCleanliness,
      gateQuality: guidance.gateQuality,
      preflight: publicPreflight,
    }),
    runtimeAuthority: guidance.runtimeAuthority,
    ledgerHealth,
  };
  const recipeSummaries = listBuiltInRecipes().map((recipe) => ({
    id: recipe.id,
    title: recipe.title,
    tags: recipe.tags || [],
  }));
  const partialResults = await discoverLastRunPartialResultsLazy(workDir, state, lastRun);
  const workflowFriction = analyzeWorkflowFriction({
    state: stateWithQualityGap,
    lastRun,
    warningDetails,
    recipes: recipeSummaries,
  });
  const experimentEconomics = analyzeExperimentEconomics({
    state: stateWithQualityGap,
    lastRun,
    progress: activeProgress || lastRunEvidence.progressSnapshot || null,
  });
  const readModel = buildSessionReadModel({
    workDir,
    config,
    state,
    records,
    codexGoalObjective,
    parallelLanes,
    workflowFriction,
    finalization,
    commands: continuationCommands(workDir),
    processProgress: activeProgress,
    qualityGap,
    laneLifecycle,
    packetDiagnostics,
    runtimeProvenance: currentRuntimeProvenance,
    runtimeDriftSummary: guidance.runtimeDriftSummary,
    dashboardHealth,
    sourceCleanliness,
    gateQuality: guidance.gateQuality,
    preflight: publicPreflight,
  });
  const controlPlane = readModel.controlPlane;
  const statusCounts = readModel.statusCounts;
  const portfolioRecommendation = recommendPortfolioDirection({
    runtimeDrift: guidance.runtimeDriftSummary,
    gateQuality: guidance.gateQuality,
    preflight: publicPreflight,
    laneLifecycle,
    laneResults: laneLifecycle.latestResults,
    packetDiagnostics,
    experimentMemory: memory,
    best: state.best,
    current: state.current,
  });
  const decisionPlan = compileSessionDecision(snapshot, {
    finalization,
    diagnostics: decisionDiagnosticsForStateFacts({
      guidance,
      packetDiagnostics,
      scaffoldHealth,
      sourceCleanliness,
      warningDetails,
    }),
  });
  const continuation = projectLoopContinuation(decisionPlan);
  const resolvedDecision = projectResolvedDecision(decisionPlan);
  const fullState = {
    ok: ledgerHealth.ok,
    ...(ledgerHealth.ok ? {} : { code: "ledger_jsonl_invalid" }),
    workDir,
    parseErrors: ledgerHealth.parseErrors,
    config: publicSessionConfig(state.config),
    segment: state.segment,
    runs: state.current.length,
    totalRuns: state.results.length,
    kept: statusCounts.keep,
    discarded: statusCounts.discard,
    measured: statusCounts.measure,
    crashed: statusCounts.crash,
    checksFailed: statusCounts.checks_failed,
    baseline: state.baseline,
    best: state.best,
    historicalBest: state.historicalBest,
    development: state.development,
    promotion: state.promotion,
    evidenceRegistry: state.evidenceRegistry,
    productClaimCoverage: state.productClaimCoverage,
    sessionDecisionCapsule: state.sessionDecisionCapsule || null,
    confidence: state.confidence,
    scaffoldHealth,
    researchIntegrity,
    runtimeProvenance: currentRuntimeProvenance,
    runtimeDriftSummary: guidance.runtimeDriftSummary,
    runtimeAuthority: guidance.runtimeAuthority,
    dashboardHealth,
    sourceCleanliness,
    ledgerHealth,
    gateQuality: guidance.gateQuality,
    fixedControl: fixedControlStateSummary(config.fixedControl),
    commandAuthority: publicCommandAuthority,
    preflight: publicPreflight,
    limit: iterationLimitInfo(state, config),
    settings: {
      autonomyMode: config.autonomyMode || "guarded",
      checksPolicy: config.checksPolicy || "always",
      keepPolicy: config.keepPolicy || "primary-only",
      dashboardRefreshSeconds: config.dashboardRefreshSeconds || 5,
      commitPaths: config.commitPaths || [],
    },
    commands: {
      ...dashboardCommands(workDir),
      primary: decisionPlan.action.command,
      ...(decisionPlan.action.kind === "replace-packet"
        ? { replaceLast: decisionPlan.action.command }
        : {}),
    },
    warnings: [...ledgerHealth.warnings, ...warningDetails.map((warning) => warning.message)],
    warningDetails,
    fanoutPlan,
    fanoutProvenance,
    parallelLanes,
    laneLifecycle,
    packetDiagnostics,
    metricSemanticsWarning: state.metricSemanticsWarning || null,
    commandExecutionBoundary: commandExecutionBoundaryForState(
      { state, lastRun },
      COMMAND_EXECUTION_BOUNDARY,
    ),
    portfolioRecommendation,
    finalizationPressure: finalization,
    ...controlPlane,
    watchdogSummary,
    memory,
    experimentEconomics,
    partialResults,
    workflowFriction,
    continuation,
    decisionPlan,
    resolvedDecision,
  };
  if (compact) return compactPublicState(fullState);
  return jsonFull || !bounded
    ? projectFullState(fullState)
    : projectStateReadModel(fullState, "default");
}

async function publicCompactState({
  snapshot,
  codexGoalObjective,
}: {
  snapshot: CoherentSessionSnapshot;
  codexGoalObjective?: unknown;
}): Promise<CommandRecord> {
  const { workDir, config } = snapshot;
  const records = snapshot.records;
  const state = stateFromSessionRecords(workDir, records);
  const ledgerHealth = analyzeLedgerHealth(records, {
    parseErrors: snapshot.sourceDiagnostics.ledgerIssues,
  });
  const lastRun = snapshot.lastRunPacket;
  const activeProgress = snapshot.processProgress;
  const replaceLastRunCommand = await replacementNextCommandForLastRun(workDir, lastRun);
  const qualityGap = await currentQualityGapSummary(workDir);
  const scaffoldHealth = await buildScaffoldHealth({ workDir, config });
  const researchIntegrity = buildResearchIntegrity({ state, config });
  const warningDetails = await operatorWarningsForWorkDir(workDir, state);
  const settings = buildDashboardSettings(config);
  const orchestration = buildParallelOrchestrationContext({
    workDir,
    state,
    config,
    settings,
    records,
  });
  const { memory, fanoutPlan, fanoutProvenance, parallelLanes, watchdogSummary } = orchestration;
  const laneLifecycle = buildLaneLifecycle({
    state,
    records,
    fanoutPlan,
    parallelLanes,
    laneResults: orchestration.laneResults,
    workDir,
    pluginRoot: PLUGIN_ROOT,
  });
  const lastRunDecision = recordOrEmpty(lastRun?.decision);
  const lastRunRecord = recordOrEmpty(lastRun?.run);
  const lastRunEvidence = recordOrEmpty(lastRun?.packetEvidence);
  const packetDiagnostics = lastRun
    ? classifyPacketDiagnostics({
        packetEvidence: lastRunEvidence,
        run: lastRunRecord,
        decision: lastRunDecision,
        metrics:
          recordOrNull(lastRunDecision.metrics) || recordOrEmpty(lastRunRecord.parsedMetrics),
        metricName: state.config.metricName,
        command: continuationCommands(workDir).partialResults,
      })
    : classifyPacketDiagnostics();
  const currentRuntimeProvenance = runtimeProvenance();
  const dashboardHealth = await dashboardHealthForWorkDir(workDir, PLUGIN_VERSION);
  const sourceCleanliness = buildSourceCleanliness({ warningDetails });
  const guidance = await decisionGuidance({
    workDir,
    config,
    state,
    scaffoldHealth,
    warningDetails,
  });
  const publicPreflight = publicCommandPayload(guidance.preflight);
  const stateWithQualityGap = {
    ...buildSessionReadModelState({
      state,
      qualityGap,
      laneLifecycle,
      packetDiagnostics,
      runtimeProvenance: currentRuntimeProvenance,
      runtimeDriftSummary: guidance.runtimeDriftSummary,
      dashboardHealth,
      sourceCleanliness,
      gateQuality: guidance.gateQuality,
      preflight: publicPreflight,
    }),
    runtimeAuthority: guidance.runtimeAuthority,
    ledgerHealth,
  };
  const partialResults = await discoverLastRunPartialResultsLazy(workDir, state, lastRun);
  const recipeSummaries = listBuiltInRecipes().map((recipe) => ({
    id: recipe.id,
    title: recipe.title,
    tags: recipe.tags || [],
  }));
  const workflowFriction = analyzeWorkflowFriction({
    state: stateWithQualityGap,
    lastRun,
    warningDetails,
    recipes: recipeSummaries,
  });
  const experimentEconomics = analyzeExperimentEconomics({
    state: stateWithQualityGap,
    lastRun,
    progress: activeProgress || lastRunEvidence.progressSnapshot || null,
  });
  const statusCounts = statusCountsFromState(state);
  const continuationCommandSet = continuationCommands(workDir);
  const compactCommands = {
    ...continuationCommandSet,
    ...(replaceLastRunCommand ? { replaceLast: replaceLastRunCommand } : {}),
  };
  const finalization = await finalizationPressureForWorkDir({
    workDir,
    state,
    qualityGap,
    warningDetails,
  });
  const readModel = buildSessionReadModel({
    workDir,
    config,
    state,
    records,
    codexGoalObjective,
    parallelLanes,
    workflowFriction,
    finalization,
    commands: continuationCommands(workDir),
    processProgress: activeProgress,
    qualityGap,
    laneLifecycle,
    packetDiagnostics,
    runtimeProvenance: currentRuntimeProvenance,
    runtimeDriftSummary: guidance.runtimeDriftSummary,
    dashboardHealth,
    sourceCleanliness,
    gateQuality: guidance.gateQuality,
    preflight: publicPreflight,
  });
  const controlPlane = readModel.controlPlane;
  const portfolioRecommendation = recommendPortfolioDirection({
    runtimeDrift: guidance.runtimeDriftSummary,
    gateQuality: guidance.gateQuality,
    preflight: publicPreflight,
    laneLifecycle,
    laneResults: laneLifecycle.latestResults,
    packetDiagnostics,
    experimentMemory: memory,
    best: state.best,
    current: state.current,
  });
  const decisionPlan = compileSessionDecision(snapshot, {
    finalization,
    diagnostics: decisionDiagnosticsForStateFacts({
      guidance,
      packetDiagnostics,
      scaffoldHealth,
      sourceCleanliness,
      warningDetails,
    }),
  });
  const continuation = projectLoopContinuation(decisionPlan);
  const resolvedDecision = projectResolvedDecision(decisionPlan);
  return compactPublicState({
    ok: ledgerHealth.ok,
    ...(ledgerHealth.ok ? {} : { code: "ledger_jsonl_invalid" }),
    workDir,
    parseErrors: ledgerHealth.parseErrors,
    config: publicSessionConfig(state.config),
    segment: state.segment,
    runs: state.current.length,
    totalRuns: state.results.length,
    kept: statusCounts.keep,
    discarded: statusCounts.discard,
    measured: statusCounts.measure,
    crashed: statusCounts.crash,
    checksFailed: statusCounts.checks_failed,
    baseline: state.baseline,
    best: state.best,
    historicalBest: state.historicalBest,
    development: state.development,
    promotion: state.promotion,
    evidenceRegistry: state.evidenceRegistry,
    productClaimCoverage: state.productClaimCoverage,
    sessionDecisionCapsule: state.sessionDecisionCapsule || null,
    confidence: state.confidence,
    scaffoldHealth,
    researchIntegrity,
    runtimeProvenance: currentRuntimeProvenance,
    runtimeDriftSummary: guidance.runtimeDriftSummary,
    runtimeAuthority: guidance.runtimeAuthority,
    dashboardHealth,
    sourceCleanliness,
    ledgerHealth,
    gateQuality: guidance.gateQuality,
    fixedControl: fixedControlStateSummary(config.fixedControl),
    preflight: publicPreflight,
    limit: iterationLimitInfo(state, config),
    settings: {
      autonomyMode: config.autonomyMode || "guarded",
      checksPolicy: config.checksPolicy || "always",
      keepPolicy: config.keepPolicy || "primary-only",
      dashboardRefreshSeconds: config.dashboardRefreshSeconds || 5,
      commitPaths: config.commitPaths || [],
    },
    commands: {
      ...compactCommands,
      primary: decisionPlan.action.command,
      ...(decisionPlan.action.kind === "replace-packet"
        ? { replaceLast: decisionPlan.action.command }
        : {}),
    },
    warnings: [...ledgerHealth.warnings, ...warningDetails.map((warning) => warning.message)],
    warningDetails,
    qualityGap,
    memory,
    fanoutPlan,
    fanoutProvenance,
    parallelLanes,
    watchdogSummary,
    laneLifecycle,
    packetDiagnostics,
    metricSemanticsWarning: state.metricSemanticsWarning || null,
    commandExecutionBoundary: commandExecutionBoundaryForState(
      { state, lastRun },
      COMMAND_EXECUTION_BOUNDARY,
    ),
    portfolioRecommendation,
    experimentEconomics,
    partialResults,
    workflowFriction,
    ...controlPlane,
    codexGoalObjective,
    continuation,
    decisionPlan,
    resolvedDecision,
  });
}

export async function finalizationPressureForWorkDir({
  workDir,
  state,
  qualityGap,
  warningDetails,
}: {
  workDir: string;
  state: CommandRecord;
  qualityGap: CommandRecord | null;
  warningDetails: CommandRecord[];
}): Promise<CommandRecord> {
  const cheap = buildCheapFinalizationPressure({ state, qualityGap, warningDetails });
  if (!hasFinalizationEvidence(state)) return cheap;
  return await buildFinalizePreviewLazy({ cwd: workDir }).catch((error: unknown) => ({
    ...cheap,
    ok: false,
    ready: false,
    warnings: [...(Array.isArray(cheap.warnings) ? cheap.warnings : []), errorMessage(error)],
    nextAction:
      cheap.nextAction || "Fix finalization preview errors before relying on review readiness.",
  }));
}

function hasFinalizationEvidence(state: CommandRecord): boolean {
  const runs = Array.isArray(state.results)
    ? state.results
    : Array.isArray(state.current)
      ? state.current
      : [];
  return runs.some((run: CommandRecord) => isAcceptedCurrentRun(run));
}

function publicSessionConfig(config: unknown): CommandRecord {
  const record = config && typeof config === "object" ? { ...(config as CommandRecord) } : {};
  const output = redactEvidenceObject(record) as CommandRecord;
  for (const field of [
    "benchmarkCommand",
    "benchmark_command",
    "checksCommand",
    "checks_command",
  ]) {
    if (typeof record[field] === "string") {
      output[field] = redactCommandDisplay(record[field]);
    }
  }
  if (Object.hasOwn(record, "fixedControl")) {
    output.fixedControl = fixedControlStateSummary(record.fixedControl);
  }
  return output;
}

function publicCommandPayload<T>(value: T): T {
  return redactEvidenceObject(value) as T;
}

export function compactPublicState(state: CommandRecord): CommandRecord {
  return projectStateReadModel(state, "compact");
}

function commandExecutionBoundaryForState(
  {
    state,
    lastRun,
  }: {
    state: CommandRecord;
    lastRun?: CommandRecord | null;
  },
  commandExecutionBoundary: CommandRecord,
): CommandRecord | null {
  const boundary =
    recordOrEmpty(lastRun?.packetEvidence).commandExecutionBoundary ||
    [...(Array.isArray(state.current) ? state.current : [])]
      .reverse()
      .map((run: CommandRecord) => run.commandExecutionBoundary)
      .find(Boolean);
  if (!boundary) return null;
  return {
    mode: String(boundary),
    note: commandExecutionBoundary.note,
    recommendation: commandExecutionBoundary.recommendation,
  };
}

async function dashboardHealthForWorkDir(
  workDir: string,
  pluginVersion: string,
): Promise<CommandRecord> {
  const record = await readServeRegistry(workDir);
  return verifyDashboardHealthSummary(
    buildServeRegistryHealthInput(workDir, record, {
      expectedVersion: pluginVersion,
      timeoutMs: 500,
    }),
  ) as unknown as CommandRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decisionDiagnosticsForStateFacts({
  guidance,
  packetDiagnostics,
  scaffoldHealth,
  sourceCleanliness,
  warningDetails,
}: {
  guidance: CommandRecord;
  packetDiagnostics: unknown;
  scaffoldHealth: CommandRecord;
  sourceCleanliness: unknown;
  warningDetails: CommandRecord[];
}): DecisionDiagnostic[] {
  const diagnostics: DecisionDiagnostic[] = [];
  const packetFacts = recordOrEmpty(packetDiagnostics);
  const cleanlinessFacts = recordOrEmpty(sourceCleanliness);
  const runtimeAuthority = recordOrEmpty(guidance.runtimeAuthority);
  if (runtimeAuthority.blocking === true) {
    diagnostics.push(
      decisionDiagnostic("runtime-integrity", {
        message: String(runtimeAuthority.blocker || "Runtime authority is not proven."),
      }),
    );
  }
  if (
    (Array.isArray(scaffoldHealth.checks) ? scaffoldHealth.checks : []).some(
      (value) => recordOrEmpty(value).severity === "blocker",
    )
  ) {
    diagnostics.push(
      decisionDiagnostic("scaffold-invalid", {
        message: "The session scaffold has a blocking integrity issue.",
      }),
    );
  }
  if (cleanlinessFacts.sourceDirty === true) {
    diagnostics.push(
      decisionDiagnostic("dirty-source", {
        message: "Review the dirty source tree before authorizing packet evidence.",
      }),
    );
  }
  const evaluatorDrift = warningDetails.find((warning) =>
    ["benchmark_contract_changed", "protected_benchmark_changed"].includes(
      String(warning.code || ""),
    ),
  );
  if (evaluatorDrift) {
    diagnostics.push(
      decisionDiagnostic("evaluator-drift", {
        message: String(evaluatorDrift.message || "The accepted evaluator has drifted."),
      }),
    );
  }
  if (packetFacts.unresolved === true && packetFacts.primaryStage) {
    diagnostics.push(
      decisionDiagnostic("packet-diagnostic", {
        message: String(packetFacts.recommendation || "Resolve the latest packet diagnostic."),
        command: String(packetFacts.command || ""),
        semantic: { primaryStage: String(packetFacts.primaryStage) },
      }),
    );
  }
  return diagnostics;
}

function recordOrEmpty(value: unknown): UnknownRecord {
  return recordOrNull(value) || {};
}

function coherentSnapshotOrNull(value: unknown): CoherentSessionSnapshot | null {
  const snapshot = recordOrNull(value);
  return snapshot?.kind === "coherent-session-snapshot" && snapshot.schemaVersion === 1
    ? (snapshot as unknown as CoherentSessionSnapshot)
    : null;
}
