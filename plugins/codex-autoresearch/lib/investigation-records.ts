import type { CriterionDependencyIdentity } from "./outcome-evidence.js";
import {
  OUTCOME_EFFECTS,
  hashOutcomeValue,
  outcomeDigest,
  outcomeEnum,
  outcomeId,
  outcomeNumber,
  outcomeObject,
  outcomeString,
  outcomeStrings,
  outcomeTimestamp,
  pathsOverlap,
  type OutcomeContract,
  type OutcomeEffect,
} from "./outcome-contract.js";
import { normalizeRelativePaths } from "./literal-paths.js";
import { isResultSemantics, type ResultSemantics } from "./result-semantics.js";

export interface InvestigationRecord {
  id: string;
  question: string;
  intervention: string;
  distinguishingObservations: string[];
  evidenceRefs: string[];
  retryAllowance: number;
  resolution: "active" | "supported" | "refuted" | "inconclusive" | "exhausted";
  resolutionEvidence: string[];
}

export type EvaluatorMethod =
  | { kind: "predicate" }
  | {
      kind: "metric";
      name: string;
      direction: "lower" | "higher";
      minimumImprovement: number;
      tolerance: number;
      target: null | { comparator: "<" | "<=" | "=" | ">=" | ">"; value: number };
    };

export interface OutcomeEvaluator {
  id: string;
  parentContractDigest: string;
  criterionIds: string[];
  method: EvaluatorMethod;
  repeats: number;
  argv: string[];
  checkArgv: string[];
  environment: string;
  digest: string;
}

export interface ActionSpecification {
  id: string;
  investigation: Omit<InvestigationRecord, "resolution" | "resolutionEvidence">;
  purpose: "preparation" | "experiment" | "repair" | "confirmation" | "delivery";
  effects: OutcomeEffect[];
  paths: string[];
  environment: string;
  seconds: number;
  mode: "managed" | "process" | "github-actions";
  argv: string[];
  evaluator: OutcomeEvaluator | null;
  repairOf: string | null;
  evidenceRefs: string[];
  digest: string;
}

export interface InputFingerprint {
  digest: string;
  files: Record<string, string>;
  links: Record<string, string>;
  environment: string;
}

export type ExecutionStatus =
  | { kind: "preparing"; startedAt: string }
  | { kind: "ticket"; issuedAt: string }
  | { kind: "launching"; nominatedAt: string }
  | { kind: "running"; pid: number; identity: string; startedAt: string; progressAt: string }
  | {
      kind: "completed" | "failed" | "cancelled";
      completedAt: string;
      exitCode: number | null;
      failureId: string | null;
      failureStage: "preparation" | "execution" | null;
    }
  | { kind: "unknown"; reason: string; lastKnownPid: number | null };

export interface ExecutionReceipt {
  id: string;
  authorizationDigest: string;
  action: ActionSpecification;
  worktree: string;
  input: InputFingerprint | null;
  reservationId: string;
  token: string;
  status: ExecutionStatus;
  outputs: Array<{ path: string; digest: string }>;
  result: ResultSemantics | null;
  observation:
    | null
    | { kind: "predicate"; observed: "satisfied" | "counterexample" | "inconclusive" }
    | { kind: "metric"; value: number };
  checksPassed: boolean | null;
  consumptionSource:
    | "reserved"
    | "worker-wall-clock"
    | "ticket-wall-clock"
    | "provider"
    | "unknown";
  completedInput: InputFingerprint | null;
}

export interface InvestigationEvidence {
  id: string;
  specificationDigest: string;
  executionId: string;
  criterionId: string;
  text: string;
  relation: "supports" | "contradicts" | "inconclusive";
  result: ResultSemantics;
  dependencies: CriterionDependencyIdentity & { evidence: string[] };
  historicalValidity: "valid" | "invalid" | "unknown";
  limitations: string[];
  provenance: "operator-observation" | "worker" | "github-actions";
  measurementId: string;
  independent: boolean;
  createdAt: string;
}

export function boundedCount(value: unknown, label: string, minimum = 0): number {
  const count = outcomeNumber(value, label, minimum);
  if (!Number.isSafeInteger(count)) throw new Error(`${label} must be a safe integer.`);
  return count;
}

export function parseInvestigation(value: unknown): InvestigationRecord {
  const input = outcomeObject(value, "investigation");
  return {
    id: outcomeId(input.id),
    question: outcomeString(input.question, "question"),
    intervention: outcomeString(input.intervention, "intervention"),
    distinguishingObservations: outcomeStrings(
      input.distinguishingObservations,
      "distinguishing observations",
    ),
    evidenceRefs: outcomeStrings(
      input.evidenceRefs ?? [],
      "investigation evidence references",
      true,
    ),
    retryAllowance: boundedCount(input.retryAllowance ?? 1, "repair allowance"),
    resolution: outcomeEnum(
      input.resolution ?? "active",
      ["active", "supported", "refuted", "inconclusive", "exhausted"],
      "resolution",
    ),
    resolutionEvidence: outcomeStrings(input.resolutionEvidence ?? [], "resolution evidence", true),
  };
}

export function parseOutcomeEvaluator(value: unknown, parent: OutcomeContract): OutcomeEvaluator {
  const input = outcomeObject(value, "evaluator");
  const rawMethod = outcomeObject(input.method, "evaluator method");
  let method: EvaluatorMethod;
  if (rawMethod.kind === "predicate") method = { kind: "predicate" };
  else if (rawMethod.kind === "metric") {
    const rawTarget = rawMethod.target == null ? null : outcomeObject(rawMethod.target, "target");
    method = {
      kind: "metric",
      name: outcomeId(rawMethod.name, "metric name"),
      direction: outcomeEnum(rawMethod.direction, ["lower", "higher"], "metric direction"),
      minimumImprovement: outcomeNumber(rawMethod.minimumImprovement ?? 0, "minimum improvement"),
      tolerance: outcomeNumber(rawMethod.tolerance ?? 0, "metric tolerance"),
      target:
        rawTarget === null
          ? null
          : {
              comparator: outcomeEnum(
                rawTarget.comparator,
                ["<", "<=", "=", ">=", ">"],
                "target comparator",
              ),
              value: finiteMetric(rawTarget.value),
            },
    };
  } else throw new Error("Evaluator must be metric or predicate.");
  const criterionIds = outcomeStrings(input.criterionIds, "evaluator criteria");
  if (criterionIds.some((id) => !parent.criteria.some((criterion) => criterion.id === id)))
    throw new Error("Evaluator claims criteria outside the outcome.");
  const environment = outcomeString(input.environment, "evaluator environment");
  if (!parent.authorization.environments.includes(environment))
    throw new Error("Evaluator environment is outside the grant.");
  const body: Omit<OutcomeEvaluator, "digest"> = {
    id: outcomeId(input.id),
    parentContractDigest: parent.digest,
    criterionIds,
    method,
    repeats: boundedCount(input.repeats ?? 1, "required repeats", 1),
    argv: commandArgv(input.argv),
    checkArgv: commandArgv(input.checkArgv),
    environment,
  };
  return verifyDigest(body, input.digest);
}

export function parseActionSpecification(
  value: unknown,
  parent: OutcomeContract,
): ActionSpecification {
  const input = outcomeObject(value, "action specification");
  const investigation = parseInvestigation(input.investigation);
  if (investigation.resolution !== "active" || investigation.resolutionEvidence.length)
    throw new Error("Action proposals cannot pre-resolve their investigation.");
  const effects = outcomeStrings(input.effects, "action effects").map((effect) =>
    outcomeEnum(effect, OUTCOME_EFFECTS, "action effect"),
  );
  if (effects.some((effect) => !parent.authorization.effects.includes(effect)))
    throw new Error("Action effects exceed accepted authorization.");
  const paths = normalizeRelativePaths(
    outcomeStrings(input.paths ?? [], "action paths", true),
    "action paths",
  );
  if (
    paths.some((item) => parent.authorization.protected.some((guard) => pathsOverlap(item, guard)))
  )
    throw new Error("Action paths overlap protected scope.");
  if (
    effects.some((effect) => effect === "edit" || effect === "git") &&
    (!paths.length ||
      paths.some(
        (item) =>
          !parent.authorization.editable.some(
            (scope) => scope === "." || scope === item || item.startsWith(`${scope}/`),
          ),
      ))
  )
    throw new Error("Editing and Git actions need paths within the parent's editable scope.");
  const environment = outcomeString(input.environment, "action environment");
  if (!parent.authorization.environments.includes(environment))
    throw new Error("Action environment exceeds accepted authorization.");
  const mode = outcomeEnum(input.mode, ["managed", "process", "github-actions"], "action mode");
  if (mode !== "managed" && !effects.includes("execute"))
    throw new Error("Execution requires the execute effect.");
  const argv = commandArgv(input.argv);
  const evaluator = input.evaluator == null ? null : parseOutcomeEvaluator(input.evaluator, parent);
  if (evaluator && evaluator.environment !== environment)
    throw new Error("Evaluator and action environments differ.");
  if (mode === "process" && argv.length === 0 && !evaluator?.argv.length)
    throw new Error("A process action needs an explicit executable and arguments.");
  if (
    evaluator?.argv.length &&
    argv.length &&
    hashOutcomeValue(argv) !== hashOutcomeValue(evaluator.argv)
  )
    throw new Error("Execution argv differs from the immutable evaluator.");
  const purpose = outcomeEnum(
    input.purpose,
    ["preparation", "experiment", "repair", "confirmation", "delivery"],
    "action purpose",
  );
  const repairOf = input.repairOf == null ? null : outcomeId(input.repairOf, "repair execution");
  if ((purpose === "repair") !== (repairOf !== null))
    throw new Error("Repair actions must identify the failed execution.");
  const {
    resolution: _resolution,
    resolutionEvidence: _resolutionEvidence,
    ...proposal
  } = investigation;
  return verifyDigest(
    {
      id: outcomeId(input.id),
      investigation: proposal,
      purpose,
      effects,
      paths,
      environment,
      seconds: outcomeNumber(input.seconds, "action seconds", Number.MIN_VALUE),
      mode,
      argv,
      evaluator,
      repairOf,
      evidenceRefs: outcomeStrings(input.evidenceRefs ?? [], "action evidence references", true),
    },
    input.digest,
  );
}

export function parseInputFingerprint(value: unknown): InputFingerprint {
  const input = outcomeObject(value, "input fingerprint");
  const entries = outcomeObject(input.files, "input files");
  const files = Object.fromEntries(
    Object.entries(entries).map(([file, digest]) => [file, outcomeDigest(digest)]),
  );
  const links = Object.fromEntries(
    Object.entries(outcomeObject(input.links, "input links")).map(([file, target]) => {
      const relative = outcomeString(target, "input link target");
      if (
        normalizeRelativePaths([file, relative], "input link paths").length !== 2 ||
        !Object.hasOwn(files, file)
      )
        throw new Error("Input link identity is outside its file inventory.");
      return [file, relative];
    }),
  );
  const environment = outcomeDigest(input.environment, "environment fingerprint");
  const digest = outcomeDigest(input.digest, "input digest");
  if (digest !== hashOutcomeValue({ files, links, environment }))
    throw new Error("Input fingerprint does not match its inventory.");
  return { files, links, environment, digest };
}

export function parseExecutionStatus(value: unknown): ExecutionStatus {
  const input = outcomeObject(value, "execution status");
  switch (input.kind) {
    case "preparing":
      return {
        kind: "preparing",
        startedAt: outcomeTimestamp(input.startedAt, "preparation time"),
      };
    case "ticket":
      return { kind: "ticket", issuedAt: outcomeTimestamp(input.issuedAt, "ticket time") };
    case "launching":
      return {
        kind: "launching",
        nominatedAt: outcomeTimestamp(input.nominatedAt, "nomination time"),
      };
    case "running":
      return {
        kind: "running",
        pid: boundedCount(input.pid, "worker PID", 1),
        identity: outcomeString(input.identity, "worker identity"),
        startedAt: outcomeTimestamp(input.startedAt, "start time"),
        progressAt: outcomeTimestamp(input.progressAt, "progress time"),
      };
    case "completed":
    case "failed":
    case "cancelled":
      return {
        kind: input.kind,
        completedAt: outcomeTimestamp(input.completedAt, "completion time"),
        exitCode: input.exitCode === null ? null : boundedCount(input.exitCode, "exit code"),
        failureId:
          input.failureId === null ? null : outcomeDigest(input.failureId, "failure identity"),
        failureStage:
          input.kind === "failed"
            ? outcomeEnum(input.failureStage, ["preparation", "execution"], "failure stage")
            : null,
      };
    case "unknown":
      return {
        kind: "unknown",
        reason: outcomeString(input.reason, "unknown execution reason"),
        lastKnownPid:
          input.lastKnownPid === null ? null : boundedCount(input.lastKnownPid, "last PID", 1),
      };
    default:
      throw new Error("Unsupported execution status.");
  }
}

export function parseExecutionReceipt(
  value: unknown,
  history: OutcomeContract[],
): ExecutionReceipt {
  const input = outcomeObject(value, "execution receipt");
  const authorizationDigest = outcomeDigest(input.authorizationDigest);
  const parent = history.find((contract) => contract.digest === authorizationDigest);
  if (!parent) throw new Error("Execution has no recorded authorization.");
  const action = parseActionSpecification(input.action, parent);
  if (input.id !== action.id || input.reservationId !== action.id)
    throw new Error("Execution and reservation identities differ.");
  const worktree = outcomeString(input.worktree, "execution worktree");
  if (!parent.authorization.worktrees.includes(worktree))
    throw new Error("Execution worktree is outside its recorded grant.");
  if (!Array.isArray(input.outputs)) throw new Error("Execution outputs must be an array.");
  const result = input.result === null ? null : parseResult(input.result);
  const rawObservation =
    input.observation === null ? null : outcomeObject(input.observation, "execution observation");
  const observation: ExecutionReceipt["observation"] =
    rawObservation === null
      ? null
      : rawObservation.kind === "predicate"
        ? {
            kind: "predicate",
            observed: outcomeEnum(
              rawObservation.observed,
              ["satisfied", "counterexample", "inconclusive"],
              "predicate observation",
            ),
          }
        : rawObservation.kind === "metric"
          ? { kind: "metric", value: finiteMetric(rawObservation.value) }
          : (() => {
              throw new Error("Unsupported execution observation.");
            })();
  if (input.checksPassed !== null && typeof input.checksPassed !== "boolean")
    throw new Error("Check result must be boolean or unknown.");
  return {
    id: action.id,
    authorizationDigest,
    action,
    worktree,
    input: input.input === null ? null : parseInputFingerprint(input.input),
    reservationId: action.id,
    token: outcomeString(input.token, "execution token"),
    status: parseExecutionStatus(input.status),
    outputs: input.outputs.map((value) => {
      const output = outcomeObject(value, "execution output");
      return {
        path: outcomeString(output.path, "output path"),
        digest: outcomeDigest(output.digest),
      };
    }),
    result,
    observation,
    checksPassed: input.checksPassed,
    consumptionSource: outcomeEnum(
      input.consumptionSource,
      ["reserved", "worker-wall-clock", "ticket-wall-clock", "provider", "unknown"],
      "consumption source",
    ),
    completedInput:
      input.completedInput === null ? null : parseInputFingerprint(input.completedInput),
  };
}

export function parseInvestigationEvidence(value: unknown): InvestigationEvidence {
  const input = outcomeObject(value, "investigation evidence");
  const dependencies = outcomeObject(input.dependencies, "evidence dependencies");
  if (typeof input.independent !== "boolean")
    throw new Error("Evidence independence must be explicit.");
  return {
    id: outcomeId(input.id),
    specificationDigest: outcomeDigest(input.specificationDigest),
    executionId: outcomeId(input.executionId),
    criterionId: outcomeId(input.criterionId),
    text: outcomeString(input.text, "observation"),
    relation: outcomeEnum(
      input.relation,
      ["supports", "contradicts", "inconclusive"],
      "criterion relation",
    ),
    result: parseResult(input.result),
    dependencies: {
      source: outcomeDigest(dependencies.source),
      subject: outcomeDigest(dependencies.subject),
      evaluator: outcomeDigest(dependencies.evaluator),
      fixtures: outcomeDigest(dependencies.fixtures),
      environment: outcomeDigest(dependencies.environment),
      checks: outcomeDigest(dependencies.checks),
      criterion: outcomeDigest(dependencies.criterion),
      evidence: outcomeStrings(dependencies.evidence, "evidence dependencies", true),
    },
    historicalValidity: outcomeEnum(
      input.historicalValidity,
      ["valid", "invalid", "unknown"],
      "historical validity",
    ),
    limitations: outcomeStrings(input.limitations, "evidence limitations", true),
    provenance: outcomeEnum(
      input.provenance,
      ["operator-observation", "worker", "github-actions"],
      "evidence provenance",
    ),
    measurementId: outcomeId(input.measurementId),
    independent: input.independent,
    createdAt: outcomeTimestamp(input.createdAt, "evidence time"),
  };
}

export function parseResult(value: unknown): ResultSemantics {
  if (!isResultSemantics(value)) throw new Error("Malformed result dimensions.");
  return {
    execution: value.execution,
    validity: value.validity,
    conclusion: value.conclusion,
    movement: value.movement,
    attainment: value.attainment,
    codeAcceptance: value.codeAcceptance,
  };
}

export function finiteMetric(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Metric observation must be finite.");
  return value;
}

function verifyDigest<T extends object>(body: T, supplied: unknown): T & { digest: string } {
  const digest = hashOutcomeValue(body);
  if (supplied != null && supplied !== digest)
    throw new Error("Immutable record digest does not match its content.");
  return { ...body, digest };
}

function commandArgv(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (item, index) => typeof item !== "string" || item.includes("\0") || (index === 0 && !item),
    )
  )
    throw new Error("Executable arguments must be strings without NUL bytes.");
  return value.map((item) => String(item));
}
