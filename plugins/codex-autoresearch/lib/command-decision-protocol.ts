import { randomUUID } from "node:crypto";
import path from "node:path";

import type { DecisionDiagnostic, DecisionPlan } from "./decision-compiler.js";
import {
  loadCanonicalSessionDecision,
  type CanonicalSessionDecisionResult,
  type SessionDecisionFacts,
} from "./session-decision.js";
import { assertSessionMutationLockHeld } from "./session-mutation-lock.js";

export const COMMAND_MUTATION_RECEIPT_SCHEMA_VERSION = 1 as const;
const COMMAND_DECISION_DIAGNOSTICS = Symbol("command-decision-diagnostics");

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
  resultingGenerationId: string;
  generationChanged: boolean;
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
  preconditionDecision: DecisionPlan;
}

type DecisionLoader = (input: {
  requestedCwd: string;
  allowOutsideWorkdir?: boolean;
  facts?: SessionDecisionFacts;
}) => Promise<CanonicalSessionDecisionResult>;

export function withCommandDecisionDiagnostics<T extends object>(
  value: T,
  diagnostics: readonly DecisionDiagnostic[],
): T {
  Object.defineProperty(value, COMMAND_DECISION_DIAGNOSTICS, {
    configurable: false,
    enumerable: false,
    value: [...diagnostics],
    writable: false,
  });
  return value;
}

export function commandDecisionDiagnosticsFrom(value: unknown): DecisionDiagnostic[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<PropertyKey, unknown>;
  const direct = record[COMMAND_DECISION_DIAGNOSTICS];
  if (Array.isArray(direct)) return direct as DecisionDiagnostic[];
  return commandDecisionDiagnosticsFrom(record.result);
}

export class CommandDecisionProtocolError extends Error {
  readonly code:
    | "coherent-snapshot-unavailable"
    | "mutation-failed"
    | "mutation-precondition-blocked"
    | "session-route-changed";
  readonly preconditionDecision: DecisionPlan | null;
  readonly mutation: CommandMutationReceipt | null;
  readonly resultingDecision: DecisionPlan | null;

  constructor({
    code,
    message,
    cause,
    preconditionDecision = null,
    mutation = null,
    resultingDecision = null,
  }: {
    code: CommandDecisionProtocolError["code"];
    message: string;
    cause?: unknown;
    preconditionDecision?: DecisionPlan | null;
    mutation?: CommandMutationReceipt | null;
    resultingDecision?: DecisionPlan | null;
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CommandDecisionProtocolError";
    this.code = code;
    this.preconditionDecision = preconditionDecision;
    this.mutation = mutation;
    this.resultingDecision = resultingDecision;
  }
}

export async function runCommandDecisionProtocol<T>({
  command,
  requestedCwd,
  expectedWorkDir,
  allowOutsideWorkdir = false,
  mutate,
  loadDecision = loadCanonicalSessionDecision,
}: {
  command: string;
  requestedCwd: string;
  expectedWorkDir: string;
  allowOutsideWorkdir?: boolean;
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
  assertMutationCapability(command, precondition.plan);

  const startedAt = new Date().toISOString();
  const receiptId = randomUUID();
  let result: T;
  try {
    result = await mutate({
      sessionCwd: precondition.snapshot.sessionCwd,
      workDir: precondition.snapshot.workDir,
      config: precondition.snapshot.config,
      preconditionDecision: precondition.plan,
    });
  } catch (cause) {
    const resulting = await loadRequiredDecision({
      command,
      phase: "resulting",
      requestedCwd,
      allowOutsideWorkdir,
      loadDecision,
      preconditionDecision: precondition.plan,
    });
    assertExpectedRoute(command, "resulting", expectedWorkDir, resulting.snapshot.workDir);
    const mutation = mutationReceipt({
      command,
      receiptId,
      status: "failed",
      startedAt,
      workDir: expectedWorkDir,
      preconditionDecision: precondition.plan,
      resultingDecision: resulting.plan,
    });
    throw new CommandDecisionProtocolError({
      code: "mutation-failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
      preconditionDecision: precondition.plan,
      mutation,
      resultingDecision: resulting.plan,
    });
  }

  const resulting = await loadRequiredDecision({
    command,
    phase: "resulting",
    requestedCwd,
    allowOutsideWorkdir,
    loadDecision,
    preconditionDecision: precondition.plan,
    diagnostics: commandDecisionDiagnosticsFrom(result),
  });
  assertExpectedRoute(command, "resulting", expectedWorkDir, resulting.snapshot.workDir);
  return {
    preconditionDecision: precondition.plan,
    mutation: mutationReceipt({
      command,
      receiptId,
      status: "completed",
      startedAt,
      workDir: expectedWorkDir,
      preconditionDecision: precondition.plan,
      resultingDecision: resulting.plan,
    }),
    result,
    resultingDecision: resulting.plan,
  };
}

function assertMutationCapability(command: string, plan: DecisionPlan): void {
  const status = plan.capabilities["mutate-session"];
  if (status === "allowed") return;
  const diagnosticCodes = plan.requiredEvidence.diagnosticCodes;
  const allowedRecoveryCommands = new Set<string>();
  if (
    diagnosticCodes.includes("pending-log-transaction") ||
    diagnosticCodes.includes("pending-log-transaction-inconsistent")
  ) {
    allowedRecoveryCommands.add("log");
  }
  if (diagnosticCodes.includes("ledger-integrity")) allowedRecoveryCommands.add("ledger-doctor");
  if (status === "recovery-only" && allowedRecoveryCommands.has(command)) return;
  throw new CommandDecisionProtocolError({
    code: "mutation-precondition-blocked",
    message:
      status === "recovery-only"
        ? `The canonical precondition permits recovery only; ${command} is not the typed recovery command.`
        : `The canonical precondition blocks session mutation for ${command}.`,
    preconditionDecision: plan,
  });
}

async function loadRequiredDecision({
  command,
  phase,
  requestedCwd,
  allowOutsideWorkdir,
  loadDecision,
  preconditionDecision = null,
  diagnostics = [],
}: {
  command: string;
  phase: "precondition" | "resulting";
  requestedCwd: string;
  allowOutsideWorkdir: boolean;
  loadDecision: DecisionLoader;
  preconditionDecision?: DecisionPlan | null;
  diagnostics?: readonly DecisionDiagnostic[];
}): Promise<Extract<CanonicalSessionDecisionResult, { ok: true }>> {
  const loaded = await loadDecision({
    requestedCwd,
    allowOutsideWorkdir,
    ...(diagnostics.length > 0 ? { facts: { diagnostics } } : {}),
  });
  if (loaded.ok) return loaded;
  throw new CommandDecisionProtocolError({
    code: "coherent-snapshot-unavailable",
    message: `Cannot capture the ${phase} decision for ${command}: ${loaded.diagnostic.message}`,
    preconditionDecision,
  });
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
  resultingDecision: DecisionPlan;
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
    resultingGenerationId: resultingDecision.generationId,
    generationChanged: preconditionDecision.generationId !== resultingDecision.generationId,
  };
}
