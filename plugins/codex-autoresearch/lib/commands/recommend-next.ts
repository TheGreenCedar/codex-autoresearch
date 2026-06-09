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

  copyIfProvided(response, "compactState", input.compactState);
  copyIfProvided(response, "operatorChecklist", input.operatorChecklist);
  copyIfProvided(response, "runtimeProvenance", input.runtimeProvenance);
  copyIfProvided(response, "loopContract", input.loopContract);
  copyIfProvided(response, "laneLifecycle", input.laneLifecycle);
  copyIfProvided(response, "packetDiagnostics", input.packetDiagnostics);
  copyIfProvided(response, "portfolioRecommendation", input.portfolioRecommendation);
  copyIfProvided(response, "sessionDecisionCapsule", input.sessionDecisionCapsule);
  copyIfProvided(response, "evidenceNotes", input.evidenceNotes);
  copyIfProvided(response, "frictionSignals", input.frictionSignals);

  return response;
}

export function buildCompactRecommendNextResponse({
  workDir,
  compactState,
}: CompactRecommendNextResponseInput): RecommendNextResponse {
  const handoff = compactRecommendNextHandoff(compactState);
  const compact = recordOrNull(handoff.compactState) || {};
  const canonicalNextAction = recordOrNull(compact.canonicalNextAction);
  const commands = recordOrNull(compact.commands) || {};
  const primaryCommand =
    resolveActionCommand(canonicalNextAction?.kind, commands, {
      explicitCommand: canonicalNextAction?.command,
    }) || stringOrEmpty(commands.state);
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
  const decisionEnvelope = compact.decisionEnvelope ?? compact.resumeAudit ?? null;
  if (handoff.bounded) {
    const boundedCompactState = buildBoundedCompactState(compact);
    const boundedEnvelope = boundedDecisionEnvelope(
      recordOrNull(compact.decisionEnvelope) || recordOrNull(compact.resumeAudit),
    );
    const slimLoopContract = boundedLoopContract(recordOrNull(compact.loopContract));
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
        sessionDecisionCapsule: compact.sessionDecisionCapsule,
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
    operatorHandoff: compact.operatorHandoff ?? null,
    loopContract: boundedLoopContract(recordOrNull(compact.loopContract)),
    decisionEnvelope: {
      finalizationReadiness: decisionEnvelope?.finalizationReadiness ?? null,
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
  };
}

function boundedLoopContract(loopContract: JsonObject | null): JsonObject | null {
  if (!loopContract) return null;
  return {
    canRunNextPacket: loopContract.canRunNextPacket ?? null,
    blockers: Array.isArray(loopContract.blockers) ? loopContract.blockers.slice(0, 3) : [],
  };
}

function enforceCompactHandoffBudget(response: RecommendNextResponse): RecommendNextResponse {
  let current = response;
  if (safeStringify(current).length <= COMPACT_HANDOFF_BUDGET) return current;
  current = {
    ...current,
    evidenceNotes: [],
    frictionSignals: [],
    sessionDecisionCapsule: sanitizeSessionCapsuleForBudget(current.sessionDecisionCapsule),
  };
  if (safeStringify(current).length <= COMPACT_HANDOFF_BUDGET) return current;
  const compactState = recordOrNull(current.compactState);
  if (compactState) {
    current = {
      ...current,
      compactState: {
        goalFrame: compactState.goalFrame ?? null,
        operatorHandoff: compactState.operatorHandoff ?? null,
        loopContract: compactState.loopContract ?? null,
        decisionEnvelope: compactState.decisionEnvelope ?? null,
      },
    };
  }
  if (safeStringify(current).length <= COMPACT_HANDOFF_BUDGET) return current;
  // Last resort: drop everything except the minimal resume contract so the
  // budget is enforced, not best-effort.
  const minimalState = recordOrNull(current.compactState);
  return {
    ...current,
    sessionDecisionCapsule: null,
    compactState: {
      goalFrame: minimalState?.goalFrame ?? null,
      operatorHandoff: minimalState?.operatorHandoff ?? null,
    },
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
