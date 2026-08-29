import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { renderShellCommand } from "./command-rendering.js";
import { isAcceptedCurrentRun } from "./evidence-registry.js";
import { productGradeFinalizationIssue } from "./finalization-acceptance.js";
import {
  blockedFinalizationDecisionFact,
  buildFinalizationDecisionFact,
  type FinalizationDecisionFact,
} from "./finalization-decision-fact.js";
import { classifyFinalizationRunwayFromFacts } from "./finalization-runway.js";
import { parseNameStatusZ } from "./git-paths.js";
import {
  buildFinalizationEvidenceState,
  commitReferencesMatch,
  finalizationPlanFingerprint,
  readAutoresearchLedger,
} from "./finalization-plan.js";
import { buildFinalizationProductClaimCoverageFromLedger } from "./product-claim-coverage.js";
import { resolvePackageRoot } from "./runtime-paths.js";
import { isAutoresearchSessionArtifact } from "./session-artifacts.js";
import { readActiveSessionDecisionCapsule } from "./session-decision-capsule.js";
import { loadCanonicalSessionDecision } from "./session-decision.js";
import { projectCompactDecisionPlan, projectResolvedDecision } from "./decision-projection.js";

const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const FINALIZATION_GIT_PROBE_CONCURRENCY = 4;
type LooseObject = Record<string, any>;
type GitResult = { code: number | null; ok?: boolean; stderr: string; stdout: string };
type ProgressKind = "finalize-preview" | "finalize-current-tree";
type KeptRun = LooseObject & {
  run: number;
  commit?: string;
  description?: string;
  metric?: unknown;
  asi?: LooseObject;
};
type RunGroup = LooseObject & {
  title: string;
  run: number;
  commit: string;
  shortCommit: string;
  files: string[];
  metric?: unknown;
  asi: LooseObject;
  slug: string;
};
type CommitSummary = {
  commit: string;
  shortCommit: string;
  subject: string;
  files: string[];
};
type CurrentTreeFileSelection = {
  allFiles: string[];
  excludedSessionArtifacts: string[];
  includedFiles: string[];
};
type FinalTreePlan = LooseObject & {
  warnings: string[];
  base: string;
  baseOk: boolean | undefined;
  excludedCommits: CommitSummary[];
  missingFinalTreeFiles: string[];
  excludedPlannedFileConflicts: CommitSummary[];
  finalTreeCoverage: LooseObject;
};

export async function finalizePreview(args: LooseObject) {
  const startedAt = Date.now();
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const trunk = args.trunk || "main";
  emitProgress(args, "finalize-preview", `checking Git state in ${workDir}`);
  const inside = await gitOk(["rev-parse", "--is-inside-work-tree"], workDir);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    captureFinalizationDecisionFact(args, blockedFinalizationDecisionFact());
    return await withProgress(
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
      "finalize-preview",
      args.canonicalDecisionProjection !== false,
    );
  }

  const branch = (await git(["branch", "--show-current"], workDir)).stdout.trim();
  const dirty = (await git(["status", "--porcelain=v1", "-z"], workDir)).stdout;
  emitProgress(args, "finalize-preview", "reading autoresearch ledger and kept commits");
  const ledgerEntries = Array.isArray(args.capturedRecords)
    ? args.capturedRecords
    : await readLedgerEntries(workDir);
  const ledgerRuns = ledgerEntries.filter((entry: LooseObject) => entry.run != null) as KeptRun[];
  const keptRuns = ledgerEntries.filter(isAcceptedCurrentRun) as KeptRun[];
  const productClaimCoverage = buildFinalizationProductClaimCoverageFromLedger(ledgerEntries);
  const productGradeIssue = productGradeFinalizationIssue(productClaimCoverage);
  const sessionDecisionCapsule = readActiveSessionDecisionCapsule(workDir, ledgerEntries);
  const { groups, missingCommitCount, warnings } = await buildKeptRunGroups(workDir, keptRuns);
  const finalizationRunway = await buildFinalizationRunwaySummary({
    workDir,
    sourceBranch: branch,
    groups,
  });
  const overlaps = findGroupFileOverlaps(groups);
  emitProgress(args, "finalize-preview", "checking current final tree coverage");
  const finalTreePlan = await buildFinalTreePlan(workDir, trunk, groups);
  warnings.push(...finalTreePlan.warnings);
  const semanticSafety = await buildSemanticSafety({
    workDir,
    groups,
    ledgerRuns,
    base: finalTreePlan.base,
  });
  emitProgress(args, "finalize-preview", "building finalization recommendation");
  appendFinalTreeWarnings(warnings, finalTreePlan);
  warnings.push(...semanticSafety.blockers.map((blocker) => blocker.message));
  if (productGradeIssue) warnings.push(productGradeIssue);
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
    "--cwd",
    workDir,
    "--output",
    planOutput,
    "--goal",
    safeSlug(branch || "autoresearch"),
    "--trunk",
    trunk,
  ];
  const nextAction = finalizePreviewNextAction({
    ready,
    productGradeIssue,
    semanticSafety,
    excludedPlannedFileConflicts: finalTreePlan.excludedPlannedFileConflicts,
    finalTreeCoverage: finalTreePlan.finalTreeCoverage,
    excludedCommits: finalTreePlan.excludedCommits,
    groups,
    keptRuns,
    missingCommitCount,
  });
  const actionCode = finalizePreviewActionCode({
    ready,
    semanticSafety,
    excludedPlannedFileConflicts: finalTreePlan.excludedPlannedFileConflicts,
    finalTreeCoverage: finalTreePlan.finalTreeCoverage,
    excludedCommits: finalTreePlan.excludedCommits,
    groups,
    keptRuns,
    missingCommitCount,
  });
  captureFinalizationDecisionFact(
    args,
    buildFinalizationDecisionFact({
      ready,
      currentTreeRecovery: actionCode === "current-tree-finalization",
      acceptedEvidenceCount: groups.length,
    }),
  );
  return await withProgress(
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
      excludedPlannedFileConflicts: finalTreePlan.excludedPlannedFileConflicts,
      finalTreeCoverage: finalTreePlan.finalTreeCoverage,
      semanticSafety,
      productClaimCoverage,
      finalizationRunway,
      productGradeReady: productClaimCoverage.productGradeReady,
      productGradeIssue,
      sessionDecisionCapsule,
      overlaps,
      warnings,
      blockers: [
        ...semanticSafety.blockers.map((blocker) => blocker.message),
        ...(productGradeIssue ? [productGradeIssue] : []),
        ...finalizationRunway.blockers,
      ],
      summary: productGradeIssue
        ? "Experimental review branch only: product-grade proof is missing."
        : ready
          ? "Review branch preview is ready."
          : "Finalization preview is blocked.",
      suggestedCommand: renderShellCommand(planArgv),
      suggestedCommands: {
        finalizerPlan: {
          argv: planArgv,
          cwd: workDir,
          display: renderShellCommand(planArgv),
          purpose: "Write a review-branch plan without dirtying the source branch.",
          mutates: false,
        },
      },
      nextAction,
      actionCode,
    },
    startedAt,
    ready ? "completed" : "blocked",
    "finalize-preview",
    args.canonicalDecisionProjection !== false,
  );
}

function captureFinalizationDecisionFact(args: LooseObject, fact: FinalizationDecisionFact): void {
  const capture = args.captureCanonicalDecisionFact;
  if (typeof capture === "function") capture(fact);
}

async function buildFinalizationRunwaySummary({
  workDir,
  sourceBranch,
  groups,
}: {
  groups: RunGroup[];
  sourceBranch: string;
  workDir: string;
}): Promise<LooseObject> {
  const goal = safeSlug(sourceBranch || "autoresearch");
  const branches = await mapWithConcurrency(
    groups,
    FINALIZATION_GIT_PROBE_CONCURRENCY,
    async (group, index) => {
      const branch = reviewBranchName(goal, group, index);
      const exists = (await gitOk(["rev-parse", "--verify", branch], workDir)).ok;
      const upstream = exists
        ? await gitOk(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], workDir)
        : { ok: false, stdout: "", stderr: "", code: 1 };
      return classifyFinalizationRunwayFromFacts({
        branch,
        branchExists: exists,
        equivalent: false,
        localOnly: exists && !upstream.ok,
      });
    },
  );
  const blockers = branches.flatMap((branch) => branch.blockers || []);
  const warnings = branches.flatMap((branch) => branch.warnings || []);
  const localOnly = branches.find((branch) => branch.status === "local-only");
  const unverified = branches.find((branch) => branch.status === "unverified");
  const unsafe = branches.find((branch) => (branch.blockers || []).length > 0);
  const missing = branches.find((branch) => branch.status === "missing");
  return {
    status: unsafe?.status || localOnly?.status || unverified?.status || missing?.status || "ready",
    branches,
    blockers,
    warnings,
    nextAction:
      unsafe?.nextAction ||
      localOnly?.nextAction ||
      unverified?.nextAction ||
      missing?.nextAction ||
      "Preview is ready; create review branches, then push or open PRs before merge claims.",
  };
}

function reviewBranchName(goal: string, group: RunGroup, index: number): string {
  const number = String(index + 1).padStart(2, "0");
  return `autoresearch-review/${goal}/${number}-${safeSlug(group.slug || group.title || "change")}`;
}

async function buildKeptRunGroups(workDir: string, keptRuns: KeptRun[]) {
  const groups: RunGroup[] = [];
  const warnings: string[] = [];
  let missingCommitCount = 0;
  const results = await mapWithConcurrency(
    keptRuns,
    FINALIZATION_GIT_PROBE_CONCURRENCY,
    async (run) => {
      const commit = String(run.commit || "");
      if (!commit) return { missingCommit: true };
      const full = await gitOk(["rev-parse", commit], workDir);
      if (!full.ok)
        return {
          warning: `Kept run #${run.run} commit ${commit} could not be resolved.`,
        };
      const hash = full.stdout.trim();
      const files = await changedFilesForCommit(hash, workDir);
      return {
        group: {
          title: run.description || `Autoresearch run #${run.run}`,
          run: run.run,
          commit: hash,
          shortCommit: hash.slice(0, 12),
          files,
          metric: run.metric,
          asi: run.asi || {},
          slug: safeSlug(run.description || `run-${run.run}`),
        },
      };
    },
  );
  for (const result of results) {
    if (result.missingCommit) missingCommitCount += 1;
    if (result.warning) warnings.push(result.warning);
    if (result.group) groups.push(result.group);
  }
  return { groups, missingCommitCount, warnings };
}

function findGroupFileOverlaps(groups: RunGroup[]) {
  const seen = new Map<string, number>();
  const overlaps: Array<{ file: string; first: number; second: number }> = [];
  for (const group of groups) {
    for (const file of group.files) {
      const first = seen.get(file);
      if (first !== undefined) overlaps.push({ file, first, second: group.run });
      else seen.set(file, group.run);
    }
  }
  return overlaps;
}

async function buildFinalTreePlan(
  workDir: string,
  trunk: string,
  groups: RunGroup[],
): Promise<FinalTreePlan> {
  const warnings: string[] = [];
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

function plannedFilesForGroups(groups: RunGroup[]): string[] {
  const planned = new Set<string>();
  for (const group of groups) {
    for (const file of group.files || []) planned.add(file);
  }
  return [...planned].sort((a, b) => a.localeCompare(b));
}

function appendFinalTreeWarnings(warnings: string[], finalTreePlan: FinalTreePlan): void {
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

function appendSourceBranchWarnings(
  warnings: string[],
  {
    dirty,
    branch,
    trunk,
    overlaps,
  }: {
    dirty: string;
    branch: string;
    trunk: string;
    overlaps: Array<{ file: string; first: number; second: number }>;
  },
): void {
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
}: LooseObject): boolean {
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
  productGradeIssue = null,
  semanticSafety,
  excludedPlannedFileConflicts,
  finalTreeCoverage,
  excludedCommits,
  groups,
  keptRuns,
  missingCommitCount,
}: LooseObject): string {
  if (ready) {
    return productGradeIssue
      ? "Review the preview as an experimental review branch only; product-grade proof is missing, then run the suggested finalizer plan command."
      : "Review the preview, then run the suggested finalizer plan command.";
  }
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

function finalizePreviewActionCode({
  ready,
  semanticSafety,
  excludedPlannedFileConflicts,
  finalTreeCoverage,
  excludedCommits,
  groups,
  keptRuns,
  missingCommitCount,
}: LooseObject): string {
  if (ready) return "finalization-preview-ready";
  if (!semanticSafety.ok) return "semantic-safety";
  if (excludedPlannedFileConflicts.length || !finalTreeCoverage.covered) {
    return "current-tree-finalization";
  }
  if (excludedCommits.length) return "review-excluded-history";
  if (groups.length === 0 && keptRuns.length > 0 && missingCommitCount === keptRuns.length) {
    return "commit-backed-keep-required";
  }
  return "preview-warning";
}

export async function finalizeCurrentTree(args: LooseObject) {
  const startedAt = Date.now();
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const trunk = args.trunk || "main";
  emitProgress(args, "finalize-current-tree", `checking current tree in ${workDir}`);
  const includeSessionArtifacts = Boolean(
    args.include_session_artifacts ?? args.includeSessionArtifacts ?? false,
  );
  const excludeSessionArtifacts = includeSessionArtifacts
    ? false
    : (args.exclude_session_artifacts ?? args.excludeSessionArtifacts ?? true);
  const inside = await gitOk(["rev-parse", "--is-inside-work-tree"], workDir);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return await withProgress(
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
      "finalize-current-tree",
    );
  }
  const branch = (await git(["branch", "--show-current"], workDir)).stdout.trim();
  const baseResult = await gitOk(["merge-base", trunk, "HEAD"], workDir);
  const warnings: string[] = [];
  if (!baseResult.ok) warnings.push(`Could not find merge-base with ${trunk}.`);
  const base = baseResult.ok ? baseResult.stdout.trim() : "";
  const finalTree = (await git(["rev-parse", "HEAD"], workDir)).stdout.trim();
  const allFiles = base ? await changedFilesBetween(base, "HEAD", workDir, false) : [];
  emitProgress(args, "finalize-current-tree", "classifying session artifacts and review files");
  const fileSelection = selectCurrentTreeFiles(allFiles, Boolean(excludeSessionArtifacts));
  const files = fileSelection.includedFiles;
  const dirty = (await git(["status", "--porcelain=v1", "-z"], workDir)).stdout;
  if (dirty)
    warnings.push("Working tree is dirty; current-tree plan requires a clean source branch.");
  if (!branch)
    warnings.push("Detached HEAD; switch to the autoresearch source branch before planning.");
  if (branch === trunk) warnings.push(`On trunk (${trunk}); switch to the source branch first.`);
  if (!files.length) warnings.push("No current non-session branch diff files were found.");

  const ready = Boolean(base && branch && branch !== trunk && !dirty && files.length);
  const planOutput = await defaultCurrentTreePlanOutput(workDir, branch || "autoresearch");
  const ledgerEntries = await readLedgerEntries(workDir);
  const commitOrder = base ? await commitHashesBetween(base, "HEAD", workDir) : [];
  const evidenceState = buildFinalizationEvidenceState(commitOrder, ledgerEntries);
  const productClaimCoverage = evidenceState.productClaimCoverage;
  const productGradeIssue = productGradeFinalizationIssue(productClaimCoverage);
  const currentTreeFingerprint = currentTreeFingerprintFor({
    base,
    finalTree,
    excludeSessionArtifacts: Boolean(excludeSessionArtifacts),
    fileSelection,
  });
  const plan: LooseObject = {
    mode: "current-final-tree",
    source_branch: branch,
    planned_at: new Date().toISOString(),
    base,
    trunk,
    final_tree: finalTree,
    goal: safeSlug(branch || "autoresearch"),
    kept_commits: [] as string[],
    kept_run_count: 0,
    excluded_commits: [] as CommitSummary[],
    excluded_commit_count: 0,
    overlap_files: [] as string[],
    accepted_evidence_fingerprint: evidenceState.fingerprint,
    current_tree_coverage: {
      covered: ready,
      review_unit: "current_tree",
      review_unit_message:
        "Current-tree finalization packages the current branch tree, not older kept commits, as the review unit.",
      file_count: files.length,
      all_file_count: fileSelection.allFiles.length,
      exclude_session_artifacts: Boolean(excludeSessionArtifacts),
      include_session_artifacts: includeSessionArtifacts,
      included_files: files,
      excluded_session_artifacts: fileSelection.excludedSessionArtifacts,
      current_tree_fingerprint: currentTreeFingerprint,
    },
    product_claim_coverage: productClaimCoverage,
    product_grade_ready: productClaimCoverage.productGradeReady,
    product_grade_issue: productGradeIssue,
    product_grade_summary: productGradeIssue
      ? "Experimental review branch only: product-grade proof is missing."
      : "Product-grade proof is complete for the recorded claim coverage.",
    groups: [
      {
        title: `Current final tree for ${branch || "autoresearch"}`,
        body: "Packages the current branch tree as the review unit, not older kept commits, when commit-level kept evidence is stale or incomplete.",
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
  if (ready) {
    emitProgress(args, "finalize-current-tree", `writing plan to ${planOutput}`);
    await fsp.mkdir(path.dirname(planOutput), { recursive: true });
    await fsp.writeFile(planOutput, `${JSON.stringify(planWithFingerprint, null, 2)}\n`, "utf8");
  }
  return await withProgress(
    {
      ok: true,
      workDir,
      trunk,
      branch,
      base,
      finalTree,
      ready,
      files,
      includedFiles: files,
      excludedFiles: fileSelection.excludedSessionArtifacts,
      allFiles: fileSelection.allFiles,
      planOutput: ready ? planOutput : "",
      planFingerprint: ready ? planWithFingerprint.plan_fingerprint : "",
      currentTreeFingerprint,
      reviewUnit: {
        mode: "current_tree",
        message:
          "Current-tree finalization packages the current branch tree, not older kept commits, as the review unit.",
      },
      currentTreeCoverage: {
        covered: ready,
        files,
        includedFiles: files,
        excludedFiles: fileSelection.excludedSessionArtifacts,
        fileCount: files.length,
        allFileCount: fileSelection.allFiles.length,
        excludeSessionArtifacts: Boolean(excludeSessionArtifacts),
        includeSessionArtifacts,
        currentTreeFingerprint,
      },
      warnings,
      nextAction: ready
        ? "Review the current-final-tree plan, then run the finalizer with that plan file."
        : "Resolve current-tree finalization warnings before running the finalizer.",
    },
    startedAt,
    ready ? "completed" : "blocked",
    "finalize-current-tree",
  );
}

function emitProgress(args: LooseObject, stage: string, message: string): void {
  if (args.progress !== true && args.progress_stderr !== true && args.progressStderr !== true) {
    return;
  }
  process.stderr.write(`[autoresearch:${stage}] ${message}\n`);
}

function selectCurrentTreeFiles(
  allFiles: string[],
  excludeSessionArtifacts: boolean,
): CurrentTreeFileSelection {
  const excludedSessionArtifacts = excludeSessionArtifacts
    ? allFiles.filter((file) => isAutoresearchSessionArtifact(file, "source-checkout"))
    : [];
  const includedFiles = excludeSessionArtifacts
    ? allFiles.filter((file) => !isAutoresearchSessionArtifact(file, "source-checkout"))
    : [...allFiles];
  return {
    allFiles: [...allFiles],
    excludedSessionArtifacts,
    includedFiles,
  };
}

function currentTreeFingerprintFor({
  base,
  finalTree,
  excludeSessionArtifacts,
  fileSelection,
}: {
  base: string;
  excludeSessionArtifacts: boolean;
  fileSelection: CurrentTreeFileSelection;
  finalTree: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        base,
        finalTree,
        excludeSessionArtifacts,
        includedFiles: fileSelection.includedFiles,
        excludedSessionArtifacts: fileSelection.excludedSessionArtifacts,
      }),
    )
    .digest("hex");
}

async function defaultPlanOutput(workDir: string, branch: string): Promise<string> {
  const gitPath = await gitOk(
    ["rev-parse", "--git-path", `autoresearch-finalize/${safeSlug(branch)}.groups.json`],
    workDir,
  );
  if (gitPath.ok && gitPath.stdout.trim()) return path.resolve(workDir, gitPath.stdout.trim());
  return path.join(workDir, ".git", "autoresearch-finalize", `${safeSlug(branch)}.groups.json`);
}

async function defaultCurrentTreePlanOutput(workDir: string, branch: string): Promise<string> {
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

async function withProgress(
  result: LooseObject,
  startedAt: number,
  status: string,
  kind: ProgressKind = "finalize-preview",
  projectDecision = true,
): Promise<LooseObject> {
  const durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(3));
  const label =
    kind === "finalize-current-tree"
      ? "Preview current final tree review unit"
      : "Preview review branch readiness";
  const decision = projectDecision
    ? await loadCanonicalSessionDecision({
        requestedCwd: String(result.workDir || process.cwd()),
        facts: { finalization: result },
      })
    : null;
  return {
    ...result,
    ...(decision?.ok
      ? { decisionPlanProjection: projectCompactDecisionPlan(decision.plan) }
      : decision
        ? { snapshotDiagnostic: decision.diagnostic }
        : {}),
    ...(decision?.ok ? { resolvedDecision: projectResolvedDecision(decision.plan) } : {}),
    progress: {
      mode: "synchronous",
      status,
      cancellable: false,
      cancelStatus: "not_requested",
      elapsedSeconds: durationSeconds,
      stages: [
        {
          stage: kind,
          label,
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

async function readLedgerEntries(cwd: string): Promise<LooseObject[]> {
  return await readAutoresearchLedger(cwd, { mode: "silent-empty" });
}

async function changedFilesForCommit(hash: string, cwd: string): Promise<string[]> {
  const result = await git(["show", "--name-status", "-z", "-M", "--format=", hash], cwd);
  return uniqueSortedGitPaths(result.stdout).filter(
    (file) => !isAutoresearchSessionArtifact(file, "source-checkout"),
  );
}

async function changedFilesBetween(
  left: string,
  right: string,
  cwd: string,
  filterSession = true,
): Promise<string[]> {
  const result = await git(["diff", "--name-status", "-z", "-M", `${left}..${right}`], cwd);
  return uniqueSortedGitPaths(result.stdout)
    .filter((file) => !filterSession || !isAutoresearchSessionArtifact(file, "source-checkout"))
    .sort((a, b) => a.localeCompare(b));
}

function uniqueSortedGitPaths(output: string): string[] {
  return [...new Set(parseNameStatusZ(output).flatMap((entry) => entry.paths))].sort((a, b) =>
    a.localeCompare(b),
  );
}

async function commitHashesBetween(left: string, right: string, cwd: string): Promise<string[]> {
  const result = await git(["log", "--reverse", "--format=%H", `${left}..${right}`], cwd);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function buildSemanticSafety({
  workDir,
  groups,
  ledgerRuns,
  base,
}: {
  workDir: string;
  groups: RunGroup[];
  ledgerRuns: KeptRun[];
  base: string;
}) {
  const blockersByGroup = await mapWithConcurrency(
    groups,
    FINALIZATION_GIT_PROBE_CONCURRENCY,
    async (group) => {
      const blockers: Array<{ code: string; run: number; commit: string; message: string }> = [];
      const later = ledgerRuns.filter(
        (run) =>
          run.run > group.run &&
          run.commit &&
          commitReferencesMatch(run.commit, group.commit) &&
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
      return blockers;
    },
  );
  const blockers = blockersByGroup.flat();
  return {
    ok: blockers.length === 0,
    blockers,
  };
}

async function keptCommitWasReverted(workDir: string, group: RunGroup): Promise<boolean> {
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

function explicitEvidenceInvalidationText(run: LooseObject): string {
  const text = `${run.description || ""} ${run.title || ""} ${JSON.stringify(run.asi || {})}`;
  return /invalidat|contaminat|taint|cache replay|failed repeat|(?:source|query|holdout|evaluator|benchmark|cache|data)\s+leak(?:age)?/i.test(
    text,
  )
    ? text
    : "";
}

async function unkeptCommitsSinceBase(
  base: string,
  groups: RunGroup[],
  cwd: string,
): Promise<CommitSummary[]> {
  const kept = new Set(groups.map((group) => group.commit));
  const result = await git(["log", "--reverse", "--format=%H%x1f%s", `${base}..HEAD`], cwd);
  const candidates = result.stdout.split(/\r?\n/).filter(Boolean);
  const commits = await mapWithConcurrency(
    candidates,
    FINALIZATION_GIT_PROBE_CONCURRENCY,
    async (line): Promise<CommitSummary | null> => {
      const [hash, subject = ""] = line.split("\x1f");
      if (!hash || kept.has(hash)) return null;
      const files = await changedFilesForCommit(hash, cwd);
      if (!files.length) return null;
      return {
        commit: hash,
        shortCommit: hash.slice(0, 12),
        subject,
        files,
      };
    },
  );
  return commits.filter((commit): commit is CommitSummary => commit !== null);
}

function findExcludedPlannedFileConflicts(
  excludedCommits: CommitSummary[],
  plannedFiles: string[],
): CommitSummary[] {
  const planned = new Set(plannedFiles);
  if (!planned.size) return [];
  return excludedCommits
    .map((commit) => ({
      ...commit,
      files: (commit.files || []).filter((file) => planned.has(file)),
    }))
    .filter((commit) => commit.files.length > 0);
}

function planFingerprint(plan: LooseObject): string {
  return finalizationPlanFingerprint(plan);
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

async function git(args: string[], cwd: string): Promise<GitResult> {
  const result = await gitOk(args, cwd);
  if (!result.ok)
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result;
}

async function gitOk(args: string[], cwd: string): Promise<GitResult> {
  const result = await new Promise<GitResult>((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: String(error.message || error) }),
    );
    child.on("close", (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ code, stdout, stderr });
    });
  });
  return { ...result, ok: result.code === 0 };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
