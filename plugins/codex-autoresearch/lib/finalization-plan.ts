import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export type LooseObject = Record<string, any>;

export type LedgerReadMode = "silent-empty" | "strict";

export type NormalizedExcludedCommit = {
  commit: string;
  status: string;
  subject: string;
};

export async function readAutoresearchLedger(
  cwd: string,
  { mode = "silent-empty" }: { mode?: LedgerReadMode } = {},
): Promise<LooseObject[]> {
  try {
    const text = await fsp.readFile(path.join(cwd, "autoresearch.jsonl"), "utf8");
    return text
      .split(/\r?\n/)
      .map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        try {
          return {
            ...JSON.parse(trimmed),
            ...(mode === "strict" ? { __line: index + 1 } : {}),
          };
        } catch (error) {
          if (mode === "silent-empty") throw error;
          const parseError = error as Error;
          throw new Error(
            `Corrupt autoresearch.jsonl at line ${index + 1}: ${parseError.message}`,
          );
        }
      })
      .filter((entry): entry is LooseObject => Boolean(entry));
  } catch (error) {
    if (mode === "silent-empty") return [];
    const readError = error as Error & { code?: string };
    if (readError?.code === "ENOENT") return [];
    if (/^Corrupt autoresearch\.jsonl at line \d+:/.test(readError.message || "")) throw error;
    throw new Error(`Could not read autoresearch.jsonl: ${readError.message || readError}`);
  }
}

export function normalizedExcludedCommits(plan: LooseObject): NormalizedExcludedCommit[] {
  return (Array.isArray(plan.excluded_commits) ? plan.excluded_commits : []).map((item) => ({
    commit: String(item?.commit || ""),
    status: String(item?.status || ""),
    subject: String(item?.subject || ""),
  }));
}

export function normalizeCurrentTreeCoverage(coverage: LooseObject = {}): LooseObject {
  return {
    review_unit: coverage.review_unit || "",
    file_count: coverage.file_count || 0,
    all_file_count: coverage.all_file_count || 0,
    exclude_session_artifacts: Boolean(coverage.exclude_session_artifacts),
    include_session_artifacts: Boolean(coverage.include_session_artifacts),
    included_files: coverage.included_files || [],
    excluded_session_artifacts: coverage.excluded_session_artifacts || [],
    current_tree_fingerprint: coverage.current_tree_fingerprint || "",
  };
}

export function finalizationPlanFingerprintMaterial(plan: LooseObject): LooseObject {
  return {
    mode: plan.mode || "",
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
    current_tree_coverage: normalizeCurrentTreeCoverage(plan.current_tree_coverage),
    groups: (plan.groups || []).map((group: LooseObject) => ({
      title: group.title || "",
      last_commit: group.last_commit || "",
      slug: group.slug || "",
      files: group.files || [],
      source_groups: (group.source_groups || []).map((source: LooseObject) => ({
        last_commit: source.last_commit || "",
        parent_commit: source.parent_commit || "",
        files: source.files || [],
      })),
    })),
  };
}

export function finalizationPlanFingerprint(plan: LooseObject): string {
  return createHash("sha256")
    .update(JSON.stringify(finalizationPlanFingerprintMaterial(plan)))
    .digest("hex");
}

export function assertGeneratedPlanMetadata(config: LooseObject): void {
  const hasExcludedCount = Object.hasOwn(config, "excluded_commit_count");
  const looksGenerated = Boolean(
    config.source_branch ||
      config.planned_at ||
      config.plan_fingerprint ||
      hasExcludedCount ||
      Object.hasOwn(config, "kept_run_count") ||
      Object.hasOwn(config, "kept_commits"),
  );
  if (hasExcludedCount) {
    const count = Number(config.excluded_commit_count);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(
        "Stale finalization plan: excluded_commit_count must be a non-negative integer. Rerun finalizer plan.",
      );
    }
    const excluded = normalizedExcludedCommits(config);
    if (count !== excluded.length) {
      throw new Error(
        "Stale finalization plan: excluded_commit_count does not match excluded_commits. Rerun finalizer plan.",
      );
    }
  }
  if (looksGenerated && !config.plan_fingerprint) {
    throw new Error(
      "Stale finalization plan: generated plan fingerprint is missing. Rerun finalizer plan.",
    );
  }
}
