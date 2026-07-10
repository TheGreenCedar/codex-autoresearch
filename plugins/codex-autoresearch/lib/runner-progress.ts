import { createHash } from "node:crypto";
import path from "node:path";
import type { ProcessTreeTermination } from "./runner.js";

type LooseObject = Record<string, any>;

export interface RunnerProgressSnapshot {
  generation: number;
  packetId: string;
  commandClass: string;
  startedAt: string;
  lastOutputAt: string | null;
  timeoutSeconds: number | null;
  timeoutPhase: "none" | "benchmark" | "checks" | "unknown";
  exitState: "running" | "completed" | "failed" | "timed_out" | "termination_failed" | "crashed";
  artifactRoot: string;
  latestArtifactRow: string;
  elapsedSeconds: number;
  staleProgressReason: string;
  finalArtifactSummary: string;
  termination: ProcessTreeTermination | null;
  terminationFailed: boolean;
}

export function commandClassFor(command: unknown): string {
  const rawParts = String(command || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const firstCommand = rawParts.findIndex((part) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part));
  const parts = firstCommand < 0 ? [] : rawParts.slice(firstCommand);
  if (parts.length === 0) return "unknown";
  const head = parts[0].replace(/^["']|["']$/g, "");
  const base = path.win32
    .basename(path.posix.basename(head))
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, "");
  if (["npm", "pnpm", "yarn", "bun", "git", "cargo", "dotnet"].includes(base)) {
    const subcommand = /^[a-z][a-z0-9-]*$/i.test(parts[1] || "")
      ? parts[1].toLowerCase()
      : "command";
    return `${base} ${subcommand}`;
  }
  if (["node", "python", "python3", "pwsh", "powershell", "bash", "sh"].includes(base)) {
    return `${base} script`;
  }
  return base || "unknown";
}

export function createProgressSnapshot({
  packetId = "",
  command = "",
  commandClass = "",
  startedAt = new Date().toISOString(),
  timeoutSeconds = null,
  artifactRoot = "",
}: LooseObject = {}): RunnerProgressSnapshot {
  return {
    generation: 0,
    packetId: packetId || progressId(command, startedAt),
    commandClass: commandClass || commandClassFor(command),
    startedAt: isoTime(startedAt),
    lastOutputAt: null,
    timeoutSeconds: finiteNumber(timeoutSeconds),
    timeoutPhase: "none",
    exitState: "running",
    artifactRoot: String(artifactRoot || ""),
    latestArtifactRow: "",
    elapsedSeconds: 0,
    staleProgressReason: "",
    finalArtifactSummary: "",
    termination: null,
    terminationFailed: false,
  };
}

export function updateProgressSnapshot(
  snapshot: RunnerProgressSnapshot,
  { output = "", artifactRow = "", observedAt = new Date().toISOString() }: LooseObject = {},
): RunnerProgressSnapshot {
  const lastOutputAt = output || artifactRow ? isoTime(observedAt) : snapshot.lastOutputAt;
  return {
    ...snapshot,
    lastOutputAt,
    latestArtifactRow: artifactRow || snapshot.latestArtifactRow,
    elapsedSeconds: elapsedSeconds(snapshot.startedAt, observedAt),
  };
}

export function finishProgressSnapshot(
  snapshot: RunnerProgressSnapshot,
  {
    exitCode = null,
    timedOut = false,
    crashed = false,
    terminationFailed = false,
    termination = null,
    timeoutPhase = "",
    completedAt = new Date().toISOString(),
    artifacts = [],
  }: LooseObject = {},
): RunnerProgressSnapshot {
  const artifactCount = Array.isArray(artifacts)
    ? artifacts.filter((artifact) => artifact && artifact.quarantined !== true).length
    : 0;
  const exitState = terminationFailed
    ? "termination_failed"
    : timedOut
      ? "timed_out"
      : crashed
        ? "crashed"
        : exitCode === 0
          ? "completed"
          : "failed";
  return {
    ...snapshot,
    timeoutPhase: timedOut ? normalizeTimeoutPhase(timeoutPhase) : "none",
    exitState,
    elapsedSeconds: elapsedSeconds(snapshot.startedAt, completedAt),
    finalArtifactSummary:
      artifactCount > 0
        ? `${artifactCount} artifact${artifactCount === 1 ? "" : "s"} linked`
        : "No linked artifacts",
    termination: termination || snapshot.termination || null,
    terminationFailed: Boolean(terminationFailed),
  };
}

export function staleProgressReason(
  snapshot: RunnerProgressSnapshot,
  { now = new Date().toISOString(), staleAfterSeconds = 300 }: LooseObject = {},
): string {
  const last = snapshot.lastOutputAt || snapshot.startedAt;
  const quietSeconds = elapsedSeconds(last, now);
  if (snapshot.exitState !== "running") return "";
  if (quietSeconds < Number(staleAfterSeconds || 0)) return "";
  return `No packet output or artifact progress for ${Math.round(quietSeconds)}s.`;
}

export function progressSnapshotFromRun({
  packetId = "",
  run = {},
  artifacts = [],
}: LooseObject = {}): RunnerProgressSnapshot {
  const existing = isProgressSnapshot(run.progressSnapshot)
    ? {
        ...run.progressSnapshot,
        packetId: packetId || run.progressSnapshot.packetId,
      }
    : null;
  const durationSeconds =
    finiteNumber(run.durationSeconds) ?? finiteNumber(run.progress?.elapsedSeconds) ?? 0;
  const finishedAt = run.finishedAt || new Date().toISOString();
  const startedAt =
    run.startedAt || new Date(Date.parse(finishedAt) - durationSeconds * 1000).toISOString();
  const snapshot =
    existing ||
    createProgressSnapshot({
      packetId,
      command: run.command,
      startedAt,
      timeoutSeconds: run.timeoutSeconds,
      artifactRoot: run.workDir || "",
    });
  const withOutput = updateProgressSnapshot(snapshot, {
    output: run.tailOutput || run.progress?.latestOutputTail || "",
    artifactRow: latestArtifactRow(artifacts),
    observedAt: run.lastOutputAt || finishedAt,
  });
  return finishProgressSnapshot(withOutput, {
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    crashed: run.exitCode == null && !run.timedOut,
    timeoutPhase: run.timeoutPhase || (run.timedOut ? "benchmark" : "none"),
    terminationFailed: run.terminationFailed,
    termination: run.termination || null,
    completedAt: finishedAt,
    artifacts,
  });
}

function isProgressSnapshot(value: unknown): value is RunnerProgressSnapshot {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as LooseObject).startedAt === "string" &&
    typeof (value as LooseObject).commandClass === "string",
  );
}

function progressId(command: unknown, startedAt: unknown): string {
  return `progress-${createHash("sha256")
    .update(`${String(command || "")}\n${String(startedAt || "")}`, "utf8")
    .digest("hex")
    .slice(0, 12)}`;
}

function latestArtifactRow(artifacts: LooseObject[]): string {
  const artifact = [...(artifacts || [])].reverse().find((item) => item?.path && !item.quarantined);
  if (!artifact) return "";
  return `${artifact.name || "artifact"}=${artifact.path}`;
}

function isoTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function elapsedSeconds(from: unknown, to: unknown): number {
  const start = Date.parse(String(from || ""));
  const end = Date.parse(String(to || ""));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Number(((end - start) / 1000).toFixed(3)));
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimeoutPhase(value: unknown): RunnerProgressSnapshot["timeoutPhase"] {
  const text = String(value || "").toLowerCase();
  if (text.includes("benchmark")) return "benchmark";
  if (text.includes("check")) return "checks";
  return "unknown";
}
