type LooseObject = Record<string, unknown>;

export type ProductClaimMaturity = "experimental" | "development" | "product_grade";

export interface ProductProofRequirement {
  id: string;
  label: string;
  requiredForProductGrade: boolean;
}

export interface ProductClaimCoverage {
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

const PRODUCT_CLAIM_PATTERN =
  /\b(shippable|product-grade|product grade|final|lazy|retrieval|accuracy|ranking|semantic|performance)\b/i;

const RETRIEVAL_QUALITY_PATTERN =
  /\b(retrieval|search|semantic|ranking|ranker|accuracy|performance|lazy)\b/i;

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

const PROOF_PATTERNS: Record<string, RegExp[]> = {
  retrieval_accuracy: [/\baccuracy\b/i, /\brecall\b/i, /\bmrr\b/i, /\bhit@/i, /quality validation/i],
  sidecar_safety: [/sidecar safety/i, /fail(?:s|ed)? closed/i, /sidecar fails closed/i],
  lazy_behavior: [/\blazy\b/i, /query-triggered/i, /\bbackfill\b/i, /\bselective\b/i],
  ranking_quality: [/\branking\b/i, /rank quality/i, /search quality/i],
  docs_tests: [/tests? and docs?/i, /docs? updated/i, /tests? updated/i],
};

export function buildProductClaimCoverage(
  input: ProductClaimCoverageInput = {},
): ProductClaimCoverage {
  const goal = String(input.goal || "");
  const acceptedEvidence = (input.acceptedEvidence || []).map((item) => String(item || ""));
  const requirements = requirementsForGoal(goal);
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
  const productGradeReady = missingRequiredProof.length === 0;

  return {
    maturity: productGradeReady
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

function requirementsForGoal(goal: string): ProductProofRequirement[] {
  if (!PRODUCT_CLAIM_PATTERN.test(goal)) return [];
  if (RETRIEVAL_QUALITY_PATTERN.test(goal)) return RETRIEVAL_REQUIREMENTS;
  return [];
}

function evidenceCoversRequirement(
  requirement: ProductProofRequirement,
  acceptedEvidence: string[],
): boolean {
  const patterns = PROOF_PATTERNS[requirement.id] || [];
  return acceptedEvidence.some((evidence) => patterns.some((pattern) => pattern.test(evidence)));
}

function recordValue(value: unknown): LooseObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : {};
}
