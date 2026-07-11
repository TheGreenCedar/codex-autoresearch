import fs from "node:fs";
import path from "node:path";

import { isPathInside } from "./path-containment.js";
import { runProcess, type ProcessRunResult } from "./runner.js";
import { displayGitPath, parsePorcelainV1Z } from "./git-paths.js";
import { pathExists } from "./session-core.js";

function hasGitMarker(cwd: string): boolean {
  let current = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function runGit(args: string[], cwd: string) {
  return await runProcess("git", args, { cwd, maxOutputBytes: 16 * 1024 * 1024 });
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

export async function privateStateWriteRoot(workDir: string, target: string): Promise<string> {
  if (!(await insideGitRepo(workDir).catch(() => false))) return workDir;
  const gitRoot = await gitPrivateRoot(workDir);
  if (!isPathInside(gitRoot, target)) {
    throw new Error(`Git-private state path escapes the Git directory: ${target}`);
  }
  return gitRoot;
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
