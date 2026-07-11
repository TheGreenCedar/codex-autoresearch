import type { UnknownRecord } from "../types/json.js";
import { withCanonicalActionCommand } from "../action-metadata.js";
import { readActiveProgressSnapshot } from "../active-progress-store.js";
import { COMMAND_EXECUTION_BOUNDARY } from "../command-execution-boundary.js";
import {
  buildCheapFinalizationPressure,
  buildSessionReadModel,
  buildSessionReadModelState,
  projectFullState,
  projectStateReadModel,
  statusCountsFromState,
  withResolvedSessionDecision,
} from "../session-read-model.js";
import { analyzeExperimentEconomics } from "../experiment-economics.js";
import { analyzeLedgerHealth, readLedgerRecordsTolerant } from "../ledger-health.js";
import { analyzeWorkflowFriction } from "../workflow-friction.js";
import { boolOption } from "../cli/args.js";
import {
  buildDecisionEnvelope,
  createSessionReadCache,
  finiteMetric,
  iterationLimitInfo,
  loadSessionRecords,
  loadSessionState,
} from "../session-core.js";
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
import { continuationCommands, loopContinuation } from "./continuation.js";
import { fixedControlStateSummary } from "../fixed-control.js";
import { listBuiltInRecipes } from "../recipes.js";
import { recommendPortfolioDirection } from "../portfolio-advisor.js";
import { redactCommandDisplay, redactEvidenceObject } from "../evidence-redaction.js";
import { verifyDashboardHealthSummary } from "../dashboard-health.js";
import { resolveAuthorizedWorkDir } from "../cli/workdir-context.js";
import type { SessionReadCache } from "../session-records.js";
import {
  lastRunPacketFreshness,
  readLastRunPacket,
  replacementNextCommandForLastRun,
} from "../last-run-store.js";
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

function decisionSetupState(state: CommandRecord): CommandRecord | null {
  if (
    (Array.isArray(state.current) && state.current.length > 0) ||
    String(recordOrEmpty(state.config).name || "").trim()
  ) {
    return null;
  }
  return {
    stage: "needs-setup",
    blockers: [],
    nextAction: "Create or complete the session setup before running a baseline.",
  };
}

type CommandRecord = UnknownRecord;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
type FinalizePreviewModule = typeof import("../finalize-preview.js");
type PartialResultsModule = typeof import("../partial-results.js");

async function buildFinalizePreviewLazy(
  ...args: Parameters<FinalizePreviewModule["finalizePreview"]>
): Promise<Awaited<ReturnType<FinalizePreviewModule["finalizePreview"]>>> {
  return (await import("../finalize-preview.js")).finalizePreview(...args);
}

async function discoverLastRunPartialResults(
  workDir: string,
  state: CommandRecord,
  lastRun: CommandRecord | null,
) {
  if (!lastRun || !partialResultEligiblePacket(lastRun)) {
    return { candidates: [], skippedArtifacts: [] };
  }
  return await discoverPartialResultCandidatesLazy({
    workDir,
    primaryMetricName: String(recordOrEmpty(state.config).metricName || "metric"),
    lastRunPacket: lastRun,
  }).catch((error: unknown) => ({
    candidates: [],
    skippedArtifacts: [
      {
        artifactName: "last-run",
        artifactPath: lastRun.lastRunPath || "",
        reason: errorMessage(error),
      },
    ],
  }));
}

async function discoverPartialResultCandidatesLazy(
  ...args: Parameters<PartialResultsModule["discoverPartialResultCandidates"]>
): Promise<Awaited<ReturnType<PartialResultsModule["discoverPartialResultCandidates"]>>> {
  return (await import("../partial-results.js")).discoverPartialResultCandidates(...args);
}

function partialResultEligiblePacket(packet: CommandRecord): boolean {
  const run = recordOrEmpty(packet.run);
  const packetEvidence = recordOrEmpty(packet.packetEvidence);
  if (packet.ok === false || run.timedOut === true || packetEvidence.timedOut === true) return true;
  const exitCode = finiteMetric(run.exitCode ?? packetEvidence.exitStatus);
  return exitCode != null && exitCode !== 0;
}

export async function publicState(args: CommandRecord): Promise<CommandRecord> {
  const { workDir, config } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  const compact = boolOption(args.compact, false);
  const report = boolOption(args.report, false);
  const jsonFull = boolOption(args.jsonFull ?? args.json_full ?? args.full, false);
  const bounded = boolOption(args.bounded, false);
  const codexGoalObjective = args.codexGoalObjective || args.codex_goal_objective;
  const readCache = (args.readCache || createSessionReadCache()) as SessionReadCache;
  if (compact || report) {
    let compactState: CommandRecord;
    try {
      compactState = await publicCompactState({ workDir, config, codexGoalObjective, readCache });
    } catch (error) {
      if (!isStrictLedgerParseError(error)) throw error;
      compactState = repairFirstStateForInvalidLedger({
        workDir,
        config,
        codexGoalObjective,
        error,
        compact: true,
      });
    }
    if (!report) return compactState;
    const response: CommandRecord = {
      ok: compactState.ok !== false,
      workDir,
      report: buildTerminalReport(compactState),
    };
    if (compact) response.compactState = compactState;
    return response;
  }

  let state: ReturnType<typeof loadSessionState>;
  let records: ReturnType<typeof loadSessionRecords>;
  try {
    state = loadSessionState(workDir, readCache);
    records = loadSessionRecords(workDir, readCache);
  } catch (error) {
    if (!isStrictLedgerParseError(error)) throw error;
    const repairState = repairFirstStateForInvalidLedger({
      workDir,
      config,
      codexGoalObjective,
      error,
      compact: false,
    });
    return jsonFull || !bounded
      ? projectFullState(repairState)
      : projectStateReadModel(repairState, "default");
  }
  const ledgerHealth = analyzeLedgerHealth(records);
  const scaffoldHealth = await buildScaffoldHealth({ workDir, config });
  const researchIntegrity = buildResearchIntegrity({ state, config });
  const warningDetails = await operatorWarningsForWorkDir(workDir, state);
  const lastRun = await readLastRunPacket(workDir).catch((): null => null);
  const activeProgress = await readActiveProgressSnapshot(workDir, config);
  const lastRunFreshness = lastRun ? await lastRunPacketFreshness(workDir, lastRun) : null;
  const replaceLastRunCommand = await replacementNextCommandForLastRun(workDir, lastRun);
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
  const partialResults = await discoverLastRunPartialResults(workDir, state, lastRun);
  const workflowFriction = analyzeWorkflowFriction({
    state: stateWithQualityGap,
    lastRun,
    warningDetails,
    recipes: recipeSummaries,
  });
  const experimentEconomics = analyzeExperimentEconomics({
    state: stateWithQualityGap,
    lastRun,
    progress:
      activeProgress ||
      (await readActiveProgressSnapshot(workDir, config)) ||
      lastRunEvidence.progressSnapshot ||
      null,
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
  const continuation = loopContinuation(workDir, state, config, "state");
  const stateCommands = {
    ...continuation.commands,
    ...(replaceLastRunCommand ? { replaceLast: replaceLastRunCommand } : {}),
  };
  const decisionInput = {
    state: {
      ...stateWithQualityGap,
      ...controlPlane,
      limit: iterationLimitInfo(state, config),
    },
    nextAction: continuation.nextAction,
    lastRunFreshness,
    warningDetails,
    scaffoldHealth,
    researchIntegrity,
    qualityGap,
    finalization,
    experimentEconomics,
    salvageCandidates: partialResults.candidates,
    workflowFriction,
    experimentMemory: memory,
    setupState: decisionSetupState(state),
    watchdog: watchdogSummary,
  };
  const preliminaryDecisionEnvelope = buildDecisionEnvelope(decisionInput);
  const portfolioRecommendation =
    preliminaryDecisionEnvelope.loopContract?.canRunNextPacket === false
      ? null
      : recommendPortfolioDirection({
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
  const decisionEnvelope = withCanonicalActionCommand(
    portfolioRecommendation
      ? buildDecisionEnvelope({
          ...decisionInput,
          state: { ...decisionInput.state, portfolioRecommendation },
        })
      : preliminaryDecisionEnvelope,
    stateCommands,
  );
  const loopContract = recordOrEmpty(decisionEnvelope.loopContract);
  const resolvedReadModel = withResolvedSessionDecision(readModel, {
    state: {
      decisionEnvelope,
      blockers: Array.isArray(loopContract.blockers) ? loopContract.blockers : [],
    },
    decisionEnvelope,
    commands: stateCommands,
    runtimeProvenance: currentRuntimeProvenance,
    finalization,
  });
  const fullState = {
    ok: true,
    workDir,
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
    commands: dashboardCommands(workDir),
    warnings: warningDetails.map((warning) => warning.message),
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
    qualityRound: decisionEnvelope.qualityRound || null,
    ...controlPlane,
    watchdogSummary,
    memory,
    experimentEconomics,
    partialResults,
    workflowFriction,
    continuation,
    resolvedDecision: resolvedReadModel.resolvedDecision,
    resumeAudit: decisionEnvelope,
    decisionEnvelope,
  };
  if (compact) return compactPublicState(fullState);
  return jsonFull || !bounded
    ? projectFullState(fullState)
    : projectStateReadModel(fullState, "default");
}

function isStrictLedgerParseError(error: unknown): boolean {
  return /^Corrupt autoresearch\.jsonl at line \d+\b/i.test(errorMessage(error));
}

function repairFirstStateForInvalidLedger({
  workDir,
  config,
  codexGoalObjective,
  error,
  compact,
}: {
  workDir: string;
  config: CommandRecord;
  codexGoalObjective?: unknown;
  error: unknown;
  compact: boolean;
}): CommandRecord {
  const ledger = readLedgerRecordsTolerant(workDir);
  const rawLedgerHealth = analyzeLedgerHealth(ledger.records, {
    parseErrors: ledger.parseErrors,
  });
  const commands = continuationCommands(workDir);
  const ledgerHealth = {
    ...rawLedgerHealth,
    command: commands.ledgerDoctor,
  };
  const runtimeFacts = runtimeProvenance();
  const decisionEnvelope = withCanonicalActionCommand(
    buildDecisionEnvelope({
      state: {
        config,
        current: [],
        results: [],
        ledgerHealth,
        runtimeProvenance: runtimeFacts,
      },
      nextAction: "Run ledger-doctor before another Autoresearch packet.",
    }),
    commands,
  );
  const response = {
    ok: false,
    code: "ledger_jsonl_invalid",
    workDir,
    config: publicSessionConfig(config),
    segment: 0,
    runs: ledger.records.length,
    totalRuns: ledger.records.length,
    kept: 0,
    discarded: 0,
    measured: 0,
    crashed: 0,
    checksFailed: 0,
    baseline: null,
    best: null,
    historicalBest: null,
    development: null,
    promotion: null,
    confidence: null,
    ledgerPath: ledger.ledgerPath,
    ledgerHealth,
    parseErrors: ledgerHealth.parseErrors,
    warnings: ledgerHealth.warnings,
    error: errorMessage(error),
    commands,
    continuation: {
      shouldContinue: false,
      nextAction: "Run ledger-doctor before another packet.",
      commands,
    },
    nextAction: "Run ledger-doctor before another packet.",
    blockers: ledgerHealth.warnings,
    runtimeProvenance: runtimeFacts,
    codexGoalObjective,
    resumeAudit: decisionEnvelope,
    decisionEnvelope,
    canonicalNextAction: decisionEnvelope.canonicalNextAction,
    loopContract: decisionEnvelope.loopContract,
  };
  return compact ? compactPublicState(response) : projectFullState(response);
}

async function publicCompactState({
  workDir,
  config,
  codexGoalObjective,
  readCache,
}: {
  workDir: string;
  config: CommandRecord;
  codexGoalObjective?: unknown;
  readCache?: unknown;
}): Promise<CommandRecord> {
  const effectiveReadCache = (readCache || createSessionReadCache()) as SessionReadCache;
  const state = loadSessionState(workDir, effectiveReadCache);
  const records = loadSessionRecords(workDir, effectiveReadCache);
  const ledgerHealth = analyzeLedgerHealth(records);
  const lastRun = await readLastRunPacket(workDir).catch((): null => null);
  const activeProgress = await readActiveProgressSnapshot(workDir, config);
  const lastRunFreshness = lastRun ? await lastRunPacketFreshness(workDir, lastRun) : null;
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
  const partialResults = await discoverLastRunPartialResults(workDir, state, lastRun);
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
  const continuation = loopContinuation(workDir, state, config, "state");
  const compactCommands = {
    ...continuation.commands,
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
  const decisionInput = {
    state: {
      ...stateWithQualityGap,
      ...controlPlane,
      limit: iterationLimitInfo(state, config),
    },
    nextAction: continuation.nextAction,
    lastRunFreshness,
    warningDetails,
    scaffoldHealth,
    researchIntegrity,
    qualityGap,
    finalization,
    experimentEconomics,
    salvageCandidates: partialResults.candidates,
    workflowFriction,
    experimentMemory: memory,
    setupState: decisionSetupState(state),
    watchdog: watchdogSummary,
  };
  const preliminaryDecisionEnvelope = buildDecisionEnvelope(decisionInput);
  const portfolioRecommendation =
    preliminaryDecisionEnvelope.loopContract?.canRunNextPacket === false
      ? null
      : recommendPortfolioDirection({
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
  const decisionEnvelope = withCanonicalActionCommand(
    portfolioRecommendation
      ? buildDecisionEnvelope({
          ...decisionInput,
          state: { ...decisionInput.state, portfolioRecommendation },
        })
      : preliminaryDecisionEnvelope,
    compactCommands,
  );
  return compactPublicState({
    ok: true,
    workDir,
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
    commands: compactCommands,
    warnings: warningDetails.map((warning) => warning.message),
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
    resumeAudit: decisionEnvelope,
    decisionEnvelope,
    continuation,
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

function recordOrNull(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function recordOrEmpty(value: unknown): UnknownRecord {
  return recordOrNull(value) || {};
}
