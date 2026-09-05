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
  requirements?: ProductProofRequirement[];
}

// Legacy prose remains history; only identified, explicit requirements can add gates.
export function explicitProductRequirements(entries: LooseObject[]): ProductProofRequirement[] {
  const value = [...entries]
    .reverse()
    .find(
      (entry) => entry.type === "config" && Object.hasOwn(entry, "productProofRequirements"),
    )?.productProofRequirements;
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("Explicit product proof requirements must be an array.");
  return value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      !("label" in item) ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      !("requiredForProductGrade" in item) ||
      typeof item.requiredForProductGrade !== "boolean"
    )
      throw new Error("Malformed explicit product proof requirement.");
    return {
      id: item.id,
      label: item.label,
      requiredForProductGrade: item.requiredForProductGrade,
    };
  });
}

export function buildFinalizationProductClaimCoverageFromLedger(
  entries: LooseObject[],
): ProductClaimCoverage {
  return buildProductClaimCoverage({ requirements: explicitProductRequirements(entries) });
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
  const requirements = input.requirements ?? [];
  const required = requirements.filter((item) => item.requiredForProductGrade);
  const claimDetected = requirements.length > 0;
  // Accepted benchmark keeps authorize measured review work. They do not establish
  // product-wide correctness, representativeness, or release readiness.
  return {
    claimDetected,
    maturity: "experimental",
    productGradeReady: required.length === 0,
    requirements,
    coveredProof: [],
    missingRequiredProof: required,
    blockers: required.map(
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

function recordValue(value: unknown): LooseObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseObject) : {};
}
