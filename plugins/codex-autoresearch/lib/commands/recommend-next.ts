import { resolveActionCommand } from "../action-metadata.js";

type JsonObject = Record<string, unknown>;

export interface RecommendNextResponseInput {
  ok?: boolean;
  workDir: string;
  action?: unknown;
  nextAction?: string;
  whySafe?: string;
  avoids?: string;
  proof?: string;
  blockers?: unknown[];
  commands?: JsonObject;
  nextStep?: unknown;
  compactState?: unknown;
  resumeAudit?: unknown;
  decisionEnvelope?: unknown;
  operatorChecklist?: unknown;
  runtimeProvenance?: unknown;
  loopContract?: unknown;
  approvalLedger?: unknown;
  resourcePreflight?: unknown;
  evidenceMaturity?: unknown;
  laneOrchestration?: unknown;
  finalizationRunway?: unknown;
  operatorReadout?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  portfolioRecommendation?: unknown;
  sessionDecisionCapsule?: unknown;
  evidenceNotes?: unknown[];
  frictionSignals?: unknown[];
}

export interface CompactRecommendNextResponseInput {
  workDir: string;
  compactState: unknown;
}

interface RecommendNextAuthorityInput {
  viewModel?: JsonObject | null;
  compact?: JsonObject | null;
}

export interface RecommendNextRuntimeAuthority {
  decisionEnvelope: JsonObject | null;
  canonicalNextAction: unknown;
  runtimeProvenance: unknown;
  loopContract: unknown;
}

export interface RecommendNextResponse {
  ok: boolean;
  workDir: string;
  action: unknown;
  nextAction: string;
  whySafe: string;
  avoids: string;
  proof: string;
  blockers: unknown[];
  commands: JsonObject;
  nextStep: unknown;
  compactState?: unknown;
  resumeAudit: unknown;
  decisionEnvelope: unknown;
  operatorChecklist?: unknown;
  runtimeProvenance?: unknown;
  loopContract?: unknown;
  approvalLedger?: unknown;
  resourcePreflight?: unknown;
  evidenceMaturity?: unknown;
  laneOrchestration?: unknown;
  finalizationRunway?: unknown;
  operatorReadout?: unknown;
  laneLifecycle?: unknown;
  packetDiagnostics?: unknown;
  portfolioRecommendation?: unknown;
  sessionDecisionCapsule?: unknown;
  evidenceNotes?: unknown[];
  frictionSignals?: unknown[];
}

const DEFAULT_WHY_SAFE =
  "Derived from state, doctor warnings, ASI memory, and dashboard trust state.";
const DEFAULT_AVOIDS =
  "Avoids running a packet before setup, stale-last-run, or trust blockers are resolved.";
const DEFAULT_PROOF = "The next command should update state or clear the blocker.";
const COMPACT_WHY_SAFE =
  "Derived from compact state with the shared decision envelope and finalization authority.";
const COMPACT_AVOIDS =
  "Avoids loading dashboard-only fields while handing off the compact loop contract.";
const COMPACT_PROOF =
  "The primary command comes from compact canonical next action, falling back to compact state.";
const COMPACT_HANDOFF_BUDGET = 7_000;
const OPTIONAL_RECOMMEND_NEXT_FIELDS = [
  "compactState",
  "operatorChecklist",
  "runtimeProvenance",
  "loopContract",
  "approvalLedger",
  "resourcePreflight",
  "evidenceMaturity",
  "laneOrchestration",
  "finalizationRunway",
  "operatorReadout",
  "laneLifecycle",
  "packetDiagnostics",
  "portfolioRecommendation",
  "sessionDecisionCapsule",
  "evidenceNotes",
  "frictionSignals",
] as const satisfies readonly (keyof RecommendNextResponseInput)[];

export function buildRecommendNextResponse(
  input: RecommendNextResponseInput,
): RecommendNextResponse {
  const response: RecommendNextResponse = {
    ok: input.ok ?? true,
    workDir: input.workDir,
    action: input.action ?? null,
    nextAction: input.nextAction || "",
    whySafe: input.whySafe || DEFAULT_WHY_SAFE,
    avoids: input.avoids || DEFAULT_AVOIDS,
    proof: input.proof || DEFAULT_PROOF,
    blockers: Array.isArray(input.blockers) ? input.blockers : [],
    commands: input.commands || {},
    nextStep: input.nextStep ?? null,
    resumeAudit: input.resumeAudit ?? null,
    decisionEnvelope: input.decisionEnvelope ?? input.resumeAudit ?? null,
  };

  for (const field of OPTIONAL_RECOMMEND_NEXT_FIELDS) {
    copyIfProvided(response, field, input[field]);
  }

  return response;
}

export function buildCompactRecommendNextResponse({
  workDir,
  compactState,
}: CompactRecommendNextResponseInput): RecommendNextResponse {
  const handoff = compactRecommendNextHandoff(compactState);
  const compact = recordOrNull(handoff.compactState) || {};
  const sourceEnvelope =
    recordOrNull(compact.decisionEnvelope) || recordOrNull(compact.resumeAudit);
  const canonicalNextAction =
    recordOrNull(sourceEnvelope?.canonicalNextAction) || recordOrNull(compact.canonicalNextAction);
  const commands = recordOrNull(compact.commands) || {};
  const explicitCommand = stringOrEmpty(canonicalNextAction?.command);
  const primaryCommand =
    (explicitCommand
      ? resolveActionCommand(canonicalNextAction?.kind, commands, {
          explicitCommand,
        }) || explicitCommand
      : "") ||
    stringOrEmpty(commands.primary) ||
    resolveActionCommand(canonicalNextAction?.kind, commands) ||
    stringOrEmpty(commands.state);
  const nextAction =
    stringOrEmpty(canonicalNextAction?.reason) ||
    stringOrEmpty(compact.nextAction) ||
    "Continue from compact state.";
  const action = canonicalNextAction
    ? { ...canonicalNextAction, command: primaryCommand }
    : {
        kind: "compact-state",
        reason: nextAction,
        command: primaryCommand,
      };
  const decisionEnvelope = sourceEnvelope;
  if (handoff.bounded) {
    const boundedCompactState = buildBoundedCompactState(compact);
    const boundedEnvelope = boundedDecisionEnvelope(sourceEnvelope);
    const slimLoopContract =
      boundedLoopContract(recordOrNull(compact.loopContract)) ||
      boundedLoopContract(recordOrNull(boundedEnvelope?.loopContract));
    const slimCapsule = compact.sessionDecisionCapsule ?? boundedEnvelope?.sessionDecisionCapsule;
    return enforceCompactHandoffBudget(
      buildRecommendNextResponse({
        ok: compact.ok === false ? false : true,
        workDir,
        action,
        nextAction,
        whySafe: COMPACT_WHY_SAFE,
        avoids: COMPACT_AVOIDS,
        proof: COMPACT_PROOF,
        blockers: Array.isArray(compact.blockers) ? compact.blockers : [],
        commands: primaryCommand ? { primary: primaryCommand } : {},
        nextStep: null,
        compactState: boundedCompactState,
        resumeAudit: null,
        decisionEnvelope: boundedEnvelope,
        loopContract: slimLoopContract,
        operatorReadout: boundedCompactState.operatorReadout,
        portfolioRecommendation: compact.portfolioRecommendation,
        sessionDecisionCapsule: slimCapsule,
        evidenceNotes: handoff.evidenceNotes,
        frictionSignals: handoff.frictionSignals,
      }),
    );
  }

  return buildRecommendNextResponse({
    ok: compact.ok === false ? false : true,
    workDir,
    action,
    nextAction,
    whySafe: COMPACT_WHY_SAFE,
    avoids: COMPACT_AVOIDS,
    proof: COMPACT_PROOF,
    blockers: Array.isArray(compact.blockers) ? compact.blockers : [],
    commands: { ...commands, primary: primaryCommand },
    nextStep: null,
    compactState: handoff.compactState,
    resumeAudit: compact.resumeAudit ?? decisionEnvelope,
    decisionEnvelope,
    runtimeProvenance: compact.runtimeProvenance,
    loopContract: compact.loopContract,
    approvalLedger: compact.approvalLedger,
    resourcePreflight: compact.resourcePreflight,
    evidenceMaturity: compact.evidenceMaturity,
    laneOrchestration: compact.laneOrchestration,
    finalizationRunway: compact.finalizationRunway,
    operatorReadout: compact.operatorReadout,
    laneLifecycle: compact.laneLifecycle,
    packetDiagnostics: compact.packetDiagnostics,
    portfolioRecommendation: compact.portfolioRecommendation,
    sessionDecisionCapsule: compact.sessionDecisionCapsule,
    evidenceNotes: handoff.evidenceNotes,
    frictionSignals: handoff.frictionSignals,
  });
}

export function selectRecommendNextRuntimeAuthority({
  viewModel = null,
  compact = null,
}: RecommendNextAuthorityInput): RecommendNextRuntimeAuthority {
  const viewEnvelope = recordOrNull(viewModel?.decisionEnvelope);
  const compactEnvelope =
    recordOrNull(compact?.decisionEnvelope) || recordOrNull(compact?.resumeAudit);
  const viewRuntimeProvenance =
    recordOrNull(viewEnvelope?.runtimeProvenance) ||
    recordOrNull(recordOrNull(viewModel?.processHygiene)?.runtimeDrift);
  const viewRuntimeBlocker = hasRuntimeProvenanceBlocker(viewEnvelope, viewRuntimeProvenance);
  const viewLoopContract = recordOrNull(viewEnvelope?.loopContract);
  const viewLoopBlocker = loopContractBlocksNextPacket(viewLoopContract);
  const decisionEnvelope =
    viewRuntimeBlocker || viewLoopBlocker ? viewEnvelope : compactEnvelope || viewEnvelope;

  return {
    decisionEnvelope,
    canonicalNextAction:
      decisionEnvelope?.canonicalNextAction ||
      compact?.canonicalNextAction ||
      compactEnvelope?.canonicalNextAction ||
      null,
    runtimeProvenance: viewRuntimeProvenance || recordOrNull(compact?.runtimeProvenance) || null,
    loopContract: decisionEnvelope?.loopContract || compact?.loopContract || null,
  };
}

function copyIfProvided<T extends object>(target: T, key: string, value: unknown) {
  if (value !== undefined) (target as JsonObject)[key] = value;
}

function recordOrNull(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function compactRecommendNextHandoff(compactState: unknown): {
  compactState: unknown;
  evidenceNotes: string[];
  frictionSignals: string[];
  bounded: boolean;
} {
  const compact = recordOrNull(compactState) || {};
  const capsule = recordOrNull(compact.sessionDecisionCapsule);
  const evidenceNotes = stringArray(capsule?.evidence)
    .map((value) => compactHandoffText(value, "evidence"))
    .filter(Boolean)
    .slice(0, 3);
  const frictionSignals = [
    ...stringArray(capsule?.commandBudgetWarnings).map((value) =>
      compactHandoffText(value, "commandBudgetWarnings"),
    ),
    ...arrayRecords(compact.workflowFriction).map((signal) =>
      compactHandoffText(
        stringOrEmpty(signal.reason) || stringOrEmpty(signal.message) || stringOrEmpty(signal.kind),
      ),
    ),
  ]
    .filter(Boolean)
    .slice(0, 3);
  if (!needsCompactHandoff(compactState)) {
    return { compactState, evidenceNotes, frictionSignals, bounded: false };
  }
  return {
    compactState: sanitizeCompactHandoffValue(compactState, ""),
    evidenceNotes,
    frictionSignals,
    bounded: true,
  };
}

function needsCompactHandoff(value: unknown): boolean {
  const json = safeStringify(value);
  return json.length > 6_000 || containsRawToolOutput(json);
}

function sanitizeCompactHandoffValue(value: unknown, key: string): unknown {
  if (typeof value === "string") return compactHandoffText(value, key);
  if (Array.isArray(value)) {
    const sanitized = value.map((item) => sanitizeCompactHandoffValue(item, key));
    return isBoundedArrayKey(key) ? sanitized.slice(0, 3) : sanitized;
  }
  const record = recordOrNull(value);
  if (!record) return value;
  const out: JsonObject = {};
  for (const [childKey, childValue] of Object.entries(record)) {
    out[childKey] = sanitizeCompactHandoffValue(childValue, childKey);
  }
  return out;
}

function compactHandoffText(value: unknown, key = ""): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const tokenCount = raw.match(/Original token count:\s*(\d+)/i)?.[1];
  if (containsRawToolOutput(raw)) {
    return tokenCount
      ? `Large tool output omitted from compact handoff (${tokenCount} reported tokens).`
      : "Large tool output omitted from compact handoff.";
  }
  if (isCommandLikeKey(key)) return raw;
  const text = raw.replace(/\s+/g, " ").trim();
  const maxLength = 360;
  return text.length > maxLength ? `${text.slice(0, maxLength - 20).trim()}...` : text;
}

function containsRawToolOutput(text: string): boolean {
  return /RAW_TOOL_OUTPUT_BODY_SENTINEL|Original token count:\s*\d+|Chunk ID:|Total output lines:/i.test(
    text,
  );
}

function isBoundedArrayKey(key: string): boolean {
  return /evidence|warning|doNotRepeat|wrongNextActions|workflowFriction|blockers/i.test(key);
}

function isCommandLikeKey(key: string): boolean {
  return /command|primary|replaceLast/i.test(key);
}

function buildBoundedCompactState(compact: JsonObject): JsonObject {
  const decisionEnvelope = boundedDecisionEnvelope(
    recordOrNull(compact.decisionEnvelope) || recordOrNull(compact.resumeAudit),
  );
  return {
    goalFrame: compact.goalFrame ?? null,
    goalContract: boundedGoalContract(recordOrNull(compact.goalContract)),
    operatorHandoff: compact.operatorHandoff ?? null,
    canonicalNextAction:
      decisionEnvelope?.canonicalNextAction ?? compact.canonicalNextAction ?? null,
    loopContract: boundedLoopContract(recordOrNull(compact.loopContract)),
    operatorReadout: boundedOperatorReadout(recordOrNull(compact.operatorReadout)),
    decisionEnvelope: {
      activeSegment: decisionEnvelope?.activeSegment ?? null,
      latestPacketFreshness: decisionEnvelope?.latestPacketFreshness ?? null,
      finalizationReadiness: decisionEnvelope?.finalizationReadiness ?? null,
      operatorReadout: boundedOperatorReadout(recordOrNull(decisionEnvelope?.operatorReadout)),
      watchdog: decisionEnvelope?.watchdog ?? null,
      portfolioRecommendation: boundedPortfolioRecommendation(
        recordOrNull(decisionEnvelope?.portfolioRecommendation),
      ),
      canonicalNextAction:
        decisionEnvelope?.canonicalNextAction ?? compact.canonicalNextAction ?? null,
      loopContract: boundedLoopContract(recordOrNull(decisionEnvelope?.loopContract)),
      sessionDecisionCapsule: decisionEnvelope?.sessionDecisionCapsule ?? null,
    },
  };
}

function boundedDecisionEnvelope(envelope: JsonObject | null): JsonObject | null {
  if (!envelope) return null;
  return {
    activeSegment: envelope.activeSegment ?? null,
    latestPacketFreshness: envelope.latestPacketFreshness ?? null,
    finalizationReadiness: envelope.finalizationReadiness ?? null,
    canonicalNextAction: envelope.canonicalNextAction ?? null,
    loopContract: boundedLoopContract(recordOrNull(envelope.loopContract)),
    operatorReadout: boundedOperatorReadout(recordOrNull(envelope.operatorReadout)),
    watchdog: envelope.watchdog ?? null,
    portfolioRecommendation: boundedPortfolioRecommendation(
      recordOrNull(envelope.portfolioRecommendation),
    ),
    sessionDecisionCapsule: envelope.sessionDecisionCapsule ?? null,
  };
}

function boundedLoopContract(loopContract: JsonObject | null): JsonObject | null {
  if (!loopContract) return null;
  return {
    canRunNextPacket: loopContract.canRunNextPacket ?? null,
    blockers: Array.isArray(loopContract.blockers)
      ? loopContract.blockers
          .slice(0, 3)
          .map((blocker) => boundedCanonicalAction(recordOrNull(blocker)) || blocker)
      : [],
  };
}

function enforceCompactHandoffBudget(response: RecommendNextResponse): RecommendNextResponse {
  let current = response;
  if (handoffOutputLength(current) <= COMPACT_HANDOFF_BUDGET) return current;
  current = {
    ...current,
    sessionDecisionCapsule: sanitizeSessionCapsuleForBudget(current.sessionDecisionCapsule),
  };
  if (handoffOutputLength(current) <= COMPACT_HANDOFF_BUDGET) return current;
  const compactState = recordOrNull(current.compactState);
  if (compactState) {
    const compactEnvelope = boundedDecisionEnvelope(
      recordOrNull(current.decisionEnvelope) ||
        recordOrNull(compactState.decisionEnvelope) ||
        recordOrNull(current.resumeAudit),
    );
    current = {
      ...current,
      approvalLedger: undefined,
      resourcePreflight: undefined,
      evidenceMaturity: undefined,
      laneOrchestration: undefined,
      finalizationRunway: undefined,
      operatorReadout: boundedOperatorReadout(recordOrNull(current.operatorReadout)),
      compactState: {
        goalFrame: compactState.goalFrame ?? null,
        goalContract: boundedGoalContract(recordOrNull(compactState.goalContract)),
        operatorHandoff: compactState.operatorHandoff ?? null,
        canonicalNextAction:
          compactState.canonicalNextAction ?? compactEnvelope?.canonicalNextAction ?? null,
        loopContract: boundedLoopContract(recordOrNull(compactState.loopContract)),
        operatorReadout: boundedOperatorReadout(recordOrNull(compactState.operatorReadout)),
        decisionEnvelope: compactEnvelope,
      },
      decisionEnvelope: compactEnvelope,
      loopContract:
        boundedLoopContract(recordOrNull(compactState.loopContract)) ??
        boundedLoopContract(recordOrNull(current.loopContract)),
    };
  }
  if (handoffOutputLength(current) <= COMPACT_HANDOFF_BUDGET) return current;
  // Last resort: drop everything except the minimal resume contract so the
  // budget is enforced, not best-effort.
  const minimalState = recordOrNull(current.compactState);
  const minimalEnvelope = boundedDecisionEnvelope(
    recordOrNull(current.decisionEnvelope) ||
      recordOrNull(minimalState?.decisionEnvelope) ||
      recordOrNull(current.resumeAudit),
  );
  const minimalLoopContract =
    boundedLoopContract(recordOrNull(minimalState?.loopContract)) ||
    boundedLoopContract(recordOrNull(current.loopContract));
  const slimEnvelope = minimalEnvelope
    ? {
        ...minimalEnvelope,
        canonicalNextAction: boundedCanonicalAction(
          recordOrNull(minimalEnvelope.canonicalNextAction),
        ),
      }
    : null;
  const minimalResponse: RecommendNextResponse = {
    ...current,
    action: boundedResponseAction(recordOrNull(current.action)) ?? current.action,
    whySafe: "compact state shared decision envelope.",
    avoids: "Drops nonessential handoff detail.",
    proof: "Use commands.primary, then reread state.",
    approvalLedger: undefined,
    resourcePreflight: undefined,
    evidenceMaturity: undefined,
    laneOrchestration: undefined,
    finalizationRunway: undefined,
    operatorReadout: undefined,
    sessionDecisionCapsule:
      minimalEnvelope?.sessionDecisionCapsule ||
      sanitizeSessionCapsuleForBudget(current.sessionDecisionCapsule) ||
      null,
    decisionEnvelope: slimEnvelope,
    loopContract: minimalLoopContract,
    compactState: {
      goalFrame: minimalState?.goalFrame ?? null,
      operatorHandoff: boundedOperatorHandoff(recordOrNull(minimalState?.operatorHandoff)),
      canonicalNextAction: null,
      loopContract: null,
      decisionEnvelope: slimEnvelope,
    },
  };
  if (
    handoffOutputLength(minimalResponse) <= COMPACT_HANDOFF_BUDGET ||
    !minimalResponse.sessionDecisionCapsule
  ) {
    return minimalResponse;
  }
  const minimalCompactState = recordOrNull(minimalResponse.compactState);
  return {
    ...minimalResponse,
    compactState: minimalCompactState
      ? {
          ...minimalCompactState,
          decisionEnvelope: null,
        }
      : minimalResponse.compactState,
  };
}

function boundedGoalContract(goalContract: JsonObject | null): JsonObject | null {
  if (!goalContract) return null;
  return {
    authoritativeGoal: goalContract.authoritativeGoal ?? "",
    codexObjectiveRole: goalContract.codexObjectiveRole ?? "",
    mismatch: goalContract.mismatch === true,
    status: goalContract.status ?? "",
    blockers: Array.isArray(goalContract.blockers) ? goalContract.blockers.slice(0, 2) : [],
    warnings: Array.isArray(goalContract.warnings) ? goalContract.warnings.slice(0, 2) : [],
    recoveryCommand: goalContract.recoveryCommand ?? "",
  };
}

function boundedOperatorReadout(readout: JsonObject | null): JsonObject | null {
  if (!readout) return null;
  return {
    canonicalNextAction: readout.canonicalNextAction ?? null,
    nextAction: readout.nextAction ?? "",
    blockers: Array.isArray(readout.blockers) ? readout.blockers.slice(0, 3) : [],
    warnings: Array.isArray(readout.warnings) ? readout.warnings.slice(0, 3) : [],
    dashboardMutationAllowed: false,
  };
}

function boundedOperatorHandoff(handoff: JsonObject | null): JsonObject | null {
  if (!handoff) return null;
  return {
    goal: handoff.goal ?? "",
    next: handoff.next ?? "",
    blocker: handoff.blocker ?? "",
  };
}

function boundedCanonicalAction(action: JsonObject | null): JsonObject | null {
  if (!action) return null;
  return {
    kind: action.kind ?? "",
    priority: action.priority ?? null,
    reason: action.reason ?? "",
    command: action.kind === "decision-capsule" ? boundedCanonicalCommand(action.command) : "",
    triggeredBy: Array.isArray(action.triggeredBy) ? action.triggeredBy.slice(0, 3) : [],
    label: action.label ?? "",
    safety: action.safety ?? "",
  };
}

function boundedResponseAction(action: JsonObject | null): JsonObject | null {
  if (!action) return null;
  return {
    kind: action.kind ?? "",
    priority: action.priority ?? null,
    reason: action.reason ?? action.detail ?? "",
    detail: action.detail ?? action.reason ?? "",
    title: action.title ?? "",
  };
}

function boundedCanonicalCommand(command: unknown): string {
  const text = stringOrEmpty(command);
  if (!text || /node\s+scripts[\\/]/i.test(text)) return "";
  return text;
}

function boundedPortfolioRecommendation(recommendation: JsonObject | null): JsonObject | null {
  if (!recommendation) return null;
  return {
    kind: recommendation.kind ?? "",
    nextActionHint: recommendation.nextActionHint ?? "",
    reason: recommendation.reason ?? "",
  };
}

function sanitizeSessionCapsuleForBudget(value: unknown): unknown {
  const capsule = recordOrNull(value);
  if (!capsule) return value;
  return {
    bottleneck: compactHandoffText(capsule.bottleneck),
    nextExperiment: compactHandoffText(capsule.nextExperiment),
    enforcement: capsule.enforcement ?? null,
    evidence: stringArray(capsule.evidence)
      .map((item) => compactHandoffText(item, "evidence"))
      .slice(0, 2),
    warnings: stringArray(capsule.warnings)
      .map((item) => compactHandoffText(item, "warnings"))
      .slice(0, 2),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function arrayRecords(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(recordOrNull).filter((item): item is JsonObject => Boolean(item))
    : [];
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function handoffOutputLength(value: unknown): number {
  try {
    return JSON.stringify(value, null, 2).length;
  } catch {
    return safeStringify(value).length;
  }
}

function hasRuntimeProvenanceBlocker(
  envelope: JsonObject | null,
  runtimeProvenance: JsonObject | null,
): boolean {
  if (
    runtimeProvenance?.drifted === true ||
    runtimeProvenance?.mismatched === true ||
    runtimeProvenance?.stale === true ||
    runtimeProvenance?.needsInspection === true
  ) {
    return true;
  }
  const loopContract = recordOrNull(envelope?.loopContract);
  const blockers = Array.isArray(loopContract?.blockers) ? loopContract.blockers : [];
  return blockers.some((blocker) => recordOrNull(blocker)?.kind === "runtime-provenance");
}

function loopContractBlocksNextPacket(loopContract: JsonObject | null): boolean {
  if (!loopContract) return false;
  const blockers = Array.isArray(loopContract.blockers) ? loopContract.blockers : [];
  const warnings = Array.isArray(loopContract.warnings) ? loopContract.warnings : [];
  return loopContract.canRunNextPacket === false || blockers.length > 0 || warnings.length > 0;
}
