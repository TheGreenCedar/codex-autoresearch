#!/usr/bin/env node
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

function usage() {
  return `Finalize an autoresearch branch into independent review branches.

Usage:
  node scripts/finalize-autoresearch.mjs groups.json

groups.json:
{
  "base": "<full merge-base hash>",
  "trunk": "main",
  "final_tree": "<full source branch HEAD>",
  "goal": "short-slug",
  "groups": [
    {
      "title": "Short commit title",
      "body": "Why and metric details",
      "last_commit": "<full commit hash>",
      "slug": "short-slug"
    }
  ]
}
`;
}

const SESSION_BASENAME = /^autoresearch\./;

async function run(command, args, cwd, allowFailure = false) {
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error.message || error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (!allowFailure && result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result;
}

async function git(args, cwd, allowFailure = false) {
  return await run("git", args, cwd, allowFailure);
}

function cleanLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isSessionFile(file) {
  return SESSION_BASENAME.test(path.basename(file));
}

async function currentBranch(cwd) {
  return (await git(["branch", "--show-current"], cwd)).stdout.trim();
}

async function fullHash(ref, cwd) {
  return (await git(["rev-parse", ref], cwd)).stdout.trim();
}

async function branchExists(branch, cwd) {
  const result = await git(["rev-parse", "--verify", branch], cwd, true);
  return result.code === 0;
}

async function isDirty(cwd) {
  const result = await git(["status", "--porcelain"], cwd);
  return result.stdout.trim().length > 0;
}

async function changedFiles(fromRef, toRef, cwd) {
  const result = await git(["diff", "--name-only", fromRef, toRef], cwd);
  return cleanLines(result.stdout).filter((file) => !isSessionFile(file));
}

async function pathExistsAt(ref, file, cwd) {
  const result = await git(["cat-file", "-e", `${ref}:${file}`], cwd, true);
  return result.code === 0;
}

async function applyFileFromCommit(ref, file, cwd) {
  if (await pathExistsAt(ref, file, cwd)) {
    await git(["checkout", ref, "--", file], cwd);
    return;
  }
  await fsp.rm(path.join(cwd, file), { recursive: true, force: true });
  await git(["rm", "-r", "--ignore-unmatch", "--", file], cwd, true);
}

async function collectGroups(config, cwd) {
  let prev = config.base;
  const seen = new Set();
  const groups = [];
  for (let i = 0; i < config.groups.length; i += 1) {
    const group = config.groups[i];
    const last = await fullHash(group.last_commit, cwd);
    const files = await changedFiles(prev, last, cwd);
    for (const file of files) {
      if (seen.has(file)) {
        throw new Error(`File appears in multiple groups: ${file}. Merge those groups and retry.`);
      }
      seen.add(file);
    }
    groups.push({ ...group, last_commit: last, files });
    prev = last;
  }
  return groups;
}

async function createBranchForGroup(config, group, index, cwd) {
  const number = String(index + 1).padStart(2, "0");
  const branch = `autoresearch-review/${config.goal}/${number}-${group.slug}`;
  if (await branchExists(branch, cwd)) throw new Error(`Branch already exists: ${branch}`);
  await git(["switch", "--detach", config.base], cwd);
  await git(["switch", "-c", branch], cwd);
  for (const file of group.files) {
    await applyFileFromCommit(group.last_commit, file, cwd);
  }
  await git(["add", "-A"], cwd);
  const diff = await git(["diff", "--cached", "--quiet"], cwd, true);
  if (diff.code === 0) return { branch, skipped: true };
  await git(["commit", "-m", group.title, "-m", group.body || ""], cwd);
  return { branch, skipped: false };
}

async function verifyUnion(config, groups, sourceBranch, createdBranches, cwd) {
  const verifyBranch = `autoresearch-review/${config.goal}/verify-tmp`;
  if (await branchExists(verifyBranch, cwd)) {
    await git(["branch", "-D", verifyBranch], cwd, true);
  }
  await git(["switch", "--detach", config.base], cwd);
  await git(["switch", "-c", verifyBranch], cwd);
  for (const group of groups) {
    for (const file of group.files) {
      await applyFileFromCommit(group.last_commit, file, cwd);
    }
  }
  await git(["add", "-A"], cwd);
  await git(["commit", "--allow-empty", "-m", "verify: union of autoresearch groups"], cwd);
  const diff = await git(["diff", "--name-only", "HEAD", config.final_tree], cwd);
  const nonSession = cleanLines(diff.stdout).filter((file) => !isSessionFile(file));
  await git(["switch", sourceBranch], cwd, true);
  await git(["branch", "-D", verifyBranch], cwd, true);
  if (nonSession.length > 0) {
    throw new Error(`Union of groups differs from final tree:\n${nonSession.join("\n")}\nCreated branches were left intact:\n${createdBranches.join("\n")}`);
  }
}

async function verifyNoSessionArtifacts(createdBranches, cwd) {
  for (const branch of createdBranches) {
    const result = await git(["diff-tree", "--no-commit-id", "--name-only", "-r", branch], cwd);
    const sessionFiles = cleanLines(result.stdout).filter(isSessionFile);
    if (sessionFiles.length > 0) {
      throw new Error(`Session artifact found in ${branch}: ${sessionFiles.join(", ")}`);
    }
  }
}

async function main() {
  const file = process.argv[2];
  if (!file || file === "--help" || file === "-h") {
    console.log(usage());
    return;
  }
  const cwd = process.cwd();
  const config = JSON.parse(await fsp.readFile(path.resolve(file), "utf8"));
  if (!config.base || !config.final_tree || !config.goal || !Array.isArray(config.groups)) {
    throw new Error("groups.json is missing base, final_tree, goal, or groups.");
  }
  config.trunk = config.trunk || "main";
  config.base = await fullHash(config.base, cwd);
  config.final_tree = await fullHash(config.final_tree, cwd);
  const sourceBranch = await currentBranch(cwd);
  if (!sourceBranch) throw new Error("Detached HEAD. Switch to the autoresearch branch first.");
  if (sourceBranch === config.trunk) throw new Error(`On trunk (${config.trunk}). Switch to the autoresearch branch first.`);
  if (await isDirty(cwd)) throw new Error("Working tree is dirty. Commit, stash, or clean changes before finalizing.");

  const groups = await collectGroups(config, cwd);
  const created = [];
  try {
    for (let i = 0; i < groups.length; i += 1) {
      const result = await createBranchForGroup(config, groups[i], i, cwd);
      if (!result.skipped) created.push(result.branch);
      console.log(`${String(i + 1).padStart(2, "0")}. ${groups[i].title}`);
      console.log(`    branch: ${result.branch}${result.skipped ? " (skipped empty)" : ""}`);
      console.log(`    files: ${groups[i].files.join(", ") || "(none)"}`);
    }
  } catch (error) {
    for (const branch of created) {
      await git(["branch", "-D", branch], cwd, true);
    }
    await git(["switch", sourceBranch], cwd, true);
    throw error;
  }

  await verifyUnion(config, groups, sourceBranch, created, cwd);
  await verifyNoSessionArtifacts(created, cwd);
  await git(["switch", sourceBranch], cwd, true);

  console.log("");
  console.log("Created review branches:");
  for (const branch of created) console.log(`  ${branch}`);
  console.log("");
  console.log("Cleanup after merge:");
  console.log(`  git branch -D ${sourceBranch}`);
  console.log("  rm -f autoresearch.jsonl autoresearch.md autoresearch.ideas.md autoresearch.sh autoresearch.ps1 autoresearch.checks.sh autoresearch.checks.ps1");
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
