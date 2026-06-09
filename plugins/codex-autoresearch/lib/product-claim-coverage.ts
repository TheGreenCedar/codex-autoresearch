import { isAcceptedCurrentRun } from "./evidence-registry.js";

type LooseObject = Record<string, unknown>;

export type ProductClaimMaturity = "experimental" | "development" | "product_grade";

export interface ProductProofRequirement {
  id: string;
  label: string;
  requiredForProductGrade: boolean;
}

export interface ProductClaimCoverage {
  claimDetected: boolean;
  maturity: ProductClaimMaturity;
  productGradeReady: boolean;
  requirements: ProductProofRequirement[];
  coveredProof: ProductProofRequirement[];
  missingRequiredProof: ProductProofRequirement[];
  blockers: string[];
}

export interface ProductClaimCoverageInput {
  goal?: string | null;
  acceptedEvidence?: string[];
}

const GENERIC_PRODUCT_CLAIM_PATTERN =
  /\b(shippable|product-grade|product grade|final deliverable|product deliverable|final)\b/i;

const RETRIEVAL_DOMAIN_PATTERN = /\b(retrieval|search|semantic|ranking|ranker|lazy)\b/i;

const SIDECAR_DOMAIN_PATTERN = /\bsidecar\b/i;

const NEGATION_CUE =
  /\b(not|n't|no|never|without|untested|unknown|missing|pending|skipped|todo|did not|wasn't|isn't|aren't|cannot|can't)\b/i;

const RETRIEVAL_REQUIREMENTS: ProductProofRequirement[] = [
  {
    id: "retrieval_accuracy",
    label: "Retrieval accuracy validation",
    requiredForProductGrade: true,
  },
  {
    id: "sidecar_safety",
    label: "Sidecar safety",
    requiredForProductGrade: true,
  },
  {
    id: "lazy_behavior",
    label: "Lazy/selective behavior",
    requiredForProductGrade: true,
  },
  {
    id: "ranking_quality",
    label: "Ranking quality",
    requiredForProductGrade: true,
  },
  {
    id: "docs_tests",
    label: "Tests and docs",
    requiredForProductGrade: true,
  },
];

const GENERIC_PRODUCT_REQUIREMENTS: ProductProofRequirement[] = [
  {
    id: "correctness_checks",
    label: "Correctness or quality checks",
    requiredForProductGrade: true,
  },
  {
    id: "docs_tests",
    label: "Tests and docs",
    requiredForProductGrade: true,
  },
];

const PROOF_PATTERNS: Record<string, RegExp[]> = {
  retrieval_accuracy: [
    /\baccuracy\b/i,
    /\brecall\b/i,
    /\bmrr\b/i,
    /\bhit@/i,
    /quality validation/i,
  ],
  sidecar_safety: [/sidecar safety/i, /fail(?:s|ed)? closed/i, /sidecar fails closed/i],
  lazy_behavior: [/\blazy\b/i, /query-triggered/i, /\bbackfill\b/i, /\bselective\b/i],
  ranking_quality: [/\branking\b/i, /rank quality/i, /search quality/i],
  correctness_checks: [
    /correctness/i,
    /quality check/i,
    /quality gate/i,
    /checks? passed/i,
    /validation passed/i,
    /accuracy/i,
    /ranking quality/i,
  ],
  docs_tests: [/tests? and docs?/i, /docs? updated/i, /tests? updated/i],
};

export function buildFinalizationProductClaimCoverageFromLedger(
  entries: LooseObject[],
): ProductClaimCoverage {
  const goal = latestSessionGoalFromLedger(entries);
  const acceptedEvidence = entries
    .filter(isAcceptedCurrentRun)
    .flatMap((run) => evidenceTextFromRun(run));
  return buildProductClaimCoverage({ goal, acceptedEvidence });
}

export function productClaimCoverageFingerprintMaterial(
  coverage: unknown,
): Record<string, unknown> {
  const record =
    coverage && typeof coverage === "object" && !Array.isArray(coverage)
      ? (coverage as ProductClaimCoverage)
      : null;
  if (!record) {
    return {
      claimDetected: false,
      productGradeReady: false,
      maturity: "experimental",
      missingRequiredProof: [],
      requirements: [],
    };
  }
  return {
    claimDetected: record.claimDetected,
    productGradeReady: record.productGradeReady,
    maturity: record.maturity,
    missingRequiredProof: (record.missingRequiredProof || []).map((item) => ({
      id: item.id,
      label: item.label,
    })),
    requirements: (record.requirements || []).map((item) => ({
      id: item.id,
      label: item.label,
    })),
  };
}

export function buildProductClaimCoverage(
  input: ProductClaimCoverageInput = {},
): ProductClaimCoverage {
  const goal = String(input.goal || "");
  const acceptedEvidence = (input.acceptedEvidence || []).map((item) => String(item || ""));
  const requirements = requirementsForGoal(goal);
  const claimDetected = requirements.length > 0;
  const coveredProof = requirements.filter((requirement) =>
    evidenceCoversRequirement(requirement, acceptedEvidence),
  );
  const coveredIds = new Set(coveredProof.map((proof) => proof.id));
  const missingRequiredProof = requirements.filter(
    (requirement) => requirement.requiredForProductGrade && !coveredIds.has(requirement.id),
  );
  const blockers = missingRequiredProof.map(
    (proof) => `Product-grade evidence is missing: ${proof.label}.`,
  );
  const productGradeReady = !claimDetected || missingRequiredProof.length === 0;

  return {
    claimDetected,
    maturity: !claimDetected
      ? "experimental"
      : productGradeReady
        ? "product_grade"
        : coveredProof.length > 0
          ? "development"
          : "experimental",
    productGradeReady,
    requirements,
    coveredProof,
    missingRequiredProof,
    blockers,
  };
}

export function evidenceTextFromRun(run: LooseObject | null | undefined): string[] {
  if (!run) return [];
  const asi = recordValue(run.asi);
  const metrics = recordValue(run.metrics);
  const values = [
    run.description,
    run.summary,
    run.evidence,
    run.evidenceSummary,
    run.notes,
    asi.evidence,
    asi.summary,
    asi.rationale,
    asi.next_action_hint,
    metrics.evidence,
    metrics.quality,
  ];
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function latestSessionGoalFromLedger(entries: LooseObject[]): string {
  let goal = "";
  for (const entry of entries) {
    if (entry?.type === "config" && Object.hasOwn(entry, "goal")) {
      goal = String(entry.goal || "").trim();
    }
  }
  return goal;
}

function requirementsForGoal(goal: string): ProductProofRequirement[] {
  if (RETRIEVAL_DOMAIN_PATTERN.test(goal) || /\baccuracy\b/i.test(goal)) {
    return RETRIEVAL_REQUIREMENTS.filter(
      (requirement) => requirement.id !== "sidecar_safety" || SIDECAR_DOMAIN_PATTERN.test(goal),
    );
  }
  if (GENERIC_PRODUCT_CLAIM_PATTERN.test(goal)) {
    return GENERIC_PRODUCT_REQUIREMENTS;
  }
  return [];
}

function splitEvidenceClauses(text: string): string[] {
  return text
    .split(/[.;]\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function clauseSupportsRequirement(clause: string, patterns: RegExp[]): boolean {
  if (!patterns.some((pattern) => pattern.test(clause))) return false;
  return !NEGATION_CUE.test(clause);
}

function evidenceCoversRequirement(
  requirement: ProductProofRequirement,
  acceptedEvidence: string[],
): boolean {
  const patterns = PROOF_PATTERNS[requirement.id] || [];
  return acceptedEvidence.some((evidence) =>
    splitEvidenceClauses(evidence).some((clause) => clauseSupportsRequirement(clause, patterns)),
  );
}

function recordValue(value: unknown): LooseObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseObject) : {};
}
