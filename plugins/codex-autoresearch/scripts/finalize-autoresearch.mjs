#!/usr/bin/env node
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

function usage() {
  return `Finalize an autoresearch branch into independent review branches.

Usage:
  node scripts/finalize-autoresearch.mjs plan --output groups.json [--goal short-slug] [--trunk main]
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

const SESSION_FILES = new Set([
  "autoresearch.jsonl",
  "autoresearch.md",
  "autoresearch.ideas.md",
  "autoresearch.config.json",
  "autoresearch.sh",
  "autoresearch.ps1",
  "autoresearch.checks.sh",
  "autoresearch.checks.ps1",
]);
const RESEARCH_DIR = "autoresearch.research";
const REPORT_DIRNAME = "autoresearch-finalize";

function parseCliArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

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
  const normalized = file.replace(/\\/g, "/");
  return SESSION_FILES.has(normalized) || normalized === RESEARCH_DIR || normalized.startsWith(`${RESEARCH_DIR}/`);
}

async function currentBranch(cwd) {
  return (await git(["branch", "--show-current"], cwd)).stdout.trim();
}

async function gitCommonDir(cwd) {
  const commonDir = (await git(["rev-parse", "--git-common-dir"], cwd)).stdout.trim();
  return path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
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

function safeSlug(value) {
  return String(value || "autoresearch")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "autoresearch";
}

function shortHash(hash) {
  return String(hash || "").slice(0, 12);
}

function markdownEscape(text) {
  return String(text || "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

async function readKeptRuns(cwd) {
  try {
    const text = await fsp.readFile(path.join(cwd, "autoresearch.jsonl"), "utf8");
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.status === "keep");
  } catch {
    return [];
  }
}

function runEvidenceForCommit(keptRuns, hash) {
  return keptRuns.find((run) => {
    const commit = String(run.commit || "");
    return commit && (hash.startsWith(commit) || commit.startsWith(hash.slice(0, 12)));
  });
}

function draftBodyForCommit(run) {
  if (!run) return "Drafted from git history. Review metric evidence, ASI, and branch diff before opening a PR.";
  const lines = [
    `Experiment #${run.run}: ${run.description || "kept autoresearch change"}`,
    `Metric: ${run.metric}`,
  ];
  if (run.asi?.hypothesis) lines.push(`Hypothesis: ${run.asi.hypothesis}`);
  if (run.asi?.evidence) lines.push(`Evidence: ${run.asi.evidence}`);
  if (run.asi?.next_action_hint) lines.push(`Next action: ${run.asi.next_action_hint}`);
  return lines.join("\n\n");
}

function branchName(config, group, index) {
  const number = String(index + 1).padStart(2, "0");
  return `autoresearch-review/${safeSlug(config.goal)}/${number}-${safeSlug(group.slug || group.title || "change")}`;
}

async function branchStat(branch, cwd) {
  const result = await git(["show", "--stat", "--oneline", "--decorate=short", "--no-renames", branch], cwd, true);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function reviewSummaryPath(config, cwd) {
  const dir = path.join(await gitCommonDir(cwd), REPORT_DIRNAME);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${stamp}-${safeSlug(config.goal)}.md`);
}

async function writeReviewSummary(file, context) {
  const { config, groups, results, sourceBranch, status, error } = context;
  const lines = [
    `# Autoresearch Finalize Review Summary`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Status: ${status}`,
    `Source branch: \`${sourceBranch}\``,
    `Base: \`${shortHash(config.base)}\``,
    `Final tree: \`${shortHash(config.final_tree)}\``,
    `Goal: \`${config.goal}\``,
    "",
    "## Review Branches",
    "",
    "| # | Branch | Title | Files |",
    "|---:|---|---|---|",
  ];

  for (let i = 0; i < groups.length; i += 1) {
    const result = results[i];
    const branch = result?.branch || "(not created)";
    const suffix = result?.skipped ? " (skipped empty)" : "";
    lines.push(`| ${i + 1} | \`${markdownEscape(branch)}\`${suffix} | ${markdownEscape(groups[i].title)} | ${markdownEscape(groups[i].files.join(", ") || "(none)")} |`);
  }

  lines.push(
    "",
    "## Suggested PRs",
    "",
  );
  for (let i = 0; i < groups.length; i += 1) {
    const result = results[i];
    if (!result || result.skipped) continue;
    lines.push(
      `### ${i + 1}. ${groups[i].title}`,
      "",
      `Branch: \`${result.branch}\``,
      "",
      "Suggested PR title:",
      "",
      "```text",
      groups[i].title,
      "```",
      "",
      "Suggested PR body:",
      "",
      "```markdown",
      groups[i].body || "Autoresearch kept change. Review metric evidence and branch diff.",
      "```",
      "",
      "Review commands:",
      "",
      "```bash",
      `git show --stat ${result.branch}`,
      `git diff ${shortHash(config.base)}..${result.branch} -- ${groups[i].files.join(" ")}`,
      "```",
      "",
    );
    if (result.stat) {
      lines.push("Branch stat:", "", "```text", result.stat, "```", "");
    }
  }

  lines.push(
    "",
    "## Verification",
    "",
    status === "verified"
      ? "- Union verification passed: grouped files match the final tree, excluding autoresearch session artifacts."
      : status === "failed"
        ? `- Verification or branch creation failed: ${markdownEscape(error?.message || error || "unknown error")}`
        : "- Verification is pending.",
    "- Session artifact verification is preserved: review branches must not contain `autoresearch.*` files or `autoresearch.research/` scratchpads.",
    "",
    "## Cleanup After Merge",
    "",
    "```bash",
    `git branch -D ${sourceBranch}`,
    "rm -rf autoresearch.research && rm -f autoresearch.jsonl autoresearch.md autoresearch.ideas.md autoresearch.config.json autoresearch.sh autoresearch.ps1 autoresearch.checks.sh autoresearch.checks.ps1",
    "```",
    "",
    `This file is generated under Git metadata (\`${REPORT_DIRNAME}\`) so it does not dirty the worktree. Remove it when no longer needed.`
  );

  await fsp.writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

function phaseError(phase, error, hint) {
  const original = error instanceof Error ? error : new Error(String(error));
  const message = [
    `Finalize failed during ${phase}.`,
    hint ? `Next step: ${hint}` : "",
    "",
    original.message || String(original),
  ].filter((line) => line !== "").join("\n");
  const wrapped = new Error(message);
  wrapped.cause = original;
  wrapped.finalizePhase = phase;
  return wrapped;
}

async function withPhase(phase, hint, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error?.finalizePhase) throw error;
    throw phaseError(phase, error, hint);
  }
}

async function createBranchForGroup(config, group, index, cwd) {
  const branch = branchName(config, group, index);
  if (!group.files.length) return { branch, skipped: true, deleted: true, stat: "" };
  if (await branchExists(branch, cwd)) throw new Error(`Branch already exists: ${branch}`);
  await git(["switch", "--detach", config.base], cwd);
  await git(["switch", "-c", branch], cwd);
  for (const file of group.files) {
    await applyFileFromCommit(group.last_commit, file, cwd);
  }
  await git(["add", "-A"], cwd);
  const diff = await git(["diff", "--cached", "--quiet"], cwd, true);
  if (diff.code === 0) {
    await git(["switch", "--detach", config.base], cwd, true);
    await git(["branch", "-D", branch], cwd, true);
    return { branch, skipped: true, deleted: true, stat: "" };
  }
  await git(["commit", "-m", group.title, "-m", group.body || ""], cwd);
  return { branch, skipped: false, deleted: false, stat: await branchStat(branch, cwd) };
}

async function verifyUnion(config, groups, sourceBranch, createdBranches, cwd) {
  const verifyBranch = `autoresearch-review/${safeSlug(config.goal)}/verify-tmp`;
  if (await branchExists(verifyBranch, cwd)) {
    await git(["branch", "-D", verifyBranch], cwd, true);
  }
  let nonSession = [];
  try {
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
    nonSession = cleanLines(diff.stdout).filter((file) => !isSessionFile(file));
  } finally {
    await git(["switch", sourceBranch], cwd, true);
    await git(["branch", "-D", verifyBranch], cwd, true);
  }
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

async function draftGroupsPlan(args, cwd) {
  const trunk = args.trunk || "main";
  const sourceBranch = await currentBranch(cwd);
  if (!sourceBranch) throw new Error("Detached HEAD. Switch to the autoresearch branch before planning.");
  const base = (await git(["merge-base", trunk, "HEAD"], cwd)).stdout.trim();
  const finalTree = await fullHash("HEAD", cwd);
  const goal = safeSlug(args.goal || sourceBranch.replace(/^.*\//, "") || "autoresearch");
  const keptRuns = await readKeptRuns(cwd);
  const log = await git(["log", "--reverse", "--format=%H%x1f%s", `${base}..HEAD`], cwd);
  let prev = base;
  const groups = [];
  for (const line of cleanLines(log.stdout)) {
    const [hash, subject] = line.split("\x1f");
    if (!hash) continue;
    const files = await changedFiles(prev, hash, cwd);
    prev = hash;
    if (!files.length) continue;
    const run = runEvidenceForCommit(keptRuns, hash);
    groups.push({
      title: subject || `Autoresearch change ${groups.length + 1}`,
      body: draftBodyForCommit(run),
      last_commit: hash,
      slug: safeSlug(subject || `change-${groups.length + 1}`),
    });
  }
  return {
    base,
    trunk,
    final_tree: finalTree,
    goal,
    groups,
  };
}

async function writeDraftPlan(args, cwd) {
  const plan = await draftGroupsPlan(args, cwd);
  const output = args.output ? path.resolve(args.output) : path.resolve(cwd, "autoresearch.groups.json");
  await fsp.writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(`Wrote draft groups: ${output}`);
  console.log(`Groups: ${plan.groups.length}`);
  return plan;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const command = cli._[0];
  const file = command;
  if (!file || file === "--help" || file === "-h") {
    console.log(usage());
    return;
  }
  const cwd = process.cwd();
  if (command === "plan") {
    await writeDraftPlan(cli, cwd);
    return;
  }
  const configPath = path.resolve(file);
  const config = await withPhase("configuration", "Fix groups.json and retry.", async () => {
    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    if (!parsed.base || !parsed.final_tree || !parsed.goal || !Array.isArray(parsed.groups)) {
      throw new Error("groups.json is missing base, final_tree, goal, or groups.");
    }
    parsed.trunk = parsed.trunk || "main";
    parsed.base = await fullHash(parsed.base, cwd);
    parsed.final_tree = await fullHash(parsed.final_tree, cwd);
    return parsed;
  });

  const sourceBranch = await withPhase("preflight", "Switch to a clean autoresearch source branch, then rerun finalization.", async () => {
    const branch = await currentBranch(cwd);
    if (!branch) throw new Error("Detached HEAD. Switch to the autoresearch branch first.");
    if (branch === config.trunk) throw new Error(`On trunk (${config.trunk}). Switch to the autoresearch branch first.`);
    if (await isDirty(cwd)) throw new Error("Working tree is dirty. Commit, stash, or clean changes before finalizing.");
    return branch;
  });

  const groups = await withPhase("group analysis", "Merge overlapping groups or correct the kept commit order in groups.json.", async () => {
    return await collectGroups(config, cwd);
  });

  const created = [];
  const results = [];
  let summaryPath = "";
  try {
    await withPhase("branch creation", "Delete or rename any conflicting autoresearch-review branches, then retry.", async () => {
      for (let i = 0; i < groups.length; i += 1) {
        const result = await createBranchForGroup(config, groups[i], i, cwd);
        results.push(result);
        if (!result.skipped) created.push(result.branch);
        console.log(`${String(i + 1).padStart(2, "0")}. ${groups[i].title}`);
        console.log(`    branch: ${result.branch}${result.skipped ? " (skipped empty)" : ""}`);
        console.log(`    files: ${groups[i].files.join(", ") || "(none)"}`);
      }
    });
  } catch (error) {
    for (const branch of created) {
      await git(["branch", "-D", branch], cwd, true);
    }
    await git(["switch", sourceBranch], cwd, true);
    throw error;
  }

  summaryPath = await reviewSummaryPath(config, cwd);
  await writeReviewSummary(summaryPath, { config, groups, results, sourceBranch, status: "pending" });
  console.log("");
  console.log(`Review summary: ${summaryPath}`);

  try {
    await withPhase("union verification", "Inspect the generated review summary and the listed file differences before changing groups.json.", async () => {
      await verifyUnion(config, groups, sourceBranch, created, cwd);
    });
    await withPhase("session artifact verification", "Remove autoresearch.* files from review branches, then rerun finalization.", async () => {
      await verifyNoSessionArtifacts(created, cwd);
    });
    await git(["switch", sourceBranch], cwd, true);
    await writeReviewSummary(summaryPath, { config, groups, results, sourceBranch, status: "verified" });
  } catch (error) {
    await git(["switch", sourceBranch], cwd, true);
    await writeReviewSummary(summaryPath, { config, groups, results, sourceBranch, status: "failed", error });
    console.error("");
    console.error(`Review summary: ${summaryPath}`);
    throw error;
  }

  console.log("");
  console.log("Created review branches:");
  for (const branch of created) console.log(`  ${branch}`);
  console.log("");
  console.log("Cleanup after merge:");
  console.log(`  git branch -D ${sourceBranch}`);
  console.log("  rm -rf autoresearch.research && rm -f autoresearch.jsonl autoresearch.md autoresearch.ideas.md autoresearch.config.json autoresearch.sh autoresearch.ps1 autoresearch.checks.sh autoresearch.checks.ps1");
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
