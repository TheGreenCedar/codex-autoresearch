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

export function acceptedCurrentTreeFinalizationIssue(payload: LooseObject): string | null {
  const issues = Array.isArray(payload?.issues) ? payload.issues : [];
  if (issues.length !== 1) {
    return null;
  }
  const currentTreeSignal =
    hasCurrentTreeFinalizationCode(payload) ||
    /finalize-current-tree|current non-session branch diff/i.test(String(issues[0] || ""));
  if (!currentTreeSignal) return null;
  const loopContract = objectValue(payload?.loopContract) || {};
  const strongestAction = objectValue(loopContract.strongestAction) || {};
  const strongestKind = String(strongestAction.kind || "");
  const blockers = Array.isArray(loopContract.blockers) ? loopContract.blockers : [];
  const candidateCommands = [
    strongestAction.command,
    objectValue(payload?.canonicalNextAction)?.command,
    objectValue(objectValue(payload?.decisionEnvelope)?.canonicalNextAction)?.command,
    objectValue(objectValue(objectValue(payload?.decisionEnvelope)?.loopContract)?.strongestAction)
      ?.command,
  ];
  const actionableCommands = candidateCommands
    .map(concreteCommand)
    .filter((command): command is string => Boolean(command));
  const structurallyAccepted =
    loopContract.canRunNextPacket === false &&
    strongestKind === "current-tree-finalization" &&
    blockers.some((blocker: unknown) => objectValue(blocker)?.kind === "current-tree-finalization");
  if (
    !structurallyAccepted ||
    actionableCommands.some(commandInvokesNextPacket) ||
    !actionableCommands.some(commandInvokesFinalization)
  ) {
    return null;
  }
  return String(issues[0]);
}

function hasCurrentTreeFinalizationCode(payload: LooseObject): boolean {
  const decisionEnvelope = objectValue(payload?.decisionEnvelope);
  const state = objectValue(payload?.state);
  const stateDecisionEnvelope = objectValue(state?.decisionEnvelope);
  const candidates = [
    payload?.actionCode,
    objectValue(payload?.finalizationReadiness)?.actionCode,
    objectValue(decisionEnvelope?.finalizationReadiness)?.actionCode,
    objectValue(stateDecisionEnvelope?.finalizationReadiness)?.actionCode,
  ];
  return candidates.some((candidate) => candidate === "current-tree-finalization");
}

function objectValue(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

function concreteCommand(command: unknown): string {
  const text = typeof command === "string" ? command.trim() : "";
  return text && !/<[^>]+>/.test(text) ? text : "";
}

function commandInvokesNextPacket(command: string): boolean {
  return /(?:^|\s)next(?:\s|$)|next_experiment/i.test(command);
}

function commandInvokesFinalization(command: string): boolean {
  return /\bfinalize-(?:current-tree|preview)\b/i.test(command);
}
