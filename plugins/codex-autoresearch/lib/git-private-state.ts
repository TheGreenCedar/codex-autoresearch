import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { checkedAtomicWriteFile } from "./checked-write.js";
import { runProcess, type ProcessRunResult } from "./runner.js";
import { displayGitPath, parsePorcelainV1Z } from "./git-paths.js";
import { pathExists } from "./session-core.js";
import { resolveSessionPaths } from "./session-paths.js";

const PRIVATE_STATE_FALLBACK_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

export type PrivateStateStorageMode = "git-private" | "worktree" | "worktree-fallback";

export interface PrivateStateSpec {
  fallbackPath: string;
  gitRelativePath: string;
  label: string;
}

export interface PrivateStateTarget {
  fallbackPath: string;
  gitPrivatePath: string | null;
  label: string;
  path: string;
  root: string;
  storageMode: PrivateStateStorageMode;
  warning: string;
}

export interface PrivateStateIo {
  remove?: (filePath: string) => Promise<void>;
  write?: typeof checkedAtomicWriteFile;
}

export type PrivateStateData =
  | string
  | Uint8Array
  | ((target: PrivateStateTarget) => string | Uint8Array);

export class PrivateStateConflictError extends Error {
  readonly code = "private_state_conflict";

  constructor(label: string, gitPath: string, fallbackPath: string) {
    super(
      `Conflicting ${label} state exists in both Git-private and worktree storage. ` +
        `Inspect and reconcile ${gitPath} and ${fallbackPath} before continuing.`,
    );
    this.name = "PrivateStateConflictError";
  }
}

function hasGitMarker(cwd: string): boolean {
  let current = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function runGit(
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  return await runProcess("git", args, {
    cwd,
    env: options.env,
    maxOutputBytes: 16 * 1024 * 1024,
  });
}

export function gitOutput(result: { stderr: string; stdout: string }, fallback: string): string {
  return (result.stderr || result.stdout || fallback).trim();
}

export async function insideGitRepo(cwd: string): Promise<boolean> {
  if (!hasGitMarker(cwd)) return false;
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function gitPrivatePath(cwd: string, relativePath: string): Promise<string> {
  const result = await runGit(["rev-parse", "--git-path", relativePath], cwd);
  if (result.code !== 0) {
    throw new Error(`Git path lookup failed: ${gitOutput(result, "unknown error")}`);
  }
  const filePath = result.stdout.trim();
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export async function gitPrivateRoot(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "--git-dir"], cwd);
  if (result.code !== 0) {
    throw new Error(`Git directory lookup failed: ${gitOutput(result, "unknown error")}`);
  }
  const gitDir = result.stdout.trim();
  return path.isAbsolute(gitDir) ? path.resolve(gitDir) : path.resolve(cwd, gitDir);
}

export function privateStateFallbackAllowed(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    PRIVATE_STATE_FALLBACK_CODES.has(String((error as { code?: unknown }).code || "")),
  );
}

export async function resolvePrivateStateTarget(
  workDir: string,
  spec: PrivateStateSpec,
): Promise<PrivateStateTarget> {
  const gitRepo = await verifiedPrivateStateGitRepo(workDir);
  if (!gitRepo) {
    return {
      fallbackPath: spec.fallbackPath,
      gitPrivatePath: null,
      label: spec.label,
      path: spec.fallbackPath,
      root: workDir,
      storageMode: "worktree",
      warning: "",
    };
  }

  const resolvedGitPath = await gitPrivatePath(workDir, spec.gitRelativePath);
  const gitExists = await privateStatePathExists(resolvedGitPath);
  const fallbackExists = await privateStatePathExists(spec.fallbackPath);
  if (resolvedGitPath !== spec.fallbackPath && gitExists && fallbackExists) {
    throw new PrivateStateConflictError(spec.label, resolvedGitPath, spec.fallbackPath);
  }
  if (fallbackExists) return fallbackTarget(workDir, spec, resolvedGitPath);
  return {
    fallbackPath: spec.fallbackPath,
    gitPrivatePath: resolvedGitPath,
    label: spec.label,
    path: resolvedGitPath,
    root: await gitPrivateRoot(workDir),
    storageMode: "git-private",
    warning: "",
  };
}

export async function privateStateCandidatePaths(
  workDir: string,
  spec: PrivateStateSpec,
): Promise<string[]> {
  const candidates = [spec.fallbackPath];
  if (await verifiedPrivateStateGitRepo(workDir)) {
    candidates.unshift(await gitPrivatePath(workDir, spec.gitRelativePath));
  }
  return [...new Set(candidates)];
}

export async function writePrivateStateFile(
  workDir: string,
  spec: PrivateStateSpec,
  data: PrivateStateData,
  options: { mode?: number } = {},
  io: PrivateStateIo = {},
): Promise<PrivateStateTarget> {
  const write = io.write || checkedAtomicWriteFile;
  const target = await resolvePrivateStateTarget(workDir, spec);
  try {
    await write(target.root, target.path, privateStateDataForTarget(data, target), options);
    return target;
  } catch (error) {
    if (target.storageMode !== "git-private" || !privateStateFallbackAllowed(error)) throw error;
    if (await privateStatePathExists(spec.fallbackPath)) {
      throw new PrivateStateConflictError(spec.label, target.path, spec.fallbackPath);
    }
    const fallback = fallbackTarget(workDir, spec, target.path, error);
    await write(fallback.root, fallback.path, privateStateDataForTarget(data, fallback), options);
    return fallback;
  }
}

function privateStateDataForTarget(
  data: PrivateStateData,
  target: PrivateStateTarget,
): string | Uint8Array {
  return typeof data === "function" ? data(target) : data;
}

export async function preflightPrivateStateTarget(
  workDir: string,
  spec: PrivateStateSpec,
  io: PrivateStateIo = {},
): Promise<PrivateStateTarget> {
  const write = io.write || checkedAtomicWriteFile;
  const remove = io.remove || ((filePath: string) => fsp.rm(filePath, { force: true }));
  const target = await resolvePrivateStateTarget(workDir, spec);
  try {
    await probePrivateStateTarget(target, write, remove);
    return target;
  } catch (error) {
    if (target.storageMode !== "git-private" || !privateStateFallbackAllowed(error)) throw error;
    if (await privateStatePathExists(spec.fallbackPath)) {
      throw new PrivateStateConflictError(spec.label, target.path, spec.fallbackPath);
    }
    const fallback = fallbackTarget(workDir, spec, target.path, error);
    await probePrivateStateTarget(fallback, write, remove);
    return fallback;
  }
}

export async function preflightAutoresearchPrivateState(
  workDir: string,
  io: PrivateStateIo = {},
): Promise<{
  storageMode: PrivateStateStorageMode;
  targets: PrivateStateTarget[];
  warnings: string[];
}> {
  const specs = autoresearchPrivateStateSpecs(workDir);
  const targets: PrivateStateTarget[] = [];
  for (const spec of specs) targets.push(await preflightPrivateStateTarget(workDir, spec, io));
  const warnings = [...new Set(targets.map((target) => target.warning).filter(Boolean))];
  const modes = new Set(targets.map((target) => target.storageMode));
  return {
    storageMode:
      modes.size === 1
        ? targets[0]?.storageMode || "worktree"
        : modes.has("worktree-fallback")
          ? "worktree-fallback"
          : "worktree",
    targets,
    warnings,
  };
}

export function autoresearchPrivateStateSpecs(workDir: string): PrivateStateSpec[] {
  const paths = resolveSessionPaths({ workDir });
  return [
    {
      fallbackPath: paths.lastRunFallbackPath,
      gitRelativePath: "autoresearch/last-run.json",
      label: "last-run packet",
    },
    {
      fallbackPath: paths.progressFallbackPath,
      gitRelativePath: "autoresearch/progress.json",
      label: "active progress",
    },
    {
      fallbackPath: paths.pendingLogTransactionFallbackPath,
      gitRelativePath: "autoresearch/pending-log-transaction.json",
      label: "pending log receipt",
    },
  ];
}

export async function autoresearchPrivateStateCandidatePaths(workDir: string): Promise<string[]> {
  const candidates = await Promise.all(
    autoresearchPrivateStateSpecs(workDir).map((spec) => privateStateCandidatePaths(workDir, spec)),
  );
  return [...new Set(candidates.flat())];
}

async function probePrivateStateTarget(
  target: PrivateStateTarget,
  write: typeof checkedAtomicWriteFile,
  remove: (filePath: string) => Promise<void>,
): Promise<void> {
  const probePath = path.join(
    path.dirname(target.path),
    `.${path.basename(target.path)}.${randomUUID()}.preflight`,
  );
  await write(target.root, probePath, "", { mode: 0o600 });
  try {
    await remove(probePath);
  } catch (error) {
    throw new Error(
      `Private state preflight could not remove its probe ${probePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function verifiedPrivateStateGitRepo(workDir: string): Promise<boolean> {
  if (!hasGitMarker(workDir)) return false;
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], workDir);
  if (result.code !== 0 || result.stdout.trim() !== "true") {
    throw new Error(
      `Git-private state storage could not verify the repository: ${gitOutput(
        result,
        "not a Git worktree",
      )}`,
    );
  }
  return true;
}

async function privateStatePathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function fallbackTarget(
  workDir: string,
  spec: PrivateStateSpec,
  gitPath: string,
  cause?: unknown,
): PrivateStateTarget {
  const code =
    cause && typeof cause === "object" ? String((cause as { code?: unknown }).code || "") : "";
  const reason = code ? ` after ${code}` : " because fallback state is already active";
  return {
    fallbackPath: spec.fallbackPath,
    gitPrivatePath: gitPath,
    label: spec.label,
    path: spec.fallbackPath,
    root: workDir,
    storageMode: "worktree-fallback",
    warning: `Git-private ${spec.label} storage is unavailable${reason}; using explicit worktree fallback ${spec.fallbackPath}.`,
  };
}

export async function gitDirtyPathDetails(cwd: string) {
  if (!(await insideGitRepo(cwd))) return [];
  const result = await runGit(["status", "--porcelain=v1", "-z", "-uall"], cwd);
  if (result.code !== 0) {
    throw new Error(`Git status failed: ${gitOutput(result, "unknown error")}`);
  }
  if (result.stdoutTruncated) {
    throw new Error(
      "Git path output exceeded the capture limit; refusing an incomplete trust check.",
    );
  }
  return parsePorcelainV1Z(result.stdout).flatMap((entry) =>
    entry.paths.map((gitPath) => ({
      status: entry.status,
      path: gitPath,
      raw: `${entry.status} ${displayGitPath(gitPath)}`,
    })),
  );
}

export async function gitStatusShort(cwd: string): Promise<string> {
  const result = await runGit(["status", "--porcelain=v1", "-z", "-uall"], cwd);
  if (result.code !== 0) {
    throw new Error(`Git status failed: ${gitOutput(result, "unknown error")}`);
  }
  assertCompleteGitPathOutput(result);
  return result.stdout;
}

export async function shortHead(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "--short=7", "HEAD"], cwd);
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function resolveCommitRef(cwd: string, commit: unknown): Promise<string> {
  const value = String(commit || "").trim();
  if (!value) throw new Error("commit is required");
  const result = await runGit(["rev-parse", "--verify", `${value}^{commit}`], cwd);
  if (result.code !== 0) {
    throw new Error(`Git commit could not be resolved: ${gitOutput(result, value)}`);
  }
  return result.stdout.trim();
}

export async function hasStagedChanges(cwd: string): Promise<boolean> {
  const result = await runGit(["diff", "--cached", "--quiet"], cwd);
  return result.code === 1;
}

export async function hasStagedChangesInPaths(cwd: string, paths: string[]): Promise<boolean> {
  const result = await runGit(
    ["--literal-pathspecs", "diff", "--cached", "--quiet", "--", ...paths],
    cwd,
  );
  return result.code === 1;
}

export async function assertNoGitIndexLock(
  workDir: string,
  phase = "git operation",
): Promise<void> {
  const lockPath = await gitPrivatePath(workDir, "index.lock");
  if (!(await pathExists(lockPath))) return;
  throw new Error(await gitIndexLockMessage(workDir, lockPath, phase, false));
}

export function gitIndexLockFailure(result: { stderr: string; stdout: string }): boolean {
  return /index\.lock|another git process|Unable to create/i.test(gitOutput(result, ""));
}

export async function gitIndexLockMessage(
  workDir: string,
  lockPath: string,
  phase: string,
  stagedMayHaveChanged: boolean,
): Promise<string> {
  const liveGit = await liveGitProcessSummary(workDir);
  return [
    `Git index lock blocked ${phase}: ${lockPath}.`,
    `Live git process check: ${liveGit}.`,
    stagedMayHaveChanged
      ? "Autoresearch could not prove whether staging partially changed; inspect git status before retrying."
      : "Autoresearch has not staged or committed anything for this log attempt.",
    "Wait for active Git commands to finish, then retry. If no Git process is active, remove the index.lock file and rerun the exact log command.",
  ].join(" ");
}

function assertCompleteGitPathOutput(result: ProcessRunResult): void {
  if (result.stdoutTruncated) {
    throw new Error(
      "Git path output exceeded the capture limit; refusing an incomplete trust check.",
    );
  }
}

async function liveGitProcessSummary(workDir: string): Promise<string> {
  try {
    const result =
      process.platform === "win32"
        ? await runProcess(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              "Get-Process git -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
            ],
            { cwd: workDir, timeoutSeconds: 2 },
          )
        : await runProcess("pgrep", ["-fl", "git"], { cwd: workDir, timeoutSeconds: 2 });
    const outputText = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    if (!outputText) return "no live git process found";
    return outputText.split(/\r?\n/).slice(0, 5).join(", ");
  } catch (error) {
    return `process check unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}
