import type { ExperimentContract as AcceptedExperimentContract } from "./experiment-contract.js";

export type SessionRelation = "none" | "matching" | "unrelated" | "replacement-requested";

export type ContractField =
  | "goal"
  | "repository"
  | "evaluator"
  | "checks"
  | "benchmark_command"
  | "metric_name"
  | "metric_unit"
  | "direction"
  | "checks_command"
  | "scope"
  | "max_iterations";

export interface ExperimentContractCandidate {
  goal: string;
  benchmarkCommand: string;
  metricName: string;
  metricUnit: string;
  direction: "lower" | "higher";
  checksCommand: string;
  filesInScope: string[];
  commitPaths?: string[];
  maxIterations: number;
}

/** @deprecated Use ExperimentContractCandidate for fit-gate output. */
export type ExperimentContract = ExperimentContractCandidate;

export interface ContractConflict {
  field: ContractField | string;
  existing?: string | string[] | number;
  requested?: string | string[] | number;
  sources?: string[];
  message?: string;
}

export interface DirectEvidenceCapsule {
  outcome: string;
  mainUncertainty: string;
  cheapestDiscriminatingEvidence: string;
  directAction: string;
  verification: string;
  claimBoundary: string;
}

export interface DirectAction {
  kind: "direct-evidence";
  capsule: DirectEvidenceCapsule;
}

export interface LoopAction {
  kind: "contract-candidate";
  message: string;
}

export interface AskAction {
  kind: "clarify-fit";
  question: string;
  discovery?: {
    mode: "read-only";
    fields: ContractField[];
    maxFiles: number;
    maxBytes: number;
    accepted: false;
  };
}

export type FitDecision =
  | {
      disposition: "continue-direct";
      mode: "assist-only";
      sessionRelation: "none" | "matching" | "unrelated";
      reasons: string[];
      nextAction: DirectAction;
    }
  | {
      disposition: "run-loop";
      mode: "full-loop";
      sessionRelation: "none" | "matching" | "replacement-requested";
      contract: ExperimentContractCandidate;
      nextAction: LoopAction;
    }
  | {
      disposition: "needs-user";
      mode: null;
      sessionRelation: SessionRelation;
      reasons: string[];
      missing: ContractField[];
      conflicts: ContractConflict[];
      nextAction: AskAction;
    };

export interface LegacySessionMetadata {
  status: "complete" | "incomplete";
  name: string;
  compatibility: {
    status: "verified";
    contractDigest: string;
    repositoryIdentity: string;
    worktreeIdentity: string;
    evaluatorExecutionDigest: string;
    checkExecutionDigests: string[];
    scopeDigest: string;
  } | null;
  compatibilityConflicts: ContractConflict[];
  contract:
    | (Omit<ExperimentContractCandidate, "maxIterations"> & { maxIterations?: number })
    | null;
}

export interface FitInput {
  prompt: string;
  session: LegacySessionMetadata | null;
}

const REQUIRED_FIELDS: ContractField[] = [
  "benchmark_command",
  "metric_name",
  "direction",
  "checks_command",
  "scope",
  "max_iterations",
];

export function adaptLegacySessionMetadata(
  config: Record<string, unknown>,
): LegacySessionMetadata | null {
  if (Object.keys(config).length === 0) return null;

  const name = text(config.name);
  const goal = text(config.goal);
  const benchmarkCommand = text(config.benchmarkCommand ?? config.benchmark_command);
  const metricName = text(config.metricName ?? config.metric_name);
  const metricUnit = text(config.metricUnit ?? config.metric_unit);
  const direction = directionValue(config.bestDirection ?? config.direction);
  const checksCommand = text(config.checksCommand ?? config.checks_command);
  const filesInScope = stringList(config.filesInScope ?? config.files_in_scope);
  const commitPaths = stringList(config.commitPaths ?? config.commit_paths);
  const maxIterations = positiveInteger(config.maxIterations ?? config.max_iterations);
  const complete = Boolean(
    name &&
    goal &&
    benchmarkCommand &&
    metricName &&
    direction &&
    checksCommand &&
    filesInScope.length,
  );

  return {
    status: complete ? "complete" : "incomplete",
    name,
    compatibility: null,
    compatibilityConflicts: [],
    contract: complete
      ? {
          goal,
          benchmarkCommand,
          metricName,
          metricUnit,
          direction: direction as ExperimentContractCandidate["direction"],
          checksCommand,
          filesInScope,
          ...(commitPaths.length ? { commitPaths } : {}),
          ...(maxIterations ? { maxIterations } : {}),
        }
      : null,
  };
}

export function adaptAcceptedSessionMetadata(
  config: Record<string, unknown>,
  accepted: AcceptedExperimentContract,
): LegacySessionMetadata {
  const direction =
    accepted.metric.kind === "minimize"
      ? "lower"
      : accepted.metric.kind === "maximize"
        ? "higher"
        : "";
  const authoritativeChecks = accepted.checks.filter(
    (check) => check.authority === "authoritative",
  );
  const maxIterations = positiveInteger(
    config.maxIterations ?? config.max_iterations ?? accepted.stopPolicy.packets.limit,
  );
  const complete = Boolean(direction && authoritativeChecks.length > 0 && maxIterations);
  return {
    status: complete ? "complete" : "incomplete",
    name: text(config.name) || "Autoresearch",
    compatibility: {
      status: "verified",
      contractDigest: accepted.contractDigest,
      repositoryIdentity: accepted.repository.repositoryIdentity,
      worktreeIdentity: accepted.repository.worktreeIdentity,
      evaluatorExecutionDigest: accepted.evaluator.execution.executionDigest,
      checkExecutionDigests: authoritativeChecks
        .map((check) => check.execution.executionDigest)
        .sort(),
      scopeDigest: JSON.stringify({
        editable: [...accepted.scope.editable].sort(),
        protected: [...accepted.scope.protected].sort(),
      }),
    },
    compatibilityConflicts: [],
    contract: complete
      ? {
          goal: accepted.goal.objective,
          benchmarkCommand: executableCommandText(accepted.evaluator.execution.command),
          metricName: accepted.metric.metricName,
          metricUnit: accepted.metric.unit,
          direction: direction as ExperimentContractCandidate["direction"],
          checksCommand: authoritativeChecks
            .map((check) => executableCommandText(check.execution.command))
            .join(" && "),
          filesInScope: accepted.scope.editable,
          commitPaths: accepted.scope.editable,
          maxIterations: maxIterations as number,
        }
      : null,
  };
}

export function withFitCompatibilityConflicts(
  session: LegacySessionMetadata,
  conflicts: ContractConflict[],
): LegacySessionMetadata {
  return { ...session, compatibility: null, compatibilityConflicts: conflicts };
}

export function requestsNamedSessionContinuation(prompt: string, name: string): boolean {
  return explicitlyNamesSession(prompt, name);
}

export function classifyFit({ prompt, session }: FitInput): FitDecision {
  const request = parsePromptContract(prompt);
  const replacementRequested = hasReplacementIntent(prompt, session);
  const loopRequested = hasExplicitRepeatedMeasuredLoop(prompt);
  const sessionRelation = relationForDirectRequest(prompt, session);

  if (!loopRequested) return directDecision(sessionRelation);

  const missing = missingFields(request);
  const matchingSession = matchingLegacySession(prompt, request, session);

  if (replacementRequested) {
    if (missing.length) return clarificationDecision("replacement-requested", missing, []);
    return loopDecision("replacement-requested", completeContract(request));
  }

  if (matchingSession) {
    const contract = completeLegacyContract(matchingSession.contract, request.maxIterations);
    if (!contract) return clarificationDecision("unrelated", ["max_iterations"], []);
    return loopDecision("matching", contract);
  }

  if (session?.status === "complete" && session.contract) {
    const conflicts = [
      ...session.compatibilityConflicts,
      ...contractConflicts(
        session.contract,
        request,
        explicitlyNamesSession(prompt, session.name) ? continuationGoal(prompt, session.name) : "",
      ),
    ];
    if (conflicts.length) return clarificationDecision("unrelated", missing, conflicts);
    return clarificationDecision("unrelated", missing, []);
  }

  if (session?.status === "incomplete") {
    return clarificationDecision("unrelated", missing, session.compatibilityConflicts);
  }

  return missing.length
    ? clarificationDecision("none", missing, [])
    : loopDecision("none", completeContract(request));
}

function directDecision(sessionRelation: "none" | "matching" | "unrelated"): FitDecision {
  const capsule: DirectEvidenceCapsule = {
    outcome: "Treat the request as direct work, not an Autoresearch loop.",
    mainUncertainty: "Whether repeated measurement would change the recommended direct action.",
    cheapestDiscriminatingEvidence:
      "Inspect the named surface and run its smallest relevant existing check, if one exists.",
    directAction: "Answer or implement the bounded request directly.",
    verification:
      "Verify the requested result on the affected surface before making a broader claim.",
    claimBoundary:
      "Do not claim a measured improvement, benchmark result, or reusable session contract.",
  };
  return {
    disposition: "continue-direct",
    mode: "assist-only",
    sessionRelation,
    reasons: ["The prompt does not explicitly request a repeated measured optimization loop."],
    nextAction: { kind: "direct-evidence", capsule },
  };
}

function loopDecision(
  sessionRelation: "none" | "matching" | "replacement-requested",
  contract: ExperimentContractCandidate,
): FitDecision {
  return {
    disposition: "run-loop",
    mode: "full-loop",
    sessionRelation,
    contract,
    nextAction: {
      kind: "contract-candidate",
      message:
        "This is an in-memory candidate only. Establish it through setup or an explicit segment transition, then execute only after state reports an accepted contract.",
    },
  };
}

function clarificationDecision(
  sessionRelation: SessionRelation,
  missing: ContractField[],
  conflicts: ContractConflict[],
): FitDecision {
  const reasons = [
    ...(missing.length ? [`The loop request is missing: ${missing.join(", ")}.`] : []),
    ...(conflicts.length
      ? ["The requested loop conflicts with the active session; explicit replacement is required."]
      : []),
  ];
  if (!reasons.length)
    reasons.push("The active session cannot be proven compatible with this loop.");
  return {
    disposition: "needs-user",
    mode: null,
    sessionRelation,
    reasons,
    missing,
    conflicts,
    nextAction: {
      kind: "clarify-fit",
      question:
        conflicts.length || !missing.length
          ? "Name the session to continue, or explicitly request a replacement contract."
          : `Confirm the missing contract fields: ${missing.join(", ")}.`,
      ...(sessionRelation === "none" || sessionRelation === "replacement-requested"
        ? {
            discovery: {
              mode: "read-only" as const,
              fields: missing.filter((field) =>
                ["benchmark_command", "checks_command", "scope"].includes(field),
              ),
              maxFiles: 5,
              maxBytes: 64 * 1024,
              accepted: false as const,
            },
          }
        : {}),
    },
  };
}

function relationForDirectRequest(
  prompt: string,
  session: LegacySessionMetadata | null,
): "none" | "matching" | "unrelated" {
  if (!session) return "none";
  return session.status === "complete" &&
    session.compatibility?.status === "verified" &&
    explicitlyNamesSession(prompt, session.name)
    ? "matching"
    : "unrelated";
}

function matchingLegacySession(
  prompt: string,
  request: PromptContract,
  session: LegacySessionMetadata | null,
): LegacySessionMetadata | null {
  if (session?.status !== "complete" || !session.contract) return null;
  if (session.compatibility?.status !== "verified") return null;
  const conflicts = contractConflicts(
    session.contract,
    request,
    continuationGoal(prompt, session.name),
  );
  if (explicitlyNamesSession(prompt, session.name)) return conflicts.length === 0 ? session : null;
  return null;
}

function explicitlyNamesSession(prompt: string, name: string): boolean {
  const trimmedName = name.trim();
  if (!trimmedName || !/\bcontinue\b/i.test(prompt)) return false;
  const escapedName = escapeRegExp(trimmedName);
  return new RegExp(
    `(?:["']${escapedName}["']|\\bsession\\s+(?:named\\s+)?${escapedName}\\b)`,
    "i",
  ).test(prompt);
}

function hasReplacementIntent(prompt: string, session: LegacySessionMetadata | null): boolean {
  if (
    /\b(?:replace|abandon)\s+(?:the\s+)?(?:active|current)\s+(?:autoresearch\s+)?session\b/i.test(
      prompt,
    ) ||
    /\bstart(?:ing)?\s+(?:a\s+)?new\s+(?:autoresearch\s+)?session\b/i.test(prompt)
  ) {
    return true;
  }
  const name = session?.name.trim();
  if (!name) return false;
  const escapedName = escapeRegExp(name);
  return new RegExp(
    `\\b(?:replace|abandon)\\s+(?:the\\s+)?(?:["']${escapedName}["']|(?:autoresearch\\s+)?session\\s+(?:named\\s+)?${escapedName})\\b`,
    "i",
  ).test(prompt);
}

function hasExplicitRepeatedMeasuredLoop(prompt: string): boolean {
  const instructionText = prompt
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:Benchmark|Metric|Checks|Scope):/i.test(line))
    .join("\n");
  if (
    /^\s*(?:explain|describe|review|critique|audit|summari[sz]e|how\b|why\b)/i.test(
      instructionText,
    ) ||
    /\b(?:do not|don't|never)\s+(?:run|start|execute|perform|continue)\b/i.test(instructionText) ||
    /\bread[ -]only\b/i.test(instructionText)
  ) {
    return false;
  }
  const loopRequest =
    /\b(?:run(?:ning)?|continue|start|perform|execute|repeat(?:ed)?)\b[^.\n]{0,96}\b(?:loop|iterations?)\b/i.test(
      prompt,
    );
  const measured =
    /\b(?:measured|measure|benchmark|metric|optimi[sz](?:e|ation)?|improv(?:e|ement))\b/i.test(
      prompt,
    );
  const boundedPluginRequest =
    /^\s*(?:\/goal\s+)?@Codex Autoresearch\b/i.test(prompt) &&
    /^Benchmark:\s*\S+/im.test(prompt) &&
    /^Metric:\s*\S+/im.test(prompt) &&
    /^Checks:\s*\S+/im.test(prompt) &&
    /^Scope:\s*\S+/im.test(prompt) &&
    /\bstop after\s+\d+\s+(?:attempts?|iterations?|runs?|packets?)\b/i.test(prompt);
  return (loopRequest && measured) || boundedPluginRequest;
}

interface PromptContract {
  goal: string;
  benchmarkCommand: string;
  metricName: string;
  metricUnit: string;
  direction: "lower" | "higher" | "";
  checksCommand: string;
  filesInScope: string[];
  maxIterations: number | null;
}

function parsePromptContract(prompt: string): PromptContract {
  const field = (name: string) => {
    const match = prompt.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
    return match?.[1]?.trim() || "";
  };
  const metricText = field("Metric");
  const metricMatch = metricText.match(
    /^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s*\(([^)]+)\))?(?:\s*,\s*(lower|higher)\s+is\s+better)?/i,
  );
  return {
    goal: prompt
      .split(/\r?\n/)
      .filter((line) => !/^(?:Benchmark|Metric|Checks|Scope):/i.test(line))
      .join(" ")
      .trim(),
    benchmarkCommand: field("Benchmark"),
    metricName: metricMatch?.[1] || "",
    metricUnit: metricMatch?.[2] || "",
    direction: directionValue(metricMatch?.[3]) || "",
    checksCommand: field("Checks"),
    filesInScope: splitList(field("Scope")),
    maxIterations: iterationCount(prompt),
  };
}

function missingFields(contract: PromptContract): ContractField[] {
  return REQUIRED_FIELDS.filter((field) => {
    if (field === "benchmark_command") return !contract.benchmarkCommand;
    if (field === "metric_name") return !contract.metricName;
    if (field === "direction") return !contract.direction;
    if (field === "checks_command") return !contract.checksCommand;
    if (field === "scope") return contract.filesInScope.length === 0;
    return !contract.maxIterations;
  });
}

function isComplete(contract: PromptContract): boolean {
  return missingFields(contract).length === 0;
}

function completeContract(contract: PromptContract): ExperimentContractCandidate {
  if (!isComplete(contract) || !contract.direction || !contract.maxIterations) {
    throw new Error("Cannot build a complete contract from incomplete prompt fields.");
  }
  return {
    goal: contract.goal,
    benchmarkCommand: contract.benchmarkCommand,
    metricName: contract.metricName,
    metricUnit: contract.metricUnit,
    direction: contract.direction,
    checksCommand: contract.checksCommand,
    filesInScope: contract.filesInScope,
    maxIterations: contract.maxIterations,
  };
}

function completeLegacyContract(
  contract: LegacySessionMetadata["contract"],
  maxIterations: number | null,
): ExperimentContractCandidate | null {
  if (!contract) return null;
  const iterations = maxIterations ?? contract.maxIterations;
  if (!iterations) return null;
  return { ...contract, maxIterations: iterations };
}

function contractConflicts(
  existing: LegacySessionMetadata["contract"],
  requested: PromptContract,
  requestedGoal = "",
): ContractConflict[] {
  if (!existing) return [];
  const pairs: Array<[ContractField, string | string[] | number, string | string[] | number]> = [];
  if (requestedGoal && normalizeGoal(requestedGoal) !== normalizeGoal(existing.goal)) {
    pairs.push(["goal", existing.goal, requestedGoal]);
  }
  if (requested.benchmarkCommand && requested.benchmarkCommand !== existing.benchmarkCommand) {
    pairs.push(["benchmark_command", existing.benchmarkCommand, requested.benchmarkCommand]);
  }
  if (requested.metricName && requested.metricName !== existing.metricName) {
    pairs.push(["metric_name", existing.metricName, requested.metricName]);
  }
  if (requested.metricUnit && requested.metricUnit !== existing.metricUnit) {
    pairs.push(["metric_unit", existing.metricUnit, requested.metricUnit]);
  }
  if (requested.direction && requested.direction !== existing.direction) {
    pairs.push(["direction", existing.direction, requested.direction]);
  }
  if (requested.checksCommand && requested.checksCommand !== existing.checksCommand) {
    pairs.push(["checks_command", existing.checksCommand, requested.checksCommand]);
  }
  if (
    requested.filesInScope.length &&
    JSON.stringify(requested.filesInScope) !== JSON.stringify(existing.filesInScope)
  ) {
    pairs.push(["scope", existing.filesInScope, requested.filesInScope]);
  }
  if (
    requested.maxIterations &&
    existing.maxIterations &&
    requested.maxIterations !== existing.maxIterations
  ) {
    pairs.push(["max_iterations", existing.maxIterations, requested.maxIterations]);
  }
  return pairs.map(([field, current, requestedValue]) => ({
    field,
    existing: current,
    requested: requestedValue,
  }));
}

function continuationGoal(prompt: string, sessionName: string): string {
  const explicitGoal = prompt.match(/^Goal:\s*(.+)$/im)?.[1]?.trim();
  if (explicitGoal) return explicitGoal;
  const prose = prompt
    .split(/\r?\n/)
    .filter((line) => !/^(?:Goal|Benchmark|Metric|Checks|Scope):/i.test(line))
    .join(" ");
  const index = prose.toLowerCase().indexOf(sessionName.toLowerCase());
  if (index < 0) return "";
  return prose
    .slice(index + sessionName.length)
    .replace(/^["']?\s*(?:autoresearch\s+)?session\b/i, "")
    .replace(
      /\b(?:for\s+)?\d{1,4}\s+(?:repeated\s+)?(?:measured\s+)?(?:optimization\s+)?(?:iterations?|runs?|packets?)\b/gi,
      " ",
    )
    .replace(/[.;,:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGoal(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function executableCommandText(
  command: AcceptedExperimentContract["evaluator"]["execution"]["command"],
): string {
  return command.kind === "shell"
    ? command.script
    : [command.executable, ...command.args].join(" ");
}

function iterationCount(prompt: string): number | null {
  const match = prompt.match(
    /\b(\d{1,4})\b(?=[^.\n]{0,64}\b(?:times|attempts?|iterations?|runs?|packets?)\b)/i,
  );
  return positiveInteger(match?.[1]);
}

function directionValue(value: unknown): "lower" | "higher" | "" {
  const normalized = text(value).toLowerCase();
  return normalized === "lower" || normalized === "higher" ? normalized : "";
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function splitList(value: unknown): string[] {
  return text(value)
    .split(/\r?\n|,|;|\band\b/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return splitList(value);
}

function text(value: unknown): string {
  return String(value || "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
