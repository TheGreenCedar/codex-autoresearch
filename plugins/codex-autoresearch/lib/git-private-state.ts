import fs from "node:fs";
import path from "node:path";

import { isPathInside } from "./path-containment.js";
import { runProcess } from "./runner.js";
import { displayGitPath, parsePorcelainV1Z } from "./git-paths.js";

function hasGitMarker(cwd: string): boolean {
  let current = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function git(args: string[], cwd: string) {
  return await runProcess("git", args, { cwd, maxOutputBytes: 16 * 1024 * 1024 });
}

function gitOutput(result: { stderr: string; stdout: string }, fallback: string): string {
  return (result.stderr || result.stdout || fallback).trim();
}

export async function insideGitRepo(cwd: string): Promise<boolean> {
  if (!hasGitMarker(cwd)) return false;
  const result = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function gitPrivatePath(cwd: string, relativePath: string): Promise<string> {
  const result = await git(["rev-parse", "--git-path", relativePath], cwd);
  if (result.code !== 0) {
    throw new Error(`Git path lookup failed: ${gitOutput(result, "unknown error")}`);
  }
  const filePath = result.stdout.trim();
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export async function gitPrivateRoot(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--git-dir"], cwd);
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
  const result = await git(["status", "--porcelain=v1", "-z", "-uall"], cwd);
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
