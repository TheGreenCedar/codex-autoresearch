import { createHash } from "node:crypto";
import {
  parseInvestigation,
  parseExecutionReceipt,
  parseInvestigationEvidence,
  parseOutcomeEvaluator,
  type InvestigationRecord,
  type ExecutionReceipt,
  type InvestigationEvidence,
  type OutcomeEvaluator,
} from "./investigation-records.js";
import path from "node:path";

import { normalizeRelativePaths } from "./literal-paths.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

export const OUTCOME_SCHEMA_VERSION = 3;
export const OUTCOME_EFFECTS = ["inspect", "edit", "execute", "git", "publish"] as const;
export type OutcomeEffect = (typeof OUTCOME_EFFECTS)[number];
export type DeliveryEndpoint = "answer" | "patch" | "integrated" | "deployed";

export interface OutcomeCriterion {
  id: string;
  description: string;
  authority: "internal" | "independent";
  subject: "candidate" | "outcome";
}

export interface OutcomeBudget {
  actions: number | null;
  executionSeconds: number | null;
  deadline: string | null;
  advisoryModelTokens: number | null;
  advisoryCostUsd: number | null;
}

export interface ConfirmationAuthority {
  repository: string;
  workflow: string;
  workflowRevision: string;
  ref: string;
  protocolDigest: string;
  datasetId: string;
  custody: "external" | "internal";
  custodyReference: string;
}

export interface OutcomeContract {
  schemaVersion: 3;
  id: string;
  objective: string;
  criteria: OutcomeCriterion[];
  authorization: {
    reference: string;
    worktrees: string[];
    editable: string[];
    protected: string[];
    effects: OutcomeEffect[];
    environments: string[];
    delivery: DeliveryEndpoint;
  };
  budget: OutcomeBudget;
  confirmation: ConfirmationAuthority | null;
  digest: string;
}

export type ResourceSettlement =
  | { kind: "reserved" }
  | { kind: "unknown"; reason: string }
  | { kind: "measured"; seconds: number };

export interface OutcomeReservation {
  id: string;
  investigationId: string;
  specificationDigest: string;
  contractDigest: string;
  worktree: string;
  reservedAt: string;
  seconds: number;
  settlement: ResourceSettlement;
}

export interface LegacySource {
  kind: "file" | "directory";
  path: string;
  digest: string;
  bytesBase64: string | null;
}

export interface OutcomeState {
  schemaVersion: 3;
  revision: number;
  contract: OutcomeContract;
  history: Array<{ contract: OutcomeContract; at: string; authorization: string; reason: string }>;
  reservations: OutcomeReservation[];
  investigations: InvestigationRecord[];
  executions: ExecutionReceipt[];
  evidence: InvestigationEvidence[];
  evaluators: OutcomeEvaluator[];
  legacySources: LegacySource[];
  lifecycle: { kind: "active" } | { kind: "stopped-unmet"; at: string; reason: string };
  adoption: null | {
    priorConsumption: { kind: "unknown"; reason: string };
    allowance: "remaining";
  };
}

export function outcomeObject(value: unknown, label: string): UnknownRecord {
  if (!isUnknownRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

export function outcomeString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a nonempty string.`);
  return value;
}

export function outcomeId(value: unknown, label = "id"): string {
  const id = outcomeString(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id))
    throw new Error(`${label} is not a bounded identifier.`);
  return id;
}

export function outcomeDigest(value: unknown, label = "digest"): string {
  const digest = outcomeString(value, label);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 digest.`);
  return digest;
}

export function outcomeNumber(value: unknown, label: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`${label} must be a finite number between ${minimum} and MAX_SAFE_INTEGER.`);
  }
  return value;
}

export function outcomeEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.some((item) => item === value))
    throw new Error(`${label} must be one of: ${values.join(", ")}.`);
  // Membership in the closed values tuple was established above.
  return value as T[number];
}

export function outcomeStrings(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a nonempty"} array.`);
  const result = value.map((item) => outcomeString(item, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates.`);
  return result;
}

export function outcomeTimestamp(value: unknown, label: string): string {
  const timestamp = outcomeString(value, label);
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

export function hashOutcomeValue(value: unknown): string {
  return createHash("sha256").update(stableOutcomeJson(value)).digest("hex");
}

export function stableOutcomeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableOutcomeJson).join(",")}]`;
  if (isUnknownRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableOutcomeJson(value[key])}`)
      .join(",")}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Outcome records must contain JSON values.");
  return json;
}

function optionalLimit(value: unknown, label: string, integer = false): number | null {
  if (value == null) return null;
  const number = outcomeNumber(value, `budget.${label}`, Number.MIN_VALUE);
  if (integer && !Number.isSafeInteger(number))
    throw new Error(`budget.${label} must be a positive safe integer.`);
  return number;
}

export function parseOutcomeBudget(value: unknown): OutcomeBudget {
  const input = outcomeObject(value, "budget");
  const budget: OutcomeBudget = {
    actions: optionalLimit(input.actions, "actions", true),
    executionSeconds: optionalLimit(input.executionSeconds, "executionSeconds"),
    deadline: input.deadline == null ? null : outcomeTimestamp(input.deadline, "budget.deadline"),
    advisoryModelTokens: optionalLimit(input.advisoryModelTokens, "advisoryModelTokens", true),
    advisoryCostUsd: optionalLimit(input.advisoryCostUsd, "advisoryCostUsd"),
  };
  if (budget.actions === null && budget.executionSeconds === null && budget.deadline === null) {
    throw new Error(
      "An explicit action, execution-time, or deadline budget is required. Model and monetary estimates are advisory.",
    );
  }
  if (Object.keys(input).some((key) => !Object.hasOwn(budget, key)))
    throw new Error(
      "Unsupported budget dimension; hard model or monetary limits require trusted host/provider enforcement.",
    );
  return budget;
}

export function parseConfirmationAuthority(value: unknown): ConfirmationAuthority | null {
  if (value == null) return null;
  const input = outcomeObject(value, "confirmation");
  const repository = outcomeString(input.repository, "confirmation.repository");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("confirmation.repository must be owner/repository.");
  const workflow = outcomeString(input.workflow, "confirmation.workflow");
  if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflow))
    throw new Error("confirmation.workflow must identify a GitHub Actions workflow.");
  const workflowRevision = outcomeString(input.workflowRevision, "confirmation.workflowRevision");
  if (!/^[a-f0-9]{40}$/.test(workflowRevision))
    throw new Error("confirmation.workflowRevision must be an immutable Git commit.");
  return {
    repository,
    workflow,
    workflowRevision,
    ref: outcomeString(input.ref, "confirmation.ref"),
    protocolDigest: outcomeDigest(input.protocolDigest, "confirmation.protocolDigest"),
    datasetId: outcomeId(input.datasetId, "confirmation.datasetId"),
    custody: outcomeEnum(input.custody, ["external", "internal"], "confirmation.custody"),
    custodyReference: outcomeString(input.custodyReference, "confirmation.custodyReference"),
  };
}

export function parseOutcomeContract(value: unknown): OutcomeContract {
  const input = outcomeObject(value, "outcome contract");
  if (input.schemaVersion != null && input.schemaVersion !== OUTCOME_SCHEMA_VERSION)
    throw new Error("Unsupported outcome contract schema.");
  const authorization = outcomeObject(input.authorization, "authorization");
  if (!Array.isArray(input.criteria) || input.criteria.length === 0)
    throw new Error("Explicit outcome criteria are required.");
  const criteria = input.criteria.map((value): OutcomeCriterion => {
    const criterion = outcomeObject(value, "criterion");
    return {
      id: outcomeId(criterion.id, "criterion.id"),
      description: outcomeString(criterion.description, "criterion.description"),
      authority: outcomeEnum(
        criterion.authority,
        ["internal", "independent"],
        "criterion.authority",
      ),
      subject: outcomeEnum(criterion.subject, ["candidate", "outcome"], "criterion.subject"),
    };
  });
  if (new Set(criteria.map((item) => item.id)).size !== criteria.length)
    throw new Error("Criterion IDs must be unique.");
  const editable = normalizeRelativePaths(
    outcomeStrings(authorization.editable, "editable scope", true),
    "editable scope",
  );
  const protectedPaths = normalizeRelativePaths(
    outcomeStrings(authorization.protected, "protected scope", true),
    "protected scope",
  );
  if (editable.some((item) => protectedPaths.some((other) => pathsOverlap(item, other))))
    throw new Error("Editable and protected scope overlap.");
  const worktrees = outcomeStrings(authorization.worktrees, "authorized worktrees");
  if (worktrees.some((cwd) => !path.isAbsolute(cwd)))
    throw new Error("Authorized worktree paths must be absolute.");
  const contract: Omit<OutcomeContract, "digest"> = {
    schemaVersion: 3,
    id: outcomeId(input.id, "outcome.id"),
    objective: outcomeString(input.objective, "objective"),
    criteria,
    authorization: {
      reference: outcomeString(authorization.reference, "authorization.reference"),
      worktrees,
      editable,
      protected: protectedPaths,
      effects: outcomeStrings(authorization.effects, "effects").map((item) =>
        outcomeEnum(item, OUTCOME_EFFECTS, "effect"),
      ),
      environments: outcomeStrings(authorization.environments, "environments"),
      delivery: outcomeEnum(
        authorization.delivery,
        ["answer", "patch", "integrated", "deployed"],
        "delivery",
      ),
    },
    budget: parseOutcomeBudget(input.budget),
    confirmation: parseConfirmationAuthority(input.confirmation),
  };
  const digest = hashOutcomeValue(contract);
  if (input.digest != null && input.digest !== digest)
    throw new Error("Outcome contract digest does not match its contents.");
  return { ...contract, digest };
}

export function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left === "." ||
    right === "." ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

export function outcomeUsage(state: Pick<OutcomeState, "reservations">) {
  let measuredSeconds = 0;
  let reservedSeconds = 0;
  let unknownExecutions = 0;
  for (const reservation of state.reservations) {
    if (reservation.settlement.kind === "measured")
      measuredSeconds += reservation.settlement.seconds;
    else reservedSeconds += reservation.seconds;
    if (reservation.settlement.kind === "unknown") unknownExecutions += 1;
  }
  outcomeNumber(measuredSeconds + reservedSeconds, "cumulative execution exposure");
  return {
    actions: state.reservations.length,
    measuredSeconds,
    reservedSeconds,
    unknownExecutions,
    modelTokens: null,
    costUsd: null,
  };
}

export function parseResourceSettlement(value: unknown): ResourceSettlement {
  const input = outcomeObject(value, "resource settlement");
  switch (input.kind) {
    case "reserved":
      return { kind: "reserved" };
    case "unknown":
      return { kind: "unknown", reason: outcomeString(input.reason, "unknown consumption reason") };
    case "measured":
      return { kind: "measured", seconds: outcomeNumber(input.seconds, "measured seconds") };
    default:
      throw new Error("Unsupported resource settlement.");
  }
}

export function parseOutcomeState(value: unknown): OutcomeState {
  const input = outcomeObject(value, "outcome state");
  if (input.schemaVersion !== 3) throw new Error("Unsupported outcome state schema.");
  const revision = outcomeNumber(input.revision, "revision", 1);
  if (!Number.isSafeInteger(revision)) throw new Error("Outcome revision must be a safe integer.");
  const contract = parseOutcomeContract(input.contract);
  if (!Array.isArray(input.history) || !input.history.length || !Array.isArray(input.reservations))
    throw new Error("Outcome history and reservations are required.");
  const history = input.history.map((value) => {
    const record = outcomeObject(value, "contract history");
    return {
      contract: parseOutcomeContract(record.contract),
      at: outcomeTimestamp(record.at, "history timestamp"),
      authorization: outcomeString(record.authorization, "history authorization"),
      reason: outcomeString(record.reason, "history reason"),
    };
  });
  if (
    history.at(-1)?.contract.digest !== contract.digest ||
    history.some((item) => item.contract.id !== contract.id)
  )
    throw new Error("Outcome contract history does not match current authority.");
  const reservations = input.reservations.map((value): OutcomeReservation => {
    const record = outcomeObject(value, "reservation");
    const contractDigest = outcomeDigest(record.contractDigest, "reservation contract");
    if (!history.some((item) => item.contract.digest === contractDigest))
      throw new Error("Reservation refers to unknown authorization.");
    return {
      id: outcomeId(record.id),
      investigationId: outcomeId(record.investigationId),
      specificationDigest: outcomeDigest(record.specificationDigest),
      contractDigest,
      worktree: outcomeString(record.worktree, "reservation worktree"),
      reservedAt: outcomeTimestamp(record.reservedAt, "reservation time"),
      seconds: outcomeNumber(record.seconds, "reservation seconds", Number.MIN_VALUE),
      settlement: parseResourceSettlement(record.settlement),
    };
  });
  if (new Set(reservations.map((r) => r.id)).size !== reservations.length)
    throw new Error("Duplicate reservation identities.");
  const lifecycle = outcomeObject(input.lifecycle, "outcome lifecycle");
  const parsedLifecycle: OutcomeState["lifecycle"] =
    lifecycle.kind === "active"
      ? { kind: "active" }
      : lifecycle.kind === "stopped-unmet"
        ? {
            kind: "stopped-unmet",
            at: outcomeTimestamp(lifecycle.at, "stop timestamp"),
            reason: outcomeString(lifecycle.reason, "stop reason"),
          }
        : (() => {
            throw new Error("Unsupported outcome lifecycle.");
          })();
  let adoption: OutcomeState["adoption"] = null;
  if (input.adoption != null) {
    const record = outcomeObject(input.adoption, "adoption");
    const consumption = outcomeObject(record.priorConsumption, "prior consumption");
    if (consumption.kind !== "unknown" || record.allowance !== "remaining")
      throw new Error("Imported historical consumption must retain its unknown boundary.");
    adoption = {
      priorConsumption: {
        kind: "unknown",
        reason: outcomeString(consumption.reason, "prior consumption reason"),
      },
      allowance: "remaining",
    };
  }
  if (!Array.isArray(input.legacySources))
    throw new Error("Legacy source guard is required, including absent sources.");
  const legacySources = input.legacySources.map((value) => {
    const source = outcomeObject(value, "legacy source");
    const bytesBase64 =
      source.bytesBase64 === null
        ? null
        : typeof source.bytesBase64 === "string"
          ? source.bytesBase64
          : (() => {
              throw new Error("Legacy bytes must be encoded text.");
            })();
    const digest = outcomeString(source.digest, "legacy digest");
    if (
      digest !==
      (bytesBase64 === null
        ? "missing"
        : createHash("sha256").update(Buffer.from(bytesBase64, "base64")).digest("hex"))
    )
      throw new Error("Legacy import bytes do not match their digest.");
    return {
      kind: outcomeEnum(source.kind, ["file", "directory"], "legacy source kind"),
      path: outcomeString(source.path, "legacy path"),
      digest,
      bytesBase64,
    };
  });
  const state: OutcomeState = {
    schemaVersion: 3,
    revision,
    contract,
    history,
    reservations,
    investigations: parseRecords(input.investigations, parseInvestigation, "investigations"),
    executions: parseRecords(
      input.executions,
      (value) =>
        parseExecutionReceipt(
          value,
          history.map((entry) => entry.contract),
        ),
      "executions",
    ),
    evidence: parseRecords(input.evidence, parseInvestigationEvidence, "evidence"),
    evaluators: parseRecords(
      input.evaluators,
      (value) => {
        const child = outcomeObject(value, "child evaluator");
        const parent = history.find(
          (entry) => entry.contract.digest === child.parentContractDigest,
        )?.contract;
        if (!parent) throw new Error("Evaluator's parent authorization is missing.");
        return parseOutcomeEvaluator(value, parent);
      },
      "evaluators",
    ),
    legacySources,
    lifecycle: parsedLifecycle,
    adoption,
  };
  for (const execution of state.executions) {
    const reservation = reservations.find((item) => item.id === execution.reservationId);
    if (
      !reservation ||
      reservation.specificationDigest !== execution.action.digest ||
      reservation.contractDigest !== execution.authorizationDigest ||
      reservation.worktree !== execution.worktree
    )
      throw new Error("Execution does not match its durable reservation.");
    if (!state.investigations.some((item) => item.id === execution.action.investigation.id))
      throw new Error("Execution refers to an unknown investigation.");
  }
  for (const evidence of state.evidence) {
    if (!state.executions.some((execution) => execution.id === evidence.executionId))
      throw new Error("Evidence has no execution receipt.");
    if (
      evidence.dependencies.evidence.some((id) => !state.evidence.some((entry) => entry.id === id))
    )
      throw new Error("Evidence dependency is missing.");
  }
  outcomeUsage(state);
  return state;
}

function parseRecords<T extends { id: string }>(
  value: unknown,
  parser: (value: unknown) => T,
  label: string,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const records = value.map(parser);
  if (new Set(records.map((record) => record.id)).size !== records.length)
    throw new Error(`Duplicate ${label} identities.`);
  return records;
}
