const FAILURE_STATUSES = new Set(["discard", "crash", "checks_failed"]);
const FAMILY_IGNORE_KEYS = new Set(["attempt", "attempts", "run", "trial", "trials", "seed", "repeat", "repeats", "r"]);

export function buildExperimentMemory({ runs = [], direction = "lower", settings = {} } = {}) {
  const kept = [];
  const rejected = [];
  const nextActions = [];
  const missingAsiRuns = [];
  const enriched = runs.map((run) => ({ ...run, family: familyForRun(run) }));

  for (const run of enriched) {
    const asi = run.asi || {};
    const compact = {
      run: run.run,
      metric: run.metric,
      status: run.status,
      description: run.description || "",
      hypothesis: asi.hypothesis || "",
      evidence: asi.evidence || "",
      commit: run.commit || "",
      family: run.family.label,
    };
    const nextActionHint = asi.next_action_hint || asi.nextAction || asi.next_action || "";
    if (nextActionHint) {
      nextActions.push({ run: run.run, nextActionHint });
    }
    if (!asi.hypothesis && !asi.evidence && !nextActionHint && !asi.rollback_reason) {
      missingAsiRuns.push(run.run);
    }
    if (run.status === "keep") {
      kept.push(compact);
    } else if (FAILURE_STATUSES.has(run.status)) {
      rejected.push({
        ...compact,
        rollbackReason: asi.rollback_reason || asi.failure || "",
      });
    }
  }

  const families = summarizeFamilies(enriched, direction);
  const plateau = detectPlateau({ runs: enriched, families, direction });
  const novelty = noveltySummary(enriched);
  const warnings = [];
  if (runs.length && missingAsiRuns.length) {
    warnings.push(`Runs missing ASI memory fields: ${missingAsiRuns.slice(-5).join(", ")}.`);
  }
  if (plateau.detected) warnings.push(plateau.reason);
  const latestNextAction = nextActions.at(-1)?.nextActionHint || "";
  const lanePortfolio = buildLanePortfolio({
    runs: enriched,
    direction,
    families,
    plateau,
    latestNextAction,
    missingAsi: missingAsiRuns.length,
    settings,
  });
  const diversityGuidance = lanePortfolio.find((lane) => lane.priority === "high" && lane.status !== "waiting")
    || lanePortfolio.find((lane) => lane.status === "ready")
    || lanePortfolio[0]
    || null;

  return {
    direction,
    kept,
    rejected,
    nextActions,
    warnings,
    latestNextAction,
    families,
    plateau,
    novelty,
    lanePortfolio,
    diversityGuidance,
    summary: {
      kept: kept.length,
      rejected: rejected.length,
      missingAsi: missingAsiRuns.length,
      families: families.length,
      plateau: plateau.detected,
      suggestedLane: diversityGuidance?.id || "",
    },
  };
}

export function detectRepeatedHypothesis({ proposed = "", memory = {} } = {}) {
  const key = normalizeHypothesis(proposed);
  if (!key) return null;
  const candidates = [
    ...(memory.rejected || []),
    ...(memory.kept || []),
  ];
  const proposedFamily = canonicalFamilyKey(proposed);
  for (const item of candidates) {
    const previous = normalizeHypothesis(item.hypothesis || item.description);
    const previousFamily = canonicalFamilyKey(item.family || item.hypothesis || item.description);
    if (!previous) continue;
    if (
      previous === key
      || previous.includes(key)
      || key.includes(previous)
      || (proposedFamily && previousFamily && (proposedFamily === previousFamily || proposedFamily.includes(previousFamily) || previousFamily.includes(proposedFamily)))
    ) {
      return {
        matchedRun: item.run,
        status: item.status,
        reason: `Similar hypothesis was already logged in run ${item.run}.`,
      };
    }
  }
  return null;
}

function summarizeFamilies(runs, direction) {
  const map = new Map();
  for (const run of runs) {
    const key = run.family.key;
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: run.family.label,
        runs: 0,
        kept: 0,
        rejected: 0,
        latestRun: null,
        bestRun: null,
        bestKeptRun: null,
        statuses: {},
      });
    }
    const family = map.get(key);
    family.runs += 1;
    family.latestRun = compactFamilyRun(run);
    family.statuses[run.status] = (family.statuses[run.status] || 0) + 1;
    if (run.status === "keep") family.kept += 1;
    if (FAILURE_STATUSES.has(run.status)) family.rejected += 1;
    if (Number.isFinite(Number(run.metric)) && (!family.bestRun || isBetter(Number(run.metric), Number(family.bestRun.metric), direction))) {
      family.bestRun = compactFamilyRun(run);
    }
    if (run.status === "keep" && Number.isFinite(Number(run.metric)) && (!family.bestKeptRun || isBetter(Number(run.metric), Number(family.bestKeptRun.metric), direction))) {
      family.bestKeptRun = compactFamilyRun(run);
    }
  }
  const summarized = [...map.values()]
    .map((family) => ({
      ...family,
      exhausted: family.runs >= 3 && family.rejected >= Math.max(2, family.kept + 1),
    }));
  const sorted = summarized
    .sort((a, b) => b.runs - a.runs || (b.latestRun?.run || 0) - (a.latestRun?.run || 0));
  const limited = sorted.slice(0, 8);
  const incumbent = bestIncumbentFamily(summarized, direction);
  if (incumbent && !limited.some((family) => family.key === incumbent.key)) {
    return [...limited.slice(0, 7), incumbent];
  }
  return limited;
}

function detectPlateau({ runs, families, direction }) {
  const finiteRuns = runs.filter((run) => Number.isFinite(Number(run.metric)));
  const keptFinite = finiteRuns.filter((run) => run.status === "keep");
  const best = bestRun(keptFinite, direction);
  const bestIndex = best ? runs.findIndex((run) => run.run === best.run) : -1;
  const runsSinceBest = bestIndex >= 0 ? runs.length - bestIndex - 1 : runs.length;
  const recent = runs.slice(-Math.min(6, runs.length));
  const recentFailures = recent.filter((run) => FAILURE_STATUSES.has(run.status)).length;
  const familyCounts = new Map();
  for (const run of recent) {
    familyCounts.set(run.family.key, (familyCounts.get(run.family.key) || 0) + 1);
  }
  const repeatedFamilyRuns = Math.max(0, ...familyCounts.values());
  const repeatedFamilyKey = [...familyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const repeatedFamily = families.find((family) => family.key === repeatedFamilyKey) || null;
  const detected = Boolean(
    best
    && runs.length >= 5
    && runsSinceBest >= 4
    && (repeatedFamilyRuns >= 3 || recentFailures >= 3)
  );
  return {
    detected,
    state: detected ? "plateau" : runs.length < 5 ? "forming" : "moving",
    runsSinceBest,
    recentWindow: recent.length,
    recentFailures,
    repeatedFamilyRuns,
    repeatedFamily: repeatedFamily ? repeatedFamily.label : "",
    reason: detected
      ? `Plateau risk: ${runsSinceBest} runs since the best keep, with ${repeatedFamilyRuns} recent run(s) in ${repeatedFamily?.label || "one family"}.`
      : "",
    recommendation: detected
      ? "Force a distant scout or constraint-removal lane before another near-neighbor tweak."
      : "Continue balancing incumbent confirmation with fresh scouts.",
  };
}

function noveltySummary(runs) {
  const recent = runs.slice(-Math.min(6, runs.length));
  const unique = new Set(recent.map((run) => run.family.key));
  const topCount = Math.max(0, ...[...unique].map((key) => recent.filter((run) => run.family.key === key).length));
  return {
    recentWindow: recent.length,
    uniqueFamilies: unique.size,
    repeatedFamilyRuns: topCount,
    score: recent.length ? Number((unique.size / recent.length).toFixed(3)) : null,
  };
}

function buildLanePortfolio({ runs, direction, families, plateau, latestNextAction, missingAsi, settings = {} }) {
  const recentFailures = runs.slice(-5).filter((run) => FAILURE_STATUSES.has(run.status)).length;
  const kept = runs.filter((run) => run.status === "keep");
  const rejected = runs.filter((run) => FAILURE_STATUSES.has(run.status));
  const topFamily = bestIncumbentFamily(families, direction);
  const exhaustedFamily = families.find((family) => family.exhausted);
  const checksPolicy = settings.checksPolicy || "always";
  const keepPolicy = settings.keepPolicy || "primary-only";
  const aggregateLanes = [
    {
      id: "promote",
      label: "Promote",
      title: "Promote",
      count: kept.length,
      priority: kept.length ? "medium" : "low",
      status: kept.length ? "ready" : "watch",
      reason: kept.at(-1)?.description || kept.at(-1)?.asi?.hypothesis || "No kept lane yet.",
      nextActionHint: kept.at(-1)?.asi?.next_action_hint || kept.at(-1)?.description || "Keep measured wins visible for finalization.",
    },
    {
      id: "avoid",
      label: "Avoid",
      title: "Avoid",
      count: rejected.length,
      priority: rejected.length ? "high" : "low",
      status: rejected.length ? "ready" : "watch",
      reason: rejected.at(-1)?.asi?.rollback_reason || rejected.at(-1)?.description || "No rejected lane yet.",
      nextActionHint: rejected.at(-1)?.asi?.next_action_hint || rejected.at(-1)?.asi?.rollback_reason || rejected.at(-1)?.description || "Keep rejected paths visible before the next edit.",
    },
    {
      id: "explore",
      label: "Explore",
      title: "Explore",
      count: latestNextAction ? 1 : 0,
      priority: latestNextAction ? "medium" : "low",
      status: "ready",
      reason: latestNextAction || "No queued ASI hint yet.",
      nextActionHint: latestNextAction || "Add ASI next_action_hint when logging the next result.",
    },
  ];
  return [
    {
      id: "distant-scout",
      label: "Distant scout",
      priority: plateau.detected ? "high" : "medium",
      status: "ready",
      reason: plateau.detected ? plateau.recommendation : "Reserve one lane for a materially different family each batch.",
      nextActionHint: "Try a different algorithm, model family, data slice, or architecture knob before another small parameter tweak.",
    },
    {
      id: "incumbent-confirmation",
      label: "Incumbent confirmation",
      priority: topFamily && !plateau.detected ? "high" : "medium",
      status: topFamily ? "ready" : "waiting",
      reason: topFamily ? `Best-known local family: ${topFamily.label}.` : "No kept incumbent yet.",
      nextActionHint: topFamily
        ? (topFamily.bestKeptRun?.nextActionHint || topFamily.latestRun?.nextActionHint || latestNextAction || "Repeat or stress the best kept idea only after a fresh scout lane exists.")
        : "Keep a baseline before confirmation lanes.",
    },
    {
      id: "near-neighbor",
      label: "Near-neighbor tweak",
      priority: plateau.detected ? "low" : "medium",
      status: plateau.detected ? "cooldown" : "ready",
      reason: exhaustedFamily ? `${exhaustedFamily.label} looks exhausted.` : "Small tweaks are useful after the portfolio has enough novelty.",
      nextActionHint: "Limit near-neighbor tweaks to one lane when recent runs cluster together.",
    },
    {
      id: "constraint-removal",
      label: "Constraint removal",
      priority: recentFailures >= 2 ? "high" : "medium",
      status: recentFailures ? "ready" : "watch",
      reason: recentFailures ? `${recentFailures} recent failed or discarded run(s) need a different blocker hypothesis.` : "Use this lane when failures share a cause.",
      nextActionHint: "Change the constraint, benchmark slice, or validation guard before retesting the same idea.",
    },
    {
      id: "measurement-quality",
      label: "Measurement quality",
      priority: missingAsi || checksPolicy === "manual" ? "high" : "low",
      status: missingAsi || checksPolicy === "manual" ? "ready" : "watch",
      reason: missingAsi
        ? `${missingAsi} run(s) are missing ASI memory.`
        : checksPolicy === "manual"
          ? "Checks are manual, so keep decisions need extra review evidence."
          : "Keep benchmark noise and ASI quality from hiding real wins.",
      nextActionHint: "Add clearer ASI or tighten the benchmark before spending more iterations.",
    },
    {
      id: "promotion-policy",
      label: "Promotion policy",
      priority: keepPolicy === "primary-or-risk-reduction" ? "medium" : "low",
      status: "watch",
      reason: `Keep policy is ${keepPolicy}; use this lane when a run reduces risk without moving the primary metric.`,
      nextActionHint: "Only promote non-primary wins when ASI evidence names the reduced risk.",
    },
    ...aggregateLanes,
    {
      id: "wild-card",
      label: "Wild-card eureka",
      priority: plateau.detected || runs.length >= 8 ? "high" : "medium",
      status: "ready",
      reason: "Always reserve one slot for a non-local solution that could change the search space.",
      nextActionHint: "Try the idea that would make the current lane obsolete if it worked.",
    },
  ];
}

function bestIncumbentFamily(families, direction) {
  let best = null;
  for (const family of families) {
    if (!family.kept || !family.bestKeptRun) continue;
    const metric = Number(family.bestKeptRun.metric);
    const bestMetric = Number(best?.bestKeptRun?.metric);
    if (!best || (Number.isFinite(metric) && (!Number.isFinite(bestMetric) || isBetter(metric, bestMetric, direction)))) {
      best = family;
    }
  }
  return best;
}

function familyForRun(run) {
  const asi = run.asi || {};
  const explicit = asi.family || asi.family_key || asi.strategy || asi.lane;
  const settings = asi.settings || asi.params || asi.parameters || asi.config;
  const settingsKey = settingsSignature(settings);
  const source = explicit || settingsKey || asi.hypothesis || run.description || `run ${run.run}`;
  return {
    key: canonicalFamilyKey(source),
    label: familyLabel(explicit || asi.hypothesis || run.description || settingsKey || `Run ${run.run}`),
  };
}

function settingsSignature(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const entries = Object.entries(value)
    .filter(([key]) => !FAMILY_IGNORE_KEYS.has(String(key).toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return "";
  return entries.map(([key, item]) => `${key}:${typeof item === "object" ? JSON.stringify(item) : String(item)}`).join("|");
}

function familyLabel(value) {
  const text = String(value || "Unlabeled family")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 44 ? `${text.slice(0, 41)}...` : text;
}

function canonicalFamilyKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(repeat|attempt|trial|seed|run)\s*[:=-]?\s*\d+\b/g, "$1 *")
    .replace(/\br\s*\d+\b/g, "r *")
    .replace(/\b\d+(?:\.\d+)?(?:k|m|b|ms|s|mb|gb|dim|d)?\b/g, "#")
    .replace(/\b(keep|discard|baseline|regression|quality|new|leader|full|query|try|use|test)\b/g, " ")
    .replace(/[^a-z0-9#*]+/g, " ")
    .trim()
    .slice(0, 96) || "unlabeled";
}

function compactFamilyRun(run) {
  return {
    run: run.run,
    metric: run.metric,
    status: run.status,
    description: run.description || "",
    nextActionHint: run.asi?.next_action_hint || run.asi?.nextAction || run.asi?.next_action || "",
  };
}

function bestRun(runs, direction) {
  let best = null;
  for (const run of runs) {
    const metric = Number(run.metric);
    if (!Number.isFinite(metric)) continue;
    if (!best || isBetter(metric, Number(best.metric), direction)) best = run;
  }
  return best;
}

function isBetter(value, current, direction) {
  return direction === "higher" ? value > current : value < current;
}

function normalizeHypothesis(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
