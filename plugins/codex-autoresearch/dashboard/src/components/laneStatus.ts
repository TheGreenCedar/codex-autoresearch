import type { StrategyLane } from "../types";

const COMPLETED_LANE_STATUSES = ["done", "complete", "completed", "accepted", "finished"];
const BLOCKED_LANE_STATUSES = ["blocked", "failed", "error", "rejected"];
const ACTIVE_LANE_STATUSES = ["ready", "active", "running", "tracking", "planned"];

export function laneStatusKey(lane: Record<string, unknown>) {
  const key = String(lane.status || lane.state || lane.evidenceStatus || "tracking")
    .trim()
    .toLowerCase();
  if (COMPLETED_LANE_STATUSES.includes(key)) return "completed";
  if (BLOCKED_LANE_STATUSES.includes(key)) return "blocked";
  if (ACTIVE_LANE_STATUSES.includes(key)) return key;
  return "tracking";
}

export function laneStatusTone(status: string) {
  if (status === "completed") return "good";
  if (status === "blocked") return "warn";
  return "neutral";
}

export function laneCompleted(lane: StrategyLane | Record<string, unknown>) {
  return laneStatusKey(lane) === "completed";
}

export function laneActive(lane: StrategyLane | Record<string, unknown>) {
  return ACTIVE_LANE_STATUSES.includes(laneStatusKey(lane));
}
