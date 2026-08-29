export type FinalizationDecisionFact =
  | { code: "finalization-blocked" }
  | { code: "finalization-ready"; acceptedEvidenceCount: number }
  | { code: "current-tree-finalization"; acceptedEvidenceCount: number };

export function blockedFinalizationDecisionFact(): FinalizationDecisionFact {
  return { code: "finalization-blocked" };
}

export function buildFinalizationDecisionFact({
  ready,
  currentTreeRecovery,
  acceptedEvidenceCount,
}: {
  ready: boolean;
  currentTreeRecovery: boolean;
  acceptedEvidenceCount: number;
}): FinalizationDecisionFact {
  const provenAcceptedEvidenceCount =
    Number.isInteger(acceptedEvidenceCount) && acceptedEvidenceCount > 0
      ? acceptedEvidenceCount
      : 0;
  if (ready && provenAcceptedEvidenceCount > 0) {
    return { code: "finalization-ready", acceptedEvidenceCount: provenAcceptedEvidenceCount };
  }
  if (currentTreeRecovery && provenAcceptedEvidenceCount > 0) {
    return {
      code: "current-tree-finalization",
      acceptedEvidenceCount: provenAcceptedEvidenceCount,
    };
  }
  return blockedFinalizationDecisionFact();
}

export function isFinalizationDecisionFact(value: unknown): value is FinalizationDecisionFact {
  if (!value || typeof value !== "object") return false;
  const fact = value as Record<string, unknown>;
  if (fact.code === "finalization-blocked") return true;
  return (
    (fact.code === "finalization-ready" || fact.code === "current-tree-finalization") &&
    Number.isInteger(fact.acceptedEvidenceCount) &&
    Number(fact.acceptedEvidenceCount) > 0
  );
}
