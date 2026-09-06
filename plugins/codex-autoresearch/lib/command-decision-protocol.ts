import { randomUUID } from "node:crypto";
import path from "node:path";

import type { DecisionPlan } from "./decision-compiler.js";
import type { CoherentSessionSnapshot } from "./coherent-session-snapshot.js";
import {
  CanonicalSessionSourceError,
  loadCanonicalSessionDecision,
  type CanonicalSessionDecisionResult,
  type SessionDecisionFactCollection,
} from "./session-decision.js";
import { assertSessionMutationLockHeld } from "./session-mutation-lock.js";
import {
  decisionCapabilityForCommand,
  recoveryDiagnosticsForCommand,
  requiredDecisionDiagnosticsForCommand,
} from "./command-table.js";
import { COMMAND_MUTATION_RECEIPT_SCHEMA_VERSION } from "./decision-schema-versions.js";
import { acceptedExperimentContractForMutation } from "./experiment-contract.js";

export { COMMAND_MUTATION_RECEIPT_SCHEMA_VERSION } from "./decision-schema-versions.js";

export interface CommandMutationReceipt {
  kind: "command-mutation-receipt";
  schemaVersion: 1;
  receiptId: string;
  command: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  workDir: string;
  preconditionGenerationId: string;
  resultingCaptureStatus: "captured" | "unavailable";
  resultingGenerationId: string | null;
  generationChanged: boolean | null;
}

export interface CommandDecisionProtocolResult<T> {
  preconditionDecision: DecisionPlan;
  mutation: CommandMutationReceipt;
  result: T;
  resultingDecision: DecisionPlan;
}

export interface CommandDecisionMutationContext {
  sessionCwd: string;
  workDir: string;
  config: Record<string, unknown>;
  snapshot: CoherentSessionSnapshot;
  factCollection?: SessionDecisionFactCollection;
  preconditionDecision: DecisionPlan;
}

type DecisionLoader = (input: {
  requestedCwd: string;
  allowOutsideWorkdir?: boolean;
  allowLedgerParseErrors?: boolean;
}) => Promise<CanonicalSessionDecisionResult>;

export interface ResultingCaptureDiagnostic {
  code:
    | "coherent-snapshot-source-invalid"
    | "coherent-snapshot-unavailable"
    | "session-route-changed";
  message: string;
}

export class CommandDecisionProtocolError extends Error {
  readonly code:
    | "coherent-snapshot-unavailable"
    | "coherent-snapshot-source-invalid"
    | "mutation-failed"
    | "mutation-precondition-blocked"
    | "session-route-changed";
  readonly preconditionDecision: DecisionPlan | null;
  readonly mutation: CommandMutationReceipt | null;
  readonly resultingDecision: DecisionPlan | null;
  readonly resultingCaptureDiagnostic: ResultingCaptureDiagnostic | null;

  constructor({
    code,
    message,
    cause,
    preconditionDecision = null,
    mutation = null,
    resultingDecision = null,
    resultingCaptureDiagnostic = null,
  }: {
    code: CommandDecisionProtocolError["code"];
    message: string;
    cause?: unknown;
    preconditionDecision?: DecisionPlan | null;
    mutation?: CommandMutationReceipt | null;
    resultingDecision?: DecisionPlan | null;
    resultingCaptureDiagnostic?: ResultingCaptureDiagnostic | null;
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CommandDecisionProtocolError";
    this.code = code;
    this.preconditionDecision = preconditionDecision;
    this.mutation = mutation;
    this.resultingDecision = resultingDecision;
    this.resultingCaptureDiagnostic = resultingCaptureDiagnostic;
  }
}

export function commandDecisionProtocolFailureEnvelope(
  error: CommandDecisionProtocolError,
): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    ...(error.preconditionDecision ? { preconditionDecision: error.preconditionDecision } : {}),
    ...(error.mutation ? { mutation: error.mutation } : {}),
    ...(error.resultingDecision ? { resultingDecision: error.resultingDecision } : {}),
    ...(error.resultingCaptureDiagnostic
      ? { resultingCaptureDiagnostic: error.resultingCaptureDiagnostic }
      : {}),
  };
}

export async function runCommandDecisionProtocol<T>({
  command,
  requestedCwd,
  expectedWorkDir,
  allowOutsideWorkdir = false,
  commandArgs = {},
  mutate,
  loadDecision = loadCanonicalSessionDecision,
}: {
  command: string;
  requestedCwd: string;
  expectedWorkDir: string;
  allowOutsideWorkdir?: boolean;
  commandArgs?: Readonly<Record<string, unknown>>;
  mutate: (context: CommandDecisionMutationContext) => Promise<T>;
  loadDecision?: DecisionLoader;
}): Promise<CommandDecisionProtocolResult<T>> {
  assertSessionMutationLockHeld(command);
  const precondition = await loadRequiredDecision({
    command,
    phase: "precondition",
    requestedCwd,
    allowOutsideWorkdir,
    loadDecision,
  });
  assertExpectedRoute(command, "precondition", expectedWorkDir, precondition.snapshot.workDir);
  if (
    (commandArgs.actionFile ||
      commandArgs.action_file ||
      commandArgs.resume ||
      commandArgs.observationFile ||
      commandArgs.observation_file) &&
    !precondition.snapshot.outcome
  )
    throw new Error(
      "An accepted outcome with an explicit resource budget is required before governed work.",
    );
  if (precondition.snapshot.outcome && !["outcome", "next", "log"].includes(command))
    throw new Error(
      "This outcome uses versioned authority. Use outcome, next, and log; legacy session mutation is not permitted.",
    );
  assertMutationCapability(command, commandArgs, precondition.plan, precondition.snapshot);
  await assertAcceptedContractCommandCompatibility(command, commandArgs, precondition);
  await acceptCompleteLegacyContract(command, commandArgs, precondition);

  const startedAt = new Date().toISOString();
  const receiptId = randomUUID();
  let result: T;
  try {
    result = await mutate({
      sessionCwd: precondition.snapshot.sessionCwd,
      workDir: precondition.snapshot.workDir,
      config: precondition.snapshot.config,
      snapshot: precondition.snapshot,
      factCollection: precondition.factCollection,
      preconditionDecision: precondition.plan,
    });
  } catch (cause) {
    const resulting = await captureResultingDecision({
      command,
      requestedCwd,
      expectedWorkDir,
      allowOutsideWorkdir,
      loadDecision,
      preconditionDecision: precondition.plan,
    });
    const mutation = mutationReceipt({
      command,
      receiptId,
      status: "failed",
      startedAt,
      workDir: expectedWorkDir,
      preconditionDecision: precondition.plan,
      resultingDecision: resulting.ok ? resulting.loaded.plan : null,
    });
    throw new CommandDecisionProtocolError({
      code: "mutation-failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
      preconditionDecision: precondition.plan,
      mutation,
      resultingDecision: resulting.ok ? resulting.loaded.plan : null,
      resultingCaptureDiagnostic: resulting.ok ? null : resulting.diagnostic,
    });
  }

  const resulting = await captureResultingDecision({
    command,
    requestedCwd,
    expectedWorkDir,
    allowOutsideWorkdir,
    loadDecision,
    preconditionDecision: precondition.plan,
  });
  if (!resulting.ok) {
    const mutation = mutationReceipt({
      command,
      receiptId,
      status: "completed",
      startedAt,
      workDir: expectedWorkDir,
      preconditionDecision: precondition.plan,
      resultingDecision: null,
    });
    throw new CommandDecisionProtocolError({
      code: resulting.diagnostic.code,
      message: resulting.diagnostic.message,
      preconditionDecision: precondition.plan,
      mutation,
      resultingCaptureDiagnostic: resulting.diagnostic,
    });
  }
  return {
    preconditionDecision: precondition.plan,
    mutation: mutationReceipt({
      command,
      receiptId,
      status: "completed",
      startedAt,
      workDir: expectedWorkDir,
      preconditionDecision: precondition.plan,
      resultingDecision: resulting.loaded.plan,
    }),
    result,
    resultingDecision: resulting.loaded.plan,
  };
}

async function assertAcceptedContractCommandCompatibility(
  command: string,
  commandArgs: Readonly<Record<string, unknown>>,
  precondition: Extract<CanonicalSessionDecisionResult, { ok: true }>,
): Promise<void> {
  if (
    command === "outcome" ||
    precondition.snapshot.outcome ||
    command !== "next" ||
    !precondition.snapshot.semanticFacts.contractDigest
  )
    return;
  try {
    await acceptedExperimentContractForMutation({
      workDir: precondition.snapshot.workDir,
      args: commandArgs,
      config: precondition.snapshot.config,
      entries: precondition.snapshot.records,
      packet: precondition.snapshot.lastRunPacket,
    });
  } catch (cause) {
    throw new CommandDecisionProtocolError({
      code: "mutation-precondition-blocked",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
      preconditionDecision: precondition.plan,
    });
  }
}

async function acceptCompleteLegacyContract(
  command: string,
  commandArgs: Readonly<Record<string, unknown>>,
  precondition: Extract<CanonicalSessionDecisionResult, { ok: true }>,
): Promise<void> {
  if (command === "outcome" || precondition.snapshot.outcome) return;
  const capability = decisionCapabilityForCommand(command, commandArgs, {
    config: precondition.snapshot.config,
  });
  if (capability === "transition-segment") return;
  if (
    !precondition.plan.requiredEvidence.diagnosticCodes.includes(
      "legacy-contract-acceptance-required",
    )
  ) {
    return;
  }
  await acceptedExperimentContractForMutation({
    workDir: precondition.snapshot.workDir,
    config: precondition.snapshot.config,
    entries: precondition.snapshot.records,
    packet: precondition.snapshot.lastRunPacket,
  });
}

function assertMutationCapability(
  command: string,
  commandArgs: Readonly<Record<string, unknown>>,
  plan: DecisionPlan,
  snapshot: CoherentSessionSnapshot,
): void {
  const missingRequiredDiagnostic = requiredDecisionDiagnosticsForCommand(command).find(
    (code) => !plan.requiredEvidence.diagnosticCodes.includes(code),
  );
  if (missingRequiredDiagnostic) {
    throw new CommandDecisionProtocolError({
      code: "mutation-precondition-blocked",
      message: `${command} requires the canonical ${missingRequiredDiagnostic} recovery route.`,
      preconditionDecision: plan,
    });
  }
  const status = plan.capabilities["mutate-session"];
  const recoveryCodes = new Set(recoveryDiagnosticsForCommand(command));
  if (
    status !== "allowed" &&
    !recoveryCoversCapabilityRestrictions(command, plan, snapshot, "mutate-session", recoveryCodes)
  ) {
    throw new CommandDecisionProtocolError({
      code: "mutation-precondition-blocked",
      message:
        status === "recovery-only"
          ? `The canonical precondition permits recovery only; ${command} is not the typed recovery command.`
          : `The canonical precondition blocks session mutation for ${command}.`,
      preconditionDecision: plan,
    });
  }
  const capability = decisionCapabilityForCommand(command, commandArgs, {
    config: snapshot.config,
  });
  if (!capability) return;
  const capabilityStatus = plan.capabilities[capability];
  if (
    capabilityStatus === "allowed" ||
    recoveryCoversCapabilityRestrictions(command, plan, snapshot, capability, recoveryCodes)
  ) {
    return;
  }
  throw new CommandDecisionProtocolError({
    code: "mutation-precondition-blocked",
    message:
      `The canonical precondition sets ${capability}=${capabilityStatus}; ${command} is not authorized` +
      ` (${plan.requiredEvidence.diagnosticCodes.join(", ") || "no diagnostic code"}).`,
    preconditionDecision: plan,
  });
}

function recoveryCoversCapabilityRestrictions(
  command: string,
  plan: DecisionPlan,
  snapshot: CoherentSessionSnapshot,
  capability: keyof DecisionPlan["capabilities"],
  recoveryCodes: ReadonlySet<string>,
): boolean {
  const marker = `:${capability}:`;
  const restrictingDiagnostics = plan.requiredEvidence.capabilityEffectCodes.flatMap((effect) => {
    const markerIndex = effect.indexOf(marker);
    return markerIndex < 0 ? [] : [effect.slice(0, markerIndex)];
  });
  return (
    restrictingDiagnostics.length > 0 &&
    restrictingDiagnostics.every(
      (code) => recoveryCodes.has(code) || receiptOwnedLogRecoveryCovers(command, snapshot, code),
    )
  );
}

function receiptOwnedLogRecoveryCovers(
  command: string,
  snapshot: CoherentSessionSnapshot,
  diagnosticCode: string,
): boolean {
  if (command !== "log") return false;
  const pending = snapshot.pendingTransaction;
  const relation = pending?.ledgerRelation;
  const ownsLedgerSuffix = Boolean(
    pending?.consistent &&
    pending.transactionId &&
    (relation?.kind === "absent" ||
      relation?.kind === "complete" ||
      relation?.kind === "receipt-owned-torn-suffix") &&
    relation.transactionId === pending.transactionId,
  );
  if (!ownsLedgerSuffix) return false;
  if (diagnosticCode === "ledger-integrity") {
    return relation?.kind === "receipt-owned-torn-suffix";
  }
  if (diagnosticCode !== "legacy-contract-conflict") return false;
  const receipt = pending?.receipt;
  const transaction =
    receipt && typeof receipt.transaction === "object" && receipt.transaction !== null
      ? (receipt.transaction as Record<string, unknown>)
      : null;
  return (
    transaction?.kind === "keep" &&
    Array.isArray(receipt?.completedStages) &&
    receipt.completedStages.includes("commit-applied-or-verified")
  );
}

async function loadRequiredDecision({
  command,
  phase,
  requestedCwd,
  allowOutsideWorkdir,
  loadDecision,
  preconditionDecision = null,
}: {
  command: string;
  phase: "precondition" | "resulting";
  requestedCwd: string;
  allowOutsideWorkdir: boolean;
  loadDecision: DecisionLoader;
  preconditionDecision?: DecisionPlan | null;
}): Promise<Extract<CanonicalSessionDecisionResult, { ok: true }>> {
  let loaded: CanonicalSessionDecisionResult;
  try {
    loaded = await loadDecision({
      requestedCwd,
      allowOutsideWorkdir,
      ...(command === "ledger-doctor" || command === "log" ? { allowLedgerParseErrors: true } : {}),
    });
  } catch (error) {
    if (error instanceof CommandDecisionProtocolError) throw error;
    if (!(error instanceof CanonicalSessionSourceError)) throw error;
    throw new CommandDecisionProtocolError({
      code: "coherent-snapshot-source-invalid",
      message: `Cannot capture the ${phase} decision for ${command}: ${error.message}`,
      cause: error,
      preconditionDecision,
    });
  }
  if (loaded.ok) return loaded;
  throw new CommandDecisionProtocolError({
    code: loaded.diagnostic.code,
    message: `Cannot capture the ${phase} decision for ${command}: ${loaded.diagnostic.message}`,
    preconditionDecision,
  });
}

async function captureResultingDecision({
  command,
  requestedCwd,
  expectedWorkDir,
  allowOutsideWorkdir,
  loadDecision,
  preconditionDecision,
}: {
  command: string;
  requestedCwd: string;
  expectedWorkDir: string;
  allowOutsideWorkdir: boolean;
  loadDecision: DecisionLoader;
  preconditionDecision: DecisionPlan;
}): Promise<
  | { ok: true; loaded: Extract<CanonicalSessionDecisionResult, { ok: true }> }
  | { ok: false; diagnostic: ResultingCaptureDiagnostic }
> {
  try {
    const loaded = await loadRequiredDecision({
      command,
      phase: "resulting",
      requestedCwd,
      allowOutsideWorkdir,
      loadDecision,
      preconditionDecision,
    });
    assertExpectedRoute(command, "resulting", expectedWorkDir, loaded.snapshot.workDir);
    return { ok: true, loaded };
  } catch (error) {
    if (
      error instanceof CommandDecisionProtocolError &&
      [
        "coherent-snapshot-source-invalid",
        "coherent-snapshot-unavailable",
        "session-route-changed",
      ].includes(error.code)
    ) {
      return {
        ok: false,
        diagnostic: {
          code: error.code as ResultingCaptureDiagnostic["code"],
          message: error.message,
        },
      };
    }
    return {
      ok: false,
      diagnostic: {
        code: "coherent-snapshot-source-invalid",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function assertExpectedRoute(
  command: string,
  phase: "precondition" | "resulting",
  expectedWorkDir: string,
  actualWorkDir: string,
): void {
  if (path.resolve(expectedWorkDir) === path.resolve(actualWorkDir)) return;
  throw new CommandDecisionProtocolError({
    code: "session-route-changed",
    message:
      `The routing config changed before the ${phase} snapshot for ${command}: ` +
      `the held lock targets ${path.resolve(expectedWorkDir)}, but captured config routes to ${path.resolve(actualWorkDir)}. Retry the command.`,
  });
}

function mutationReceipt({
  command,
  receiptId,
  status,
  startedAt,
  workDir,
  preconditionDecision,
  resultingDecision,
}: {
  command: string;
  receiptId: string;
  status: CommandMutationReceipt["status"];
  startedAt: string;
  workDir: string;
  preconditionDecision: DecisionPlan;
  resultingDecision: DecisionPlan | null;
}): CommandMutationReceipt {
  return {
    kind: "command-mutation-receipt",
    schemaVersion: COMMAND_MUTATION_RECEIPT_SCHEMA_VERSION,
    receiptId,
    command,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    workDir,
    preconditionGenerationId: preconditionDecision.generationId,
    resultingCaptureStatus: resultingDecision ? "captured" : "unavailable",
    resultingGenerationId: resultingDecision?.generationId || null,
    generationChanged: resultingDecision
      ? preconditionDecision.generationId !== resultingDecision.generationId
      : null,
  };
}
