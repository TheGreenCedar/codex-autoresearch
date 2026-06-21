import { finiteMetric } from "./session-core.js";
import type { UnknownRecord } from "./types/json.js";

type Direction = "lower" | "higher" | string;

export function buildWatchdogSummary({
  state,
  settings = {},
  current = [],
  parallelLanes = [],
  fanoutPlan = null,
}: UnknownRecord) {
  const stateRecord = asRecord(state);
  const settingsRecord = asRecord(settings);
  const config = asRecord(stateRecord.config);
  const thresholdSeconds = watchdogThresholdSeconds(settingsRecord, config);
  const thresholdHours = round(thresholdSeconds / 3600);
  const nowMs = timestampMs(settingsRecord.now || settingsRecord.generatedAt) || Date.now();
  const cutoffMs = nowMs - thresholdSeconds * 1000;
  const currentRuns = Array.isArray(current) ? current : [];
  const completedLanes = Array.isArray(parallelLanes)
    ? parallelLanes.filter((lane: unknown) => laneCompleted(asRecord(lane)))
    : [];
  const progressEvents = [
    ...metricMovementEvents(currentRuns.map(asRecord), String(config.bestDirection || "lower")),
    ...currentRuns
      .map(asRecord)
      .filter(watchdogDecisionRun)
      .map((run: UnknownRecord) => ({
        kind: "decision",
        at: timestampMs(run.timestamp || run.loggedAt || run.createdAt),
        label: `Logged run #${run.run ?? "?"} as ${run.status || "decision"}.`,
      })),
    ...currentRuns
      .map(asRecord)
      .filter((run: UnknownRecord) => run.status === "keep" && cleanText(run.commit))
      .map((run: UnknownRecord) => ({
        kind: "kept_commit",
        at: timestampMs(run.timestamp || run.loggedAt || run.createdAt),
        label: `Kept commit ${String(run.commit).slice(0, 12)} from run #${run.run ?? "?"}.`,
      })),
    ...completedLanes.map((lane: UnknownRecord) => ({
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
    fanoutPlanId: cleanText(asRecord(fanoutPlan).id) || null,
    completedLaneCount: completedLanes.length,
    reasons,
    recommendation,
  };
}

function watchdogThresholdSeconds(settings: UnknownRecord, config: UnknownRecord = {}) {
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

function metricMovementEvents(current: UnknownRecord[], direction: Direction) {
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

function laneCompleted(lane: UnknownRecord) {
  const status = String(lane.status || lane.state || lane.evidenceStatus || "").toLowerCase();
  return ["complete", "completed", "done", "kept", "accepted", "finished"].includes(status);
}

function watchdogDecisionRun(run: UnknownRecord) {
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

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}
