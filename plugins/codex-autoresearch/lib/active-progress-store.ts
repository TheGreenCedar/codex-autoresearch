import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";

import { createCoalescingProgressWriter } from "./active-progress-writer.js";
import { numberOption } from "./cli/args.js";
import {
  privateStateCandidatePaths,
  resolvePrivateStateTarget,
  writePrivateStateFile,
  type PrivateStateSpec,
} from "./git-private-state.js";
import { staleProgressReason, type RunnerProgressSnapshot } from "./runner-progress.js";
import { resolveSessionPaths } from "./session-paths.js";
import type { UnknownRecord } from "./types/json.js";

export async function resolveProgressPath(workDir: string): Promise<string> {
  return (await resolvePrivateStateTarget(workDir, progressStateSpec(workDir))).path;
}

export function progressStateSpec(workDir: string): PrivateStateSpec {
  return {
    fallbackPath: resolveSessionPaths({ workDir }).progressFallbackPath,
    gitRelativePath: "autoresearch/progress.json",
    label: "active progress",
  };
}

export async function progressCandidatePaths(workDir: string): Promise<string[]> {
  return await privateStateCandidatePaths(workDir, progressStateSpec(workDir));
}

function readProgressSnapshot(target: string): UnknownRecord | null {
  if (!fs.existsSync(target)) return null;
  try {
    const snapshot: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as UnknownRecord)
      : null;
  } catch {
    return null;
  }
}

function activeProgressGeneration(snapshot: RunnerProgressSnapshot | UnknownRecord | null): number {
  const generation = Number(snapshot?.generation);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

async function writeActiveProgressSnapshot(
  workDir: string,
  snapshot: RunnerProgressSnapshot,
): Promise<string> {
  const target = await resolveProgressPath(workDir);
  const generation = activeProgressGeneration(snapshot);
  if (generation <= activeProgressGeneration(readProgressSnapshot(target))) return target;
  const stored = await writePrivateStateFile(
    workDir,
    progressStateSpec(workDir),
    (stateTarget) =>
      `${JSON.stringify(
        {
          ...snapshot,
          stateStorage: {
            storageMode: stateTarget.storageMode,
            path: stateTarget.path,
            warning: stateTarget.warning,
          },
        },
        null,
        2,
      )}\n`,
    { mode: 0o600 },
  );
  return stored.path;
}

export async function readActiveProgressSnapshot(
  workDir: string,
  config: UnknownRecord = {},
): Promise<UnknownRecord | null> {
  const target = await resolveProgressPath(workDir);
  const snapshot = readProgressSnapshot(target);
  if (!snapshot || snapshot.exitState !== "running") return snapshot;
  return {
    ...snapshot,
    staleProgressReason: staleProgressReason(snapshot, {
      staleAfterSeconds: numberOption(
        config.staleProgressSeconds ?? config.progressStaleSeconds,
        300,
      ),
    }),
  };
}

export async function createActiveProgressWriter(workDir: string) {
  const current = await readActiveProgressSnapshot(workDir);
  return createCoalescingProgressWriter<RunnerProgressSnapshot>({
    initialGeneration: activeProgressGeneration(current),
    write: async (snapshot) => {
      await writeActiveProgressSnapshot(workDir, snapshot);
    },
  });
}

export async function deleteActiveProgressSnapshot(workDir: string): Promise<void> {
  for (const target of await progressCandidatePaths(workDir)) {
    try {
      await fsp.rm(target);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
}

export async function deleteActiveProgressSnapshotIfSafe(workDir: string): Promise<void> {
  const snapshot = await readActiveProgressSnapshot(workDir);
  if (snapshot?.exitState === "termination_failed") return;
  if (
    snapshot?.exitState === "running" &&
    typeof snapshot.startedAt === "string" &&
    typeof snapshot.commandClass === "string"
  ) {
    return;
  }
  await deleteActiveProgressSnapshot(workDir);
}

export async function recoverTerminationFailedProgress(workDir: string): Promise<UnknownRecord> {
  const target = await resolveProgressPath(workDir);
  let before: Buffer;
  try {
    before = await fsp.readFile(target);
  } catch (error) {
    if (isMissingPathError(error)) throw new Error("No retained process progress marker exists.");
    throw error;
  }
  let snapshot: UnknownRecord;
  try {
    const parsed: unknown = JSON.parse(before.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    snapshot = parsed as UnknownRecord;
  } catch {
    throw new Error("The retained process progress marker is not valid JSON evidence.");
  }
  if (snapshot.exitState !== "termination_failed" || snapshot.terminationFailed !== true) {
    throw new Error("Process recovery requires a retained termination_failed marker.");
  }
  const termination =
    snapshot.termination && typeof snapshot.termination === "object"
      ? (snapshot.termination as UnknownRecord)
      : null;
  const pids = uniqueProcessIds([
    termination?.pid,
    ...(Array.isArray(termination?.trackedPids) ? termination.trackedPids : []),
    ...(Array.isArray(termination?.remainingPids) ? termination.remainingPids : []),
  ]);
  if (pids.length === 0) {
    if (isFailedBeforeSpawnProof(snapshot, termination)) {
      const after = await fsp.readFile(target);
      if (!before.equals(after)) {
        throw new Error("The retained process progress marker changed during recovery; retry.");
      }
      await fsp.rm(target);
      return {
        ok: true,
        workDir,
        recovered: true,
        markerPath: target,
        provenDeadPids: [],
        proof: {
          kind: "no-process-started",
          markerGeneration: snapshot.generation ?? null,
          packetId: snapshot.packetId ?? null,
          spawnState: "failed-before-spawn",
          spawnErrorDigest: createHash("sha256")
            .update(String(snapshot.spawnError), "utf8")
            .digest("hex"),
        },
      };
    }
    throw new Error("Process recovery cannot prove a dead tree without recorded process IDs.");
  }
  const livePids = pids.filter(processIdMayBeLive);
  if (livePids.length > 0) {
    throw new Error(`The recorded process tree is still live or unproven: ${livePids.join(", ")}.`);
  }
  const after = await fsp.readFile(target);
  if (!before.equals(after)) {
    throw new Error("The retained process progress marker changed during recovery; retry.");
  }
  await fsp.rm(target);
  return {
    ok: true,
    workDir,
    recovered: true,
    markerPath: target,
    provenDeadPids: pids,
    proof: {
      kind: "recorded-process-tree-absent",
      markerGeneration: snapshot.generation ?? null,
      packetId: snapshot.packetId ?? null,
    },
  };
}

function isFailedBeforeSpawnProof(
  snapshot: UnknownRecord,
  termination: UnknownRecord | null,
): boolean {
  return Boolean(
    snapshot.spawnState === "failed-before-spawn" &&
    typeof snapshot.spawnError === "string" &&
    snapshot.spawnError.trim() &&
    termination &&
    termination.attempted === false &&
    termination.escalated === false &&
    termination.method === "none" &&
    termination.pid === null &&
    termination.proven === false &&
    termination.reason === "missing_root_pid" &&
    Array.isArray(termination.trackedPids) &&
    termination.trackedPids.length === 0 &&
    Array.isArray(termination.remainingPids) &&
    termination.remainingPids.length === 0,
  );
}

function uniqueProcessIds(values: unknown[]): number[] {
  return [
    ...new Set(
      values
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647),
    ),
  ].sort((left, right) => left - right);
}

function processIdMayBeLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && (error as { code?: unknown }).code === "ESRCH");
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT",
  );
}
