import { STATUS_VALUES, finiteMetric } from "./session-core.js";

type LooseObject = Record<string, any>;

export function buildDashboardViewModel({
  state,
  settings = {},
  commands = [],
  setupPlan = null,
  guidedSetup = null,
  qualityGap = null,
  finalizePreview = null,
  recipes = [],
  experimentMemory = null,
  drift = null,
  warnings = [],
}: LooseObject) {
  const current = state.current || [];
  const kept = current.filter((run) => run.status === "keep");
  const failures = current.filter((run) =>
    ["discard", "crash", "checks_failed"].includes(run.status),
  );
  const bestKept = bestRun(kept, state.config.bestDirection);
  const latestFailure = failures.at(-1) || null;
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
  const portfolio = buildPortfolio(experimentMemory, state.config.bestDirection);
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
    researchTruth,
    trustState: trustContext.trustState,
  });
  const finalizationChecklist = buildFinalizationChecklist({
    current,
    kept,
    finalizePreview,
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
  return {
    setup: setupPlan,
    guidedSetup,
    lastRun: guidedSetup?.lastRun || null,
    qualityGap,
    finalizePreview,
    recipes,
    experimentMemory,
    portfolio,
    trustState: trustContext.trustState,
    researchTruth,
    evidenceChips,
    finalizationChecklist,
    missionControl,
    aiSummary,
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
      failed: failures.length,
      baseline: state.baseline,
      best: state.best,
      confidence: state.confidence,
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
  };
}

const UNKNOWN = "unknown";
const NO_DATA = "No data";

function buildTrustState({
  state,
  settings = {},
  setupPlan = null,
  guidedSetup = null,
  finalizePreview = null,
  drift = null,
  warnings = [],
}: LooseObject) {
  const taggedReasons = [];
  const mode = normalizeMode(
    firstValue(settings.deliveryMode, settings.mode, settings.dashboardMode),
  );
  const addReasons = (source, values, decisionRelevant = false, classifyDecisionReason = true) => {
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
      text: "Static export is read-only; serve the dashboard locally for guarded actions.",
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
  addReasons("guided-setup", guidedSetup?.warnings, true);
  addReasons("drift", drift?.warnings, true);
  addReasons("operator", warnings, true);
  addReasons("finalize", finalizePreview?.warnings, false, false);

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
      liveUrl: cleanText(firstValue(settings.liveUrl, settings.url, settings.dashboardUrl)) || null,
      pluginVersion:
        cleanText(
          firstValue(settings.pluginVersion, settings.version, state?.config?.pluginVersion),
        ) || UNKNOWN,
      runtimeDrift: summarizeRuntimeDrift(firstValue(settings.runtimeDrift, drift)),
      generatedAt:
        cleanText(
          firstValue(settings.generatedAt, settings.exportedAt, settings.snapshotGeneratedAt),
        ) || null,
      sourceCwd:
        cleanText(
          firstValue(
            settings.sourceCwd,
            settings.workDir,
            settings.cwd,
            state?.workDir,
            state?.cwd,
          ),
        ) || UNKNOWN,
    },
    decisionWarnings: unique(
      taggedReasons.filter((reason) => reason.decisionRelevant).map((reason) => reason.text),
    ),
  };
}

function summarizeRuntimeDrift(drift) {
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

function buildResearchTruth({
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
  const promotionGrade = boolOrNull(
    firstValue(
      source.promotionGrade,
      source.promotion_grade,
      latestMetrics.promotionGrade,
      latestMetrics.promotion_grade,
    ),
  );
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

function buildEvidenceChips({
  state,
  current = [],
  bestKept = null,
  latestFailure = null,
  researchTruth,
  trustState,
}: LooseObject) {
  const latest = current.at(-1) || null;
  const unit = state.config.metricUnit ? ` ${state.config.metricUnit}` : "";
  const baseline = finiteMetric(state.baseline);
  const best = finiteMetric(state.best);
  const delta = percentChange(best, baseline, state.config.bestDirection);
  return [
    evidenceChip({
      label: "Trust",
      value:
        trustState.status === "trusted"
          ? "Trusted"
          : trustState.status === "read-only"
            ? "Read-only"
            : trustState.status === UNKNOWN
              ? UNKNOWN
              : "Needs attention",
      tone:
        trustState.status === "trusted"
          ? "good"
          : trustState.status === "read-only"
            ? "neutral"
            : "warn",
      detail: trustState.reasons[0] || "No trust warnings reported by the model.",
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
      tone: latest?.status === "keep" ? "good" : latest?.status ? "warn" : "neutral",
      detail: latest
        ? `${formatChipMetric(latest.metric, unit)}. ${latest.description || "No description"}.`
        : "No logged runs yet.",
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

function buildFinalizationChecklist({
  current = [],
  kept = [],
  finalizePreview = null,
}: LooseObject) {
  const warnings = Array.isArray(finalizePreview?.warnings)
    ? finalizePreview.warnings.map(warningMessage).filter(Boolean)
    : [];
  const dirtyWarning = warnings.find((warning) => /dirty|clean/i.test(warning));
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
  ];
}

function currentHasRuns(state) {
  return Array.isArray(state?.current) && state.current.length > 0;
}

function normalizeMode(value) {
  const text = cleanText(value);
  if (!text) return UNKNOWN;
  if (/live/i.test(text)) return "live-server";
  if (/static|export|snapshot|read-only/i.test(text)) return "static-export";
  return text;
}

function isTrustDecisionReason(value) {
  return /dirty|corrupt|stale|drift|missing|invalid|parse|failed|error|refusing|changed/i.test(
    String(value || ""),
  );
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function countValue(...values) {
  for (const value of values) {
    const count = Number(value);
    if (Number.isFinite(count) && count >= 0) return Math.floor(count);
  }
  return null;
}

function boolOrNull(value) {
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

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => warningMessage(item)).filter(Boolean);
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
}: LooseObject) {
  if (!isPerfectMetricState({ state, qualityGap })) return [];
  const latest = current.at(-1) || null;
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

function isPerfectMetricState({ state, qualityGap }) {
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

function evidenceChip({ label, value, tone = "neutral", detail = "" }) {
  return {
    label,
    value: value == null || value === "" ? NO_DATA : String(value),
    tone,
    detail: detail || NO_DATA,
  };
}

function checklistItem({ label, state = UNKNOWN, detail = "" }) {
  return {
    label,
    state: state || UNKNOWN,
    detail: detail || NO_DATA,
  };
}

function formatChipMetric(value, unit) {
  const metric = finiteMetric(value);
  return metric == null ? NO_DATA : formatSummaryMetric(metric, unit || "");
}

function truthBreadthLabel(truth) {
  const counts = [
    truth.queryCount,
    truth.holdoutCount,
    truth.adversarialCount,
    truth.externalRepoCount,
  ].filter((value) => Number.isFinite(value));
  if (!counts.length) return NO_DATA;
  return `${counts.reduce((sum, value) => sum + value, 0)} checks`;
}

function buildActionRail({
  current,
  bestKept,
  latestFailure,
  nextAction,
  setupPlan,
  guidedSetup,
  qualityGap,
  finalizePreview,
  experimentMemory,
  drift,
  warnings: operatorWarnings = [],
  trustWarnings = [],
  commands,
}: LooseObject) {
  const commandMap = commandLookup(commands);
  const warnings = [
    ...(current.length ? [] : Array.isArray(setupPlan?.missing) ? setupPlan.missing : []),
    ...(Array.isArray(setupPlan?.warnings) ? setupPlan.warnings : []),
    ...(Array.isArray(drift?.warnings) ? drift.warnings : []),
    ...operatorWarnings,
    ...trustWarnings,
  ];
  const lastMemoryAction = experimentMemory?.latestNextAction || "";
  const qualityGapOpen = Number(qualityGap?.open);
  const hasQualityGaps = Number.isFinite(qualityGapOpen) && qualityGapOpen > 0;
  const hasClosedQualityGapSet =
    Boolean(qualityGap) &&
    Number.isFinite(qualityGapOpen) &&
    qualityGapOpen === 0 &&
    Number(qualityGap?.total) > 0;
  const canFinalize = Boolean(finalizePreview?.ready);

  let primary;
  if (guidedSetup?.stage === "needs-setup") {
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
      commandLabel: stalePacketCommand ? "Next" : "Setup",
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
  } else if (warnings.length) {
    primary = actionItem({
      kind: "fix-blocker",
      priority: "Critical",
      title: "Clear setup drift",
      detail: warningMessage(warnings[0]),
      utilityCopy: "Trust the loop after doctor is clean.",
      safeAction: "doctor",
      command: commandMap.get("doctor"),
      commandLabel: "Doctor",
      tone: "warn",
      source: "doctor",
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
  } else if (canFinalize) {
    primary = actionItem({
      kind: "finalize-preview",
      priority: "Review",
      title: "Preview finalization",
      detail:
        finalizePreview.nextAction || "Inspect the branch packet before creating review branches.",
      utilityCopy: "Turn kept evidence into a reviewable packet.",
      safeAction: "finalize-preview",
      command: commandMap.get("finalize preview"),
      commandLabel: "Preview",
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
      title: "Use the live runboard",
      detail: "Open the served dashboard for live refresh and guarded actions.",
      utilityCopy: "Static exports are fallback snapshots; the live URL is the operator surface.",
      command: commandMap.get("serve dashboard") || commandMap.get("export dashboard"),
      commandLabel: commandMap.get("serve dashboard") ? "Live" : "Export",
      tone: "neutral",
      source: "serve",
    }),
  ].filter(Boolean);

  return [primary, ...secondary].slice(0, 4);
}

function buildMissionControl({
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
  const logCommandsByStatus = Object.fromEntries(
    allowedStatuses.map((status) => [
      status,
      logCommandForStatus(guidedSetup?.commands?.logLast, status),
    ]),
  );

  return {
    activeStep,
    staticFallback:
      "Serve the dashboard locally for guarded live actions; static snapshots stay read-only.",
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
        command:
          guidedSetup?.commands?.logLast ||
          commandMap.get("keep last") ||
          commandMap.get("discard last"),
        commandLabel: "Log",
        mutates: true,
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
      mutates: true,
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
      command: guidedSetup?.commands?.logLast || "",
      commandsByStatus: logCommandsByStatus,
      liveAction: suggestedStatus ? `log-${String(suggestedStatus).replace(/_/g, "-")}` : "",
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
  commandLabel = "Copy",
  mutates = false,
}) {
  return {
    id,
    title,
    state,
    detail,
    safeAction,
    command,
    primaryCommand: command ? { label: commandLabel, command } : null,
    mutates,
  };
}

function logCommandForStatus(command, status) {
  if (!command || !status) return "";
  return String(command).replace(/--status\s+(?:"[^"]+"|'[^']+'|\S+)/, `--status ${status}`);
}

function actionItem({
  kind = "continue",
  priority,
  title,
  detail,
  utilityCopy,
  safeAction = "",
  command = "",
  commandLabel = "Copy",
  tone = "neutral",
  source = "",
  explanation = null,
}) {
  return {
    kind,
    priority,
    title,
    detail,
    utilityCopy,
    explanation:
      explanation || buildActionExplanation({ kind, title, detail, utilityCopy, source }),
    safeAction,
    command,
    primaryCommand: command ? { label: commandLabel, command } : null,
    tone,
    source,
  };
}

function buildActionExplanation({ kind, title, detail, utilityCopy, source }) {
  return {
    why: detail || title || "This is the highest-priority action in the current loop state.",
    evidence:
      utilityCopy ||
      (source ? `Derived from ${source}.` : "Derived from the latest run state and ASI."),
    avoids: defaultAvoidance(kind),
    proof: defaultProof(kind),
  };
}

function defaultAvoidance(kind) {
  if (kind === "setup") return "Avoids a baseline built on incomplete session metadata.";
  if (kind === "stale-packet") return "Avoids logging an old metric against newer run history.";
  if (kind === "log-decision")
    return "Avoids piling new experiments on top of an unrecorded packet.";
  if (kind === "benchmark-command")
    return "Avoids running an optimization loop with no repeatable measurement.";
  if (kind === "fix-blocker")
    return "Avoids trusting a loop while doctor or drift warnings are unresolved.";
  if (kind === "baseline") return "Avoids optimizing before a comparison floor exists.";
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

function defaultProof(kind) {
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
  if (kind === "plateau") return "A different lane produces new evidence or a better metric.";
  if (kind === "finalize-preview")
    return "Finalize preview reports a ready review packet with no unresolved blockers.";
  if (kind === "complete")
    return "A fresh gap preview stays empty or finalization warnings are resolved.";
  if (kind === "continue")
    return "The next packet is logged with metric evidence and ASI for the following run.";
  return "The next run produces evidence that updates the dashboard state.";
}

function commandLookup(commands) {
  const map = new Map();
  for (const item of Array.isArray(commands) ? commands : []) {
    const label = String(item?.label || "").toLowerCase();
    if (label) map.set(label, item.command || "");
  }
  return map;
}

function warningMessage(warning) {
  if (warning && typeof warning === "object")
    return String(warning.message || warning.code || "Warning");
  return String(warning || "");
}

function buildAiSummary({
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
  const metricName = state.config.metricName || "metric";
  const unit = state.config.metricUnit ? ` ${state.config.metricUnit}` : "";
  const direction =
    state.config.bestDirection === "higher" ? "higher is better" : "lower is better";
  const baseline = finiteMetric(state.baseline);
  const bestMetric = finiteMetric(state.best);
  const latest = current.at(-1) || null;
  const latestMetric = finiteMetric(latest?.metric);
  const delta =
    baseline != null && bestMetric != null
      ? percentChange(bestMetric, baseline, state.config.bestDirection)
      : null;
  const happened = [];
  const plan = [];
  const blockers = [
    ...(Array.isArray(warnings) ? warnings.map(warningMessage) : []),
    ...(Array.isArray(finalizePreview?.warnings) ? finalizePreview.warnings : []),
  ].filter(Boolean);

  if (!current.length) {
    happened.push("No experiments have been logged yet; the loop needs a measured baseline.");
  } else {
    happened.push(
      `${current.length} run${current.length === 1 ? "" : "s"} logged: ${kept.length} kept and ${failures.length} rejected or failed.`,
    );
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
  }

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

  return {
    title: current.length ? "Next move is ready." : "Run a baseline.",
    subtitle: nextTitle || "Ledger, ASI, gap state, and finalization preview.",
    happened: happened.slice(0, 3),
    plan: unique(plan).slice(0, 3),
    blockers: blockers.slice(0, 2),
    generatedFrom: {
      runs: current.length,
      latestRun: latest?.run || null,
      latestActionHint: experimentMemory?.latestNextAction || "",
    },
  };
}

function percentChange(best, baseline, direction) {
  if (!Number.isFinite(best) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return null;
  const raw = ((best - baseline) / Math.abs(baseline)) * 100;
  return direction === "higher" ? raw : -raw;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function formatSummaryMetric(value, unit) {
  return `${round(value)}${unit}`;
}

function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function buildPortfolio(memory, direction) {
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

function memoryExperiments(memory) {
  const kept = Array.isArray(memory?.kept) ? memory.kept : [];
  const rejected = Array.isArray(memory?.rejected) ? memory.rejected : [];
  return [
    ...kept.map((item) => ({ ...item, lane: "promote" })),
    ...rejected.map((item) => ({ ...item, lane: "avoid" })),
  ].sort((a, b) => Number(a.run || 0) - Number(b.run || 0));
}

function buildFamilies(experiments, direction) {
  const byKey = new Map();
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

function buildLanes(memory, experiments) {
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

function buildPlateau(experiments, direction) {
  const finite = experiments
    .map((item, index) => ({ ...item, metric: finiteMetric(item.metric), index }))
    .filter((item) => item.metric != null);
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

function familyKey(value) {
  return tokens(value).slice(0, 3).join("-") || "experiment";
}

function familyName(value) {
  const picked = tokens(value).slice(0, 3);
  if (!picked.length) return "Experiment";
  return picked.map((token) => token.slice(0, 1).toUpperCase() + token.slice(1)).join(" ");
}

function tokens(value) {
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
    .filter((token) => token.length > 2 && !stop.has(token));
}

function isBetter(next, current, direction) {
  return direction === "higher" ? next > current : next < current;
}

function bestRun(runs, direction) {
  let best = null;
  for (const run of runs) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    if (!best || (direction === "higher" ? metric > best.metric : metric < best.metric)) {
      best = { ...run, metric };
    }
  }
  return best;
}

function compactRun(run) {
  return {
    run: run.run,
    metric: run.metric,
    status: run.status,
    description: run.description || "",
    commit: run.commit || "",
    asi: run.asi || {},
  };
}
