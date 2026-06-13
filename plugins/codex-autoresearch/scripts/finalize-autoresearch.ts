#!/usr/bin/env node
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { isAcceptedCurrentRun } from "../lib/evidence-registry.js";
import { productGradeFinalizationIssue } from "../lib/finalization-acceptance.js";
import { classifyFinalizationRunwayFromFacts } from "../lib/finalization-runway.js";
import {
  assertGeneratedPlanMetadata,
  finalizationPlanFingerprint,
  readAutoresearchLedger,
} from "../lib/finalization-plan.js";
import { buildFinalizationProductClaimCoverageFromLedger } from "../lib/product-claim-coverage.js";
import {
  CLEANUP_SESSION_PATHS,
  REPORT_DIRNAME,
  isAutoresearchSessionArtifact,
} from "../lib/session-artifacts.js";

type LooseObject = Record<string, any>;
type LocalProcessResult = { code: number | null; stderr: string; stdout: string };
type FinalizePhaseError = Error & { cause?: unknown; finalizePhase?: string };
type CliArgs = LooseObject & { _: string[] };
type RunEntry = LooseObject & {
  commit?: string;
  description?: string;
  metric?: unknown;
  run?: number;
  status?: string;
};
type CommitInfo = {
  hash: string;
  parents: string[];
  subject: string;
};
type PlanSourceGroup = LooseObject & {
  files?: string[];
  last_commit: string;
  parent_commit?: string;
  slug?: string;
  title?: string;
};
type CollectedSourceGroup = PlanSourceGroup & {
  files: string[];
  parent_commit: string;
};
type PlanGroup = LooseObject & {
  body?: string;
  files?: string[];
  last_commit: string;
  parent_commit?: string;
  slug?: string;
  source_groups?: PlanSourceGroup[];
  title?: string;
};
type CollectedGroup = PlanGroup & {
  files: string[];
  parent_commit: string;
  source_groups: CollectedSourceGroup[];
};
type ExcludedCommit = {
  commit: string;
  status?: string;
  subject?: string;
};
type FinalizePlan = LooseObject & {
  base: string;
  excluded_commits?: ExcludedCommit[];
  final_tree: string;
  goal: string;
  groups: PlanGroup[];
  plan_fingerprint?: string;
  product_claim_coverage?: LooseObject;
  product_grade_issue?: string | null;
  product_grade_ready?: boolean;
  product_grade_summary?: string;
  source_branch?: string;
  trunk: string;
};
type BranchResult = {
  branch: string;
  deleted?: boolean;
  runway?: LooseObject;
  skipped?: boolean;
  stat: string;
};
type OverlapAnalysis = {
  files: string[];
  groups: string[];
};
type ReviewSummaryContext = {
  config: FinalizePlan;
  error?: unknown;
  groups: CollectedGroup[];
  results: BranchResult[];
  sourceBranch: string;
  status: string;
};

function usage() {
  return `Finalize an autoresearch branch into independent review branches.

Usage:
  node scripts/finalize-autoresearch.mjs plan --cwd <repo> --output groups.json [--goal short-slug] [--trunk main] [--collapse-overlap]
  node scripts/finalize-autoresearch.mjs --cwd <repo> groups.json

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

function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const equalsAt = arg.indexOf("=");
    const rawKey = equalsAt > 2 ? arg.slice(2, equalsAt) : arg.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    if (equalsAt > 2) {
      out[key] = arg.slice(equalsAt + 1);
      continue;
    }
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

function resolveFinalizerCwd(args: CliArgs): string {
  const raw = args.cwd ?? args.workingDir;
  if (raw == null || raw === "" || raw === true) return process.cwd();
  return path.resolve(String(raw));
}

function resolveCliPath(input: unknown, cwd: string): string {
  const text = String(input || "");
  return path.isAbsolute(text) ? text : path.resolve(cwd, text);
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  allowFailure = false,
): Promise<LocalProcessResult> {
  const result = await new Promise<LocalProcessResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) =>
      resolve({ code: -1, stdout, stderr: String(error.message || error) }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (!allowFailure && result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result;
}

async function git(args: string[], cwd: string, allowFailure = false): Promise<LocalProcessResult> {
  return await run("git", args, cwd, allowFailure);
}

function cleanLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function validateRepoRelativePath(file: unknown, cwd: string): string {
  const normalized = String(file || "")
    .trim()
    .replace(/\\/g, "/");
  if (!normalized) throw new Error("Unsafe finalizer file path: empty path.");
  if (normalized.includes("\0"))
    throw new Error(`Unsafe finalizer file path contains NUL: ${file}`);
  if (
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.startsWith("//")
  ) {
    throw new Error(`Unsafe finalizer file path must be repo-relative: ${file}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(
      `Unsafe finalizer file path must not contain empty, dot, or parent segments: ${file}`,
    );
  }
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    throw new Error(`Unsafe finalizer file path must not target Git metadata: ${file}`);
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, ...parts);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe finalizer file path resolves outside the repo: ${file}`);
  }
  return parts.join("/");
}

async function currentBranch(cwd: string): Promise<string> {
  return (await git(["branch", "--show-current"], cwd)).stdout.trim();
}

async function gitCommonDir(cwd: string): Promise<string> {
  const commonDir = (await git(["rev-parse", "--git-common-dir"], cwd)).stdout.trim();
  return path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
}

async function fullHash(ref: string, cwd: string): Promise<string> {
  return (await git(["rev-parse", ref], cwd)).stdout.trim();
}

async function branchExists(branch: string, cwd: string): Promise<boolean> {
  const result = await git(["rev-parse", "--verify", branch], cwd, true);
  return result.code === 0;
}

async function isDirty(cwd: string): Promise<boolean> {
  const result = await git(["status", "--porcelain"], cwd);
  return result.stdout.trim().length > 0;
}

async function restoreSourceBranch(sourceBranch: string, cwd: string): Promise<void> {
  await git(["switch", sourceBranch], cwd, true);
  await git(["reset", "--hard", "HEAD"], cwd, true);
}

async function changedFiles(fromRef: string, toRef: string, cwd: string): Promise<string[]> {
  const result = await git(["diff", "--name-only", fromRef, toRef], cwd);
  return normalizePlanFiles(cleanLines(result.stdout), cwd);
}

function planExcludesSessionArtifacts(config: FinalizePlan): boolean {
  return config.current_tree_coverage?.exclude_session_artifacts !== false;
}

async function pathExistsAt(ref: string, file: string, cwd: string): Promise<boolean> {
  const result = await git(["cat-file", "-e", `${ref}:${file}`], cwd, true);
  return result.code === 0;
}

async function applyFileFromCommit(ref: string, file: unknown, cwd: string): Promise<void> {
  const safeFile = validateRepoRelativePath(file, cwd);
  if (await pathExistsAt(ref, safeFile, cwd)) {
    await git(["checkout", ref, "--", safeFile], cwd);
    return;
  }
  await fsp.rm(path.resolve(cwd, safeFile), { recursive: true, force: true });
  await git(["rm", "-r", "--ignore-unmatch", "--", safeFile], cwd, true);
}

function sourceStepsForGroup(group: CollectedGroup): CollectedSourceGroup[] {
  if (Array.isArray(group.source_groups) && group.source_groups.length) return group.source_groups;
  return [
    {
      last_commit: group.last_commit,
      parent_commit: group.parent_commit,
      files: group.files || [],
    },
  ];
}

async function applyGroupSources(group: CollectedGroup, cwd: string): Promise<void> {
  for (const source of sourceStepsForGroup(group)) {
    for (const file of source.files || []) {
      await applyFileFromCommit(source.last_commit, file, cwd);
    }
  }
}

async function collectGroups(config: FinalizePlan, cwd: string): Promise<CollectedGroup[]> {
  const seen = new Set<string>();
  const groups: CollectedGroup[] = [];
  const excludeSessionArtifacts = planExcludesSessionArtifacts(config);
  for (let i = 0; i < config.groups.length; i += 1) {
    const group = config.groups[i];
    const last = await fullHash(group.last_commit, cwd);
    const parent = group.parent_commit
      ? await fullHash(group.parent_commit, cwd)
      : await commitParent(last, config.base, cwd);
    const sourceGroups =
      Array.isArray(group.source_groups) && group.source_groups.length
        ? await collectSourceGroups(group.source_groups, config, cwd)
        : [
            {
              last_commit: last,
              parent_commit: parent,
              files:
                Array.isArray(group.files) && group.files.length
                  ? normalizePlanFiles(group.files, cwd, excludeSessionArtifacts)
                  : await changedFiles(parent, last, cwd),
            },
          ];
    const files = normalizePlanFiles(
      sourceGroups.flatMap((source) => source.files || []),
      cwd,
      excludeSessionArtifacts,
    );
    for (const file of files) {
      if (seen.has(file)) {
        throw new Error(`File appears in multiple groups: ${file}. Merge those groups and retry.`);
      }
      seen.add(file);
    }
    groups.push({
      ...group,
      last_commit: last,
      files,
      parent_commit: parent,
      source_groups: sourceGroups,
    });
  }
  await assertNoExcludedFileConflicts(config, groups, cwd);
  return groups;
}

async function collectSourceGroups(
  sources: PlanSourceGroup[],
  config: FinalizePlan,
  cwd: string,
): Promise<CollectedSourceGroup[]> {
  const collected: CollectedSourceGroup[] = [];
  const excludeSessionArtifacts = planExcludesSessionArtifacts(config);
  for (const source of sources) {
    const last = await fullHash(source.last_commit, cwd);
    const parent = source.parent_commit
      ? await fullHash(source.parent_commit, cwd)
      : await commitParent(last, config.base, cwd);
    const files =
      Array.isArray(source.files) && source.files.length
        ? normalizePlanFiles(source.files, cwd, excludeSessionArtifacts)
        : await changedFiles(parent, last, cwd);
    collected.push({ ...source, last_commit: last, parent_commit: parent, files });
  }
  return collected;
}

async function assertNoExcludedFileConflicts(
  config: FinalizePlan,
  groups: CollectedGroup[],
  cwd: string,
): Promise<void> {
  const plannedFiles = new Set(groups.flatMap((group) => group.files || []));
  if (
    !plannedFiles.size ||
    !Array.isArray(config.excluded_commits) ||
    !config.excluded_commits.length
  )
    return;
  const conflicts: Array<{ commit: string; files: string[]; subject: string }> = [];
  for (const item of config.excluded_commits) {
    if (!item?.commit) continue;
    const commit = await fullHash(item.commit, cwd);
    const parent = await commitParent(commit, config.base, cwd);
    const files = await changedFiles(parent, commit, cwd);
    const overlapping = files.filter((file) => plannedFiles.has(file));
    if (overlapping.length) {
      conflicts.push({ commit, subject: item.subject || "", files: overlapping });
    }
  }
  if (!conflicts.length) return;
  const details = conflicts
    .slice(0, 6)
    .map((conflict) => {
      const subject = conflict.subject ? ` ${conflict.subject}` : "";
      return `${shortHash(conflict.commit)}${subject}: ${conflict.files.slice(0, 8).join(", ")}`;
    })
    .join("\n");
  throw new Error(
    `Finalization stopped because excluded commits touch planned kept files. Rework the kept commits or finalization plan so unkept state cannot enter review branches.\n${details}`,
  );
}

function safeSlug(value: unknown): string {
  return (
    String(value || "autoresearch")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "autoresearch"
  );
}

function shortHash(hash: string): string {
  return String(hash || "").slice(0, 12);
}

function markdownEscape(text: string): string {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function runEvidenceForCommit(entries: RunEntry[], hash: string): RunEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const run = entries[index];
    const commit = String(run.commit || "");
    if (commitMatchesHash(commit, hash)) {
      return isAcceptedCurrentRun(run) ? run : null;
    }
  }
  return null;
}

function commitMatchesHash(commit: unknown, hash: string): boolean {
  if (!commit) return false;
  const text = String(commit);
  return hash.startsWith(text) || text.startsWith(hash.slice(0, 12));
}

async function readAutoresearchJsonl(cwd: string): Promise<RunEntry[]> {
  return (await readAutoresearchLedger(cwd, { mode: "strict" })) as RunEntry[];
}

async function commitHistory(base: string, cwd: string): Promise<CommitInfo[]> {
  const result = await git(["log", "--reverse", "--format=%H%x1f%P%x1f%s", `${base}..HEAD`], cwd);
  return cleanLines(result.stdout)
    .map((line) => {
      const [hash = "", parents = "", subject = ""] = line.split("\x1f");
      return {
        hash,
        parents: cleanLines(parents.replace(/\s+/g, "\n")),
        subject,
      };
    })
    .filter((item) => item.hash);
}

async function commitParent(hash: string, base: string, cwd: string): Promise<string> {
  const result = await git(["rev-list", "--parents", "-n", "1", hash], cwd);
  const parts = cleanLines(result.stdout.replace(/\s+/g, "\n"));
  const parent = parts[1] || base;
  return parent || base;
}

function parseCommitStatus(entries: RunEntry[], hash: string): RunEntry | null {
  const matching: RunEntry[] = [];
  for (const entry of entries) {
    const commit = String(entry.commit || "");
    if (commitMatchesHash(commit, hash)) matching.push(entry);
  }
  return matching.at(-1) || null;
}

function describeCommitStatus(entry: RunEntry | null): string {
  if (!entry) return "unlogged";
  if (isAcceptedCurrentRun(entry)) return "kept";
  if (entry.status === "keep" && entry.evidenceStatus) return String(entry.evidenceStatus);
  return String(entry.status || "unlogged");
}

function quotePathspecs(files: string[]): string {
  return files.map((file) => posixQuote(file)).join(" ");
}

function normalizePlanFiles(
  files: unknown[],
  cwd: string,
  excludeSessionArtifacts = true,
): string[] {
  return [
    ...new Set(
      (Array.isArray(files) ? files : [])
        .map((file) => validateRepoRelativePath(file, cwd))
        .filter(
          (file) =>
            !excludeSessionArtifacts || !isAutoresearchSessionArtifact(file, "finalization"),
        ),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function draftBodyForCommit(run: RunEntry | null): string {
  if (!run)
    return "Drafted from git history. Review metric evidence, ASI, and branch diff before opening a PR.";
  const lines = [
    `Experiment #${run.run}: ${run.description || "kept autoresearch change"}`,
    `Metric: ${run.metric}`,
  ];
  if (run.asi?.hypothesis) lines.push(`Hypothesis: ${run.asi.hypothesis}`);
  if (run.asi?.evidence) lines.push(`Evidence: ${run.asi.evidence}`);
  if (run.asi?.next_action_hint) lines.push(`Next action: ${run.asi.next_action_hint}`);
  return lines.join("\n\n");
}

function branchName(config: FinalizePlan, group: PlanGroup, index: number): string {
  const number = String(index + 1).padStart(2, "0");
  return `autoresearch-review/${safeSlug(config.goal)}/${number}-${safeSlug(group.slug || group.title || "change")}`;
}

async function branchStat(branch: string, cwd: string): Promise<string> {
  const result = await git(
    ["show", "--stat", "--oneline", "--decorate=short", "--no-renames", branch],
    cwd,
    true,
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

async function reviewSummaryPath(config: FinalizePlan, cwd: string): Promise<string> {
  const dir = path.join(await gitCommonDir(cwd), REPORT_DIRNAME);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${stamp}-${safeSlug(config.goal)}.md`);
}

function renderReviewSummaryHeader({
  config,
  sourceBranch,
  status,
  generatedAt,
}: {
  config: FinalizePlan;
  generatedAt: string;
  sourceBranch: string;
  status: string;
}): string[] {
  return [
    `# Autoresearch Finalize Review Summary`,
    "",
    `Generated: ${generatedAt}`,
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
}

function renderBranchRows(groups: CollectedGroup[], results: BranchResult[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]!;
    const result = results[i];
    const branch = result?.branch || "(not created)";
    const suffix = result?.skipped ? " (skipped empty)" : "";
    lines.push(
      `| ${i + 1} | \`${markdownEscape(branch)}\`${suffix} | ${markdownEscape(group.title || "")} | ${markdownEscape(group.files.join(", ") || "(none)")} |`,
    );
  }
  return lines;
}

function renderSuggestedPrBlocks(
  config: FinalizePlan,
  groups: CollectedGroup[],
  results: BranchResult[],
): string[] {
  const lines = ["", "## Suggested PRs", ""];
  if (productGradeFinalizationIssue(config.product_claim_coverage)) {
    lines.push(
      "Experimental review branch only: product-grade proof is missing.",
      "Do not describe this handoff as shippable or merge-ready until the missing proof is recorded.",
      "",
    );
  }
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]!;
    const result = results[i];
    if (!result || result.skipped) continue;
    const files = group.files || [];
    lines.push(
      `### ${i + 1}. ${group.title || "Autoresearch change"}`,
      "",
      `Branch: \`${result.branch}\``,
      "",
      "Suggested PR title:",
      "",
      "```text",
      group.title || "Autoresearch change",
      "```",
      "",
      "Suggested PR body:",
      "",
      "```markdown",
      group.body || "Autoresearch kept change. Review metric evidence and branch diff.",
      "```",
      "",
      "Review commands:",
      "",
      "```bash",
      `git show --stat ${posixQuote(result.branch)}`,
      `git diff ${shortHash(config.base)}..${posixQuote(result.branch)} -- ${quotePathspecs(files)}`,
      "```",
      "",
    );
    if (result.stat) {
      lines.push("Branch stat:", "", "```text", result.stat, "```", "");
    }
  }
  return lines;
}

function renderVerificationText(status: string, error: unknown): string[] {
  const failure = error as Error | null | undefined;
  return [
    "",
    "## Verification",
    "",
    status === "verified"
      ? "- Union verification passed: grouped files match the final tree, excluding autoresearch session artifacts."
      : status === "failed"
        ? `- Verification or branch creation failed: ${markdownEscape(failure?.message || String(error || "unknown error"))}`
        : "- Verification is pending.",
    "- Session artifact verification is preserved: review branches must not contain `autoresearch.*` files or `autoresearch.research/` scratchpads.",
  ];
}

function renderCleanupNotes(config: FinalizePlan, sourceBranch: string): string[] {
  const cleanupTargets = [sourceBranch, ...CLEANUP_SESSION_PATHS].sort((a, b) =>
    a.localeCompare(b),
  );
  const productGradeIssue = productGradeFinalizationIssue(config.product_claim_coverage);
  if (productGradeIssue) {
    return [
      "",
      "## Cleanup After Review",
      "",
      "Cleanup commands are intentionally omitted from this generated summary.",
      "Do not delete source branches or autoresearch artifacts until the experimental review path and missing proof decision have been verified.",
      "",
      `Cleanup targets after accepted review verification: ${cleanupTargets.join(", ")}`,
      "",
      `This file is generated under Git metadata (\`${REPORT_DIRNAME}\`) so it does not dirty the worktree. Remove it when no longer needed.`,
    ];
  }
  return [
    "",
    "## Cleanup After Merge",
    "",
    "Cleanup commands are intentionally omitted from this generated summary.",
    "Do not delete source branches or autoresearch artifacts until the review branches have been merged into trunk and that merge has been verified.",
    "",
    `Cleanup targets after verified merge: ${cleanupTargets.join(", ")}`,
    "",
    `This file is generated under Git metadata (\`${REPORT_DIRNAME}\`) so it does not dirty the worktree. Remove it when no longer needed.`,
  ];
}

function renderRunwayTextForConfig(
  config: FinalizePlan,
  groups: CollectedGroup[],
  results: BranchResult[],
): string[] {
  const fileSet = new Set<string>();
  for (const group of groups) {
    for (const file of group.files || []) fileSet.add(file);
  }
  const productGradeIssue = productGradeFinalizationIssue(config.product_claim_coverage);
  return [
    "",
    "## Finalization Runway",
    "",
    ...(productGradeIssue
      ? [
          "1. Preview groups and risks.",
          "2. Create experimental review branches only.",
          "3. Verify union and session-artifact checks.",
          "4. Add the missing product-grade proof before any merge claim.",
          "5. Cleanup source branches and autoresearch artifacts only after the accepted review path is verified.",
        ]
      : [
          "1. Preview groups and risks.",
          "2. Approve the review branch plan.",
          "3. Create review branches.",
          "4. Verify union and session-artifact checks.",
          "5. Merge the review branches into trunk.",
          "6. Cleanup source branches and autoresearch artifacts only after merge succeeds.",
        ]),
    "",
    `Final file set: ${[...fileSet].sort().join(", ") || "(none)"}`,
    `Review branches created: ${
      results
        .filter((result) => result && !result.skipped)
        .map((result) => result.branch)
        .join(", ") || "(none)"
    }`,
  ];
}

async function writeReviewSummary(file: string, context: ReviewSummaryContext): Promise<void> {
  const { config, groups, results, sourceBranch, status, error } = context;
  const generatedAt = new Date().toISOString();
  const lines = [
    ...renderReviewSummaryHeader({ config, sourceBranch, status, generatedAt }),
    ...renderBranchRows(groups, results),
    ...renderSuggestedPrBlocks(config, groups, results),
    ...renderVerificationText(status, error),
    ...renderRunwayTextForConfig(config, groups, results),
    ...renderCleanupNotes(config, sourceBranch),
  ];

  await fsp.writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

function phaseError(phase: string, error: unknown, hint: string): FinalizePhaseError {
  const original = error instanceof Error ? error : new Error(String(error));
  const message = [
    `Finalize failed during ${phase}.`,
    hint ? `Next step: ${hint}` : "",
    "",
    original.message || String(original),
  ]
    .filter((line: string) => line !== "")
    .join("\n");
  const wrapped = new Error(message) as FinalizePhaseError;
  wrapped.cause = original;
  wrapped.finalizePhase = phase;
  return wrapped;
}

async function withPhase<T>(phase: string, hint: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if ((error as FinalizePhaseError)?.finalizePhase) throw error;
    throw phaseError(phase, error, hint);
  }
}

async function createBranchForGroup(
  config: FinalizePlan,
  group: CollectedGroup,
  index: number,
  cwd: string,
): Promise<BranchResult> {
  const branch = branchName(config, group, index);
  if (!group.files.length) return { branch, skipped: true, deleted: true, stat: "" };
  if (await branchExists(branch, cwd)) {
    return await reuseExistingBranchForGroup(config, group, branch, cwd);
  }
  await git(["switch", "--detach", config.base], cwd);
  await git(["switch", "-c", branch], cwd);
  try {
    await applyGroupSources(group, cwd);
    await git(["add", "-A"], cwd);
    const diff = await git(["diff", "--cached", "--quiet"], cwd, true);
    if (diff.code === 0) {
      await git(["switch", "--detach", config.base], cwd, true);
      await git(["branch", "-D", branch], cwd, true);
      return { branch, skipped: true, deleted: true, stat: "" };
    }
    await git(["commit", "-m", group.title || "Autoresearch change", "-m", group.body || ""], cwd);
    return { branch, skipped: false, deleted: false, stat: await branchStat(branch, cwd) };
  } catch (error) {
    await git(["switch", "--detach", config.base], cwd, true);
    await git(["branch", "-D", branch], cwd, true);
    throw error;
  }
}

async function reuseExistingBranchForGroup(
  config: FinalizePlan,
  group: CollectedGroup,
  branch: string,
  cwd: string,
): Promise<BranchResult> {
  const current = await currentBranch(cwd);
  const branchFiles = await changedFiles(config.base, branch, cwd);
  const sameFiles = sameStringSet(branchFiles, group.files);
  const upstream = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd, true);
  if (current === branch) {
    const runway = classifyFinalizationRunwayFromFacts({
      branch,
      branchExists: true,
      checkedOut: true,
      divergent: !sameFiles,
      equivalent: false,
      localOnly: upstream.code !== 0,
    });
    if (runway.blockers.length > 0) {
      throw new Error(`${runway.status}: ${runway.nextAction}`);
    }
  }
  const contentEquivalent = sameFiles
    ? await existingBranchMatchesPlannedGroup(config, group, branch, cwd)
    : false;
  const runway = classifyFinalizationRunwayFromFacts({
    branch,
    branchExists: true,
    divergent: !sameFiles || !contentEquivalent,
    equivalent: contentEquivalent,
    localOnly: upstream.code !== 0,
  });
  if (runway.blockers.length > 0) {
    throw new Error(`${runway.status}: ${runway.nextAction}`);
  }
  return {
    branch,
    skipped: false,
    deleted: false,
    runway,
    stat: await branchStat(branch, cwd),
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  for (const value of leftSet) {
    if (!rightSet.has(value)) return false;
  }
  return true;
}

async function existingBranchMatchesPlannedGroup(
  config: FinalizePlan,
  group: CollectedGroup,
  branch: string,
  cwd: string,
): Promise<boolean> {
  return await withTemporaryVerificationBranch(
    config,
    cwd,
    `verify-${safeSlug(group.slug || group.title || "group")}`,
    async (verifyBranch) => {
      await applyGroupSources(group, cwd);
      await git(["add", "-A"], cwd);
      await git(["commit", "--allow-empty", "-m", "verify: planned autoresearch group"], cwd);
      const diff = await git(
        ["diff", "--quiet", verifyBranch, branch, "--", ...group.files],
        cwd,
        true,
      );
      return diff.code === 0;
    },
    async () => {
      await git(["switch", "--detach", config.base], cwd, true);
    },
  );
}

async function verifyUnion(
  config: FinalizePlan,
  groups: CollectedGroup[],
  sourceBranch: string,
  createdBranches: string[],
  cwd: string,
): Promise<void> {
  let nonSession: string[] = [];
  await withTemporaryVerificationBranch(
    config,
    cwd,
    "verify-tmp",
    async () => {
      for (const group of groups) {
        await applyGroupSources(group, cwd);
      }
      await git(["add", "-A"], cwd);
      await git(["commit", "--allow-empty", "-m", "verify: union of autoresearch groups"], cwd);
      const diff = await git(["diff", "--name-only", "HEAD", config.final_tree], cwd);
      nonSession = cleanLines(diff.stdout).filter(
        (file) => !isAutoresearchSessionArtifact(file, "finalization"),
      );
    },
    async () => {
      await restoreSourceBranch(sourceBranch, cwd);
    },
  );
  if (nonSession.length > 0) {
    throw new Error(
      `Union of groups differs from final tree:\n${nonSession.join("\n")}\nCreated branches were left intact:\n${createdBranches.join("\n")}`,
    );
  }
}

async function withTemporaryVerificationBranch<T>(
  config: FinalizePlan,
  cwd: string,
  suffix: string,
  runOnBranch: (verifyBranch: string) => Promise<T>,
  restoreAfter: () => Promise<void>,
): Promise<T> {
  const verifyBranch = `autoresearch-review/${safeSlug(config.goal)}/${suffix}`;
  if (await branchExists(verifyBranch, cwd)) {
    await git(["branch", "-D", verifyBranch], cwd, true);
  }
  try {
    await git(["switch", "--detach", config.base], cwd);
    await git(["switch", "-c", verifyBranch], cwd);
    return await runOnBranch(verifyBranch);
  } finally {
    try {
      await restoreAfter();
    } finally {
      await git(["branch", "-D", verifyBranch], cwd, true);
    }
  }
}

async function verifyNoSessionArtifacts(
  createdBranches: string[],
  cwd: string,
  excludeSessionArtifacts = true,
): Promise<void> {
  if (!excludeSessionArtifacts) return;
  for (const branch of createdBranches) {
    const result = await git(["diff-tree", "--no-commit-id", "--name-only", "-r", branch], cwd);
    const sessionFiles = cleanLines(result.stdout).filter((file) =>
      isAutoresearchSessionArtifact(file, "finalization"),
    );
    if (sessionFiles.length > 0) {
      throw new Error(`Session artifact found in ${branch}: ${sessionFiles.join(", ")}`);
    }
  }
}

async function draftGroupsPlan(args: CliArgs, cwd: string): Promise<FinalizePlan> {
  const trunk = args.trunk || "main";
  const sourceBranch = await currentBranch(cwd);
  if (!sourceBranch)
    throw new Error("Detached HEAD. Switch to the autoresearch branch before planning.");
  const base = (await git(["merge-base", trunk, "HEAD"], cwd)).stdout.trim();
  const finalTree = await fullHash("HEAD", cwd);
  const goal = safeSlug(args.goal || sourceBranch.replace(/^.*\//, "") || "autoresearch");
  const history = await commitHistory(base, cwd);
  const entries = await readAutoresearchJsonl(cwd);
  const keptRuns = entries.filter(isAcceptedCurrentRun);
  const productClaimCoverage = buildFinalizationProductClaimCoverageFromLedger(entries);
  const productGradeIssue = productGradeFinalizationIssue(productClaimCoverage);
  const groups: PlanGroup[] = [];
  const excludedCommits: ExcludedCommit[] = [];
  const selectedCommits = new Set<string>();
  for (const item of history) {
    const selectedRun = runEvidenceForCommit(entries, item.hash);
    if (!selectedRun) {
      const sourceEntry = parseCommitStatus(entries, item.hash);
      excludedCommits.push({
        commit: item.hash,
        subject: item.subject || "",
        status: describeCommitStatus(sourceEntry),
      });
      continue;
    }
    selectedCommits.add(item.hash);
    const parent = item.parents[0] || base;
    const files = await changedFiles(parent, item.hash, cwd);
    groups.push({
      title: item.subject || selectedRun.description || `Autoresearch change ${groups.length + 1}`,
      body: draftBodyForCommit(selectedRun),
      last_commit: item.hash,
      slug: safeSlug(item.subject || selectedRun.description || `change-${groups.length + 1}`),
      parent_commit: parent,
      files,
    });
  }
  const overlapAnalysis = analyzeGroupOverlap(groups);
  const plan = {
    source_branch: sourceBranch,
    planned_at: new Date().toISOString(),
    base,
    trunk,
    final_tree: finalTree,
    goal,
    kept_commits: [...selectedCommits],
    kept_run_count: keptRuns.length,
    excluded_commits: excludedCommits,
    excluded_commit_count: excludedCommits.length,
    overlap_files: overlapAnalysis.files,
    overlap_count: overlapAnalysis.files.length,
    collapse_overlap_recommended: overlapAnalysis.files.length > 0,
    warnings: buildPlanWarnings({ excludedCommits, overlapAnalysis }),
    product_claim_coverage: productClaimCoverage,
    product_grade_ready: productClaimCoverage.productGradeReady,
    product_grade_issue: productGradeIssue,
    product_grade_summary: productGradeIssue
      ? "Experimental review branch only: product-grade proof is missing."
      : "Product-grade proof is complete for the recorded claim coverage.",
    groups,
  };
  return {
    ...plan,
    plan_fingerprint: planFingerprint(plan),
  };
}

async function collapseOverlappingDraftGroups(
  plan: FinalizePlan,
  cwd: string,
): Promise<FinalizePlan> {
  if (plan.groups.length <= 1) return plan;
  const overlapping = new Set(plan.overlap_files || []);
  if (overlapping.size === 0) return plan;
  const lastGroup = plan.groups.at(-1)!;
  const overlapList = [...overlapping].sort().slice(0, 12);
  const sourceGroups = await collectSourceGroups(
    plan.groups.map((group) => ({
      title: group.title,
      slug: group.slug,
      last_commit: group.last_commit,
      parent_commit: group.parent_commit,
      files: group.files || [],
    })),
    plan,
    cwd,
  );
  const files = normalizePlanFiles(
    sourceGroups.flatMap((group) => group.files || []),
    cwd,
  );
  return {
    ...plan,
    groups: [
      {
        title: `Consolidated ${plan.goal} changes`,
        body: [
          "Autoresearch kept changes were collapsed into one review branch because multiple kept commits touched the same files.",
          "",
          `Overlapping files: ${overlapList.join(", ")}${overlapping.size > overlapList.length ? ", ..." : ""}`,
        ].join("\n"),
        last_commit: lastGroup.last_commit,
        parent_commit: plan.base,
        files,
        source_groups: sourceGroups,
        slug: safeSlug(`${plan.goal}-changes`),
        collapsed: true,
      },
    ],
  };
}

async function writeDraftPlan(args: CliArgs, cwd: string): Promise<FinalizePlan> {
  let plan = await draftGroupsPlan(args, cwd);
  if (args.collapseOverlap) {
    plan = await collapseOverlappingDraftGroups(plan, cwd);
  }
  plan = { ...plan, plan_fingerprint: planFingerprint(plan) };
  const output = args.output
    ? resolveCliPath(args.output, cwd)
    : path.join(await gitCommonDir(cwd), REPORT_DIRNAME, `${safeSlug(plan.goal)}.groups.json`);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(`Wrote draft groups: ${output}`);
  console.log(`Groups: ${plan.groups.length}`);
  console.log(`Selected kept commits: ${plan.kept_commits.length}`);
  if (plan.excluded_commit_count > 0) {
    const excludedCommits = plan.excluded_commits || [];
    console.log(`Excluded commits: ${plan.excluded_commit_count}`);
    console.log("Excluded commits were flagged and omitted from finalization planning.");
    for (const item of excludedCommits.slice(0, 5)) {
      const parts = [shortHash(item.commit), item.status];
      if (item.subject) parts.push(item.subject);
      console.log(`  - ${parts.join(" ")}`);
    }
    if (excludedCommits.length > 5) console.log("  - ...");
  }
  if (plan.collapse_overlap_recommended && !args.collapseOverlap) {
    console.log("Hint: rerun with --collapse-overlap to consolidate overlapping kept commits.");
  }
  if (productGradeFinalizationIssue(plan.product_claim_coverage)) {
    console.log("Experimental review branch only: product-grade proof is missing.");
  }
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
  const cwd = resolveFinalizerCwd(cli);
  if (command === "plan") {
    await withPhase(
      "plan generation",
      "Fix autoresearch.jsonl and rerun finalizer plan.",
      async () => {
        await writeDraftPlan(cli, cwd);
      },
    );
    return;
  }
  const configPath = resolveCliPath(file, cwd);
  let config = await withPhase("configuration", "Fix groups.json and retry.", async () => {
    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    if (!parsed.base || !parsed.final_tree || !parsed.goal || !Array.isArray(parsed.groups)) {
      throw new Error("groups.json is missing base, final_tree, goal, or groups.");
    }
    parsed.trunk = parsed.trunk || "main";
    parsed.base = await fullHash(parsed.base, cwd);
    parsed.final_tree = await fullHash(parsed.final_tree, cwd);
    return parsed as FinalizePlan;
  });
  config = await hydratePlanProductClaimCoverage(config, cwd);

  const sourceBranch = await withPhase(
    "preflight",
    "Switch to a clean autoresearch source branch, then rerun finalization.",
    async () => {
      const branch = await currentBranch(cwd);
      if (!branch) throw new Error("Detached HEAD. Switch to the autoresearch branch first.");
      if (branch === config.trunk)
        throw new Error(`On trunk (${config.trunk}). Switch to the autoresearch branch first.`);
      if (await isDirty(cwd))
        throw new Error(
          "Working tree is dirty. Commit, stash, or clean changes before finalizing.",
        );
      if (config.source_branch && branch !== config.source_branch)
        throw new Error(
          `Stale finalization plan: current branch is ${branch}, but plan was created for ${config.source_branch}. Rerun finalizer plan.`,
        );
      const currentHead = await fullHash("HEAD", cwd);
      if (currentHead !== config.final_tree)
        throw new Error(
          "Stale finalization plan: current HEAD differs from planned final_tree. Rerun finalizer plan.",
        );
      const currentBase = (await git(["merge-base", config.trunk, "HEAD"], cwd)).stdout.trim();
      if (currentBase !== config.base)
        throw new Error(
          "Stale finalization plan: trunk merge-base differs from planned base. Rerun finalizer plan.",
        );
      assertGeneratedPlanMetadata(config);
      if (config.plan_fingerprint && config.plan_fingerprint !== planFingerprint(config))
        throw new Error(
          "Stale finalization plan: plan fingerprint does not match contents. Rerun finalizer plan.",
        );
      return branch;
    },
  );

  const groups = await withPhase(
    "group analysis",
    "Merge overlapping groups or correct the kept commit order in groups.json.",
    async () => {
      return await collectGroups(config, cwd);
    },
  );

  const created: string[] = [];
  const results: BranchResult[] = [];
  let summaryPath = "";
  try {
    await withPhase(
      "branch creation",
      "Delete or rename any conflicting autoresearch-review branches, then retry.",
      async () => {
        for (let i = 0; i < groups.length; i += 1) {
          const result = await createBranchForGroup(config, groups[i], i, cwd);
          results.push(result);
          if (!result.skipped) created.push(result.branch);
          console.log(`${String(i + 1).padStart(2, "0")}. ${groups[i].title}`);
          console.log(`    branch: ${result.branch}${result.skipped ? " (skipped empty)" : ""}`);
          console.log(`    files: ${groups[i].files.join(", ") || "(none)"}`);
        }
      },
    );
  } catch (error) {
    for (const branch of created) {
      await git(["branch", "-D", branch], cwd, true);
    }
    await restoreSourceBranch(sourceBranch, cwd);
    throw error;
  }

  summaryPath = await reviewSummaryPath(config, cwd);
  await writeReviewSummary(summaryPath, {
    config,
    groups,
    results,
    sourceBranch,
    status: "pending",
  });
  console.log("");
  console.log(`Review summary: ${summaryPath}`);

  try {
    await withPhase(
      "union verification",
      "Inspect the generated review summary and the listed file differences before changing groups.json.",
      async () => {
        await verifyUnion(config, groups, sourceBranch, created, cwd);
      },
    );
    await withPhase(
      "session artifact verification",
      "Remove autoresearch.* files from review branches, then rerun finalization.",
      async () => {
        await verifyNoSessionArtifacts(created, cwd, planExcludesSessionArtifacts(config));
      },
    );
    await restoreSourceBranch(sourceBranch, cwd);
    await writeReviewSummary(summaryPath, {
      config,
      groups,
      results,
      sourceBranch,
      status: "verified",
    });
  } catch (error) {
    await restoreSourceBranch(sourceBranch, cwd);
    await writeReviewSummary(summaryPath, {
      config,
      groups,
      results,
      sourceBranch,
      status: "failed",
      error,
    });
    console.error("");
    console.error(`Review summary: ${summaryPath}`);
    throw error;
  }

  console.log("");
  console.log("Created review branches:");
  for (const branch of created) console.log(`  ${branch}`);
  console.log("");
  if (productGradeFinalizationIssue(config.product_claim_coverage)) {
    console.log("Experimental review branch only: product-grade proof is missing.");
    console.log(
      "Runway: preview -> create experimental review branch -> verify -> add proof before merge claim.",
    );
    console.log("Cleanup after accepted review path verification:");
  } else {
    console.log(
      "Runway: preview -> approve -> create review branch -> verify -> merge -> cleanup.",
    );
    console.log("Cleanup after verified merge:");
  }
  console.log(
    "  Source branch and session-artifact cleanup commands are intentionally omitted here.",
  );
  console.log("  Use the generated review summary after trunk merge verification succeeds.");
}

function planFingerprint(plan: FinalizePlan): string {
  return finalizationPlanFingerprint(plan);
}

async function hydratePlanProductClaimCoverage(
  config: FinalizePlan,
  cwd: string,
): Promise<FinalizePlan> {
  const entries = await readAutoresearchJsonl(cwd);
  const derived = buildFinalizationProductClaimCoverageFromLedger(entries);
  const productGradeIssue = productGradeFinalizationIssue(derived);
  if (!config.product_claim_coverage) {
    return {
      ...config,
      product_claim_coverage: derived,
      product_grade_ready: derived.productGradeReady,
      product_grade_issue: productGradeIssue,
      product_grade_summary: productGradeIssue
        ? "Experimental review branch only: product-grade proof is missing."
        : "Product-grade proof is complete for the recorded claim coverage.",
    };
  }
  await assertPlanProductClaimCoverage(config, cwd);
  return config;
}

async function assertPlanProductClaimCoverage(config: FinalizePlan, cwd: string): Promise<void> {
  const entries = await readAutoresearchJsonl(cwd);
  const derived = buildFinalizationProductClaimCoverageFromLedger(entries);
  const planned = config.product_claim_coverage;
  if (!planned) return;
  if (Boolean(planned.productGradeReady) !== derived.productGradeReady) {
    throw new Error(
      "Stale finalization plan: product claim coverage does not match the session ledger. Rerun finalizer plan.",
    );
  }
  const plannedMissing = new Set(
    (Array.isArray(planned.missingRequiredProof) ? planned.missingRequiredProof : [])
      .map((item) => String(item?.id || "").trim())
      .filter(Boolean),
  );
  const derivedMissing = new Set(derived.missingRequiredProof.map((item) => item.id));
  if (plannedMissing.size !== derivedMissing.size) {
    throw new Error(
      "Stale finalization plan: product claim coverage does not match the session ledger. Rerun finalizer plan.",
    );
  }
  for (const id of plannedMissing) {
    if (!derivedMissing.has(id)) {
      throw new Error(
        "Stale finalization plan: product claim coverage does not match the session ledger. Rerun finalizer plan.",
      );
    }
  }
}

function analyzeGroupOverlap(groups: PlanGroup[]): OverlapAnalysis {
  if (!Array.isArray(groups) || groups.length <= 1) {
    return { files: [], groups: [] };
  }
  const seen = new Map<string, string>();
  const overlappingFiles = new Set<string>();
  const overlappingGroups = new Set<string>();
  for (const group of groups) {
    for (const file of group.files || []) {
      if (seen.has(file)) {
        const firstGroup = seen.get(file)!;
        overlappingFiles.add(file);
        overlappingGroups.add(firstGroup);
        overlappingGroups.add(group.last_commit);
      } else {
        seen.set(file, group.last_commit);
      }
    }
  }
  return {
    files: [...overlappingFiles],
    groups: [...overlappingGroups],
  };
}

function buildPlanWarnings({
  excludedCommits,
  overlapAnalysis,
}: {
  excludedCommits: ExcludedCommit[];
  overlapAnalysis: OverlapAnalysis;
}): string[] {
  const warnings: string[] = [];
  if (excludedCommits.length > 0) {
    const sample = excludedCommits
      .slice(0, 3)
      .map(
        (item) =>
          `${shortHash(item.commit)} ${item.status}${item.subject ? ` ${item.subject}` : ""}`,
      );
    warnings.push(
      `Excluded ${excludedCommits.length} unkept commit${excludedCommits.length === 1 ? "" : "s"} from base..HEAD: ${sample.join(", ")}${excludedCommits.length > sample.length ? ", ..." : ""}.`,
    );
  }
  if (overlapAnalysis.files.length > 0) {
    warnings.push(
      `Kept commits overlap on ${overlapAnalysis.files.length} file${overlapAnalysis.files.length === 1 ? "" : "s"}; rerun with --collapse-overlap to consolidate them.`,
    );
  }
  return warnings;
}

function posixQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

main().catch((error: unknown) => {
  const failure = error as FinalizePhaseError;
  console.error(failure.stack || failure.message || String(failure));
  process.exitCode = 1;
});
