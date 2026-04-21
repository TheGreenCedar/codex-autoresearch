import { STATUS_VALUES, finiteMetric } from "./session-core.mjs";

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
}) {
  const current = state.current || [];
  const kept = current.filter((run) => run.status === "keep");
  const failures = current.filter((run) => ["discard", "crash", "checks_failed"].includes(run.status));
  const bestKept = bestRun(kept, state.config.bestDirection);
  const latestFailure = failures.at(-1) || null;
  const nextAction = [...current].reverse()
    .map((run) => run.asi?.next_action_hint || run.asi?.nextAction || run.asi?.next_action)
    .find(Boolean) || (current.length ? "Choose the next measured hypothesis." : "Run and log a baseline.");
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
    commands,
  });
  const portfolio = buildPortfolio(experimentMemory, state.config.bestDirection);
  return {
    setup: setupPlan,
    guidedSetup,
    lastRun: guidedSetup?.lastRun || null,
    qualityGap,
    finalizePreview,
    recipes,
    experimentMemory,
    portfolio,
    nextBestAction: actionRail[0],
    actionRail,
    drift,
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
      statusCounts: Object.fromEntries([...STATUS_VALUES].map((status) => [
        status,
        current.filter((run) => run.status === status).length,
      ])),
      settings,
    },
    readout: {
      bestKept: bestKept ? compactRun(bestKept) : null,
      latestFailure: latestFailure ? compactRun(latestFailure) : null,
      nextAction: actionRail[0]?.detail || nextAction,
      confidenceText: state.confidence == null
        ? "Confidence needs at least three finite metric runs and enough signal over noise."
        : "Confidence compares best movement against median absolute deviation.",
      finalizeText: finalizePreview?.ready
        ? "Ready to preview final review branches."
        : finalizePreview?.nextAction || "Keep evidence or run finalize-preview when ready.",
    },
    commands,
  };
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
  commands,
}) {
  const commandMap = commandLookup(commands);
  const warnings = [
    ...(current.length ? [] : Array.isArray(setupPlan?.missing) ? setupPlan.missing : []),
    ...(Array.isArray(setupPlan?.warnings) ? setupPlan.warnings : []),
    ...(Array.isArray(drift?.warnings) ? drift.warnings : []),
  ];
  const lastMemoryAction = experimentMemory?.latestNextAction || "";
  const qualityGapOpen = Number(qualityGap?.open);
  const hasQualityGaps = Number.isFinite(qualityGapOpen) && qualityGapOpen > 0;
  const canFinalize = Boolean(finalizePreview?.ready);

  let primary;
  if (guidedSetup?.stage === "needs-setup") {
    primary = actionItem({
      kind: "setup",
      priority: "Critical",
      title: "Complete setup",
      detail: guidedSetup.nextAction || "Create or complete the session setup before running a baseline.",
      utilityCopy: "Setup comes before trustworthy metrics.",
      safeAction: "setup-plan",
      command: guidedSetup.commands?.setup || commandMap.get("setup plan"),
      commandLabel: "Setup",
      tone: "warn",
      source: "setup",
    });
  } else if (guidedSetup?.stage === "stale-last-run") {
    const stalePacketCommand = guidedSetup.commands?.replaceLast
      || (setupPlan?.defaultBenchmarkCommandReady ? commandMap.get("next run") : "");
    primary = actionItem({
      kind: "stale-packet",
      priority: "Critical",
      title: "Replace the stale packet",
      detail: guidedSetup.lastRun?.freshness?.reason || guidedSetup.nextAction || "The saved last-run packet no longer matches the ledger.",
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
      command: guidedSetup.commands?.logLast || commandMap.get("keep last") || commandMap.get("discard last"),
      commandLabel: "Log",
      tone: "warn",
      source: "packet",
    });
  } else if (guidedSetup?.stage === "needs-benchmark-command") {
    primary = actionItem({
      kind: "benchmark-command",
      priority: "Critical",
      title: "Add a benchmark command",
      detail: guidedSetup.nextAction || "This session has logged metrics, but next has no default benchmark script to run.",
      utilityCopy: "Measured loops need a repeatable command before the dashboard can send you to next.",
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
      detail: String(warnings[0]),
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
      detail: guidedSetup?.nextAction || setupPlan?.nextCommand || "Run the first measured packet so future changes have a floor.",
      utilityCopy: "Establish the benchmark floor before tuning.",
      command: guidedSetup?.commands?.baseline || commandMap.get("next run"),
      commandLabel: "Next",
      tone: "start",
      source: "baseline",
    });
  } else if (experimentMemory?.plateau?.detected) {
    const lane = experimentMemory.diversityGuidance || (Array.isArray(experimentMemory.lanePortfolio) ? experimentMemory.lanePortfolio[0] : null);
    primary = actionItem({
      kind: "plateau",
      priority: "Critical",
      title: "Break the plateau",
      detail: lane?.nextActionHint || experimentMemory.plateau.recommendation,
      utilityCopy: experimentMemory.plateau.reason || "Recent runs are clustering without a new best.",
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
      detail: finalizePreview.nextAction || "Inspect the branch packet before creating review branches.",
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
  } else if (lastMemoryAction || nextAction) {
    primary = actionItem({
      kind: "continue",
      priority: "Next",
      title: "Run the next measured hypothesis",
      detail: lastMemoryAction || nextAction,
      utilityCopy: latestFailure ? "Avoid repeating the rejected path." : "Use the latest ASI hint as the next loop input.",
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
    latestFailure && actionItem({
      priority: "Avoid",
      title: `Revisit run #${latestFailure.run}`,
      detail: latestFailure.asi?.rollback_reason || latestFailure.asi?.failure || latestFailure.description || "Recent failure needs a rollback reason.",
      utilityCopy: "Keep failed lanes visible before the next edit.",
      command: commandMap.get("discard last"),
      commandLabel: "Review",
      tone: "warn",
      source: "failure",
    }),
    bestKept && actionItem({
      priority: "Anchor",
      title: `Best kept #${bestKept.run}`,
      detail: bestKept.description || bestKept.asi?.hypothesis || "Use the best kept run as the comparison anchor.",
      utilityCopy: "Compare future work against the strongest kept result.",
      command: commandMap.get("keep last"),
      commandLabel: "Anchor",
      tone: "good",
      source: "kept",
    }),
    actionItem({
      priority: "Safe",
      title: "Refresh the runboard",
      detail: "Export a fresh static dashboard after meaningful changes.",
      utilityCopy: "Keep shared status pages current.",
      safeAction: "export",
      command: commandMap.get("export dashboard"),
      commandLabel: "Export",
      tone: "neutral",
      source: "export",
    }),
  ].filter(Boolean);

  return [primary, ...secondary].slice(0, 4);
}

function actionItem({ kind = "continue", priority, title, detail, utilityCopy, safeAction = "", command = "", commandLabel = "Copy", tone = "neutral", source = "" }) {
  return {
    kind,
    priority,
    title,
    detail,
    utilityCopy,
    safeAction,
    command,
    primaryCommand: command ? { label: commandLabel, command } : null,
    tone,
    source,
  };
}

function commandLookup(commands) {
  const map = new Map();
  for (const item of Array.isArray(commands) ? commands : []) {
    const label = String(item?.label || "").toLowerCase();
    if (label) map.set(label, item.command || "");
  }
  return map;
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
    if (metric != null && (existing.bestMetric == null || isBetter(metric, existing.bestMetric, direction))) {
      existing.bestMetric = metric;
    }
    existing.lane = existing.kept && existing.rejected ? "mixed" : existing.kept ? "promote" : "avoid";
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
      detail: rejected.at(-1)?.rollbackReason || rejected.at(-1)?.description || "No rejected lane yet.",
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
  const recentSpread = Math.max(...recent.map((item) => item.metric)) - Math.min(...recent.map((item) => item.metric));
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
  const stop = new Set(["the", "and", "for", "with", "from", "into", "all", "next", "run", "try", "use", "add"]);
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
