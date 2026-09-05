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

// Goal wording can request a claim, but cannot supply evidence or invent domain gates.
const GENERIC_PRODUCT_CLAIM_PATTERN =
  /\b(shippable|product[- ]grade|broad superiority|general superiority)\b/i;

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
  const claimDetected = GENERIC_PRODUCT_CLAIM_PATTERN.test(goal);
  const requirements: ProductProofRequirement[] = claimDetected
    ? [
        {
          id: "independent_product_review",
          label: "Independent review of the product claim",
          requiredForProductGrade: true,
        },
      ]
    : [];
  // Accepted benchmark keeps authorize measured review work. They do not establish
  // product-wide correctness, representativeness, or release readiness.
  return {
    claimDetected,
    maturity: "experimental",
    productGradeReady: !claimDetected,
    requirements,
    coveredProof: [],
    missingRequiredProof: requirements,
    blockers: requirements.map(
      (proof) =>
        `Product-grade evidence is missing: ${proof.label}. Finalize only the measured result and report the broader claim as unverified.`,
    ),
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

function recordValue(value: unknown): LooseObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseObject) : {};
}
