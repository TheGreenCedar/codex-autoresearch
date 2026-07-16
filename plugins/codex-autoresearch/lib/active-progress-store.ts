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

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT",
  );
}
