import { finiteMetric } from "./session-core.js";

type LooseObject = Record<string, any>;

const FAILURE_STATUSES = new Set(["discard", "crash", "checks_failed"]);
const FAMILY_IGNORE_KEYS = new Set([
  "attempt",
  "attempts",
  "run",
  "trial",
  "trials",
  "seed",
  "repeat",
  "repeats",
  "r",
]);

function getAsi(run) {
  return run.asi || {};
}

function isKeepStatus(status) {
  return status === "keep";
}

function isRejectedStatus(status) {
  return FAILURE_STATUSES.has(status);
}

function nextActionHintFromAsi(asi) {
  return asi.next_action_hint || asi.nextAction || asi.next_action || "";
}

function compactMemoryRun(run, asi = getAsi(run)) {
  return {
    run: run.run,
    metric: finiteMetric(run.metric),
    status: run.status,
    description: run.description || "",
    hypothesis: asi.hypothesis || "",
    evidence: asi.evidence || "",
    commit: run.commit || "",
    family: run.family.label,
  };
}

function isMissingAsiMemory(run, asi = getAsi(run)) {
  return !asi.evidence && !asi.rollback_reason && (isKeepStatus(run.status) || !asi.hypothesis);
}

export function buildExperimentMemory({
  runs = [],
  direction = "lower",
  settings = {},
}: LooseObject = {}) {
  const kept = [];
  const rejected = [];
  const nextActions = [];
  const missingAsiRuns = [];
  const enriched = runs.map((run) => ({ ...run, family: familyForRun(run) }));

  for (const run of enriched) {
    const asi = getAsi(run);
    const compact = compactMemoryRun(run, asi);
    const nextActionHint = nextActionHintFromAsi(asi);
    if (nextActionHint) {
      nextActions.push({ run: run.run, nextActionHint });
    }
    if (isMissingAsiMemory(run, asi)) {
      missingAsiRuns.push(run.run);
    }
    if (isKeepStatus(run.status)) {
      kept.push(compact);
    } else if (isRejectedStatus(run.status)) {
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
  const diversityGuidance =
    lanePortfolio.find((lane) => lane.priority === "high" && lane.status !== "waiting") ||
    lanePortfolio.find((lane) => lane.status === "ready") ||
    lanePortfolio[0] ||
    null;

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

export function detectRepeatedHypothesis({ proposed = "", memory = {} }: LooseObject = {}) {
  const key = normalizeHypothesis(proposed);
  if (!key) return null;
  const candidates = [...(memory.rejected || []), ...(memory.kept || [])];
  const proposedFamily = canonicalFamilyKey(proposed);
  for (const item of candidates) {
    const previous = normalizeHypothesis(item.hypothesis || item.description);
    const previousFamily = canonicalFamilyKey(item.family || item.hypothesis || item.description);
    if (!previous) continue;
    if (matchesPreviousHypothesis({ key, previous, proposedFamily, previousFamily })) {
      return {
        matchedRun: item.run,
        status: item.status,
        reason: `Similar hypothesis was already logged in run ${item.run}.`,
      };
    }
  }
  return null;
}

function matchesPreviousHypothesis({ key, previous, proposedFamily, previousFamily }) {
  return hypothesisTextMatches(previous, key) || familyKeyMatches(proposedFamily, previousFamily);
}

function hypothesisTextMatches(previous, key) {
  return previous === key || previous.includes(key) || key.includes(previous);
}

function familyKeyMatches(proposedFamily, previousFamily) {
  return Boolean(
    proposedFamily &&
    previousFamily &&
    (proposedFamily === previousFamily ||
      proposedFamily.includes(previousFamily) ||
      previousFamily.includes(proposedFamily)),
  );
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
    if (isKeepStatus(run.status)) family.kept += 1;
    if (isRejectedStatus(run.status)) family.rejected += 1;
    const metric = finiteMetric(run.metric);
    const bestMetric = finiteMetric(family.bestRun?.metric);
    const bestKeptMetric = finiteMetric(family.bestKeptRun?.metric);
    if (metric != null && (bestMetric == null || isBetter(metric, bestMetric, direction))) {
      family.bestRun = compactFamilyRun(run);
    }
    if (
      isKeepStatus(run.status) &&
      metric != null &&
      (bestKeptMetric == null || isBetter(metric, bestKeptMetric, direction))
    ) {
      family.bestKeptRun = compactFamilyRun(run);
    }
  }
  const summarized = [...map.values()].map((family) => ({
    ...family,
    exhausted: family.runs >= 3 && family.rejected >= Math.max(2, family.kept + 1),
  }));
  const sorted = summarized.sort(
    (a, b) => b.runs - a.runs || (b.latestRun?.run || 0) - (a.latestRun?.run || 0),
  );
  const limited = sorted.slice(0, 8);
  const incumbent = bestIncumbentFamily(summarized, direction);
  if (incumbent && !limited.some((family) => family.key === incumbent.key)) {
    return [...limited.slice(0, 7), incumbent];
  }
  return limited;
}

function detectPlateau({ runs, families, direction }) {
  const finiteRuns = runs.filter(hasNumericMetricForPlateau);
  const keptFinite = finiteRuns.filter((run) => isKeepStatus(run.status));
  const best = bestRun(keptFinite, direction);
  const bestIndex = best ? runs.findIndex((run) => run.run === best.run) : -1;
  const runsSinceBest = bestIndex >= 0 ? runs.length - bestIndex - 1 : runs.length;
  const recent = runs.slice(-Math.min(6, runs.length));
  const recentFailures = recent.filter((run) => isRejectedStatus(run.status)).length;
  const familyCounts = countRunsByFamily(recent);
  const repeatedFamilyRuns = Math.max(0, ...familyCounts.values());
  const repeatedFamilyKey = mostRepeatedFamilyKey(familyCounts);
  const repeatedFamily = families.find((family) => family.key === repeatedFamilyKey) || null;
  const detected = Boolean(
    best &&
    runs.length >= 5 &&
    runsSinceBest >= 4 &&
    (repeatedFamilyRuns >= 3 || recentFailures >= 3),
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

function hasNumericMetricForPlateau(run) {
  return Number.isFinite(Number(run.metric));
}

function noveltySummary(runs) {
  const recent = runs.slice(-Math.min(6, runs.length));
  const familyCounts = countRunsByFamily(recent);
  const topCount = Math.max(0, ...familyCounts.values());
  return {
    recentWindow: recent.length,
    uniqueFamilies: familyCounts.size,
    repeatedFamilyRuns: topCount,
    score: recent.length ? Number((familyCounts.size / recent.length).toFixed(3)) : null,
  };
}

function countRunsByFamily(runs) {
  const familyCounts = new Map();
  for (const run of runs) {
    familyCounts.set(run.family.key, (familyCounts.get(run.family.key) || 0) + 1);
  }
  return familyCounts;
}

function mostRepeatedFamilyKey(familyCounts) {
  return [...familyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function buildLanePortfolio({
  runs,
  direction,
  families,
  plateau,
  latestNextAction,
  missingAsi,
  settings = {},
}: LooseObject) {
  const recentFailures = runs.slice(-5).filter((run) => isRejectedStatus(run.status)).length;
  const kept = runs.filter((run) => isKeepStatus(run.status));
  const rejected = runs.filter((run) => isRejectedStatus(run.status));
  const topFamily = bestIncumbentFamily(families, direction);
  const exhaustedFamily = families.find((family) => family.exhausted);
  const checksPolicy = settings.checksPolicy || "always";
  const keepPolicy = settings.keepPolicy || "primary-only";
  const latestRun = runs.at(-1);
  const latestKept = kept.at(-1);
  const latestRejected = rejected.at(-1);
  const lane = (item, evidence) => ({
    ...item,
    evidence,
    reason: `${item.reason} Evidence: ${evidence}.`,
  });
  const aggregateLanes = [
    latestKept &&
      lane(
        {
          id: "promote",
          label: "Promote",
          title: "Promote",
          count: kept.length,
          priority: "medium",
          status: "ready",
          reason: latestKept.description || latestKept.asi?.hypothesis || "Kept work exists.",
          nextActionHint:
            latestKept.asi?.next_action_hint ||
            latestKept.description ||
            "Keep measured wins visible for finalization.",
        },
        `run ${latestKept.run} kept metric ${latestKept.metric ?? "unknown"}`,
      ),
    latestRejected &&
      lane(
        {
          id: "avoid",
          label: "Avoid",
          title: "Avoid",
          count: rejected.length,
          priority: "high",
          status: "ready",
          reason:
            latestRejected.asi?.rollback_reason ||
            latestRejected.description ||
            "Rejected work exists.",
          nextActionHint:
            latestRejected.asi?.next_action_hint ||
            latestRejected.asi?.rollback_reason ||
            latestRejected.description ||
            "Keep rejected paths visible before the next edit.",
        },
        `run ${latestRejected.run} status ${latestRejected.status}`,
      ),
    latestNextAction &&
      latestRun &&
      lane(
        {
          id: "explore",
          label: "Explore",
          title: "Explore",
          count: 1,
          priority: "medium",
          status: "ready",
          reason: latestNextAction,
          nextActionHint: latestNextAction,
        },
        `latest run ${latestRun.run} ASI next action`,
      ),
  ].filter(Boolean);
  return [
    plateau.detected &&
      lane(
        {
          id: "distant-scout",
          label: "Distant scout",
          priority: "high",
          status: "ready",
          reason: plateau.recommendation || "Plateau detected.",
          nextActionHint:
            "Try a different algorithm, model family, data slice, or architecture knob before another small parameter tweak.",
        },
        "plateau.detected session state",
      ),
    topFamily &&
      lane(
        {
          id: "incumbent-confirmation",
          label: "Incumbent confirmation",
          priority: !plateau.detected ? "high" : "medium",
          status: "ready",
          reason: `Best-known local family: ${topFamily.label}.`,
          nextActionHint:
            topFamily.bestKeptRun?.nextActionHint ||
            topFamily.latestRun?.nextActionHint ||
            latestNextAction ||
            "Repeat or stress the best kept idea only after a fresh scout lane exists.",
        },
        `family ${topFamily.label} best kept metric ${topFamily.bestMetric ?? "unknown"}`,
      ),
    exhaustedFamily &&
      lane(
        {
          id: "near-neighbor",
          label: "Near-neighbor tweak",
          priority: plateau.detected ? "low" : "medium",
          status: plateau.detected ? "cooldown" : "ready",
          reason: `${exhaustedFamily.label} looks exhausted.`,
          nextActionHint:
            "Limit near-neighbor tweaks to one lane when recent runs cluster together.",
        },
        `family ${exhaustedFamily.label} exhausted after ${exhaustedFamily.runs} run(s)`,
      ),
    recentFailures >= 2 &&
      lane(
        {
          id: "constraint-removal",
          label: "Constraint removal",
          priority: "high",
          status: "ready",
          reason: `${recentFailures} recent failed or discarded run(s) need a different blocker hypothesis.`,
          nextActionHint:
            "Change the constraint, benchmark slice, or validation guard before retesting the same idea.",
        },
        `${recentFailures} failure statuses in the last 5 run(s)`,
      ),
    (missingAsi || checksPolicy === "manual") &&
      lane(
        {
          id: "measurement-quality",
          label: "Measurement quality",
          priority: "high",
          status: "ready",
          reason: missingAsi
            ? `${missingAsi} run(s) are missing ASI memory.`
            : "Checks are manual, so keep decisions need extra review evidence.",
          nextActionHint:
            "Add clearer ASI or tighten the benchmark before spending more iterations.",
        },
        missingAsi ? `${missingAsi} missing ASI run(s)` : `checksPolicy=${checksPolicy}`,
      ),
    keepPolicy === "primary-or-risk-reduction" &&
      kept.length > 0 &&
      lane(
        {
          id: "promotion-policy",
          label: "Promotion policy",
          priority: "medium",
          status: "watch",
          reason: `Keep policy is ${keepPolicy}; use this lane when a run reduces risk without moving the primary metric.`,
          nextActionHint: "Only promote non-primary wins when ASI evidence names the reduced risk.",
        },
        `keepPolicy=${keepPolicy} with ${kept.length} kept run(s)`,
      ),
    ...aggregateLanes,
    (plateau.detected || repeatedFamilyEvidence(families)) &&
      lane(
        {
          id: "wild-card",
          label: "Wild-card eureka",
          priority: "high",
          status: "ready",
          reason: "Current evidence suggests the local search space is stale.",
          nextActionHint: "Try the idea that would make the current lane obsolete if it worked.",
        },
        plateau.detected ? "plateau.detected session state" : repeatedFamilyEvidence(families),
      ),
  ].filter(Boolean);
}

function repeatedFamilyEvidence(families) {
  const repeated = families.find((family) => family.runs >= 3);
  return repeated ? `family ${repeated.label} has ${repeated.runs} run(s)` : "";
}

function bestIncumbentFamily(families, direction) {
  let best = null;
  for (const family of families) {
    if (!family.kept || !family.bestKeptRun) continue;
    const metric = finiteMetric(family.bestKeptRun.metric);
    const bestMetric = finiteMetric(best?.bestKeptRun?.metric);
    if (
      metric != null &&
      (!best || bestMetric == null || isBetter(metric, bestMetric, direction))
    ) {
      best = family;
    }
  }
  return best;
}

function familyForRun(run) {
  const asi = getAsi(run);
  const explicit = asi.family || asi.family_key || asi.strategy || asi.lane;
  const settings = asi.settings || asi.params || asi.parameters || asi.config;
  const settingsKey = settingsSignature(settings);
  const source = explicit || settingsKey || asi.hypothesis || run.description || `run ${run.run}`;
  return {
    key: canonicalFamilyKey(source),
    label: familyLabel(
      explicit || asi.hypothesis || run.description || settingsKey || `Run ${run.run}`,
    ),
  };
}

function settingsSignature(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const entries = Object.entries(value)
    .filter(([key]) => !FAMILY_IGNORE_KEYS.has(String(key).toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return "";
  return entries
    .map(
      ([key, item]) => `${key}:${typeof item === "object" ? JSON.stringify(item) : String(item)}`,
    )
    .join("|");
}

function familyLabel(value) {
  const text = String(value || "Unlabeled family")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 44 ? `${text.slice(0, 41)}...` : text;
}

function canonicalFamilyKey(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/\b(repeat|attempt|trial|seed|run)\s*[:=-]?\s*\d+\b/g, "$1 *")
      .replace(/\br\s*\d+\b/g, "r *")
      .replace(/\b\d+(?:\.\d+)?(?:k|m|b|ms|s|mb|gb|dim|d)?\b/g, "#")
      .replace(
        /\b(keep|discard|baseline|regression|quality|new|leader|full|query|try|use|test)\b/g,
        " ",
      )
      .replace(/[^a-z0-9#*]+/g, " ")
      .trim()
      .slice(0, 96) || "unlabeled"
  );
}

function compactFamilyRun(run) {
  return {
    run: run.run,
    metric: finiteMetric(run.metric),
    status: run.status,
    description: run.description || "",
    nextActionHint: nextActionHintFromAsi(run.asi || {}),
  };
}

function bestRun(runs, direction) {
  let best = null;
  for (const run of runs) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    const bestMetric = finiteMetric(best?.metric);
    if (!best || bestMetric == null || isBetter(metric, bestMetric, direction)) best = run;
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
