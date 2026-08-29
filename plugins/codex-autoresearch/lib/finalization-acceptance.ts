type LooseObject = Record<string, unknown>;

export function productGradeFinalizationIssue(coverage: unknown): string | null {
  const record = objectValue(coverage);
  if (!record || record.productGradeReady === true) return null;
  const missing = Array.isArray(record.missingRequiredProof) ? record.missingRequiredProof : [];
  if (!missing.length) return null;
  const labels = missing
    .map((item) => objectValue(item)?.label || objectValue(item)?.id || item)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!labels.length) return null;
  return `Product-grade evidence is missing: ${labels.join(", ")}.`;
}

function objectValue(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}
