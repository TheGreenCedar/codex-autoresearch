const FAILURE_STATUSES = new Set(["discard", "crash", "checks_failed"]);

export function buildExperimentMemory({ runs = [], direction = "lower" } = {}) {
  const kept = [];
  const rejected = [];
  const nextActions = [];
  const missingAsiRuns = [];

  for (const run of runs) {
    const asi = run.asi || {};
    const compact = {
      run: run.run,
      metric: run.metric,
      status: run.status,
      description: run.description || "",
      hypothesis: asi.hypothesis || "",
      evidence: asi.evidence || "",
      commit: run.commit || "",
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

  const warnings = [];
  if (runs.length && missingAsiRuns.length) {
    warnings.push(`Runs missing ASI memory fields: ${missingAsiRuns.slice(-5).join(", ")}.`);
  }

  return {
    direction,
    kept,
    rejected,
    nextActions,
    warnings,
    latestNextAction: nextActions.at(-1)?.nextActionHint || "",
    summary: {
      kept: kept.length,
      rejected: rejected.length,
      missingAsi: missingAsiRuns.length,
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
  for (const item of candidates) {
    const previous = normalizeHypothesis(item.hypothesis || item.description);
    if (!previous) continue;
    if (previous === key || previous.includes(key) || key.includes(previous)) {
      return {
        matchedRun: item.run,
        status: item.status,
        reason: `Similar hypothesis was already logged in run ${item.run}.`,
      };
    }
  }
  return null;
}

function normalizeHypothesis(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
