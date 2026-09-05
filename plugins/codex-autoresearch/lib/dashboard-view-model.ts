import { STATUS_VALUES, finiteMetric } from "./session-core.js";
import { redactEvidenceObject } from "./evidence-redaction.js";
import { acceptedCurrentRuns, buildEvidenceRegistry } from "./evidence-registry.js";
import { buildAiSummary } from "./dashboard-view-model/ai-summary.js";
import { buildMissionControl } from "./dashboard-view-model/mission-control.js";
import { buildWatchdogSummary } from "./watchdog-summary.js";
import { actionMetadataForKind } from "./action-metadata.js";
import {
  dashboardReadOnlyCommand,
  stripDashboardGuidanceCommandFields,
} from "./dashboard-command-safety.js";
import { parseDashboardContext, type DashboardContext } from "./types/dashboard-wire.js";

export { buildAiSummary } from "./dashboard-view-model/ai-summary.js";
export { buildMissionControl } from "./dashboard-view-model/mission-control.js";
export { buildWatchdogSummary } from "./watchdog-summary.js";

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
  } = normalizeDashboardContext(parseDashboardContext(context));
  const current = (state.current || []) as RunLike[];
  const ledgerSummary = (state.dashboardLedgerSummary as LooseObject) || null;
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
  const decisionEnvelope = projectDashboardDecisionEnvelope({ state });
  const decisionEnvelopeSummary = summarizeDecisionEnvelope({
    envelope: decisionEnvelope,
    current,
    measurements,
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
  const viewModel = sanitizeDashboardDecisionEnvelope({
    setup: setupPlan,
    guidedSetup,
    decisionPlanProjection: state.decisionPlanProjection || null,
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
      runs: ledgerSummary?.currentRunCount ?? current.length,
      kept: ledgerSummary?.acceptedRunCount ?? kept.length,
      measured: ledgerSummary?.measurementRunCount ?? measurements.length,
      failed: ledgerSummary?.failedRunCount ?? failures.length,
      baseline: state.baseline,
      best: state.best,
      development: state.development || null,
      promotion: state.promotion || null,
      confidence: state.confidence,
      evidenceLabels: researchIntegrity?.evidenceLabels || [],
      statusCounts: Object.fromEntries(
        [...STATUS_VALUES].map((status) => [
          status,
          ledgerSummary?.statusCounts?.[status] ??
            current.filter((run) => run.status === status).length,
        ]),
      ),
      settings,
    },
    readout: {
      bestKept: bestKept ? compactRun(bestKept) : null,
      latestFailure: latestFailure ? compactRun(latestFailure) : null,
      measurementRuns: measurementReadout.runs,
      measurementRunCount: ledgerSummary?.measurementRunCount ?? measurements.length,
      measurementRunsOmitted: Math.max(
        0,
        Number(ledgerSummary?.measurementRunCount ?? measurements.length) -
          measurementReadout.runs.length,
      ),
      measurementRunsTruncated:
        Number(ledgerSummary?.measurementRunCount ?? measurements.length) >
        measurementReadout.runs.length,
      nextAction: actionRail[0]?.detail || nextAction,
      confidenceText:
        state.confidence == null
          ? "Movement / spread needs three finite runs and nonzero history spread. It is not statistical confidence."
          : "Movement / spread divides improvement by history median absolute deviation across experiments. It is not statistical confidence.",
      finalizeText: finalizePreview?.ready
        ? "Ready to preview final review branches."
        : finalizePreview?.nextAction || "Keep evidence or run finalize-preview when ready.",
    },
    commands,
  });
  const projectedPlan = recordOrNull(viewModel.decisionPlanProjection);
  const projectedAction = recordOrNull(projectedPlan?.action);
  if (projectedAction) projectedAction.command = "";
  return viewModel;
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

function projectDashboardDecisionEnvelope({ state }: LooseObject): LooseObject {
  const plan = recordOrNull(state?.decisionPlanProjection);
  const action = recordOrNull(plan?.action);
  const display = recordOrNull(plan?.display);
  const capabilities = recordOrNull(plan?.capabilities);
  const loopDisposition = recordOrNull(plan?.loopDisposition);
  const parentDisposition = recordOrNull(plan?.parentDisposition);
  const nextAction =
    cleanText(display?.actionReason) || cleanText(action?.kind) || "Decision unavailable.";
  const blockerCode = cleanText(plan?.primaryBlockerCode);
  const canonicalNextAction = {
    kind: cleanText(action?.kind) || "decision-unavailable",
    reason: nextAction,
    command: "",
    commandDigest: cleanText(action?.commandDigest),
    triggeredBy: blockerCode ? [blockerCode] : [],
  };
  return sanitizeDashboardDecisionEnvelope({
    compilerSchemaVersion: plan?.compilerSchemaVersion || null,
    decisionId: cleanText(plan?.decisionId),
    generationId: cleanText(plan?.generationId),
    phase: cleanText(plan?.phase) || "recovery",
    primaryBlockerCode: blockerCode || null,
    parentDisposition: cleanText(parentDisposition?.kind) || "block-final-answer",
    contractDigest: cleanText(plan?.contractDigest),
    evaluatorIdentity: cleanText(plan?.evaluatorIdentity),
    canonicalNextAction,
    loopContract: {
      ok: loopDisposition?.kind !== "blocked",
      complete: loopDisposition?.kind === "complete",
      canRunNextPacket: capabilities?.["run-packet"] === "allowed",
      blockers: blockerCode ? [{ kind: blockerCode, message: blockerCode }] : [],
      warnings: [],
      strongestAction: blockerCode ? canonicalNextAction : null,
    },
    nextAction,
  });
}

function summarizeDecisionEnvelope({ envelope, current = [], measurements = [] }: LooseObject) {
  const canonicalSummary = summaryFromCanonicalNextAction(envelope?.canonicalNextAction, {
    current,
    measurements,
    envelope,
  });
  if (canonicalSummary) return canonicalSummary;

  const summary = {
    kind: "decision-unavailable",
    priority: "Critical",
    title: "Decision unavailable",
    detail: "Refresh state before choosing another action.",
    source: "decision-envelope",
    fresh: null,
    segment: null,
    runs: current.length,
    measurementRuns: measurements.length,
    finalizationReady: null,
  };

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
    blockerCode: cleanText(envelope?.primaryBlockerCode),
    canRunPacket: envelope?.loopContract?.canRunNextPacket === true,
    source: "decision-plan",
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
  if (!isExplicitQualityGapCompletion(qualityGap)) return [];
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
  if (!hasFreshness) reasons.push("Perfect metrics have no freshness evidence.");
  if (!hasBreadth) reasons.push("Perfect metrics have no breadth evidence.");
  if (promotionGrade !== true) reasons.push("Perfect metrics are not marked promotion-grade.");
  return reasons;
}

function isExplicitQualityGapCompletion(qualityGap: LooseObject | null): boolean {
  return Boolean(qualityGap && Number(qualityGap.open) === 0 && Number(qualityGap.total) > 0);
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

export function buildActionRail({
  bestKept,
  latestFailure,
  decisionEnvelopeSummary = null,
  commands,
}: LooseObject) {
  const commandMap = commandLookup(commands);
  const canonicalSummary =
    decisionEnvelopeSummary?.kind && typeof decisionEnvelopeSummary.canRunPacket === "boolean"
      ? decisionEnvelopeSummary
      : {
          kind: "decision-unavailable",
          priority: "Critical",
          title: "Decision unavailable",
          detail: "Refresh state to load the canonical capability decision.",
          source: "decision-plan",
          canRunPacket: false,
        };
  const primary = actionFromDecisionEnvelope(canonicalSummary);

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

function actionFromDecisionEnvelope(summary: LooseObject) {
  const kind = cleanText(summary.kind) || "continue";
  return actionItem({
    kind,
    priority: cleanText(summary.priority) || "Next",
    title: cleanText(summary.title) || "Next action",
    detail: cleanText(summary.detail) || "Review the decision envelope before continuing.",
    utilityCopy: "This action is projected from the canonical session decision.",
    command: cleanText(summary.command),
    commandLabel: "Inspect",
    tone: cleanText(summary.blockerCode) ? "warn" : "focus",
    source: cleanText(summary.source) || "decision-plan",
    packetBrake: typeof summary.canRunPacket === "boolean" ? !summary.canRunPacket : undefined,
  });
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
  packetBrake,
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
  packetBrake?: boolean;
}) {
  const safeCommand = dashboardReadOnlyCommand(command);
  return {
    kind,
    priority,
    title,
    detail,
    utilityCopy,
    packetBrake: packetBrake ?? false,
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
