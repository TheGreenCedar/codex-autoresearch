import type { UnknownRecord } from "../types/json.js";
import { parseEvidenceAxes } from "../evidence-axes.js";

export interface BudgetStatus {
  configured: boolean;
  exhausted: boolean;
  packetBudget: number | null;
  packetsUsed: number;
  packetsRemaining: number | null;
  wallClockBudgetSeconds: number | null;
  wallClockStartedAt: string;
  wallClockElapsedSeconds: number | null;
  wallClockRemainingSeconds: number | null;
  budgetNote: string;
  stopReason: string;
  nextAction: string;
  warnings: string[];
}

export function buildBudgetStatus({
  state,
  runtimeConfig = {},
  now = Date.now(),
}: {
  state: UnknownRecord;
  runtimeConfig?: UnknownRecord;
  now?: number;
}): BudgetStatus {
  const packetBudget = positiveInteger(runtimeConfig.packetBudget);
  const wallClockBudgetSeconds = positiveInteger(runtimeConfig.wallClockBudgetSeconds);
  const budgetNote = stringValue(runtimeConfig.budgetNote);
  const wallClockStartedAt = stringValue(runtimeConfig.budgetStartedAt);
  const packetsUsed = packetBudgetUsage(state.current);
  const packetsRemaining = packetBudget == null ? null : Math.max(0, packetBudget - packetsUsed);
  const startedMs = wallClockStartedAt ? Date.parse(wallClockStartedAt) : NaN;
  const wallClockElapsedSeconds =
    wallClockBudgetSeconds == null || !Number.isFinite(startedMs)
      ? null
      : Math.max(0, Math.floor((now - startedMs) / 1000));
  const wallClockRemainingSeconds =
    wallClockBudgetSeconds == null || wallClockElapsedSeconds == null
      ? null
      : Math.max(0, wallClockBudgetSeconds - wallClockElapsedSeconds);
  const packetExhausted = packetsRemaining != null && packetsRemaining <= 0;
  const wallClockExhausted = wallClockRemainingSeconds != null && wallClockRemainingSeconds <= 0;
  const warnings = [];
  if (wallClockBudgetSeconds != null && !Number.isFinite(startedMs)) {
    warnings.push("Wall-clock budget has no valid budgetStartedAt timestamp.");
  }
  const stopReason = packetExhausted
    ? `Packet budget exhausted (${packetsUsed}/${packetBudget} packets used).`
    : wallClockExhausted
      ? `Wall-clock budget exhausted (${wallClockBudgetSeconds} seconds).`
      : "";
  return {
    configured: packetBudget != null || wallClockBudgetSeconds != null || Boolean(budgetNote),
    exhausted: Boolean(stopReason),
    packetBudget,
    packetsUsed,
    packetsRemaining,
    wallClockBudgetSeconds,
    wallClockStartedAt,
    wallClockElapsedSeconds,
    wallClockRemainingSeconds,
    budgetNote,
    stopReason,
    nextAction: stopReason
      ? "Budget exhausted; stop packet work and ask whether to extend, rescope, or start a new segment."
      : budgetNote || "Continue while packet and wall-clock budgets remain available.",
    warnings,
  };
}

export function packetBudgetUsage(value: unknown): number {
  return Array.isArray(value) ? value.filter(countsTowardPacketBudget).length : 0;
}

export function countsTowardPacketBudget(value: unknown): boolean {
  const axes = parseEvidenceAxes(value);
  if (!axes.valid) return true;
  return (
    axes.evaluationAuthority === "accepted-contract" &&
    (axes.runPurpose === "baseline" || axes.runPurpose === "candidate")
  );
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
