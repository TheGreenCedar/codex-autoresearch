import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { buildProtectedBenchmarkSnapshot } from "./benchmark/contract-guards.js";
import { insideGitRepo, runGit } from "./git-private-state.js";
import { normalizeRelativePaths } from "./literal-paths.js";
import { appendJsonl, readJsonl, stateFromSessionRecords } from "./session-core.js";
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

export type TreePolicy = { kind: "require-clean" } | { kind: "initial-dirty"; fingerprint: string };

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

export interface DeriveExperimentContractInput {
  workDir: string;
  args?: UnknownRecord;
  config?: UnknownRecord;
  entries?: UnknownRecord[];
  packet?: UnknownRecord | null;
  ignoreAccepted?: boolean;
}

const DEFAULT_EVALUATOR_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 300;
const DEFAULT_METRIC_LIMIT = 512;

export async function deriveExperimentContract({
  workDir,
  args = {},
  config = {},
  entries = readJsonl(workDir),
  packet = null,
  ignoreAccepted = false,
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
  conflicts.push(
    ...(await legacyRepositoryIdentityConflicts({
      workDir,
      config,
      ledgerConfig: state.config,
      packetHistory,
    })),
  );
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

  const packetLimitInput = config.maxIterations ?? config.packetBudget;
  const packetLimit = positiveInteger(packetLimitInput);
  if (packetLimit == null && packetLimitInput == null) {
    missing.push({ field: "stopPolicy.packets", message: "A packet ceiling is required." });
  } else if (packetLimit == null) {
    conflicts.push({
      field: "stopPolicy.packets",
      sources: ["config"],
      message: "The packet ceiling must be a positive integer.",
    });
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

  const repository = await repositoryContract(workDir);
  const environmentModeInput =
    args.packet_env_mode ?? args.packetEnvMode ?? config.packetEnvMode ?? "minimal";
  if (environmentModeInput !== "inherit" && environmentModeInput !== "minimal") {
    return {
      status: "invalid",
      contract: null,
      missing: [],
      conflicts: [
        {
          field: "environment",
          sources:
            args.packet_env_mode != null || args.packetEnvMode != null ? ["arguments"] : ["config"],
          message: "Environment inheritance mode must be minimal or inherit.",
        },
      ],
      event: null,
    };
  }
  const environmentMode = environmentModeInput;
  const environmentFile =
    args.packet_env_file ??
    args.packetEnvFile ??
    args.env_file ??
    args.envFile ??
    config.packetEnvFile ??
    config.envFile;
  const environmentSource =
    args.packet_env_file != null ||
    args.packetEnvFile != null ||
    args.env_file != null ||
    args.envFile != null
      ? "arguments"
      : "config";
  let environment: ExecutionEnvironment;
  try {
    environment = environmentFile
      ? await environmentFromFile(
          workDir,
          String(environmentFile),
          repository.worktreeIdentity,
          environmentMode,
        )
      : emptyEnvironment(environmentMode);
  } catch (error) {
    return {
      status: "invalid",
      contract: null,
      missing: [],
      conflicts: [
        {
          field: "environment",
          sources: [environmentSource],
          message: errorMessage(error),
        },
      ],
      event: null,
    };
  }
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
  const evaluatorTimeout =
    positiveInteger(args.timeout_seconds ?? args.timeoutSeconds ?? config.timeoutSeconds) ??
    DEFAULT_EVALUATOR_TIMEOUT_SECONDS;
  const checkTimeout =
    positiveInteger(
      args.checks_timeout_seconds ?? args.checksTimeoutSeconds ?? config.checksTimeoutSeconds,
    ) ?? DEFAULT_CHECK_TIMEOUT_SECONDS;
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
  const evaluatorLimit = positiveInteger(config.maxEvaluatorRuns) ?? packetLimit;
  const wallClockLimit =
    positiveInteger(config.wallClockBudgetSeconds) ??
    packetLimit *
      (evaluatorTimeout + checks.reduce((sum, check) => sum + check.execution.timeoutSeconds, 0));
  const modelTokens = hostBudgetDimension(config.modelTokenBudget);
  const modelCalls = hostBudgetDimension(config.modelCallBudget);
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
      noLearningPackets: { limit: positiveInteger(config.noLearningLimit) ?? 2 },
      repeatedFailures: { limit: positiveInteger(config.repeatedFailureLimit) ?? 2 },
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
}: {
  workDir: string;
  args: UnknownRecord;
  config: UnknownRecord;
  state: ReturnType<typeof stateFromSessionRecords>;
  packet: UnknownRecord | null;
  event: ExperimentContractAcceptedEvent;
}): Promise<ContractConflict[]> {
  const conflicts = acceptedContractBoundaryConflicts(event);
  if (conflicts.length > 0) return conflicts;
  const currentRepository = await repositoryContract(workDir);
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
      config,
      stateConfig: state.config,
      accepted: event.contract,
    }),
  );
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
  config,
  stateConfig,
  accepted,
}: {
  config: UnknownRecord;
  stateConfig: { metricName: string; metricUnit: string; bestDirection: "lower" | "higher" };
  accepted: ExperimentContract;
}): ContractConflict[] {
  const conflicts: ContractConflict[] = [];
  const compareLimit = (field: string, keys: string[], acceptedLimit: number) => {
    const key = keys.find((candidate) => Object.hasOwn(config, candidate));
    if (!key) return;
    const limit = positiveInteger(config[key]);
    if (limit !== acceptedLimit) {
      conflicts.push({
        field,
        sources: ["accepted-contract", "config"],
        message: `Configured ${field} does not match the accepted limit ${acceptedLimit}. Start a new segment.`,
      });
    }
  };
  compareLimit(
    "stopPolicy.packets",
    ["maxIterations", "packetBudget"],
    accepted.stopPolicy.packets.limit,
  );
  compareLimit(
    "stopPolicy.evaluatorRuns",
    ["maxEvaluatorRuns"],
    accepted.stopPolicy.evaluatorRuns.limit,
  );
  compareLimit(
    "stopPolicy.pluginWallClockSeconds",
    ["wallClockBudgetSeconds"],
    accepted.stopPolicy.pluginWallClockSeconds.limit,
  );
  compareLimit(
    "stopPolicy.noLearningPackets",
    ["noLearningLimit"],
    accepted.stopPolicy.noLearningPackets.limit,
  );
  compareLimit(
    "stopPolicy.repeatedFailures",
    ["repeatedFailureLimit"],
    accepted.stopPolicy.repeatedFailures.limit,
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
    config,
    ["timeoutSeconds"],
    accepted.evaluator.execution.timeoutSeconds,
    "evaluator.timeoutSeconds",
    conflicts,
  );
  compareOptionalExecutionLimit(
    config,
    ["checksTimeoutSeconds"],
    accepted.checks[0].execution.timeoutSeconds,
    "checks.timeoutSeconds",
    conflicts,
  );
  return conflicts;
}

function compareOptionalExecutionLimit(
  config: UnknownRecord,
  keys: string[],
  acceptedLimit: number,
  field: string,
  conflicts: ContractConflict[],
): void {
  const key = keys.find((candidate) => Object.hasOwn(config, candidate));
  if (!key) return;
  if (positiveInteger(config[key]) !== acceptedLimit) {
    conflicts.push({
      field,
      sources: ["accepted-contract", "config"],
      message: `Configured ${field} does not match the accepted execution specification. Start a new segment.`,
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
  const argumentFile = args.packet_env_file ?? args.packetEnvFile ?? args.env_file ?? args.envFile;
  const configFile = config.packetEnvFile ?? config.envFile;
  const file = argumentFile ?? configFile;
  const argumentMode = args.packet_env_mode ?? args.packetEnvMode;
  const configMode = config.packetEnvMode;
  const modeValue = argumentMode ?? configMode;
  if (file == null && modeValue == null) return [];
  const source = argumentFile != null || argumentMode != null ? "arguments" : "config";
  const mode = String(modeValue ?? accepted.inheritance);
  if (mode !== "minimal" && mode !== "inherit") {
    return [
      {
        field: "environment",
        sources: ["accepted-contract", source],
        message: `Compatibility source ${source} has an invalid environment inheritance mode.`,
      },
    ];
  }
  try {
    const candidate = file
      ? await environmentFromFile(workDir, String(file), worktreeIdentity, mode)
      : { ...accepted, inheritance: mode };
    return digestJson(candidate) === digestJson(accepted)
      ? []
      : [
          {
            field: "environment",
            sources: ["accepted-contract", source],
            message: `Compatibility source ${source} does not match the accepted execution environment digest.`,
          },
        ];
  } catch (error) {
    return [
      {
        field: "environment",
        sources: ["accepted-contract", source],
        message: errorMessage(error),
      },
    ];
  }
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

export function appendExperimentContractAcceptance(
  workDir: string,
  derivation: Extract<ContractDerivation, { status: "derived" }>,
  segment: number,
): ExperimentContractAcceptedEvent {
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

export async function acceptedExperimentContractForMutation(
  input: DeriveExperimentContractInput,
): Promise<Extract<ContractDerivation, { status: "accepted" }>> {
  const derivation = await deriveExperimentContract(input);
  if (derivation.status === "invalid") throw contractDerivationError(derivation);
  if (derivation.status === "accepted") return derivation;
  const entries = input.entries ?? readJsonl(input.workDir);
  const state = stateFromSessionRecords(input.workDir, entries);
  const event = appendExperimentContractAcceptance(input.workDir, derivation, state.segment);
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
  if (!validRepositoryContract(contract.repository)) {
    reject("repository", "The accepted repository identity contract is malformed.");
  }
  if (!validMetricSemantics(contract.metric)) {
    reject("metric", "The accepted metric semantics are malformed.");
  }
  const evaluator = recordValue(contract.evaluator);
  if (typeof evaluator.id !== "string" || !validExecutionSpec(evaluator.execution)) {
    reject("evaluator", "The accepted evaluator execution specification is malformed.");
  }
  const checks = Array.isArray(contract.checks) ? contract.checks : [];
  if (checks.length === 0 || !checks.every(validAcceptedCheck)) {
    reject("checks", "The accepted checks list must contain valid execution specifications.");
  }
  const scope = recordValue(contract.scope);
  if (!stringArray(scope.editable, true) || !stringArray(scope.protected, false)) {
    reject("scope", "The accepted editable and protected scope is malformed.");
  } else {
    try {
      const editable = normalizeRelativePaths(scope.editable, "accepted editable scope");
      const protectedScope = normalizeRelativePaths(scope.protected, "accepted protected scope");
      if (scopeOverlaps(editable, protectedScope).length > 0) {
        reject("scope", "The accepted editable and protected scope overlaps.");
      }
    } catch (error) {
      reject("scope", errorMessage(error));
    }
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
    return nonNegativeNumber(record.minimumImprovement) != null;
  }
  return (
    record.kind === "threshold" &&
    ["<", "<=", "=", ">=", ">"].includes(String(record.comparator)) &&
    Number.isFinite(Number(record.target))
  );
}

function validExecutionSpec(value: unknown): value is ExecutionSpec {
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
        ].includes(String(input.role)) &&
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
    positiveInteger(record.timeoutSeconds) == null ||
    typeof parser.id !== "string" ||
    positiveInteger(parser.version) == null ||
    !validProtectedInputs ||
    runner.id !== "codex-autoresearch" ||
    positiveInteger(runner.version) == null ||
    positiveInteger(runner.metricLimit) == null ||
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

function validAcceptedCheck(value: unknown): value is AcceptedCheck {
  const record = recordValue(value);
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    ((record.authority === "authoritative" && record.reason == null) ||
      (record.authority === "supplemental" && typeof record.reason === "string")) &&
    validExecutionSpec(record.execution)
  );
}

function validNoiseModel(value: unknown): value is NoiseModel {
  const record = recordValue(value);
  return (
    record.kind === "deterministic" ||
    (record.kind === "bounded" &&
      nonNegativeNumber(record.tolerance) != null &&
      positiveInteger(record.repeats) != null) ||
    (record.kind === "unknown" && positiveInteger(record.qualificationRepeats) != null)
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
    positiveInteger(recordValue(record.noLearningPackets).limit) != null &&
    positiveInteger(recordValue(record.repeatedFailures).limit) != null
  );
}

function validEnforcedBudget(value: unknown): value is EnforcedBudgetDimension {
  const record = recordValue(value);
  return (
    record.status === "enforced" &&
    positiveInteger(record.limit) != null &&
    (record.telemetry === "plugin" || record.telemetry === "trusted-host")
  );
}

function validHostBudget(value: unknown): value is HostBudgetDimension {
  const record = recordValue(value);
  if (record.status === "enforced") {
    return positiveInteger(record.limit) != null && record.telemetry === "trusted-host";
  }
  if (record.status === "advisory") {
    return (
      typeof record.reason === "string" &&
      (record.limit == null || positiveInteger(record.limit) != null)
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
  config,
  ledgerConfig,
  packetHistory,
}: {
  workDir: string;
  config: UnknownRecord;
  ledgerConfig: UnknownRecord;
  packetHistory: UnknownRecord;
}): Promise<ContractConflict[]> {
  const conflicts: ContractConflict[] = [];
  const currentPath = await fsp.realpath(workDir).catch(() => path.resolve(workDir));
  const currentRepository = await repositoryContract(workDir);
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

async function repositoryContract(workDir: string): Promise<RepositoryContract> {
  const resolved = await fsp.realpath(workDir).catch(() => path.resolve(workDir));
  const git = await insideGitRepo(workDir).catch(() => false);
  if (!git) {
    const identity = digestText(`filesystem\0${resolved}`);
    return {
      repositoryIdentity: identity,
      worktreeIdentity: identity,
      segmentBaseRevision: "non-git",
      expectedHead: "non-git",
      treePolicy: { kind: "require-clean" },
    };
  }
  const [topLevel, commonDir, head, status] = await Promise.all([
    requiredGitOutput(workDir, ["rev-parse", "--show-toplevel"]),
    requiredGitOutput(workDir, ["rev-parse", "--git-common-dir"]),
    requiredGitOutput(workDir, ["rev-parse", "HEAD"]),
    requiredGitOutput(workDir, ["status", "--porcelain=v1", "-z", "-uall"]),
  ]);
  const repositoryIdentity = digestText(`repository\0${path.resolve(workDir, commonDir)}`);
  const worktreeIdentity = digestText(`worktree\0${path.resolve(topLevel)}`);
  return {
    repositoryIdentity,
    worktreeIdentity,
    segmentBaseRevision: head,
    expectedHead: head,
    treePolicy: status
      ? { kind: "initial-dirty", fingerprint: digestText(status) }
      : { kind: "require-clean" },
  };
}

async function requiredGitOutput(workDir: string, args: string[]): Promise<string> {
  const result = await runGit(args, workDir);
  if (result.code !== 0) {
    throw new Error(`Git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
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
  const packets = input.currentRuns.length;
  const evaluatorRuns = input.currentRuns.reduce(
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
