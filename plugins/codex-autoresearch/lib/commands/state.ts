import type { UnknownRecord } from "../types/json.js";
import { compactFinalizationReadiness } from "../state-finalization-readout.js";

type JsonObject = Record<string, unknown>;

export interface CompactStateBuilderInput {
  ok?: boolean;
  workDir: string;
  name?: string;
  goal?: string;
  metric?: string;
  direction?: string;
  segment?: number;
  runs?: number;
  kept?: number;
  discarded?: number;
  measured?: number;
  baseline?: unknown;
  best?: unknown;
  historicalBest?: unknown;
  developmentBest?: unknown;
  promotionBest?: unknown;
  goalFrame?: unknown;
  goalContract?: unknown;
  operatorHandoff?: unknown;
  evidenceRegistry?: unknown;
  productClaimCoverage?: unknown;
  sessionDecisionCapsule?: unknown;
  evidenceLabels?: unknown[];
  scaffoldHealth?: unknown;
  researchIntegrity?: unknown;
  limitReached?: boolean;
  remainingIterations?: unknown;
  nextAction?: string;
  shouldContinue?: boolean;
  canRunNextPacket?: boolean;
  forbidFinalAnswer?: boolean;
  activeBudget?: boolean;
  requiresLogDecision?: boolean;
  afterLogAction?: string;
  finalAnswerPolicy?: string;
  parallelLanes?: unknown[];
  fanoutPlan?: unknown;
  fanoutProvenance?: unknown;
  watchdogSummary?: unknown;
  blockers?: unknown[];
  goalAdvice?: unknown;
  report?: unknown;
  memory?: unknown;
  experimentEconomics?: unknown;
  partialResults?: unknown;
  commandExecutionBoundary?: unknown;
  workflowFriction?: unknown[];
  commands?: JsonObject;
  resumeAudit?: unknown;
  decisionEnvelope?: unknown;
  canonicalNextAction?: unknown;
  runtimeProvenance?: unknown;
  runtimeDriftSummary?: unknown;
  runtimeAuthority?: unknown;
  dashboardHealth?: unknown;
  sourceCleanliness?: unknown;
  ledgerHealth?: unknown;
  gateQuality?: unknown;
  preflight?: unknown;
  portfolioRecommendation?: unknown;
  loopContract?: unknown;
  approvalLedger?: unknown;
  resourcePreflight?: unknown;
  evidenceMaturity?: unknown;
  laneOrchestration?: unknown;
  finalizationRunway?: unknown;
  operatorReadout?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  metricSemanticsWarning?: unknown;
  fixedControl?: unknown;
}

const OPTIONAL_COMPACT_STATE_FIELDS = [
  "runtimeProvenance",
  "runtimeDriftSummary",
  "runtimeAuthority",
  "dashboardHealth",
  "sourceCleanliness",
  "ledgerHealth",
  "gateQuality",
  "preflight",
  "portfolioRecommendation",
  "loopContract",
  "approvalLedger",
  "resourcePreflight",
  "evidenceMaturity",
  "laneOrchestration",
  "finalizationRunway",
  "operatorReadout",
  "laneLifecycle",
  "packetDiagnostics",
  "commandExecutionBoundary",
  "metricSemanticsWarning",
  "fixedControl",
] as const satisfies readonly (keyof CompactStateBuilderInput)[];

export interface CompactStateResponse {
  ok: boolean;
  workDir: string;
  name: string;
  goal: string;
  metric: string;
  direction: string;
  segment: number;
  runs: number;
  kept: number;
  discarded: number;
  measured: number;
  baseline: unknown;
  best: unknown;
  historicalBest: unknown;
  developmentBest: unknown;
  promotionBest: unknown;
  goalFrame: unknown;
  goalContract: unknown;
  operatorHandoff: unknown;
  evidenceRegistry: unknown;
  productClaimCoverage: unknown;
  sessionDecisionCapsule: unknown;
  evidenceLabels: unknown[];
  scaffoldHealth: unknown;
  researchIntegrity: unknown;
  limitReached: boolean;
  remainingIterations: unknown;
  nextAction: string;
  shouldContinue: boolean;
  canRunNextPacket: boolean;
  forbidFinalAnswer: boolean;
  activeBudget: boolean;
  requiresLogDecision: boolean;
  afterLogAction: string;
  finalAnswerPolicy: string;
  parallelLanes: unknown[];
  fanoutPlan: unknown;
  fanoutProvenance: unknown;
  watchdogSummary: unknown;
  blockers: unknown[];
  goalAdvice: unknown;
  report: unknown;
  memory: unknown;
  experimentEconomics: unknown;
  partialResults: unknown;
  commandExecutionBoundary?: unknown;
  workflowFriction: unknown[];
  commands: JsonObject;
  resumeAudit: unknown;
  decisionEnvelope: unknown;
  canonicalNextAction: unknown;
  runtimeProvenance?: unknown;
  runtimeDriftSummary?: unknown;
  runtimeAuthority?: unknown;
  dashboardHealth?: unknown;
  sourceCleanliness?: unknown;
  ledgerHealth?: unknown;
  gateQuality?: unknown;
  preflight?: unknown;
  portfolioRecommendation?: unknown;
  loopContract?: unknown;
  approvalLedger?: unknown;
  resourcePreflight?: unknown;
  evidenceMaturity?: unknown;
  laneOrchestration?: unknown;
  finalizationRunway?: unknown;
  operatorReadout?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  metricSemanticsWarning?: unknown;
  fixedControl?: unknown;
}

export function buildCompactStateResponse(input: CompactStateBuilderInput): CompactStateResponse {
  const response: CompactStateResponse = {
    ok: input.ok ?? true,
    workDir: input.workDir,
    name: input.name || "Autoresearch",
    goal: input.goal || "",
    metric: input.metric || "metric",
    direction: input.direction || "lower",
    segment: input.segment ?? 0,
    runs: input.runs ?? 0,
    kept: input.kept ?? 0,
    discarded: input.discarded ?? 0,
    measured: input.measured ?? 0,
    baseline: input.baseline ?? null,
    best: input.best ?? null,
    historicalBest: input.historicalBest ?? null,
    developmentBest: input.developmentBest ?? null,
    promotionBest: input.promotionBest ?? null,
    goalFrame: input.goalFrame ?? null,
    goalContract: input.goalContract ?? null,
    operatorHandoff: input.operatorHandoff ?? null,
    evidenceRegistry: input.evidenceRegistry ?? null,
    productClaimCoverage: input.productClaimCoverage ?? null,
    sessionDecisionCapsule: input.sessionDecisionCapsule ?? null,
    evidenceLabels: Array.isArray(input.evidenceLabels) ? input.evidenceLabels : [],
    scaffoldHealth: input.scaffoldHealth ?? null,
    researchIntegrity: input.researchIntegrity ?? null,
    limitReached: input.limitReached === true,
    remainingIterations: input.remainingIterations ?? null,
    nextAction: input.nextAction || "Run doctor, then next.",
    shouldContinue: input.shouldContinue === true,
    canRunNextPacket: input.canRunNextPacket === true,
    forbidFinalAnswer: input.forbidFinalAnswer === true,
    activeBudget: input.activeBudget === true,
    requiresLogDecision: input.requiresLogDecision === true,
    afterLogAction: input.afterLogAction || "",
    finalAnswerPolicy: input.finalAnswerPolicy || "",
    parallelLanes: Array.isArray(input.parallelLanes) ? input.parallelLanes : [],
    fanoutPlan: input.fanoutPlan ?? null,
    fanoutProvenance: input.fanoutProvenance ?? null,
    watchdogSummary: input.watchdogSummary ?? null,
    blockers: Array.isArray(input.blockers) ? input.blockers : [],
    goalAdvice: input.goalAdvice ?? null,
    report: input.report ?? null,
    memory: input.memory ?? null,
    experimentEconomics: input.experimentEconomics ?? null,
    partialResults: input.partialResults ?? null,
    workflowFriction: Array.isArray(input.workflowFriction) ? input.workflowFriction : [],
    commands: input.commands || {},
    resumeAudit: input.resumeAudit ?? null,
    decisionEnvelope: input.decisionEnvelope ?? input.resumeAudit ?? null,
    canonicalNextAction: input.canonicalNextAction ?? null,
  };

  for (const field of OPTIONAL_COMPACT_STATE_FIELDS) {
    copyIfProvided(response, field, input[field]);
  }

  return response;
}

function copyIfProvided<T extends object>(target: T, key: string, value: unknown) {
  if (value !== undefined) (target as JsonObject)[key] = value;
}

function decisionSetupState(state: CommandRecord): CommandRecord | null {
  if (state.current?.length > 0 || String(state.config?.name || "").trim()) return null;
  return {
    stage: "needs-setup",
    blockers: [],
    nextAction: "Create or complete the session setup before running a baseline.",
  };
}

type CommandRecord = UnknownRecord & Record<string, any>;

export type StateCommandServiceDeps = Record<string, any>;

export function createStateCommandService(deps: StateCommandServiceDeps) {
  const {
    actionMessage,
    analyzeExperimentEconomics,
    analyzeLedgerHealth,
    analyzeWorkflowFriction,
    boolOption,
    buildCheapFinalizationPressure,
    buildDecisionEnvelope,
    buildFinalizePreview,
    buildGoalContract,
    buildGoalFrame,
    buildLaneLifecycle,
    buildParallelOrchestrationContext,
    buildScaffoldHealth,
    buildServeRegistryHealthInput,
    buildSessionReadModel,
    buildSessionReadModelState,
    buildSourceCleanliness,
    buildResearchIntegrity,
    buildTerminalReport,
    classifyPacketDiagnostics,
    continuationCommands,
    createSessionReadCache,
    currentQualityGapSummary,
    dashboardCommands,
    dashboardSettings,
    decisionGuidance,
    discoverLastRunPartialResults,
    errorMessage,
    fixedControlStateSummary,
    isAcceptedCurrentRun,
    isPacketBrakeKind,
    iterationLimitInfo,
    lastRunPacketFreshness,
    listBuiltInRecipes,
    loadSessionRecords,
    loadSessionState,
    loopContinuation,
    operatorWarningsForWorkDir,
    readActiveProgressSnapshot,
    readLastRunPacket,
    readLedgerRecordsTolerant,
    readServeRegistry,
    recommendPortfolioDirection,
    redactCommandDisplay,
    redactEvidenceObject,
    replacementNextCommandForLastRun,
    resolveWorkDir,
    runtimeProvenance,
    statusCountsFromState,
    uniqueStrings,
    verifyDashboardHealthSummary,
    withCanonicalActionCommand,
  } = deps;
  const COMMAND_EXECUTION_BOUNDARY = deps.commandExecutionBoundary;
  const PENDING_LOG_TRANSACTION_CODE = deps.pendingLogTransactionCode;
  const PLUGIN_ROOT = deps.pluginRoot;
  const PLUGIN_VERSION = deps.pluginVersion;

  async function publicState(args: CommandRecord): Promise<CommandRecord> {
    const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
    const compact = boolOption(args.compact, false);
    const report = boolOption(args.report, false);
    const codexGoalObjective = args.codexGoalObjective || args.codex_goal_objective;
    const readCache = args.readCache || createSessionReadCache();
    if (compact || report) {
      let compactState: CommandRecord;
      try {
        compactState = await publicCompactState({
          workDir,
          config,
          codexGoalObjective,
          readCache,
        });
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
      return repairFirstStateForInvalidLedger({
        workDir,
        config,
        codexGoalObjective,
        error,
        compact: false,
      });
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
    const settings = dashboardSettings(config);
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
    const packetDiagnostics = lastRun
      ? classifyPacketDiagnostics({
          packetEvidence: lastRun.packetEvidence || {},
          run: lastRun.run || {},
          decision: lastRun.decision || {},
          metrics: lastRun.decision?.metrics || lastRun.run?.parsedMetrics || {},
          metricName: state.config.metricName,
          command: continuationCommands(workDir).partialResults,
        })
      : classifyPacketDiagnostics();
    const currentRuntimeProvenance = runtimeProvenance();
    const dashboardHealth = await dashboardHealthForWorkDir(workDir);
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
    const recipeSummaries = listBuiltInRecipes().map((recipe: any) => ({
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
        lastRun?.packetEvidence?.progressSnapshot ||
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
      warnings: warningDetails.map((warning: any) => warning.message),
      warningDetails,
      fanoutPlan,
      fanoutProvenance,
      parallelLanes,
      laneLifecycle,
      packetDiagnostics,
      metricSemanticsWarning: state.metricSemanticsWarning || null,
      commandExecutionBoundary: commandExecutionBoundaryForState({ state, lastRun }),
      portfolioRecommendation,
      ...controlPlane,
      watchdogSummary,
      memory,
      experimentEconomics,
      partialResults,
      workflowFriction,
      continuation,
      resumeAudit: decisionEnvelope,
      decisionEnvelope,
    };
    return compact ? compactPublicState(fullState) : fullState;
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
    const runtime = runtimeProvenance();
    const decisionEnvelope = withCanonicalActionCommand(
      buildDecisionEnvelope({
        state: {
          config,
          current: [],
          results: [],
          ledgerHealth,
          runtimeProvenance: runtime,
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
      runtimeProvenance: runtime,
      codexGoalObjective,
      resumeAudit: decisionEnvelope,
      decisionEnvelope,
      canonicalNextAction: decisionEnvelope.canonicalNextAction,
      loopContract: decisionEnvelope.loopContract,
    };
    return compact ? compactPublicState(response) : response;
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
    const effectiveReadCache = (readCache || createSessionReadCache()) as any;
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
    const settings = dashboardSettings(config);
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
    const packetDiagnostics = lastRun
      ? classifyPacketDiagnostics({
          packetEvidence: lastRun.packetEvidence || {},
          run: lastRun.run || {},
          decision: lastRun.decision || {},
          metrics: lastRun.decision?.metrics || lastRun.run?.parsedMetrics || {},
          metricName: state.config.metricName,
          command: continuationCommands(workDir).partialResults,
        })
      : classifyPacketDiagnostics();
    const currentRuntimeProvenance = runtimeProvenance();
    const dashboardHealth = await dashboardHealthForWorkDir(workDir);
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
    const recipeSummaries = listBuiltInRecipes().map((recipe: any) => ({
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
      progress: activeProgress || lastRun?.packetEvidence?.progressSnapshot || null,
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
      warnings: warningDetails.map((warning: any) => warning.message),
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
      commandExecutionBoundary: commandExecutionBoundaryForState({ state, lastRun }),
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

  async function finalizationPressureForWorkDir({
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
    return await buildFinalizePreview({ cwd: workDir }).catch((error: any) => ({
      ...cheap,
      ok: false,
      ready: false,
      warnings: [...(cheap.warnings || []), error.message],
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

  function compactPublicState(state: CommandRecord): CommandRecord {
    const limit = state.limit || {};
    const continuation = state.continuation || {};
    const compactDecisionEnvelope = compactEnvelope(state.decisionEnvelope || state.resumeAudit);
    const canonicalNextAction =
      compactDecisionEnvelope?.canonicalNextAction ||
      state.decisionEnvelope?.canonicalNextAction ||
      state.resumeAudit?.canonicalNextAction ||
      null;
    const canonicalReason =
      canonicalNextAction?.reason ||
      compactDecisionEnvelope?.nextAction ||
      continuation.nextAction ||
      "Run doctor, then next.";
    const loopBlockers = Array.isArray(compactDecisionEnvelope?.loopContract?.blockers)
      ? compactDecisionEnvelope.loopContract.blockers.map(actionMessage).filter(Boolean)
      : [];
    const canonicalBlocker =
      canonicalNextAction && isPacketBrakeKind(canonicalNextAction.kind)
        ? actionMessage(canonicalNextAction)
        : "";
    const warningBlockers = Array.isArray(state.warningDetails)
      ? state.warningDetails
          .filter((warning: any) =>
            ["git_dirty", "missing_commit_paths", PENDING_LOG_TRANSACTION_CODE].includes(
              String(warning?.code || ""),
            ),
          )
          .map((warning: any) => warning.message || warning.code)
      : [];
    const blockers = uniqueStrings(
      [...loopBlockers, canonicalBlocker, ...warningBlockers].filter(Boolean),
    );
    const goalFrame = buildGoalFrame({
      autoresearchGoal: state.config?.goal,
      codexGoalObjective: state.codexGoalObjective,
    });
    const goalContract =
      state.goalContract ||
      buildGoalContract({
        autoresearchGoal: state.config?.goal,
        codexGoalObjective: state.codexGoalObjective,
        benchmarkGoal: state.config?.benchmarkGoal || state.config?.goal,
        finalizationClaim: state.config?.finalizationClaim,
        recoveryCommand: state.commands?.codexGoalBrief || state.commands?.state,
      });
    const operatorHandoff = {
      goal: goalFrame.operatorLine,
      next: canonicalReason,
      blocker: blockers[0] || "",
      command: canonicalNextAction?.command || continuation.commands?.next || "",
    };
    return buildCompactStateResponse({
      ok: state.ok,
      workDir: state.workDir,
      name: state.config?.name || "Autoresearch",
      goal: state.config?.goal || "",
      metric: state.config?.metricName || "metric",
      direction: state.config?.bestDirection || "lower",
      segment: state.segment,
      runs: state.runs,
      kept: state.kept,
      discarded: state.discarded,
      measured: state.measured,
      baseline: state.baseline,
      best: state.best,
      historicalBest: state.historicalBest ?? null,
      developmentBest: state.development?.best ?? null,
      promotionBest: state.promotion?.best ?? null,
      goalFrame,
      goalContract,
      operatorHandoff,
      evidenceRegistry: state.evidenceRegistry
        ? {
            counts: state.evidenceRegistry.counts,
            acceptedCurrent: Array.isArray(state.evidenceRegistry.acceptedCurrent)
              ? state.evidenceRegistry.acceptedCurrent.length
              : 0,
            currentArtifacts: Array.isArray(state.evidenceRegistry.currentArtifacts)
              ? state.evidenceRegistry.currentArtifacts.slice(0, 5)
              : [],
          }
        : null,
      productClaimCoverage: state.productClaimCoverage || null,
      sessionDecisionCapsule:
        state.sessionDecisionCapsule || compactDecisionEnvelope?.sessionDecisionCapsule || null,
      evidenceLabels: state.researchIntegrity?.evidenceLabels || [],
      scaffoldHealth: state.scaffoldHealth
        ? {
            ok: state.scaffoldHealth.ok,
            status: state.scaffoldHealth.status,
            blockers: (state.scaffoldHealth.checks || [])
              .filter((check: any) => check.severity === "blocker")
              .map((check: any) => check.message || check.code),
          }
        : null,
      researchIntegrity: state.researchIntegrity
        ? {
            ok: state.researchIntegrity.ok,
            currentLabel: state.researchIntegrity.currentLabel,
            evidenceLabels: state.researchIntegrity.evidenceLabels || [],
            notPromotableBecause: state.researchIntegrity.notPromotableBecause || [],
          }
        : null,
      limitReached: Boolean(limit.limitReached),
      remainingIterations: limit.remainingIterations ?? null,
      nextAction: canonicalReason,
      shouldContinue: continuation.shouldContinue === true,
      canRunNextPacket: compactDecisionEnvelope?.loopContract?.canRunNextPacket === true,
      forbidFinalAnswer: continuation.forbidFinalAnswer === true,
      activeBudget: continuation.activeBudget === true,
      requiresLogDecision: continuation.requiresLogDecision === true,
      afterLogAction: continuation.afterLogAction || "",
      finalAnswerPolicy: continuation.finalAnswerPolicy || "",
      parallelLanes: Array.isArray(state.parallelLanes)
        ? state.parallelLanes.slice(0, 6).map((lane: any) => ({
            id: lane.id,
            title: lane.title || lane.label,
            status: lane.status,
            mode: lane.mode,
            evidenceStatus: lane.evidenceStatus,
            nextActionHint: lane.nextActionHint,
            brief: lane.brief || null,
          }))
        : [],
      fanoutPlan: state.fanoutPlan
        ? {
            id: state.fanoutPlan.id,
            status: state.fanoutPlan.status,
            segment: state.fanoutPlan.segment ?? state.segment,
            nextAction: state.fanoutPlan.nextAction,
          }
        : null,
      fanoutProvenance: state.fanoutProvenance || null,
      watchdogSummary: state.watchdogSummary
        ? {
            stale: state.watchdogSummary.stale === true,
            status: state.watchdogSummary.status || "",
            recommendation: state.watchdogSummary.recommendation || "",
            quietHours: state.watchdogSummary.quietHours ?? null,
          }
        : state.decisionEnvelope?.watchdog || null,
      blockers: [...new Set(blockers)].slice(0, 6),
      goalAdvice: compactDecisionEnvelope?.goalAdvice || null,
      report: {
        happened: `${state.runs} run${state.runs === 1 ? "" : "s"} in this segment; ${state.kept} kept, ${state.discarded} discarded, ${state.measured} measured, ${state.crashed} crashed, ${state.checksFailed} checks failed.`,
        decision:
          continuation.requiresLogDecision === true
            ? "A packet is waiting for a keep/discard/measure/crash/checks_failed log decision."
            : state.best == null
              ? "No best metric yet."
              : `Best ${state.config?.metricName || "metric"} is ${state.best}.`,
        next: canonicalReason,
      },
      memory: {
        plateau: state.memory?.plateau?.detected === true,
        suggestedLane: state.memory?.summary?.suggestedLane || "",
        latestNextAction: state.memory?.latestNextAction || "",
        exhaustedFamilies: Array.isArray(state.memory?.exhaustedFamilies)
          ? state.memory.exhaustedFamilies.slice(0, 3)
          : [],
        metricShelves: Array.isArray(state.memory?.metricShelves)
          ? state.memory.metricShelves.slice(0, 3)
          : [],
      },
      experimentEconomics: state.experimentEconomics
        ? {
            runtimeClass: state.experimentEconomics.runtimeClass,
            expectedRuntimeSeconds: state.experimentEconomics.expectedRuntimeSeconds ?? null,
            baselineFreshness: state.experimentEconomics.baselineFreshness,
            freshRunRequired: state.experimentEconomics.freshRunRequired === true,
            freshRunReason: state.experimentEconomics.freshRunReason || "",
            warnings: Array.isArray(state.experimentEconomics.warnings)
              ? state.experimentEconomics.warnings.slice(0, 3)
              : [],
            progress: state.experimentEconomics.progress || null,
          }
        : null,
      partialResults: {
        candidates: Array.isArray(state.partialResults?.candidates)
          ? state.partialResults.candidates.slice(0, 5)
          : [],
        skippedArtifacts: Array.isArray(state.partialResults?.skippedArtifacts)
          ? state.partialResults.skippedArtifacts.slice(0, 5)
          : [],
      },
      commandExecutionBoundary: state.commandExecutionBoundary || null,
      portfolioRecommendation: compactPortfolioRecommendation(state.portfolioRecommendation),
      workflowFriction: Array.isArray(state.workflowFriction)
        ? state.workflowFriction.slice(0, 5)
        : [],
      commands: state.commands || {},
      resumeAudit: compactDecisionEnvelope,
      decisionEnvelope: compactDecisionEnvelope,
      canonicalNextAction,
      runtimeProvenance: state.runtimeProvenance,
      runtimeDriftSummary: state.runtimeDriftSummary
        ? {
            installedRuntime: state.runtimeDriftSummary.installedRuntime,
            builtRuntime: state.runtimeDriftSummary.builtRuntime,
            nextActionHint: state.runtimeDriftSummary.nextActionHint,
          }
        : null,
      runtimeAuthority: compactRuntimeAuthority(state.runtimeAuthority),
      dashboardHealth: state.dashboardHealth || null,
      sourceCleanliness: state.sourceCleanliness || null,
      ledgerHealth: state.ledgerHealth || null,
      gateQuality: state.gateQuality
        ? {
            posture: state.gateQuality.posture,
            blockers: state.gateQuality.blockers || [],
            warnings: state.gateQuality.warnings || [],
            nextActionHint: state.gateQuality.nextActionHint || "",
          }
        : null,
      fixedControl: state.fixedControl || null,
      preflight: state.preflight
        ? {
            status: state.preflight.status,
            blockers: state.preflight.blockers || [],
            warnings: state.preflight.warnings || [],
            nextCommand: state.preflight.nextCommand || "",
          }
        : null,
      loopContract: compactDecisionEnvelope?.loopContract,
      approvalLedger: state.approvalLedger || null,
      resourcePreflight: state.resourcePreflight || null,
      evidenceMaturity: state.evidenceMaturity || null,
      laneOrchestration: state.laneOrchestration || null,
      finalizationRunway: state.finalizationRunway || null,
      operatorReadout: compactDecisionEnvelope?.operatorReadout || state.operatorReadout || null,
      laneLifecycle: compactLaneLifecycle(state.laneLifecycle),
      packetDiagnostics: state.packetDiagnostics,
      metricSemanticsWarning: state.metricSemanticsWarning || null,
    }) as unknown as CommandRecord;
  }

  function commandExecutionBoundaryForState({
    state,
    lastRun,
  }: {
    state: CommandRecord;
    lastRun?: CommandRecord | null;
  }): CommandRecord | null {
    const boundary =
      lastRun?.packetEvidence?.commandExecutionBoundary ||
      [...(Array.isArray(state.current) ? state.current : [])]
        .reverse()
        .map((run: CommandRecord) => run.commandExecutionBoundary)
        .find(Boolean);
    if (!boundary) return null;
    return {
      mode: String(boundary),
      note: COMMAND_EXECUTION_BOUNDARY.note,
      recommendation: COMMAND_EXECUTION_BOUNDARY.recommendation,
    };
  }

  function compactEnvelope(envelope: CommandRecord | null | undefined): CommandRecord | null {
    if (!envelope) return null;
    return {
      activeSegment: envelope.activeSegment || null,
      historicalBest: envelope.historicalBest || null,
      promotionGradeBest: envelope.promotionGradeBest || null,
      latestPacketFreshness: envelope.latestPacketFreshness || null,
      benchmarkConfigDrift: envelope.benchmarkConfigDrift || null,
      dirtySourceDrift: envelope.dirtySourceDrift || null,
      sourceCleanliness: envelope.sourceCleanliness || null,
      goalContract: envelope.goalContract || null,
      approvalLedger: envelope.approvalLedger || null,
      resourcePreflight: envelope.resourcePreflight || null,
      evidenceMaturity: envelope.evidenceMaturity || null,
      laneOrchestration: envelope.laneOrchestration || null,
      finalizationRunway: envelope.finalizationRunway || null,
      budgetStatus: envelope.budgetStatus || null,
      qualityRound: envelope.qualityRound || null,
      scaffoldHealth: compactScaffoldHealth(envelope.scaffoldHealth),
      researchIntegrity: envelope.researchIntegrity || null,
      goalAdvice: envelope.goalAdvice || null,
      finalizationReadiness: compactFinalizationReadiness(envelope.finalizationReadiness),
      experimentEconomics: compactExperimentEconomics(envelope.experimentEconomics),
      workflowFriction: Array.isArray(envelope.workflowFriction)
        ? envelope.workflowFriction.slice(0, 5)
        : [],
      watchdog: envelope.watchdog || null,
      contextDistillation: envelope.contextDistillation || null,
      laneLifecycle: compactLaneLifecycle(envelope.laneLifecycle),
      runtimeProvenance: envelope.runtimeProvenance || null,
      packetDiagnostics: envelope.packetDiagnostics || null,
      sessionDecisionCapsule: envelope.sessionDecisionCapsule || null,
      nextAction: envelope.nextAction || "",
      loopContract: envelope.loopContract || null,
      canonicalNextAction: envelope.canonicalNextAction || null,
      operatorReadout: envelope.operatorReadout || null,
    };
  }

  function compactScaffoldHealth(
    scaffoldHealth: CommandRecord | null | undefined,
  ): CommandRecord | null {
    if (!scaffoldHealth) return null;
    return {
      ok: scaffoldHealth.ok,
      status: scaffoldHealth.status,
      blockers: Array.isArray(scaffoldHealth.blockers)
        ? scaffoldHealth.blockers.slice(0, 6)
        : Array.isArray(scaffoldHealth.checks)
          ? scaffoldHealth.checks
              .filter((check: any) => check.severity === "blocker")
              .map((check: any) => check.message || check.code)
              .slice(0, 6)
          : [],
    };
  }

  function compactExperimentEconomics(
    economics: CommandRecord | null | undefined,
  ): CommandRecord | null {
    if (!economics) return null;
    return {
      runtimeClass: economics.runtimeClass,
      expectedRuntimeSeconds: economics.expectedRuntimeSeconds ?? null,
      baselineFreshness: economics.baselineFreshness,
      freshRunRequired: economics.freshRunRequired === true,
      freshRunReason: economics.freshRunReason || "",
      warnings: Array.isArray(economics.warnings) ? economics.warnings.slice(0, 3) : [],
      progress: economics.progress || null,
    };
  }

  function compactLaneLifecycle(
    laneLifecycle: CommandRecord | null | undefined,
  ): CommandRecord | null {
    if (!laneLifecycle) return null;
    const lanes = Array.isArray(laneLifecycle.lanes) ? laneLifecycle.lanes : [];
    return {
      stale: laneLifecycle.stale === true,
      counts: {
        planned: Array.isArray(laneLifecycle.plannedLanes) ? laneLifecycle.plannedLanes.length : 0,
        running: Array.isArray(laneLifecycle.runningLanes) ? laneLifecycle.runningLanes.length : 0,
        result: Array.isArray(laneLifecycle.resultLanes) ? laneLifecycle.resultLanes.length : 0,
        stale: Array.isArray(laneLifecycle.staleLanes) ? laneLifecycle.staleLanes.length : 0,
      },
      lanes: lanes.slice(0, 6).map((lane: any) => ({
        id: lane.id,
        title: lane.title || lane.label,
        status: lane.status,
        mode: lane.mode,
        evidenceStatus: lane.evidenceStatus,
        nextActionHint: lane.nextActionHint,
        brief: lane.brief || null,
      })),
      lessonsToAvoid: Array.isArray(laneLifecycle.lessonsToAvoid)
        ? laneLifecycle.lessonsToAvoid.slice(0, 8)
        : [],
      recommendation: laneLifecycle.recommendation || "",
      command: laneLifecycle.command || "",
    };
  }

  function compactRuntimeAuthority(value: CommandRecord | null | undefined): CommandRecord | null {
    if (!value) return null;
    return {
      sourceRuntime: value.sourceRuntime || null,
      installedRuntime: value.installedRuntime || null,
      trustScope: value.trustScope || "source-checkout",
      blocking: value.blocking === true,
      blocker: value.blocker || "",
      warning: value.warning || "",
    };
  }

  function compactPortfolioRecommendation(
    value: CommandRecord | null | undefined,
  ): CommandRecord | null {
    if (!value) return null;
    return {
      kind: value.kind || "insufficient-evidence",
      confidence: value.confidence || "low",
      reason: value.reason || "",
      nextActionHint: value.nextActionHint || "",
      evidence: Array.isArray(value.evidence) ? value.evidence.slice(0, 6) : [],
    };
  }

  async function dashboardHealthForWorkDir(workDir: string): Promise<CommandRecord> {
    const record = await readServeRegistry(workDir);
    return verifyDashboardHealthSummary(
      buildServeRegistryHealthInput(workDir, record, {
        expectedVersion: PLUGIN_VERSION,
        timeoutMs: 500,
      }),
    );
  }

  return {
    publicState,
    publicCompactState,
    compactPublicState,
    publicSessionConfig,
    dashboardHealthForWorkDir,
    finalizationPressureForWorkDir,
  };
}
