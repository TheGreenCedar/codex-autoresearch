import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { countsTowardPacketBudget } from "./benchmark/budget-contract.js";
import type { CandidateOrigin, EvaluationAuthority, RunPurpose } from "./evidence-axes.js";
export {
  parseEvidenceAxes,
  type CandidateOrigin,
  type EvaluationAuthority,
  type EvidenceAxesParseResult,
  type RunPurpose,
} from "./evidence-axes.js";
import { buildProtectedBenchmarkSnapshot } from "./benchmark/contract-guards.js";
import { parsePorcelainV1Z } from "./git-paths.js";
import { insideGitRepo, runGit } from "./git-private-state.js";
import { normalizeRelativePaths } from "./literal-paths.js";
import { appendJsonl, readJsonl, stateFromSessionRecords } from "./session-core.js";
import {
  AUTORESEARCH_DASHBOARD_FILE,
  AUTORESEARCH_RESEARCH_DIR,
  AUTORESEARCH_SESSION_FILES,
} from "./session-paths.js";
import type { UnknownRecord } from "./types/json.js";

export type ExecutableCommand =
  | { kind: "argv"; executable: string; args: string[] }
  | { kind: "shell"; shell: "bash" | "powershell"; script: string };

export interface GoalSpec {
  objective: string;
  successCriteria: string[];
  claimBoundary: string;
}

export type MetricSemantics =
  | {
      kind: "minimize";
      metricName: string;
      unit: string;
      minimumImprovement: number;
    }
  | {
      kind: "maximize";
      metricName: string;
      unit: string;
      minimumImprovement: number;
    }
  | {
      kind: "threshold";
      metricName: string;
      unit: string;
      comparator: "<" | "<=" | "=" | ">=" | ">";
      target: number;
    };

export type NoiseModel =
  | { kind: "deterministic" }
  | { kind: "bounded"; tolerance: number; repeats: number }
  | { kind: "unknown"; qualificationRepeats: number };

export type TreePolicy =
  | { kind: "require-clean"; outsideEditableFingerprint: string }
  | {
      kind: "initial-dirty";
      fingerprint: string;
      outsideEditableFingerprint: string;
    };

export interface RepositoryContract {
  repositoryIdentity: string;
  worktreeIdentity: string;
  segmentBaseRevision: string;
  expectedHead: string;
  treePolicy: TreePolicy;
}

export interface EnvironmentValueDigest {
  name: string;
  valueDigest: string;
}

export interface ExecutionEnvironment {
  inheritance: "inherit" | "minimal";
  declared: EnvironmentValueDigest[];
  source:
    | { kind: "none" }
    | { kind: "process" }
    | { kind: "file"; path: string; contentDigest: string };
}

export interface ProtectedExecutionInput {
  path: string;
  role:
    | "command-file"
    | "environment-file"
    | "evaluator"
    | "check"
    | "fixture"
    | "dataset"
    | "runner-config";
  contentDigest: string;
}

export interface ParserIdentity {
  id: string;
  version: number;
}

export interface RunnerConfiguration {
  id: "codex-autoresearch";
  version: number;
  metricLimit: number;
}

export interface ExecutionSpec {
  command: ExecutableCommand;
  relativeWorkingDirectory: string;
  environment: ExecutionEnvironment;
  timeoutSeconds: number;
  parser: ParserIdentity;
  protectedInputs: ProtectedExecutionInput[];
  runner: RunnerConfiguration;
  executionDigest: string;
}

export type AcceptedCheck =
  | {
      id: string;
      authority: "authoritative";
      execution: ExecutionSpec;
    }
  | {
      id: string;
      authority: "supplemental";
      reason: string;
      execution: ExecutionSpec;
    };

export type EnforcedBudgetDimension = {
  status: "enforced";
  limit: number;
  telemetry: "plugin" | "trusted-host";
};

export type HostBudgetDimension =
  | EnforcedBudgetDimension
  | { status: "advisory"; limit?: number; reason: string }
  | { status: "unsupported"; reason: string };

export interface ExecutableStopPolicy {
  packets: EnforcedBudgetDimension;
  evaluatorRuns: EnforcedBudgetDimension;
  pluginWallClockSeconds: EnforcedBudgetDimension;
  modelTokens: HostBudgetDimension;
  modelCalls: HostBudgetDimension;
  noLearningPackets: { limit: number };
  repeatedFailures: { limit: number };
}

export interface KeepPolicy {
  requiresAcceptedEvaluation: true;
  requiresAllChecks: true;
  requiresMetricComparison: true;
  requiresNoiseQualification: true;
  authoritativeCheckIds: string[];
}

export interface ExperimentContract {
  schemaVersion: 1;
  goal: GoalSpec;
  repository: RepositoryContract;
  metric: MetricSemantics;
  evaluator: { id: string; execution: ExecutionSpec };
  checks: [AcceptedCheck, ...AcceptedCheck[]];
  scope: { editable: string[]; protected: string[] };
  noise: NoiseModel;
  keepPolicy: KeepPolicy;
  stopPolicy: ExecutableStopPolicy;
  contractDigest: string;
}

export interface ContractMissing {
  field: string;
  message: string;
}

export interface ContractConflict {
  field: string;
  sources: string[];
  message: string;
}

export type ContractDerivation =
  | {
      status: "accepted";
      contract: ExperimentContract;
      missing: [];
      conflicts: [];
      event: ExperimentContractAcceptedEvent;
    }
  | {
      status: "derived";
      contract: ExperimentContract;
      missing: [];
      conflicts: [];
      event: null;
    }
  | {
      status: "invalid";
      contract: null;
      missing: ContractMissing[];
      conflicts: ContractConflict[];
      event: null;
    };

export interface ExperimentContractAcceptedEvent extends UnknownRecord {
  type: "experiment-contract-accepted";
  schemaVersion: 1;
  eventId: string;
  source: "legacy-derivation";
  segment: number;
  timestamp: string;
  contract: ExperimentContract;
}

export type ContractStopDimension =
  | "packets"
  | "evaluatorRuns"
  | "pluginWallClockSeconds"
  | "noLearningPackets"
  | "repeatedFailures";

export type ContractStopStatus =
  | {
      status: "allowed";
      usage: {
        packets: number;
        evaluatorRuns: number;
        pluginWallClockSeconds: number;
        consecutiveNoLearningPackets: number;
        consecutiveFailures: number;
      };
    }
  | {
      status: "exhausted";
      dimension: ContractStopDimension;
      limit: number;
      used: number;
      message: string;
    };

export interface ContractCheckOutcome {
  id: string;
  executionDigest: string;
  passed: boolean;
}

export interface ContractEvaluationEvidence extends UnknownRecord {
  contractDigest: string;
  candidateFingerprint: string;
  acceptedEvaluation: true;
  metric: number;
  checksPassed: true;
}

export interface KeepAuthorizationInput {
  purpose: RunPurpose;
  evaluationAuthority: EvaluationAuthority;
  candidateOrigin: CandidateOrigin;
  acceptedEvaluation: boolean;
  checksPassed: boolean;
  comparisonSatisfied: boolean;
  noiseQualified: boolean;
}

export type ContractKeepEligibility =
  | {
      eligible: true;
      reasons: [];
      completedRepeats: number;
      requiredRepeats: number;
      referenceMetric: number | null;
    }
  | {
      eligible: false;
      reasons: [string, ...string[]];
      completedRepeats: number;
      requiredRepeats: number;
      referenceMetric: number | null;
    };

export interface DeriveExperimentContractInput {
  workDir: string;
  args?: UnknownRecord;
  config?: UnknownRecord;
  entries?: UnknownRecord[];
  packet?: UnknownRecord | null;
  ignoreAccepted?: boolean;
  verifiedEvidencePaths?: string[];
}

const DEFAULT_EVALUATOR_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 300;
const DEFAULT_METRIC_LIMIT = 512;
const MAX_SUPPORTED_METRIC_LIMIT = 4096;
const SESSION_OWNED_DIRS = [
  AUTORESEARCH_RESEARCH_DIR,
  "target/autoresearch",
  ".autoresearch-cache",
];

class ContractFingerprintAuthorityError extends Error {
  readonly field: "candidateFingerprint" | "repository.treePolicy";

  constructor(
    field: "candidateFingerprint" | "repository.treePolicy",
    label: string,
    quarantined: UnknownRecord[],
  ) {
    const reasons = uniqueStrings(
      quarantined.map((item) => String(item.reason || "unknown quarantine").replaceAll("_", " ")),
    );
    super(
      `${label} is incomplete and cannot be authoritative: ${reasons.join(", ") || "quarantined snapshot"}.`,
    );
    this.name = "ContractFingerprintAuthorityError";
    this.field = field;
  }
}

function contractFingerprintConflict(error: unknown, sources: string[]): ContractConflict | null {
  return error instanceof ContractFingerprintAuthorityError
    ? { field: error.field, sources, message: error.message }
    : null;
}

export async function deriveExperimentContract({
  workDir,
  args = {},
  config = {},
  entries = readJsonl(workDir),
  packet = null,
  ignoreAccepted = false,
  verifiedEvidencePaths = [],
}: DeriveExperimentContractInput): Promise<ContractDerivation> {
  const state = stateFromSessionRecords(workDir, entries);
  if (!ignoreAccepted) {
    const event = latestAcceptedEvent(entries, state.segment);
    if (event) {
      const conflicts = await acceptedContractConflicts({
        workDir,
        args,
        config,
        state,
        packet,
        event,
        verifiedEvidencePaths,
      });
      if (conflicts.length > 0) {
        return { status: "invalid", contract: null, missing: [], conflicts, event: null };
      }
      return { status: "accepted", contract: event.contract, missing: [], conflicts: [], event };
    }
  }

  const missing: ContractMissing[] = [];
  const conflicts: ContractConflict[] = [];
  const activeConfigEntry = recordValue(state.activeConfigEntry);
  const ledgerBenchmarkContract = recordValue(activeConfigEntry.benchmarkContract);
  const packetHistory = recordValue(packet?.history);
  const packetBenchmarkContract =
    Number(packetHistory.segment ?? state.segment) === state.segment
      ? recordValue(packetHistory.benchmarkContract)
      : {};
  let evaluatorCandidates: LegacyCommandCandidate[] = [];
  let checksCandidates: LegacyCommandCandidate[] = [];
  try {
    evaluatorCandidates = await evaluatorCommandCandidates({
      workDir,
      args,
      config,
      ledgerCommand: ledgerBenchmarkContract.command ?? activeConfigEntry.benchmarkCommand,
      packetCommand: packetBenchmarkContract.command ?? packetHistory.command,
    });
  } catch (error) {
    conflicts.push({
      field: "evaluator.command",
      sources: ["legacy-boundary"],
      message: errorMessage(error),
    });
  }
  try {
    checksCandidates = await checksCommandCandidates({
      workDir,
      args,
      config,
      ledgerCommand: ledgerBenchmarkContract.checksCommand ?? activeConfigEntry.checksCommand,
      packetCommand: packetBenchmarkContract.checksCommand ?? packetHistory.checksCommand,
    });
  } catch (error) {
    conflicts.push({
      field: "checks.command",
      sources: ["legacy-boundary"],
      message: errorMessage(error),
    });
  }
  const evaluatorResolution = agreedExecutableCommand(
    "evaluator.command",
    evaluatorCandidates,
    conflicts,
  );
  const checksResolution = agreedExecutableCommand("checks.command", checksCandidates, conflicts);
  const evaluatorCommand = evaluatorResolution?.command ?? null;
  const checksCommand = checksResolution?.command ?? null;
  if (
    evaluatorCandidates.length === 0 &&
    !conflicts.some((conflict) => conflict.field === "evaluator.command")
  ) {
    missing.push({ field: "evaluator", message: "No evaluator command was provided." });
  }
  if (
    checksCandidates.length === 0 &&
    !conflicts.some((conflict) => conflict.field === "checks.command")
  ) {
    missing.push({ field: "checks", message: "No checks command was provided." });
  }

  let editable: string[] = [];
  let protectedScope: string[] = [];
  let fixturePaths: string[] = [];
  let datasetPaths: string[] = [];
  let runnerConfigPaths: string[] = [];
  try {
    editable = normalizeRelativePaths(
      config.editableScope ?? config.filesInScope ?? config.commitPaths,
      "editableScope",
    );
    protectedScope = normalizeRelativePaths(
      config.protectedScope ?? config.protectedBenchmarkPaths,
      "protectedScope",
    );
    fixturePaths = normalizeRelativePaths(config.fixturePaths, "fixturePaths");
    datasetPaths = normalizeRelativePaths(config.datasetPaths, "datasetPaths");
    runnerConfigPaths = normalizeRelativePaths(config.runnerConfigPaths, "runnerConfigPaths");
    protectedScope = uniqueStrings([
      ...protectedScope,
      ...fixturePaths,
      ...datasetPaths,
      ...runnerConfigPaths,
      ...(evaluatorResolution?.protectedPaths.map((item) => item.path) ?? []),
      ...(checksResolution?.protectedPaths.map((item) => item.path) ?? []),
    ]);
  } catch (error) {
    conflicts.push({
      field: "scope",
      sources: ["config"],
      message: errorMessage(error),
    });
  }
  if (editable.length === 0 && !conflicts.some((conflict) => conflict.field === "scope")) {
    missing.push({ field: "scope.editable", message: "Editable scope is required." });
  }
  const overlaps = scopeOverlaps(editable, protectedScope);
  if (overlaps.length > 0) {
    conflicts.push({
      field: "scope",
      sources: ["editable", "protected"],
      message: `Editable and protected scope overlap: ${overlaps.join(", ")}.`,
    });
  }
  conflicts.push(
    ...(await legacyRepositoryIdentityConflicts({
      workDir,
      editable,
      config,
      ledgerConfig: state.config,
      packetHistory,
    })),
  );

  const packetLimitResolution = resolveLegacyPositiveInteger({
    field: "stopPolicy.packets",
    sources: [
      {
        name: "arguments",
        record: args,
        keys: ["max_iterations", "maxIterations", "packet_budget", "packetBudget"],
      },
      { name: "config", record: config, keys: ["maxIterations", "packetBudget"] },
    ],
    conflicts,
  });
  const packetLimit = packetLimitResolution.value;
  if (packetLimit == null && !packetLimitResolution.provided) {
    missing.push({ field: "stopPolicy.packets", message: "A packet ceiling is required." });
  }
  let metric: MetricSemantics | null = null;
  try {
    metric = metricSemanticsFromConfig(config.metricSemantics, state.config, config);
  } catch (error) {
    conflicts.push({
      field: "metric",
      sources: ["config"],
      message: errorMessage(error),
    });
  }
  let noise: NoiseModel | null = null;
  try {
    noise = noiseModel(config.noiseModel);
  } catch (error) {
    conflicts.push({
      field: "noise",
      sources: ["config"],
      message: errorMessage(error),
    });
  }
  if (
    missing.length > 0 ||
    conflicts.length > 0 ||
    !evaluatorCommand ||
    !checksCommand ||
    !packetLimit ||
    !metric ||
    !noise
  ) {
    return { status: "invalid", contract: null, missing, conflicts, event: null };
  }

  const repository = await repositoryContract(workDir, editable);
  const environment = await resolveLegacyEnvironment({
    workDir,
    worktreeIdentity: repository.worktreeIdentity,
    args,
    config,
    conflicts,
  });
  const evaluatorTimeoutResolution = resolveLegacyPositiveInteger({
    field: "evaluator.timeoutSeconds",
    sources: [
      {
        name: "arguments",
        record: args,
        keys: ["timeout_seconds", "timeoutSeconds"],
      },
      { name: "config", record: config, keys: ["timeoutSeconds"] },
    ],
    conflicts,
  });
  const checkTimeoutResolution = resolveLegacyPositiveInteger({
    field: "checks.timeoutSeconds",
    sources: [
      {
        name: "arguments",
        record: args,
        keys: ["checks_timeout_seconds", "checksTimeoutSeconds"],
      },
      { name: "config", record: config, keys: ["checksTimeoutSeconds"] },
    ],
    conflicts,
  });
  const evaluatorLimitResolution = resolveLegacyPositiveInteger({
    field: "stopPolicy.evaluatorRuns",
    sources: [
      {
        name: "arguments",
        record: args,
        keys: ["max_evaluator_runs", "maxEvaluatorRuns"],
      },
      { name: "config", record: config, keys: ["maxEvaluatorRuns"] },
    ],
    conflicts,
  });
  const wallClockLimitResolution = resolveLegacyPositiveInteger({
    field: "stopPolicy.pluginWallClockSeconds",
    sources: [
      {
        name: "arguments",
        record: args,
        keys: ["wall_clock_budget_seconds", "wallClockBudgetSeconds"],
      },
      { name: "config", record: config, keys: ["wallClockBudgetSeconds"] },
    ],
    conflicts,
  });
  const noLearningLimitResolution = resolveLegacyPositiveInteger({
    field: "stopPolicy.noLearningPackets",
    sources: [
      {
        name: "arguments",
        record: args,
        keys: ["no_learning_limit", "noLearningLimit"],
      },
      { name: "config", record: config, keys: ["noLearningLimit"] },
    ],
    conflicts,
  });
  const repeatedFailureLimitResolution = resolveLegacyPositiveInteger({
    field: "stopPolicy.repeatedFailures",
    sources: [
      {
        name: "arguments",
        record: args,
        keys: ["repeated_failure_limit", "repeatedFailureLimit"],
      },
      { name: "config", record: config, keys: ["repeatedFailureLimit"] },
    ],
    conflicts,
  });
  const modelTokenLimitResolution = resolveLegacyPositiveInteger({
    field: "stopPolicy.modelTokens",
    sources: [
      {
        name: "arguments",
        record: args,
        keys: ["model_token_budget", "modelTokenBudget"],
      },
      { name: "config", record: config, keys: ["modelTokenBudget"] },
    ],
    conflicts,
  });
  const modelCallLimitResolution = resolveLegacyPositiveInteger({
    field: "stopPolicy.modelCalls",
    sources: [
      {
        name: "arguments",
        record: args,
        keys: ["model_call_budget", "modelCallBudget"],
      },
      { name: "config", record: config, keys: ["modelCallBudget"] },
    ],
    conflicts,
  });
  if (!environment || conflicts.length > 0) {
    return { status: "invalid", contract: null, missing, conflicts, event: null };
  }
  const evaluatorTimeout = evaluatorTimeoutResolution.value ?? DEFAULT_EVALUATOR_TIMEOUT_SECONDS;
  const checkTimeout = checkTimeoutResolution.value ?? DEFAULT_CHECK_TIMEOUT_SECONDS;
  const typedProtectedPathSet = new Set([...fixturePaths, ...datasetPaths, ...runnerConfigPaths]);
  let protectedInputs: ProtectedExecutionInput[];
  let typedProtectedInputs: ProtectedExecutionInput[];
  let evaluatorSourceInputs: ProtectedExecutionInput[];
  let checksSourceInputs: ProtectedExecutionInput[];
  try {
    protectedInputs = await protectedInputsForPaths(
      workDir,
      protectedScope.filter((protectedPath) => !typedProtectedPathSet.has(protectedPath)),
    );
    typedProtectedInputs = await protectedInputsForRoles(workDir, [
      { paths: fixturePaths, role: "fixture" },
      { paths: datasetPaths, role: "dataset" },
      { paths: runnerConfigPaths, role: "runner-config" },
    ]);
    evaluatorSourceInputs = await protectedInputsFromSources(
      workDir,
      evaluatorResolution?.protectedPaths ?? [],
    );
    checksSourceInputs = await protectedInputsFromSources(
      workDir,
      checksResolution?.protectedPaths ?? [],
    );
  } catch (error) {
    return {
      status: "invalid",
      contract: null,
      missing: [],
      conflicts: [
        {
          field: "protectedInputs",
          sources: ["config", "worktree"],
          message: errorMessage(error),
        },
      ],
      event: null,
    };
  }
  if (environment.source.kind === "file") {
    protectedInputs.push({
      path: environment.source.path,
      role: "environment-file",
      contentDigest: environment.source.contentDigest,
    });
  }
  const metricName = metric.metricName;
  const evaluatorExecution = createExecutionSpec({
    command: evaluatorCommand,
    relativeWorkingDirectory: ".",
    environment,
    parser: { id: "metric-lines", version: 1 },
    protectedInputs: mergeProtectedInputs(
      protectedInputs,
      typedProtectedInputs,
      evaluatorSourceInputs,
    ),
    timeoutSeconds: evaluatorTimeout,
    runner: { id: "codex-autoresearch", version: 1, metricLimit: DEFAULT_METRIC_LIMIT },
  });
  let checkImplementationPaths: string[];
  let checkProtectedInputs: ProtectedExecutionInput[];
  try {
    checkImplementationPaths = normalizeRelativePaths(
      config.checkImplementationPaths,
      "checkImplementationPaths",
    );
    checkProtectedInputs = await withCheckImplementationInputs(
      workDir,
      mergeProtectedInputs(protectedInputs, typedProtectedInputs, checksSourceInputs),
      checkImplementationPaths,
    );
  } catch (error) {
    return {
      status: "invalid",
      contract: null,
      missing: [],
      conflicts: [
        {
          field: "checks",
          sources: ["config", "worktree"],
          message: errorMessage(error),
        },
      ],
      event: null,
    };
  }
  const checksExecution = createExecutionSpec({
    command: checksCommand,
    relativeWorkingDirectory: ".",
    environment,
    parser: { id: "exit-code", version: 1 },
    protectedInputs: checkProtectedInputs,
    timeoutSeconds: checkTimeout,
    runner: { id: "codex-autoresearch", version: 1, metricLimit: DEFAULT_METRIC_LIMIT },
  });
  const checkAuthorityPaths = uniqueStrings([
    ...checkImplementationPaths,
    ...(checksResolution?.protectedPaths.map((item) => item.path) ?? []),
  ]);
  const editableCheckImplementation = checkAuthorityPaths.some((checkPath) =>
    editable.some((editablePath) => pathsOverlap(editablePath, checkPath)),
  );
  const checksAuthoritative =
    config.checksAuthoritative === true &&
    checkAuthorityPaths.length > 0 &&
    editableCheckImplementation === false;
  const checks: [AcceptedCheck, ...AcceptedCheck[]] = [
    checksAuthoritative
      ? { id: "checks", authority: "authoritative", execution: checksExecution }
      : {
          id: "checks",
          authority: "supplemental",
          reason: "Legacy derivation did not prove the check implementation authoritative.",
          execution: checksExecution,
        },
  ];
  const evaluatorLimit = evaluatorLimitResolution.value ?? packetLimit;
  const wallClockLimit =
    wallClockLimitResolution.value ??
    packetLimit *
      (evaluatorTimeout + checks.reduce((sum, check) => sum + check.execution.timeoutSeconds, 0));
  const modelTokens = hostBudgetDimension(modelTokenLimitResolution.value);
  const modelCalls = hostBudgetDimension(modelCallLimitResolution.value);
  const draft: Omit<ExperimentContract, "contractDigest"> = {
    schemaVersion: 1,
    goal: {
      objective: state.config.goal || state.config.name || "Autoresearch experiment",
      successCriteria: [`Improve ${metricName} under the accepted evaluator and checks.`],
      claimBoundary: "Only accepted-contract evaluation can support a measured-improvement claim.",
    },
    repository,
    metric,
    evaluator: { id: "primary", execution: evaluatorExecution },
    checks,
    scope: { editable, protected: protectedScope },
    noise,
    keepPolicy: {
      requiresAcceptedEvaluation: true,
      requiresAllChecks: true,
      requiresMetricComparison: true,
      requiresNoiseQualification: true,
      authoritativeCheckIds: checks
        .filter((check) => check.authority === "authoritative")
        .map((check) => check.id),
    },
    stopPolicy: {
      packets: { status: "enforced", limit: packetLimit, telemetry: "plugin" },
      evaluatorRuns: { status: "enforced", limit: evaluatorLimit, telemetry: "plugin" },
      pluginWallClockSeconds: {
        status: "enforced",
        limit: wallClockLimit,
        telemetry: "plugin",
      },
      modelTokens,
      modelCalls,
      noLearningPackets: { limit: noLearningLimitResolution.value ?? 2 },
      repeatedFailures: { limit: repeatedFailureLimitResolution.value ?? 2 },
    },
  };
  const contract = createExperimentContract(draft);
  return { status: "derived", contract, missing: [], conflicts: [], event: null };
}

export function createExperimentContract(
  input: Omit<ExperimentContract, "contractDigest"> & { contractDigest?: undefined },
): ExperimentContract {
  const canonical: Omit<ExperimentContract, "contractDigest"> = {
    schemaVersion: input.schemaVersion,
    goal: input.goal,
    repository: input.repository,
    metric: input.metric,
    evaluator: input.evaluator,
    checks: input.checks,
    scope: input.scope,
    noise: input.noise,
    keepPolicy: input.keepPolicy,
    stopPolicy: input.stopPolicy,
  };
  return { ...canonical, contractDigest: digestJson(canonical) };
}

async function acceptedContractConflicts({
  workDir,
  args,
  config,
  state,
  packet,
  event,
  verifiedEvidencePaths,
}: {
  workDir: string;
  args: UnknownRecord;
  config: UnknownRecord;
  state: ReturnType<typeof stateFromSessionRecords>;
  packet: UnknownRecord | null;
  event: ExperimentContractAcceptedEvent;
  verifiedEvidencePaths: string[];
}): Promise<ContractConflict[]> {
  const conflicts = acceptedContractBoundaryConflicts(event);
  if (conflicts.length > 0) return conflicts;
  let evidencePaths: string[] = [];
  try {
    evidencePaths = acceptedEvidenceTreePolicyPaths(verifiedEvidencePaths, event.contract);
  } catch (error) {
    conflicts.push({
      field: "repository.treePolicy",
      sources: ["accepted-contract", "evidence-artifacts"],
      message: errorMessage(error),
    });
    return conflicts;
  }
  let currentRepository: RepositoryContract;
  try {
    currentRepository = await repositoryContract(
      workDir,
      event.contract.scope.editable,
      evidencePaths,
    );
  } catch (error) {
    const fingerprintConflict = contractFingerprintConflict(error, [
      "accepted-contract",
      "worktree",
    ]);
    if (fingerprintConflict) return [...conflicts, fingerprintConflict];
    throw error;
  }
  if (
    currentRepository.repositoryIdentity !== event.contract.repository.repositoryIdentity ||
    currentRepository.worktreeIdentity !== event.contract.repository.worktreeIdentity
  ) {
    conflicts.push({
      field: "repository",
      sources: ["accepted-contract", "worktree"],
      message:
        "The accepted repository or worktree identity does not match this checkout. Start a new segment.",
    });
    return conflicts;
  }
  const expectedHead = expectedHeadFromLedger(
    event.contract.repository,
    state.current,
    event.timestamp,
  );
  if (!revisionMatches(currentRepository.expectedHead, expectedHead)) {
    conflicts.push({
      field: "repository.expectedHead",
      sources: ["accepted-contract", "ledger", "worktree"],
      message: `The repository revision does not match accepted expected HEAD ${expectedHead}. Start a new segment.`,
    });
  }
  if (
    currentRepository.treePolicy.outsideEditableFingerprint !==
    event.contract.repository.treePolicy.outsideEditableFingerprint
  ) {
    conflicts.push({
      field: "repository.treePolicy",
      sources: ["accepted-contract", "worktree"],
      message:
        "The Git dirty state outside accepted editable scope changed. Restore the accepted tree policy or start a new segment.",
    });
  }
  conflicts.push(
    ...(await acceptedEnvironmentCompatibilityConflicts({
      workDir,
      args,
      config,
      accepted: event.contract.evaluator.execution.environment,
      worktreeIdentity: currentRepository.worktreeIdentity,
    })),
  );
  conflicts.push(
    ...acceptedConfigurationCompatibilityConflicts({
      args,
      config,
      stateConfig: state.config,
      accepted: event.contract,
    }),
  );
  const activeConfigEntry = recordValue(state.activeConfigEntry);
  const ledgerBenchmarkContract = recordValue(activeConfigEntry.benchmarkContract);
  const packetHistory = recordValue(packet?.history);
  const packetRun = recordValue(packet?.run);
  const packetUsesAcceptedAuthority =
    packetRun.executionAuthority === "accepted-contract" &&
    packetRun.experimentContractDigest === event.contract.contractDigest;
  if (
    packet &&
    packetRun.executionAuthority === "accepted-contract" &&
    packetRun.experimentContractDigest !== event.contract.contractDigest
  ) {
    conflicts.push({
      field: "contractDigest",
      sources: ["accepted-contract", "packet"],
      message: "The packet was produced under a different accepted experiment contract.",
    });
  }
  const packetBenchmarkContract =
    Number(packetHistory.segment ?? state.segment) === state.segment
      ? recordValue(packetHistory.benchmarkContract)
      : {};
  let evaluatorCandidates: LegacyCommandCandidate[] = [];
  let checksCandidates: LegacyCommandCandidate[] = [];
  try {
    evaluatorCandidates = await evaluatorCommandCandidates({
      workDir,
      args,
      config,
      ledgerCommand: ledgerBenchmarkContract.command ?? activeConfigEntry.benchmarkCommand,
      packetCommand: packetUsesAcceptedAuthority
        ? undefined
        : (packetBenchmarkContract.command ?? packetHistory.command),
    });
  } catch (error) {
    conflicts.push({
      field: "evaluator.command",
      sources: ["legacy-boundary"],
      message: errorMessage(error),
    });
  }
  try {
    checksCandidates = await checksCommandCandidates({
      workDir,
      args,
      config,
      ledgerCommand: ledgerBenchmarkContract.checksCommand ?? activeConfigEntry.checksCommand,
      packetCommand: packetUsesAcceptedAuthority
        ? undefined
        : (packetBenchmarkContract.checksCommand ?? packetHistory.checksCommand),
    });
  } catch (error) {
    conflicts.push({
      field: "checks.command",
      sources: ["legacy-boundary"],
      message: errorMessage(error),
    });
  }
  compareCompatibilityCandidates(
    "evaluator.executionDigest",
    event.contract.evaluator.execution,
    evaluatorCandidates,
    conflicts,
  );
  compareCompatibilityCandidates(
    "checks.executionDigest",
    event.contract.checks[0].execution,
    checksCandidates,
    conflicts,
  );
  for (const execution of [
    event.contract.evaluator.execution,
    ...event.contract.checks.map((check) => check.execution),
  ]) {
    const verification = await verifyExecutionSpecForWorkDir(workDir, execution);
    conflicts.push(...verification.conflicts);
  }
  return conflicts;
}

function acceptedConfigurationCompatibilityConflicts({
  args,
  config,
  stateConfig,
  accepted,
}: {
  args: UnknownRecord;
  config: UnknownRecord;
  stateConfig: { metricName: string; metricUnit: string; bestDirection: "lower" | "higher" };
  accepted: ExperimentContract;
}): ContractConflict[] {
  const conflicts: ContractConflict[] = [];
  const compareLimit = (
    field: string,
    argumentKeys: string[],
    configKeys: string[],
    acceptedLimit: number,
  ) => {
    const resolution = resolveLegacyPositiveInteger({
      field,
      sources: [
        { name: "arguments", record: args, keys: argumentKeys },
        { name: "config", record: config, keys: configKeys },
      ],
      conflicts,
    });
    if (!resolution.provided || resolution.value === acceptedLimit) return;
    if (resolution.value != null) {
      conflicts.push({
        field,
        sources: ["accepted-contract", "compatibility-input"],
        message: `Configured ${field} does not match the accepted limit ${acceptedLimit}. Start a new segment.`,
      });
    }
  };
  compareLimit(
    "stopPolicy.packets",
    ["max_iterations", "maxIterations", "packet_budget", "packetBudget"],
    ["maxIterations", "packetBudget"],
    accepted.stopPolicy.packets.limit,
  );
  compareLimit(
    "stopPolicy.evaluatorRuns",
    ["max_evaluator_runs", "maxEvaluatorRuns"],
    ["maxEvaluatorRuns"],
    accepted.stopPolicy.evaluatorRuns.limit,
  );
  compareLimit(
    "stopPolicy.pluginWallClockSeconds",
    ["wall_clock_budget_seconds", "wallClockBudgetSeconds"],
    ["wallClockBudgetSeconds"],
    accepted.stopPolicy.pluginWallClockSeconds.limit,
  );
  compareLimit(
    "stopPolicy.noLearningPackets",
    ["no_learning_limit", "noLearningLimit"],
    ["noLearningLimit"],
    accepted.stopPolicy.noLearningPackets.limit,
  );
  compareLimit(
    "stopPolicy.repeatedFailures",
    ["repeated_failure_limit", "repeatedFailureLimit"],
    ["repeatedFailureLimit"],
    accepted.stopPolicy.repeatedFailures.limit,
  );
  compareHostBudgetCompatibility(
    "stopPolicy.modelTokens",
    args,
    ["model_token_budget", "modelTokenBudget"],
    config,
    ["modelTokenBudget"],
    accepted.stopPolicy.modelTokens,
    conflicts,
  );
  compareHostBudgetCompatibility(
    "stopPolicy.modelCalls",
    args,
    ["model_call_budget", "modelCallBudget"],
    config,
    ["modelCallBudget"],
    accepted.stopPolicy.modelCalls,
    conflicts,
  );
  if (Object.hasOwn(config, "metricSemantics")) {
    try {
      const metric = metricSemanticsFromConfig(config.metricSemantics, stateConfig, config);
      if (digestJson(metric) !== digestJson(accepted.metric)) {
        conflicts.push({
          field: "metric",
          sources: ["accepted-contract", "config"],
          message:
            "Configured metric semantics do not match the accepted metric contract. Start a new segment.",
        });
      }
    } catch (error) {
      conflicts.push({
        field: "metric",
        sources: ["accepted-contract", "config"],
        message: errorMessage(error),
      });
    }
  }
  const editableKey = ["editableScope", "filesInScope", "commitPaths"].find((key) =>
    Object.hasOwn(config, key),
  );
  if (editableKey) {
    try {
      const editable = normalizeRelativePaths(config[editableKey], editableKey);
      if (digestJson(editable) !== digestJson(accepted.scope.editable)) {
        conflicts.push({
          field: "scope.editable",
          sources: ["accepted-contract", "config"],
          message:
            "Configured editable scope does not match the accepted scope. Start a new segment.",
        });
      }
    } catch (error) {
      conflicts.push({
        field: "scope.editable",
        sources: ["accepted-contract", "config"],
        message: errorMessage(error),
      });
    }
  }
  compareOptionalExecutionLimit(
    args,
    config,
    ["timeout_seconds", "timeoutSeconds"],
    ["timeoutSeconds"],
    accepted.evaluator.execution.timeoutSeconds,
    "evaluator.timeoutSeconds",
    conflicts,
  );
  compareOptionalExecutionLimit(
    args,
    config,
    ["checks_timeout_seconds", "checksTimeoutSeconds"],
    ["checksTimeoutSeconds"],
    accepted.checks[0].execution.timeoutSeconds,
    "checks.timeoutSeconds",
    conflicts,
  );
  return conflicts;
}

function compareOptionalExecutionLimit(
  args: UnknownRecord,
  config: UnknownRecord,
  argumentKeys: string[],
  configKeys: string[],
  acceptedLimit: number,
  field: string,
  conflicts: ContractConflict[],
): void {
  const before = conflicts.length;
  const resolution = resolveLegacyPositiveInteger({
    field,
    sources: [
      { name: "arguments", record: args, keys: argumentKeys },
      { name: "config", record: config, keys: configKeys },
    ],
    conflicts,
  });
  if (conflicts.length === before && resolution.provided && resolution.value !== acceptedLimit) {
    conflicts.push({
      field,
      sources: ["accepted-contract", "compatibility-input"],
      message: `Configured ${field} does not match the accepted execution specification. Start a new segment.`,
    });
  }
}

function compareHostBudgetCompatibility(
  field: string,
  args: UnknownRecord,
  argumentKeys: string[],
  config: UnknownRecord,
  configKeys: string[],
  accepted: HostBudgetDimension,
  conflicts: ContractConflict[],
): void {
  const before = conflicts.length;
  const resolution = resolveLegacyPositiveInteger({
    field,
    sources: [
      { name: "arguments", record: args, keys: argumentKeys },
      { name: "config", record: config, keys: configKeys },
    ],
    conflicts,
  });
  if (conflicts.length !== before || !resolution.provided) return;
  const acceptedLimit = "limit" in accepted ? accepted.limit : undefined;
  if (resolution.value !== acceptedLimit) {
    conflicts.push({
      field,
      sources: ["accepted-contract", "compatibility-input"],
      message: `Configured ${field} does not match the accepted host-budget specification. Start a new segment.`,
    });
  }
}

async function acceptedEnvironmentCompatibilityConflicts({
  workDir,
  args,
  config,
  accepted,
  worktreeIdentity,
}: {
  workDir: string;
  args: UnknownRecord;
  config: UnknownRecord;
  accepted: ExecutionEnvironment;
  worktreeIdentity: string;
}): Promise<ContractConflict[]> {
  const conflicts: ContractConflict[] = [];
  const argumentMode = legacyStringForSource({
    field: "environment",
    source: "arguments",
    record: args,
    keys: ["packet_env_mode", "packetEnvMode"],
    conflicts,
  });
  const configMode = legacyStringForSource({
    field: "environment",
    source: "config",
    record: config,
    keys: ["packet_env_mode", "packetEnvMode"],
    conflicts,
  });
  const argumentFile = legacyStringForSource({
    field: "environment",
    source: "arguments",
    record: args,
    keys: ["packet_env_file", "packetEnvFile", "env_file", "envFile"],
    conflicts,
  });
  const configFile = legacyStringForSource({
    field: "environment",
    source: "config",
    record: config,
    keys: ["packet_env_file", "packetEnvFile", "env_file", "envFile"],
    conflicts,
  });
  if (
    argumentMode == null &&
    configMode == null &&
    argumentFile == null &&
    configFile == null &&
    conflicts.length === 0
  ) {
    return [];
  }
  for (const [source, mode] of [
    ["arguments", argumentMode],
    ["config", configMode],
  ] as const) {
    if (mode != null && mode !== "minimal" && mode !== "inherit") {
      conflicts.push({
        field: "environment",
        sources: ["accepted-contract", source],
        message: `Compatibility source ${source} has an invalid environment inheritance mode.`,
      });
    }
  }
  if (argumentMode != null && configMode != null && argumentMode !== configMode) {
    conflicts.push({
      field: "environment",
      sources: ["accepted-contract", "arguments", "config"],
      message: "Compatibility environment inheritance modes do not agree.",
    });
  }
  if (conflicts.length > 0) return conflicts;
  const mode = (argumentMode ?? configMode ?? accepted.inheritance) as "minimal" | "inherit";
  for (const [source, file] of [
    ["arguments", argumentFile],
    ["config", configFile],
  ] as const) {
    if (file == null) continue;
    try {
      const candidate = await environmentFromFile(workDir, file, worktreeIdentity, mode);
      if (digestJson(candidate) !== digestJson(accepted)) {
        conflicts.push({
          field: "environment",
          sources: ["accepted-contract", source],
          message: `Compatibility source ${source} does not match the accepted execution environment digest.`,
        });
      }
    } catch (error) {
      conflicts.push({
        field: "environment",
        sources: ["accepted-contract", source],
        message: errorMessage(error),
      });
    }
  }
  if (argumentFile == null && configFile == null) {
    const candidate = { ...accepted, inheritance: mode };
    if (digestJson(candidate) !== digestJson(accepted)) {
      conflicts.push({
        field: "environment",
        sources: ["accepted-contract", argumentMode != null ? "arguments" : "config"],
        message: "Compatibility environment mode does not match accepted authority.",
      });
    }
  }
  return conflicts;
}

function compareCompatibilityCandidates(
  field: string,
  accepted: ExecutionSpec,
  candidates: LegacyCommandCandidate[],
  conflicts: ContractConflict[],
): void {
  for (const candidate of candidates) {
    const candidateExecution = createExecutionSpec({
      command: candidate.command,
      relativeWorkingDirectory: accepted.relativeWorkingDirectory,
      environment: accepted.environment,
      timeoutSeconds: accepted.timeoutSeconds,
      parser: accepted.parser,
      protectedInputs: accepted.protectedInputs,
      runner: accepted.runner,
    });
    if (candidateExecution.executionDigest !== accepted.executionDigest) {
      conflicts.push({
        field,
        sources: ["accepted-contract", candidate.source],
        message: `Compatibility source ${candidate.source} does not match the accepted execution digest.`,
      });
    }
  }
}

export async function appendExperimentContractAcceptance(
  workDir: string,
  derivation: Extract<ContractDerivation, { status: "derived" }>,
  segment: number,
): Promise<ExperimentContractAcceptedEvent> {
  const currentRepository = await repositoryContract(workDir, derivation.contract.scope.editable);
  if (
    currentRepository.repositoryIdentity !== derivation.contract.repository.repositoryIdentity ||
    currentRepository.worktreeIdentity !== derivation.contract.repository.worktreeIdentity ||
    currentRepository.expectedHead !== derivation.contract.repository.expectedHead ||
    currentRepository.treePolicy.outsideEditableFingerprint !==
      derivation.contract.repository.treePolicy.outsideEditableFingerprint
  ) {
    throw new Error(
      "Repository revision or dirty state changed during contract acceptance. Retry new-segment from a stable checkout.",
    );
  }
  const event: ExperimentContractAcceptedEvent = {
    type: "experiment-contract-accepted",
    schemaVersion: 1,
    eventId: `experiment-contract-accepted:${segment}:${derivation.contract.contractDigest}`,
    source: "legacy-derivation",
    segment,
    timestamp: new Date().toISOString(),
    contract: derivation.contract,
  };
  appendJsonl(workDir, event);
  return event;
}

export function acceptedExperimentContractForEvidenceValidation(
  workDir: string,
  entries: UnknownRecord[] = readJsonl(workDir),
): ExperimentContract | null {
  const state = stateFromSessionRecords(workDir, entries);
  const event = latestAcceptedEvent(entries, state.segment);
  if (!event) return null;
  const conflicts = acceptedContractBoundaryConflicts(event);
  if (conflicts.length > 0) {
    throw contractDerivationError({
      status: "invalid",
      contract: null,
      missing: [],
      conflicts,
      event: null,
    });
  }
  return event.contract;
}

export async function acceptedExperimentContractForMutation(
  input: DeriveExperimentContractInput,
): Promise<Extract<ContractDerivation, { status: "accepted" }>> {
  const derivation = await deriveExperimentContract(input);
  if (derivation.status === "invalid") throw contractDerivationError(derivation);
  if (derivation.status === "accepted") return derivation;
  const entries = input.entries ?? readJsonl(input.workDir);
  const state = stateFromSessionRecords(input.workDir, entries);
  const event = await appendExperimentContractAcceptance(input.workDir, derivation, state.segment);
  return {
    status: "accepted",
    contract: derivation.contract,
    missing: [],
    conflicts: [],
    event,
  };
}

export function contractDerivationError(
  derivation: Extract<ContractDerivation, { status: "invalid" }>,
): Error {
  const details = [
    ...derivation.missing.map((item) => `missing ${item.field}: ${item.message}`),
    ...derivation.conflicts.map((item) => `conflict ${item.field}: ${item.message}`),
  ];
  return new Error(
    `Experiment contract is not acceptable. ${details.join(" ")} Start a new segment with a complete contract.`,
  );
}

export function executionCommandText(command: ExecutableCommand): string {
  return command.kind === "shell"
    ? command.script
    : [command.executable, ...command.args].map(displayArg).join(" ");
}

function latestAcceptedEvent(
  entries: UnknownRecord[],
  segment: number,
): ExperimentContractAcceptedEvent | null {
  const event = entries
    .filter(
      (entry) => entry.type === "experiment-contract-accepted" && Number(entry.segment) === segment,
    )
    .at(-1);
  if (!event) return null;
  return event as ExperimentContractAcceptedEvent;
}

function acceptedContractBoundaryConflicts(
  event: ExperimentContractAcceptedEvent,
): ContractConflict[] {
  const conflicts: ContractConflict[] = [];
  const reject = (field: string, message: string) => {
    conflicts.push({ field, sources: ["accepted-contract"], message });
  };
  if (
    event.type !== "experiment-contract-accepted" ||
    event.schemaVersion !== 1 ||
    event.source !== "legacy-derivation" ||
    !Number.isSafeInteger(event.segment) ||
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp))
  ) {
    reject("event", "The accepted-contract ledger event is malformed.");
  }
  const contract = recordValue(event.contract);
  if (contract.schemaVersion !== 1) {
    reject("schemaVersion", "The accepted contract schema version is unsupported.");
  }
  const goal = recordValue(contract.goal);
  if (
    typeof goal.objective !== "string" ||
    !Array.isArray(goal.successCriteria) ||
    goal.successCriteria.length === 0 ||
    !goal.successCriteria.every((value) => typeof value === "string" && value.length > 0) ||
    typeof goal.claimBoundary !== "string"
  ) {
    reject("goal", "The accepted goal specification is malformed.");
  }
  const scope = recordValue(contract.scope);
  let acceptedEditable: string[] = [];
  let acceptedProtected: string[] = [];
  if (!stringArray(scope.editable, true) || !stringArray(scope.protected, false)) {
    reject("scope", "The accepted editable and protected scope is malformed.");
  } else {
    try {
      acceptedEditable = normalizeRelativePaths(scope.editable, "accepted editable scope");
      acceptedProtected = normalizeRelativePaths(scope.protected, "accepted protected scope");
      if (scopeOverlaps(acceptedEditable, acceptedProtected).length > 0) {
        reject("scope", "The accepted editable and protected scope overlaps.");
      }
    } catch (error) {
      reject("scope", errorMessage(error));
    }
  }
  if (!validRepositoryContract(contract.repository)) {
    reject("repository", "The accepted repository identity contract is malformed.");
  }
  if (!validMetricSemantics(contract.metric)) {
    reject("metric", "The accepted metric semantics are malformed.");
  }
  const evaluator = recordValue(contract.evaluator);
  if (evaluator.id !== "primary" || !validExecutionSpec(evaluator.execution, "evaluator")) {
    reject("evaluator", "The accepted evaluator execution specification is malformed.");
  }
  const checks = Array.isArray(contract.checks) ? contract.checks : [];
  if (
    checks.length === 0 ||
    !checks.every((check) =>
      validAcceptedCheck(check, { editable: acceptedEditable, protected: acceptedProtected }),
    )
  ) {
    reject(
      "checks",
      "The accepted checks list must contain valid execution specifications with recomputed authority.",
    );
  }
  if (!validNoiseModel(contract.noise)) {
    reject("noise", "The accepted noise model is malformed.");
  }
  if (!validKeepPolicy(contract.keepPolicy, checks)) {
    reject("keepPolicy", "The accepted keep policy is malformed.");
  }
  if (!validStopPolicy(contract.stopPolicy)) {
    reject("stopPolicy", "The accepted stop policy is malformed.");
  }
  if (conflicts.length === 0) {
    const accepted = contract as unknown as ExperimentContract;
    const expected = createExperimentContract({
      schemaVersion: accepted.schemaVersion,
      goal: accepted.goal,
      repository: accepted.repository,
      metric: accepted.metric,
      evaluator: accepted.evaluator,
      checks: accepted.checks,
      scope: accepted.scope,
      noise: accepted.noise,
      keepPolicy: accepted.keepPolicy,
      stopPolicy: accepted.stopPolicy,
    });
    if (accepted.contractDigest !== expected.contractDigest) {
      reject("contractDigest", "The accepted contract no longer has its canonical digest.");
    }
    if (
      event.eventId !== `experiment-contract-accepted:${event.segment}:${accepted.contractDigest}`
    ) {
      reject("eventId", "The accepted-contract event identity does not match its contract.");
    }
  }
  return conflicts;
}

function validRepositoryContract(value: unknown): value is RepositoryContract {
  const record = recordValue(value);
  const treePolicy = recordValue(record.treePolicy);
  return (
    [
      record.repositoryIdentity,
      record.worktreeIdentity,
      record.segmentBaseRevision,
      record.expectedHead,
    ].every((field) => typeof field === "string" && field.length > 0) &&
    typeof treePolicy.outsideEditableFingerprint === "string" &&
    treePolicy.outsideEditableFingerprint.length > 0 &&
    (treePolicy.kind === "require-clean" ||
      (treePolicy.kind === "initial-dirty" &&
        typeof treePolicy.fingerprint === "string" &&
        treePolicy.fingerprint.length > 0))
  );
}

function validMetricSemantics(value: unknown): value is MetricSemantics {
  const record = recordValue(value);
  if (
    typeof record.metricName !== "string" ||
    !record.metricName ||
    typeof record.unit !== "string"
  ) {
    return false;
  }
  if (record.kind === "minimize" || record.kind === "maximize") {
    return isExactNonNegativeNumber(record.minimumImprovement);
  }
  return (
    record.kind === "threshold" &&
    ["<", "<=", "=", ">=", ">"].includes(record.comparator as string) &&
    isExactFiniteNumber(record.target)
  );
}

function validExecutionSpec(
  value: unknown,
  purpose: "evaluator" | "check",
): value is ExecutionSpec {
  const record = recordValue(value);
  const command = recordValue(record.command);
  const validCommand =
    (command.kind === "argv" &&
      typeof command.executable === "string" &&
      command.executable.length > 0 &&
      Array.isArray(command.args) &&
      command.args.every((arg) => typeof arg === "string")) ||
    (command.kind === "shell" &&
      (command.shell === "bash" || command.shell === "powershell") &&
      typeof command.script === "string" &&
      command.script.length > 0);
  const environment = recordValue(record.environment);
  const source = recordValue(environment.source);
  const declared = Array.isArray(environment.declared) ? environment.declared : [];
  const validEnvironment =
    (environment.inheritance === "inherit" || environment.inheritance === "minimal") &&
    Array.isArray(environment.declared) &&
    declared.every((item) => {
      const entry = recordValue(item);
      return (
        typeof entry.name === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) &&
        typeof entry.valueDigest === "string" &&
        entry.valueDigest.length > 0
      );
    }) &&
    (source.kind === "none" ||
      source.kind === "process" ||
      (source.kind === "file" &&
        typeof source.path === "string" &&
        typeof source.contentDigest === "string"));
  const parser = recordValue(record.parser);
  const runner = recordValue(record.runner);
  const protectedInputs = Array.isArray(record.protectedInputs) ? record.protectedInputs : [];
  const validProtectedInputs =
    Array.isArray(record.protectedInputs) &&
    protectedInputs.every((item) => {
      const input = recordValue(item);
      return (
        typeof input.path === "string" &&
        [
          "command-file",
          "environment-file",
          "evaluator",
          "check",
          "fixture",
          "dataset",
          "runner-config",
        ].includes(input.role as string) &&
        typeof input.contentDigest === "string" &&
        input.contentDigest.length > 0
      );
    });
  if (
    !validCommand ||
    typeof record.relativeWorkingDirectory !== "string" ||
    path.isAbsolute(record.relativeWorkingDirectory) ||
    record.relativeWorkingDirectory.split(/[\\/]/).includes("..") ||
    !validEnvironment ||
    !isExactPositiveInteger(record.timeoutSeconds) ||
    parser.id !== (purpose === "evaluator" ? "metric-lines" : "exit-code") ||
    parser.version !== 1 ||
    !validProtectedInputs ||
    runner.id !== "codex-autoresearch" ||
    runner.version !== 1 ||
    !isExactPositiveInteger(runner.metricLimit) ||
    runner.metricLimit > MAX_SUPPORTED_METRIC_LIMIT ||
    (purpose === "check" && runner.metricLimit !== DEFAULT_METRIC_LIMIT) ||
    typeof record.executionDigest !== "string"
  ) {
    return false;
  }
  const execution = record as unknown as ExecutionSpec;
  return (
    createExecutionSpec({
      command: execution.command,
      relativeWorkingDirectory: execution.relativeWorkingDirectory,
      environment: execution.environment,
      timeoutSeconds: execution.timeoutSeconds,
      parser: execution.parser,
      protectedInputs: execution.protectedInputs,
      runner: execution.runner,
    }).executionDigest === execution.executionDigest
  );
}

function validAcceptedCheck(
  value: unknown,
  scope: { editable: string[]; protected: string[] },
): value is AcceptedCheck {
  const record = recordValue(value);
  const structurallyValid =
    typeof record.id === "string" &&
    record.id.length > 0 &&
    ((record.authority === "authoritative" && record.reason == null) ||
      (record.authority === "supplemental" && typeof record.reason === "string")) &&
    validExecutionSpec(record.execution, "check");
  if (!structurallyValid) return false;
  if (record.authority !== "authoritative") return true;
  const execution = recordValue(record.execution);
  const protectedInputs = execution.protectedInputs as ProtectedExecutionInput[];
  const implementationInputs = protectedInputs.filter(
    (input) => input.role === "check" || input.role === "command-file",
  );
  const authorityInputsAreIndependent = protectedInputs.every(
    (input) =>
      !scope.editable.some((editablePath) => pathsOverlap(editablePath, input.path)) ||
      scope.protected.some((protectedPath) => pathsOverlap(protectedPath, input.path)),
  );
  return (
    implementationInputs.length > 0 &&
    authorityInputsAreIndependent &&
    implementationInputs.every(
      (input) =>
        !scope.editable.some((editablePath) => pathsOverlap(editablePath, input.path)) ||
        scope.protected.some((protectedPath) => pathsOverlap(protectedPath, input.path)),
    )
  );
}

function validNoiseModel(value: unknown): value is NoiseModel {
  const record = recordValue(value);
  return (
    record.kind === "deterministic" ||
    (record.kind === "bounded" &&
      isExactNonNegativeNumber(record.tolerance) &&
      isExactPositiveInteger(record.repeats)) ||
    (record.kind === "unknown" && isExactPositiveInteger(record.qualificationRepeats))
  );
}

function validKeepPolicy(value: unknown, checks: unknown[]): value is KeepPolicy {
  const record = recordValue(value);
  const authoritativeIds = checks
    .map(recordValue)
    .filter((check) => check.authority === "authoritative")
    .map((check) => check.id)
    .sort();
  return (
    record.requiresAcceptedEvaluation === true &&
    record.requiresAllChecks === true &&
    record.requiresMetricComparison === true &&
    record.requiresNoiseQualification === true &&
    Array.isArray(record.authoritativeCheckIds) &&
    record.authoritativeCheckIds.every((id) => typeof id === "string") &&
    JSON.stringify([...record.authoritativeCheckIds].sort()) === JSON.stringify(authoritativeIds)
  );
}

function validStopPolicy(value: unknown): value is ExecutableStopPolicy {
  const record = recordValue(value);
  return (
    validEnforcedBudget(record.packets) &&
    validEnforcedBudget(record.evaluatorRuns) &&
    validEnforcedBudget(record.pluginWallClockSeconds) &&
    validHostBudget(record.modelTokens) &&
    validHostBudget(record.modelCalls) &&
    isExactPositiveInteger(recordValue(record.noLearningPackets).limit) &&
    isExactPositiveInteger(recordValue(record.repeatedFailures).limit)
  );
}

function validEnforcedBudget(value: unknown): value is EnforcedBudgetDimension {
  const record = recordValue(value);
  return (
    record.status === "enforced" &&
    isExactPositiveInteger(record.limit) &&
    (record.telemetry === "plugin" || record.telemetry === "trusted-host")
  );
}

function validHostBudget(value: unknown): value is HostBudgetDimension {
  const record = recordValue(value);
  if (record.status === "enforced") {
    return isExactPositiveInteger(record.limit) && record.telemetry === "trusted-host";
  }
  if (record.status === "advisory") {
    return (
      typeof record.reason === "string" &&
      (record.limit === undefined || isExactPositiveInteger(record.limit))
    );
  }
  return record.status === "unsupported" && typeof record.reason === "string";
}

function stringArray(value: unknown, requireNonEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (!requireNonEmpty || value.length > 0) &&
    value.every((item) => typeof item === "string")
  );
}

interface LegacyPositiveIntegerResolution {
  provided: boolean;
  value: number | null;
}

function resolveLegacyPositiveInteger({
  field,
  sources,
  conflicts,
}: {
  field: string;
  sources: Array<{ name: string; record: UnknownRecord; keys: string[] }>;
  conflicts: ContractConflict[];
}): LegacyPositiveIntegerResolution {
  const resolved: Array<{ source: string; value: number }> = [];
  let provided = false;
  let invalid = false;
  for (const source of sources) {
    const values = source.keys
      .filter((key) => Object.hasOwn(source.record, key))
      .map((key) => source.record[key]);
    if (values.length === 0) continue;
    provided = true;
    const parsed = values.map(legacyPositiveInteger);
    if (parsed.some((value) => value == null)) {
      conflicts.push({
        field,
        sources: [source.name],
        message: `Legacy ${source.name} ${field} must be a positive integer.`,
      });
      invalid = true;
      continue;
    }
    const canonical = [...new Set(parsed as number[])];
    if (canonical.length !== 1) {
      conflicts.push({
        field,
        sources: [source.name],
        message: `Legacy ${source.name} aliases for ${field} do not agree.`,
      });
      invalid = true;
      continue;
    }
    resolved.push({ source: source.name, value: canonical[0] });
  }
  if (new Set(resolved.map((item) => item.value)).size > 1) {
    conflicts.push({
      field,
      sources: resolved.map((item) => item.source),
      message: `Legacy sources for ${field} do not agree.`,
    });
    invalid = true;
  }
  return {
    provided,
    value: invalid ? null : (resolved[0]?.value ?? null),
  };
}

function legacyPositiveInteger(value: unknown): number | null {
  if (isExactPositiveInteger(value)) return value;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return isExactPositiveInteger(parsed) ? parsed : null;
}

async function resolveLegacyEnvironment({
  workDir,
  worktreeIdentity,
  args,
  config,
  conflicts,
}: {
  workDir: string;
  worktreeIdentity: string;
  args: UnknownRecord;
  config: UnknownRecord;
  conflicts: ContractConflict[];
}): Promise<ExecutionEnvironment | null> {
  const argumentMode = legacyStringForSource({
    field: "environment",
    source: "arguments",
    record: args,
    keys: ["packet_env_mode", "packetEnvMode"],
    conflicts,
  });
  const configMode = legacyStringForSource({
    field: "environment",
    source: "config",
    record: config,
    keys: ["packet_env_mode", "packetEnvMode"],
    conflicts,
  });
  for (const [source, candidate] of [
    ["arguments", argumentMode],
    ["config", configMode],
  ] as const) {
    if (candidate != null && candidate !== "minimal" && candidate !== "inherit") {
      conflicts.push({
        field: "environment",
        sources: [source],
        message: "Environment inheritance mode must be minimal or inherit.",
      });
    }
  }
  if (argumentMode != null && configMode != null && argumentMode !== configMode) {
    conflicts.push({
      field: "environment",
      sources: ["arguments", "config"],
      message: "Legacy environment inheritance modes do not agree.",
    });
  }
  const argumentFile = legacyStringForSource({
    field: "environment",
    source: "arguments",
    record: args,
    keys: ["packet_env_file", "packetEnvFile", "env_file", "envFile"],
    conflicts,
  });
  const configFile = legacyStringForSource({
    field: "environment",
    source: "config",
    record: config,
    keys: ["packet_env_file", "packetEnvFile", "env_file", "envFile"],
    conflicts,
  });
  if (conflicts.some((conflict) => conflict.field === "environment")) return null;
  const mode = (argumentMode ?? configMode ?? "minimal") as "minimal" | "inherit";
  const candidates: Array<{ source: string; environment: ExecutionEnvironment }> = [];
  for (const [source, file] of [
    ["arguments", argumentFile],
    ["config", configFile],
  ] as const) {
    if (file == null) continue;
    try {
      candidates.push({
        source,
        environment: await environmentFromFile(workDir, file, worktreeIdentity, mode),
      });
    } catch (error) {
      conflicts.push({
        field: "environment",
        sources: [source],
        message: errorMessage(error),
      });
    }
  }
  if (new Set(candidates.map((candidate) => digestJson(candidate.environment))).size > 1) {
    conflicts.push({
      field: "environment",
      sources: candidates.map((candidate) => candidate.source),
      message: "Legacy environment files do not resolve to the same execution environment.",
    });
  }
  if (conflicts.some((conflict) => conflict.field === "environment")) return null;
  return candidates[0]?.environment ?? emptyEnvironment(mode);
}

function legacyStringForSource({
  field,
  source,
  record,
  keys,
  conflicts,
}: {
  field: string;
  source: string;
  record: UnknownRecord;
  keys: string[];
  conflicts: ContractConflict[];
}): string | null {
  const values = keys.filter((key) => Object.hasOwn(record, key)).map((key) => record[key]);
  if (values.length === 0) return null;
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    conflicts.push({
      field,
      sources: [source],
      message: `Legacy ${source} ${field} value must be a non-empty string.`,
    });
    return null;
  }
  const strings = values as string[];
  if (new Set(strings).size !== 1) {
    conflicts.push({
      field,
      sources: [source],
      message: `Legacy ${source} aliases for ${field} do not agree.`,
    });
    return null;
  }
  return strings[0];
}

interface LegacyCommandCandidate {
  source: string;
  command: ExecutableCommand;
  protectedPaths: Array<{
    path: string;
    role: ProtectedExecutionInput["role"];
  }>;
}

async function evaluatorCommandCandidates({
  workDir,
  args,
  config,
  ledgerCommand,
  packetCommand,
}: {
  workDir: string;
  args: UnknownRecord;
  config: UnknownRecord;
  ledgerCommand: unknown;
  packetCommand: unknown;
}): Promise<LegacyCommandCandidate[]> {
  const candidates: LegacyCommandCandidate[] = [];
  const explicit = args.command ?? args.benchmark_command ?? args.benchmarkCommand;
  if (explicit != null && explicit !== "") {
    candidates.push(commandCandidate("arguments", explicit));
  }
  const separator = Array.isArray(args._) ? args._.map(String) : [];
  if (separator.length > 1) {
    candidates.push({
      source: "separator",
      command: { kind: "argv", executable: separator[1], args: separator.slice(2) },
      protectedPaths: [],
    });
  }
  const commandFile = args.command_file ?? args.commandFile;
  if (commandFile != null && commandFile !== "") {
    candidates.push(await commandFileCandidate(workDir, String(commandFile), "arguments"));
  }
  for (const [source, value] of [
    ["config", config.benchmarkCommand],
    ["ledger", ledgerCommand],
    ["packet", packetCommand],
  ] as const) {
    if (value != null && value !== "") candidates.push(commandCandidate(source, value));
  }
  const wrapper = await wrapperCandidate(workDir, "evaluator");
  if (wrapper) candidates.push(wrapper);
  return candidates;
}

async function checksCommandCandidates({
  workDir,
  args,
  config,
  ledgerCommand,
  packetCommand,
}: {
  workDir: string;
  args: UnknownRecord;
  config: UnknownRecord;
  ledgerCommand: unknown;
  packetCommand: unknown;
}): Promise<LegacyCommandCandidate[]> {
  const candidates: LegacyCommandCandidate[] = [];
  for (const [source, value] of [
    ["arguments", args.checks_command ?? args.checksCommand],
    ["config", config.checksCommand],
    ["ledger", ledgerCommand],
    ["packet", packetCommand],
  ] as const) {
    if (value != null && value !== "") candidates.push(commandCandidate(source, value));
  }
  const wrapper = await wrapperCandidate(workDir, "check");
  if (wrapper) candidates.push(wrapper);
  return candidates;
}

function commandCandidate(source: string, value: unknown): LegacyCommandCandidate {
  const command = executableCommandValue(value);
  return { source, command, protectedPaths: [] };
}

function executableCommandValue(value: unknown): ExecutableCommand {
  if (typeof value === "string") {
    return {
      kind: "shell",
      shell: process.platform === "win32" ? "powershell" : "bash",
      script: value,
    };
  }
  const record = recordValue(value);
  if (record.kind === "argv") {
    const executable = String(record.executable || "");
    if (!executable || !Array.isArray(record.args)) {
      throw new Error("Canonical argv commands require executable and args.");
    }
    return { kind: "argv", executable, args: record.args.map(String) };
  }
  if (
    record.kind === "shell" &&
    (record.shell === "bash" || record.shell === "powershell") &&
    typeof record.script === "string"
  ) {
    return { kind: "shell", shell: record.shell, script: record.script };
  }
  throw new Error("Command source is neither a string nor a canonical executable command.");
}

async function commandFileCandidate(
  workDir: string,
  filePath: string,
  source: string,
): Promise<LegacyCommandCandidate> {
  const relativePath = normalizeRelativePaths([filePath], "command file")[0];
  const script = await fsp.readFile(path.resolve(workDir, relativePath), "utf8");
  if (!script.trim()) throw new Error(`Command file is empty: ${relativePath}.`);
  return {
    source: `${source}:command-file`,
    command: {
      kind: "shell",
      shell: process.platform === "win32" ? "powershell" : "bash",
      script,
    },
    protectedPaths: [{ path: relativePath, role: "command-file" }],
  };
}

async function wrapperCandidate(
  workDir: string,
  role: "evaluator" | "check",
): Promise<LegacyCommandCandidate | null> {
  const bashPath = role === "evaluator" ? "autoresearch.sh" : "autoresearch.checks.sh";
  const powershellPath = role === "evaluator" ? "autoresearch.ps1" : "autoresearch.checks.ps1";
  if (process.platform !== "win32" && (await fileExists(path.join(workDir, bashPath)))) {
    return {
      source: "wrapper",
      command: { kind: "argv", executable: "bash", args: [`./${bashPath}`] },
      protectedPaths: [{ path: bashPath, role }],
    };
  }
  if (await fileExists(path.join(workDir, powershellPath))) {
    return {
      source: "wrapper",
      command: {
        kind: "argv",
        executable: "powershell",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `./${powershellPath}`],
      },
      protectedPaths: [{ path: powershellPath, role }],
    };
  }
  if (await fileExists(path.join(workDir, bashPath))) {
    return {
      source: "wrapper",
      command: { kind: "argv", executable: "bash", args: [`./${bashPath}`] },
      protectedPaths: [{ path: bashPath, role }],
    };
  }
  return null;
}

function agreedExecutableCommand(
  field: string,
  candidates: LegacyCommandCandidate[],
  conflicts: ContractConflict[],
): { command: ExecutableCommand; protectedPaths: LegacyCommandCandidate["protectedPaths"] } | null {
  if (candidates.length === 0) return null;
  const values = new Set(candidates.map((candidate) => JSON.stringify(candidate.command)));
  if (values.size > 1) {
    conflicts.push({
      field,
      sources: candidates.map((candidate) => candidate.source),
      message: "Legacy command sources do not agree exactly.",
    });
    return null;
  }
  return {
    command: candidates[0].command,
    protectedPaths: candidates.flatMap((candidate) => candidate.protectedPaths),
  };
}

async function legacyRepositoryIdentityConflicts({
  workDir,
  editable,
  config,
  ledgerConfig,
  packetHistory,
}: {
  workDir: string;
  editable: string[];
  config: UnknownRecord;
  ledgerConfig: UnknownRecord;
  packetHistory: UnknownRecord;
}): Promise<ContractConflict[]> {
  const conflicts: ContractConflict[] = [];
  const currentPath = await fsp.realpath(workDir).catch(() => path.resolve(workDir));
  let currentRepository: RepositoryContract;
  try {
    currentRepository = await repositoryContract(workDir, editable);
  } catch (error) {
    const fingerprintConflict = contractFingerprintConflict(error, ["legacy-boundary", "worktree"]);
    if (fingerprintConflict) return [fingerprintConflict];
    throw error;
  }
  for (const [source, record] of [
    ["config", config],
    ["ledger", ledgerConfig],
    ["packet", packetHistory],
  ] as const) {
    const workingDirectory = record.workingDir ?? record.working_dir ?? record.workDir;
    if (workingDirectory != null && workingDirectory !== "") {
      if (typeof workingDirectory !== "string") {
        conflicts.push({
          field: "repository",
          sources: [source, "worktree"],
          message: `Legacy ${source} working-directory identity is malformed.`,
        });
      } else {
        const candidatePath = path.isAbsolute(workingDirectory)
          ? workingDirectory
          : path.resolve(workDir, workingDirectory);
        const resolvedCandidate = await fsp
          .realpath(candidatePath)
          .catch(() => path.resolve(candidatePath));
        if (resolvedCandidate !== currentPath) {
          conflicts.push({
            field: "repository",
            sources: [source, "worktree"],
            message: `Legacy ${source} working-directory identity does not match this worktree.`,
          });
        }
      }
    }
    for (const [field, acceptedValue] of [
      ["repositoryIdentity", currentRepository.repositoryIdentity],
      ["worktreeIdentity", currentRepository.worktreeIdentity],
    ] as const) {
      if (record[field] != null && record[field] !== acceptedValue) {
        conflicts.push({
          field: "repository",
          sources: [source, "worktree"],
          message: `Legacy ${source} ${field} does not match this worktree.`,
        });
      }
    }
  }
  return conflicts;
}

async function repositoryContract(
  workDir: string,
  editable: string[] = [],
  ignoredOutsideEditablePaths: string[] = [],
): Promise<RepositoryContract> {
  const resolved = await fsp.realpath(workDir).catch(() => path.resolve(workDir));
  const git = await insideGitRepo(workDir).catch(() => false);
  if (!git) {
    const identity = digestText(`filesystem\0${resolved}`);
    return {
      repositoryIdentity: identity,
      worktreeIdentity: identity,
      segmentBaseRevision: "non-git",
      expectedHead: "non-git",
      treePolicy: {
        kind: "require-clean",
        outsideEditableFingerprint: digestJson([]),
      },
    };
  }
  const [topLevel, commonDir, head, status] = await Promise.all([
    requiredGitOutput(workDir, ["rev-parse", "--show-toplevel"]),
    requiredGitOutput(workDir, ["rev-parse", "--git-common-dir"]),
    requiredGitOutput(workDir, ["rev-parse", "HEAD"]),
    requiredGitRawOutput(workDir, ["status", "--porcelain=v1", "-z", "-uall"]),
  ]);
  const repositoryIdentity = digestText(`repository\0${path.resolve(workDir, commonDir)}`);
  const worktreeIdentity = digestText(`worktree\0${path.resolve(topLevel)}`);
  const outsideEditableFingerprint = await dirtyStateOutsideEditableFingerprint(
    workDir,
    status,
    editable,
    ignoredOutsideEditablePaths,
  );
  return {
    repositoryIdentity,
    worktreeIdentity,
    segmentBaseRevision: head,
    expectedHead: head,
    treePolicy: status
      ? {
          kind: "initial-dirty",
          fingerprint: digestText(status),
          outsideEditableFingerprint,
        }
      : { kind: "require-clean", outsideEditableFingerprint },
  };
}

function expectedHeadFromLedger(
  repository: RepositoryContract,
  currentRuns: UnknownRecord[],
  acceptedAt: string,
): string {
  const acceptedAtMilliseconds = Date.parse(acceptedAt);
  const keptCommit = [...currentRuns]
    .reverse()
    .find(
      (run) =>
        run.status === "keep" &&
        typeof run.commit === "string" &&
        run.commit.length > 0 &&
        typeof run.timestamp === "number" &&
        run.timestamp >= acceptedAtMilliseconds,
    )?.commit;
  return typeof keptCommit === "string" ? keptCommit : repository.expectedHead;
}

function revisionMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.startsWith(expected) || expected.startsWith(actual);
}

async function dirtyStateOutsideEditableFingerprint(
  workDir: string,
  status: string,
  editable: string[],
  ignoredPaths: string[] = [],
): Promise<string> {
  if (!status) return digestJson([]);
  const outsidePaths = (entryPaths: string[]) =>
    entryPaths.filter(
      (entryPath) =>
        !pathCoveredByAnyScope(entryPath, editable) &&
        !pathCoveredByAnyScope(entryPath, ignoredPaths) &&
        !isSessionOwnedPath(entryPath),
    );
  const entries = parsePorcelainV1Z(status)
    .map((entry) => ({ status: entry.status, paths: outsidePaths(entry.paths).sort() }))
    .filter((entry) => entry.paths.length > 0)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (entries.length === 0) return digestJson([]);
  const paths = uniqueStrings(entries.flatMap((entry) => entry.paths));
  const snapshot = await buildProtectedBenchmarkSnapshot({
    workDir,
    paths,
    capturedAt: "contract-tree-policy",
  });
  if (snapshot.quarantined.length > 0) {
    throw new ContractFingerprintAuthorityError(
      "repository.treePolicy",
      "Repository tree-policy fingerprint",
      snapshot.quarantined,
    );
  }
  return digestJson({
    entries,
    surfaceHash: snapshot.surfaceHash,
    quarantined: snapshot.quarantined,
  });
}

function acceptedEvidenceTreePolicyPaths(paths: string[], contract: ExperimentContract): string[] {
  const normalized = normalizeRelativePaths(paths, "verifiedEvidencePaths");
  const protectedScopes = [
    ...contract.scope.editable,
    ...contract.scope.protected,
    ".git",
    ...AUTORESEARCH_SESSION_FILES,
    AUTORESEARCH_DASHBOARD_FILE,
    ...SESSION_OWNED_DIRS,
  ];
  for (const evidencePath of normalized) {
    if (
      protectedScopes.some(
        (scopePath) =>
          pathCoveredByAnyScope(evidencePath, [scopePath]) ||
          pathCoveredByAnyScope(scopePath, [evidencePath]),
      )
    ) {
      throw new Error(
        `Verified evidence path overlaps editable, protected, or session-owned scope: ${evidencePath}.`,
      );
    }
  }
  return normalized;
}

function pathCoveredByAnyScope(filePath: string, scopes: string[]): boolean {
  return scopes.some((scopePath) => filePath === scopePath || filePath.startsWith(`${scopePath}/`));
}

function isSessionOwnedPath(filePath: string): boolean {
  return (
    AUTORESEARCH_SESSION_FILES.includes(filePath as (typeof AUTORESEARCH_SESSION_FILES)[number]) ||
    filePath === AUTORESEARCH_DASHBOARD_FILE ||
    SESSION_OWNED_DIRS.some(
      (directory) => filePath === directory || filePath.startsWith(`${directory}/`),
    )
  );
}

async function requiredGitOutput(workDir: string, args: string[]): Promise<string> {
  const result = await runGit(args, workDir);
  if (result.code !== 0) {
    throw new Error(`Git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function requiredGitRawOutput(workDir: string, args: string[]): Promise<string> {
  const result = await runGit(args, workDir);
  if (result.code !== 0) {
    throw new Error(`Git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function protectedInputsForPaths(
  workDir: string,
  paths: string[],
): Promise<ProtectedExecutionInput[]> {
  const inputs: ProtectedExecutionInput[] = [];
  for (const relativePath of paths) {
    inputs.push(await protectedInputForPath(workDir, relativePath, "evaluator"));
  }
  return inputs;
}

async function protectedInputsFromSources(
  workDir: string,
  sources: LegacyCommandCandidate["protectedPaths"],
): Promise<ProtectedExecutionInput[]> {
  const inputs: ProtectedExecutionInput[] = [];
  for (const source of sources) {
    inputs.push(await protectedInputForPath(workDir, source.path, source.role));
  }
  return inputs;
}

async function protectedInputsForRoles(
  workDir: string,
  groups: Array<{
    paths: string[];
    role: ProtectedExecutionInput["role"];
  }>,
): Promise<ProtectedExecutionInput[]> {
  const inputs: ProtectedExecutionInput[] = [];
  for (const group of groups) {
    for (const relativePath of group.paths) {
      inputs.push(await protectedInputForPath(workDir, relativePath, group.role));
    }
  }
  return inputs;
}

function mergeProtectedInputs(...groups: ProtectedExecutionInput[][]): ProtectedExecutionInput[] {
  const unique = new Map<string, ProtectedExecutionInput>();
  for (const input of groups.flat()) {
    unique.set(`${input.role}\0${input.path}`, input);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.role}\0${left.path}`.localeCompare(`${right.role}\0${right.path}`),
  );
}

async function withCheckImplementationInputs(
  workDir: string,
  protectedInputs: ProtectedExecutionInput[],
  paths: unknown,
): Promise<ProtectedExecutionInput[]> {
  const inputs = [...protectedInputs];
  for (const relativePath of normalizeRelativePaths(paths, "checkImplementationPaths")) {
    inputs.push(await protectedInputForPath(workDir, relativePath, "check"));
  }
  return inputs;
}

async function protectedInputForPath(
  workDir: string,
  relativePath: string,
  role: ProtectedExecutionInput["role"],
): Promise<ProtectedExecutionInput> {
  const normalized = normalizeRelativePaths([relativePath], `${role} path`)[0];
  const snapshot = await buildProtectedBenchmarkSnapshot({ workDir, paths: [normalized] });
  if (snapshot.quarantined.length > 0 || snapshot.files.some((file) => file.missing === true)) {
    throw new Error(`Protected contract input is unavailable: ${normalized}.`);
  }
  return { path: normalized, role, contentDigest: snapshot.surfaceHash };
}

async function environmentFromFile(
  workDir: string,
  filePath: string,
  worktreeIdentity: string,
  inheritance: "inherit" | "minimal",
): Promise<ExecutionEnvironment> {
  const relativePath = normalizeRelativePaths([filePath], "environment file")[0];
  const absolutePath = path.resolve(workDir, relativePath);
  const content = await fsp.readFile(absolutePath, "utf8");
  const values = parseEnvironmentValues(content, absolutePath);
  const fingerprint = await protectedInputForPath(workDir, relativePath, "environment-file");
  return {
    inheritance,
    declared: Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({
        name,
        valueDigest: digestText(`environment-value\0${worktreeIdentity}\0${name}\0${value}`),
      })),
    source: {
      kind: "file",
      path: relativePath,
      contentDigest: fingerprint.contentDigest,
    },
  };
}

function parseEnvironmentValues(content: string, filePath: string): Record<string, string> {
  const trimmed = content.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Environment-file JSON must be an object: ${filePath}`);
    }
    return Object.fromEntries(
      Object.entries(parsed).map(([name, value]) => [
        validateEnvironmentName(name),
        String(value ?? ""),
      ]),
    );
  }
  const values: Record<string, string> = {};
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      throw new Error(`Invalid environment-file line ${index + 1}: ${filePath}.`);
    }
    values[validateEnvironmentName(match[1])] = unquoteEnvironmentValue(match[2].trim());
  }
  return values;
}

function validateEnvironmentName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}.`);
  }
  return name;
}

function unquoteEnvironmentValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function createExecutionSpec(input: Omit<ExecutionSpec, "executionDigest">): ExecutionSpec {
  const canonical: Omit<ExecutionSpec, "executionDigest"> = {
    command: input.command,
    relativeWorkingDirectory: input.relativeWorkingDirectory,
    environment: input.environment,
    timeoutSeconds: input.timeoutSeconds,
    parser: input.parser,
    protectedInputs: input.protectedInputs,
    runner: input.runner,
  };
  return { ...canonical, executionDigest: digestJson(canonical) };
}

export async function verifyExecutionSpecForWorkDir(
  workDir: string,
  spec: ExecutionSpec,
): Promise<{ ok: boolean; conflicts: ContractConflict[] }> {
  const conflicts: ContractConflict[] = [];
  let environment = spec.environment;
  if (spec.environment.source.kind === "file") {
    try {
      const repository = await repositoryContract(workDir);
      const current = await environmentFromFile(
        workDir,
        spec.environment.source.path,
        repository.worktreeIdentity,
        spec.environment.inheritance,
      );
      if (
        current.source.kind !== "file" ||
        current.source.contentDigest !== spec.environment.source.contentDigest ||
        JSON.stringify(current.declared) !== JSON.stringify(spec.environment.declared)
      ) {
        conflicts.push({
          field: "environment",
          sources: ["accepted-contract", "worktree"],
          message: "Declared environment values or environment-file contents changed.",
        });
      }
      environment = current;
    } catch (error) {
      conflicts.push({
        field: "environment",
        sources: ["accepted-contract", "worktree"],
        message: errorMessage(error),
      });
    }
  }
  const refreshedInputs: ProtectedExecutionInput[] = [];
  for (const input of spec.protectedInputs) {
    try {
      const refreshed = await protectedInputForPath(workDir, input.path, input.role);
      refreshedInputs.push(refreshed);
      if (refreshed.contentDigest !== input.contentDigest && input.role !== "environment-file") {
        conflicts.push({
          field: "protectedInputs",
          sources: ["accepted-contract", input.path],
          message: `Protected execution input changed: ${input.path}.`,
        });
      }
    } catch (error) {
      conflicts.push({
        field: input.role === "environment-file" ? "environment" : "protectedInputs",
        sources: ["accepted-contract", input.path],
        message: errorMessage(error),
      });
    }
  }
  const refreshed = createExecutionSpec({
    command: spec.command,
    relativeWorkingDirectory: spec.relativeWorkingDirectory,
    environment,
    timeoutSeconds: spec.timeoutSeconds,
    parser: spec.parser,
    protectedInputs: refreshedInputs,
    runner: spec.runner,
  });
  if (conflicts.length === 0 && refreshed.executionDigest !== spec.executionDigest) {
    conflicts.push({
      field: "executionDigest",
      sources: ["accepted-contract", "worktree"],
      message: `The accepted execution specification no longer has its canonical digest: ${spec.executionDigest} != ${refreshed.executionDigest}.`,
    });
  }
  return { ok: conflicts.length === 0, conflicts };
}

export async function materializeExecutionEnvironment(
  workDir: string,
  environment: ExecutionEnvironment,
): Promise<NodeJS.ProcessEnv> {
  if (environment.source.kind === "none") {
    if (environment.declared.length > 0) {
      throw new Error(
        "Experiment contract environment declares values without an accepted source.",
      );
    }
    return {};
  }
  const repository = await repositoryContract(workDir);
  if (environment.source.kind === "process") {
    const values: NodeJS.ProcessEnv = {};
    for (const declared of environment.declared) {
      const value = process.env[declared.name];
      if (value == null) {
        throw new Error(`Accepted environment value is unavailable: ${declared.name}.`);
      }
      const valueDigest = digestText(
        `environment-value\0${repository.worktreeIdentity}\0${declared.name}\0${value}`,
      );
      if (valueDigest !== declared.valueDigest) {
        throw new Error(`Accepted environment value changed: ${declared.name}.`);
      }
      values[declared.name] = value;
    }
    return values;
  }
  const absolutePath = path.resolve(workDir, environment.source.path);
  const content = await fsp.readFile(absolutePath, "utf8");
  const values = parseEnvironmentValues(content, absolutePath);
  const current = await environmentFromFile(
    workDir,
    environment.source.path,
    repository.worktreeIdentity,
    environment.inheritance,
  );
  if (
    current.source.kind !== "file" ||
    current.source.contentDigest !== environment.source.contentDigest ||
    JSON.stringify(current.declared) !== JSON.stringify(environment.declared)
  ) {
    throw new Error(
      "Accepted environment values or environment-file contents changed. Start a new segment.",
    );
  }
  return values;
}

function emptyEnvironment(inheritance: "inherit" | "minimal"): ExecutionEnvironment {
  return { inheritance, declared: [], source: { kind: "none" } };
}

function hostBudgetDimension(value: unknown): HostBudgetDimension {
  const limit = positiveInteger(value);
  if (limit != null) {
    return {
      status: "advisory",
      limit,
      reason: "Trusted host telemetry is unavailable; remaining usage is unknown.",
    };
  }
  return {
    status: "unsupported",
    reason: "No trusted host telemetry and budget limit were supplied.",
  };
}

export function noiseQualificationStatus(
  noise: NoiseModel,
  input: { completedRepeats: number; purpose: "baseline" | "candidate" | "holdout" | "diagnostic" },
): {
  evaluationAllowed: true;
  keepEligible: boolean;
  requiredRepeats: number;
  completedRepeats: number;
  remainingRepeats: number;
} {
  const completedRepeats = Math.max(0, Math.floor(Number(input.completedRepeats) || 0));
  const requiredRepeats =
    noise.kind === "deterministic"
      ? 1
      : noise.kind === "bounded"
        ? noise.repeats
        : noise.qualificationRepeats;
  const remainingRepeats = Math.max(0, requiredRepeats - completedRepeats);
  return {
    evaluationAllowed: true,
    keepEligible: input.purpose === "candidate" && remainingRepeats === 0,
    requiredRepeats,
    completedRepeats,
    remainingRepeats,
  };
}

export async function contractCandidateFingerprintForWorkDir(
  workDir: string,
  contract: ExperimentContract,
): Promise<string> {
  const snapshot = await buildProtectedBenchmarkSnapshot({
    workDir,
    paths: contract.scope.editable,
    capturedAt: "contract-candidate",
  });
  if (snapshot.quarantined.length > 0) {
    throw new ContractFingerprintAuthorityError(
      "candidateFingerprint",
      "Candidate fingerprint",
      snapshot.quarantined,
    );
  }
  return digestJson({
    contractDigest: contract.contractDigest,
    editable: contract.scope.editable,
    truncated: false,
    surfaceHash: snapshot.surfaceHash,
  });
}

export function completedContractNoiseRepeats(
  contract: ExperimentContract,
  currentRuns: UnknownRecord[],
  input: { candidateFingerprint: string; metric: number },
): number {
  const priorRepeats = currentRuns.filter((run) => {
    const evidence = recordValue(run.contractEvaluationEvidence);
    if (
      evidence.contractDigest !== contract.contractDigest ||
      evidence.candidateFingerprint !== input.candidateFingerprint ||
      evidence.acceptedEvaluation !== true ||
      evidence.checksPassed !== true ||
      !isExactFiniteNumber(evidence.metric)
    ) {
      return false;
    }
    return contract.noise.kind !== "bounded"
      ? evidence.metric === input.metric
      : Math.abs(evidence.metric - input.metric) <= contract.noise.tolerance;
  }).length;
  return priorRepeats + 1;
}

export function evaluateContractKeepEligibility(
  contract: ExperimentContract,
  input: {
    purpose: RunPurpose;
    evaluationAuthority: EvaluationAuthority;
    candidateOrigin: CandidateOrigin;
    acceptedEvaluation: boolean;
    checkOutcomes: ContractCheckOutcome[];
    completedRepeats: number;
    metric: number | null;
    referenceMetric: number | null;
  },
): ContractKeepEligibility {
  const reasons: string[] = [];
  if (input.purpose !== "candidate") {
    reasons.push("Keep requires candidate-purpose evidence.");
  }
  if (input.evaluationAuthority !== "accepted-contract") {
    reasons.push("Keep requires accepted-contract evaluation authority.");
  }
  if (input.candidateOrigin.kind === "none") {
    reasons.push("Keep requires a working-tree or commit candidate origin.");
  }
  if (!input.acceptedEvaluation) {
    reasons.push("Keep requires an accepted-contract evaluator result.");
  }
  if (input.metric == null || !Number.isFinite(input.metric)) {
    reasons.push("Keep requires a finite accepted metric.");
  }
  const outcomeById = new Map(input.checkOutcomes.map((outcome) => [outcome.id, outcome]));
  const allChecksPassed =
    input.checkOutcomes.length === contract.checks.length &&
    outcomeById.size === contract.checks.length &&
    contract.checks.every((check) => {
      const outcome = outcomeById.get(check.id);
      return outcome?.executionDigest === check.execution.executionDigest && outcome.passed;
    });
  if (!allChecksPassed) {
    reasons.push("Keep requires every accepted check to pass its accepted execution digest.");
  }
  if (contract.keepPolicy.authoritativeCheckIds.length === 0) {
    reasons.push(
      "Keep requires at least one proven authoritative check; supplemental checks cannot authorize it.",
    );
  } else if (
    !contract.keepPolicy.authoritativeCheckIds.every((id) => outcomeById.get(id)?.passed === true)
  ) {
    reasons.push("Keep requires every authoritative check to pass.");
  }
  const metricReason =
    input.metric != null && Number.isFinite(input.metric)
      ? metricComparisonFailureReason(
          contract.metric,
          contract.noise,
          input.metric,
          input.referenceMetric,
        )
      : null;
  if (metricReason) reasons.push(metricReason);
  const qualification = noiseQualificationStatus(contract.noise, {
    completedRepeats: input.completedRepeats,
    purpose: "candidate",
  });
  if (!qualification.keepEligible) {
    reasons.push(
      `Keep requires accepted noise qualification (${qualification.completedRepeats}/${qualification.requiredRepeats} repeats).`,
    );
  }
  const shared = {
    completedRepeats: qualification.completedRepeats,
    requiredRepeats: qualification.requiredRepeats,
    referenceMetric: input.referenceMetric,
  };
  const authorized = mayAuthorizeKeep({
    purpose: input.purpose,
    evaluationAuthority: input.evaluationAuthority,
    candidateOrigin: input.candidateOrigin,
    acceptedEvaluation: input.acceptedEvaluation,
    checksPassed:
      allChecksPassed &&
      contract.keepPolicy.authoritativeCheckIds.length > 0 &&
      contract.keepPolicy.authoritativeCheckIds.every((id) => outcomeById.get(id)?.passed === true),
    comparisonSatisfied: input.metric != null && Number.isFinite(input.metric) && !metricReason,
    noiseQualified: qualification.keepEligible,
  });
  return authorized && reasons.length === 0
    ? { eligible: true, reasons: [], ...shared }
    : {
        eligible: false,
        reasons: reasons as [string, ...string[]],
        ...shared,
      };
}

export function mayAuthorizeKeep(input: KeepAuthorizationInput): boolean {
  const hasCandidate =
    input.candidateOrigin.kind === "working-tree" ||
    (input.candidateOrigin.kind === "commit" && input.candidateOrigin.oid.trim().length > 0);
  return (
    input.purpose === "candidate" &&
    input.evaluationAuthority === "accepted-contract" &&
    hasCandidate &&
    input.acceptedEvaluation &&
    input.checksPassed &&
    input.comparisonSatisfied &&
    input.noiseQualified
  );
}

function metricComparisonFailureReason(
  metric: MetricSemantics,
  noise: NoiseModel,
  candidate: number,
  reference: number | null,
): string | null {
  if (metric.kind === "threshold") {
    const passed =
      metric.comparator === "<"
        ? candidate < metric.target
        : metric.comparator === "<="
          ? candidate <= metric.target
          : metric.comparator === "="
            ? candidate === metric.target
            : metric.comparator === ">="
              ? candidate >= metric.target
              : candidate > metric.target;
    return passed
      ? null
      : `Accepted metric comparison did not meet threshold ${metric.comparator} ${metric.target}.`;
  }
  if (reference == null || !Number.isFinite(reference)) {
    return "Keep requires a prior accepted reference metric; log this packet as measure.";
  }
  const improvement = metric.kind === "maximize" ? candidate - reference : reference - candidate;
  if (improvement <= 0) {
    return "Accepted metric comparison did not improve on the reference metric.";
  }
  if (improvement < metric.minimumImprovement) {
    return `Accepted improvement ${improvement} is below minimum improvement ${metric.minimumImprovement}.`;
  }
  if (noise.kind === "bounded" && improvement <= noise.tolerance) {
    return `Accepted improvement ${improvement} does not exceed bounded noise tolerance ${noise.tolerance}.`;
  }
  return null;
}

export function contractStopStatus(
  contract: ExperimentContract,
  input: {
    acceptedAt: string;
    currentRuns: UnknownRecord[];
    now?: string | Date;
  },
): ContractStopStatus {
  const acceptedAtMilliseconds = Date.parse(input.acceptedAt);
  const nowMilliseconds =
    input.now instanceof Date
      ? input.now.getTime()
      : Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(acceptedAtMilliseconds) || !Number.isFinite(nowMilliseconds)) {
    throw new Error("Accepted contract wall-clock timestamps must be valid ISO dates.");
  }
  const packetRuns = input.currentRuns.filter(countsTowardPacketBudget);
  const packets = packetRuns.length;
  const evaluatorRuns = packetRuns.reduce(
    (total, run) => total + (positiveInteger(run.evaluatorRuns) ?? 1),
    0,
  );
  const pluginWallClockSeconds = Math.max(
    0,
    Math.floor((nowMilliseconds - acceptedAtMilliseconds) / 1000),
  );
  const consecutiveFailures = countTrailingRuns(input.currentRuns, (run) =>
    ["crash", "checks_failed"].includes(String(run.status || "")),
  );
  const consecutiveNoLearningPackets = countTrailingRuns(
    input.currentRuns,
    (run) => !["baseline", "keep", "measure"].includes(String(run.status || "")),
  );
  const ceilings: Array<{
    dimension: ContractStopDimension;
    limit: number;
    used: number;
    label: string;
  }> = [
    {
      dimension: "packets",
      limit: contract.stopPolicy.packets.limit,
      used: packets,
      label: "packet",
    },
    {
      dimension: "evaluatorRuns",
      limit: contract.stopPolicy.evaluatorRuns.limit,
      used: evaluatorRuns,
      label: "evaluator-run",
    },
    {
      dimension: "pluginWallClockSeconds",
      limit: contract.stopPolicy.pluginWallClockSeconds.limit,
      used: pluginWallClockSeconds,
      label: "plugin wall-clock",
    },
    {
      dimension: "repeatedFailures",
      limit: contract.stopPolicy.repeatedFailures.limit,
      used: consecutiveFailures,
      label: "repeated-failure",
    },
    {
      dimension: "noLearningPackets",
      limit: contract.stopPolicy.noLearningPackets.limit,
      used: consecutiveNoLearningPackets,
      label: "no-learning packet",
    },
  ];
  const exhausted = ceilings.find((ceiling) => ceiling.used >= ceiling.limit);
  if (exhausted) {
    return {
      status: "exhausted",
      dimension: exhausted.dimension,
      limit: exhausted.limit,
      used: exhausted.used,
      message: `Accepted ${exhausted.label} ceiling reached (${exhausted.used}/${exhausted.limit}). Start a new segment.`,
    };
  }
  return {
    status: "allowed",
    usage: {
      packets,
      evaluatorRuns,
      pluginWallClockSeconds,
      consecutiveNoLearningPackets,
      consecutiveFailures,
    },
  };
}

function countTrailingRuns(
  runs: UnknownRecord[],
  predicate: (run: UnknownRecord) => boolean,
): number {
  let count = 0;
  for (let index = runs.length - 1; index >= 0 && predicate(runs[index]); index -= 1) {
    count += 1;
  }
  return count;
}

function noiseModel(value: unknown): NoiseModel {
  if (value == null) return { kind: "unknown", qualificationRepeats: 2 };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as UnknownRecord;
    if (record.kind === "deterministic") return { kind: "deterministic" };
    if (record.kind === "bounded") {
      const tolerance = nonNegativeNumber(record.tolerance);
      const repeats = positiveInteger(record.repeats);
      if (tolerance != null && repeats != null) return { kind: "bounded", tolerance, repeats };
    }
    if (record.kind === "unknown") {
      const qualificationRepeats =
        record.qualificationRepeats == null ? 2 : positiveInteger(record.qualificationRepeats);
      if (qualificationRepeats == null) {
        throw new Error("Unknown noise requires positive qualification repeats.");
      }
      return {
        kind: "unknown",
        qualificationRepeats,
      };
    }
  }
  throw new Error(
    "Noise model must be deterministic, bounded with non-negative tolerance and positive repeats, or unknown with positive qualification repeats.",
  );
}

function metricSemanticsFromConfig(
  value: unknown,
  sessionConfig: { metricName: string; metricUnit: string; bestDirection: "lower" | "higher" },
  config: UnknownRecord,
): MetricSemantics {
  const metricName = sessionConfig.metricName || "metric";
  const unit = sessionConfig.metricUnit || "";
  if (value == null) {
    return sessionConfig.bestDirection === "higher"
      ? {
          kind: "maximize",
          metricName,
          unit,
          minimumImprovement: nonNegativeNumber(config.minimumImprovement) ?? 0,
        }
      : {
          kind: "minimize",
          metricName,
          unit,
          minimumImprovement: nonNegativeNumber(config.minimumImprovement) ?? 0,
        };
  }
  const explicit = recordValue(value);
  if (explicit.kind === "threshold") {
    const comparator = String(explicit.comparator || "");
    const target = Number(explicit.target);
    if (!["<", "<=", "=", ">=", ">"].includes(comparator) || !Number.isFinite(target)) {
      throw new Error(
        "Threshold metric semantics require an explicit comparator and finite target.",
      );
    }
    return {
      kind: "threshold",
      metricName,
      unit,
      comparator: comparator as "<" | "<=" | "=" | ">=" | ">",
      target,
    };
  }
  if (explicit.kind === "minimize" || explicit.kind === "maximize") {
    const minimumImprovement = nonNegativeNumber(explicit.minimumImprovement);
    if (minimumImprovement == null) {
      throw new Error(`${String(explicit.kind)} metric semantics require minimumImprovement.`);
    }
    return {
      kind: explicit.kind,
      metricName,
      unit,
      minimumImprovement,
    };
  }
  throw new Error("Metric semantics must be minimize, maximize, or threshold.");
}

function scopeOverlaps(editable: string[], protectedScope: string[]): string[] {
  const overlaps: string[] = [];
  for (const editablePath of editable) {
    for (const protectedPath of protectedScope) {
      if (pathsOverlap(editablePath, protectedPath)) {
        overlaps.push(`${editablePath} <> ${protectedPath}`);
      }
    }
  }
  return overlaps;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function recordValue(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isExactPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isExactFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isExactNonNegativeNumber(value: unknown): value is number {
  return isExactFiniteNumber(value) && value >= 0;
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function displayArg(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
