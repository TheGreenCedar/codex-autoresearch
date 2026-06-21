import type { UnknownRecord } from "./types/json.js";

export interface CompactFinalizationReadiness {
  available: boolean;
  ready: boolean | null;
  productGradeReady: boolean;
  productGradeIssue: unknown;
  nextAction: unknown;
  warnings: unknown[];
}

export function compactFinalizationReadiness(
  readiness: UnknownRecord | null | undefined,
): CompactFinalizationReadiness {
  return {
    available: readiness?.available !== false,
    ready: readiness?.ready === null ? null : readiness?.ready === true,
    productGradeReady: readiness?.productGradeReady !== false,
    productGradeIssue: readiness?.productGradeIssue || null,
    nextAction: readiness?.nextAction || readiness?.recommendation || "",
    warnings: Array.isArray(readiness?.warnings) ? readiness.warnings.slice(0, 3) : [],
  };
}
