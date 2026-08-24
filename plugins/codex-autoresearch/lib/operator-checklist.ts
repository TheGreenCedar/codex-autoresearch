type LooseObject = Record<string, unknown>;

export interface OperatorChecklist {
  command: string;
  safetyReason: string;
  blocker: string;
  evidenceRole: string;
  source: string;
}

export function buildOperatorChecklist(
  decisionPlan: LooseObject | null | undefined,
  context: LooseObject = {},
): OperatorChecklist {
  const plan = objectValue(decisionPlan) || {};
  const action = objectValue(plan.action) || {};
  const capabilities = objectValue(plan.capabilities);
  const requiredEvidence = objectValue(plan.requiredEvidence) || {};
  const diagnosticCodes = stringArray(requiredEvidence.diagnosticCodes);
  const acceptedCheckIdentities = stringArray(requiredEvidence.acceptedCheckIdentities);
  const hasCanonicalPacketCapability =
    stringValue(objectValue(capabilities?.["run-packet"])?.status) ||
    stringValue(capabilities?.["run-packet"]);

  if (!hasCanonicalPacketCapability) {
    return {
      command: "",
      safetyReason: "Canonical capability decision unavailable; refresh state before acting.",
      blocker: "decision-unavailable",
      evidenceRole: "decision-precondition",
      source: "decision-plan",
    };
  }

  return {
    command: stringValue(action.command) || stringValue(context.primaryCommand),
    safetyReason:
      stringValue(action.reason) ||
      stringValue(context.actionReason) ||
      "Projected from the canonical session decision.",
    blocker: stringValue(plan.primaryBlockerCode),
    evidenceRole: acceptedCheckIdentities.length
      ? "accepted-checks"
      : diagnosticCodes.length
        ? "decision-diagnostics"
        : "decision-precondition",
    source: stringValue(context.source) || diagnosticCodes.join(",") || "decision-plan",
  };
}

function objectValue(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}
