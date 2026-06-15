import { STATUS_VALUES, buildDecisionEnvelope, finiteMetric } from "./session-core.js";
import { redactEvidenceObject } from "./evidence-redaction.js";
import { acceptedCurrentRuns, buildEvidenceRegistry } from "./evidence-registry.js";
import {
  actionMetadataForKind,
  fallbackCommandForKind,
  isPacketBrakeKind,
} from "./action-metadata.js";
import {
  dashboardCommandMapKey,
  dashboardReadOnlyCommand,
  stripDashboardGuidanceCommandFields,
} from "./dashboard-command-safety.js";
import type { DashboardContext } from "../dashboard/src/types.js";

type LooseObject = Record<string, any>;
type Direction = "lower" | "higher" | string;
type RunLike = LooseObject & {
  run?: number;
  metric?: unknown;
  status?: string;
  metrics?: LooseObject;
  asi?: LooseObject;
  description?: string;
  commit?: string;
};
type CommandMap = Map<string, string>;

export const DASHBOARD_READOUT_MEASUREMENT_RUN_LIMIT = 50;

interface NormalizedDashboardSettings extends LooseObject {
  deliveryMode?: string;
  liveUrl?: string;
  pluginVersion?: string;
  runtimeDrift?: LooseObject | null;
  dashboardServerRegistry?: LooseObject | null;
  generatedAt?: string;
  sourceCwd?: string;
}

interface NormalizedDashboardContext extends Omit<DashboardContext, "settings"> {
  settings: NormalizedDashboardSettings;
}

export function buildDashboardViewModel(context: DashboardContext) {
  const {
    state,
    settings,
    commands = [],
    setupPlan = null,
    guidedSetup = null,
    qualityGap = null,
    finalizePreview = null,
    recipes = [],
    experimentMemory = null,
    drift = null,
    warnings = [],
  } = normalizeDashboardContext(context);
  const current = (state.current || []) as RunLike[];
  const scaffoldHealth = (state.scaffoldHealth as LooseObject) || null;
  const researchIntegrity = (state.researchIntegrity as LooseObject) || null;
  const kept = acceptedCurrentRuns(current);
  const failures = current.filter((run) =>
    ["discard", "crash", "checks_failed"].includes(String(run.status)),
  );
  const measurements = current.filter((run) => run.status === "measure");
  const measurementReadout = boundedMeasurementRunReadout(measurements);
  const bestKept = bestRun(kept, String(state.config.bestDirection || "lower"));
  const latestFailure = failures.at(-1) || null;
  const parallelLanes = Array.isArray(state.parallelLanes)
    ? state.parallelLanes
    : Array.isArray(experimentMemory?.lanePortfolio)
      ? experimentMemory.lanePortfolio
      : [];
  const watchdogSummary = buildWatchdogSummary({
    state,
    settings,
    current,
    parallelLanes,
    fanoutPlan: state.fanoutPlan || null,
  });
  const decisionEnvelope = normalizeDecisionEnvelope({
    state,
    settings,
    guidedSetup,
    setupPlan,
    finalizePreview,
    qualityGap,
    scaffoldHealth,
    researchIntegrity,
    experimentEconomics: state.experimentEconomics || null,
    salvageCandidates: (state.partialResults as LooseObject)?.candidates || [],
    workflowFriction: state.workflowFriction || [],
    experimentMemory,
    segmentTransition: segmentTransitionFromDashboardInput({ state, guidedSetup, qualityGap }),
    setupState: setupStateFromDashboardInput({ guidedSetup, setupPlan }),
    watchdog: watchdogSummary,
    warnings,
  });
  const decisionEnvelopeSummary = summarizeDecisionEnvelope({
    envelope: decisionEnvelope,
    current,
    measurements,
    guidedSetup,
    setupPlan,
    finalizePreview,
    experimentMemory,
  });
  const trustContext = buildTrustState({
    state,
    settings,
    setupPlan,
    guidedSetup,
    finalizePreview,
    drift,
    warnings,
  });
  const researchTruth = buildResearchTruth({
    state,
    settings,
    current,
    qualityGap,
    experimentMemory,
  });
  const productClaimCoverage = normalizeProductClaimCoverage(state.productClaimCoverage);
  const nextAction =
    [...current]
      .reverse()
      .map((run) => run.asi?.next_action_hint || run.asi?.nextAction || run.asi?.next_action)
      .find(Boolean) ||
    (current.length ? "Choose the next measured hypothesis." : "Run and log a baseline.");
  const actionRail = buildActionRail({
    current,
    bestKept,
    latestFailure,
    nextAction,
    decisionEnvelopeSummary,
    setupPlan,
    guidedSetup,
    qualityGap,
    finalizePreview,
    experimentMemory,
    drift,
    warnings,
    trustWarnings: trustContext.decisionWarnings,
    commands,
  });
  const trustBlockers = buildTrustBlockers({
    trustWarnings: trustContext.decisionWarnings,
    guidedSetup,
    warnings,
    commands,
  });
  const decisionReceipt = buildDecisionReceipt({
    state,
    current,
    bestKept,
    latestFailure,
    action: actionRail[0],
    trustBlockers,
  });
  const bestVsLatest = buildBestVsLatest({ state, current, bestKept });
  const handoffPacket = buildHandoffPacket({
    state,
    current,
    action: actionRail[0],
    trustBlockers,
    experimentMemory,
  });
  const portfolio = buildPortfolio(experimentMemory, String(state.config.bestDirection || "lower"));
  const missionControl = buildMissionControl({
    current,
    setupPlan,
    guidedSetup,
    qualityGap,
    finalizePreview,
    experimentMemory,
    actionRail,
    commands,
  });
  const evidenceChips = buildEvidenceChips({
    state,
    current,
    bestKept,
    latestFailure,
    measurements,
    decisionEnvelopeSummary,
    researchTruth,
    researchIntegrity,
    trustState: trustContext.trustState,
  });
  const finalizationPressure = buildFinalizationPressure({
    kept,
    finalizePreview,
    watchdogSummary,
  });
  const finalizationChecklist = buildFinalizationChecklist({
    current,
    kept,
    finalizePreview,
    finalizationPressure,
  });
  const processHygiene = buildProcessHygiene({
    settings,
    trustState: trustContext.trustState,
    watchdogSummary,
  });
  const evidenceLedger = buildEvidenceLedger(current);
  const evidenceReadout = buildEvidenceReadout({
    researchIntegrity,
    researchTruth,
    trustState: trustContext.trustState,
    current,
  });
  const proofGaps = buildProofGaps({
    setupPlan,
    guidedSetup,
    researchIntegrity,
    productClaimCoverage,
    trustWarnings: trustContext.decisionWarnings,
    action: actionRail[0],
  });
  const signals = buildDashboardSignals({
    productClaimCoverage,
    finalizePreview,
    trustBlockers,
  });
  const aiSummary = buildAiSummary({
    state,
    current,
    kept,
    failures,
    bestKept,
    latestFailure,
    nextAction: actionRail[0]?.detail || nextAction,
    nextTitle: actionRail[0]?.title || "",
    qualityGap,
    finalizePreview,
    experimentMemory,
    warnings,
  });
  return sanitizeDashboardDecisionEnvelope({
    setup: setupPlan,
    guidedSetup,
    decisionEnvelope,
    decisionEnvelopeSummary,
    experimentEconomics: state.experimentEconomics || decisionEnvelope?.experimentEconomics || null,
    partialResults: state.partialResults || {
      candidates: decisionEnvelope?.salvageCandidates || [],
      skippedArtifacts: [],
    },
    workflowFriction: state.workflowFriction || decisionEnvelope?.workflowFriction || [],
    scaffoldHealth,
    researchIntegrity,
    lastRun: guidedSetup?.lastRun || null,
    qualityGap,
    finalizePreview,
    recipes,
    experimentMemory,
    fanoutPlan: state.fanoutPlan || null,
    parallelLanes,
    portfolio,
    trustState: trustContext.trustState,
    researchTruth,
    evidenceChips,
    evidenceLedger,
    evidenceReadout,
    productClaimCoverage,
    signals,
    proofGaps,
    finalizationChecklist,
    finalizationPressure,
    watchdogSummary,
    processHygiene,
    missionControl,
    aiSummary,
    trustBlockers,
    decisionReceipt,
    bestVsLatest,
    handoffPacket,
    codexDiagnostics: trustBlockers,
    staleSession: staleSessionSummary({ guidedSetup, state, warnings: trustBlockers }),
    nextBestAction: actionRail[0],
    actionRail,
    drift,
    warnings,
    summary: {
      name: state.config.name || "Autoresearch",
      metricName: state.config.metricName,
      metricUnit: state.config.metricUnit,
      direction: state.config.bestDirection,
      segment: state.segment,
      runs: current.length,
      kept: kept.length,
      measured: measurements.length,
      failed: failures.length,
      baseline: state.baseline,
      best: state.best,
      development: state.development || null,
      promotion: state.promotion || null,
      confidence: state.confidence,
      evidenceLabels: researchIntegrity?.evidenceLabels || [],
      statusCounts: Object.fromEntries(
        [...STATUS_VALUES].map((status) => [
          status,
          current.filter((run) => run.status === status).length,
        ]),
      ),
      settings,
    },
    readout: {
      bestKept: bestKept ? compactRun(bestKept) : null,
      latestFailure: latestFailure ? compactRun(latestFailure) : null,
      measurementRuns: measurementReadout.runs,
      measurementRunCount: measurements.length,
      measurementRunsOmitted: measurementReadout.omitted,
      measurementRunsTruncated: measurementReadout.truncated,
      nextAction: actionRail[0]?.detail || nextAction,
      confidenceText:
        state.confidence == null
          ? "Confidence needs at least three finite metric runs and enough signal over noise."
          : "Confidence compares best movement against median absolute deviation.",
      finalizeText: finalizePreview?.ready
        ? "Ready to preview final review branches."
        : finalizePreview?.nextAction || "Keep evidence or run finalize-preview when ready.",
    },
    commands,
  });
}

function normalizeDashboardContext(context: DashboardContext): NormalizedDashboardContext {
  const settings = normalizeDashboardSettings(context.settings, context.state, context.drift);
  return {
    ...context,
    settings,
    commands: sanitizeDashboardCommandList(context.commands),
    setupPlan: sanitizeDashboardGuidance(context.setupPlan),
    guidedSetup: sanitizeDashboardGuidance(context.guidedSetup),
    qualityGap: context.qualityGap || null,
    finalizePreview: sanitizeDashboardFinalizationPreview(context.finalizePreview),
    recipes: Array.isArray(context.recipes) ? context.recipes : [],
    experimentMemory: context.experimentMemory || null,
    drift: context.drift || null,
    warnings: Array.isArray(context.warnings) ? context.warnings : [],
  };
}

function sanitizeDashboardGuidance<T>(value: T): T | null {
  return stripDashboardGuidanceCommandFields(value);
}

function sanitizeDashboardFinalizationPreview<T>(value: T): T | null {
  return stripDashboardGuidanceCommandFields(value, {
    extraFieldNames: [
      "applyCommand",
      "finalizeCommand",
      "finalizerCommand",
      "planCommand",
      "planOutput",
    ],
  });
}

function sanitizeDashboardCommandList(commands: unknown) {
  if (!Array.isArray(commands)) return [];
  return commands
    .map((item): LooseObject | null => {
      const record = recordOrNull(item);
      const label = cleanText(record?.label);
      const command = dashboardReadOnlyCommand(record?.command);
      if (!label || !command) return null;
      return { ...record, label, command };
    })
    .filter((item): item is LooseObject => item !== null);
}

function sanitizeDashboardDecisionEnvelope<T>(value: T): T {
  if (Array.isArray(value))
    return value.map((item) => sanitizeDashboardDecisionEnvelope(item)) as T;
  if (!value || typeof value !== "object") return value;
  const result: LooseObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "command") {
      const command = dashboardReadOnlyCommand(nested);
      if (command) result[key] = command;
      continue;
    }
    if (key === "primaryCommand") {
      const primary = sanitizeDashboardPrimaryCommand(nested);
      if (primary) result[key] = primary;
      continue;
    }
    if (key === "commandsByStatus" || key === "liveAction") continue;
    result[key] = sanitizeDashboardDecisionEnvelope(nested);
  }
  return result as T;
}

function sanitizeDashboardPrimaryCommand(value: unknown): LooseObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as LooseObject;
  const command = dashboardReadOnlyCommand(record.command);
  if (!command) return null;
  return { ...record, command };
}

function normalizeDashboardSettings(
  rawSettings: DashboardContext["settings"] = {},
  state: DashboardContext["state"],
  drift: DashboardContext["drift"] = null,
): NormalizedDashboardSettings {
  const settings = rawSettings || {};
  return {
    ...settings,
    deliveryMode: cleanText(settings.deliveryMode || settings.mode || settings.dashboardMode),
    liveUrl: cleanText(settings.liveUrl || settings.url || settings.dashboardUrl),
    pluginVersion: cleanText(
      settings.pluginVersion || settings.version || state?.config?.pluginVersion,
    ),
    runtimeDrift: (settings.runtimeDrift as LooseObject) || drift || null,
    dashboardServerRegistry: recordOrNull(settings.dashboardServerRegistry),
    generatedAt: cleanText(
      settings.generatedAt || settings.exportedAt || settings.snapshotGeneratedAt,
    ),
    sourceCwd: cleanText(
      settings.sourceCwd || settings.workDir || settings.cwd || state?.workDir || state?.cwd,
    ),
  };
}

function normalizeDecisionEnvelope({
  state,
  settings = {},
  guidedSetup = null,
  setupPlan = null,
  finalizePreview = null,
  qualityGap = null,
  scaffoldHealth = null,
  researchIntegrity = null,
  experimentEconomics = null,
  salvageCandidates = [],
  workflowFriction = [],
  experimentMemory = null,
  segmentTransition = null,
  setupState = null,
  warnings = [],
  watchdog = null,
}: LooseObject) {
  const supplied = firstRecord(
    state?.decisionEnvelope,
    state?.resumeAudit,
    settings.decisionEnvelope,
    settings.resumeAudit,
  );
  if (Object.keys(supplied).length) return sanitizeDashboardDecisionEnvelope(supplied);

  const current = Array.isArray(state?.current) ? state.current : [];
  const lastRun = guidedSetup?.lastRun || null;
  const freshness = lastRun?.freshness || null;
  return sanitizeDashboardDecisionEnvelope(
    buildDecisionEnvelope({
      state: { ...state, current },
      nextAction:
        guidedSetup?.nextStep?.nextAction?.reason ||
        guidedSetup?.nextAction ||
        setupPlan?.nextStep?.nextAction?.reason ||
        "Run doctor, then next.",
      lastRunFreshness: freshness,
      warningDetails: warnings,
      scaffoldHealth,
      researchIntegrity,
      finalization: finalizePreview,
      qualityGap,
      experimentEconomics,
      salvageCandidates,
      workflowFriction,
      experimentMemory,
      segmentTransition,
      setupState,
      watchdog,
    }),
  );
}

function setupStateFromDashboardInput({ guidedSetup, setupPlan }: LooseObject) {
  const blockers = [...stringList(setupPlan?.missing), ...stringList(setupPlan?.missingEssentials)];
  if (!guidedSetup?.stage && blockers.length === 0) return null;
  return {
    stage: cleanText(guidedSetup?.stage),
    blockers,
    nextAction:
      cleanText(guidedSetup?.nextAction) || cleanText(setupPlan?.nextStep?.nextAction?.reason),
  };
}

function segmentTransitionFromDashboardInput({ state, guidedSetup, qualityGap }: LooseObject) {
  const limit = guidedSetup?.state?.limit || guidedSetup?.limit || state?.limit || {};
  const budgetStatus = limit.budgetStatus || state?.budgetStatus || {};
  if (budgetStatus.exhausted === true) {
    return {
      required: true,
      nextAction:
        cleanText(budgetStatus.nextAction) ||
        "Budget exhausted; stop packet work and ask whether to extend, rescope, or start a new segment.",
      triggeredBy: ["budget"],
    };
  }
  const limitReached =
    limit.limitReached === true ||
    (Number.isFinite(Number(limit.remainingIterations)) && Number(limit.remainingIterations) <= 0);
  if (limitReached || guidedSetup?.stage === "limit-reached") {
    return {
      required: true,
      nextAction:
        cleanText(guidedSetup?.nextAction) ||
        "The active segment reached its limit; extend the limit or start a new segment.",
      triggeredBy: ["limit"],
    };
  }
  if (qualityGap?.done === true) {
    return {
      required: true,
      nextAction: "The active quality round is closed; refresh gaps or preview finalization.",
      triggeredBy: ["qualityRound"],
    };
  }
  return null;
}

function summarizeDecisionEnvelope({
  envelope,
  current = [],
  measurements = [],
  guidedSetup = null,
  setupPlan = null,
  finalizePreview = null,
  experimentMemory = null,
}: LooseObject) {
  const freshness = envelope?.latestPacketFreshness || {};
  const finalization = envelope?.finalizationReadiness || {};
  const canonicalSummary = summaryFromCanonicalNextAction(envelope?.canonicalNextAction, {
    current,
    measurements,
    envelope,
  });
  if (canonicalSummary && canonicalSummary.kind !== "next-packet") return canonicalSummary;

  let summary = {
    kind: "continue",
    priority: "Next",
    title: "Run the next measured hypothesis",
    detail: cleanText(envelope?.nextAction) || "Use the latest ASI hint as the next loop input.",
    source: "decision-envelope",
    fresh: freshness.fresh ?? null,
    segment: envelope?.activeSegment?.segment ?? null,
    runs: envelope?.activeSegment?.runs ?? current.length,
    measurementRuns: measurements.length,
    finalizationReady: finalization.ready ?? null,
  };

  if (!canonicalSummary) {
    const scaffoldBlockers = stringList(envelope?.scaffoldHealth?.blockers);
    const setupBlockers = [
      ...scaffoldBlockers,
      ...stringList(setupPlan?.missing),
      ...stringList(setupPlan?.missingEssentials),
    ];
    const limit = guidedSetup?.state?.limit || guidedSetup?.limit || {};
    const limitReached =
      limit.limitReached === true ||
      (Number.isFinite(Number(limit.remainingIterations)) &&
        Number(limit.remainingIterations) <= 0);
    const watchdog = envelope?.watchdog || {};
    const qualityRound = envelope?.qualityRound || {};

    if (freshness.fresh === false) {
      summary = {
        ...summary,
        kind: "stale-packet",
        priority: "Critical",
        title: "Replace the stale packet",
        detail: freshness.reason || "The saved last-run packet no longer matches the ledger.",
        source: "packet",
      };
    } else if (setupBlockers.length || guidedSetup?.stage === "needs-setup") {
      summary = {
        ...summary,
        kind: "setup",
        priority: "Critical",
        title: "Complete setup",
        detail:
          setupBlockers[0] ||
          guidedSetup?.nextAction ||
          "Repair setup blockers before trusting another packet.",
        source: "setup",
      };
    } else if (guidedSetup?.stage === "needs-benchmark-command") {
      summary = {
        ...summary,
        kind: "benchmark-command",
        priority: "Critical",
        title: "Add a benchmark command",
        detail:
          guidedSetup?.nextAction ||
          "This session has logged metrics, but next has no default benchmark script to run.",
        source: "setup",
      };
    } else if (guidedSetup?.stage === "needs-log-decision" && freshness.fresh !== false) {
      const suggested =
        guidedSetup?.lastRun?.safeSuggestedStatus || guidedSetup?.lastRun?.suggestedStatus;
      summary = {
        ...summary,
        kind: "log-decision",
        priority: "Critical",
        title: "Log the last packet",
        detail: suggested
          ? `Record the last packet as ${suggested}, then run a new packet.`
          : "Record the fresh last-run packet before starting another packet.",
        source: "packet",
      };
    } else if (
      limitReached ||
      guidedSetup?.stage === "limit-reached" ||
      qualityRound.done === true
    ) {
      summary = {
        ...summary,
        kind: "segment-transition",
        priority: "Transition",
        title: qualityRound.done === true ? "Review completion state" : "Start a new segment",
        detail:
          guidedSetup?.nextAction ||
          (qualityRound.done === true
            ? "The active quality round is closed; refresh gaps or preview finalization."
            : "The active segment reached its limit; extend the limit or start a new segment."),
        source: "segment",
      };
    } else if (experimentMemory?.plateau?.detected) {
      summary = {
        ...summary,
        kind: "plateau",
        priority: "Critical",
        title: "Break the plateau",
        detail:
          experimentMemory?.diversityGuidance?.nextActionHint ||
          experimentMemory?.plateau?.recommendation ||
          "Recent runs are clustering without a new best.",
        source: "plateau",
      };
    } else if (watchdog.stale === true) {
      summary = {
        ...summary,
        kind: "watchdog",
        priority: "Critical",
        title: "Investigate the quiet window",
        detail:
          watchdog.recommendation || "No progress signal has appeared within the watchdog window.",
        source: "watchdog",
      };
    } else if (finalization.ready === true || finalizePreview?.ready === true) {
      summary = {
        ...summary,
        kind: "finalize-preview",
        priority: "Review",
        title: "Preview finalization",
        detail:
          finalization.nextAction ||
          finalizePreview?.nextAction ||
          "Inspect the branch packet before creating review branches.",
        source: "finalize",
      };
    }
  }

  if (summary.kind === "continue" && !current.length) {
    summary = {
      ...summary,
      kind: "baseline",
      priority: "Start",
      title: "Capture the baseline",
      detail:
        guidedSetup?.nextAction || "Run the first measured packet so future changes have a floor.",
      source: "baseline",
    };
  }

  return summary;
}

function summaryFromCanonicalNextAction(
  action: unknown,
  { current, measurements, envelope }: LooseObject,
) {
  if (!action || typeof action !== "object") return null;
  const canonical = action as LooseObject;
  const kind = cleanText(canonical.kind);
  if (!kind) return null;
  return {
    kind,
    priority: canonicalPriorityLabel(canonical.priority),
    title:
      cleanText(canonical.title) ||
      (kind === "segment-transition" &&
      Array.isArray(canonical.triggeredBy) &&
      canonical.triggeredBy.includes("qualityRound")
        ? "Review completion state"
        : canonicalTitle(kind)),
    detail:
      cleanText(canonical.reason) || cleanText(envelope?.nextAction) || "Review before continuing.",
    command: cleanText(canonical.command),
    source: "decision-envelope",
    fresh: envelope?.latestPacketFreshness?.fresh ?? null,
    segment: envelope?.activeSegment?.segment ?? null,
    runs: envelope?.activeSegment?.runs ?? current.length,
    measurementRuns: measurements.length,
    finalizationReady: envelope?.finalizationReadiness?.ready ?? null,
    canonical: true,
  };
}

function canonicalPriorityLabel(value: unknown): string {
  const priority = Number(value);
  if (!Number.isFinite(priority)) return cleanText(value) || "Next";
  if (priority <= 2) return "Critical";
  if (priority <= 5) return "Review";
  if (priority <= 8) return "Pivot";
  if (priority === 9) return "Review";
  return "Next";
}

function canonicalTitle(kind: string): string {
  const metadata = actionMetadataForKind(kind);
  if (metadata?.label) return metadata.label;
  const titles: Record<string, string> = {
    "safety-blocker": "Resolve the safety blocker",
    "benchmark-mismatch": "Repair the benchmark mismatch",
    "workflow-friction": "Remove workflow friction",
    "stale-packet": "Replace the stale packet",
    setup: "Complete setup",
    "benchmark-command": "Add a benchmark command",
    "partial-salvage": "Review partial results",
    "log-decision": "Log the last packet",
    "context-distillation": "Refresh context",
    "decision-capsule": "Resolve the decision capsule",
    "segment-transition": "Start a new segment",
    "quality-gap": "Close accepted quality gaps",
    "plateau-pivot": "Pivot before repeating the plateau",
    watchdog: "Investigate the quiet window",
    finalization: "Preview finalization",
    "next-packet": "Run the next measured hypothesis",
  };
  return titles[kind] || "Next action";
}

const UNKNOWN = "unknown";
const NO_DATA = "No data";

export function buildTrustState({
  state,
  settings = {},
  setupPlan = null,
  guidedSetup = null,
  finalizePreview = null,
  drift = null,
  warnings = [],
}: LooseObject) {
  const taggedReasons: Array<{ source: string; text: string; decisionRelevant: boolean }> = [];
  const mode = normalizeMode(settings.deliveryMode);
  const addReasons = (
    source: string,
    values: unknown,
    decisionRelevant = false,
    classifyDecisionReason = true,
  ) => {
    for (const value of Array.isArray(values) ? values : []) {
      const text = warningMessage(value);
      if (text) {
        taggedReasons.push({
          source,
          text,
          decisionRelevant:
            decisionRelevant || (classifyDecisionReason && isTrustDecisionReason(text)),
        });
      }
    }
  };

  if (mode === "static-export") {
    taggedReasons.push({
      source: "mode",
      text: "Static export is read-only; serve the dashboard locally for fresh state.",
      decisionRelevant: false,
    });
  }
  if (setupPlan?.ok === false) {
    taggedReasons.push({
      source: "setup",
      text: "Setup plan could not be verified.",
      decisionRelevant: true,
    });
  }
  if (guidedSetup?.ok === false) {
    taggedReasons.push({
      source: "guided-setup",
      text: "Guided setup could not be verified.",
      decisionRelevant: true,
    });
  }
  if (guidedSetup?.lastRun?.freshness?.fresh === false) {
    taggedReasons.push({
      source: "last-run",
      text: guidedSetup.lastRun.freshness.reason || "Last-run packet is stale.",
      decisionRelevant: true,
    });
  }
  addReasons("setup", currentHasRuns(state) ? [] : setupPlan?.missing, true);
  addReasons("setup", setupPlan?.warnings, true);
  addReasons(
    "scaffold-health",
    (state.scaffoldHealth?.checks || []).map((check: LooseObject) => check.message || check.code),
    true,
  );
  const latestConstraintEvaluation = latestSecondaryMetricConstraints(state);
  addReasons("secondary-metric-constraints", latestConstraintEvaluation?.messages, true);
  addReasons("research-integrity", state.researchIntegrity?.warnings, true);
  addReasons("research-integrity", state.researchIntegrity?.blockers, true);
  addReasons("guided-setup", guidedSetup?.warnings, true);
  addReasons("drift", drift?.warnings, true);
  addReasons("operator", warnings, true);
  addReasons("finalize", finalizePreview?.warnings, false, false);

  const commandExecutionBoundary = commandExecutionBoundaryFromState(state);
  const uniqueReasons = unique(taggedReasons.map((reason) => reason.text));
  const attention = taggedReasons.some(
    (reason) => reason.decisionRelevant || isTrustDecisionReason(reason.text),
  );
  const status = attention
    ? "needs-attention"
    : mode === "static-export"
      ? "read-only"
      : mode === UNKNOWN
        ? UNKNOWN
        : "trusted";

  return {
    trustState: {
      mode,
      status,
      reasons: uniqueReasons,
      liveUrl: cleanText(settings.liveUrl) || null,
      pluginVersion: cleanText(settings.pluginVersion) || UNKNOWN,
      runtimeDrift: summarizeRuntimeDrift(settings.runtimeDrift || drift),
      generatedAt: cleanText(settings.generatedAt) || null,
      sourceCwd: cleanText(settings.sourceCwd) || UNKNOWN,
      commandExecutionBoundary,
    },
    decisionWarnings: unique(
      taggedReasons.filter((reason) => reason.decisionRelevant).map((reason) => reason.text),
    ),
  };
}

function latestSecondaryMetricConstraints(state: LooseObject): LooseObject | null {
  return (
    [...(Array.isArray(state.current) ? state.current : [])]
      .reverse()
      .map((run: LooseObject) => run.secondaryMetricConstraints || null)
      .find((evaluation: LooseObject | null) => evaluation?.configured === true) || null
  );
}

function commandExecutionBoundaryFromState(state: LooseObject): LooseObject | null {
  const direct = state.commandExecutionBoundary;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return {
      mode: cleanText(direct.mode) || "not_sandboxed",
      note:
        cleanText(direct.note) ||
        "Benchmark and checks commands run with the current user's local permissions.",
    };
  }
  const latest = [...(Array.isArray(state.current) ? state.current : [])]
    .reverse()
    .map((run: LooseObject) => cleanText(run.commandExecutionBoundary))
    .find(Boolean);
  if (!latest) return null;
  return {
    mode: latest,
    note: "Benchmark and checks commands run with the current user's local permissions.",
  };
}

function summarizeRuntimeDrift(drift: LooseObject | null | undefined) {
  if (!drift) return null;
  return {
    ok: drift.ok === true,
    sourceVersion: cleanText(drift.local?.version) || null,
    installedVersion: cleanText(drift.installed?.version) || null,
    installedPath: cleanText(drift.installed?.path) || null,
    installedAvailable:
      typeof drift.installed?.available === "boolean" ? drift.installed.available : null,
  };
}

export function buildWatchdogSummary({
  state,
  settings = {},
  current = [],
  parallelLanes = [],
  fanoutPlan = null,
}: LooseObject) {
  const thresholdSeconds = watchdogThresholdSeconds(settings, state?.config);
  const thresholdHours = round(thresholdSeconds / 3600);
  const nowMs = timestampMs(settings.now || settings.generatedAt) || Date.now();
  const cutoffMs = nowMs - thresholdSeconds * 1000;
  const currentRuns = Array.isArray(current) ? current : [];
  const completedLanes = Array.isArray(parallelLanes)
    ? parallelLanes.filter((lane: LooseObject) => laneCompleted(lane))
    : [];
  const progressEvents = [
    ...metricMovementEvents(currentRuns, state?.config?.bestDirection || "lower"),
    ...currentRuns.filter(watchdogDecisionRun).map((run: LooseObject) => ({
      kind: "decision",
      at: timestampMs(run.timestamp || run.loggedAt || run.createdAt),
      label: `Logged run #${run.run ?? "?"} as ${run.status || "decision"}.`,
    })),
    ...currentRuns
      .filter((run: LooseObject) => run.status === "keep" && cleanText(run.commit))
      .map((run: LooseObject) => ({
        kind: "kept_commit",
        at: timestampMs(run.timestamp || run.loggedAt || run.createdAt),
        label: `Kept commit ${String(run.commit).slice(0, 12)} from run #${run.run ?? "?"}.`,
      })),
    ...completedLanes.map((lane: LooseObject) => ({
      kind: "completed_lane",
      at: timestampMs(lane.completedAt || lane.finishedAt || lane.updatedAt || lane.timestamp),
      label: `Lane ${lane.title || lane.id || "unknown"} completed.`,
    })),
  ].filter((event) => event.at != null) as Array<{ kind: string; at: number; label: string }>;
  const recentEvents = progressEvents.filter((event) => event.at >= cutoffMs);
  const latestEvent = progressEvents.sort((a, b) => b.at - a.at)[0] || null;
  const quietHours = latestEvent ? round((nowMs - latestEvent.at) / 3600000) : null;
  const stale = currentRuns.length > 0 && recentEvents.length === 0 && quietHours != null;
  const reasons = stale
    ? [
        `No metric movement, logged decision, kept commit, or completed lane in ${thresholdHours}h.`,
        latestEvent
          ? `Last progress signal: ${latestEvent.label}`
          : "No dated progress signal found.",
      ]
    : recentEvents.length
      ? [
          `${recentEvents.length} progress signal${recentEvents.length === 1 ? "" : "s"} inside the watchdog window.`,
        ]
      : currentRuns.length
        ? ["Run history has no dated progress signal; watchdog cannot prove a quiet window."]
        : ["No run history yet; capture a baseline before watchdog pressure applies."];
  const recommendation = stale
    ? "Intervene before running more packets: inspect the active process, finalize kept work, or rescope the segment."
    : currentRuns.length
      ? "Continue from the decision envelope; watchdog has no stale no-progress window."
      : "Run and log the baseline so the watchdog can compare future progress.";
  return {
    status: stale ? "stale" : currentRuns.length ? "tracking" : "idle",
    stale,
    thresholdSeconds,
    thresholdHours,
    quietHours,
    latestProgressAt: latestEvent ? new Date(latestEvent.at).toISOString() : null,
    recentProgressCount: recentEvents.length,
    progressEventCount: progressEvents.length,
    fanoutPlanId: cleanText(fanoutPlan?.id) || null,
    completedLaneCount: completedLanes.length,
    reasons,
    recommendation,
  };
}

function watchdogThresholdSeconds(settings: LooseObject, config: LooseObject = {}) {
  const direct =
    settings.watchdogNoProgressSeconds ??
    settings.watchdogThresholdSeconds ??
    config.watchdogNoProgressSeconds ??
    config.watchdogThresholdSeconds;
  const hours = settings.watchdogNoProgressHours ?? config.watchdogNoProgressHours;
  const raw = direct ?? (hours != null ? Number(hours) * 3600 : 8 * 3600);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 8 * 3600;
}

function metricMovementEvents(current: LooseObject[], direction: Direction) {
  const events = [];
  let previous: number | null = null;
  for (const run of current) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    if (previous != null && metric !== previous) {
      events.push({
        kind: "metric_movement",
        at: timestampMs(run.timestamp || run.loggedAt || run.createdAt),
        label: `Metric moved on run #${run.run ?? "?"} (${previous} -> ${metric}; ${direction}).`,
      });
    }
    previous = metric;
  }
  return events;
}

function laneCompleted(lane: LooseObject) {
  const status = String(lane.status || lane.state || lane.evidenceStatus || "").toLowerCase();
  return ["complete", "completed", "done", "kept", "accepted", "finished"].includes(status);
}

function watchdogDecisionRun(run: LooseObject) {
  if (run?.type === "lane_result") return false;
  const status = String(run?.status || "").toLowerCase();
  return ["keep", "discard", "crash", "checks_failed", "measure"].includes(status);
}

function timestampMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildProcessHygiene({
  settings = {},
  trustState = {},
  watchdogSummary = null,
}: LooseObject) {
  const mode = normalizeMode(settings.deliveryMode);
  const generatedAt = timestampMs(settings.generatedAt);
  const nowMs = timestampMs(settings.now || settings.generatedAt) || Date.now();
  const staleExportHours = Number(settings.staleExportHours ?? settings.dashboardStaleHours ?? 8);
  const exportAgeHours = generatedAt ? round((nowMs - generatedAt) / 3600000) : null;
  const activeServerCount =
    Number.isFinite(Number(settings.activeServerCount)) && Number(settings.activeServerCount) >= 0
      ? Number(settings.activeServerCount)
      : null;
  const dashboardServerRegistry = recordOrNull(settings.dashboardServerRegistry);
  const registryMessage = cleanText(dashboardServerRegistry?.message);
  const registryStale = dashboardServerRegistry?.stale === true;
  const warnings = [];
  if (mode === "static-export" && exportAgeHours != null && exportAgeHours >= staleExportHours) {
    warnings.push(
      "Static export is a snapshot and cannot prove current runtime freshness; serve a live dashboard before acting.",
    );
  } else if (mode === "static-export") {
    warnings.push(
      "Static export is a snapshot and cannot prove current runtime freshness; serve a live dashboard before acting.",
    );
  }
  if (activeServerCount != null && activeServerCount > 1) {
    warnings.push(
      `${activeServerCount} dashboard servers are active in this process; close stale tabs or restart serve if URLs disagree.`,
    );
  }
  if (registryStale && registryMessage) warnings.push(registryMessage);
  if (watchdogSummary?.stale) warnings.push(watchdogSummary.recommendation);
  return {
    status: warnings.length ? "needs-attention" : "ok",
    mode,
    activeCwd: cleanText(settings.sourceCwd) || trustState.sourceCwd || UNKNOWN,
    pluginVersion: cleanText(settings.pluginVersion) || trustState.pluginVersion || UNKNOWN,
    liveUrl: cleanText(settings.liveUrl) || trustState.liveUrl || null,
    generatedAt: cleanText(settings.generatedAt) || null,
    exportAgeHours,
    runtimeDrift: trustState.runtimeDrift || summarizeRuntimeDrift(settings.runtimeDrift),
    dashboardServerRegistry,
    activeServerCount,
    duplicateServerDetection:
      activeServerCount == null
        ? "unavailable from this snapshot"
        : activeServerCount > 1
          ? "duplicates detected in this process"
          : "single server in this process",
    staleServerDetection:
      registryMessage ||
      (mode === "live-server"
        ? "live URL health is checked by the serve command; older external servers are not enumerable here"
        : "static exports cannot prove live server health"),
    warnings,
  };
}

export function buildResearchTruth({
  state,
  settings = {},
  current = [],
  qualityGap = null,
  experimentMemory = null,
}: LooseObject) {
  const latest = current.at(-1) || null;
  const latestMetrics = latest?.metrics || {};
  const source = {
    ...recordValue(state?.researchTruth),
    ...recordValue(experimentMemory?.researchTruth),
    ...recordValue(qualityGap?.researchTruth),
    ...recordValue(settings.researchTruth),
  };
  const queryCount = countValue(
    source.queryCount,
    source.query_count,
    source.queries,
    latestMetrics.queryCount,
    latestMetrics.query_count,
  );
  const holdoutCount = countValue(
    source.holdoutCount,
    source.holdout_count,
    source.holdouts,
    latestMetrics.holdoutCount,
    latestMetrics.holdout_count,
  );
  const adversarialCount = countValue(
    source.adversarialCount,
    source.adversarial_count,
    source.adversarial,
    latestMetrics.adversarialCount,
    latestMetrics.adversarial_count,
  );
  const externalRepoCount = countValue(
    source.externalRepoCount,
    source.external_repo_count,
    source.externalRepos,
    source.external_repos,
    latestMetrics.externalRepoCount,
    latestMetrics.external_repo_count,
  );
  const promotionGrade = promotionGradeValue(source, latestMetrics);
  const suspiciousReasons = unique([
    ...stringList(source.suspiciousReasons),
    ...stringList(source.suspicious_reasons),
    ...perfectMetricSuspicion({
      state,
      settings,
      current,
      qualityGap,
      queryCount,
      holdoutCount,
      adversarialCount,
      externalRepoCount,
      promotionGrade,
    }),
  ]);
  return {
    queryCount,
    holdoutCount,
    adversarialCount,
    externalRepoCount,
    promotionGrade,
    suspiciousReasons,
  };
}

export function buildEvidenceChips({
  state,
  current = [],
  bestKept = null,
  latestFailure = null,
  measurements = [],
  decisionEnvelopeSummary = null,
  researchTruth,
  researchIntegrity = null,
  trustState,
}: LooseObject) {
  const latest = current.at(-1) || null;
  const unit = state.config.metricUnit ? ` ${state.config.metricUnit}` : "";
  const baseline = finiteMetric(state.baseline);
  const best = finiteMetric(state.best);
  const delta =
    best == null || baseline == null
      ? null
      : percentChange(best, baseline, state.config.bestDirection);
  return [
    evidenceChip({
      label: "Mode",
      value:
        trustState.mode === "live-server" || trustState.mode === "live"
          ? "Live"
          : trustState.status === "read-only"
            ? "Snapshot"
            : trustState.mode === UNKNOWN
              ? UNKNOWN
              : "Readout",
      tone: trustState.mode === "live-server" || trustState.mode === "live" ? "good" : "neutral",
      detail: "Runtime diagnostics are preserved for Codex handoff when relevant.",
    }),
    evidenceChip({
      label: "Decision",
      value: decisionEnvelopeSummary?.title || "Next action",
      tone:
        decisionEnvelopeSummary?.kind === "stale-packet" ||
        decisionEnvelopeSummary?.kind === "setup"
          ? "warn"
          : decisionEnvelopeSummary?.kind === "finalize-preview"
            ? "good"
            : "info",
      detail:
        decisionEnvelopeSummary?.detail ||
        "Authoritative decision envelope drives the dashboard readout.",
    }),
    evidenceChip({
      label: "Baseline",
      value: baseline == null ? NO_DATA : formatSummaryMetric(baseline, unit),
      tone: baseline == null ? "neutral" : "info",
      detail:
        baseline == null
          ? "No finite baseline metric has been logged."
          : "First baseline-eligible metric in the active segment.",
    }),
    evidenceChip({
      label: "Best",
      value: best == null ? NO_DATA : formatSummaryMetric(best, unit),
      tone: bestKept ? "good" : "neutral",
      detail: bestKept
        ? `Best kept run #${bestKept.run}: ${bestKept.description || "No description"}.`
        : "No kept metric anchor yet.",
    }),
    evidenceChip({
      label: "Delta",
      value: delta == null ? UNKNOWN : `${delta >= 0 ? "+" : ""}${round(delta)}%`,
      tone: delta == null ? "neutral" : delta > 0 ? "good" : delta < 0 ? "warn" : "neutral",
      detail:
        delta == null
          ? "No comparable baseline and best metric yet."
          : "Percent movement from baseline to best in the configured direction.",
    }),
    evidenceChip({
      label: "Latest",
      value: latest ? `#${latest.run} ${latest.status || "run"}` : NO_DATA,
      tone:
        latest?.status === "keep"
          ? "good"
          : latest?.status === "measure"
            ? "info"
            : latest?.status
              ? "warn"
              : "neutral",
      detail: latest
        ? `${formatChipMetric(latest.metric, unit)}. ${latest.description || "No description"}.`
        : "No logged runs yet.",
    }),
    evidenceChip({
      label: "Measurements",
      value: measurements.length ? String(measurements.length) : NO_DATA,
      tone: measurements.length ? "info" : "neutral",
      detail: measurements.length
        ? "Measure status counts as trend evidence, not kept or finalizer evidence."
        : "No trend-only measurement runs in this segment.",
    }),
    evidenceChip({
      label: "Research truth",
      value: researchTruth.suspiciousReasons.length
        ? "Suspicious"
        : truthBreadthLabel(researchTruth),
      tone: researchTruth.suspiciousReasons.length ? "warn" : "neutral",
      detail:
        researchTruth.suspiciousReasons[0] ||
        "Research breadth metadata is available when the benchmark reports it.",
    }),
    evidenceChip({
      label: "Promotion",
      value: researchIntegrity?.evidenceLabels?.includes("promotion_eligible")
        ? "Eligible"
        : researchIntegrity?.currentLabel
          ? labelText(researchIntegrity.currentLabel)
          : UNKNOWN,
      tone: researchIntegrity?.ok === false ? "warn" : "neutral",
      detail:
        researchIntegrity?.notPromotableBecause?.[0] ||
        "Promotion-grade evidence appears when repeat, holdout, and promotion metadata support the run.",
    }),
    evidenceChip({
      label: "Recent failure",
      value: latestFailure ? `#${latestFailure.run}` : NO_DATA,
      tone: latestFailure ? "warn" : "neutral",
      detail:
        latestFailure?.asi?.rollback_reason ||
        latestFailure?.description ||
        "No rejected or failed run in this segment.",
    }),
  ];
}

function buildEvidenceReadout({
  researchIntegrity = null,
  researchTruth = null,
  trustState = null,
  current = [],
}: LooseObject) {
  const labels = Array.isArray(researchIntegrity?.evidenceLabels)
    ? researchIntegrity.evidenceLabels
    : [];
  const label =
    labels.find((item: string) => item === "promotion_eligible") ||
    labels.find((item: string) => item === "pending_repeat") ||
    labels.find((item: string) => item === "invalidated") ||
    labels.find((item: string) => item === "historical") ||
    labels.find((item: string) => item === "dev_best") ||
    labels[0] ||
    (current.length ? "exploratory" : "blocked");
  const normalized = label === "dev_best" ? "exploratory" : label;
  const reasons = unique([
    ...(researchIntegrity?.notPromotableBecause || []),
    ...(researchIntegrity?.warnings || []),
    ...(researchIntegrity?.blockers || []),
    ...(researchTruth?.suspiciousReasons || []),
    ...(trustState?.decisionWarnings || []),
  ]);
  return {
    label: normalized,
    title: labelText(normalized),
    promotable: normalized === "promotion_eligible",
    reasons,
  };
}

function buildEvidenceLedger(current: RunLike[] = []) {
  const registry = buildEvidenceRegistry({ runs: current });
  const latest = [...registry.audit]
    .reverse()
    .map((entry) => ({
      run: entry.run,
      status: entry.status,
      kind: entry.kind,
      name: entry.name || "",
      path: entry.path || "",
      evidenceStatus: entry.evidenceStatus,
      current: entry.current,
      description: entry.description || "",
    }))
    .slice(0, 5);
  return {
    counts: registry.counts,
    latest,
    acceptedCurrent: registry.acceptedCurrent.length,
    rule: "Accepted evidence can promote; rejected and quarantined evidence stays visible but does not drive promotion.",
  };
}

function normalizeProductClaimCoverage(value: unknown) {
  const coverage = recordOrNull(value);
  if (!coverage) return null;
  const missingRequiredProof = unique([
    ...stringList(coverage.missingRequiredProof),
    ...stringList(coverage.missingProof),
    ...stringList(coverage.requiredProofMissing),
  ]);
  const blockers = unique([
    ...stringList(coverage.blockers),
    ...stringList(coverage.blockingReasons),
    ...stringList(coverage.claimCoverageBlockers),
  ]);
  return {
    productGradeReady: coverage.productGradeReady === true,
    maturity:
      cleanText(coverage.maturity) ||
      (coverage.productGradeReady === true ? "product-grade" : "needs-proof"),
    missingRequiredProof,
    blockers,
  };
}

function buildDashboardSignals({
  productClaimCoverage = null,
  finalizePreview = null,
  trustBlockers = [],
}: LooseObject) {
  const signals = [];
  const productBlockers = [
    ...stringList(productClaimCoverage?.blockers),
    ...stringList(productClaimCoverage?.missingRequiredProof),
  ];
  if (productClaimCoverage && productClaimCoverage.productGradeReady === false) {
    signals.push({
      id: "product-proof",
      label: "Product proof missing",
      value: "Claim coverage blocked",
      detail: productBlockers[0] || "Product claim coverage is not release-ready.",
      tone: "warn",
      source: "claim coverage",
    });
  }
  const finalizationWarnings = [...stringList(finalizePreview?.warnings)];
  if (finalizationWarnings.length) {
    signals.push({
      id: "finalization-blocker",
      label: "Finalization blocker",
      value: "Preview gated",
      detail: finalizationWarnings[0],
      tone: "warn",
      source: "finalization",
    });
  }
  const trustMessages = stringList(trustBlockers)
    .map((item: unknown) => warningMessage(item))
    .filter(Boolean);
  if (trustMessages.length) {
    signals.push({
      id: "handoff-blocker",
      label: "Handoff blocker",
      value: "Review required",
      detail: trustMessages[0],
      tone: "warn",
      source: "trust",
    });
  }
  return signals;
}

function buildProofGaps({
  setupPlan = null,
  guidedSetup = null,
  researchIntegrity = null,
  productClaimCoverage = null,
  trustWarnings = [],
  action = null,
}: LooseObject) {
  const gaps = [];
  for (const blocker of productClaimCoverage?.blockers || []) {
    gaps.push({
      label: "Product proof",
      detail: String(blocker),
      nextAction: "Add or cite the missing claim coverage proof before handoff.",
    });
  }
  for (const missing of productClaimCoverage?.missingRequiredProof || []) {
    gaps.push({
      label: "Claim coverage",
      detail: String(missing),
      nextAction: "Attach durable product proof or mark the claim out of scope.",
    });
  }
  for (const missing of setupPlan?.missing || setupPlan?.missingEssentials || []) {
    gaps.push({
      label: "Missing setup",
      detail: String(missing),
      nextAction:
        setupPlan?.nextStep?.nextAction?.title ||
        setupPlan?.nextStep?.nextAction?.reason ||
        "Run setup-plan, doctor, then serve the dashboard.",
    });
  }
  for (const reason of researchIntegrity?.notPromotableBecause || []) {
    gaps.push({
      label: "Promotion proof",
      detail: String(reason),
      nextAction: action?.title || action?.detail || "",
    });
  }
  for (const warning of trustWarnings || []) {
    gaps.push({
      label: "Trust blocker",
      detail: String(warning),
      nextAction:
        guidedSetup?.nextStep?.nextAction?.title ||
        guidedSetup?.nextStep?.nextAction?.reason ||
        action?.title ||
        action?.detail ||
        "",
    });
  }
  if (!gaps.length && guidedSetup?.stage === "needs-baseline") {
    gaps.push({
      label: "Baseline",
      detail: "No baseline packet has been logged yet.",
      nextAction:
        guidedSetup?.nextStep?.nextAction?.title ||
        guidedSetup?.nextStep?.nextAction?.reason ||
        "Run the baseline packet, then log it with ASI.",
    });
  }
  return gaps.slice(0, 6);
}

export function buildFinalizationChecklist({
  current = [],
  kept = [],
  finalizePreview = null,
  finalizationPressure = null,
}: LooseObject) {
  const warnings = Array.isArray(finalizePreview?.warnings)
    ? finalizePreview.warnings.map((warning: unknown) => warningMessage(warning)).filter(Boolean)
    : [];
  const dirtyWarning = warnings.find((warning: string) => /dirty|clean/i.test(warning));
  return [
    checklistItem({
      label: "Kept evidence",
      state: kept.length ? "done" : current.length ? "blocked" : UNKNOWN,
      detail: kept.length
        ? `${kept.length} kept run${kept.length === 1 ? "" : "s"} can anchor review packaging.`
        : current.length
          ? "No kept run is available for review branches."
          : "No run data yet.",
    }),
    checklistItem({
      label: "Clean source tree",
      state: dirtyWarning ? "blocked" : finalizePreview ? "done" : UNKNOWN,
      detail:
        dirtyWarning ||
        (finalizePreview
          ? "No dirty-tree warning was reported by finalize preview."
          : "No finalize preview has been generated."),
    }),
    checklistItem({
      label: "Preview packet",
      state: finalizePreview?.ready
        ? "ready"
        : finalizePreview
          ? warnings.length
            ? "blocked"
            : "idle"
          : UNKNOWN,
      detail:
        finalizePreview?.nextAction ||
        warnings[0] ||
        "Run finalize-preview when kept evidence is ready.",
    }),
    checklistItem({
      label: "Review branches",
      state: finalizePreview?.ready ? "ready" : "blocked",
      detail: finalizePreview?.ready
        ? "Preview is ready; branch creation still stays outside the dashboard."
        : "Branch creation should wait for a ready preview packet.",
    }),
    checklistItem({
      label: "Finalization pressure",
      state:
        finalizationPressure?.status === "high"
          ? "blocked"
          : finalizationPressure?.status === "medium"
            ? "ready"
            : "idle",
      detail:
        finalizationPressure?.recommendation ||
        "No finalization pressure has accumulated in this segment.",
    }),
  ];
}

export function buildFinalizationPressure({
  kept = [],
  finalizePreview = null,
  watchdogSummary = null,
}: LooseObject) {
  const warnings = Array.isArray(finalizePreview?.warnings)
    ? finalizePreview.warnings.map((warning: unknown) => warningMessage(warning)).filter(Boolean)
    : [];
  const missingCommitCount = Number(finalizePreview?.missingCommitCount || 0);
  const backlog = Math.max(0, kept.length - Number(finalizePreview?.groups?.length || 0));
  const warningPressure = warnings.length + missingCommitCount + backlog;
  const high = kept.length >= 3 || warningPressure >= 3 || watchdogSummary?.stale === true;
  const medium = kept.length > 0 || warningPressure > 0;
  const reasons = [
    kept.length
      ? `${kept.length} kept run${kept.length === 1 ? "" : "s"} in the active segment.`
      : "",
    backlog ? `${backlog} kept run${backlog === 1 ? "" : "s"} are not in preview groups.` : "",
    missingCommitCount
      ? `${missingCommitCount} kept run${missingCommitCount === 1 ? "" : "s"} lack commit metadata.`
      : "",
    warnings[0] || "",
    watchdogSummary?.stale ? "Watchdog reports a stale no-progress window." : "",
  ].filter(Boolean);
  return {
    status: high ? "high" : medium ? "medium" : "low",
    keptCount: kept.length,
    warningCount: warnings.length,
    missingCommitCount,
    backlog,
    reasons,
    recommendation: high
      ? "Stop accumulating packets and run finalize-preview or rescope before more experiments."
      : medium
        ? "Preview finalization soon so kept work and warnings do not drift."
        : "Keep collecting evidence until reviewable work exists.",
  };
}

export function buildTrustBlockers({
  trustWarnings = [],
  guidedSetup = null,
  warnings = [],
  commands = [],
}: LooseObject) {
  const commandMap = commandLookup(commands);
  const raw = [
    ...stringList(trustWarnings),
    ...stringList(warnings),
    ...(guidedSetup?.stage === "stale-last-run"
      ? [guidedSetup?.lastRun?.freshness?.reason || guidedSetup.nextAction]
      : []),
    ...(guidedSetup?.stage === "limit-reached"
      ? [guidedSetup.nextAction || "Iteration limit reached."]
      : []),
  ];
  return unique(raw)
    .slice(0, 6)
    .map((message: string) => ({
      message,
      severity: /dirty|stale|drift|missing|limit|benchmark|commitPaths/i.test(message)
        ? "warning"
        : "info",
      action: blockerActionFor(message),
      command: blockerCommandFor(message, commandMap),
    }));
}

function blockerActionFor(message: string): string {
  if (/stale/i.test(message)) return "Replace the stale packet.";
  if (/limit/i.test(message)) return "Extend the limit or start a new segment.";
  if (/benchmark|metric/i.test(message)) return "Lint or repair the benchmark.";
  if (/dirty|commitPaths/i.test(message)) return "Inspect Git and commit paths.";
  if (/drift/i.test(message)) return "Verify installed/runtime routing.";
  return "Review before continuing.";
}

function blockerCommandFor(message: string, commandMap: CommandMap): string {
  if (/stale/i.test(message)) return commandMap.get("next run") || "";
  if (/limit/i.test(message))
    return commandMap.get("new segment") || commandMap.get("extend limit") || "";
  if (/benchmark|metric/i.test(message))
    return commandMap.get("benchmark lint") || commandMap.get("doctor") || "";
  if (/dirty|commitPaths|drift/i.test(message)) return commandMap.get("doctor") || "";
  return "";
}

export function buildDecisionReceipt({
  state,
  current = [],
  bestKept = null,
  latestFailure = null,
  action = null,
  trustBlockers = [],
}: LooseObject) {
  const latest = current.at(-1) || null;
  return {
    title: action?.title || "Next action",
    summary: action?.detail || "No next action available.",
    generatedAt: new Date().toISOString(),
    ledger: {
      segment: state.segment,
      runs: current.length,
      latestRun: latest ? compactRun(latest) : null,
      bestKept: bestKept ? compactRun(bestKept) : null,
      latestFailure: latestFailure ? compactRun(latestFailure) : null,
    },
    whySafe: action?.explanation?.evidence || action?.utilityCopy || "",
    avoids: action?.explanation?.avoids || "",
    proof: action?.explanation?.proof || "",
    blockers: trustBlockers,
  };
}

export function buildBestVsLatest({ state, current = [], bestKept = null }: LooseObject) {
  const latest = current.at(-1) || null;
  const latestMetric = finiteMetric(latest?.metric);
  const bestMetric = finiteMetric(bestKept?.metric ?? state.best);
  const baseline = finiteMetric(state.baseline);
  return {
    metricName: state.config.metricName,
    direction: state.config.bestDirection,
    baseline,
    best: bestMetric,
    bestRun: bestKept ? compactRun(bestKept) : null,
    latest: latestMetric,
    latestRun: latest ? compactRun(latest) : null,
    latestBeatsBest:
      latestMetric != null && bestMetric != null
        ? state.config.bestDirection === "higher"
          ? latestMetric > bestMetric
          : latestMetric < bestMetric
        : false,
    latestVsBestPercent:
      latestMetric != null && bestMetric != null
        ? percentChange(latestMetric, bestMetric, state.config.bestDirection)
        : null,
  };
}

export function buildHandoffPacket({
  state,
  current = [],
  action = null,
  trustBlockers = [],
  experimentMemory = null,
}: LooseObject) {
  return {
    kind: "dashboard-handoff",
    metric: state.config.metricName,
    direction: state.config.bestDirection,
    segment: state.segment,
    runs: current.length,
    latestRun: current.at(-1)?.run || null,
    nextAction: action?.detail || "",
    shouldFixFirst: trustBlockers.length > 0,
    blockers: trustBlockers.map((item: LooseObject) => item.message),
    lane: experimentMemory?.diversityGuidance?.id || experimentMemory?.summary?.suggestedLane || "",
    plateau: experimentMemory?.plateau?.detected === true,
  };
}

function staleSessionSummary({ guidedSetup = null, state, warnings = [] }: LooseObject) {
  const stage = guidedSetup?.stage || "";
  const limitReached = Boolean(guidedSetup?.state?.limit?.limitReached);
  const staleWarning = warnings.find((warning: LooseObject) =>
    /stale|drift/i.test(warning.message || ""),
  );
  return {
    stale:
      stage === "stale-last-run" ||
      limitReached ||
      Boolean(staleWarning) ||
      (Number(state?.current?.length) > 0 && state?.baseline == null),
    stage,
    reason:
      staleWarning?.message ||
      guidedSetup?.lastRun?.freshness?.reason ||
      (limitReached ? "Iteration limit reached." : ""),
    nextAction:
      stage === "limit-reached"
        ? "Extend the limit or start a new segment."
        : guidedSetup?.nextAction || "",
  };
}

function currentHasRuns(state: LooseObject): boolean {
  return Array.isArray(state?.current) && state.current.length > 0;
}

function normalizeMode(value: unknown): string {
  const text = cleanText(value);
  if (!text) return UNKNOWN;
  if (/live/i.test(text)) return "live-server";
  if (/static|export|snapshot|read-only/i.test(text)) return "static-export";
  return text;
}

function isTrustDecisionReason(value: unknown): boolean {
  return /dirty|corrupt|stale|drift|missing|invalid|parse|failed|error|refusing|changed/i.test(
    String(value || ""),
  );
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function labelText(value: unknown): string {
  return String(value || UNKNOWN)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function promotionGradeValue(source: LooseObject, latestMetrics: LooseObject): boolean | null {
  for (const value of [
    source.promotionGrade,
    source.promotion_grade,
    latestMetrics.promotionGrade,
    latestMetrics.promotion_grade,
  ]) {
    const result = boolOrNull(value);
    if (result !== null) return result;
  }
  return null;
}

function countValue(...values: unknown[]): number | null {
  for (const value of values) {
    const count = Number(value);
    if (Number.isFinite(count) && count >= 0) return Math.floor(count);
  }
  return null;
}

function boolOrNull(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((item: unknown) => warningMessage(item)).filter(Boolean);
  const text = cleanText(value);
  return text ? [text] : [];
}

function perfectMetricSuspicion({
  state,
  settings = {},
  current = [],
  qualityGap = null,
  queryCount,
  holdoutCount,
  adversarialCount,
  externalRepoCount,
  promotionGrade,
}: LooseObject): string[] {
  const latest = current.at(-1) || null;
  const perfectMetricNames = perfectQualityMetricNames({ state, latest });
  if (!isPerfectMetricState({ state, qualityGap }) && !perfectMetricNames.length) return [];
  const reasons = [];
  const hasFreshness = Boolean(
    settings.researchTruth?.fresh ||
    settings.researchTruth?.freshAt ||
    settings.researchTruth?.generatedAt ||
    settings.generatedAt ||
    latest?.timestamp ||
    latest?.generatedAt,
  );
  const hasBreadth = [queryCount, holdoutCount, adversarialCount, externalRepoCount].some(
    (value) => Number.isFinite(value) && value > 0,
  );
  if (perfectMetricNames.length) {
    reasons.push(`Perfect secondary metrics need corroboration: ${perfectMetricNames.join(", ")}.`);
  }
  if (!hasFreshness) reasons.push("Perfect metrics have no freshness evidence.");
  if (!hasBreadth) reasons.push("Perfect metrics have no breadth evidence.");
  if (promotionGrade !== true) reasons.push("Perfect metrics are not marked promotion-grade.");
  return reasons;
}

function perfectQualityMetricNames({
  state,
  latest,
}: {
  state: LooseObject;
  latest: RunLike | null;
}): string[] {
  const names = new Set<string>();
  const addIfPerfect = (name: unknown, value: unknown) => {
    if (!/mrr|hit|accuracy|quality|score/i.test(String(name || ""))) return;
    if (/promotion|query|holdout|adversarial|external/i.test(String(name || ""))) return;
    if (finiteMetric(value) === 1) names.add(String(name));
  };
  if (state?.config?.bestDirection === "higher") {
    addIfPerfect(state?.config?.metricName, state?.best);
  }
  for (const [name, value] of Object.entries(latest?.metrics || {})) {
    addIfPerfect(name, value);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function isPerfectMetricState({
  state,
  qualityGap,
}: {
  state: LooseObject;
  qualityGap: LooseObject | null;
}): boolean {
  const best = finiteMetric(state?.best);
  const metricName = String(state?.config?.metricName || "").toLowerCase();
  if (qualityGap && Number(qualityGap.open) === 0 && Number(qualityGap.total) > 0) return true;
  if (metricName === "quality_gap" && best === 0) return true;
  if (
    state?.config?.bestDirection === "lower" &&
    best === 0 &&
    /gap|error|fail|defect|issue/.test(metricName)
  )
    return true;
  return false;
}

function evidenceChip({
  label,
  value,
  tone = "neutral",
  detail = "",
}: {
  label: string;
  value: unknown;
  tone?: string;
  detail?: string;
}) {
  return {
    label,
    value: value == null || value === "" ? NO_DATA : String(value),
    tone,
    detail: detail || NO_DATA,
  };
}

function checklistItem({
  label,
  state = UNKNOWN,
  detail = "",
}: {
  label: string;
  state?: string;
  detail?: string;
}) {
  return {
    label,
    state: state || UNKNOWN,
    detail: detail || NO_DATA,
  };
}

function formatChipMetric(value: unknown, unit: string): string {
  const metric = finiteMetric(value);
  return metric == null ? NO_DATA : formatSummaryMetric(metric, unit || "");
}

function truthBreadthLabel(truth: LooseObject): string {
  const counts = [
    truth.queryCount,
    truth.holdoutCount,
    truth.adversarialCount,
    truth.externalRepoCount,
  ].filter((value: unknown) => Number.isFinite(value));
  if (!counts.length) return NO_DATA;
  return `${counts.reduce((sum, value) => sum + value, 0)} checks`;
}

function shouldPrioritizeFinalization({
  canFinalize,
  guidedSetup,
  hasQualityGaps,
  hasClosedQualityGapSet,
  lastMemoryAction,
  nextAction,
}: LooseObject) {
  if (!canFinalize || hasQualityGaps) return false;
  if (hasClosedQualityGapSet) return true;
  return (
    actionSuggestsFinalization(lastMemoryAction || nextAction) || iterationLimitReached(guidedSetup)
  );
}

function actionSuggestsFinalization(value: unknown): boolean {
  const action = cleanText(value);
  return (
    /^(stop|finali[sz]e|review|package|handoff|done)\b/i.test(action) ||
    /no credible next|no next packet|no remaining hypothesis/i.test(action)
  );
}

function iterationLimitReached(guidedSetup: LooseObject | null): boolean {
  const limit = guidedSetup?.state?.limit || guidedSetup?.limit || {};
  if (limit.limitReached === true) return true;
  const remaining = Number(limit.remainingIterations);
  return Number.isFinite(remaining) && remaining <= 0;
}

export function buildActionRail({
  current,
  bestKept,
  latestFailure,
  nextAction,
  decisionEnvelopeSummary = null,
  setupPlan,
  guidedSetup,
  qualityGap,
  finalizePreview,
  experimentMemory,
  commands,
}: LooseObject) {
  const commandMap = commandLookup(commands);
  const lastMemoryAction = experimentMemory?.latestNextAction || "";
  const qualityGapOpen = Number(qualityGap?.open);
  const hasQualityGaps = Number.isFinite(qualityGapOpen) && qualityGapOpen > 0;
  const hasClosedQualityGapSet =
    Boolean(qualityGap) &&
    Number.isFinite(qualityGapOpen) &&
    qualityGapOpen === 0 &&
    Number(qualityGap?.total) > 0;
  const canFinalize = Boolean(finalizePreview?.ready);
  const shouldFinalizeNow = shouldPrioritizeFinalization({
    canFinalize,
    guidedSetup,
    hasQualityGaps,
    hasClosedQualityGapSet,
    lastMemoryAction,
    nextAction,
  });

  let primary;
  if (decisionEnvelopeSummary?.kind && decisionEnvelopeSummary.kind !== "continue") {
    primary = actionFromDecisionEnvelope(decisionEnvelopeSummary, {
      guidedSetup,
      setupPlan,
      commandMap,
    });
  } else if (guidedSetup?.stage === "needs-setup") {
    primary = actionItem({
      kind: "setup",
      priority: "Critical",
      title: "Complete setup",
      detail:
        guidedSetup.nextAction || "Create or complete the session setup before running a baseline.",
      utilityCopy: "Setup comes before trustworthy metrics.",
      safeAction: "setup-plan",
      command: guidedSetup.commands?.setup || commandMap.get("setup plan"),
      commandLabel: "Setup",
      tone: "warn",
      source: "setup",
    });
  } else if (guidedSetup?.stage === "stale-last-run") {
    const stalePacketCommand =
      guidedSetup.commands?.replaceLast ||
      (setupPlan?.defaultBenchmarkCommandReady ? commandMap.get("next run") : "");
    primary = actionItem({
      kind: "stale-packet",
      priority: "Critical",
      title: "Replace the stale packet",
      detail:
        guidedSetup.lastRun?.freshness?.reason ||
        guidedSetup.nextAction ||
        "The saved last-run packet no longer matches the ledger.",
      utilityCopy: "Run a fresh packet before logging so old metrics cannot be reused.",
      safeAction: stalePacketCommand ? "" : "setup-plan",
      command: stalePacketCommand || guidedSetup.commands?.setup || commandMap.get("setup plan"),
      commandLabel: stalePacketCommand ? "Replace stale packet" : "Setup",
      tone: "warn",
      source: "packet",
    });
  } else if (guidedSetup?.stage === "needs-log-decision") {
    const suggested = guidedSetup.lastRun?.suggestedStatus || "keep or discard";
    primary = actionItem({
      kind: "log-decision",
      priority: "Critical",
      title: "Log the last packet",
      detail: `Record the last packet as ${suggested}, then run a new packet.`,
      utilityCopy: "Logging clears the packet so it cannot be reused by mistake.",
      command:
        guidedSetup.commands?.logLast ||
        commandMap.get("keep last") ||
        commandMap.get("discard last"),
      commandLabel: "Log",
      tone: "warn",
      source: "packet",
    });
  } else if (guidedSetup?.stage === "needs-benchmark-command") {
    primary = actionItem({
      kind: "benchmark-command",
      priority: "Critical",
      title: "Add a benchmark command",
      detail:
        guidedSetup.nextAction ||
        "This session has logged metrics, but next has no default benchmark script to run.",
      utilityCopy:
        "Measured loops need a repeatable command before the dashboard can send you to next.",
      safeAction: "setup-plan",
      command: guidedSetup.commands?.setup || commandMap.get("setup plan"),
      commandLabel: "Setup",
      tone: "warn",
      source: "setup",
    });
  } else if (!current.length) {
    primary = actionItem({
      kind: "baseline",
      priority: "Start",
      title: guidedSetup?.stage ? `Run ${guidedSetup.stage}` : "Capture the baseline",
      detail:
        guidedSetup?.nextAction || "Run the first measured packet so future changes have a floor.",
      utilityCopy: "Establish the benchmark floor before tuning.",
      command: guidedSetup?.commands?.baseline || commandMap.get("next run"),
      commandLabel: "Next",
      tone: "start",
      source: "baseline",
    });
  } else if (experimentMemory?.plateau?.detected) {
    const lane =
      experimentMemory.diversityGuidance ||
      (Array.isArray(experimentMemory.lanePortfolio) ? experimentMemory.lanePortfolio[0] : null);
    primary = actionItem({
      kind: "plateau",
      priority: "Critical",
      title: "Break the plateau",
      detail: lane?.nextActionHint || experimentMemory.plateau.recommendation,
      utilityCopy:
        experimentMemory.plateau.reason || "Recent runs are clustering without a new best.",
      command: commandMap.get("next run"),
      commandLabel: "Next",
      tone: "warn",
      source: lane?.id || "plateau",
    });
  } else if (shouldFinalizeNow) {
    primary = actionItem({
      kind: "finalize-preview",
      priority: "Review",
      title: "Preview finalization",
      detail:
        finalizePreview.nextAction || "Inspect the branch packet before creating review branches.",
      utilityCopy: "Turn kept evidence into a reviewable packet.",
      safeAction: "finalize-preview",
      command: commandMap.get("finalize preview"),
      commandLabel: "Preview finalization",
      tone: "good",
      source: "finalize",
    });
  } else if (hasQualityGaps) {
    primary = actionItem({
      kind: "continue",
      priority: "Narrow",
      title: "Pick a quality gap",
      detail: `${qualityGap.open} open gap${qualityGap.open === 1 ? "" : "s"} remain in ${qualityGap.slug}.`,
      utilityCopy: "Convert the next gap into one measurable hypothesis.",
      safeAction: "gap-candidates",
      command: commandMap.get("gap candidates"),
      commandLabel: "Gaps",
      tone: "focus",
      source: "quality-gap",
    });
  } else if (hasClosedQualityGapSet) {
    const detail =
      lastMemoryAction && /^stop\b|^stop iteration\b/i.test(lastMemoryAction)
        ? lastMemoryAction
        : `${qualityGap.total} accepted quality gap${qualityGap.total === 1 ? "" : "s"} are closed in ${qualityGap.slug}.`;
    primary = actionItem({
      kind: "complete",
      priority: "Complete",
      title: "Review completion state",
      detail,
      utilityCopy: finalizePreview?.warnings?.length
        ? "Accepted gaps are closed; resolve finalization warnings before creating review branches."
        : "Accepted gaps are closed; run a fresh gap preview only if you need another research round.",
      safeAction: "gap-candidates",
      command:
        commandMap.get("gap candidates") ||
        commandMap.get("finalize preview") ||
        commandMap.get("export dashboard"),
      commandLabel: commandMap.get("gap candidates") ? "Gaps" : "Review",
      tone: "good",
      source: "quality-gap",
    });
  } else if (lastMemoryAction || nextAction) {
    primary = actionItem({
      kind: "continue",
      priority: "Next",
      title: "Run the next measured hypothesis",
      detail: lastMemoryAction || nextAction,
      utilityCopy: latestFailure
        ? "Avoid repeating the rejected path."
        : "Use the latest ASI hint as the next loop input.",
      command: commandMap.get("next run"),
      commandLabel: "Next",
      tone: "focus",
      source: "asi-memory",
    });
  } else {
    primary = actionItem({
      kind: "continue",
      priority: "Decide",
      title: "Choose the next hypothesis",
      detail: "No ASI next action was recorded on the latest runs.",
      utilityCopy: "Add next_action_hint when logging the next result.",
      command: commandMap.get("next run"),
      commandLabel: "Next",
      tone: "warn",
      source: "memory",
    });
  }

  const secondary = [
    latestFailure &&
      actionItem({
        priority: "Avoid",
        title: `Revisit run #${latestFailure.run}`,
        detail:
          latestFailure.asi?.rollback_reason ||
          latestFailure.asi?.failure ||
          latestFailure.description ||
          "Recent failure needs a rollback reason.",
        utilityCopy: "Keep failed lanes visible before the next edit.",
        command: commandMap.get("discard last"),
        commandLabel: "Review",
        tone: "warn",
        source: "failure",
      }),
    bestKept &&
      actionItem({
        priority: "Anchor",
        title: `Best kept #${bestKept.run}`,
        detail:
          bestKept.description ||
          bestKept.asi?.hypothesis ||
          "Use the best kept run as the comparison anchor.",
        utilityCopy: "Compare future work against the strongest kept result.",
        command: commandMap.get("keep last"),
        commandLabel: "Anchor",
        tone: "good",
        source: "kept",
      }),
    actionItem({
      priority: "Safe",
      title: "Use the live readout",
      detail: "Open the served dashboard for fresh state and next-action context.",
      utilityCopy: "Static exports are fallback snapshots; CLI owns actions.",
      command: commandMap.get("serve dashboard") || commandMap.get("export dashboard"),
      commandLabel: commandMap.get("serve dashboard") ? "Live" : "Export",
      tone: "neutral",
      source: "serve",
    }),
  ].filter(Boolean);

  return [primary, ...secondary].slice(0, 4);
}

function actionFromDecisionEnvelope(
  summary: LooseObject,
  {
    guidedSetup = null,
    setupPlan = null,
    commandMap,
  }: { guidedSetup?: LooseObject | null; setupPlan?: LooseObject | null; commandMap: CommandMap },
) {
  const kind = cleanText(summary.kind) || "continue";
  const stalePacketCommand =
    guidedSetup?.commands?.replaceLast ||
    (setupPlan?.defaultBenchmarkCommandReady ? commandMap.get("next run") : "");
  const metadata = actionMetadataForKind(kind);
  const metadataCommand = fallbackCommandForKind(kind, (key) =>
    commandMap.get(dashboardCommandMapKey(key)),
  );
  const commandOverrides: Record<string, string> = {
    "stale-packet":
      stalePacketCommand || guidedSetup?.commands?.setup || commandMap.get("setup plan") || "",
    setup: guidedSetup?.commands?.setup || commandMap.get("setup plan") || "",
    "benchmark-command": guidedSetup?.commands?.setup || commandMap.get("setup plan") || "",
    "log-decision": guidedSetup?.commands?.logLast || "",
    baseline: guidedSetup?.commands?.baseline || commandMap.get("next run") || "",
  };
  const commandLabel = dashboardCommandLabelOverride(kind, {
    commandMap,
    stalePacketCommand,
  });
  const safeAction = dashboardSafeActionOverride(kind, { commandMap, stalePacketCommand });
  const packetBrake = isPacketBrakeKind(kind);
  return actionItem({
    kind,
    priority: cleanText(summary.priority) || "Next",
    title: cleanText(summary.title) || "Next action",
    detail: cleanText(summary.detail) || "Review the decision envelope before continuing.",
    utilityCopy: decisionEnvelopeUtility(kind),
    safeAction: safeAction ?? metadata?.safeAction ?? "",
    command:
      cleanText(summary.command) ||
      commandOverrides[kind] ||
      metadataCommand ||
      (packetBrake ? "" : commandMap.get("next run") || ""),
    commandLabel: commandLabel || metadata?.commandLabel || "Next",
    tone: ["finalize-preview", "finalization"].includes(kind)
      ? "good"
      : [
            "safety-blocker",
            "benchmark-mismatch",
            "gate-quality",
            "preflight",
            "portfolio-trust-blocker",
            "metric-saturation",
            "current-tree-finalization",
            "workflow-friction",
            "stale-packet",
            "setup",
            "benchmark-command",
            "decision-capsule",
            "log-decision",
            "watchdog",
            "plateau",
            "plateau-pivot",
          ].includes(kind)
        ? "warn"
        : "focus",
    source: cleanText(summary.source) || "decision-envelope",
  });
}

function dashboardCommandLabelOverride(
  kind: string,
  { commandMap, stalePacketCommand }: { commandMap: CommandMap; stalePacketCommand: string },
): string {
  if (kind === "stale-packet" && stalePacketCommand) return "Next";
  if (kind === "watchdog") return commandMap.get("finalize preview") ? "Preview" : "Inspect";
  if (kind === "segment-transition") {
    if (commandMap.get("new segment")) return "Segment";
    return commandMap.get("gap candidates") ? "Gaps" : "Review";
  }
  return "";
}

function dashboardSafeActionOverride(
  kind: string,
  { commandMap, stalePacketCommand }: { commandMap: CommandMap; stalePacketCommand: string },
): string | null {
  if (kind === "stale-packet" && stalePacketCommand) return "";
  if (kind === "watchdog") {
    return commandMap.get("finalize preview") ? "finalize-preview" : "inspect";
  }
  return null;
}

function decisionEnvelopeUtility(kind: string): string {
  if (kind === "safety-blocker") return "Safety blockers come before benchmark work.";
  if (kind === "workflow-friction")
    return "Workflow friction should be removed before spending another packet.";
  if (kind === "lane-cleanup") return "Lane cleanup comes before another measured packet.";
  if (kind === "runtime-provenance")
    return "Runtime provenance should be refreshed before trusting another packet.";
  if (kind === "packet-diagnostic")
    return "Packet diagnostics should explain the last run before another packet.";
  if (kind === "benchmark-mismatch")
    return "Benchmark timeout and command-shape mismatches come before reruns.";
  if (kind === "gate-quality")
    return "Independent gate quality should be repaired before another measured packet.";
  if (kind === "preflight") return "Preflight blockers come before another measured packet.";
  if (kind === "portfolio-trust-blocker")
    return "Portfolio trust blockers should be resolved before spending another packet.";
  if (kind === "metric-saturation")
    return "Saturated metrics need promotion evidence or a pivot before more packets.";
  if (kind === "current-tree-finalization")
    return "Current-tree finalization should describe the branch before review work continues.";
  if (kind === "stale-packet") return "Authoritative packet freshness blocks logging old metrics.";
  if (kind === "partial-salvage")
    return "Review completed artifact rows before rerunning an expensive failed packet.";
  if (kind === "context-distillation")
    return "Refresh bounded context before context loss repeats the same work.";
  if (kind === "decision-capsule")
    return "Imported session evidence can brake unsafe packets until its next experiment is cleared.";
  if (kind === "quality-gap")
    return "Accepted quality gaps should drive the next implementation step.";
  if (kind === "plateau-pivot") return "Plateau evidence should redirect the next hypothesis.";
  if (kind === "watchdog") return "A quiet progress window should trigger intervention.";
  if (kind === "finalization") return "Finalization is ready after higher-priority loop checks.";
  if (kind === "next-packet") return "The next packet should produce metric evidence and ASI.";
  if (kind === "setup") return "Setup blockers come before trustworthy metrics.";
  if (kind === "benchmark-command")
    return "A repeatable benchmark command comes before more segment work.";
  if (kind === "log-decision")
    return "A fresh packet decision should be logged before another run.";
  if (kind === "segment-transition")
    return "Segment or limit state should be resolved before more tuning.";
  if (kind === "plateau") return "Plateau evidence should redirect the next hypothesis.";
  if (kind === "finalize-preview")
    return "Finalization is ready after higher-priority loop checks.";
  if (kind === "baseline") return "Establish the benchmark floor before tuning.";
  return "Decision envelope is the authoritative next-action source.";
}

export function buildMissionControl({
  current,
  setupPlan,
  guidedSetup,
  qualityGap,
  finalizePreview,
  experimentMemory,
  actionRail,
  commands,
}: LooseObject) {
  const commandMap = commandLookup(commands);
  const stage = guidedSetup?.stage || "ready";
  const lastRun = guidedSetup?.lastRun || null;
  const allowedStatuses = Array.isArray(lastRun?.allowedStatuses) ? lastRun.allowedStatuses : [];
  const suggestedStatus =
    lastRun?.safeSuggestedStatus ||
    lastRun?.suggestedStatus ||
    (allowedStatuses.length === 1 ? allowedStatuses[0] : "");
  const hasFreshLastRun = Boolean(lastRun && lastRun?.freshness?.fresh !== false);
  const canLog = stage === "needs-log-decision" && hasFreshLastRun && allowedStatuses.length > 0;
  const qualityGapOpen = Number(qualityGap?.open);
  const hasQualityGaps = Number.isFinite(qualityGapOpen) && qualityGapOpen > 0;
  const setupState =
    stage === "needs-setup" ? "ready" : setupPlan?.configured || current.length ? "done" : "idle";
  const gapState = qualityGap ? (hasQualityGaps ? "ready" : "done") : "idle";
  const logState = lastRun ? (hasFreshLastRun ? "ready" : "blocked") : "idle";
  const finalizeState = finalizePreview?.ready ? "ready" : current.length ? "idle" : "blocked";
  const activeStep = canLog
    ? "log"
    : stage === "needs-setup"
      ? "setup"
      : hasQualityGaps
        ? "gaps"
        : finalizePreview?.ready
          ? "finalize"
          : qualityGap
            ? "gaps"
            : actionRail?.[0]?.kind || "next";
  return {
    activeStep,
    staticFallback: "Serve the dashboard locally for a fresh readout; use CLI for actions.",
    steps: [
      missionStep({
        id: "setup",
        title: "Setup",
        state: setupState,
        detail:
          guidedSetup?.stage === "needs-setup"
            ? guidedSetup.nextAction
            : "Session setup is readable.",
        safeAction: "setup-plan",
        command: guidedSetup?.commands?.setup || commandMap.get("setup plan"),
        commandLabel: "Setup",
      }),
      missionStep({
        id: "gaps",
        title: "Gap review",
        state: gapState,
        detail: qualityGap
          ? `${qualityGap.open} open / ${qualityGap.total} total in ${qualityGap.slug}.`
          : "No research gap file detected.",
        safeAction: "gap-candidates",
        command: commandMap.get("gap candidates"),
        commandLabel: "Gaps",
      }),
      missionStep({
        id: "log",
        title: "Log decision",
        state: logState,
        detail: canLog
          ? `Last packet is ready to log as ${suggestedStatus || "an allowed status"}.`
          : lastRun?.freshness?.reason || "No fresh last-run packet is waiting.",
      }),
      missionStep({
        id: "finalize",
        title: "Finalize",
        state: finalizeState,
        detail:
          finalizePreview?.nextAction || "Preview review branches after kept evidence is ready.",
        safeAction: "finalize-preview",
        command: commandMap.get("finalize preview"),
        commandLabel: "Preview",
      }),
    ],
    logDecision: {
      available: canLog,
      allowedStatuses,
      suggestedStatus,
      metric: lastRun?.metric ?? null,
      lastRunFingerprint: lastRun?.fingerprint || "",
      statusGuidance: lastRun?.statusGuidance || "",
      defaultDescription:
        suggestedStatus === "discard"
          ? "Describe the discarded packet"
          : suggestedStatus === "checks_failed"
            ? "Describe the failed checks"
            : "Describe the kept change",
      asiTemplate: lastRun?.asiTemplate || {},
      requiresDescription: true,
      requiresConfirmation: true,
    },
    nextAction:
      actionRail?.[0]?.detail ||
      experimentMemory?.latestNextAction ||
      guidedSetup?.nextAction ||
      "",
  };
}

function missionStep({
  id,
  title,
  state,
  detail,
  safeAction = "",
  command = "",
  commandLabel = "Copy read-only command",
  mutates = false,
}: {
  id: string;
  title: string;
  state: string;
  detail: string;
  safeAction?: string;
  command?: string;
  commandLabel?: string;
  mutates?: boolean;
}) {
  const safeCommand = dashboardReadOnlyCommand(command);
  return {
    id,
    title,
    state,
    detail,
    safeAction,
    command: safeCommand,
    primaryCommand: safeCommand ? { label: commandLabel, command: safeCommand } : null,
    mutates,
  };
}

function actionItem({
  kind = "continue",
  priority,
  title,
  detail,
  utilityCopy,
  safeAction = "",
  command = "",
  commandLabel = "Copy read-only command",
  tone = "neutral",
  source = "",
  explanation = null,
}: {
  kind?: string;
  priority: string;
  title: string;
  detail: string;
  utilityCopy: string;
  safeAction?: string;
  command?: string;
  commandLabel?: string;
  tone?: string;
  source?: string;
  explanation?: LooseObject | null;
}) {
  const safeCommand = dashboardReadOnlyCommand(command);
  return {
    kind,
    priority,
    title,
    detail,
    utilityCopy,
    packetBrake: isPacketBrakeKind(kind),
    explanation:
      explanation || buildActionExplanation({ kind, title, detail, utilityCopy, source }),
    safeAction,
    command: safeCommand,
    primaryCommand: safeCommand ? { label: commandLabel, command: safeCommand } : null,
    tone,
    source,
  };
}

function buildActionExplanation({
  kind,
  title,
  detail,
  utilityCopy,
  source,
}: {
  kind: string;
  title: string;
  detail: string;
  utilityCopy: string;
  source: string;
}) {
  return {
    why: detail || title || "This is the highest-priority action in the current loop state.",
    evidence:
      utilityCopy ||
      (source ? `Derived from ${source}.` : "Derived from the latest run state and ASI."),
    avoids: defaultAvoidance(kind),
    proof: defaultProof(kind),
  };
}

function defaultAvoidance(kind: string): string {
  if (kind === "setup") return "Avoids a baseline built on incomplete session metadata.";
  if (kind === "stale-packet") return "Avoids logging an old metric against newer run history.";
  if (kind === "log-decision")
    return "Avoids piling new experiments on top of an unrecorded packet.";
  if (kind === "benchmark-command")
    return "Avoids running an optimization loop with no repeatable measurement.";
  if (kind === "fix-blocker")
    return "Avoids trusting a loop while doctor or drift warnings are unresolved.";
  if (kind === "baseline") return "Avoids optimizing before a comparison floor exists.";
  if (kind === "current-tree-finalization")
    return "Avoids packaging stale kept-commit history when the current branch tree is the review unit.";
  if (kind === "plateau")
    return "Avoids repeating the same experiment family after signal has flattened.";
  if (kind === "finalize-preview")
    return "Avoids creating review branches before the evidence packet is understood.";
  if (kind === "complete")
    return "Avoids starting another run after the accepted gap set is already closed.";
  if (kind === "continue")
    return "Avoids losing the next ASI hint or repeating the latest rejected path.";
  return "Avoids acting without a clear operator reason.";
}

function defaultProof(kind: string): string {
  if (kind === "setup")
    return "The session has setup files, a configured metric, and a doctorable command.";
  if (kind === "stale-packet")
    return "A fresh next packet replaces the stale one and becomes loggable.";
  if (kind === "log-decision")
    return "The last-run packet is consumed and the ledger shows the decision.";
  if (kind === "benchmark-command")
    return "Doctor confirms the command emits the configured primary metric.";
  if (kind === "fix-blocker") return "Doctor returns without blocking issues or drift warnings.";
  if (kind === "baseline") return "Run 1 is logged and future changes compare against its metric.";
  if (kind === "current-tree-finalization")
    return "A finalize-current-tree preview or prerequisite logging covers the current non-session diff before review branch creation.";
  if (kind === "plateau") return "A different lane produces new evidence or a better metric.";
  if (kind === "finalize-preview")
    return "Finalize preview reports a ready review packet with no unresolved blockers.";
  if (kind === "complete")
    return "A fresh gap preview stays empty or finalization warnings are resolved.";
  if (kind === "continue")
    return "The next packet is logged with metric evidence and ASI for the following run.";
  return "The next run produces evidence that updates the dashboard state.";
}

function commandLookup(commands: unknown): CommandMap {
  const map: CommandMap = new Map();
  for (const item of Array.isArray(commands) ? commands : []) {
    const label = String(item?.label || "").toLowerCase();
    if (label) map.set(label, item.command || "");
  }
  return map;
}

function warningMessage(warning: unknown): string {
  if (warning && typeof warning === "object") {
    const payload = warning as LooseObject;
    return String(payload.message || payload.code || "Warning");
  }
  return String(warning || "");
}

export function buildAiSummary({
  state,
  current,
  kept,
  failures,
  bestKept,
  latestFailure,
  nextAction,
  nextTitle,
  qualityGap,
  finalizePreview,
  experimentMemory,
  warnings,
}: LooseObject) {
  const context = summaryMetricContext({ state, current });
  const metricName = state.config.metricName || "metric";
  const blockers = [
    ...(Array.isArray(warnings) ? warnings.map((warning: unknown) => warningMessage(warning)) : []),
    ...(Array.isArray(finalizePreview?.warnings) ? finalizePreview.warnings : []),
  ].filter(Boolean);

  return {
    title: current.length ? "Next move is ready." : "Run a baseline.",
    subtitle: nextTitle || "Ledger, ASI, gap state, and finalization preview.",
    happened: buildSummaryHappened({ current, kept, failures, metricName, ...context }).slice(0, 3),
    plan: unique(
      buildSummaryPlan({ bestKept, latestFailure, qualityGap, nextAction, finalizePreview }),
    ).slice(0, 3),
    blockers: blockers.slice(0, 2),
    generatedFrom: {
      runs: current.length,
      latestRun: context.latest?.run || null,
      latestActionHint: experimentMemory?.latestNextAction || "",
    },
  };
}

function summaryMetricContext({ state, current }: LooseObject) {
  const baseline = finiteMetric(state.baseline);
  const bestMetric = finiteMetric(state.best);
  const latest = current.at(-1) || null;
  return {
    unit: state.config.metricUnit ? ` ${state.config.metricUnit}` : "",
    direction: state.config.bestDirection === "higher" ? "higher is better" : "lower is better",
    baseline,
    bestMetric,
    latest,
    latestMetric: finiteMetric(latest?.metric),
    delta:
      baseline != null && bestMetric != null
        ? percentChange(bestMetric, baseline, state.config.bestDirection)
        : null,
  };
}

function buildSummaryHappened({
  current,
  kept,
  failures,
  metricName,
  unit,
  direction,
  baseline,
  bestMetric,
  latest,
  latestMetric,
  delta,
}: LooseObject) {
  if (!current.length) {
    return ["No experiments have been logged yet; the loop needs a measured baseline."];
  }
  const happened = [
    `${current.length} run${current.length === 1 ? "" : "s"} logged: ${kept.length} kept and ${failures.length} rejected or failed.`,
  ];
  if (baseline != null && bestMetric != null) {
    const movement = delta == null ? "" : ` (${delta >= 0 ? "+" : ""}${round(delta)}%)`;
    happened.push(
      `The best ${metricName} is ${formatSummaryMetric(bestMetric, unit)} against a ${formatSummaryMetric(baseline, unit)} baseline${movement}; ${direction}.`,
    );
  }
  if (latest) {
    happened.push(
      `Most recent run #${latest.run} was ${latest.status}${latestMetric == null ? "" : ` at ${formatSummaryMetric(latestMetric, unit)}`}.`,
    );
  }
  return happened;
}

function buildSummaryPlan({
  bestKept,
  latestFailure,
  qualityGap,
  nextAction,
  finalizePreview,
}: LooseObject) {
  const plan = [];
  if (bestKept) {
    plan.push(
      `Use kept run #${bestKept.run} as the comparison anchor unless the next packet beats it.`,
    );
  }
  if (latestFailure) {
    plan.push(
      `Avoid repeating #${latestFailure.run}: ${latestFailure.asi?.rollback_reason || latestFailure.description || "it did not improve the primary metric"}.`,
    );
  }
  if (qualityGap) {
    plan.push(
      qualityGap.open > 0
        ? `Work the next accepted gap in ${qualityGap.slug}; ${qualityGap.open} remain open.`
        : `Treat ${qualityGap.slug} as closed unless a fresh gap pass finds credible new work.`,
    );
  }
  if (nextAction) {
    plan.push(nextAction);
  }
  if (finalizePreview?.ready) {
    plan.push("Preview finalization and package the kept evidence for review.");
  }
  if (!plan.length) {
    plan.push(
      "Capture a clean baseline, then log the decision with ASI before the next experiment.",
    );
  }
  return plan;
}

function percentChange(best: number, baseline: number, direction: Direction): number | null {
  if (!Number.isFinite(best) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return null;
  const raw = ((best - baseline) / Math.abs(baseline)) * 100;
  return direction === "higher" ? raw : -raw;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatSummaryMetric(value: number, unit: string): string {
  return `${round(value)}${unit}`;
}

function unique<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item: T) => {
    const key = String(item || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordValue(value: unknown): LooseObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function recordOrNull(value: unknown): LooseObject | null {
  const record = recordValue(value);
  return Object.keys(record).length ? record : null;
}

function firstRecord(...values: unknown[]): LooseObject {
  for (const value of values) {
    const record = recordValue(value);
    if (Object.keys(record).length) return record;
  }
  return {};
}

function buildPortfolio(memory: LooseObject | null, direction: Direction) {
  if (Array.isArray(memory?.families) || Array.isArray(memory?.lanePortfolio)) {
    return {
      summary: {
        families: memory?.families?.length || 0,
        lanes: memory?.lanePortfolio?.length || 0,
        experiments: (memory?.kept?.length || 0) + (memory?.rejected?.length || 0),
        noveltyScore: memory?.novelty?.score ?? null,
      },
      families: Array.isArray(memory?.families) ? memory.families : [],
      lanes: Array.isArray(memory?.lanePortfolio) ? memory.lanePortfolio : [],
      plateau: memory?.plateau || { detected: false, recommendation: "" },
    };
  }
  const experiments = memoryExperiments(memory);
  const families = buildFamilies(experiments, direction);
  const lanes = buildLanes(memory, experiments);
  const plateau = buildPlateau(experiments, direction);
  return {
    summary: {
      families: families.length,
      lanes: lanes.length,
      experiments: experiments.length,
    },
    families,
    lanes,
    plateau,
  };
}

function memoryExperiments(memory: LooseObject | null): RunLike[] {
  const kept = Array.isArray(memory?.kept) ? memory.kept : [];
  const rejected = Array.isArray(memory?.rejected) ? memory.rejected : [];
  return (
    [
      ...kept.map((item: LooseObject) => ({ ...item, lane: "promote" })),
      ...rejected.map((item: LooseObject) => ({ ...item, lane: "avoid" })),
    ] as RunLike[]
  ).sort((a, b) => Number(a.run || 0) - Number(b.run || 0));
}

function buildFamilies(experiments: RunLike[], direction: Direction) {
  const byKey = new Map<string, LooseObject>();
  for (const item of experiments) {
    const source = item.hypothesis || item.description || `Run ${item.run}`;
    const key = familyKey(source);
    const existing = byKey.get(key) || {
      key,
      name: familyName(source),
      total: 0,
      kept: 0,
      rejected: 0,
      latestRun: null,
      latestStatus: "",
      bestMetric: null,
      lane: "explore",
    };
    existing.total += 1;
    if (item.status === "keep") existing.kept += 1;
    else existing.rejected += 1;
    existing.latestRun = item.run;
    existing.latestStatus = item.status;
    const metric = finiteMetric(item.metric);
    if (
      metric != null &&
      (existing.bestMetric == null || isBetter(metric, existing.bestMetric, direction))
    ) {
      existing.bestMetric = metric;
    }
    existing.lane =
      existing.kept && existing.rejected ? "mixed" : existing.kept ? "promote" : "avoid";
    byKey.set(key, existing);
  }
  return [...byKey.values()]
    .sort((a, b) => b.total - a.total || Number(b.latestRun || 0) - Number(a.latestRun || 0))
    .slice(0, 6);
}

function buildLanes(memory: LooseObject | null, experiments: RunLike[]) {
  const kept = experiments.filter((item) => item.status === "keep");
  const rejected = experiments.filter((item) => item.status !== "keep");
  const nextActions = Array.isArray(memory?.nextActions) ? memory.nextActions : [];
  return [
    {
      id: "promote",
      title: "Promote",
      count: kept.length,
      detail: kept.at(-1)?.description || kept.at(-1)?.hypothesis || "No kept lane yet.",
    },
    {
      id: "avoid",
      title: "Avoid",
      count: rejected.length,
      detail:
        rejected.at(-1)?.rollbackReason || rejected.at(-1)?.description || "No rejected lane yet.",
    },
    {
      id: "explore",
      title: "Explore",
      count: nextActions.length,
      detail: nextActions.at(-1)?.nextActionHint || "No queued ASI hint yet.",
    },
  ];
}

function buildPlateau(experiments: RunLike[], direction: Direction) {
  type FiniteExperiment = RunLike & { index: number; metric: number };
  const finite = experiments
    .map((item: RunLike, index: number) => ({ ...item, metric: finiteMetric(item.metric), index }))
    .filter((item): item is FiniteExperiment => item.metric != null);
  if (finite.length < 3) {
    return {
      state: "forming",
      title: "Signal forming",
      detail: "Plateau detection needs at least three finite experiment-memory metrics.",
      sinceBest: 0,
    };
  }
  let bestIndex = 0;
  for (let index = 1; index < finite.length; index += 1) {
    if (isBetter(finite[index].metric, finite[bestIndex].metric, direction)) bestIndex = index;
  }
  const sinceBest = finite.length - bestIndex - 1;
  const recent = finite.slice(-3);
  const recentSpread =
    Math.max(...recent.map((item) => item.metric)) - Math.min(...recent.map((item) => item.metric));
  const anchor = Math.max(1, Math.abs(finite[bestIndex].metric));
  const flat = sinceBest >= 2 && recentSpread / anchor < 0.03;
  if (flat) {
    return {
      state: "plateau",
      title: "Plateau likely",
      detail: `${sinceBest} finite run${sinceBest === 1 ? "" : "s"} since the best metric without a clear move.`,
      sinceBest,
    };
  }
  return {
    state: sinceBest ? "moving" : "new-best",
    title: sinceBest ? "Still moving" : "New best is latest",
    detail: sinceBest
      ? `${sinceBest} finite run${sinceBest === 1 ? "" : "s"} since the best metric; keep probing the active lane.`
      : "The newest best metric is still fresh.",
    sinceBest,
  };
}

function familyKey(value: unknown): string {
  return tokens(value).slice(0, 3).join("-") || "experiment";
}

function familyName(value: unknown): string {
  const picked = tokens(value).slice(0, 3);
  if (!picked.length) return "Experiment";
  return picked.map((token) => token.slice(0, 1).toUpperCase() + token.slice(1)).join(" ");
}

function tokens(value: unknown): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "all",
    "next",
    "run",
    "try",
    "use",
    "add",
  ]);
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token: string) => token.length > 2 && !stop.has(token));
}

function isBetter(next: number, current: number, direction: Direction): boolean {
  return direction === "higher" ? next > current : next < current;
}

function bestRun(runs: RunLike[], direction: Direction): (RunLike & { metric: number }) | null {
  let best: (RunLike & { metric: number }) | null = null;
  for (const run of runs) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    if (!best || (direction === "higher" ? metric > best.metric : metric < best.metric)) {
      best = { ...run, metric };
    }
  }
  return best;
}

function compactRun(run: RunLike) {
  return {
    run: run.run,
    metric: run.metric,
    status: run.status,
    description: redactEvidenceObject(run.description || ""),
    commit: run.commit || "",
    asi: redactEvidenceObject(run.asi || {}),
  };
}

function boundedMeasurementRunReadout(measurements: RunLike[]) {
  const bounded = measurements.slice(-DASHBOARD_READOUT_MEASUREMENT_RUN_LIMIT);
  return {
    runs: bounded.map((run) => compactRun(run)),
    omitted: Math.max(0, measurements.length - bounded.length),
    truncated: measurements.length > bounded.length,
  };
}
