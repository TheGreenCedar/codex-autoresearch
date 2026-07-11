import fs from "node:fs";
import fsp from "node:fs/promises";

import { createCoalescingProgressWriter } from "./active-progress-writer.js";
import { checkedAtomicWriteFile } from "./checked-write.js";
import { numberOption } from "./cli/args.js";
import { gitPrivatePath, insideGitRepo, privateStateWriteRoot } from "./git-private-state.js";
import { staleProgressReason, type RunnerProgressSnapshot } from "./runner-progress.js";
import { resolveSessionPaths } from "./session-paths.js";
import type { UnknownRecord } from "./types/json.js";

export async function resolveProgressPath(workDir: string): Promise<string> {
  if (await insideGitRepo(workDir)) {
    return await gitPrivatePath(workDir, "autoresearch/progress.json");
  }
  return resolveSessionPaths({ workDir }).progressFallbackPath;
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
  await checkedAtomicWriteFile(
    await privateStateWriteRoot(workDir, target),
    target,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { mode: 0o600 },
  );
  return target;
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
  try {
    await fsp.rm(await resolveProgressPath(workDir));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
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
