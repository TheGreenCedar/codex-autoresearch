import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePackageRoot } from "./runtime-paths.js";

const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
type GitResult = { code: number | null; ok?: boolean; stderr: string; stdout: string };

export async function finalizePreview(args) {
  const startedAt = Date.now();
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const trunk = args.trunk || "main";
  const inside = await gitOk(["rev-parse", "--is-inside-work-tree"], workDir);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return withProgress(
      {
        ok: true,
        workDir,
        ready: false,
        groups: [],
        warnings: ["Working directory is not a Git repository."],
        nextAction: "Run finalization preview from a Git-backed autoresearch branch.",
      },
      startedAt,
      "blocked",
    );
  }

  const branch = (await git(["branch", "--show-current"], workDir)).stdout.trim();
  const dirty = (await git(["status", "--porcelain"], workDir)).stdout.trim();
  const ledgerRuns = await readLedgerRuns(workDir);
  const keptRuns = await readKeptRuns(workDir);
  const { groups, missingCommitCount, warnings } = await buildKeptRunGroups(workDir, keptRuns);
  const overlaps = findGroupFileOverlaps(groups);
  const finalTreePlan = await buildFinalTreePlan(workDir, trunk, groups);
  warnings.push(...finalTreePlan.warnings);
  const semanticSafety = await buildSemanticSafety({
    workDir,
    groups,
    ledgerRuns,
    base: finalTreePlan.base,
  });
  appendFinalTreeWarnings(warnings, finalTreePlan);
  warnings.push(...semanticSafety.blockers.map((blocker) => blocker.message));
  appendSourceBranchWarnings(warnings, { dirty, branch, trunk, overlaps });

  const ready = isFinalizePreviewReady({
    groups,
    dirty,
    branch,
    trunk,
    baseOk: finalTreePlan.baseOk,
    finalTreeCoverage: finalTreePlan.finalTreeCoverage,
    excludedPlannedFileConflicts: finalTreePlan.excludedPlannedFileConflicts,
    semanticSafety,
  });
  const planOutput = await defaultPlanOutput(workDir, branch || "autoresearch");
  const planArgv = [
    process.execPath,
    path.join(PLUGIN_ROOT, "scripts", "finalize-autoresearch.mjs"),
    "plan",
    "--output",
    planOutput,
    "--goal",
    safeSlug(branch || "autoresearch"),
    "--trunk",
    trunk,
  ];
  const nextAction = finalizePreviewNextAction({
    ready,
    semanticSafety,
    excludedPlannedFileConflicts: finalTreePlan.excludedPlannedFileConflicts,
    finalTreeCoverage: finalTreePlan.finalTreeCoverage,
    excludedCommits: finalTreePlan.excludedCommits,
    groups,
    keptRuns,
    missingCommitCount,
  });
  return withProgress(
    {
      ok: true,
      workDir,
      trunk,
      branch,
      base: finalTreePlan.base,
      ready,
      groups,
      missingCommitCount,
      excludedCommits: finalTreePlan.excludedCommits,
      excludedHistoryCommits: finalTreePlan.excludedCommits,
      excludedPlannedFileConflicts: finalTreePlan.excludedPlannedFileConflicts,
      finalTreeCoverage: finalTreePlan.finalTreeCoverage,
      semanticSafety,
      overlaps,
      warnings,
      suggestedCommand: planArgv.map(shellQuote).join(" "),
      suggestedCommands: {
        finalizerPlan: {
          argv: planArgv,
          cwd: workDir,
          display: planArgv.map(shellQuote).join(" "),
          purpose: "Write a review-branch plan without dirtying the source branch.",
          mutates: false,
        },
      },
      nextAction,
    },
    startedAt,
    ready ? "completed" : "blocked",
  );
}

async function buildKeptRunGroups(workDir, keptRuns) {
  const groups = [];
  const warnings = [];
  let missingCommitCount = 0;
  for (const run of keptRuns) {
    const commit = String(run.commit || "");
    if (!commit) {
      missingCommitCount += 1;
      continue;
    }
    const full = await gitOk(["rev-parse", commit], workDir);
    if (!full.ok) {
      warnings.push(`Kept run #${run.run} commit ${commit} could not be resolved.`);
      continue;
    }
    const hash = full.stdout.trim();
    const files = await changedFilesForCommit(hash, workDir);
    groups.push({
      title: run.description || `Autoresearch run #${run.run}`,
      run: run.run,
      commit: hash,
      shortCommit: hash.slice(0, 12),
      files,
      metric: run.metric,
      asi: run.asi || {},
      slug: safeSlug(run.description || `run-${run.run}`),
    });
  }
  return { groups, missingCommitCount, warnings };
}

function findGroupFileOverlaps(groups) {
  const seen = new Map();
  const overlaps = [];
  for (const group of groups) {
    for (const file of group.files) {
      if (seen.has(file)) overlaps.push({ file, first: seen.get(file), second: group.run });
      else seen.set(file, group.run);
    }
  }
  return overlaps;
}

async function buildFinalTreePlan(workDir, trunk, groups) {
  const warnings = [];
  let base = "";
  const baseResult = await gitOk(["merge-base", trunk, "HEAD"], workDir);
  if (baseResult.ok) base = baseResult.stdout.trim();
  else warnings.push(`Could not find merge-base with ${trunk}.`);

  const finalTree = (await git(["rev-parse", "HEAD"], workDir)).stdout.trim();
  const finalChangedFiles = base ? await changedFilesBetween(base, "HEAD", workDir) : [];
  const excludedCommits = base ? await unkeptCommitsSinceBase(base, groups, workDir) : [];
  const plannedFiles = plannedFilesForGroups(groups);
  const missingFinalTreeFiles = finalChangedFiles.filter((file) => !plannedFiles.includes(file));
  const excludedPlannedFileConflicts = findExcludedPlannedFileConflicts(
    excludedCommits,
    plannedFiles,
  );
  return {
    warnings,
    base,
    baseOk: baseResult.ok,
    finalTree,
    finalChangedFiles,
    excludedCommits,
    plannedFiles,
    missingFinalTreeFiles,
    excludedPlannedFileConflicts,
    finalTreeCoverage: {
      mode: "final-tree",
      finalTree,
      keptCommitCount: groups.length,
      excludedCommitCount: excludedCommits.length,
      excludedPlannedFileConflictCount: excludedPlannedFileConflicts.length,
      finalChangedFiles,
      plannedFiles,
      missingFiles: missingFinalTreeFiles,
      covered: missingFinalTreeFiles.length === 0,
    },
  };
}

function plannedFilesForGroups(groups) {
  const planned = new Set<string>();
  for (const group of groups) {
    for (const file of group.files || []) planned.add(file);
  }
  return [...planned].sort((a, b) => a.localeCompare(b));
}

function appendFinalTreeWarnings(warnings, finalTreePlan) {
  const { excludedCommits, missingFinalTreeFiles, excludedPlannedFileConflicts } = finalTreePlan;
  if (excludedCommits.length) {
    const sample = excludedCommits
      .slice(0, 3)
      .map((commit) => `${commit.shortCommit} ${commit.subject}`.trim())
      .join(", ");
    warnings.push(
      `Excluded ${excludedCommits.length} unkept non-session commit${excludedCommits.length === 1 ? "" : "s"} from base..HEAD: ${sample}${excludedCommits.length > 3 ? ", ..." : ""}.`,
    );
  }
  if (missingFinalTreeFiles.length) {
    warnings.push(
      `Final tree coverage is missing ${missingFinalTreeFiles.length} non-session file${missingFinalTreeFiles.length === 1 ? "" : "s"}: ${missingFinalTreeFiles.slice(0, 6).join(", ")}${missingFinalTreeFiles.length > 6 ? ", ..." : ""}.`,
    );
  }
  if (excludedPlannedFileConflicts.length) {
    const sample = excludedPlannedFileConflicts
      .slice(0, 3)
      .map((commit) => `${commit.shortCommit} ${commit.files.slice(0, 4).join(", ")}`.trim())
      .join("; ");
    warnings.push(
      `Excluded commits touch planned files and cannot be safely omitted: ${sample}${excludedPlannedFileConflicts.length > 3 ? "; ..." : ""}.`,
    );
  }
}

function appendSourceBranchWarnings(warnings, { dirty, branch, trunk, overlaps }) {
  if (dirty)
    warnings.push("Working tree is dirty; finalization branch creation will refuse to run.");
  if (!branch)
    warnings.push("Detached HEAD; switch to the autoresearch source branch before finalizing.");
  if (branch === trunk)
    warnings.push(
      `On trunk (${trunk}); switch to the autoresearch source branch before finalizing.`,
    );
  if (overlaps.length)
    warnings.push("Some kept runs touch the same files; finalization may need collapsed groups.");
}

function isFinalizePreviewReady({
  groups,
  dirty,
  branch,
  trunk,
  baseOk,
  finalTreeCoverage,
  excludedPlannedFileConflicts,
  semanticSafety,
}) {
  return (
    groups.length > 0 &&
    !dirty &&
    branch &&
    branch !== trunk &&
    baseOk &&
    finalTreeCoverage.covered &&
    excludedPlannedFileConflicts.length === 0 &&
    semanticSafety.ok
  );
}

function finalizePreviewNextAction({
  ready,
  semanticSafety,
  excludedPlannedFileConflicts,
  finalTreeCoverage,
  excludedCommits,
  groups,
  keptRuns,
  missingCommitCount,
}) {
  if (ready) return "Review the preview, then run the suggested finalizer plan command.";
  if (!semanticSafety.ok) {
    return "Resolve semantic safety blockers before finalizing stale, reverted, or invalidated evidence.";
  }
  if (excludedPlannedFileConflicts.length) {
    return "Rework the kept plan, collapse overlapping history, or use finalize-current-tree so omitted commits cannot affect planned files.";
  }
  if (!finalTreeCoverage.covered) {
    return "Use finalize-current-tree or log prerequisite/support commits so selected groups cover the current non-session branch diff.";
  }
  if (excludedCommits.length) {
    return "Review excluded history; it does not change final tree coverage, but may still need explanation in the handoff.";
  }
  if (groups.length === 0 && keptRuns.length > 0 && missingCommitCount === keptRuns.length) {
    return "Review branches need commit-backed keep logs. Log a keep with --commit, configure commitPaths, or rerun keep after committing the experiment.";
  }
  return "Resolve preview warnings before creating review branches.";
}

export async function finalizeCurrentTree(args) {
  const startedAt = Date.now();
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const trunk = args.trunk || "main";
  const excludeSessionArtifacts =
    args.exclude_session_artifacts ?? args.excludeSessionArtifacts ?? true;
  const inside = await gitOk(["rev-parse", "--is-inside-work-tree"], workDir);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return withProgress(
      {
        ok: true,
        workDir,
        ready: false,
        files: [],
        warnings: ["Working directory is not a Git repository."],
        nextAction: "Run current-tree finalization from a Git-backed autoresearch branch.",
      },
      startedAt,
      "blocked",
    );
  }
  const branch = (await git(["branch", "--show-current"], workDir)).stdout.trim();
  const baseResult = await gitOk(["merge-base", trunk, "HEAD"], workDir);
  const warnings = [];
  if (!baseResult.ok) warnings.push(`Could not find merge-base with ${trunk}.`);
  const base = baseResult.ok ? baseResult.stdout.trim() : "";
  const finalTree = (await git(["rev-parse", "HEAD"], workDir)).stdout.trim();
  const allFiles = base ? await changedFilesBetween(base, "HEAD", workDir, false) : [];
  const files = excludeSessionArtifacts
    ? allFiles.filter((file) => !isSessionFile(file))
    : allFiles;
  const dirty = (await git(["status", "--porcelain"], workDir)).stdout.trim();
  if (dirty)
    warnings.push("Working tree is dirty; current-tree plan requires a clean source branch.");
  if (!branch)
    warnings.push("Detached HEAD; switch to the autoresearch source branch before planning.");
  if (branch === trunk) warnings.push(`On trunk (${trunk}); switch to the source branch first.`);
  if (!files.length) warnings.push("No current non-session branch diff files were found.");

  const ready = Boolean(base && branch && branch !== trunk && !dirty && files.length);
  const planOutput = await defaultCurrentTreePlanOutput(workDir, branch || "autoresearch");
  const plan = {
    mode: "current-final-tree",
    source_branch: branch,
    planned_at: new Date().toISOString(),
    base,
    trunk,
    final_tree: finalTree,
    goal: safeSlug(branch || "autoresearch"),
    kept_commits: [],
    kept_run_count: 0,
    excluded_commits: [],
    excluded_commit_count: 0,
    overlap_files: [],
    current_tree_coverage: {
      covered: ready,
      file_count: files.length,
      exclude_session_artifacts: Boolean(excludeSessionArtifacts),
    },
    groups: [
      {
        title: `Current final tree for ${branch || "autoresearch"}`,
        body: "Packages the current non-session branch diff as the review unit when commit-level kept evidence is stale or incomplete.",
        last_commit: finalTree,
        slug: "current-final-tree",
        files,
      },
    ],
  };
  const planWithFingerprint = {
    ...plan,
    plan_fingerprint: planFingerprint(plan),
  };
  await fsp.mkdir(path.dirname(planOutput), { recursive: true });
  await fsp.writeFile(planOutput, `${JSON.stringify(planWithFingerprint, null, 2)}\n`, "utf8");
  return withProgress(
    {
      ok: true,
      workDir,
      trunk,
      branch,
      base,
      finalTree,
      ready,
      files,
      planOutput,
      planFingerprint: planWithFingerprint.plan_fingerprint,
      currentTreeCoverage: {
        covered: ready,
        files,
        fileCount: files.length,
        excludeSessionArtifacts: Boolean(excludeSessionArtifacts),
      },
      warnings,
      nextAction: ready
        ? "Review the current-final-tree plan, then run the finalizer with that plan file."
        : "Resolve current-tree finalization warnings before running the finalizer.",
    },
    startedAt,
    ready ? "completed" : "blocked",
  );
}

async function defaultPlanOutput(workDir, branch) {
  const gitPath = await gitOk(
    ["rev-parse", "--git-path", `autoresearch-finalize/${safeSlug(branch)}.groups.json`],
    workDir,
  );
  if (gitPath.ok && gitPath.stdout.trim()) return path.resolve(workDir, gitPath.stdout.trim());
  return path.join(workDir, ".git", "autoresearch-finalize", `${safeSlug(branch)}.groups.json`);
}

async function defaultCurrentTreePlanOutput(workDir, branch) {
  const gitPath = await gitOk(
    [
      "rev-parse",
      "--git-path",
      `autoresearch-finalize/${safeSlug(branch)}.current-final-tree.json`,
    ],
    workDir,
  );
  if (gitPath.ok && gitPath.stdout.trim()) return path.resolve(workDir, gitPath.stdout.trim());
  return path.join(
    workDir,
    ".git",
    "autoresearch-finalize",
    `${safeSlug(branch)}.current-final-tree.json`,
  );
}

function withProgress(result, startedAt, status) {
  const durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(3));
  return {
    ...result,
    progress: {
      mode: "synchronous",
      status,
      cancellable: false,
      cancelStatus: "not_requested",
      elapsedSeconds: durationSeconds,
      stages: [
        {
          stage: "finalize-preview",
          label: "Preview review branch readiness",
          status,
          durationSeconds,
          exitCode: null,
          timedOut: false,
          outputTail: result.nextAction || "",
        },
      ],
      latestOutputTail: result.nextAction || "",
    },
  };
}

async function readKeptRuns(cwd) {
  try {
    const text = await fsp.readFile(path.join(cwd, "autoresearch.jsonl"), "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.status === "keep");
  } catch {
    return [];
  }
}

async function readLedgerRuns(cwd) {
  try {
    const text = await fsp.readFile(path.join(cwd, "autoresearch.jsonl"), "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.run != null);
  } catch {
    return [];
  }
}

async function changedFilesForCommit(hash, cwd) {
  const result = await git(["show", "--name-only", "--format=", hash], cwd);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !isSessionFile(file));
}

async function changedFilesBetween(left, right, cwd, filterSession = true) {
  const result = await git(["diff", "--name-only", `${left}..${right}`], cwd);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !filterSession || !isSessionFile(file))
    .sort((a, b) => a.localeCompare(b));
}

async function buildSemanticSafety({ workDir, groups, ledgerRuns, base }) {
  const blockers = [];
  for (const group of groups) {
    const later = ledgerRuns.filter(
      (run) =>
        run.run > group.run &&
        run.commit &&
        commitRefsMayMatch(run.commit, group.commit) &&
        run.status !== "keep" &&
        explicitEvidenceInvalidationText(run),
    );
    if (later.length) {
      blockers.push({
        code: "later_invalidated_keep",
        run: group.run,
        commit: group.shortCommit || group.commit,
        message: `Kept run #${group.run} (${group.shortCommit}) was later explicitly invalidated for the same commit.`,
      });
    }
    if (explicitEvidenceInvalidationText(group)) {
      blockers.push({
        code: "invalidated_keep",
        run: group.run,
        commit: group.shortCommit || group.commit,
        message: `Kept run #${group.run} is marked invalidated or contaminated in ASI/description.`,
      });
    }
    if (base && (await keptCommitWasReverted(workDir, group))) {
      blockers.push({
        code: "reverted_keep",
        run: group.run,
        commit: group.shortCommit || group.commit,
        message: `Kept run #${group.run} (${group.shortCommit}) appears to have been reverted later in the branch.`,
      });
    }
  }
  return {
    ok: blockers.length === 0,
    blockers,
  };
}

async function keptCommitWasReverted(workDir, group) {
  const files = Array.isArray(group.files) ? group.files.filter(Boolean) : [];
  if (!files.length) return false;
  const log = await gitOk(
    ["log", "--format=%H%x1f%s", `${group.commit}..HEAD`, "--", ...files],
    workDir,
  );
  if (!log.ok) return false;
  return log.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      const [, subject = ""] = line.split("\x1f");
      return /^Revert\s+/i.test(subject) || subject.includes(group.shortCommit);
    });
}

function commitRefsMayMatch(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  return Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
}

function explicitEvidenceInvalidationText(run) {
  const text = `${run.description || ""} ${run.title || ""} ${JSON.stringify(run.asi || {})}`;
  return /invalidat|contaminat|taint|cache replay|failed repeat|(?:source|query|holdout|evaluator|benchmark|cache|data)\s+leak(?:age)?/i.test(
    text,
  )
    ? text
    : "";
}

async function unkeptCommitsSinceBase(base, groups, cwd) {
  const kept = new Set(groups.map((group) => group.commit));
  const result = await git(["log", "--reverse", "--format=%H%x1f%s", `${base}..HEAD`], cwd);
  const commits = [];
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [hash, subject = ""] = line.split("\x1f");
    if (!hash || kept.has(hash)) continue;
    const files = await changedFilesForCommit(hash, cwd);
    if (!files.length) continue;
    commits.push({
      commit: hash,
      shortCommit: hash.slice(0, 12),
      subject,
      files,
    });
  }
  return commits;
}

function findExcludedPlannedFileConflicts(excludedCommits, plannedFiles) {
  const planned = new Set(plannedFiles);
  if (!planned.size) return [];
  return excludedCommits
    .map((commit) => ({
      ...commit,
      files: (commit.files || []).filter((file) => planned.has(file)),
    }))
    .filter((commit) => commit.files.length > 0);
}

function normalizedExcludedCommits(plan) {
  return (Array.isArray(plan.excluded_commits) ? plan.excluded_commits : []).map((item) => ({
    commit: String(item?.commit || ""),
    status: String(item?.status || ""),
    subject: String(item?.subject || ""),
  }));
}

function planFingerprint(plan) {
  const stable = {
    source_branch: plan.source_branch || "",
    base: plan.base || "",
    trunk: plan.trunk || "",
    final_tree: plan.final_tree || "",
    goal: plan.goal || "",
    kept_commits: plan.kept_commits || [],
    kept_run_count: plan.kept_run_count || 0,
    excluded_commits: normalizedExcludedCommits(plan),
    excluded_commit_count: plan.excluded_commit_count || 0,
    overlap_files: plan.overlap_files || [],
    groups: (plan.groups || []).map((group) => ({
      title: group.title || "",
      last_commit: group.last_commit || "",
      slug: group.slug || "",
      files: group.files || [],
      source_groups: (group.source_groups || []).map((source) => ({
        last_commit: source.last_commit || "",
        parent_commit: source.parent_commit || "",
        files: source.files || [],
      })),
    })),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function isSessionFile(file) {
  const normalized = file.replace(/\\/g, "/");
  return (
    normalized.startsWith("autoresearch.") ||
    normalized.startsWith("autoresearch-") ||
    normalized.startsWith("autoresearch.research/")
  );
}

function safeSlug(value) {
  return (
    String(value || "autoresearch")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "autoresearch"
  );
}

function shellQuote(value) {
  const text = String(value);
  if (/^--[A-Za-z0-9-]+$/.test(text) || text === "plan") return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

async function git(args, cwd) {
  const result = await gitOk(args, cwd);
  if (!result.ok)
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result;
}

async function gitOk(args, cwd) {
  const result = await new Promise<GitResult>((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: String(error.message || error) }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { ...result, ok: result.code === 0 };
}
