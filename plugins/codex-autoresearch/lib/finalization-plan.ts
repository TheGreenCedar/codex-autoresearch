import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import {
  evidenceStatusForRun,
  isAcceptedCurrentRun,
  isKeepRun,
  isRejectedRun,
} from "./evidence-registry.js";
import {
  buildProductClaimCoverage,
  evidenceTextFromRun,
  productClaimCoverageFingerprintMaterial,
  type ProductClaimCoverage,
} from "./product-claim-coverage.js";
import { jsonlPath } from "./session-records.js";

export type LooseObject = Record<string, any>;

export type LedgerReadMode = "silent-empty" | "strict";

export type NormalizedExcludedCommit = {
  commit: string;
  status: string;
  subject: string;
};

export const FINALIZATION_EVIDENCE_COMPONENT_KEYS = [
  "accepted_commit_membership",
  "excluded_commit_statuses",
  "evidence_statuses",
  "accepted_ledger_order",
  "product_claim_coverage_inputs",
] as const;

export type FinalizationEvidenceComponent = (typeof FINALIZATION_EVIDENCE_COMPONENT_KEYS)[number];

export type FinalizationEvidenceFingerprint = {
  schema_version: 1;
  fingerprint: string;
  components: Record<FinalizationEvidenceComponent, string>;
};

export type FinalizationEvidenceState = {
  acceptedCommits: string[];
  acceptedRuns: LooseObject[];
  fingerprint: FinalizationEvidenceFingerprint;
  productClaimCoverage: ProductClaimCoverage;
};

const MINIMUM_COMMIT_REFERENCE_LENGTH = 7;

export async function readAutoresearchLedger(
  cwd: string,
  { mode = "silent-empty" }: { mode?: LedgerReadMode } = {},
): Promise<LooseObject[]> {
  try {
    const text = await fsp.readFile(jsonlPath(cwd), "utf8");
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
          const parseError = error as Error;
          throw new Error(`Corrupt autoresearch.jsonl at line ${index + 1}: ${parseError.message}`);
        }
      })
      .filter((entry): entry is LooseObject => Boolean(entry));
  } catch (error) {
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

export function buildFinalizationEvidenceState(
  commitOrder: string[],
  ledgerEntries: LooseObject[],
): FinalizationEvidenceState {
  const commits = [
    ...new Set((commitOrder || []).map((commit) => String(commit || "").trim()).filter(Boolean)),
  ];
  const commitStates = commits.map((commit) => {
    let entry: LooseObject | null = null;
    let ledgerIndex = -1;
    for (let index = 0; index < ledgerEntries.length; index += 1) {
      const candidate = ledgerEntries[index];
      if (
        !isFinalizationEvidenceTransition(candidate) ||
        !commitReferencesMatch(candidate?.commit, commit)
      )
        continue;
      entry = candidate;
      ledgerIndex = index;
    }
    return {
      commit,
      entry,
      ledgerIndex,
      accepted: isAcceptedCurrentRun(entry),
    };
  });
  const acceptedRecords = [
    ...commitStates
      .filter((state) => state.accepted && state.entry)
      .map((state) => ({
        commit: state.commit,
        entry: state.entry!,
        ledgerIndex: state.ledgerIndex,
      })),
    ...ledgerEntries
      .map((entry, ledgerIndex) => ({ commit: "", entry, ledgerIndex }))
      .filter(
        ({ entry }) =>
          entry?.run != null &&
          !String(entry.commit || "").trim() &&
          isFinalizationEvidenceTransition(entry) &&
          isAcceptedCurrentRun(entry),
      ),
  ].sort((left, right) => left.ledgerIndex - right.ledgerIndex);
  const acceptedCommits = commitStates
    .filter((state) => state.accepted)
    .map((state) => state.commit);
  const goal = latestSessionGoal(ledgerEntries);
  const claimInputs = acceptedRecords.map(({ commit, entry }) => ({
    commit,
    run: entry.run ?? null,
    evidence: evidenceTextFromRun(entry),
  }));
  const productClaimCoverage = buildProductClaimCoverage({
    goal,
    acceptedEvidence: claimInputs.flatMap((input) => input.evidence),
  });
  const materials: Record<FinalizationEvidenceComponent, unknown> = {
    accepted_commit_membership: acceptedCommits,
    excluded_commit_statuses: commitStates
      .filter((state) => !state.accepted)
      .map((state) => ({
        commit: state.commit,
        status: finalizationEvidenceStatusLabel(state.entry),
      })),
    evidence_statuses: commitStates.map((state) => ({
      commit: state.commit,
      status: state.entry ? String(state.entry.status || "") : "unlogged",
      declared_evidence_status: state.entry ? String(state.entry.evidenceStatus || "") : "unlogged",
      effective_evidence_status: state.entry ? evidenceStatusForRun(state.entry) : "unlogged",
      quarantined: state.entry?.quarantined === true,
    })),
    accepted_ledger_order: acceptedRecords.map(({ commit, entry }) => ({
      commit,
      run: entry.run ?? null,
    })),
    product_claim_coverage_inputs: {
      goal,
      accepted_evidence: claimInputs,
      coverage: productClaimCoverageFingerprintMaterial(productClaimCoverage),
    },
  };
  const components = Object.fromEntries(
    FINALIZATION_EVIDENCE_COMPONENT_KEYS.map((key) => [
      key,
      hashFingerprintMaterial(materials[key]),
    ]),
  ) as Record<FinalizationEvidenceComponent, string>;
  return {
    acceptedCommits,
    acceptedRuns: acceptedRecords.map((record) => record.entry),
    productClaimCoverage,
    fingerprint: {
      schema_version: 1,
      fingerprint: hashFingerprintMaterial(materials),
      components,
    },
  };
}

export function normalizeFinalizationEvidenceFingerprint(value: unknown): LooseObject {
  const fingerprint =
    value && typeof value === "object" && !Array.isArray(value) ? (value as LooseObject) : {};
  const components =
    fingerprint.components &&
    typeof fingerprint.components === "object" &&
    !Array.isArray(fingerprint.components)
      ? fingerprint.components
      : {};
  return {
    schema_version: Number(fingerprint.schema_version || 0),
    fingerprint: String(fingerprint.fingerprint || ""),
    components: Object.fromEntries(
      FINALIZATION_EVIDENCE_COMPONENT_KEYS.map((key) => [key, String(components[key] || "")]),
    ),
  };
}

export function commitReferencesMatch(left: unknown, right: unknown): boolean {
  const a = String(left || "")
    .trim()
    .toLowerCase();
  const b = String(right || "")
    .trim()
    .toLowerCase();
  const valid = (value: string) =>
    value.length >= MINIMUM_COMMIT_REFERENCE_LENGTH &&
    value.length <= 64 &&
    /^[0-9a-f]+$/.test(value);
  if (!valid(a) || !valid(b)) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length !== 40 && longer.length !== 64) return false;
  if ((shorter.length === 40 || shorter.length === 64) && shorter.length !== longer.length)
    return false;
  return longer.startsWith(shorter);
}

export function isFinalizationEvidenceTransition(entry: LooseObject | null | undefined): boolean {
  const type = String(entry?.type || "")
    .trim()
    .toLowerCase();
  if (type && type !== "run") return false;
  return isKeepRun(entry) || isRejectedRun(entry);
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
    accepted_evidence_fingerprint: normalizeFinalizationEvidenceFingerprint(
      plan.accepted_evidence_fingerprint,
    ),
    product_claim_coverage: productClaimCoverageFingerprintMaterial(plan.product_claim_coverage),
    product_grade_ready: Boolean(
      plan.product_grade_ready ?? plan.product_claim_coverage?.productGradeReady,
    ),
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
  if (looksGenerated && !config.accepted_evidence_fingerprint) {
    throw new Error(
      "Stale finalization plan: accepted-current evidence fingerprint is missing. Rerun finalizer plan.",
    );
  }
}

function finalizationEvidenceStatusLabel(entry: LooseObject | null): string {
  if (!entry) return "unlogged";
  if (String(entry.status || "") === "keep") return evidenceStatusForRun(entry);
  return String(entry.status || "unlogged");
}

function latestSessionGoal(entries: LooseObject[]): string {
  let goal = "";
  for (const entry of entries) {
    if (entry?.type === "config" && Object.hasOwn(entry, "goal")) {
      goal = String(entry.goal || "").trim();
    }
  }
  return goal;
}

function hashFingerprintMaterial(material: unknown): string {
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
