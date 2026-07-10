import { finiteMetric } from "./session-core.js";

export type PortfolioRecommendationKind =
  | "trust-blocker"
  | "exploit-best"
  | "diversify-family"
  | "read-only-scout"
  | "holdout"
  | "insufficient-evidence";

export type PortfolioRecommendationConfidence = "high" | "medium" | "low";

export interface PortfolioRecommendation {
  kind: PortfolioRecommendationKind;
  confidence: PortfolioRecommendationConfidence;
  reason: string;
  nextActionHint: string;
  evidence: string[];
}

export interface PortfolioAdvisorInput {
  runtimeDrift?: unknown;
  gateQuality?: unknown;
  preflight?: unknown;
  laneLifecycle?: unknown;
  laneResults?: unknown[];
  packetDiagnostics?: unknown;
  experimentMemory?: unknown;
  best?: unknown;
  current?: unknown[];
}

export function recommendPortfolioDirection(input: PortfolioAdvisorInput): PortfolioRecommendation {
  const runtime = recordOrNull(input.runtimeDrift);
  const gate = recordOrNull(input.gateQuality);
  const preflight = recordOrNull(input.preflight);
  const packetDiagnostics = recordOrNull(input.packetDiagnostics);
  const laneLifecycle = recordOrNull(input.laneLifecycle);
  const memory = recordOrNull(input.experimentMemory);
  const evidence: string[] = [];

  const trustBlockers = [
    ...runtimeBlockers(runtime),
    ...gateBlockers(gate),
    ...preflightBlockers(preflight),
    ...packetBlockers(packetDiagnostics),
  ];
  if (trustBlockers.length > 0) {
    return recommendation({
      kind: "trust-blocker",
      confidence: "high",
      reason: trustBlockers[0],
      nextActionHint: "Resolve the trust blocker before spending another measured packet.",
      evidence: trustBlockers,
    });
  }

  const gatePosture = stringValue(gate?.posture);
  if (gatePosture === "promotion" || gatePosture === "holdout") {
    evidence.push(`gate posture: ${gatePosture}`);
    return recommendation({
      kind: "holdout",
      confidence: gatePosture === "promotion" ? "high" : "medium",
      reason: "Promotion or holdout evidence is available enough to check review readiness.",
      nextActionHint: "Use holdout, repeat, or finalization evidence before broadening the search.",
      evidence,
    });
  }

  const plateau = recordOrNull(memory?.plateau);
  const exhaustedFamilies = arrayValue(memory?.exhaustedFamilies);
  const diversityGuidance = recordOrNull(memory?.diversityGuidance);
  if (
    plateau?.detected === true ||
    exhaustedFamilies.length > 0 ||
    /avoid|distant|divers/i.test(stringValue(diversityGuidance?.id))
  ) {
    if (plateau?.detected === true) evidence.push("plateau detected");
    if (exhaustedFamilies.length > 0) evidence.push(`${exhaustedFamilies.length} exhausted family`);
    if (diversityGuidance?.reason) evidence.push(stringValue(diversityGuidance.reason));
    return recommendation({
      kind: "diversify-family",
      confidence: "medium",
      reason:
        stringValue(diversityGuidance?.reason) ||
        "Recent attempts are concentrated or exhausted enough to justify a different family.",
      nextActionHint:
        stringValue(diversityGuidance?.nextActionHint) ||
        "Pick a distinct hypothesis family before another implementation packet.",
      evidence,
    });
  }

  const keptRuns = arrayValue(memory?.kept);
  const hasBest = finiteMetric(input.best) != null;
  if (
    /incumbent|exploit|confirm/i.test(stringValue(diversityGuidance?.id)) ||
    keptRuns.length > 0 ||
    hasBest
  ) {
    if (keptRuns.length > 0) evidence.push(`${keptRuns.length} current kept run`);
    if (hasBest) evidence.push(`best metric: ${String(input.best)}`);
    return recommendation({
      kind: "exploit-best",
      confidence: keptRuns.length > 0 ? "medium" : "low",
      reason:
        stringValue(diversityGuidance?.reason) ||
        "A current incumbent exists; exploit or verify it before exploring weaker paths.",
      nextActionHint:
        stringValue(diversityGuidance?.nextActionHint) ||
        "Run one focused packet that strengthens or validates the incumbent.",
      evidence,
    });
  }

  const plannedLanes = arrayValue(laneLifecycle?.plannedLanes);
  const firstReadOnly = plannedLanes.find((lane) =>
    /read[_ -]?only|scout/i.test(stringValue(recordOrNull(lane)?.mode || recordOrNull(lane)?.id)),
  );
  if (firstReadOnly || plannedLanes.length > 0) {
    const lane = recordOrNull(firstReadOnly || plannedLanes[0]) || {};
    evidence.push(`planned lane: ${stringValue(lane.id || lane.title || "lane")}`);
    return recommendation({
      kind: "read-only-scout",
      confidence: "medium",
      reason: "A planned scout lane can improve evidence before choosing packet work.",
      nextActionHint:
        stringValue(lane.nextActionHint) ||
        "Run or record one read-only scout lane, then choose the next measured packet.",
      evidence,
    });
  }

  const runCount = Array.isArray(input.current) ? input.current.length : 0;
  return recommendation({
    kind: "insufficient-evidence",
    confidence: "low",
    reason:
      runCount === 0
        ? "No measured packet has been logged yet, so portfolio advice is low confidence."
        : "Available evidence does not identify a strong lane family yet.",
    nextActionHint: "Collect one baseline or scout result before choosing a portfolio direction.",
    evidence: runCount ? [`${runCount} logged run`] : ["no logged runs"],
  });
}

function runtimeBlockers(runtime: Record<string, unknown> | null): string[] {
  if (!runtime) return [];
  const builtStatus = stringValue(runtime.builtRuntime);
  if (builtStatus === "missing") {
    return [stringValue(runtime.nextActionHint) || "Local built runtime is unavailable."];
  }
  return [];
}

function gateBlockers(gate: Record<string, unknown> | null): string[] {
  if (!gate) return [];
  const posture = stringValue(gate.posture);
  if (posture === "missing" || posture === "malformed") {
    return arrayValue(gate.blockers).map(stringValue).filter(Boolean).length
      ? arrayValue(gate.blockers).map(stringValue).filter(Boolean)
      : [`Gate quality is ${posture}.`];
  }
  return arrayValue(gate.blockers).map(stringValue).filter(Boolean);
}

function preflightBlockers(preflight: Record<string, unknown> | null): string[] {
  if (!preflight || preflight.status !== "blocked") return [];
  const blockers = arrayValue(preflight.blockers).map(stringValue).filter(Boolean);
  return blockers.length ? blockers : ["Preflight is blocked."];
}

function packetBlockers(packetDiagnostics: Record<string, unknown> | null): string[] {
  if (!packetDiagnostics) return [];
  const blockers = arrayValue(packetDiagnostics.blockers).map(stringValue).filter(Boolean);
  if (blockers.length) return blockers;
  const stale = packetDiagnostics.stale === true || packetDiagnostics.fresh === false;
  return stale ? [stringValue(packetDiagnostics.reason) || "Latest packet evidence is stale."] : [];
}

function recommendation(input: PortfolioRecommendation): PortfolioRecommendation {
  return {
    ...input,
    evidence: uniqueStrings(input.evidence).slice(0, 6),
  };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
