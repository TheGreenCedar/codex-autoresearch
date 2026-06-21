import { dashboardReadOnlyCommand } from "../dashboard-command-safety.js";
import type { UnknownRecord } from "../types/json.js";

type CommandMap = Map<string, unknown>;
type MissionAction = UnknownRecord & { detail?: string; kind?: string };
type MissionGuidedSetup = UnknownRecord & {
  commands?: { setup?: unknown };
  lastRun?: MissionLastRun | null;
  nextAction?: string;
  stage?: string;
};
type MissionLastRun = UnknownRecord & {
  allowedStatuses?: unknown[];
  asiTemplate?: unknown;
  fingerprint?: string;
  freshness?: { fresh?: boolean; reason?: string };
  metric?: unknown;
  safeSuggestedStatus?: unknown;
  statusGuidance?: string;
  suggestedStatus?: unknown;
};
type MissionControlInput = UnknownRecord & {
  actionRail?: MissionAction[];
  commands?: unknown;
  current?: UnknownRecord[];
  experimentMemory?: (UnknownRecord & { latestNextAction?: string }) | null;
  finalizePreview?: (UnknownRecord & { nextAction?: string; ready?: boolean }) | null;
  guidedSetup?: MissionGuidedSetup | null;
  qualityGap?: (UnknownRecord & { open?: unknown; slug?: unknown; total?: unknown }) | null;
  setupPlan?: (UnknownRecord & { configured?: unknown }) | null;
};

export function buildMissionControl({
  current,
  setupPlan,
  guidedSetup,
  qualityGap,
  finalizePreview,
  experimentMemory,
  actionRail,
  commands,
}: MissionControlInput) {
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
  const runCount = current?.length || 0;
  const setupState =
    stage === "needs-setup" ? "ready" : setupPlan?.configured || runCount ? "done" : "idle";
  const gapState = qualityGap ? (hasQualityGaps ? "ready" : "done") : "idle";
  const logState = lastRun ? (hasFreshLastRun ? "ready" : "blocked") : "idle";
  const finalizeState = finalizePreview?.ready ? "ready" : runCount ? "idle" : "blocked";
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
  return {
    activeStep,
    staticFallback: "Serve the dashboard locally for a fresh readout; use CLI for actions.",
    steps: [
      missionStep({
        id: "setup",
        title: "Setup",
        state: setupState,
        detail:
          guidedSetup?.stage === "needs-setup"
            ? guidedSetup.nextAction || ""
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
  commandLabel = "Copy read-only command",
  mutates = false,
}: {
  id: string;
  title: string;
  state: string;
  detail: string;
  safeAction?: string;
  command?: unknown;
  commandLabel?: string;
  mutates?: boolean;
}) {
  const safeCommand = dashboardReadOnlyCommand(command);
  return {
    id,
    title,
    state,
    detail,
    safeAction,
    command: safeCommand,
    primaryCommand: safeCommand ? { label: commandLabel, command: safeCommand } : null,
    mutates,
  };
}

function commandLookup(commands: unknown): CommandMap {
  const map: CommandMap = new Map();
  for (const item of Array.isArray(commands) ? commands : []) {
    const record = item && typeof item === "object" ? (item as UnknownRecord) : {};
    const label = String(record.label || "").toLowerCase();
    if (label) map.set(label, record.command || "");
  }
  return map;
}
