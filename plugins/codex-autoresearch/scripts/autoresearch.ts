#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { decisionGuidance } from "../lib/decision-guidance.js";
import { decisionDiagnostic, type DecisionPlan } from "../lib/decision-compiler.js";
import {
  projectCompactDecisionPlan,
  projectDashboardDecisionPlan,
  projectLoopContinuation,
  projectResolvedDecision,
} from "../lib/decision-projection.js";
import { loadCanonicalSessionDecision } from "../lib/session-decision.js";
import {
  adaptAcceptedSessionMetadata,
  adaptLegacySessionMetadata,
  classifyFit,
  requestsNamedSessionContinuation,
  withFitCompatibilityConflicts,
} from "../lib/fit-gate.js";
import { stripDashboardGuidanceCommandFields } from "../lib/dashboard-command-safety.js";
import { dashboardSafeGuidanceText } from "../lib/dashboard-transport.js";
import { DASHBOARD_LEDGER_MAX_ENTRIES, type DashboardLedgerFold } from "../lib/dashboard-ledger.js";
import {
  buildDashboardSettings as dashboardSettings,
  dashboardCommands,
} from "../lib/commands/dashboard.js";
import { buildContinuationCommands, continuationCommands } from "../lib/commands/continuation.js";
import {
  buildCompactRecommendNextResponse,
  buildRecommendNextResponse,
} from "../lib/commands/recommend-next.js";
import { doctorSession as runDoctorSession } from "../lib/commands/doctor.js";
import { runExperiment } from "../lib/commands/run.js";
import {
  compactPublicState as compactStateResponse,
  finalizationPressureForWorkDir as buildFinalizationPressureForWorkDir,
  publicState as readPublicState,
} from "../lib/commands/state.js";
import { logExperiment } from "../lib/commands/log.js";
import {
  defaultCommandShell,
  normalizeCommandShell,
  quoteShellArg,
  renderShellCommand,
  type CommandShell,
} from "../lib/command-rendering.js";
import {
  actionToolNameForKind,
  actionTitleForKind,
  resolveActionCommand,
} from "../lib/action-metadata.js";
import { renderCliHelp } from "../lib/cli/help.js";
import {
  commandRequiresSessionMutationLock,
  commandUsesSessionDecisionProtocol,
  compatibilityErrorForCli,
} from "../lib/command-table.js";
import {
  CliUsageError,
  cliDebugRequested,
  isKnownCliCommand,
  parseAutoresearchCliArgs,
} from "../lib/cli/options.js";
import {
  boolOption,
  enumOption,
  nonNegativeIntegerOption,
  numberOption,
  parseJsonOption,
  positiveIntegerOption,
} from "../lib/cli/args.js";
import {
  resolveAuthorizedWorkDir,
  withAcceptedWorkdirResolution,
  withOutsideWorkdirAuthorization,
} from "../lib/cli/workdir-context.js";
import { createCliCommandHandlers, runCliCommand } from "../lib/cli-handlers.js";
import { resolveInitialSessionMutationRoute } from "../lib/coherent-session-snapshot.js";
import { buildDriftReport, runtimeProvenance } from "../lib/drift-doctor.js";
import { analyzeExperimentEconomics } from "../lib/experiment-economics.js";
import {
  acceptedExperimentContractForMutation,
  appendExperimentContractAcceptance,
  contractDerivationError,
  deriveExperimentContract,
  executionCommandText,
} from "../lib/experiment-contract.js";
import {
  createActiveProgressWriter,
  deleteActiveProgressSnapshotIfSafe,
  readActiveProgressSnapshot,
  recoverTerminationFailedProgress,
} from "../lib/active-progress-store.js";
import { rekeyProcessLifecycleRecords } from "../lib/process-governor.js";
import { COMMAND_EXECUTION_BOUNDARY } from "../lib/command-execution-boundary.js";
import {
  CommandDecisionProtocolError,
  commandDecisionProtocolFailureEnvelope,
  runCommandDecisionProtocol,
  type CommandDecisionProtocolResult,
} from "../lib/command-decision-protocol.js";
import { defaultChecksCommand } from "../lib/check-policy.js";
import { buildSourceCleanliness } from "../lib/source-cleanliness.js";
import { buildSessionReadModelState } from "../lib/session-read-model.js";
import { normalizeProtectedBenchmarkPaths } from "../lib/benchmark/contract-guards.js";
import { packetBudgetUsage } from "../lib/benchmark/budget-contract.js";
import {
  defaultBenchmarkCommand,
  defaultBenchmarkCommandExists,
  resolveBenchmarkCommandSource,
} from "../lib/benchmark/command-input.js";
import { benchmarkContractSnapshot } from "../lib/benchmark/contract-snapshot.js";
import {
  normalizeSecondaryMetricConstraintMode,
  normalizeSecondaryMetricConstraints,
} from "../lib/benchmark/multi-metric-constraints.js";
import {
  redactCommandDisplay,
  redactEvidenceObject,
  redactEvidenceText,
  redactPathDisplay,
} from "../lib/evidence-redaction.js";
import { artifactList } from "../lib/evidence-registry.js";
import { isPathInside } from "../lib/path-containment.js";
import { resolveSafeResearchPath } from "../lib/research-path-guard.js";
import { buildExperimentMemory } from "../lib/experiment-memory.js";
import { fixedControlBlockForCommand, fixedControlRerunError } from "../lib/fixed-control.js";
import { runWithRequiredCleanup } from "../lib/required-cleanup.js";
import { normalizeRelativePaths } from "../lib/literal-paths.js";
import {
  gitSnapshotContainsDirtyFingerprintTruncation,
  lastRunConfigSnapshot,
  lastRunGitSnapshot,
  lastRunPacketFingerprint,
  lastRunPacketFreshness,
  lastRunTrustConfigSnapshot,
  lastRunStateSpec,
  readLastRunPacket,
  replacementNextCommandForLastRun,
  resolveLastRunPath,
} from "../lib/last-run-store.js";
import {
  autoresearchPrivateStateCandidatePaths,
  preflightAutoresearchPrivateState,
  writePrivateStateFile,
} from "../lib/git-private-state.js";
import { buildLaneLifecycle } from "../lib/lane-lifecycle.js";
import { buildOperatorChecklist } from "../lib/operator-checklist.js";
import { buildOperatorSnapshot } from "../lib/operator-snapshot.js";
import { classifyPacketDiagnostics } from "../lib/packet-diagnostics.js";
import {
  buildParallelLanes,
  buildParallelOrchestrationContext,
} from "../lib/parallel-orchestration.js";
import {
  benchmarkIntegrityPreflight,
  operatorWarningsForWorkDir,
} from "../lib/operator-warnings.js";
import {
  currentQualityGapSummary,
  gapCandidates as buildGapCandidates,
  QUALITY_GAP_DECISIONS_FILE,
  recordQualityGapDecision,
  resolveResearchSlugForQualityGapSync,
  summarizeQualityGaps,
} from "../lib/research-gaps.js";
import { recommendPortfolioDirection } from "../lib/portfolio-advisor.js";
import {
  applyResolvedRecipeDefaults,
  findRecipe,
  getBuiltInRecipe,
  listBuiltInRecipes,
  loadRecipeCatalog,
  recommendRecipe,
} from "../lib/recipes.js";
import {
  createProgressSnapshot,
  finishProgressSnapshot,
  progressSnapshotFromRun,
} from "../lib/runner-progress.js";
import {
  appendJsonl,
  createSessionReadCache,
  finiteMetric,
  currentState,
  loadSessionRecords,
  loadSessionState,
  listOption,
  pathExists,
  stateFromSessionRecords,
  safeSlug,
  promotionGradeValue,
  readConfig as readSessionConfig,
} from "../lib/session-core.js";
import { validateMetricName } from "../lib/runner.js";
import { buildResearchIntegrity, buildScaffoldHealth } from "../lib/truth-signals.js";
import {
  analyzeLedgerHealth,
  readLedgerRecordsTolerant,
  repairLedgerRecords,
} from "../lib/ledger-health.js";
import { analyzeWorkflowFriction } from "../lib/workflow-friction.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import {
  AUTORESEARCH_RESEARCH_DIR,
  researchDirPathForSession,
  resolveSessionPaths,
  type SessionPaths,
} from "../lib/session-paths.js";
import { indexTaskArtifacts } from "../lib/task-artifact-indexer.js";
import { checkedAtomicWriteFile, checkedEnsureDirectory } from "../lib/checked-write.js";
import {
  sessionMutationLockLocation,
  withSessionMutationLock,
} from "../lib/session-mutation-lock.js";

type LooseObject = Record<string, any>;
type WorkDirResolution = {
  config: LooseObject;
  sessionPaths: SessionPaths;
  sessionCwd: string;
  workDir: string;
};

const RESEARCH_DIR = AUTORESEARCH_RESEARCH_DIR;

const AUTONOMY_MODES = new Set(["guarded", "owner-autonomous", "manual"]);
const CHECKS_POLICIES = new Set(["always", "on-improvement", "manual"]);
const KEEP_POLICIES = new Set(["primary-only", "primary-or-risk-reduction"]);
const SECONDARY_METRIC_CONSTRAINT_MODES = new Set(["advisory", "blocking"]);
const DEFAULT_TIMEOUT_SECONDS = 600;
type DashboardViewModelModule = typeof import("../lib/dashboard-view-model.js");
type FinalizePreviewModule = typeof import("../lib/finalize-preview.js");
type LiveServerModule = typeof import("../lib/live-server.js");

async function buildDashboardViewModelLazy(
  ...args: Parameters<DashboardViewModelModule["buildDashboardViewModel"]>
): Promise<ReturnType<DashboardViewModelModule["buildDashboardViewModel"]>> {
  return (await import("../lib/dashboard-view-model.js")).buildDashboardViewModel(...args);
}

async function buildFinalizePreview(
  ...args: Parameters<FinalizePreviewModule["finalizePreview"]>
): Promise<Awaited<ReturnType<FinalizePreviewModule["finalizePreview"]>>> {
  return (await import("../lib/finalize-preview.js")).finalizePreview(...args);
}

async function buildFinalizeCurrentTree(
  ...args: Parameters<FinalizePreviewModule["finalizeCurrentTree"]>
): Promise<Awaited<ReturnType<FinalizePreviewModule["finalizeCurrentTree"]>>> {
  return (await import("../lib/finalize-preview.js")).finalizeCurrentTree(...args);
}

async function serveAutoresearchLazy(
  ...args: Parameters<LiveServerModule["serveAutoresearch"]>
): Promise<Awaited<ReturnType<LiveServerModule["serveAutoresearch"]>>> {
  return (await import("../lib/live-server.js")).serveAutoresearch(...args);
}
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
export const AUTORESEARCH_RUNTIME_IDENTITY = {
  pluginVersion: PLUGIN_VERSION,
} as const;

async function publicState(args: LooseObject): Promise<LooseObject> {
  return await readPublicState(args);
}

function compactPublicState(state: LooseObject): LooseObject {
  return compactStateResponse(state);
}

async function finalizationPressureForWorkDir(args: {
  workDir: string;
  state: LooseObject;
  qualityGap: LooseObject | null;
  warningDetails: LooseObject[];
}): Promise<LooseObject> {
  return await buildFinalizationPressureForWorkDir(args);
}

async function doctorSession(args: LooseObject): Promise<LooseObject> {
  return await runDoctorSession(args);
}
const DASHBOARD_GUIDANCE_EXTRA_DROP_FIELDS = new Set([
  "runtimeDriftSummary",
  "gateQuality",
  "preflight",
]);

async function exportDashboard(args: LooseObject): Promise<LooseObject> {
  const { exportDashboard: runExportDashboard } = await import("../lib/commands/dashboard.js");
  return await runExportDashboard(args, {
    dashboardViewModel,
    serveAutoresearch: serveAutoresearchLazy,
  });
}

async function serveDashboard(args: LooseObject): Promise<LooseObject> {
  const { serveDashboard: runServeDashboard } = await import("../lib/commands/dashboard.js");
  return await runServeDashboard(args, {
    dashboardViewModel,
    serveAutoresearch: serveAutoresearchLazy,
  });
}

async function benchmarkLint(args: LooseObject): Promise<LooseObject> {
  const { benchmarkLint: runBenchmarkLint } = await import("../lib/commands/inspect.js");
  return await runBenchmarkLint(args);
}

async function benchmarkInspect(args: LooseObject): Promise<LooseObject> {
  const { benchmarkInspect: runBenchmarkInspect } = await import("../lib/commands/inspect.js");
  return await runBenchmarkInspect(args);
}

async function checksInspect(args: LooseObject): Promise<LooseObject> {
  const { checksInspect: runChecksInspect } = await import("../lib/commands/inspect.js");
  return await runChecksInspect(args);
}

async function partialResultsCommand(args: LooseObject): Promise<LooseObject> {
  const { partialResultsCommand: runPartialResultsCommand } =
    await import("../lib/commands/partial-results.js");
  return await runPartialResultsCommand(args);
}

async function sessionForensics(args: LooseObject): Promise<LooseObject> {
  const { sessionForensics: runSessionForensics } =
    await import("../lib/commands/session-forensics.js");
  return await runSessionForensics(args);
}

async function laneRunner(args: LooseObject): Promise<LooseObject> {
  const { laneRunner: runLaneRunner } = await import("../lib/commands/lane-runner.js");
  return await runLaneRunner(args);
}

function usage(options: { all?: boolean; command?: string | null } = {}) {
  return renderCliHelp(options);
}

function commandLine(
  argv: readonly unknown[],
  shell: CommandShell = defaultCommandShell(),
): string {
  return renderShellCommand(argv, shell);
}

function shellQuote(value: unknown, shell: CommandShell = defaultCommandShell()): string {
  return quoteShellArg(value, shell);
}

function slashPath(value: unknown): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function readConfig(sessionCwd: string): LooseObject {
  return readSessionConfig(sessionCwd);
}

function runtimeConfigPath(sessionCwd: string): string {
  return resolveSessionPaths({ sessionCwd, workDir: sessionCwd }).configPath;
}

function resolveWorkDir(cwdArg: unknown): WorkDirResolution {
  return resolveAuthorizedWorkDir(cwdArg);
}

function assetPath(fileName: string) {
  return path.join(PLUGIN_ROOT, "assets", fileName);
}

function readAssetTemplate(fileName: string) {
  return fs.readFileSync(assetPath(fileName), "utf8");
}

function replaceAllText(text: string, replacements: Record<string, unknown>): string {
  let out = text;
  for (const [from, to] of Object.entries(replacements)) {
    out = out.split(from).join(String(to));
  }
  return out;
}

function shellKindFromArgs(args: LooseObject): CommandShell {
  return normalizeCommandShell(args.shell ?? args.script);
}

async function withRecipeDefaults(args: LooseObject): Promise<LooseObject> {
  const recipeId = args.recipe_id ?? args.recipeId ?? args.recipe;
  return recipeId
    ? await applyResolvedRecipeDefaults(args, recipeId, args.catalog, {
        catalogBaseDir: recipeCatalogBaseDir(args),
        trustCatalog: trustCatalogOption(args),
      })
    : args;
}

function recipeCatalogBaseDir(args: LooseObject): string {
  try {
    return resolveWorkDir(args.working_dir || args.cwd).sessionCwd;
  } catch {
    return process.cwd();
  }
}

function trustCatalogOption(args: LooseObject): boolean {
  return boolOption(args.trust_catalog ?? args.trustCatalog, false);
}

function explicitBenchmarkPrintsMetric(args: LooseObject): boolean {
  const hasExplicitBenchmarkCommand = Boolean(args.benchmark_command || args.benchmarkCommand);
  return boolOption(
    args.benchmark_prints_metric ?? args.benchmarkPrintsMetric,
    hasExplicitBenchmarkCommand,
  );
}

function scopeWarningsFromArgs(args: LooseObject): string[] {
  const scope = normalizeRelativePaths(
    args.files_in_scope ?? args.filesInScope ?? args.scope,
    "filesInScope",
  ).map(slashPath);
  const commitPaths = normalizeRelativePaths(
    args.commit_paths ?? args.commitPaths,
    "commitPaths",
  ).map(slashPath);
  if (!scope.length || !commitPaths.length) return [];
  const covers = (container: string, item: string) =>
    container === item || item.startsWith(`${container}/`) || container.startsWith(`${item}/`);
  const commitOutsideScope = commitPaths.filter((commitPath) =>
    scope.every((scopePath) => !covers(scopePath, commitPath)),
  );
  const scopeOutsideCommit = scope.filter((scopePath) =>
    commitPaths.every((commitPath) => !covers(commitPath, scopePath)),
  );
  const warnings: string[] = [];
  if (commitOutsideScope.length) {
    warnings.push(`commitPaths not represented in filesInScope: ${commitOutsideScope.join(", ")}`);
  }
  if (scopeOutsideCommit.length) {
    warnings.push(`filesInScope not represented in commitPaths: ${scopeOutsideCommit.join(", ")}`);
  }
  return warnings;
}

function firstRunChecklist({
  setupCommand,
  benchmarkLintCommand,
  doctorCommand,
  checkpoint,
  baselineCommand,
  logCommand,
}: LooseObject) {
  const steps = [
    { step: "setup", command: setupCommand, purpose: "Create or refresh the session files." },
  ];
  if (benchmarkLintCommand) {
    steps.push({
      step: "benchmark-lint",
      command: benchmarkLintCommand,
      purpose: "Validate that the benchmark emits the primary METRIC line before running it live.",
    });
  }
  steps.push({
    step: "doctor",
    command: doctorCommand,
    purpose: "Run setup/readiness checks and confirm the benchmark contract.",
  });
  if (checkpoint?.commands?.length) {
    steps.push({
      step: "checkpoint",
      command: checkpoint.commands.join(" && "),
      purpose: "Commit generated session files before experiment-scoped keep commits.",
    });
  }
  steps.push(
    { step: "baseline", command: baselineCommand, purpose: "Run the first measured packet." },
    {
      step: "log",
      command: logCommand,
      purpose: "Record the packet with status and ASI before starting another run.",
    },
  );
  return steps;
}

async function setupPlan(args: any) {
  const { sessionCwd, workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const readCache = args.readCache;
  const catalogOptions = { catalogBaseDir: sessionCwd };
  const requestedRecipe = args.recipe_id ?? args.recipeId ?? args.recipe;
  const storedRecipe = config?.recipeId;
  let recommended = null;
  if (requestedRecipe) {
    recommended = await findRecipe(requestedRecipe, args.catalog, catalogOptions);
    if (!recommended) throw new Error(`Unknown recipe: ${requestedRecipe}`);
  } else if (storedRecipe) {
    recommended =
      (await findRecipe(storedRecipe, args.catalog, catalogOptions)) ||
      (await recommendRecipe(workDir));
  } else {
    recommended = await recommendRecipe(workDir);
  }
  const state = loadSessionState(workDir, readCache);
  const hasDefaultBenchmarkCommand = await defaultBenchmarkCommandExists(workDir);
  const planArgs = await withRecipeDefaults({
    ...args,
    recipe: recommended?.id,
    name: args.name || recommended?.title || "Autoresearch session",
  });
  const benchmarkCommand = planArgs.benchmark_command || planArgs.benchmarkCommand || "";
  const missing = [];
  if (!args.name && !state.config.name && !recommended) missing.push("name");
  if (!args.metric_name && !args.metricName && !state.config.metricName && !recommended)
    missing.push("metric_name");
  if (state.current.length === 0 && !benchmarkCommand && !hasDefaultBenchmarkCommand) {
    missing.push("benchmark_command");
  }
  const shellKind = shellKindFromArgs(planArgs);
  const setupMaxIterations = positiveIntegerOption(
    planArgs.max_iterations ?? planArgs.maxIterations,
    null,
    "maxIterations",
  );
  const commitPaths = normalizeRelativePaths(
    planArgs.commit_paths ?? planArgs.commitPaths,
    "commitPaths",
  );
  const checksCommand = planArgs.checks_command || planArgs.checksCommand || "";
  const metricName = validateMetricName(planArgs.metric_name || planArgs.metricName || "seconds");
  const qualityConstraints = uniqueQualityConstraints([
    ...qualityConstraintsFromInput(planArgs.quality_constraints ?? planArgs.qualityConstraints),
    ...qualityConstraintsForText(
      [
        planArgs.goal,
        planArgs.name,
        benchmarkCommand,
        checksCommand,
        listOption(planArgs.constraints).join(" "),
      ].join(" "),
    ),
  ]);
  const benchmarkPrintsMetric = explicitBenchmarkPrintsMetric(planArgs);
  const benchmarkMode = {
    explicitCommand: Boolean(benchmarkCommand),
    printsMetric: benchmarkPrintsMetric,
    note: benchmarkCommand
      ? benchmarkPrintsMetric
        ? "Explicit benchmark commands are treated as metric-emitting by default. Pass --benchmark-prints-metric false to time a raw workload instead."
        : "This explicit benchmark command will be wrapped and timed by the generated script."
      : "No explicit benchmark command was provided; generated placeholder wrappers must be replaced before use.",
  };
  const catalogTrustArgs = [
    ...(args.catalog ? ["--catalog", args.catalog] : []),
    ...(args.catalog && trustCatalogOption(args) ? ["--trust-catalog"] : []),
  ];
  const commandArgs = [
    "node",
    path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
    "setup",
    "--cwd",
    workDir,
    "--name",
    planArgs.name || "Autoresearch session",
    ...(planArgs.goal ? ["--goal", planArgs.goal] : []),
    "--metric-name",
    metricName,
    ...(planArgs.metric_unit || planArgs.metricUnit
      ? ["--metric-unit", planArgs.metric_unit ?? planArgs.metricUnit]
      : []),
    "--direction",
    planArgs.direction || "lower",
    "--shell",
    shellKind,
    ...(benchmarkCommand ? ["--benchmark-command", benchmarkCommand] : []),
    ...(planArgs.benchmark_prints_metric != null || planArgs.benchmarkPrintsMetric != null
      ? [
          "--benchmark-prints-metric",
          planArgs.benchmark_prints_metric ?? planArgs.benchmarkPrintsMetric,
        ]
      : []),
    ...(checksCommand ? ["--checks-command", checksCommand] : []),
    ...(listOption(planArgs.files_in_scope ?? planArgs.filesInScope).length
      ? ["--files-in-scope", listOption(planArgs.files_in_scope ?? planArgs.filesInScope).join(",")]
      : []),
    ...(listOption(planArgs.off_limits ?? planArgs.offLimits).length
      ? ["--off-limits", listOption(planArgs.off_limits ?? planArgs.offLimits).join(",")]
      : []),
    ...(listOption(planArgs.constraints).length
      ? ["--constraints", listOption(planArgs.constraints).join(",")]
      : []),
    ...(qualityConstraints.length
      ? ["--quality-constraints", JSON.stringify(qualityConstraints)]
      : []),
    ...(listOption(planArgs.secondary_metrics ?? planArgs.secondaryMetrics).length
      ? [
          "--secondary-metrics",
          listOption(planArgs.secondary_metrics ?? planArgs.secondaryMetrics).join(","),
        ]
      : []),
    ...(listOption(planArgs.secondary_metric_constraints ?? planArgs.secondaryMetricConstraints)
      .length
      ? [
          "--secondary-metric-constraints",
          listOption(
            planArgs.secondary_metric_constraints ?? planArgs.secondaryMetricConstraints,
          ).join(","),
        ]
      : []),
    ...((planArgs.secondary_metric_constraint_mode ?? planArgs.secondaryMetricConstraintMode)
      ? [
          "--secondary-metric-constraint-mode",
          planArgs.secondary_metric_constraint_mode ?? planArgs.secondaryMetricConstraintMode,
        ]
      : []),
    ...(listOption(planArgs.protected_benchmark_paths ?? planArgs.protectedBenchmarkPaths).length
      ? [
          "--protected-benchmark-paths",
          listOption(planArgs.protected_benchmark_paths ?? planArgs.protectedBenchmarkPaths).join(
            ",",
          ),
        ]
      : []),
    ...(setupMaxIterations != null ? ["--max-iterations", setupMaxIterations] : []),
    ...((planArgs.packet_budget ?? planArgs.packetBudget)
      ? ["--packet-budget", planArgs.packet_budget ?? planArgs.packetBudget]
      : []),
    ...((planArgs.wall_clock_budget_seconds ?? planArgs.wallClockBudgetSeconds)
      ? [
          "--wall-clock-budget-seconds",
          planArgs.wall_clock_budget_seconds ?? planArgs.wallClockBudgetSeconds,
        ]
      : []),
    ...((planArgs.budget_note ?? planArgs.budgetNote)
      ? ["--budget-note", planArgs.budget_note ?? planArgs.budgetNote]
      : []),
    ...(commitPaths.length > 0 ? ["--commit-paths", commitPaths.join(",")] : []),
    ...(recommended ? ["--recipe", recommended.id] : []),
    ...catalogTrustArgs,
  ];
  const command = commandLine(commandArgs, shellKind);
  const doctorCommand = commandLine(
    [
      "node",
      path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
      "doctor",
      "--cwd",
      workDir,
      "--check-benchmark",
      ...catalogTrustArgs,
    ],
    shellKind,
  );
  const benchmarkLintCommand = benchmarkCommand
    ? commandLine(
        [
          "node",
          path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
          "benchmark-lint",
          "--cwd",
          workDir,
          "--metric-name",
          metricName,
          "--command",
          benchmarkCommand,
        ],
        shellKind,
      )
    : hasDefaultBenchmarkCommand
      ? commandLine(
          [
            "node",
            path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
            "benchmark-lint",
            "--cwd",
            workDir,
            "--metric-name",
            metricName,
            "--command",
            await defaultBenchmarkCommand(workDir),
          ],
          shellKind,
        )
      : "";
  const baselineCommand = commandLine(
    ["node", path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"), "next", "--cwd", workDir],
    shellKind,
  );
  const logCommand = commandLine(
    [
      "node",
      path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
      "log",
      "--cwd",
      workDir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Baseline measurement",
    ],
    shellKind,
  );
  const guideCommand = commandLine(
    ["node", path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"), "guide", "--cwd", workDir],
    shellKind,
  );
  const scopeWarnings = scopeWarningsFromArgs(planArgs);
  const integrityPreflight = await benchmarkIntegrityPreflight(workDir, config, state);
  const scaffoldHealth = await buildScaffoldHealth({ workDir, config });
  const researchIntegrity = buildResearchIntegrity({ state, config });
  const guidance = await decisionGuidance({
    workDir,
    config,
    state,
    scaffoldHealth,
    warningDetails: integrityPreflight,
    setupMissing: missing,
    qualityConstraints,
    benchmarkCommand,
    checksCommand,
  });
  const preSetupCheckpoint =
    commitPaths.length > 0
      ? {
          paths: [
            path.relative(workDir, resolveSessionPaths({ workDir }).notesPath),
            path.relative(workDir, resolveSessionPaths({ workDir }).ideasPath),
            shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1",
            "autoresearch.config.json",
          ],
          commands: [
            commandLine(
              [
                "git",
                "add",
                "--",
                path.relative(workDir, resolveSessionPaths({ workDir }).notesPath),
                path.relative(workDir, resolveSessionPaths({ workDir }).ideasPath),
                shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1",
                "autoresearch.config.json",
              ],
              shellKind,
            ),
            commandLine(
              [
                "git",
                "commit",
                "-m",
                `Start autoresearch session: ${planArgs.name || "Autoresearch session"}`,
              ],
              shellKind,
            ),
          ],
          note: "Run after setup creates files and before the first experiment-scoped keep commit.",
        }
      : null;
  const checklist = firstRunChecklist({
    setupCommand: command,
    benchmarkLintCommand,
    doctorCommand,
    checkpoint: preSetupCheckpoint,
    baselineCommand,
    logCommand,
  });
  const configured = Boolean(config && Object.keys(config).length > 0);
  const hasMissingEssentials = missing.length > 0;
  const configuredNextCommand = doctorCommand || guideCommand;
  const safeNextCommand = configured && !hasMissingEssentials ? configuredNextCommand : command;
  return {
    ok: true,
    workDir,
    sessionCwd,
    configured,
    currentMetric: state.config.metricName,
    recommendedRecipe: recommended,
    missing,
    defaultBenchmarkCommandReady: hasDefaultBenchmarkCommand,
    benchmarkMode,
    benchmarkLintCommand,
    qualityConstraints,
    gateQuality: guidance.gateQuality,
    preflight: guidance.preflight,
    runtimeDriftSummary: guidance.runtimeDriftSummary,
    scopeWarnings,
    scaffoldHealth,
    researchIntegrity,
    integrityPreflight,
    nextCommand: safeNextCommand,
    guideCommand,
    baselineCommand,
    missingEssentials: missing,
    nextStep:
      configured && !hasMissingEssentials
        ? sharedNextStep({
            stage: "configured-session",
            title: "Verify configured session",
            reason: "Session setup is present; verify benchmark and state before packet work.",
            command: configuredNextCommand,
            toolName: "doctor",
            safety: "read_or_check",
            missingEssentials: [],
          })
        : sharedNextStep({
            stage: "setup-repair",
            title: "Create session setup",
            reason: missing.length
              ? `Setup still needs: ${missing.join(", ")}.`
              : "Create or refresh the Autoresearch session files before the first packet.",
            command,
            toolName: "setup_session",
            safety: "state_mutation",
            missingEssentials: missing,
          }),
    firstRunChecklist: checklist,
    guidedFlow: checklist,
    notes: [
      "setup-plan is read-only.",
      "Before the first live packet, run benchmark-lint or doctor --check-benchmark so a broken or expensive benchmark is caught early.",
      "Generated recipe scripts remain inspectable and should be checkpointed before experiment-scoped keep commits.",
      benchmarkMode.note,
      ...scopeWarnings.map((warning: any) => `Scope warning: ${warning}`),
    ],
  };
}

function sharedNextStep({
  stage,
  title,
  reason,
  command = "",
  toolName = "",
  safety = "read",
  missingEssentials = [],
  staleState = null,
}: LooseObject) {
  return {
    stage,
    nextAction: {
      title,
      reason,
      command,
      toolName,
      safety,
    },
    missingEssentials: listOption(missingEssentials),
    ...(staleState ? { staleState } : {}),
  };
}

function guidedNextStep({
  stage,
  nextAction,
  setup,
  commands,
  lastRunFreshness = null,
}: LooseObject) {
  const replacementAction = commands?.replaceLast || "";
  if (stage === "needs-setup" || stage === "needs-benchmark-command") {
    return sharedNextStep({
      stage: "setup-repair",
      title: "Repair setup",
      reason: nextAction,
      command: commands?.setup || setup?.nextCommand || "",
      toolName: "setup_session",
      safety: "state_mutation",
      missingEssentials: setup?.missing || setup?.missingEssentials || [],
    });
  }
  if (stage === "stale-last-run") {
    return sharedNextStep({
      stage: "log-decision",
      title: "Replace stale packet",
      reason: nextAction || "The saved packet no longer matches current state.",
      command: replacementAction,
      toolName: "next_experiment",
      safety: "process_start",
      staleState: {
        stale: true,
        reason: lastRunFreshness?.reason || nextAction || "",
        replacementAction,
      },
    });
  }
  if (stage === "needs-log-decision") {
    return sharedNextStep({
      stage: "log-decision",
      title: "Log packet decision",
      reason: nextAction,
      command: commands?.logLast || "",
      toolName: "log_experiment",
      safety: "git_mutation",
    });
  }
  if (stage === "limit-reached") {
    return sharedNextStep({
      stage: "segment-reset",
      title: "Start or extend segment",
      reason: nextAction,
      command: commands?.newSegmentDryRun || "",
      toolName: "new_segment",
      safety: "state_mutation",
    });
  }
  return sharedNextStep({
    stage: "baseline-packet",
    title: stage === "ready" ? "Run next packet" : "Run baseline packet",
    reason: nextAction || "Run one measured packet, then log the decision with ASI.",
    command: commands?.baseline || "",
    toolName: "next_experiment",
    safety: "process_start",
  });
}

function canonicalActionForGuidedSetup({ doctor, stage }: LooseObject): LooseObject | null {
  const plan = compactRecord(doctor?.decisionPlan);
  const action = compactRecord(plan?.action);
  const capabilities = compactRecord(plan?.capabilities);
  const runPacket = compactRecord(capabilities?.["run-packet"]);
  if (!action || runPacket?.status === "allowed") return null;
  if (
    (stage === "stale-last-run" && action.kind === "replace-packet") ||
    (stage === "needs-log-decision" && action.kind === "log-decision") ||
    (stage === "needs-setup" && action.kind === "setup") ||
    (stage === "needs-benchmark-command" && action.kind === "configure-benchmark")
  ) {
    return null;
  }
  return action;
}

function canonicalGuidedNextStep({ action, commands, fallbackReason }: LooseObject) {
  const kind = String(action?.kind || "doctor");
  const command = resolveActionCommand(kind, commands, {
    explicitCommand: action?.command,
  });
  return sharedNextStep({
    stage: guidedStageForCanonicalKind(kind),
    title: actionTitleForKind(kind, "Resolve loop blocker"),
    reason:
      actionMessage(action) || fallbackReason || "Resolve the loop blocker before packet work.",
    command,
    toolName: guidedToolNameForCanonicalKind(kind),
    safety: guidedSafetyForCanonicalKind(kind),
  });
}

function guidedStageForCanonicalKind(kind: string): string {
  if (kind === "setup" || kind === "benchmark-command") return "setup-repair";
  if (kind === "segment-transition") return "segment-reset";
  if (kind === "finalization" || kind === "finalize-preview") return "finalization-preview";
  return kind || "doctor";
}

function guidedToolNameForCanonicalKind(kind: string): string {
  return actionToolNameForKind(kind);
}

function guidedSafetyForCanonicalKind(kind: string): string {
  if (kind === "setup" || kind === "segment-transition") return "state_mutation";
  if (kind === "next-packet" || kind === "baseline") return "process_start";
  if (kind === "log-decision") return "git_mutation";
  return "read";
}

async function promptPlan(args: LooseObject): Promise<LooseObject> {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const prompt = String(args.prompt || args.goal || args.request || "").trim();
  if (!prompt) throw new Error("prompt-plan requires --prompt <text>.");
  const directFit = classifyFit({ prompt, session: null });
  if (directFit.disposition === "continue-direct") {
    return {
      ok: true,
      workDir,
      kind: "codex-autoresearch-prompt-plan",
      prompt,
      fit: directFit,
      directEvidence: directFit.nextAction.capsule,
      nextAction: directFit.nextAction,
    };
  }
  const records = loadSessionRecords(workDir);
  const sessionConfig = records.length
    ? { ...stateFromSessionRecords(workDir, records).config, ...config }
    : config;
  let session = adaptLegacySessionMetadata(sessionConfig);
  if (session && requestsNamedSessionContinuation(prompt, session.name)) {
    const derivation = await deriveExperimentContract({ workDir, config });
    if (derivation.status === "accepted") {
      session = adaptAcceptedSessionMetadata(sessionConfig, derivation.contract);
    } else if (derivation.status === "invalid") {
      session = withFitCompatibilityConflicts(
        session,
        derivation.conflicts.map(({ field, sources, message }) => ({
          field,
          sources,
          message,
        })),
      );
    }
  }
  const fit = classifyFit({ prompt, session });
  if (fit.disposition === "continue-direct") {
    return {
      ok: true,
      workDir,
      kind: "codex-autoresearch-prompt-plan",
      prompt,
      fit,
      directEvidence: fit.nextAction.capsule,
      nextAction: fit.nextAction,
    };
  }
  if (fit.disposition === "needs-user") {
    return {
      ok: true,
      workDir,
      kind: "codex-autoresearch-prompt-plan",
      prompt,
      fit,
      nextAction: fit.nextAction,
    };
  }
  return {
    ok: true,
    workDir,
    kind: "codex-autoresearch-prompt-plan",
    prompt,
    fit,
    contractCandidate: fit.contract,
    nextAction: fit.nextAction,
  };
}

function qualitySensitivePerformanceDomain(text: string): string[] {
  const normalized = text.toLowerCase();
  const domains: string[] = [];
  if (/(retrieval|search|semantic|ranking|ranker|recall|mrr|accuracy)/.test(normalized)) {
    domains.push("retrieval_quality");
  }
  if (/(accessibility|wcag|keyboard|screen reader|aria)/.test(normalized)) {
    domains.push("accessibility_quality");
  }
  if (/(safety|security|auth|permission|data integrity|migration)/.test(normalized)) {
    domains.push("safety_integrity");
  }
  return domains;
}

type QualityConstraint = {
  domain: string;
  guidance: string;
  requiredBeforePromotion: boolean;
};

function qualityConstraintsForText(text: string): QualityConstraint[] {
  return qualitySensitivePerformanceDomain(text).map((domain) => ({
    domain,
    requiredBeforePromotion: true,
    guidance:
      domain === "retrieval_quality"
        ? "Add or identify recall/MRR/hit@k/ranking checks before treating speed wins as product-grade."
        : "Add or identify a correctness check before promotion.",
  }));
}

function qualityConstraintsFromInput(value: unknown): QualityConstraint[] {
  let parsed = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const record = entry as LooseObject;
      const domain = String(record.domain || "").trim();
      if (!domain) return null;
      const guidance =
        String(record.guidance || "").trim() ||
        "Add or identify a correctness check before promotion.";
      return {
        domain,
        requiredBeforePromotion: record.requiredBeforePromotion !== false,
        guidance,
      };
    })
    .filter((entry): entry is QualityConstraint => Boolean(entry));
}

function uniqueQualityConstraints(constraints: QualityConstraint[]) {
  const seen = new Set<string>();
  const unique = [];
  for (const constraint of constraints) {
    const key = constraint.domain;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(constraint);
  }
  return unique;
}

function metricLooksHigherIsBetter(metricName: string) {
  return /score|quality|throughput|docs_per_second|hit|mrr/i.test(metricName);
}

function uniqueStrings(items: any[]) {
  return [
    ...new Set(
      listOption(items)
        .map((item: any) => String(item).trim())
        .filter(Boolean),
    ),
  ];
}

async function guidedSetup(args: LooseObject): Promise<LooseObject> {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const readCache = args.readCache;
  if (boolOption(args.compact, false)) {
    return compactGuidedSetup({ workDir, config, readCache });
  }
  const setup = await setupPlan(args);
  const state: LooseObject = await publicState({ cwd: workDir, readCache });
  const doctor = await doctorSession({
    ...args,
    cwd: workDir,
    checkBenchmark: false,
    check_benchmark: false,
    jsonFull: true,
  });
  const lastRun = await readLastRunPacket(workDir).catch((): null => null);
  const lastRunFingerprint = lastRun ? await lastRunPacketFingerprint(workDir).catch(() => "") : "";
  const lastRunFreshness = lastRun ? await lastRunPacketFreshness(workDir, lastRun, config) : null;
  const lastRunLogStatus = lastRun
    ? lastRun.decision?.safeSuggestedStatus ||
      lastRun.decision?.suggestedStatus ||
      (lastRun.decision?.allowedStatuses?.length === 1
        ? lastRun.decision.allowedStatuses[0]
        : "discard")
    : "";
  const replaceLastRunCommand = await replacementNextCommandForLastRun(
    workDir,
    lastRun,
    setup.defaultBenchmarkCommandReady,
  );
  const dashboardCommand = commandLine([
    "node",
    path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
    "serve",
    "--cwd",
    workDir,
  ]);
  const baselineCommand = setup.baselineCommand;
  const logCommand = lastRun
    ? commandLine([
        "node",
        path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
        "log",
        "--cwd",
        workDir,
        "--from-last",
        "--status",
        lastRunLogStatus,
        "--description",
        "Describe the last packet",
      ])
    : setup.guidedFlow.find((step: any) => step.step === "log")?.command;
  let stage = "ready";
  let nextAction = "Run the next measured packet.";
  if ((setup.missing.length || !state.config.name) && state.runs === 0) {
    stage = "needs-setup";
    nextAction = "Create or complete the session setup before running a baseline.";
  } else if (lastRun && lastRunFreshness?.fresh === false) {
    stage = "stale-last-run";
    nextAction = lastRunFreshness.reason;
  } else if (lastRun) {
    stage = "needs-log-decision";
    nextAction = "Log the last packet with an allowed status before starting another run.";
  } else if (state.runs === 0) {
    stage = "needs-baseline";
    nextAction = "Run and log a baseline before trying optimizations.";
  } else if (state.limit.limitReached) {
    stage = "limit-reached";
    nextAction = "Export the dashboard or extend the iteration limit.";
  } else if (!setup.defaultBenchmarkCommandReady) {
    stage = "needs-benchmark-command";
    nextAction =
      "Add autoresearch.ps1 or autoresearch.sh, or run setup with a benchmark command before using next.";
  }
  const commands = {
    setup: setup.nextCommand,
    benchmarkLint: setup.benchmarkLintCommand,
    doctor: setup.guidedFlow.find((step: any) => step.step === "doctor")?.command,
    checkpoint:
      setup.firstRunChecklist.find((step: any) => step.step === "checkpoint")?.command || "",
    baseline: baselineCommand,
    logLast: logCommand,
    replaceLast: replaceLastRunCommand,
    dashboard: dashboardCommand,
    newSegmentDryRun: commandLine([
      "node",
      path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
      "new-segment",
      "--cwd",
      workDir,
      "--dry-run",
    ]),
  };
  const canonicalGuideAction = canonicalActionForGuidedSetup({
    doctor,
    stage,
  });
  let nextStep = guidedNextStep({
    stage,
    nextAction,
    setup,
    commands,
    lastRunFreshness,
  });
  if (canonicalGuideAction) {
    stage = String(canonicalGuideAction.kind || stage);
    nextAction = actionMessage(canonicalGuideAction) || doctor.nextAction || nextAction;
    nextStep = canonicalGuidedNextStep({
      action: canonicalGuideAction,
      commands,
      fallbackReason: nextAction,
    });
  }
  return {
    ok: doctor.issues.length === 0,
    workDir,
    stage,
    missingEssentials: setup.missingEssentials || setup.missing || [],
    nextStep,
    setup,
    state,
    gateQuality: state.gateQuality || setup.gateQuality || doctor.gateQuality || null,
    preflight: state.preflight || setup.preflight || doctor.preflight || null,
    runtimeDriftSummary:
      state.runtimeDriftSummary || setup.runtimeDriftSummary || doctor.runtimeDriftSummary || null,
    scaffoldHealth: state.scaffoldHealth,
    researchIntegrity: state.researchIntegrity,
    doctor: {
      ok: doctor.ok,
      issues: doctor.issues,
      warnings: doctor.warnings,
      nextAction: doctor.nextAction,
      decisionPlanProjection:
        doctor.decisionPlan?.kind === "decision-plan"
          ? projectCompactDecisionPlan(doctor.decisionPlan as DecisionPlan)
          : null,
    },
    lastRun: lastRun
      ? {
          ok: lastRun.ok,
          allowedStatuses: lastRun.decision?.allowedStatuses || [],
          suggestedStatus: lastRun.decision?.suggestedStatus || "",
          rawSuggestedStatus: lastRun.decision?.rawSuggestedStatus || "",
          safeSuggestedStatus: lastRun.decision?.safeSuggestedStatus || lastRunLogStatus,
          statusGuidance: lastRun.decision?.statusGuidance || "",
          asiTemplate: lastRun.decision?.asiTemplate || {},
          diversityGuidance:
            lastRun.decision?.diversityGuidance || state.memory?.diversityGuidance || null,
          lanePortfolio: lastRun.decision?.lanePortfolio || state.memory?.lanePortfolio || [],
          metric: lastRun.decision?.metric ?? null,
          packetEvidence: lastRun.packetEvidence || null,
          path: lastRun.lastRunPath || "",
          fingerprint: lastRunFingerprint,
          freshness: lastRunFreshness,
        }
      : null,
    commands,
    firstRunChecklist: setup.firstRunChecklist,
    scopeWarnings: setup.scopeWarnings,
    settings: dashboardSettings(config),
    dashboard: {
      requested: boolOption(args.startDashboard ?? args.start_dashboard, false),
      started: false,
      url: "",
      healthUrl: "",
      verified: false,
      modeGuidance: null,
    },
    diversityGuidance: state.memory?.diversityGuidance || null,
    lanePortfolio: state.memory?.lanePortfolio || [],
    nextAction,
  };
}

async function compactGuidedSetup({ workDir, config, readCache }: LooseObject) {
  const state: LooseObject = await publicState({ cwd: workDir, compact: true, readCache });
  const compactPlan = compactRecord(state.decisionPlanProjection);
  const canonicalNextAction = compactRecord(compactPlan?.action);
  const shouldReadLastRun =
    state.requiresLogDecision === true ||
    ["log-decision", "stale-packet"].includes(String(canonicalNextAction?.kind || ""));
  const lastRun = shouldReadLastRun
    ? await readLastRunPacket(workDir).catch((): null => null)
    : null;
  const lastRunFingerprint = lastRun ? await lastRunPacketFingerprint(workDir).catch(() => "") : "";
  const lastRunFreshness = lastRun ? await lastRunPacketFreshness(workDir, lastRun, config) : null;
  const lastRunLogStatus = lastRun
    ? lastRun.decision?.safeSuggestedStatus ||
      lastRun.decision?.suggestedStatus ||
      (lastRun.decision?.allowedStatuses?.length === 1 ? lastRun.decision.allowedStatuses[0] : "")
    : "";
  const stage =
    compactGuidedStage(canonicalNextAction?.kind) ||
    (state.runs === 0 ? "needs-baseline" : state.limitReached ? "limit-reached" : "ready");
  const nextAction =
    canonicalNextAction?.reason || state.nextAction || "Continue from compact state.";
  return {
    ok: state.ok !== false,
    workDir,
    compact: true,
    stage,
    nextAction,
    nextStep: {
      stage,
      nextAction: {
        kind: canonicalNextAction?.kind || stage,
        title: actionTitleForKind(canonicalNextAction?.kind, "Next action"),
        command: canonicalNextAction?.command || state.commands?.state || "",
        safety: canonicalNextAction?.safety || "read_only",
      },
    },
    state,
    commands: {
      state: state.commands?.state || "",
      primary: canonicalNextAction?.command || state.commands?.state || "",
    },
    lastRun: lastRun
      ? {
          ok: lastRun.ok,
          allowedStatuses: lastRun.decision?.allowedStatuses || [],
          suggestedStatus: lastRun.decision?.suggestedStatus || "",
          rawSuggestedStatus: lastRun.decision?.rawSuggestedStatus || "",
          safeSuggestedStatus: lastRun.decision?.safeSuggestedStatus || lastRunLogStatus,
          statusGuidance: lastRun.decision?.statusGuidance || "",
          asiTemplate: lastRun.decision?.asiTemplate || {},
          metric: lastRun.decision?.metric ?? null,
          packetEvidence: lastRun.packetEvidence || null,
          path: lastRun.lastRunPath || "",
          fingerprint: lastRunFingerprint,
          freshness: lastRunFreshness,
        }
      : null,
    settings: dashboardSettings(config),
  };
}

function compactGuidedStage(kind: unknown): string {
  switch (String(kind || "")) {
    case "baseline":
      return "needs-baseline";
    case "benchmark-command":
      return "needs-benchmark-command";
    case "log-decision":
      return "needs-log-decision";
    case "setup":
      return "needs-setup";
    case "stale-packet":
      return "stale-last-run";
    case "segment-transition":
      return "limit-reached";
    default:
      return String(kind || "");
  }
}

async function onboardingPacket(args: LooseObject): Promise<LooseObject> {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const readCache = args.readCache;
  const [state, guide, doctor, next] = await Promise.all([
    publicState({ cwd: workDir, compact: true, readCache }),
    guidedSetup({ cwd: workDir, readCache }).catch((error: any) => ({
      ok: false,
      stage: "blocked",
      warnings: [error.message],
      nextAction: "Fix the guided setup error before running packets.",
    })),
    doctorSession({
      cwd: workDir,
      checkBenchmark: false,
      checkInstalled: true,
      explain: true,
      jsonFull: true,
    }).catch(
      (error: any): LooseObject => ({
        ok: false,
        issues: [error.message],
        warnings: [] as string[],
        drift: null as LooseObject | null,
        nextAction: "Fix doctor before running packets.",
      }),
    ),
    recommendNext({ cwd: workDir, compact: true, readCache }).catch(
      (error: any): LooseObject => ({
        ok: false,
        action: null as LooseObject | null,
        nextAction: error.message,
      }),
    ),
  ]);
  const commands = continuationCommands(workDir);
  const guidePacket = guide as LooseObject;
  const nextPacket = next as LooseObject;
  const resolvedDecision = nextPacket.resolvedDecision || state.resolvedDecision || null;
  const decisionPlanProjection =
    nextPacket.decisionPlanProjection || state.decisionPlanProjection || null;
  const stateStorage = await preflightAutoresearchPrivateState(workDir).catch((error: unknown) => ({
    storageMode: "unavailable",
    targets: [],
    warnings: [error instanceof Error ? error.message : String(error)],
  }));
  const operatorSnapshot = buildOperatorSnapshot({
    state: { ...state, stateStorage },
    recommendation: nextPacket,
    doctor,
  });
  const full = {
    ok: true,
    workDir,
    kind: "codex-autoresearch-onboarding-packet",
    generatedAt: new Date().toISOString(),
    protocol: [
      "Inspect state and doctor before editing.",
      "Before the first live packet, benchmark-lint or doctor --check-benchmark must prove the primary METRIC contract.",
      "Checkpoint generated session files before experiment-scoped keep commits.",
      "Run exactly one packet with next_experiment or next.",
      "Log the packet with keep, discard, measure, crash, or checks_failed plus ASI.",
      "Read continuation before deciding whether to continue or finalize.",
    ],
    readFirst: [
      path.relative(workDir, resolveSessionPaths({ workDir }).notesPath),
      "autoresearch.jsonl",
      path.relative(workDir, resolveSessionPaths({ workDir }).ideasPath),
      "autoresearch.last-run.json when present",
    ],
    state,
    sessionDecisionCapsule: state.sessionDecisionCapsule || null,
    decisionPlanProjection,
    resolvedDecision,
    guidedSetup: guidePacket,
    doctor: {
      ok: doctor.ok,
      issues: doctor.issues || [],
      warnings: doctor.warnings || [],
      drift: doctor.drift || null,
      nextAction: doctor.nextAction,
    },
    runtimeTruth: {
      checkedInstalledRuntime: true,
      drift: doctor.drift || null,
      warnings: doctor.drift?.warnings || [],
      nextAction:
        doctor.drift?.ok === false
          ? "Refresh or inspect the installed Codex plugin runtime before trusting source-only changes."
          : "Installed-runtime drift was checked during onboarding.",
    },
    nextAction:
      nextPacket.action ||
      nextPacket.nextBestAction ||
      nextPacket.nextAction ||
      guidePacket.nextAction,
    hazards: compactHazards({
      doctor,
      guide: guidePacket,
      state,
    }),
    missingEssentials: guidePacket.missingEssentials || guidePacket.setup?.missing || [],
    nextStep: guidePacket.nextStep || nextPacket.nextStep || null,
    commands: {
      ...commands,
      guide: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} guide --cwd ${shellQuote(workDir)}`,
      doctorExplain: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} doctor --cwd ${shellQuote(workDir)} --explain`,
      onboardingPacket: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} onboarding-packet --cwd ${shellQuote(workDir)} --compact`,
      newSegmentDryRun: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} new-segment --cwd ${shellQuote(workDir)} --dry-run`,
    },
    templates: agentReportTemplates(config),
  };
  if (boolOption(args.jsonFull ?? args.json_full, false)) return full;
  return {
    ok: true,
    workDir,
    kind: full.kind,
    generatedAt: full.generatedAt,
    operatorSnapshot,
    decisionPlanProjection,
    resolvedDecision,
    nextAction: operatorSnapshot.nextAction,
    nextStep: {
      stage: operatorSnapshot.stage,
      command: operatorSnapshot.primaryCommand,
      reason: operatorSnapshot.strongestBlocker || operatorSnapshot.nextAction,
    },
    hazards: full.hazards.slice(0, 5),
    missingEssentials: full.missingEssentials.slice(0, 10),
    templates: full.templates,
    diagnosticCommand: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} onboarding-packet --cwd ${shellQuote(workDir)} --json-full`,
  };
}

async function recommendNext(args: LooseObject): Promise<LooseObject> {
  const requestedCwd = String(args.working_dir || args.cwd || "");
  if (boolOption(args.compact, false) && !boolOption(args.full, false)) {
    const compact = await publicState({
      cwd: requestedCwd,
      compact: true,
      codexGoalObjective: args.codexGoalObjective || args.codex_goal_objective,
    });
    const workDir = String(compact.workDir || requestedCwd);
    const response = buildCompactRecommendNextResponse({
      workDir,
      compactState: compact,
    });
    if (boolOption(args.operatorChecklist ?? args.operator_checklist, false)) {
      const compactPlan = (compact.decisionPlanProjection || null) as LooseObject | null;
      const requiredEvidence = (compactPlan?.requiredEvidence || {}) as LooseObject;
      return {
        ...response,
        operatorChecklist: buildOperatorChecklist(compactPlan, {
          primaryCommand: (response.commands as LooseObject)?.primary,
          actionReason: response.nextAction,
          source:
            Array.isArray(requiredEvidence.diagnosticCodes) &&
            requiredEvidence.diagnosticCodes.length > 0
              ? requiredEvidence.diagnosticCodes.join(",")
              : "decision-plan",
        }),
      };
    }
    return response;
  }
  const state: LooseObject = await publicState({
    cwd: requestedCwd,
    jsonFull: true,
    codexGoalObjective: args.codexGoalObjective || args.codex_goal_objective,
  });
  const workDir = String(state.workDir || requestedCwd);
  const decisionPlan = state.decisionPlan as DecisionPlan | undefined;
  if (!decisionPlan || decisionPlan.kind !== "decision-plan") {
    throw new TypeError("full recommend-next requires a canonical decision plan.");
  }
  const resolvedProjection = projectResolvedDecision(decisionPlan);
  const action = resolvedProjection.canonicalNextAction as LooseObject;
  const loopContract = resolvedProjection.loopContract as LooseObject;
  const operatorChecklist = boolOption(args.operatorChecklist ?? args.operator_checklist, false)
    ? buildOperatorChecklist(decisionPlan as unknown as LooseObject, {
        actionReason: decisionPlan.action.reason,
        source: decisionPlan.requiredEvidence.diagnosticCodes.join(",") || "decision-plan",
      })
    : undefined;
  return buildRecommendNextResponse({
    ok: state.ok !== false,
    workDir,
    action,
    nextAction: decisionPlan.action.reason,
    whySafe: "Projected from the coherent session snapshot and canonical decision plan.",
    avoids: "Avoids reinterpreting dashboard, prose, or compatibility projections.",
    proof: `Decision ${decisionPlan.decisionId}.`,
    blockers: Array.isArray(loopContract?.blockers) ? loopContract.blockers : [],
    commands: {
      primary: action.command || "",
      ...state.commands,
    },
    nextStep: action.kind ? { stage: state.decisionPlan?.phase, action } : null,
    operatorChecklist,
    runtimeProvenance: state.runtimeProvenance,
    approvalLedger: state.approvalLedger,
    resourcePreflight: state.resourcePreflight,
    evidenceMaturity: state.evidenceMaturity,
    laneOrchestration: state.laneOrchestration,
    finalizationRunway: state.finalizationRunway,
    operatorReadout: state.operatorReadout,
    laneLifecycle: state.laneLifecycle,
    packetDiagnostics: state.packetDiagnostics,
    portfolioRecommendation: state.portfolioRecommendation,
    sessionDecisionCapsule: state.sessionDecisionCapsule || null,
    decisionPlan,
  });
}

function compactRecord(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

async function codexGoalBrief(args: LooseObject): Promise<LooseObject> {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = await publicState({ cwd: workDir, compact: false, readCache: args.readCache });
  const compact = compactPublicState(state);
  const commands = continuationCommands(workDir);
  const importedGoal = importedCodexGoal(args);
  const objectiveDraft = codexGoalObjectiveDraft(state, importedGoal);
  const completionClaimRequired =
    boolOption(args.completionConfirmed ?? args.completion_confirmed, false) &&
    Boolean(String(args.completionEvidence || args.completion_evidence || "").trim());
  const canonicalDecision = await loadCanonicalSessionDecision({
    requestedCwd: workDir,
    facts: {
      finalization: (state.finalizationPressure || null) as LooseObject | null,
      finalizationClaimRequired: completionClaimRequired,
    },
  });
  if (!canonicalDecision.ok) {
    throw new Error(canonicalDecision.diagnostic.message);
  }
  const completionAudit = codexGoalCompletionAudit({
    args,
    compact,
    importedGoal,
    state,
    decisionPlan: canonicalDecision.plan,
  });
  const completionBlocker = completionAudit.canMarkCodexGoalComplete
    ? null
    : completionAudit.localEvidence?.blockers?.[0] ||
      completionAudit.recommendedCodexAction ||
      "Autoresearch completion evidence is not sufficient.";
  const result = {
    ok: true,
    kind: "codex-autoresearch-goal-bridge",
    workDir,
    canMarkCodexGoalComplete: completionAudit.canMarkCodexGoalComplete === true,
    completionBlocker,
    boundary: {
      codexOwns:
        "Thread-level Goal lifecycle, pause/resume/clear controls, token accounting, and update_goal completion.",
      autoresearchOwns:
        "Benchmark contract, packet ledger, ASI, dashboard/readout truth, Git safety, and evidence-based completion audit.",
      unsupported:
        "This command does not read or mutate Codex private state. Pass get_goal output in explicitly when available.",
    },
    importedCodexGoal: importedGoal,
    objectiveDraft,
    objectiveLength: objectiveDraft.length,
    completionAudit,
    decisionPlanProjection: projectCompactDecisionPlan(canonicalDecision.plan),
    commands: {
      codexSlashGoal: `/goal ${objectiveDraft}`,
      explicitGoalToolPrompt: [
        "Create a goal for this thread using the goal tool, not as prose.",
        "",
        "Objective:",
        objectiveDraft,
        "",
        "After creating it, call get_goal. If no active goal exists, stop and report GOAL_NOT_CREATED.",
      ].join("\n"),
      autoresearchState: commands.state,
      autoresearchRecommendNext: commands.recommendNext,
      autoresearchNext: commands.next,
    },
    session: {
      name: state.config?.name || "Autoresearch",
      metric: state.config?.metricName || "metric",
      direction: state.config?.bestDirection || "lower",
      runs: state.runs,
      best: state.best,
      limit: state.limit,
      nextAction: compact.nextAction,
      resolvedDecision: state.resolvedDecision || null,
    },
    settings: {
      autonomyMode: config.autonomyMode || "guarded",
      maxIterations: state.limit?.maxIterations ?? null,
    },
  };
  if (
    boolOption(args.enforceCompletion ?? args.enforce_completion, false) &&
    result.canMarkCodexGoalComplete !== true
  ) {
    const error = new Error(`Codex Goal completion is blocked: ${completionBlocker}`) as Error & {
      code?: string;
    };
    error.code = "codex_goal_completion_blocked";
    throw error;
  }
  return result;
}

function importedCodexGoal(args: LooseObject): LooseObject | null {
  const objective = args.codexGoalObjective || args.codex_goal_objective;
  const status = args.codexGoalStatus || args.codex_goal_status;
  const hasGoal =
    objective != null ||
    status != null ||
    args.codexGoalTokenBudget != null ||
    args.codex_goal_token_budget != null ||
    args.codexGoalTokensUsed != null ||
    args.codex_goal_tokens_used != null ||
    args.codexGoalTimeUsedSeconds != null ||
    args.codex_goal_time_used_seconds != null;
  if (!hasGoal) return null;
  const normalizedStatus = normalizeCodexGoalStatus(status);
  return {
    objective: objective == null ? "" : String(objective),
    status: normalizedStatus,
    tokenBudget: nonNegativeIntegerOption(
      args.codexGoalTokenBudget ?? args.codex_goal_token_budget,
      null,
      "codex_goal_token_budget",
    ),
    tokensUsed: nonNegativeIntegerOption(
      args.codexGoalTokensUsed ?? args.codex_goal_tokens_used,
      null,
      "codex_goal_tokens_used",
    ),
    timeUsedSeconds: nonNegativeIntegerOption(
      args.codexGoalTimeUsedSeconds ?? args.codex_goal_time_used_seconds,
      null,
      "codex_goal_time_used_seconds",
    ),
  };
}

function normalizeCodexGoalStatus(value: unknown): string {
  if (value == null || value === "") return "unknown";
  const normalized = String(value).toLowerCase();
  if (!["active", "paused", "budget_limited", "complete", "unknown"].includes(normalized)) {
    throw new Error(
      `codex_goal_status must be one of active, paused, budget_limited, complete. Got ${value}`,
    );
  }
  return normalized;
}

function codexGoalObjectiveDraft(state: LooseObject, importedGoal: LooseObject | null): string {
  const config = state.config || {};
  const metric = config.metricName || "metric";
  const direction = config.bestDirection === "higher" ? "higher" : "lower";
  const durableGoal = String(config.goal || "").trim();
  const sessionName = config.name || "Autoresearch";
  const sessionObjective = durableGoal || sessionName;
  const sessionNameContext = durableGoal && config.name ? ` Session name: ${config.name}.` : "";
  const existingObjective = importedGoal?.objective
    ? `Existing Codex Goal: ${importedGoal.objective}. `
    : "";
  const text = [
    existingObjective,
    `Use Codex Autoresearch for ${sessionObjective}.${sessionNameContext}`,
    `Improve or complete the loop using the durable benchmark contract: every trusted packet must emit METRIC ${metric}=value, and ${direction} is better.`,
    "Keep the Autoresearch ledger authoritative: run bounded packets, log each decision with ASI, preserve scoped Git safety, and use the dashboard/state decision envelope for the next action.",
    "Do not mark the Codex Goal complete because a packet limit or token budget was reached; complete it only after an evidence audit shows the requested outcome, checks, and unresolved-risk review are satisfied.",
  ].join(" ");
  return truncateGoalObjective(text);
}

function truncateGoalObjective(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 4000) return normalized;
  return `${normalized.slice(0, 3960).replace(/\s+\S*$/, "")} ... See autoresearch.md and state --compact for details.`;
}

function codexGoalCompletionAudit({
  args,
  compact,
  decisionPlan,
  importedGoal,
  state,
}: LooseObject): LooseObject {
  const plan = decisionPlan as DecisionPlan;
  const completionEvidence = String(
    args.completionEvidence || args.completion_evidence || "",
  ).trim();
  const completionConfirmed = boolOption(
    args.completionConfirmed ?? args.completion_confirmed,
    false,
  );
  const limitReached = compact.limitReached === true;
  const finalizationReady =
    plan.capabilities.finalize === "allowed" && plan.action.kind === "finalize";
  const qualityRound = state.qualityRound || {};
  const completionRequested = completionConfirmed && Boolean(completionEvidence);
  const blockers = plan.requiredEvidence.diagnosticCodes;
  const importedGoalCompletable = importedGoal?.status === "active";
  const hasMeasuredEvidence =
    Number(state.runs) > 0 &&
    (state.best != null || state.development?.best != null || state.promotion?.best != null);
  const hasLocalCompletionEvidence =
    hasMeasuredEvidence || finalizationReady || (qualityRound.active && qualityRound.done === true);
  let status = "active";
  if (importedGoal?.status === "budget_limited" || limitReached) {
    status = "budget_limited";
  } else if (compact.requiresLogDecision) {
    status = "pending_log_decision";
  } else if (completionRequested && !importedGoal) {
    status = "no_codex_goal_imported";
  } else if (completionRequested && !importedGoalCompletable) {
    status = "codex_goal_not_active";
  } else if (completionRequested && plan.parentDisposition.mayClaimCompletion !== true) {
    status = "blocked";
  } else if (
    completionRequested &&
    hasLocalCompletionEvidence &&
    plan.parentDisposition.mayClaimCompletion === true
  ) {
    status = "complete";
  } else if (plan.parentDisposition.mayAnswer !== true) {
    status = "blocked";
  } else if (completionRequested) {
    status = "completion_evidence_insufficient";
  } else if (!state.runs) {
    status = "not_started";
  } else if (qualityRound.active && qualityRound.done === true) {
    status = "quality_round_closed";
  } else if (finalizationReady) {
    status = "ready_for_review";
  }
  return {
    status,
    canMarkCodexGoalComplete: status === "complete" && importedGoalCompletable,
    completionEvidence: completionEvidence || null,
    evidenceRequired:
      "Before calling update_goal(status=complete), cite the benchmark result, checks, artifacts or docs changed, unresolved risks, and why the original objective is satisfied.",
    budgetPolicy:
      "Budget or iteration exhaustion is a stop signal, not success. Extend, start a new segment, or report the blocker instead of marking complete.",
    importedCodexStatus: importedGoal?.status || "none",
    localEvidence: {
      runs: state.runs,
      best: state.best,
      developmentBest: state.development?.best ?? null,
      promotionBest: state.promotion?.best ?? null,
      metric: state.config?.metricName || "metric",
      direction: state.config?.bestDirection || "lower",
      finalizationReady,
      qualityRound,
      limitReached,
      hasLocalCompletionEvidence,
      blockers,
      nextAction: compact.nextAction,
    },
    recommendedCodexAction: recommendedCodexGoalAction(status, importedGoal),
  };
}

function recommendedCodexGoalAction(status: string, importedGoal: LooseObject | null): string {
  if (status === "complete") {
    return "If a Codex Goal is active, call update_goal with status=complete and report the completion evidence.";
  }
  if (!importedGoal) {
    return "Create a Codex Goal only when the operator explicitly asks for Goal mode; otherwise continue with Autoresearch state alone.";
  }
  if (status === "codex_goal_not_active") {
    return importedGoal.status === "complete"
      ? "The imported Codex Goal is already complete; do not call update_goal again from this audit."
      : "Do not mark complete. Resume or verify an active Codex Goal before using this audit for update_goal.";
  }
  if (importedGoal.status === "paused") {
    return "Resume or edit the Codex Goal in the Codex surface, then continue from Autoresearch recommend-next.";
  }
  if (status === "budget_limited") {
    return "Do not mark complete. Report budget or iteration exhaustion and ask whether to extend, start a new segment, or stop.";
  }
  if (status === "pending_log_decision") {
    return "Log the pending Autoresearch packet before continuing the Codex Goal.";
  }
  if (status === "blocked") {
    return "Resolve the listed blocker before treating the Codex Goal as progressing or complete; continue experiments only from Autoresearch recommend-next evidence.";
  }
  if (status === "completion_evidence_insufficient") {
    return "Do not mark complete. Add local Autoresearch evidence such as a promotion-grade logged metric, ready finalization preview, or explicitly reviewed closed quality round before completion.";
  }
  return "Continue toward the active Codex Goal using Autoresearch next-action evidence.";
}

function compactHazards({ doctor, guide, state }: LooseObject) {
  return [
    ...(Array.isArray(doctor?.issues) ? doctor.issues : []),
    ...(Array.isArray(doctor?.warnings) ? doctor.warnings : []),
    ...(Array.isArray(guide?.warnings) ? guide.warnings : []),
    ...(Array.isArray(state?.blockers) ? state.blockers : []),
  ]
    .map((item: any) => (typeof item === "object" ? item.message || item.code : item))
    .filter(Boolean)
    .slice(0, 8);
}

function agentReportTemplates(config: LooseObject = {}) {
  const metric = config.metricName || "metric";
  return {
    firstResponse:
      "I found the Autoresearch session, checked state/doctor, and the next safe action is: <action>. Dashboard: <verified URL only when requested/useful, otherwise optional>.",
    progress: `Tried: <plain-English hypothesis>. Result: ${metric}=<value>, status=<pending|keep|discard|measure|crash|checks_failed>. Meaning: <what changed versus baseline/incumbent>. Decision: <log/keep/discard/measure>. Next: <ASI next_action_hint or continuation>.`,
    final:
      "Changed: <files/behavior>. Verified: <commands>. Autoresearch: <runs/kept/best/next>. Risks: <remaining blockers>.",
    blocked:
      "Blocked by <specific layer>. Evidence: <command/output>. Dashboard: <verified replacement URL or unavailable reason>. Safe next action: <fix or command>.",
  };
}

function replaySafeCommand(value: unknown, context: LooseObject): string {
  const portable = portableNodeCommand(String(value || "").trim());
  if (!portable) return "";
  return redactCommandDisplay(portable, context) === portable ? portable : "";
}

function portableNodeCommand(command: string): string {
  const executable = process.execPath;
  const candidates = [
    executable,
    executable.replace(/\\/g, "/"),
    executable.replace(/\\/g, "\\\\"),
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    for (const quote of ['"', "'"]) {
      const prefix = `${quote}${candidate}${quote}`;
      if (command === prefix) return "node";
      if (command.startsWith(`${prefix} `)) return `node${command.slice(prefix.length)}`;
    }
    if (command === candidate) return "node";
    if (command.startsWith(`${candidate} `)) return `node${command.slice(candidate.length)}`;
  }
  return command;
}

async function recipeCommand(subcommand: string, args: any) {
  const catalogOptions = { catalogBaseDir: recipeCatalogBaseDir(args) };
  if (!subcommand || subcommand === "list") {
    const catalogRecipes = args.catalog
      ? await loadRecipeCatalog(args.catalog, catalogOptions)
      : [];
    return { ok: true, recipes: [...listBuiltInRecipes(), ...catalogRecipes] };
  }
  if (subcommand === "recommend") {
    const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
    const recipe = await recommendRecipe(workDir);
    const setup = await setupPlan({
      cwd: workDir,
      recipe: args.recipe || recipe?.id,
      catalog: args.catalog,
    });
    return {
      ok: true,
      workDir,
      recommendedRecipe: recipe,
      reason: recipe
        ? `Detected project shape matches ${recipe.title}.`
        : "No built-in recipe matched strongly; use custom setup.",
      nextCommand: setup.nextCommand,
      doctorCommand: setup.guidedFlow.find((step: any) => step.step === "doctor")?.command || "",
    };
  }
  if (subcommand === "show") {
    const id = args._[2] || args.id || args.recipe || args.recipeId;
    if (!id) throw new Error("recipes show requires a recipe id");
    const catalogRecipes = args.catalog
      ? await loadRecipeCatalog(args.catalog, catalogOptions)
      : [];
    const recipe = [...listBuiltInRecipes(), ...catalogRecipes].find((item: any) => item.id === id);
    if (!recipe) throw new Error(`Unknown recipe: ${id}`);
    return { ok: true, recipe };
  }
  throw new Error(`Unknown recipes subcommand: ${subcommand}`);
}

async function interactiveSetup(args: any) {
  const plan = await setupPlan(args);
  const recipe = plan.recommendedRecipe || getBuiltInRecipe("custom");
  const catalogOptions = { catalogBaseDir: recipeCatalogBaseDir(args) };
  const rl = createInterface({ input, output });
  try {
    const ask = async (prompt: any, fallback: any) => {
      const answer = await rl.question(`${prompt}${fallback ? ` (${fallback})` : ""}: `);
      return answer.trim() || fallback;
    };
    const selectedRecipeId = await ask("Recipe id", recipe?.id || "custom");
    const selectedRecipe = await findRecipe(selectedRecipeId, args.catalog, catalogOptions);
    if (!selectedRecipe) throw new Error(`Unknown recipe: ${selectedRecipeId}`);
    const nextArgs = await withRecipeDefaults({
      ...args,
      recipe: selectedRecipeId,
      name: await ask("Session name", args.name || selectedRecipe.title || "Autoresearch session"),
      goal: await ask("Goal", args.goal || "Improve the measured target"),
      metricName: await ask(
        "Primary metric",
        args.metricName || args.metric_name || selectedRecipe.metricName || "seconds",
      ),
      metricUnit: await ask(
        "Metric unit",
        args.metricUnit || args.metric_unit || selectedRecipe.metricUnit || "",
      ),
      direction: await ask(
        "Direction lower/higher",
        args.direction || selectedRecipe.direction || "lower",
      ),
      filesInScope: await ask(
        "Files in scope (comma separated)",
        args.filesInScope || args.files_in_scope || (selectedRecipe.scope || []).join(","),
      ),
      checksCommand: await ask(
        "Checks command",
        args.checksCommand || args.checks_command || selectedRecipe.checksCommand || "",
      ),
      commitPaths: await ask(
        "Commit paths (comma separated)",
        args.commitPaths || args.commit_paths || "",
      ),
      maxIterations: await ask("Max iterations", args.maxIterations || args.max_iterations || "50"),
    });
    const setup = await setupSession(nextArgs);
    const doctor = await doctorSession({ cwd: setup.workDir, checkBenchmark: false });
    return {
      ok: true,
      setup,
      doctor,
      baselineCommand: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(setup.workDir)}`,
    };
  } finally {
    rl.close();
  }
}

function markdownList(items: any[], emptyText: string) {
  if (!items.length) return `- ${emptyText}`;
  return items.map((item: any) => `- ${item}`).join("\n");
}

function renderSessionDocument(args: any) {
  const explicitScope = listOption(args.files_in_scope ?? args.filesInScope ?? args.scope);
  const commitScope = normalizeRelativePaths(
    args.commit_paths ?? args.commitPaths,
    "commitPaths",
  ).map((item: any) => `\`${item}\`: in configured commit scope`);
  const scope = explicitScope.length ? explicitScope : commitScope;
  const offLimits = listOption(args.off_limits ?? args.offLimits);
  const constraints = listOption(args.constraints);
  const constraintsPlaceholder =
    "- <Correctness, compatibility, dependency," + " or budget constraints>";
  const secondary = listOption(args.secondary_metrics ?? args.secondaryMetrics);
  const benchmarkCommand = args.benchmark_command || args.benchmarkCommand || "./autoresearch.sh";
  const metricUnit = args.metric_unit ?? args.metricUnit ?? "";
  const direction = args.direction === "higher" ? "higher" : "lower";
  const primaryMetric = validateMetricName(args.metric_name || args.metricName);
  const metricContractNote = metricLooksHigherIsBetter(primaryMetric)
    ? `- Decision contract: ${primaryMetric} is treated as a quality-bearing score; faster runs should not be promoted when component evidence shows quality or correctness erosion.`
    : `- Decision contract: ${primaryMetric} is the primary metric; secondary evidence explains tradeoffs but should not silently override it.`;
  return replaceAllText(readAssetTemplate("autoresearch.md.template"), {
    "<goal>": args.name,
    "<Specific description of what is being optimized and the workload.>": args.goal || args.name,
    "- Primary: <name> (<unit>, lower/higher is better)": `- Primary: ${primaryMetric} (${metricUnit || "unitless"}, ${direction} is better)`,
    "- Secondary: <name>, <name>": secondary.length
      ? `- Secondary: ${secondary.join(", ")}`
      : "- Secondary: none yet",
    "`<benchmark command>` prints `METRIC name=value` lines.": `\`${benchmarkCommand}\` prints \`METRIC name=value\` lines.`,
    "- `<path>`: <why it matters>": markdownList(scope, "TBD: add files after initial inspection"),
    "- `<path or behavior>`: <reason>": markdownList(
      offLimits,
      "TBD: add off-limits files or behaviors if needed",
    ),
    [constraintsPlaceholder]: markdownList(
      uniqueStrings([metricContractNote, ...constraints]),
      "TBD: add correctness and compatibility constraints",
    ),
    "- Baseline: <initial metric and notes>": "- Baseline: pending",
  });
}

function renderIdeasDocument(args: any) {
  const title = args.name || "Autoresearch";
  const goal = String(args.goal || args.name || "").trim();
  const constraints = listOption(args.constraints);
  const secondary = listOption(args.secondary_metrics ?? args.secondaryMetrics);
  const ideas = uniqueStrings([
    ...(goal ? [`Baseline the current behavior for: ${goal}`] : []),
    ...(secondary.length ? [`Track secondary metrics explicitly: ${secondary.join(", ")}.`] : []),
    ...constraints
      .filter((constraint: any) => !/^Decision contract:/i.test(constraint))
      .slice(0, 3)
      .map((constraint: any) => `Validate constraint before promotion: ${constraint}`),
    "Try one focused change at a time; repeat unchanged candidates when the accepted noise model requires it.",
  ]);
  return [`# Autoresearch Ideas: ${title}`, "", ...ideas.map((idea: any) => `- ${idea}`), ""].join(
    "\n",
  );
}

function renderResumeBlock(workDir: string) {
  const cwd = shellQuote(workDir);
  const script = shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"));
  return [
    "## Resume This Session",
    "",
    "Read the current decision before resuming:",
    "",
    "```bash",
    `node ${script} state --cwd ${cwd} --report`,
    "```",
    "",
    "Follow its next action. A measurement is a keep only after the accepted checks and repeat requirements pass.",
    "",
  ].join("\n");
}

function renderBenchmarkScript(args: any, shellKind: string) {
  const command = args.benchmark_command || args.benchmarkCommand;
  if (!command) {
    return renderMissingCommandScript(shellKind, "benchmark", "--benchmark-command");
  }
  const metricName = validateMetricName(args.metric_name || args.metricName || "elapsed_seconds");
  const hasExplicitBenchmarkCommand = Boolean(args.benchmark_command || args.benchmarkCommand);
  if (
    boolOption(
      args.benchmark_prints_metric ?? args.benchmarkPrintsMetric,
      hasExplicitBenchmarkCommand,
    )
  ) {
    if (shellKind === "bash") {
      return [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        "# This recipe command is responsible for printing METRIC lines.",
        command,
        "",
      ].join("\n");
    }
    return [
      '$ErrorActionPreference = "Stop"',
      "",
      "# This recipe command is responsible for printing METRIC lines.",
      "$global:LASTEXITCODE = 0",
      command,
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      "",
    ].join("\n");
  }
  const templateName =
    shellKind === "bash" ? "autoresearch.sh.template" : "autoresearch.ps1.template";
  return replaceAllText(readAssetTemplate(templateName), {
    "<benchmark command>": command,
    "<metric name>": metricName,
  });
}

function renderChecksScript(args: any, shellKind: string) {
  const command = args.checks_command || args.checksCommand;
  if (!command) {
    return renderMissingCommandScript(shellKind, "checks", "--checks-command");
  }
  const templateName =
    shellKind === "bash" ? "autoresearch.checks.sh.template" : "autoresearch.checks.ps1.template";
  return replaceAllText(readAssetTemplate(templateName), {
    "<check command>": command,
  });
}

function renderMissingCommandScript(shellKind: string, kind: string, optionName: string) {
  const message = `Autoresearch ${kind} command is not configured. Re-run setup with ${optionName}.`;
  if (shellKind === "bash") {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      `printf '%s\\n' ${shellQuote(message, "bash")} >&2`,
      "exit 2",
      "",
    ].join("\n");
  }
  return [
    '$ErrorActionPreference = "Stop"',
    "",
    `Write-Error ${shellQuote(message, "powershell")}`,
    "exit 2",
    "",
  ].join("\n");
}

function researchSlugFromArgs(args: any) {
  return safeSlug(args.research_slug ?? args.researchSlug ?? args.slug ?? args.name ?? "research");
}

function researchRelativeDir(slug: string) {
  return `${RESEARCH_DIR}/${slug}`;
}

function researchDirPath(workDir: string, slug: string) {
  return researchDirPathForSession(workDir, slug);
}

function renderResearchBenchmarkScript(slug: string, shellKind: string) {
  const script = path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs");
  if (shellKind === "bash") {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      `${shellQuote(process.execPath, "bash")} ${shellQuote(script, "bash")} quality-gap --cwd . --research-slug ${shellQuote(slug, "bash")}`,
      "",
    ].join("\n");
  }
  return [
    '$ErrorActionPreference = "Stop"',
    "",
    `& ${shellQuote(process.execPath, "powershell")} ${shellQuote(script, "powershell")} quality-gap --cwd . --research-slug ${shellQuote(slug, "powershell")}`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "",
  ].join("\n");
}

function researchTitle(value: any) {
  return String(value).replace(/\s+/g, " ").trim();
}

const RESEARCH_FILE_TEMPLATES: Record<string, (input: LooseObject) => string> = {
  "brief.md": ({ title, goal, args }: LooseObject) => `# Research Brief: ${title}

## Request
${goal}

## Decision To Support
- Identify source-backed changes worth testing through an autoresearch loop.

## Success Criteria
- The project essence is accurate.
- Sources and direct evidence are logged.
- High-impact findings are converted into quality gaps.
- Each implemented or rejected gap has evidence.

## Constraints
${markdownList(listOption(args.constraints), "TBD: add constraints as they are discovered")}

## Known Unknowns
- TBD: add unresolved questions before delegating or implementing.
`,
  "plan.md": ({ title }: LooseObject) => `# Research Plan: ${title}

## Workstreams
- Project essence and audience
- Current implementation and architecture evidence
- High-impact improvement candidates
- Risks, constraints, and validation strategy

## Sequencing
- Gather evidence first.
- Synthesize findings into \`synthesis.md\`.
- Convert actionable findings into \`quality-gaps.md\`.
- Iterate with the Codex Autoresearch skill until \`quality_gap=0\`.
`,
  "tasks.md": ({ title }: LooseObject) => `# Research Tasks: ${title}

## queued
- Capture project essence from repo evidence.
- Log primary sources and direct measurements.
- Convert recommendations into quality gaps.

## in_progress
- None.

## done
- Scratchpad initialized.

## blockers
- None.
`,
  "sources.md": ({ title }: LooseObject) => `# Research Sources: ${title}

| Source | Date Checked | Claim Supported | Confidence |
| --- | --- | --- | --- |
| TBD | TBD | TBD | TBD |
`,
  "synthesis.md": ({ title }: LooseObject) => `# Research Synthesis: ${title}

## Project Essence
- TBD: summarize what the project is trying to become.

## High-Impact Findings
- TBD: list source-backed findings and why they matter.

## Quality-Gap Translation
- Keep \`quality-gaps.md\` aligned with the current synthesis.

## Confidence And Gaps
- TBD: record confidence, contradictions, and unresolved questions.
`,
  "quality-gaps.md": ({ title }: LooseObject) => `# Quality Gaps: ${title}

- [ ] Project essence is accurate and source-backed.
- [ ] Sources are logged with dates, claims, and confidence.
- [ ] Synthesis separates high-impact changes from small QoL fixes.
- [ ] Each high-impact recommendation is implemented or rejected with evidence.
- [ ] Correctness checks pass after kept changes.
- [ ] Final handoff includes dashboard or state evidence.
`,
};

function renderResearchFile(fileName: string, args: any, slug: string) {
  const goal = args.goal || args.name || slug;
  const renderer = RESEARCH_FILE_TEMPLATES[fileName];
  if (renderer) return renderer({ title: researchTitle(goal), goal, args });
  throw new Error(`Unknown research file template: ${fileName}`);
}

async function writeSessionFile(filePath: string, content: any, options: LooseObject = {}) {
  const exists = await pathExists(filePath);
  if (exists && !options.overwrite) return { path: filePath, action: "kept" };
  await checkedAtomicWriteFile(
    options.root || path.dirname(filePath),
    filePath,
    content.endsWith("\n") ? content : `${content}\n`,
    { mode: options.executable ? 0o755 : 0o600 },
  );
  if (options.executable) {
    await fsp.chmod(filePath, 0o755).catch(() => {});
  }
  return { path: filePath, action: exists ? "overwritten" : "created" };
}

function mergeRuntimeConfig(sessionCwd: any, updates: any) {
  const configPath = runtimeConfigPath(sessionCwd);
  const existing = readConfig(sessionCwd);
  const nextConfig = { ...existing, ...updates };
  return {
    configPath,
    nextConfig,
    content: JSON.stringify(nextConfig, null, 2),
  };
}

async function appendRuntimeConfigFile(files: any[], sessionCwd: any, updates: any) {
  if (Object.keys(updates).length === 0) return;
  const { configPath, content } = mergeRuntimeConfig(sessionCwd, updates);
  files.push(await writeSessionFile(configPath, content, { overwrite: true, root: sessionCwd }));
}

async function appendRuntimeConfigUpdates(files: any[], sessionCwd: any, updates: LooseObject) {
  if (Object.keys(updates).length > 0) {
    await appendRuntimeConfigFile(files, sessionCwd, updates);
  }
}

async function appendSetupRuntimeConfig(
  files: any[],
  sessionCwd: any,
  args: LooseObject,
  options: {
    includeRecipe?: boolean;
    includeRecipeCatalogProvenance?: boolean;
    grouped?: boolean;
  } = {},
) {
  const maxIterations = positiveIntegerOption(
    args.max_iterations ?? args.maxIterations,
    null,
    "maxIterations",
  );
  const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
  const runtimeUpdates = runtimeConfigUpdatesFromArgs(args);

  if (options.grouped) {
    const nextConfig: LooseObject = { ...runtimeUpdates };
    if (maxIterations != null) nextConfig.maxIterations = maxIterations;
    if (commitPaths.length > 0) nextConfig.commitPaths = commitPaths;
    await appendRuntimeConfigUpdates(files, sessionCwd, nextConfig);
    return;
  }

  const setupConfig: LooseObject = {};
  if (maxIterations != null) setupConfig.maxIterations = maxIterations;
  if (options.includeRecipe && (args.recipe_id || args.recipeId || args.recipe)) {
    setupConfig.recipeId = args.recipe_id || args.recipeId || args.recipe;
  }
  await appendRuntimeConfigUpdates(files, sessionCwd, setupConfig);
  if (options.includeRecipeCatalogProvenance && args.recipeCatalogProvenance) {
    await appendRuntimeConfigUpdates(files, sessionCwd, {
      recipeCatalogProvenance: args.recipeCatalogProvenance,
    });
  }
  if (commitPaths.length > 0) {
    await appendRuntimeConfigUpdates(files, sessionCwd, { commitPaths });
  }
  await appendRuntimeConfigUpdates(files, sessionCwd, runtimeUpdates);
}

function setupCheckpointGuidance(workDir: string, files: any[], name: string) {
  const paths = [
    ...new Set(
      files
        .map((file: any) => path.relative(workDir, file.path).replace(/\\/g, "/"))
        .filter(
          (filePath: string) =>
            filePath && !filePath.startsWith("..") && !path.isAbsolute(filePath),
        ),
    ),
  ];
  return {
    paths,
    commands: paths.length
      ? [
          `git add -- ${paths.map((item) => shellQuote(item)).join(" ")}`,
          `git commit -m ${shellQuote(`Start autoresearch session: ${name}`)}`,
        ]
      : [],
    note: "Checkpoint these generated session files before the first experiment commit if this project is in Git.",
  };
}

async function setupCommandResponseFields({
  args,
  benchmarkMode,
  checkpoint,
  metricName,
  sessionCwd,
  shellKind,
  workDir,
}: LooseObject) {
  const benchmarkCommand =
    shellKind === "bash"
      ? "bash ./autoresearch.sh"
      : "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
  const benchmarkLintCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} benchmark-lint --cwd ${shellQuote(workDir)} --metric-name ${shellQuote(metricName)} --command ${shellQuote(benchmarkCommand)}`;
  const doctorCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} doctor --cwd ${shellQuote(workDir)} --check-benchmark`;
  const baselineCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)}`;
  const logCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} log --cwd ${shellQuote(workDir)} --from-last --status measure --description ${shellQuote("Baseline measurement")}`;
  const config = readConfig(sessionCwd);
  const scaffoldHealth = await buildScaffoldHealth({ workDir, config });
  const checksCommand =
    args.checks_command || args.checksCommand || (await defaultChecksCommand(workDir)) || "";
  const guidance = await decisionGuidance({
    workDir,
    config,
    state: currentState(workDir),
    scaffoldHealth,
    benchmarkCommand,
    checksCommand,
  });
  return {
    scaffoldHealth,
    benchmarkMode,
    benchmarkLintCommand,
    gateQuality: guidance.gateQuality,
    preflight: guidance.preflight,
    runtimeDriftSummary: guidance.runtimeDriftSummary,
    scopeWarnings: scopeWarningsFromArgs(args),
    firstRunChecklist: firstRunChecklist({
      setupCommand: "already completed",
      benchmarkLintCommand,
      doctorCommand,
      checkpoint,
      baselineCommand,
      logCommand,
    }),
  };
}

async function writeRuntimeConfig(sessionCwd: any, updates: any) {
  if (Object.keys(updates).length === 0) return readConfig(sessionCwd);
  const { configPath, nextConfig, content } = mergeRuntimeConfig(sessionCwd, updates);
  await checkedAtomicWriteFile(sessionCwd, configPath, `${content}\n`, { mode: 0o600 });
  return nextConfig;
}

function runtimeConfigUpdatesFromArgs(args: LooseObject) {
  const updates: LooseObject = {};
  const hasPacketBudget = hasAnyArg(args, "packet_budget", "packetBudget");
  const clearPacketBudget = boolOption(args.clear_packet_budget ?? args.clearPacketBudget, false);
  const hasWallClockBudgetSeconds = hasAnyArg(
    args,
    "wall_clock_budget_seconds",
    "wallClockBudgetSeconds",
  );
  const clearWallClockBudget = boolOption(
    args.clear_wall_clock_budget ?? args.clearWallClockBudget,
    false,
  );
  const hasBudgetNote = hasAnyArg(args, "budget_note", "budgetNote");
  const hasProtectedBenchmarkPaths = hasAnyArg(
    args,
    "protected_benchmark_paths",
    "protectedBenchmarkPaths",
  );
  const hasSecondaryMetricConstraints = hasAnyArg(
    args,
    "secondary_metric_constraints",
    "secondaryMetricConstraints",
  );
  const autonomyMode = enumOption(
    args.autonomy_mode ?? args.autonomyMode,
    AUTONOMY_MODES,
    null,
    "autonomyMode",
  );
  const checksPolicy = enumOption(
    args.checks_policy ?? args.checksPolicy,
    CHECKS_POLICIES,
    null,
    "checksPolicy",
  );
  const keepPolicy = enumOption(
    args.keep_policy ?? args.keepPolicy,
    KEEP_POLICIES,
    null,
    "keepPolicy",
  );
  const dashboardRefreshSeconds = numberOption(
    args.dashboard_refresh_seconds ?? args.dashboardRefreshSeconds,
    null,
  );
  const packetBudget = positiveIntegerOption(
    args.packet_budget ?? args.packetBudget,
    null,
    "packetBudget",
  );
  const wallClockBudgetSeconds = positiveIntegerOption(
    args.wall_clock_budget_seconds ?? args.wallClockBudgetSeconds,
    null,
    "wallClockBudgetSeconds",
  );
  const budgetNote = String(args.budget_note ?? args.budgetNote ?? "").trim();
  const protectedBenchmarkPaths = normalizeProtectedBenchmarkPaths(
    args.protected_benchmark_paths ?? args.protectedBenchmarkPaths,
  );
  const secondaryMetricConstraintMode = enumOption(
    args.secondary_metric_constraint_mode ?? args.secondaryMetricConstraintMode,
    SECONDARY_METRIC_CONSTRAINT_MODES as Set<"advisory" | "blocking">,
    null,
    "secondaryMetricConstraintMode",
  );
  const rawSecondaryMetricConstraints =
    args.secondary_metric_constraints ?? args.secondaryMetricConstraints;
  const secondaryMetricConstraints = normalizeSecondaryMetricConstraints(
    rawSecondaryMetricConstraints,
    normalizeSecondaryMetricConstraintMode(secondaryMetricConstraintMode, "advisory"),
  );
  if (autonomyMode) updates.autonomyMode = autonomyMode;
  if (checksPolicy) updates.checksPolicy = checksPolicy;
  if (keepPolicy) updates.keepPolicy = keepPolicy;
  if (dashboardRefreshSeconds != null)
    updates.dashboardRefreshSeconds = Math.max(1, Math.floor(dashboardRefreshSeconds));
  if (clearPacketBudget) updates.packetBudget = null;
  else if (hasPacketBudget) updates.packetBudget = packetBudget;
  if (clearWallClockBudget) updates.wallClockBudgetSeconds = null;
  else if (hasWallClockBudgetSeconds) updates.wallClockBudgetSeconds = wallClockBudgetSeconds;
  if (hasBudgetNote) updates.budgetNote = budgetNote;
  if (hasProtectedBenchmarkPaths) updates.protectedBenchmarkPaths = protectedBenchmarkPaths;
  if (secondaryMetricConstraintMode)
    updates.secondaryMetricConstraintMode = secondaryMetricConstraintMode;
  if (hasSecondaryMetricConstraints)
    updates.secondaryMetricConstraints = serializeSecondaryMetricConstraints(
      rawSecondaryMetricConstraints,
      secondaryMetricConstraints,
    );
  const qualityConstraints = uniqueQualityConstraints(
    qualityConstraintsFromInput(args.quality_constraints ?? args.qualityConstraints),
  );
  if (qualityConstraints.length > 0) updates.qualityConstraints = qualityConstraints;
  if (!clearWallClockBudget && hasWallClockBudgetSeconds && wallClockBudgetSeconds != null) {
    updates.budgetStartedAt = new Date().toISOString();
  } else if (
    clearWallClockBudget ||
    (hasWallClockBudgetSeconds && wallClockBudgetSeconds == null)
  ) {
    updates.budgetStartedAt = null;
  }
  return updates;
}

function hasAnyArg(args: LooseObject, ...names: string[]): boolean {
  return names.some((name) => Object.hasOwn(args, name) && args[name] !== undefined);
}

function serializeSecondaryMetricConstraints(
  rawInput: unknown,
  constraints: Array<{
    expression: string;
    id: string;
    metric: string;
    mode: "advisory" | "blocking";
    operator: string;
  }>,
): LooseObject[] {
  return constraints.map((constraint, index) => {
    const serialized: LooseObject = {
      id: constraint.id,
      metric: constraint.metric,
      operator: constraint.operator,
      expression: constraint.expression,
    };
    if (secondaryConstraintModeWasExplicit(rawInput, index)) serialized.mode = constraint.mode;
    return serialized;
  });
}

function secondaryConstraintModeWasExplicit(rawInput: unknown, index: number): boolean {
  if (Array.isArray(rawInput)) {
    const item = rawInput[index];
    return Boolean(item && typeof item === "object" && Object.hasOwn(item, "mode"));
  }
  return Boolean(rawInput && typeof rawInput === "object" && Object.hasOwn(rawInput, "mode"));
}

async function writeSetupBootstrapFiles(args: LooseObject, options: LooseObject) {
  const { sessionCwd, workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const stateStorage = await preflightAutoresearchPrivateState(workDir);
  const overwrite = boolOption(args.overwrite, false);
  const shellKind = shellKindFromArgs(args);
  const benchmarkFile = shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1";
  const checksFile = shellKind === "bash" ? "autoresearch.checks.sh" : "autoresearch.checks.ps1";
  const files: LooseObject[] = [];
  const context = {
    sessionCwd,
    workDir,
    overwrite,
    shellKind,
    benchmarkFile,
    checksFile,
    files,
    stateStorage,
  };

  if (options.beforeCommonFiles) await options.beforeCommonFiles(context);

  files.push(
    await writeSessionFile(
      resolveSessionPaths({ workDir }).notesPath,
      `${renderSessionDocument(options.sessionDocumentArgs(context)).trimEnd()}\n\n${renderResumeBlock(workDir)}`,
      { overwrite, root: workDir },
    ),
  );
  files.push(
    await writeSessionFile(path.join(workDir, benchmarkFile), options.benchmarkContent(context), {
      overwrite,
      executable: shellKind === "bash",
      root: workDir,
    }),
  );
  files.push(
    await writeSessionFile(
      resolveSessionPaths({ workDir }).ideasPath,
      options.ideasContent(context),
      { overwrite, root: workDir },
    ),
  );
  if (
    args.checks_command ||
    args.checksCommand ||
    boolOption(args.create_checks ?? args.createChecks, false)
  ) {
    files.push(
      await writeSessionFile(path.join(workDir, checksFile), renderChecksScript(args, shellKind), {
        overwrite,
        executable: shellKind === "bash",
        root: workDir,
      }),
    );
  }

  return context;
}

async function setupSession(args: LooseObject) {
  args = await withRecipeDefaults(args);
  if (!args.name) throw new Error("name is required");
  if (!args.metric_name && !args.metricName) throw new Error("metric_name is required");
  validateMetricName(args.metric_name || args.metricName);
  const { sessionCwd, workDir, shellKind, files, stateStorage } = await writeSetupBootstrapFiles(
    args,
    {
      sessionDocumentArgs: () => args,
      benchmarkContent: ({ shellKind: setupShellKind }: LooseObject) =>
        renderBenchmarkScript(args, setupShellKind),
      ideasContent: () => renderIdeasDocument(args),
    },
  );

  await appendSetupRuntimeConfig(files, sessionCwd, args, {
    includeRecipe: true,
    includeRecipeCatalogProvenance: true,
  });

  let init = null;
  if (!boolOption(args.skip_init ?? args.skipInit, false)) {
    init = await initExperiment(args);
  }
  const checkpoint = setupCheckpointGuidance(workDir, files, args.name);
  const metricName = validateMetricName(args.metric_name || args.metricName);
  const benchmarkMode = {
    explicitCommand: Boolean(args.benchmark_command || args.benchmarkCommand),
    printsMetric: explicitBenchmarkPrintsMetric(args),
    note: explicitBenchmarkPrintsMetric(args)
      ? "The benchmark command/script is expected to print METRIC lines."
      : "The generated benchmark script wraps the command and emits the primary metric from elapsed time.",
  };
  const responseFields = await setupCommandResponseFields({
    args,
    benchmarkMode,
    checkpoint,
    metricName,
    sessionCwd,
    shellKind,
    workDir,
  });

  return {
    ok: true,
    workDir,
    sessionCwd,
    shell: shellKind,
    files,
    checkpoint,
    stateStorage,
    ...responseFields,
    init,
  };
}

async function setupResearchSession(args: any) {
  const slug = researchSlugFromArgs(args);
  const goal = args.goal || args.name || slug;
  const { sessionCwd, workDir, shellKind, files, stateStorage } = await writeSetupBootstrapFiles(
    args,
    {
      beforeCommonFiles: async ({
        workDir: setupWorkDir,
        overwrite,
        files: setupFiles,
      }: LooseObject) => {
        await resolveSafeResearchPath(setupWorkDir, slug);
        const researchDir = researchDirPath(setupWorkDir, slug);
        await checkedEnsureDirectory(setupWorkDir, path.join(researchDir, "notes"));
        await checkedEnsureDirectory(setupWorkDir, path.join(researchDir, "deliverables"));
        for (const fileName of [
          "brief.md",
          "plan.md",
          "tasks.md",
          "sources.md",
          "synthesis.md",
          "quality-gaps.md",
        ]) {
          setupFiles.push(
            await writeSessionFile(
              path.join(researchDir, fileName),
              renderResearchFile(fileName, args, slug),
              { overwrite, root: setupWorkDir },
            ),
          );
        }
      },
      sessionDocumentArgs: ({ shellKind: setupShellKind }: LooseObject) => {
        const benchmarkCommand =
          setupShellKind === "bash"
            ? "./autoresearch.sh"
            : "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
        const scopedFiles = [
          researchRelativeDir(slug),
          ...listOption(args.files_in_scope ?? args.filesInScope ?? args.scope),
        ];
        return {
          ...args,
          name: args.name || `Deep research: ${goal}`,
          goal,
          metricName: "quality_gap",
          metricUnit: "gaps",
          direction: "lower",
          benchmarkCommand,
          filesInScope: scopedFiles,
          constraints: [
            ...listOption(args.constraints),
            `Keep research notes under ${researchRelativeDir(slug)}.`,
            "Use source-backed evidence before implementing recommendations.",
          ],
        };
      },
      benchmarkContent: ({ shellKind: setupShellKind }: LooseObject) =>
        renderResearchBenchmarkScript(slug, setupShellKind),
      ideasContent: () =>
        `# Autoresearch Ideas: ${goal}\n\n- Add promising research-backed ideas here when they are not tried immediately.\n`,
    },
  );
  const researchDir = researchDirPath(workDir, slug);

  await appendSetupRuntimeConfig(files, sessionCwd, args, { grouped: true });

  let init = null;
  if (!boolOption(args.skip_init ?? args.skipInit, false)) {
    init = await initExperiment({
      cwd: workDir,
      name: args.name || `Deep research: ${goal}`,
      goal,
      metricName: "quality_gap",
      metricUnit: "gaps",
      direction: "lower",
    });
  }

  const gap = await measureQualityGap({ cwd: workDir, researchSlug: slug });
  const checkpoint = setupCheckpointGuidance(workDir, files, args.name || `Deep research: ${goal}`);
  const responseFields = await setupCommandResponseFields({
    args,
    benchmarkMode: {
      explicitCommand: true,
      printsMetric: true,
      note: "The generated research benchmark emits quality_gap METRIC lines from the scratchpad.",
    },
    checkpoint,
    metricName: "quality_gap",
    sessionCwd,
    shellKind,
    workDir,
  });
  return {
    ok: true,
    workDir,
    sessionCwd,
    slug,
    researchDir,
    shell: shellKind,
    files,
    checkpoint,
    stateStorage,
    ...responseFields,
    init,
    qualityGap: gap,
  };
}

async function researchStart(args: LooseObject) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const slug = safeSlug(args.slug || "research");
  const goal = String(args.goal || "").trim();
  if (!goal) throw new Error("research-start requires --goal.");

  const dryRun = boolOption(args.dry_run ?? args.dryRun, false);
  const configuredBeforeStart = {
    ...currentState(workDir).config,
    ...readConfig(workDir),
  };
  const configuredMetricName = String(configuredBeforeStart.metricName || "").trim();
  const configuredBenchmarkCommand = String(
    configuredBeforeStart.benchmarkCommand ||
      ((await defaultBenchmarkCommandExists(workDir))
        ? await defaultBenchmarkCommand(workDir)
        : ""),
  ).trim();
  const preserveExecutableMetric =
    Boolean(configuredMetricName && configuredBenchmarkCommand) &&
    configuredMetricName !== "quality_gap";
  const primaryMetricName = preserveExecutableMetric ? configuredMetricName : "quality_gap";
  const requestedSkipInit = boolOption(args.skipInit ?? args.skip_init, false);
  const skipInit = requestedSkipInit || preserveExecutableMetric;
  const shouldLogBaseline = skipInit
    ? false
    : boolOption(args.no_baseline_log ?? args.noBaselineLog, false)
      ? false
      : boolOption(args.baseline_log ?? args.baselineLog, true);
  const commandShell = normalizeCommandShell(args.shell, defaultCommandShell());
  const shellQuote = (value: string) => quoteShellArg(value, commandShell);
  const scriptPath = path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs");
  const commands = buildContinuationCommands({
    researchSlug: slug,
    scriptPath,
    shellQuote,
    workDir,
  });
  const setupParts = [
    "node",
    shellQuote(scriptPath),
    "research-setup",
    "--cwd",
    shellQuote(workDir),
    "--slug",
    shellQuote(slug),
    "--goal",
    shellQuote(goal),
  ];
  const addSetupOption = (flag: string, value: unknown) => {
    if (value == null || value === "") return;
    setupParts.push(flag, shellQuote(String(value)));
  };
  const addSetupListOption = (flag: string, value: unknown) => {
    const values = listOption(value);
    if (values.length === 0) return;
    setupParts.push(flag, shellQuote(values.join(",")));
  };
  const addSetupBoolOption = (flag: string, value: unknown) => {
    if (boolOption(value, false)) setupParts.push(flag);
  };
  addSetupOption("--name", args.name);
  addSetupOption("--checks-command", args.checksCommand ?? args.checks_command);
  addSetupOption("--shell", args.shell);
  addSetupListOption("--files-in-scope", args.filesInScope ?? args.files_in_scope);
  addSetupListOption("--constraints", args.constraints);
  addSetupListOption(
    "--secondary-metric-constraints",
    args.secondaryMetricConstraints ?? args.secondary_metric_constraints,
  );
  addSetupOption(
    "--secondary-metric-constraint-mode",
    args.secondaryMetricConstraintMode ?? args.secondary_metric_constraint_mode,
  );
  addSetupListOption(
    "--protected-benchmark-paths",
    args.protectedBenchmarkPaths ?? args.protected_benchmark_paths,
  );
  addSetupListOption("--commit-paths", args.commitPaths ?? args.commit_paths);
  addSetupOption("--max-iterations", args.maxIterations ?? args.max_iterations);
  addSetupOption("--packet-budget", args.packetBudget ?? args.packet_budget);
  addSetupOption(
    "--wall-clock-budget-seconds",
    args.wallClockBudgetSeconds ?? args.wall_clock_budget_seconds,
  );
  addSetupOption("--budget-note", args.budgetNote ?? args.budget_note);
  addSetupOption("--autonomy-mode", args.autonomyMode ?? args.autonomy_mode);
  addSetupOption("--checks-policy", args.checksPolicy ?? args.checks_policy);
  addSetupOption("--keep-policy", args.keepPolicy ?? args.keep_policy);
  addSetupOption(
    "--dashboard-refresh-seconds",
    args.dashboardRefreshSeconds ?? args.dashboard_refresh_seconds,
  );
  addSetupBoolOption("--overwrite", args.overwrite);
  addSetupBoolOption("--create-checks", args.createChecks ?? args.create_checks);
  addSetupBoolOption("--skip-init", args.skipInit ?? args.skip_init);
  addSetupBoolOption(
    "--allow-unsafe-command",
    args.allowUnsafeCommand ?? args.allow_unsafe_command,
  );

  const output = {
    dryRun,
    workDir,
    slug,
    goal,
    metricName: primaryMetricName,
    qualityGapRole: preserveExecutableMetric ? "secondary" : "primary",
    warnings: preserveExecutableMetric
      ? [
          `Preserved configured executable primary metric '${configuredMetricName}'. quality_gap remains secondary research acceptance evidence.`,
        ]
      : [],
    baselineLogged: false,
    baselineSkippedReason: requestedSkipInit
      ? "skip-init disables the default baseline/log step."
      : preserveExecutableMetric
        ? "Configured executable metric was preserved; run the explicit next command when ready to measure it."
        : "",
    commands: {
      setup: setupParts.join(" "),
      benchmarkLint: preserveExecutableMetric
        ? `node ${shellQuote(scriptPath)} benchmark-lint --cwd ${shellQuote(workDir)} --metric-name ${shellQuote(primaryMetricName)}`
        : commands.benchmarkLint,
      doctor: `node ${shellQuote(scriptPath)} doctor --cwd ${shellQuote(workDir)} --check-benchmark --explain`,
      baseline: commands.next,
      logBaseline: commands.measureLast,
      resume: commands.recommendNext,
      state: commands.state,
    },
  };
  if (dryRun) return output;

  const setup = await setupResearchSession({
    ...args,
    cwd: workDir,
    slug,
    goal,
    skipInit,
    skip_init: skipInit,
  });
  const runtimeConfig = preserveExecutableMetric
    ? await writeRuntimeConfig(setup.sessionCwd, {
        name: configuredBeforeStart.name || args.name || `Deep research: ${goal}`,
        goal: configuredBeforeStart.goal || goal,
        metricName: configuredMetricName,
        metricUnit: configuredBeforeStart.metricUnit || "",
        bestDirection: configuredBeforeStart.bestDirection === "higher" ? "higher" : "lower",
        benchmarkCommand: configuredBenchmarkCommand,
      })
    : await writeRuntimeConfig(setup.sessionCwd, {
        name: args.name || `Deep research: ${goal}`,
        goal,
        metricName: "quality_gap",
        metricUnit: "gaps",
        bestDirection: "lower",
      });
  return await withAcceptedWorkdirResolution(
    {
      sessionCwd: setup.sessionCwd,
      workDir,
      config: runtimeConfig,
      sessionPaths: resolveSessionPaths({ sessionCwd: setup.sessionCwd, workDir }),
    },
    async () => {
      const lint = await benchmarkLint({ cwd: workDir, metricName: primaryMetricName });
      const doctor = await doctorSession({
        cwd: workDir,
        checkBenchmark: true,
        explain: true,
        metricName: primaryMetricName,
      });
      let baselinePacket: LooseObject | null = null;
      let baselineLogResult: LooseObject | null = null;
      if (shouldLogBaseline) {
        baselinePacket = await nextExperiment({ cwd: workDir, compact: true });
        baselineLogResult = await logExperiment({
          cwd: workDir,
          fromLast: true,
          status: "measure",
          description: `Baseline ${primaryMetricName} measurement`,
        });
      }
      const full = {
        ...output,
        dryRun: false,
        setup,
        runtimeConfig,
        benchmarkLint: lint,
        doctor,
        baselinePacket,
        baselineLog: baselineLogResult,
        baselineLogged: Boolean(baselineLogResult),
      };
      if (boolOption(args.jsonFull ?? args.json_full, false)) return full;
      return {
        ...output,
        dryRun: false,
        warnings: output.warnings.length ? output.warnings : undefined,
        baselineSkippedReason: output.baselineSkippedReason || undefined,
        baselineLogged: full.baselineLogged,
        stateStorage: compactStateStorage(setup.stateStorage),
        setup: {
          qualityGap: compactResearchStartQualityGap(setup.qualityGap),
          checkpoint: setup.checkpoint,
        },
        benchmarkLint: {
          ok: lint.ok,
          metricName: lint.metricName,
        },
        ...(baselinePacket ? { baselinePacket } : {}),
        ...(baselineLogResult
          ? {
              baselineLog: {
                ok: baselineLogResult.ok,
                experiment: baselineLogResult.experiment || null,
                continuation: baselineLogResult.continuation
                  ? {
                      shouldContinue: baselineLogResult.continuation.shouldContinue,
                      nextAction: baselineLogResult.continuation.nextAction,
                      stopReason: baselineLogResult.continuation.stopReason || "",
                    }
                  : null,
              },
            }
          : {}),
      };
    },
  );
}

function compactResearchStartQualityGap(value: unknown): LooseObject | null {
  const qualityGap = compactRecord(value);
  if (!qualityGap) return null;
  const researchReadiness = compactRecord(qualityGap.researchReadiness) || {};
  const roundDecision = compactRecord(qualityGap.roundDecision) || {};
  return {
    open: qualityGap.open ?? null,
    closed: qualityGap.closed ?? 0,
    total: qualityGap.total ?? 0,
    researchReadiness: {
      open: researchReadiness.open ?? 0,
      closed: researchReadiness.closed ?? 0,
      total: researchReadiness.total ?? 0,
    },
    roundDecision: {
      accepted: roundDecision.accepted === true,
      status: roundDecision.status || "unknown",
      reason: roundDecision.reason || "",
    },
  };
}

function compactStateStorage(value: unknown): LooseObject | null {
  const storage = compactRecord(value);
  if (!storage) return null;
  return {
    storageMode: storage.storageMode || "unavailable",
    targetCount: Array.isArray(storage.targets) ? storage.targets.length : 0,
    warnings: Array.isArray(storage.warnings) ? storage.warnings.slice(0, 3) : [],
  };
}

async function measureQualityGap(args: any) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const slugResolution = resolveResearchSlugForQualityGapSync(args, workDir);
  const slug = slugResolution.slug;
  const researchDir = researchDirPath(workDir, slug);
  const gapsPath = path.join(researchDir, "quality-gaps.md");
  if (!(await pathExists(gapsPath))) {
    throw new Error(`No quality-gaps.md found for research slug '${slug}' at ${gapsPath}`);
  }
  const text = await fsp.readFile(gapsPath, "utf8");
  const decisionsPath = path.join(researchDir, QUALITY_GAP_DECISIONS_FILE);
  const decisionsText = (await pathExists(decisionsPath))
    ? await fsp.readFile(decisionsPath, "utf8")
    : "";
  const summary = summarizeQualityGaps(text, decisionsText);
  const open = summary.open ?? 0;
  const metricOutput = [
    `METRIC quality_gap=${open}`,
    `METRIC quality_total=${summary.total}`,
    `METRIC quality_closed=${summary.closed}`,
    `METRIC research_readiness_open=${summary.researchReadiness.open}`,
    `METRIC research_readiness_total=${summary.researchReadiness.total}`,
  ].join("\n");
  return {
    ok: true,
    workDir,
    slug,
    slugInferred: slugResolution.inferred,
    slugCandidates: slugResolution.candidates,
    researchDir,
    qualityGapsPath: gapsPath,
    decisionsPath,
    open: summary.open,
    closed: summary.closed,
    total: summary.total,
    openItems: summary.openItems,
    closedItems: summary.closedItems,
    legacyProvisionalClosed: summary.legacyProvisionalClosed,
    decisionIssues: summary.decisionIssues,
    researchReadiness: summary.researchReadiness,
    roundDecision: summary.roundDecision,
    gaps: summary.gaps,
    metricOutput,
  };
}

function dashboardSafeDecisionGuidance(guidance: LooseObject): LooseObject {
  const runtimeDriftSummary = guidance.runtimeDriftSummary
    ? {
        ...guidance.runtimeDriftSummary,
        smokeCheck: "",
        nextActionHint: dashboardSafeRuntimeHint(guidance.runtimeDriftSummary),
      }
    : null;
  const preflight = guidance.preflight
    ? {
        ...guidance.preflight,
        blockers: listOption(guidance.preflight.blockers).map(dashboardSafeGuidanceText),
        warnings: listOption(guidance.preflight.warnings).map(dashboardSafeGuidanceText),
        nextCommand: "",
      }
    : null;
  const gateQuality = guidance.gateQuality
    ? {
        ...guidance.gateQuality,
        blockers: listOption(guidance.gateQuality.blockers).map(dashboardSafeGuidanceText),
        warnings: listOption(guidance.gateQuality.warnings).map(dashboardSafeGuidanceText),
        nextActionHint: dashboardSafeGuidanceText(guidance.gateQuality.nextActionHint),
      }
    : null;
  return {
    ...guidance,
    runtimeDriftSummary,
    preflight,
    gateQuality,
  };
}

function dashboardSafeRuntimeHint(runtimeDriftSummary: LooseObject): string {
  const installedRuntime = String(runtimeDriftSummary.installedRuntime || "");
  const builtRuntime = String(runtimeDriftSummary.builtRuntime || "");
  if (installedRuntime === "fresh" && builtRuntime === "available") {
    return "Runtime surfaces look fresh; use the CLI smoke check before making live claims.";
  }
  if (installedRuntime === "stale") {
    return "Installed runtime appears stale; inspect or refresh the runtime with the CLI before acting.";
  }
  if (installedRuntime === "missing") {
    return "Installed runtime is missing; inspect or refresh the runtime with the CLI before acting.";
  }
  return "Runtime drift evidence is unavailable; inspect the runtime with the CLI before acting.";
}

function dashboardLedgerFoldFromContext(value: unknown): DashboardLedgerFold | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fold = value as DashboardLedgerFold;
  return Array.isArray(fold.analysisRecords) && fold.summary && fold.ledgerBounds ? fold : null;
}

function dashboardSettingsContext(context: LooseObject): LooseObject {
  const { ledgerFold: _ledgerFold, readCache: _readCache, ...settingsContext } = context;
  return settingsContext;
}

function dashboardLedgerHealth(fold: DashboardLedgerFold): LooseObject {
  if (!fold.ledgerBounds.truncated) return analyzeLedgerHealth(fold.analysisRecords);
  const invalidCount = Number(fold.ledgerBounds.invalidLedgerEntryCount || 0);
  const warnings = invalidCount
    ? [
        `${invalidCount} invalid ledger record${invalidCount === 1 ? "" : "s"}; run ledger-doctor --cwd <project> --json.`,
      ]
    : [];
  return {
    ok: invalidCount > 0 ? false : null,
    totalRecords: fold.summary.validEntries,
    parseErrorCount: invalidCount,
    parseErrors: fold.ledgerBounds.invalidLedgerEntries || [],
    warnings,
    fullRunNumberHealthAvailable: false,
    bounded: {
      sampleLimit: DASHBOARD_LEDGER_MAX_ENTRIES,
      truncated: true,
    },
  };
}

function dashboardStateFromLedgerFold(
  workDir: string,
  fold: DashboardLedgerFold,
): ReturnType<typeof stateFromSessionRecords> {
  const summary = fold.summary;
  const current = fold.analysisRecords.filter(
    (record) => record.run != null && Number(record.segment ?? summary.segment) === summary.segment,
  );
  const currentProjection = fold.analysisRecords.flatMap((record) => {
    if (record.type === "config") return [];
    if (record.segment != null && Number(record.segment) !== summary.segment) return [];
    return [{ ...record, segment: 0 }];
  });
  const state = stateFromSessionRecords(workDir, [
    ...(summary.activeConfigEntry ? [{ ...summary.activeConfigEntry, segment: 0 }] : []),
    ...currentProjection,
  ]);
  const historicalBest = summary.historicalBestRun
    ? {
        run: summary.historicalBestRun.run ?? null,
        metric: finiteMetric(summary.historicalBestRun.metric),
        status: summary.historicalBestRun.status || "",
        segment: summary.historicalBestRun.segment ?? null,
        description: summary.historicalBestRun.description || "",
        promotionGrade: promotionGradeValue(summary.historicalBestRun),
      }
    : null;
  return {
    ...state,
    config: {
      ...state.config,
      name: typeof summary.config.name === "string" ? summary.config.name : null,
      goal: String(summary.config.goal || ""),
      metricName: String(summary.config.metricName || "metric"),
      metricUnit: String(summary.config.metricUnit || ""),
      bestDirection: summary.config.bestDirection === "higher" ? "higher" : "lower",
    },
    activeConfigEntry: summary.activeConfigEntry,
    previousConfigEntry: summary.previousConfigEntry,
    metricSemanticsWarning: summary.metricSemanticsWarning,
    segment: summary.segment,
    results: fold.analysisRecords.filter((record) => record.run != null),
    current,
    baseline: summary.baseline,
    best: summary.best,
    historicalBest,
    confidence: summary.confidenceComplete ? state.confidence : null,
    development: summary.development,
    promotion: summary.promotion,
    dashboardLedgerSummary: summary,
    dashboardLedgerBounds: fold.ledgerBounds,
  };
}

async function dashboardViewModel(workDir: string, config: any, context: LooseObject = {}) {
  const canonicalState = await publicState({
    cwd: context.requestedCwd || workDir,
    jsonFull: true,
  });
  const readCache = context.readCache || createSessionReadCache();
  const ledgerFold = dashboardLedgerFoldFromContext(context.ledgerFold);
  const records = ledgerFold?.analysisRecords || loadSessionRecords(workDir, readCache);
  const state = ledgerFold
    ? dashboardStateFromLedgerFold(workDir, ledgerFold)
    : loadSessionState(workDir, readCache);
  if (ledgerFold) {
    const cacheKey = path.resolve(workDir);
    readCache.recordsByCwd.set(cacheKey, records);
    readCache.stateByCwd.set(cacheKey, state);
  }
  const qualityGap = await currentQualityGapSummary(workDir);
  const scaffoldHealth = await buildScaffoldHealth({ workDir, config });
  const researchIntegrity = buildResearchIntegrity({ state, config });
  const warnings = [
    ...(context.suppressEnvironmentWarnings
      ? []
      : await operatorWarningsForWorkDir(workDir, state)),
    ...(ledgerFold?.ledgerBounds.truncated
      ? [
          {
            code: "dashboard_ledger_retention_bounded",
            severity: "warning",
            message:
              "Dashboard rows use bounded retention; counts, status totals, baseline, and best use the full streamed ledger. Confidence and detailed evidence lists use retained rows, and full run-number health requires ledger-doctor.",
          },
        ]
      : []),
  ];
  const settings = dashboardSettings(config, dashboardSettingsContext(context));
  const drift =
    context.runtimeDrift ||
    (await buildDriftReport({
      pluginRoot: PLUGIN_ROOT,
      includeInstalled: Boolean(context.includeInstalledRuntime),
    }).catch((error: any) => ({
      ok: null,
      status: "unavailable",
      probeFailed: true,
      warnings: [error.message],
    })));
  const finalizePreview = await finalizationPressureForWorkDir({
    workDir,
    state,
    qualityGap,
    warningDetails: warnings,
  });
  const effectiveFinalizePreview = context.suppressEnvironmentWarnings
    ? suppressEnvironmentWarningsFromPreview(finalizePreview)
    : finalizePreview;
  const lastRun = await readLastRunPacket(workDir).catch((): null => null);
  const activeProgress = await readActiveProgressSnapshot(workDir, config);
  const setupPlanResult = await setupPlan({ cwd: workDir, readCache }).catch((error: any) => ({
    ok: false,
    warnings: [error.message],
  }));
  const guidedSetupArgs =
    context.deliveryMode === "live-server"
      ? { cwd: workDir, compact: true, readCache }
      : { cwd: workDir, readCache };
  const guidedSetupResult = await guidedSetup(guidedSetupArgs).catch((error: any) => ({
    ok: false,
    warnings: [error.message],
  }));
  const dashboardSetupPlan = stripDashboardCommandGuidance(setupPlanResult);
  const dashboardGuidedSetup = stripDashboardCommandGuidance(guidedSetupResult);
  const ledgerHealth = ledgerFold
    ? dashboardLedgerHealth(ledgerFold)
    : analyzeLedgerHealth(records);
  const orchestration = buildParallelOrchestrationContext({
    workDir,
    state,
    config,
    settings,
    records,
  });
  const { memory, fanoutPlan, fanoutProvenance, parallelLanes, watchdogSummary } = orchestration;
  const laneLifecycle = buildLaneLifecycle({
    state,
    records,
    fanoutPlan,
    parallelLanes,
    laneResults: orchestration.laneResults,
    workDir,
    pluginRoot: PLUGIN_ROOT,
  });
  const packetDiagnostics = lastRun
    ? classifyPacketDiagnostics({
        packetEvidence: lastRun.packetEvidence || {},
        run: lastRun.run || {},
        decision: lastRun.decision || {},
        metrics: lastRun.decision?.metrics || lastRun.run?.parsedMetrics || {},
        metricName: state.config.metricName,
        command: continuationCommands(workDir).partialResults,
      })
    : classifyPacketDiagnostics();
  const currentRuntimeProvenance = runtimeProvenance(drift);
  const sourceCleanliness = buildSourceCleanliness({ warningDetails: warnings });
  const guidance = dashboardSafeDecisionGuidance(
    await decisionGuidance({
      workDir,
      config,
      state,
      scaffoldHealth,
      warningDetails: warnings,
      runtimeTrustScope: context.includeInstalledRuntime ? "installed-plugin" : "source-checkout",
    }),
  );
  const stateWithQualityGap = {
    ...buildSessionReadModelState({
      state,
      qualityGap,
      laneLifecycle,
      packetDiagnostics,
      runtimeProvenance: currentRuntimeProvenance,
      runtimeDriftSummary: guidance.runtimeDriftSummary,
      sourceCleanliness,
      gateQuality: guidance.gateQuality,
      preflight: guidance.preflight,
    }),
    runtimeAuthority: guidance.runtimeAuthority,
    ledgerHealth,
  };
  const recipeSummaries = listBuiltInRecipes().map((recipe: any) => ({
    id: recipe.id,
    title: recipe.title,
    tags: recipe.tags || [],
  }));
  const partialResults = await discoverLastRunPartialResultsLazy(workDir, state, lastRun);
  const workflowFriction = analyzeWorkflowFriction({
    state: stateWithQualityGap,
    lastRun,
    warningDetails: warnings,
    recipes: recipeSummaries,
  });
  const experimentEconomics = analyzeExperimentEconomics({
    state: stateWithQualityGap,
    lastRun,
    progress:
      activeProgress ||
      (await readActiveProgressSnapshot(workDir, config)) ||
      lastRun?.packetEvidence?.progressSnapshot ||
      null,
  });
  const controlPlane = {
    goalContract: canonicalState.goalContract || null,
    approvalLedger: canonicalState.approvalLedger || null,
    resourcePreflight: canonicalState.resourcePreflight || null,
    evidenceMaturity: canonicalState.evidenceMaturity || null,
    laneOrchestration: canonicalState.laneOrchestration || null,
    finalizationRunway: canonicalState.finalizationRunway || null,
  };
  const commands = dashboardCommands(workDir, qualityGap);
  const portfolioRecommendation = recommendPortfolioDirection({
    runtimeDrift: guidance.runtimeDriftSummary,
    gateQuality: guidance.gateQuality,
    preflight: guidance.preflight,
    laneLifecycle,
    laneResults: laneLifecycle.latestResults,
    packetDiagnostics,
    experimentMemory: memory,
    best: state.best,
    current: state.current,
  });
  const enrichedState = {
    ...state,
    scaffoldHealth,
    researchIntegrity,
    warningDetails: warnings,
    fanoutPlan,
    fanoutProvenance,
    parallelLanes,
    laneLifecycle,
    packetDiagnostics,
    runtimeProvenance: currentRuntimeProvenance,
    ledgerHealth,
    sourceCleanliness,
    watchdogSummary,
    experimentEconomics,
    partialResults,
    workflowFriction,
    portfolioRecommendation,
    ...controlPlane,
    decisionPlanProjection:
      canonicalState.decisionPlan?.kind === "decision-plan"
        ? projectDashboardDecisionPlan(canonicalState.decisionPlan as DecisionPlan)
        : null,
    resolvedDecision: canonicalState.resolvedDecision || null,
  };
  return buildDashboardViewModelLazy({
    state: enrichedState as any,
    settings,
    commands,
    setupPlan: dashboardSetupPlan,
    guidedSetup: dashboardGuidedSetup,
    qualityGap,
    finalizePreview: effectiveFinalizePreview,
    recipes: recipeSummaries,
    experimentMemory: memory,
    drift,
    warnings,
  });
}

function stripDashboardCommandGuidance(value: any): any {
  return stripDashboardGuidanceCommandFields(value, {
    extraFieldNames: DASHBOARD_GUIDANCE_EXTRA_DROP_FIELDS,
  });
}

function suppressEnvironmentWarningsFromPreview(preview: any) {
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return preview;
  const copy = { ...preview };
  const warnings = listOption(copy.warnings).filter(
    (warning: any) => !/dirty|working tree/i.test(String(warning)),
  );
  if (warnings.length > 0) copy.warnings = warnings;
  else delete copy.warnings;
  delete copy.suggestedCommand;
  delete copy.suggestedCommands;
  return copy;
}

async function configureSession(args: LooseObject) {
  const { sessionCwd, workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const updates = runtimeConfigUpdatesFromArgs(args);
  const maxIterations = positiveIntegerOption(
    args.max_iterations ?? args.maxIterations,
    null,
    "maxIterations",
  );
  const extend = nonNegativeIntegerOption(args.extend ?? args.extendLimit, null, "extend");
  const hasCommitPaths = hasAnyArg(args, "commit_paths", "commitPaths");
  const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
  if (maxIterations != null) updates.maxIterations = maxIterations;
  if (extend != null) {
    const state = currentState(workDir);
    const activeRuns = packetBudgetUsage(state.current);
    const currentMax = Number.isFinite(Number(config.maxIterations))
      ? Math.floor(Number(config.maxIterations))
      : activeRuns;
    updates.maxIterations = Math.max(currentMax, activeRuns) + extend;
  }
  if (hasCommitPaths) updates.commitPaths = commitPaths;
  const nextConfig = await writeRuntimeConfig(sessionCwd, updates);
  return {
    ok: true,
    workDir,
    sessionCwd,
    config: nextConfig,
    updates,
  };
}

export async function initExperiment(args: LooseObject) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  if (!args.name) throw new Error("name is required");
  if (!args.metric_name && !args.metricName) throw new Error("metric_name is required");
  const metricName = validateMetricName(args.metric_name || args.metricName);
  const direction = args.direction === "higher" ? "higher" : "lower";
  const entry = {
    type: "config",
    name: args.name,
    goal: args.goal || "",
    metricName,
    metricUnit: args.metric_unit ?? args.metricUnit ?? "",
    bestDirection: direction,
  };
  appendJsonl(workDir, entry);
  return {
    ok: true,
    workDir,
    message: `Initialized ${entry.name}: ${entry.metricName} (${entry.metricUnit || "unitless"}, ${entry.bestDirection} is better).`,
    config: entry,
  };
}

async function clearSession(args: any) {
  const dryRun = boolOption(args.dry_run ?? args.dryRun, false);
  if (!dryRun && !boolOption(args.confirm ?? args.yes, false)) {
    throw new Error("clear requires --yes for CLI confirmation");
  }
  const { sessionCwd, workDir, sessionPaths } = resolveWorkDir(args.working_dir || args.cwd);
  const targets = new Set([
    ...sessionPaths.clearTargets,
    ...(await autoresearchPrivateStateCandidatePaths(workDir)),
  ]);
  const deleted = [];
  const wouldDelete = [];
  const missing = [];
  for (const filePath of [...targets].sort()) {
    if (await pathExists(filePath)) {
      if (dryRun) {
        wouldDelete.push(filePath);
      } else {
        await fsp.rm(filePath, { recursive: true, force: true });
        deleted.push(filePath);
      }
    } else {
      missing.push(filePath);
    }
  }
  return {
    ok: true,
    workDir,
    sessionCwd,
    dryRun,
    targets: [...targets].sort(),
    wouldDelete,
    deleted,
    missing,
  };
}

async function writeLastRunPacket(workDir: string, packet: any) {
  const stored = await writePrivateStateFile(
    workDir,
    lastRunStateSpec(workDir),
    (target) => {
      packet.lastRunPath = target.path;
      packet.stateStorage = {
        storageMode: target.storageMode,
        path: target.path,
        warning: target.warning,
      };
      return `${JSON.stringify(redactLastRunPacketForStorage(packet), null, 2)}\n`;
    },
    { mode: 0o600 },
  );
  return stored.path;
}

function terminationFailureEvidence(value: LooseObject | null | undefined): LooseObject | null {
  const candidates = [
    value,
    value?.run,
    value?.checks,
    value?.benchmark,
    value?.commandResult,
    value?.result,
    value?.result?.commandResult,
  ];
  return (
    candidates.find(
      (candidate) => candidate?.terminationFailed === true && candidate?.termination,
    ) || null
  );
}

export async function persistTerminationFailure(
  workDir: string,
  command: string,
  evidence: LooseObject | null,
) {
  if (!evidence?.terminationFailed || !evidence.termination) return;
  const current = await readActiveProgressSnapshot(workDir);
  if (current?.exitState === "termination_failed") return;
  const writer = await createActiveProgressWriter(workDir);
  const snapshot = finishProgressSnapshot(
    createProgressSnapshot({
      packetId: `termination-${command}-${Date.now()}`,
      command: `autoresearch ${command}`,
      startedAt: evidence.startedAt || new Date().toISOString(),
      timeoutSeconds: evidence.timeoutSeconds ?? null,
      artifactRoot: ".",
    }),
    {
      exitCode: null,
      timedOut: true,
      terminationFailed: true,
      termination: evidence.termination,
      spawnState: evidence.spawnState,
      spawnError: evidence.spawnError,
      timeoutPhase: "unknown",
      completedAt: evidence.finishedAt || new Date().toISOString(),
    },
  );
  writer.queue(snapshot);
  await writer.close();
}

function redactLastRunPacketForStorage(packet: LooseObject): LooseObject {
  const stored = JSON.parse(JSON.stringify(packet || {}));
  const context = { workDir: packet?.workDir || packet?.history?.workDir || "" };
  if (stored.packetEvidence) {
    stored.packetEvidence = redactEvidenceObject(stored.packetEvidence, context);
  }
  redactRunPacketProcessEvidence(stored.run, context);
  redactBenchmarkContractForStorage(stored.run?.benchmarkContract, context);
  redactAcceptedEvaluatorForStorage(stored.run?.acceptedEvaluator, context);
  redactAcceptedChecksForStorage(stored.run?.acceptedChecks, context);
  if (stored.doctor) {
    redactKnownOptionFileFields(stored.doctor, context);
    stored.doctor = redactEvidenceObject(stored.doctor, context);
  }
  if (stored.history) {
    if (stored.history.command) {
      stored.history.command = redactCommandDisplay(stored.history.command, context);
    }
    redactBenchmarkContractForStorage(stored.history.benchmarkContract, context);
  }
  redactKnownOptionFileFields(stored, context);
  applyLastRunStorageReplacements(stored, lastRunStorageReplacements(packet, context));
  return stored;
}

const STORAGE_COMMAND_FILE_KEYS = new Set(["commandFile", "command_file"]);
const STORAGE_ENV_FILE_KEYS = new Set(["envFile", "env_file", "packetEnvFile", "packet_env_file"]);

function redactKnownOptionFileFields(value: unknown, context: LooseObject): void {
  if (Array.isArray(value)) {
    for (const item of value) redactKnownOptionFileFields(item, context);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as LooseObject)) {
    if (typeof child === "string") {
      if (STORAGE_COMMAND_FILE_KEYS.has(key)) {
        (value as LooseObject)[key] = redactPathDisplay(child, context.workDir);
        continue;
      }
      if (STORAGE_ENV_FILE_KEYS.has(key) && child) {
        (value as LooseObject)[key] = "<env-file>";
        continue;
      }
    }
    redactKnownOptionFileFields(child, context);
  }
}

function lastRunStorageReplacements(packet: LooseObject, context: LooseObject) {
  const replacements: Array<{ token: string; replacement: string }> = [];
  addOptionPathReplacements(replacements, packet?.run?.commandFile, context, {
    replacement: redactPathDisplay(packet?.run?.commandFile, context.workDir),
  });
  addOptionPathReplacements(replacements, packet?.run?.envFile, context, {
    replacement: "<env-file>",
  });
  addOptionPathReplacements(replacements, packet?.run?.benchmarkContract?.commandFile, context, {
    replacement: redactPathDisplay(packet?.run?.benchmarkContract?.commandFile, context.workDir),
  });
  addOptionPathReplacements(replacements, packet?.run?.benchmarkContract?.envFile, context, {
    replacement: "<env-file>",
  });
  addOptionPathReplacements(
    replacements,
    packet?.history?.benchmarkContract?.commandFile,
    context,
    {
      replacement: redactPathDisplay(
        packet?.history?.benchmarkContract?.commandFile,
        context.workDir,
      ),
    },
  );
  addOptionPathReplacements(replacements, packet?.history?.benchmarkContract?.envFile, context, {
    replacement: "<env-file>",
  });
  return replacements
    .filter((entry) => entry.token && entry.token !== entry.replacement)
    .sort((a, b) => b.token.length - a.token.length);
}

function addOptionPathReplacements(
  replacements: Array<{ token: string; replacement: string }>,
  value: unknown,
  context: LooseObject,
  options: { replacement: string },
) {
  const raw = String(value || "").trim();
  if (!raw) return;
  const tokens = new Set<string>();
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(context.workDir || "", raw);
  for (const candidate of [raw, resolved]) {
    if (!isPathLikeReplacementToken(candidate)) continue;
    tokens.add(candidate);
    tokens.add(candidate.replace(/\\/g, "/"));
    tokens.add(candidate.replace(/\//g, "\\"));
  }
  for (const token of tokens) {
    if (token.length > 2) replacements.push({ token, replacement: options.replacement });
  }
}

function isPathLikeReplacementToken(value: string) {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

function applyLastRunStorageReplacements(
  value: unknown,
  replacements: Array<{ token: string; replacement: string }>,
): void {
  if (!replacements.length) return;
  if (Array.isArray(value)) {
    for (const item of value) applyLastRunStorageReplacements(item, replacements);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as LooseObject)) {
    if (typeof child === "string") {
      let text = child;
      for (const { token, replacement } of replacements) {
        text = text.split(token).join(replacement);
      }
      (value as LooseObject)[key] = text;
      continue;
    }
    applyLastRunStorageReplacements(child, replacements);
  }
}

function redactRunPacketProcessEvidence(
  value: LooseObject | null | undefined,
  context: LooseObject,
) {
  if (!value || typeof value !== "object") return;
  if (value.command) value.command = redactCommandDisplay(value.command, context);
  if (value.commandFile) value.commandFile = redactPathDisplay(value.commandFile, context.workDir);
  if (value.envFile) value.envFile = "<env-file>";
  if (value.tailOutput) value.tailOutput = redactEvidenceText(value.tailOutput, context);
  if (value.stdoutTail) value.stdoutTail = redactEvidenceText(value.stdoutTail, context);
  if (value.stderrTail) value.stderrTail = redactEvidenceText(value.stderrTail, context);
  redactProgressEvidence(value.progress, context);
  redactProgressEvidence(value.progressSnapshot, context);
  if (value.commandDiagnostics) {
    redactKnownOptionFileFields(value.commandDiagnostics, context);
    value.commandDiagnostics = redactEvidenceObject(value.commandDiagnostics, context);
  }
  if (value.checks && typeof value.checks === "object") {
    if (value.checks.command) {
      value.checks.command = redactCommandDisplay(value.checks.command, context);
    }
    if (value.checks.tailOutput) {
      value.checks.tailOutput = redactEvidenceText(value.checks.tailOutput, context);
    }
    redactProgressEvidence(value.checks.progress, context);
  }
}

function redactProgressEvidence(value: LooseObject | null | undefined, context: LooseObject) {
  if (!value || typeof value !== "object") return;
  if (value.latestOutputTail) {
    value.latestOutputTail = redactEvidenceText(value.latestOutputTail, context);
  }
  if (Array.isArray(value.stages)) {
    for (const stage of value.stages) {
      if (!stage || typeof stage !== "object") continue;
      if (stage.outputTail) stage.outputTail = redactEvidenceText(stage.outputTail, context);
    }
  }
}

function redactBenchmarkContractForStorage(
  value: LooseObject | null | undefined,
  context: LooseObject,
) {
  if (!value || typeof value !== "object") return;
  if (value.command) value.command = redactCommandDisplay(value.command, context);
  if (value.checksCommand) {
    value.checksCommand = redactCommandDisplay(value.checksCommand, context);
  }
  if (value.commandFile) value.commandFile = redactPathDisplay(value.commandFile, context.workDir);
  if (value.envFile) value.envFile = "<env-file>";
  if (Array.isArray(value.files)) {
    for (const file of value.files) {
      if (!file || typeof file !== "object" || !file.path) continue;
      file.path = redactEvidenceText(redactPathDisplay(file.path, context.workDir), context);
    }
  }
}

function redactAcceptedEvaluatorForStorage(
  value: LooseObject | null | undefined,
  context: LooseObject,
) {
  if (!value || typeof value !== "object") return;
  redactAcceptedExecutionForStorage(value.execution, context);
}

function redactAcceptedChecksForStorage(value: unknown, context: LooseObject) {
  if (!Array.isArray(value)) return;
  for (const check of value) {
    if (!check || typeof check !== "object") continue;
    redactAcceptedExecutionForStorage((check as LooseObject).execution, context);
  }
}

function redactAcceptedExecutionForStorage(
  value: LooseObject | null | undefined,
  context: LooseObject,
) {
  if (!value || typeof value !== "object") return;
  const command = value.command as LooseObject | undefined;
  if (command && typeof command === "object") {
    if (typeof command.script === "string") {
      command.script = redactCommandDisplay(command.script, context);
    }
    if (typeof command.executable === "string") {
      command.executable = redactEvidenceText(command.executable, context);
    }
    if (Array.isArray(command.args)) {
      command.args = command.args.map((argument) => redactEvidenceText(argument, context));
    }
  }
  const environment = value.environment as LooseObject | undefined;
  const source = environment?.source as LooseObject | undefined;
  if (source?.kind === "file" && typeof source.path === "string") {
    source.path = "<env-file>";
  }
  if (Array.isArray(value.protectedInputs)) {
    for (const input of value.protectedInputs) {
      if (!input || typeof input !== "object") continue;
      const protectedInput = input as LooseObject;
      if (typeof protectedInput.path !== "string") continue;
      protectedInput.path =
        protectedInput.role === "environment-file"
          ? "<env-file>"
          : redactPathDisplay(protectedInput.path, context.workDir);
    }
  }
}

const CLI_RESPONSE_TEXT_EVIDENCE_KEYS = new Set([
  "latestOutputTail",
  "outputPreview",
  "outputTail",
  "stderrTail",
  "stdoutTail",
  "tailOutput",
]);

function redactCliResponseForOutput<T>(result: T): T {
  const cloned = JSON.parse(JSON.stringify(result ?? null));
  redactCliResponseNode(cloned, { workDir: inferCliResponseWorkDir(cloned) });
  return cloned as T;
}

function redactCliResponseNode(value: unknown, context: LooseObject): void {
  if (Array.isArray(value)) {
    for (const item of value) redactCliResponseNode(item, context);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as LooseObject;
  const localContext = { ...context, workDir: inferCliResponseWorkDir(node, context.workDir) };
  if (looksLikeProcessEvidence(node)) redactRunPacketProcessEvidence(node, localContext);
  if (node.packetEvidence) {
    node.packetEvidence = redactEvidenceObject(node.packetEvidence, localContext);
    redactProgressEvidence(node.packetEvidence.progressSnapshot, localContext);
  }
  if (node.history) {
    if (node.history.command) {
      node.history.command = redactCommandDisplay(node.history.command, localContext);
    }
    redactBenchmarkContractForStorage(node.history.benchmarkContract, localContext);
  }
  redactBenchmarkContractForStorage(node.benchmarkContract, localContext);
  redactAcceptedEvaluatorForStorage(node.acceptedEvaluator, localContext);
  redactAcceptedChecksForStorage(node.acceptedChecks, localContext);

  for (const [key, child] of Object.entries(node)) {
    if (typeof child === "string") {
      if (key === "commandFile") {
        node[key] = redactPathDisplay(child, localContext.workDir);
        continue;
      }
      if (key === "envFile" && child) {
        node[key] = "<env-file>";
        continue;
      }
      if (CLI_RESPONSE_TEXT_EVIDENCE_KEYS.has(key)) {
        node[key] = redactEvidenceText(child, localContext);
        continue;
      }
    }
    redactCliResponseNode(child, localContext);
  }
}

function inferCliResponseWorkDir(value: unknown, fallback = ""): string {
  if (!value || typeof value !== "object") return fallback;
  const node = value as LooseObject;
  const candidates = [
    node.workDir,
    node.history?.workDir,
    node.run?.workDir,
    node.doctor?.workDir,
    node.settings?.workDir,
  ];
  const found = candidates.find((candidate) => typeof candidate === "string" && candidate);
  return found ? path.resolve(String(found)) : fallback;
}

function looksLikeProcessEvidence(value: LooseObject): boolean {
  return Boolean(
    Object.hasOwn(value, "tailOutput") ||
    Object.hasOwn(value, "stdoutTail") ||
    Object.hasOwn(value, "stderrTail") ||
    Object.hasOwn(value, "progressSnapshot") ||
    Object.hasOwn(value, "commandDiagnostics") ||
    (Object.hasOwn(value, "exitCode") && Object.hasOwn(value, "command")),
  );
}

async function discoverLastRunPartialResultsLazy(
  workDir: string,
  state: LooseObject,
  lastRun: LooseObject | null,
) {
  return await (
    await import("../lib/partial-results.js")
  ).discoverLastRunPartialResults({
    workDir,
    primaryMetricName: state.config?.metricName || "metric",
    lastRunPacket: lastRun,
  });
}

async function ledgerDoctor(args: LooseObject): Promise<LooseObject> {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const ledger = readLedgerRecordsTolerant(workDir);
  const { ledgerPath, records, parseErrors } = ledger;
  const ledgerHealth = analyzeLedgerHealth(records, { parseErrors });
  const repairRequested = boolOption(args.repair, false);

  if (!repairRequested) {
    return {
      ok: ledgerHealth.ok,
      workDir,
      ledgerPath,
      readOnly: true,
      ledgerHealth,
      parseErrors: ledgerHealth.parseErrors,
      warnings: ledgerHealth.warnings,
    };
  }

  if (!boolOption(args.yes, false)) {
    throw new Error("ledger-doctor --repair requires --yes before modifying autoresearch.jsonl.");
  }

  if (ledgerHealth.parseErrorCount > 0) {
    return {
      ok: false,
      workDir,
      ledgerPath,
      readOnly: true,
      refused: true,
      code: "ledger_parse_errors",
      ledgerHealth,
      repairedLedgerHealth: null,
      backupPath: "",
      repair: summarizeLedgerRepair({ changed: false, records, repairs: [] }),
      parseErrors: ledgerHealth.parseErrors,
      warnings: ledgerHealth.warnings,
    };
  }

  const repair = repairLedgerRecords(records);
  if (!repair.changed) {
    return {
      ok: ledgerHealth.ok,
      workDir,
      ledgerPath,
      readOnly: false,
      ledgerHealth,
      repairedLedgerHealth: ledgerHealth,
      backupPath: "",
      repair: summarizeLedgerRepair(repair),
      warnings: ledgerHealth.warnings,
    };
  }

  const backupPath = `${ledgerPath}.repair-backup-${ledgerBackupTimestamp()}`;
  const originalLedger = await fsp.readFile(ledgerPath);
  await checkedAtomicWriteFile(workDir, backupPath, originalLedger, { mode: 0o600 });
  await checkedAtomicWriteFile(workDir, ledgerPath, formatJsonl(repair.records), { mode: 0o600 });
  const repairedLedgerHealth = analyzeLedgerHealth(repair.records);
  return {
    ok: repairedLedgerHealth.ok,
    workDir,
    ledgerPath,
    readOnly: false,
    ledgerHealth,
    repairedLedgerHealth,
    backupPath,
    repair: summarizeLedgerRepair(repair),
    warnings: repairedLedgerHealth.warnings,
  };
}

function summarizeLedgerRepair(repair: ReturnType<typeof repairLedgerRecords>): LooseObject {
  return {
    changed: repair.changed,
    repairedRuns: repair.repairs.length,
    preservedRecords: repair.records.length,
    repairs: repair.repairs,
  };
}

function formatJsonl(records: Array<Record<string, unknown>>): string {
  if (!records.length) return "";
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function ledgerBackupTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function researchFanout(args: LooseObject) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = currentState(workDir);
  const memory = buildExperimentMemory({
    runs: state.current,
    direction: state.config.bestDirection,
    settings: dashboardSettings(config),
  });
  const laneLimit = Math.min(
    positiveIntegerOption(args.lanes ?? args.laneCount, 6, "--lanes") || 6,
    12,
  );
  const dryRun = boolOption(args.dry_run ?? args.dryRun, !boolOption(args.yes, false));
  const lanes = buildParallelLanes({ workDir, memory, config }).slice(0, laneLimit);
  const plan = {
    id: `fanout-${Date.now()}`,
    status: dryRun ? "preview" : "planned",
    createdAt: new Date().toISOString(),
    segment: state.segment,
    runs: state.current.length,
    metric: {
      name: state.config.metricName || config.metricName || "metric",
      direction: state.config.bestDirection || config.bestDirection || "lower",
      contract:
        "Use the configured benchmark METRIC output as the primary decision value; derive composite meaning in project benchmark code, not by adding one-off Autoresearch metrics.",
    },
    lanes,
    dispatchPolicy: {
      defaultMode: "read_only_scout",
      implementationIsolation:
        "Implementation lanes must use a separate worktree or explicit write scope before editing.",
      mergeRule:
        "Only accepted evidence from logged keep or promotion-grade measurement may drive finalization.",
    },
    nextAction:
      "Dispatch the read-only scout lanes in parallel, compare evidence, then choose one isolated implementation lane for the next measured packet.",
  };
  if (!dryRun) {
    appendJsonl(workDir, {
      type: "research_fanout",
      timestamp: Date.now(),
      segment: state.segment,
      fanoutPlan: plan,
    });
  }
  return {
    ok: true,
    workDir,
    dryRun,
    fanoutPlan: plan,
    parallelLanes: lanes,
  };
}

function actionMessage(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as LooseObject;
  return String(
    record.reason || record.message || record.nextActionHint || record.title || record.kind || "",
  ).trim();
}

async function doctorHooks(args: LooseObject = {}): Promise<LooseObject> {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const platformSupported = process.platform !== "win32";
  return {
    ok: true,
    workDir,
    feature: "codex_hooks",
    defaultEnabled: false,
    supportedNow: platformSupported,
    platform: process.platform,
    verdict: platformSupported
      ? "Hooks can be explored as opt-in reminders, but should not be required for core Autoresearch behavior."
      : "Hooks are not a dependable default on this Windows environment; keep them as docs/templates only.",
    limitations: [
      "Codex hooks are experimental.",
      "Use them as reminders or context injection, not irreversible enforcement.",
      "Current hook behavior is best suited to shell/Bash-style tool observations, not complete write/web-search coverage.",
      "Autoresearch core behavior must remain correct without hooks.",
    ],
    templates: {
      sessionStart:
        "SessionStart: run `node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact` and surface the next safe action.",
      postToolUse:
        "PostToolUse: when shell output contains `METRIC name=value`, remind the agent to log the packet with ASI.",
      stop: "Stop: if `autoresearch.last-run.json` exists or continuation.forbidFinalAnswer is true, warn before a final answer.",
    },
    docs: [
      "https://developers.openai.com/codex/hooks",
      "https://developers.openai.com/codex/concepts/customization#skills",
    ],
  };
}

async function newSegment(args: any) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = currentState(workDir);
  const dryRun = boolOption(args.dry_run ?? args.dryRun, false);
  const confirmed = boolOption(args.confirm ?? args.yes, false);
  const reason = String(args.reason || "Start a fresh segment while preserving history.").trim();
  const nextMetricName = String(
    args.metric_name || args.metricName || state.config.metricName || "metric",
  );
  const nextMetricUnit =
    args.metric_unit !== undefined || args.metricUnit !== undefined
      ? String(args.metric_unit ?? args.metricUnit ?? "")
      : (state.config.metricUnit ?? "");
  const requestedDirection = args.direction || args.best_direction || args.bestDirection;
  const nextDirection =
    requestedDirection === "higher"
      ? "higher"
      : requestedDirection === "lower"
        ? "lower"
        : state.config.bestDirection === "higher"
          ? "higher"
          : "lower";
  const entry: LooseObject = {
    type: "config",
    name: state.config.name || "Autoresearch",
    metricName: nextMetricName,
    metricUnit: nextMetricUnit,
    bestDirection: nextDirection,
    segmentReason: reason,
    timestamp: new Date().toISOString(),
  };
  const benchmarkCommand = String(
    args.benchmark_command || args.benchmarkCommand || config.benchmarkCommand || "",
  ).trim();
  const checksCommand = String(
    args.checks_command || args.checksCommand || config.checksCommand || "",
  ).trim();
  if (benchmarkCommand || checksCommand) {
    entry.benchmarkContractAccepted = true;
    entry.benchmarkContractScope = "segment";
    entry.benchmarkContract = await benchmarkContractSnapshot(workDir, {
      command: benchmarkCommand,
      checksCommand,
    });
  }
  const metricSemanticsWarning = segmentMetricSemanticsWarning(state.config, {
    metricName: nextMetricName,
    metricUnit: nextMetricUnit,
    bestDirection: nextDirection,
  });
  if (metricSemanticsWarning) entry.metricSemanticsWarning = metricSemanticsWarning;
  const prospectiveEntries = [...loadSessionRecords(workDir), entry];
  const prospectiveState = stateFromSessionRecords(workDir, prospectiveEntries);
  const contractDerivation = await deriveExperimentContract({
    workDir,
    args,
    config,
    entries: prospectiveEntries,
    ignoreAccepted: true,
  });
  if (contractDerivation.status === "invalid") {
    throw contractDerivationError(contractDerivation);
  }
  if (contractDerivation.status !== "derived") {
    throw new Error("New-segment contract derivation unexpectedly resolved an active contract.");
  }
  if (!dryRun && !confirmed) {
    throw new Error(
      "new-segment requires --dry-run or --yes because it appends to autoresearch.jsonl.",
    );
  }
  let contractEvent = null;
  if (!dryRun) {
    appendJsonl(workDir, entry);
    contractEvent = await appendExperimentContractAcceptance(
      workDir,
      contractDerivation,
      prospectiveState.segment,
    );
  }
  return {
    ok: true,
    workDir,
    dryRun,
    previousSegment: state.segment,
    nextSegment: state.segment + 1,
    entry,
    metricSemanticsWarning,
    benchmarkContract: entry.benchmarkContract || null,
    experimentContract: {
      status: contractEvent ? "accepted" : "derived",
      contract: contractDerivation.contract,
      event: contractEvent,
      missing: [],
      conflicts: [],
    },
    nextAction: dryRun
      ? "Review the segment entry, then rerun with --yes to append it."
      : "Run and log a fresh baseline or next packet for the new segment.",
  };
}

function segmentMetricSemanticsWarning(previous: LooseObject, current: LooseObject) {
  const changed =
    String(previous.metricName || "") !== String(current.metricName || "") ||
    String(previous.metricUnit ?? "") !== String(current.metricUnit ?? "") ||
    String(previous.bestDirection || "lower") !== String(current.bestDirection || "lower");
  if (!changed) return null;
  return {
    code: "metric_semantics_changed",
    severity: "warning",
    message:
      "Metric semantics changed; active segment and historical best may not be directly comparable.",
    previous: {
      metricName: previous.metricName || "metric",
      metricUnit: previous.metricUnit ?? "",
      bestDirection: previous.bestDirection === "higher" ? "higher" : "lower",
    },
    current: {
      metricName: current.metricName || "metric",
      metricUnit: current.metricUnit ?? "",
      bestDirection: current.bestDirection === "higher" ? "higher" : "lower",
    },
  };
}

async function promoteGate(args: any) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const state = currentState(workDir);
  const dryRun = boolOption(args.dry_run ?? args.dryRun, false);
  const confirmed = boolOption(args.confirm ?? args.yes, false);
  const reason = String(args.reason || "").trim();
  if (!reason) throw new Error("promote-gate requires --reason <text>.");
  if (!dryRun && !confirmed) {
    throw new Error(
      "promote-gate requires --dry-run or --yes because it appends a new measurement segment.",
    );
  }
  const queryCount = positiveIntegerOption(args.query_count ?? args.queryCount, null, "queryCount");
  const entry: LooseObject = {
    type: "config",
    name: state.config.name || "Autoresearch",
    metricName: state.config.metricName || "metric",
    metricUnit: state.config.metricUnit ?? "",
    bestDirection: state.config.bestDirection === "higher" ? "higher" : "lower",
    segmentReason: `Promote measurement gate: ${reason}`,
    measurementGate: {
      name: String(args.gate_name || args.gateName || "promotion gate").trim(),
      reason,
      queryCount,
      benchmarkCommand: args.benchmark_command || args.benchmarkCommand || "",
      checksCommand: args.checks_command || args.checksCommand || "",
      notes: listOption(args.notes),
    },
    timestamp: new Date().toISOString(),
  };
  if (!dryRun) appendJsonl(workDir, entry);
  return {
    ok: true,
    workDir,
    dryRun,
    previousSegment: state.segment,
    nextSegment: state.segment + 1,
    entry,
    commands: {
      inspect: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} benchmark-inspect --cwd ${shellQuote(workDir)}`,
      next: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)} --compact`,
    },
    nextAction: dryRun
      ? "Review the promoted measurement gate, then rerun with --yes to append the new segment."
      : "Run a fresh compact packet under the promoted measurement gate and log the decision with ASI.",
  };
}

function promotionStateForPacket(run: LooseObject, state: LooseObject) {
  const promotionGrade = promotionGradeValue({
    metric: run.parsedPrimary,
    metrics: run.parsedMetrics || {},
  });
  if (!run.ok) {
    return {
      label: "blocked",
      reasons: [run.metricError || `Benchmark exit ${run.exitCode ?? "none"}`],
    };
  }
  if (promotionGrade === true) {
    return {
      label: "promotion_eligible",
      reasons: ["Packet carries explicit promotion-grade metadata."],
    };
  }
  const best = state.development?.best;
  const primary = finiteMetric(run.parsedPrimary);
  const reasons = [
    "New packet evidence is exploratory until repeat, holdout, breadth, or promotion-gate metadata is recorded.",
  ];
  if (primary != null && best != null && primary === best) {
    reasons.push("Packet matches the current development best but is not promotion-grade.");
  }
  return { label: "exploratory", reasons };
}

async function packetEvidenceForRun(run: LooseObject, history: LooseObject) {
  const packetSource = {
    history,
    command: run.command,
    metrics: run.parsedMetrics || {},
    exitStatus: run.exitCode ?? null,
    artifacts: run.artifacts || {},
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(packetSource), "utf8")
    .digest("hex");
  const artifacts = artifactList(run.artifacts, run.workDir);
  const taskArtifacts = await taskArtifactsForRun(run);
  const packetId = `packet-${history.nextRun || "next"}-${fingerprint.slice(0, 12)}`;
  return {
    packetId,
    cwd: redactPathDisplay(run.workDir, run.workDir),
    commandIdentity: {
      command: redactCommandDisplay(run.command || "", { workDir: run.workDir }),
      commandFile: redactPathDisplay(run.commandFile || "", run.workDir),
      envFile: run.envFile ? "<env-file>" : "",
      envKeys: run.envKeys || [],
      explicitEnvKeys: run.explicitEnvKeys || run.envKeys || [],
      envMode: run.packetEnvMode || "inherit",
      commandHash: run.command
        ? createHash("sha256").update(run.command, "utf8").digest("hex")
        : "",
    },
    packetEnvMode: run.packetEnvMode || "inherit",
    explicitEnvKeys: run.explicitEnvKeys || run.envKeys || [],
    commandExecutionBoundary: COMMAND_EXECUTION_BOUNDARY.mode,
    commandExecutionBoundaryNote: COMMAND_EXECUTION_BOUNDARY.note,
    timeoutSeconds: run.timeoutSeconds ?? null,
    exitStatus: run.exitCode ?? null,
    timedOut: Boolean(run.timedOut),
    termination: run.termination || null,
    terminationFailed: Boolean(run.terminationFailed),
    spawnState: run.spawnState || "unknown",
    spawnError: run.spawnError || null,
    processLifecycle: rekeyProcessLifecycleRecords(run.processLifecycle, packetId),
    stdoutTail: redactEvidenceText(run.tailOutput || run.progress?.latestOutputTail || "", {
      workDir: run.workDir,
    }),
    stderrTail: "",
    metrics: run.parsedMetrics || {},
    primaryMetric: run.parsedPrimary ?? null,
    artifacts,
    artifactWarnings: run.artifactWarnings || [],
    taskArtifacts,
    protectedBenchmarkGuard: run.protectedBenchmarkGuard || null,
    progressSnapshot: progressSnapshotFromRun({ packetId, run, artifacts }),
    checks: run.checks
      ? {
          command: redactCommandDisplay(run.checks.command || "", { workDir: run.workDir }),
          exitStatus: run.checks.exitCode ?? null,
          timedOut: Boolean(run.checks.timedOut),
          termination: run.checks.termination || null,
          terminationFailed: Boolean(run.checks.terminationFailed),
          passed: run.checks.passed ?? null,
        }
      : null,
    freshnessFingerprint: fingerprint,
  };
}

async function taskArtifactsForRun(run: LooseObject) {
  const {
    paths: taskManifestPaths,
    quarantinedTasks,
    warnings,
  } = await taskManifestPathsForRun(run);
  if (taskManifestPaths.length === 0) {
    return {
      acceptedTasks: [],
      quarantinedTasks,
      warnings,
      totalTasks: 0,
      processedTasks: 0,
      acceptedTaskCount: 0,
      quarantinedTaskCount: quarantinedTasks.length,
      truncated: false,
    };
  }
  const indexed = await indexTaskArtifacts({ artifactPaths: taskManifestPaths });
  return {
    ...indexed,
    quarantinedTasks: [...quarantinedTasks, ...(indexed.quarantinedTasks || [])],
    warnings: [...warnings, ...(indexed.warnings || [])],
    quarantinedTaskCount:
      quarantinedTasks.length +
      (indexed.quarantinedTaskCount ?? (indexed.quarantinedTasks || []).length),
  };
}

async function taskManifestPathsForRun(run: LooseObject) {
  const workDir = path.resolve(run.workDir || process.cwd());
  const workDirReal = await realPathOrResolved(workDir);
  const paths: string[] = [];
  const quarantinedTasks: LooseObject[] = [];
  const warnings: string[] = [];

  for (const [name, artifactPath] of Object.entries(run.artifacts || {})) {
    if (!/task[_-]?manifest/i.test(name)) continue;
    if (!isUsableArtifactPath(artifactPath)) {
      if (artifactPath === "<outside-workdir>") {
        quarantineTaskManifestPath({
          resolved: "<outside-workdir>",
          reason: "outside_workdir",
          detail:
            "path escapes the working directory and was quarantined before task manifest indexing",
          workDir,
          quarantinedTasks,
          warnings,
        });
      }
      continue;
    }

    const artifactValue = String(artifactPath);
    const resolved = path.isAbsolute(artifactValue)
      ? path.resolve(artifactValue)
      : path.resolve(workDir, artifactValue);
    if (!isPathInside(workDir, resolved)) {
      quarantineTaskManifestPath({
        resolved,
        reason: "outside_workdir",
        workDir,
        quarantinedTasks,
        warnings,
      });
      continue;
    }

    const realPathResult = await realPathIfExists(resolved);
    if (realPathResult.error) {
      quarantineTaskManifestPath({
        resolved,
        reason: "realpath_failed",
        detail: realPathResult.error,
        workDir,
        quarantinedTasks,
        warnings,
      });
      continue;
    }

    if (realPathResult.path && !isPathInside(workDirReal, realPathResult.path)) {
      quarantineTaskManifestPath({
        resolved,
        reason: "outside_workdir_realpath",
        workDir,
        quarantinedTasks,
        warnings,
      });
      continue;
    }

    paths.push(resolved);
  }

  return { paths, quarantinedTasks, warnings };
}

function quarantineTaskManifestPath({
  resolved,
  reason,
  detail = "path escapes the working directory",
  workDir,
  quarantinedTasks,
  warnings,
}: {
  resolved: string;
  reason: string;
  detail?: string;
  workDir: string;
  quarantinedTasks: LooseObject[];
  warnings: string[];
}) {
  const displayPath = redactPathDisplay(resolved, workDir);
  quarantinedTasks.push({ path: displayPath, reason });
  warnings.push(`task artifact ${reason} for ${displayPath}: ${detail}`);
}

function isUsableArtifactPath(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value !== "<outside-workdir>";
}

async function realPathIfExists(target: string): Promise<{ path: string | null; error: string }> {
  try {
    return { path: await fsp.realpath(target), error: "" };
  } catch (error) {
    return isMissingPathError(error)
      ? { path: null, error: "" }
      : { path: null, error: errorMessage(error) };
  }
}

async function realPathOrResolved(target: string): Promise<string> {
  try {
    return await fsp.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function nextExperiment(args: any) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  let ownsActiveProgress = false;
  return await runWithRequiredCleanup(
    () =>
      nextExperimentWithActiveProgress(args, () => {
        ownsActiveProgress = true;
      }),
    async () => {
      if (ownsActiveProgress) await deleteActiveProgressSnapshotIfSafe(workDir);
    },
    "Failed to remove active progress snapshot",
  );
}

async function nextExperimentWithActiveProgress(args: any, markProgressOwned: () => void) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const retainedProgress = await readActiveProgressSnapshot(workDir, config);
  if (retainedProgress?.exitState === "termination_failed") {
    const canonical = await loadCanonicalSessionDecision({
      requestedCwd: String(args.working_dir || args.cwd || workDir),
      allowOutsideWorkdir: boolOption(
        args.allowOutsideWorkdir ?? args.allow_outside_workdir,
        false,
      ),
    });
    if (!canonical.ok) {
      return {
        ok: false,
        workDir,
        refused: true,
        code: canonical.diagnostic.code,
        diagnostic: canonical.diagnostic,
      };
    }
    const decision = projectResolvedDecision(canonical.plan);
    return {
      ok: false,
      workDir,
      refused: true,
      code: "termination_failed",
      run: null,
      decision: null,
      blockingAction: decision.canonicalNextAction,
      decisionPlanProjection: projectCompactDecisionPlan(canonical.plan),
      resolvedDecision: decision,
      progress: retainedProgress,
      nextAction: canonical.plan.action.reason,
      clearingCondition:
        "Verify the reported PID and descendants are absent, then clear the retained progress marker before retrying next.",
      commandHint: continuationCommands(workDir).state,
      continuation: projectLoopContinuation(canonical.plan),
    };
  }
  const lastRun = await readLastRunPacket(workDir).catch((): null => null);
  const contractAuthority = await acceptedExperimentContractForMutation({
    workDir,
    args,
    config,
    packet: lastRun,
  });
  const acceptedEvaluatorCommand = executionCommandText(
    contractAuthority.contract.evaluator.execution.command,
  );
  const acceptedChecksCommand = contractAuthority.contract.checks
    .map((check) => executionCommandText(check.execution.command))
    .join(" && ");
  const authorityArgs = acceptedContractAuthorityArgs(
    args,
    acceptedEvaluatorCommand,
    acceptedChecksCommand,
  );
  const doctor = acceptedContractDoctorView(
    await doctorSession({
      ...authorityArgs,
      check_benchmark: false,
      checkBenchmark: false,
      jsonFull: true,
      acceptedContractDigest: contractAuthority.contract.contractDigest,
    }),
  );
  const preflightPlan = doctor.decisionPlan as DecisionPlan | undefined;
  if (!preflightPlan) {
    return {
      ok: false,
      workDir: doctor.workDir || workDir,
      refused: true,
      code: "canonical_decision_unavailable",
      doctor,
      run: null as LooseObject | null,
      decision: null as LooseObject | null,
    };
  }
  if (preflightPlan.capabilities["run-packet"] === "blocked") {
    const resolvedDecision = projectResolvedDecision(preflightPlan);
    return {
      ok: false,
      workDir: doctor.workDir,
      refused: true,
      code: "next_blocked_by_decision_plan",
      doctor,
      run: null as LooseObject | null,
      decision: null as LooseObject | null,
      blockingAction: resolvedDecision.canonicalNextAction,
      decisionPlanProjection: projectCompactDecisionPlan(preflightPlan),
      resolvedDecision,
      nextAction: preflightPlan.action.reason,
      clearingCondition:
        "Resolve the capability diagnostic recorded by the canonical decision, then retry next.",
      commandHint: preflightPlan.action.command || continuationCommands(doctor.workDir).state,
      continuation: projectLoopContinuation(preflightPlan),
    };
  }
  const fixedControlBlock = fixedControlBlockForCommand(acceptedEvaluatorCommand, config, args);
  if (fixedControlBlock) throw fixedControlRerunError(fixedControlBlock);
  const preRunGit = await lastRunGitSnapshot(workDir, config).catch((error: any) => ({
    inside: null as boolean | null,
    error: error.message || String(error),
  }));
  if (gitSnapshotContainsDirtyFingerprintTruncation(preRunGit)) {
    const dirtySourceDiagnostic = decisionDiagnostic("dirty-source", {
      message:
        "Clean or narrow the dirty tree before running next; dirty file fingerprints were truncated before packet freshness could be proven.",
    });
    return {
      ok: false,
      workDir,
      refused: true,
      code: "next_blocked_by_truncated_fingerprints",
      doctor,
      run: null as LooseObject | null,
      decision: null as LooseObject | null,
      git: preRunGit,
      diagnostics: [dirtySourceDiagnostic],
      decisionPlanProjection: projectCompactDecisionPlan(preflightPlan),
      resolvedDecision: projectResolvedDecision(preflightPlan),
      nextAction: preflightPlan.action.reason,
      clearingCondition:
        "Commit, stash, remove, or scope the dirty files so Autoresearch can fingerprint the packet inputs, then retry next.",
      commandHint: continuationCommands(workDir).state,
      continuation: projectLoopContinuation(preflightPlan),
    };
  }
  markProgressOwned();
  await writeNextPreflightProgressSnapshot(workDir, authorityArgs, config);
  const run = await runExperiment(args);
  const stateBeforeLog = currentState(run.workDir);
  const memory = buildExperimentMemory({
    runs: stateBeforeLog.current,
    direction: stateBeforeLog.config.bestDirection,
    settings: dashboardSettings(config),
  });
  const decision = {
    metric: run.parsedPrimary,
    metrics: run.logHint.metrics,
    allowedStatuses: run.logHint.allowedStatuses,
    suggestedStatus:
      run.logHint.safeSuggestedStatus ?? run.logHint.suggestedStatus ?? run.logHint.status,
    rawSuggestedStatus: run.logHint.suggestedStatus ?? run.logHint.status,
    safeSuggestedStatus:
      run.logHint.safeSuggestedStatus ?? run.logHint.suggestedStatus ?? run.logHint.status,
    statusGuidance: run.logHint.statusGuidance || "",
    diversityGuidance: memory.diversityGuidance,
    lanePortfolio: memory.lanePortfolio,
    plateau: memory.plateau,
    novelty: memory.novelty,
    promotion: promotionStateForPacket(run, stateBeforeLog),
    needsDecision: run.logHint.needsDecision,
    asiTemplate: run.ok
      ? {
          hypothesis: "",
          evidence: `${run.metricName}=${run.parsedPrimary}${run.metricUnit || ""}`,
          lane: memory.diversityGuidance?.id || "",
          family: "",
          next_action_hint: "",
        }
      : {
          evidence: run.metricError || `Benchmark exit ${run.exitCode ?? "none"}`,
          rollback_reason: "",
          lane: memory.diversityGuidance?.id || "",
          family: "",
          next_action_hint: "",
        },
  };
  const lastRunFile = await resolveLastRunPath(run.workDir);
  const history = {
    segment: stateBeforeLog.segment,
    config: lastRunConfigSnapshot(stateBeforeLog.config),
    command: run.command,
    replayCommand: replaySafeCommand(run.command, { workDir: run.workDir }),
    replayChecksCommand: replaySafeCommand(run.checks?.command || "", { workDir: run.workDir }),
    packetEnvMode: run.packetEnvMode || "minimal",
    workDir: run.workDir,
    currentRuns: stateBeforeLog.current.length,
    totalRuns: stateBeforeLog.results.length,
    nextRun: stateBeforeLog.results.length + 1,
    benchmarkContract: run.benchmarkContract || null,
    trustConfig: lastRunTrustConfigSnapshot(run.workDir, config, {
      benchmarkContractHash: run.benchmarkContract?.surfaceHash,
      benchmarkCommand: redactCommandDisplay(run.command, { workDir: run.workDir }),
      checksCommand: redactCommandDisplay(
        run.checks?.command || run.benchmarkContract?.checksCommand,
        { workDir: run.workDir },
      ),
      checksPolicy: run.checksPolicy,
      packetEnvMode: run.packetEnvMode || "minimal",
    }),
    git: await lastRunGitSnapshot(run.workDir, config).catch((error: any) => ({
      inside: null as boolean | null,
      error: error.message || String(error),
    })),
  };
  const packetEvidence = await packetEvidenceForRun(run, history);
  const packet = {
    ok: doctor.ok && run.ok,
    workDir: run.workDir,
    lastRunPath: lastRunFile,
    packetEvidence,
    history,
    doctor,
    run,
    decision,
    nextAction: run.terminationFailed
      ? "Process-tree termination could not be proven. Preserve this evidence, verify the reported PID and descendants are absent, then clear the retained progress marker."
      : run.ok
        ? `Log this run as ${decision.safeSuggestedStatus || "keep/discard"} unless review evidence says otherwise, include ASI, then continue with the next ${memory.diversityGuidance?.label || "diversity"} lane.`
        : `Log this run as ${run.logHint.status} with rollback ASI before trying another change.`,
  };
  await writeLastRunPacket(run.workDir, packet);
  return boolOption(args.compact, false) ? compactNextExperimentPacket(packet) : packet;
}

function acceptedContractAuthorityArgs(
  args: LooseObject,
  evaluatorCommand: string,
  checksCommand: string,
): LooseObject {
  const {
    command_file: _commandFileSnake,
    commandFile: _commandFileCamel,
    benchmark_command: _benchmarkCommandSnake,
    benchmarkCommand: _benchmarkCommandCamel,
    ...rest
  } = args;
  return {
    ...rest,
    _: [String(Array.isArray(args._) ? args._[0] || "next" : "next")],
    command: evaluatorCommand,
    checks_command: checksCommand,
    checksCommand,
  };
}

function acceptedContractDoctorView(doctor: LooseObject): LooseObject {
  const legacyMessages = new Set(
    (Array.isArray(doctor.warningDetails) ? doctor.warningDetails : [])
      .filter((detail: LooseObject) => detail?.code === "benchmark_contract_changed")
      .map((detail: LooseObject) => String(detail.message || ""))
      .filter(Boolean),
  );
  const issues = (Array.isArray(doctor.issues) ? doctor.issues : []).filter(
    (issue: unknown) => !legacyMessages.has(String(issue)),
  );
  const warnings = (Array.isArray(doctor.warnings) ? doctor.warnings : []).filter(
    (warning: unknown) => !legacyMessages.has(String(warning)),
  );
  const warningDetails = (Array.isArray(doctor.warningDetails) ? doctor.warningDetails : []).filter(
    (detail: LooseObject) => detail?.code !== "benchmark_contract_changed",
  );
  return {
    ...doctor,
    ok: issues.length === 0,
    issues,
    warnings,
    warningDetails,
  };
}

async function writeNextPreflightProgressSnapshot(
  workDir: string,
  args: LooseObject,
  config: LooseObject = readConfig(workDir),
) {
  const state = currentState(workDir);
  const commandSource = await resolveBenchmarkCommandSource(args, workDir, {
    fallbackToDefault: true,
    requireCommand: false,
    config,
  }).catch(() => null);
  const timeoutSeconds = numberOption(
    args.timeout_seconds ?? args.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const progressWriter = await createActiveProgressWriter(workDir);
  await runWithRequiredCleanup(
    async () => {
      progressWriter.queue(
        createProgressSnapshot({
          packetId: `packet-${state.results.length + 1}-active`,
          command: commandSource?.command || "autoresearch next preflight",
          commandClass: "autoresearch preflight",
          startedAt: new Date().toISOString(),
          timeoutSeconds,
          artifactRoot: ".",
        }),
      );
    },
    () => progressWriter.close(),
    "Failed to close active progress writer",
  );
}

function compactNextExperimentPacket(packet: LooseObject) {
  const run = packet.run || {};
  const decision = packet.decision || {};
  const continuation = packet.continuation || {};
  const metricName = run.metricName || packet.history?.config?.metricName || "metric";
  const metricUnit = run.metricUnit || packet.history?.config?.metricUnit || "";
  const metricText =
    decision.metric == null ? "no primary metric" : `${metricName}=${decision.metric}${metricUnit}`;
  const suggested = decision.safeSuggestedStatus || decision.suggestedStatus || "review";
  return {
    ok: packet.ok,
    workDir: packet.workDir,
    lastRunPath: packet.lastRunPath,
    packetEvidence: packet.packetEvidence,
    history: {
      segment: packet.history?.segment,
      currentRuns: packet.history?.currentRuns,
      totalRuns: packet.history?.totalRuns,
      nextRun: packet.history?.nextRun,
    },
    run: {
      ok: run.ok,
      command: run.command,
      metricName,
      parsedPrimary: run.parsedPrimary,
      parsedMetrics: run.parsedMetrics,
      checks: run.checks
        ? {
            ok: run.checks.ok,
            policy: run.checks.policy,
            exitCode: run.checks.exitCode,
            timedOut: run.checks.timedOut,
            termination: run.checks.termination || null,
            terminationFailed: run.checks.terminationFailed === true,
          }
        : null,
      progress: run.progress
        ? {
            mode: run.progress.mode,
            status: run.progress.status,
            durationMs: run.progress.durationMs,
          }
        : null,
      outputTruncated: run.outputTruncated === true,
      metricsTruncated: run.metricsTruncated === true,
      termination: run.termination || null,
      terminationFailed: run.terminationFailed === true,
    },
    decision: {
      metric: decision.metric,
      metrics: decision.metrics,
      allowedStatuses: decision.allowedStatuses || [],
      suggestedStatus: suggested,
      statusGuidance: decision.statusGuidance || "",
      promotion: decision.promotion || null,
      asiTemplate: decision.asiTemplate || {},
      diversityGuidance: decision.diversityGuidance || null,
      plateau: decision.plateau || null,
    },
    report: {
      tried: `Ran packet #${packet.history?.nextRun || "?"} with ${metricText}.`,
      means:
        decision.statusGuidance ||
        (run.ok ? "Benchmark produced a decision packet." : "Benchmark did not complete cleanly."),
      decision: `Log as ${suggested} unless review evidence changes the call.`,
      next:
        continuation.nextAction || packet.nextAction || "Log the packet, then read continuation.",
    },
    nextAction: packet.nextAction,
    continuation,
    fullPacket:
      "The complete doctor/run output is preserved in lastRunPath for audit and log --from-last.",
  };
}

export async function runAutoresearchCli(
  argv: string[] = process.argv.slice(2),
  io: {
    stderr?: (text: string) => void;
    stdout?: (text: string) => void;
  } = {},
): Promise<number> {
  const writeStdout = io.stdout || console.log;
  const writeStderr = io.stderr || console.error;
  let debug = false;
  try {
    debug = cliDebugRequested(argv);
    await executeAutoresearchCli(argv, writeStdout);
    return 0;
  } catch (error: any) {
    if (error instanceof CommandDecisionProtocolError) {
      writeStderr(JSON.stringify(commandDecisionProtocolFailureEnvelope(error)));
      return 1;
    }
    const message = error?.code
      ? `${error.code}: ${error.message || String(error)}`
      : error?.message || String(error);
    const detail = debug && error?.stack ? error.stack : message;
    if (error instanceof CliUsageError) {
      writeStderr(`${detail}\n\n${usage({ command: error.command })}`);
    } else {
      writeStderr(detail);
    }
    return 1;
  }
}

async function executeAutoresearchCli(
  argv: string[],
  writeStdout: (text: string) => void,
): Promise<void> {
  const args = parseAutoresearchCliArgs(argv);
  const command = args._[0];
  if (!command || args.help || command === "help") {
    const helpCommand = command === "help" ? args._[1] || null : command || null;
    if (helpCommand && !isKnownCliCommand(helpCommand)) {
      throw new CliUsageError(`Unknown command: ${helpCommand}`);
    }
    writeStdout(
      usage({
        command: helpCommand,
        all:
          boolOption(args.all, false) ||
          command === "finalize-current-tree" ||
          (command === "help" && args._[1] === "finalize-current-tree"),
      }),
    );
    return;
  }
  const migrationError = compatibilityErrorForCli(command);
  if (migrationError) throw new CliUsageError(migrationError, command);
  await withOutsideWorkdirAuthorization(boolOption(args.allowOutsideWorkdir, false), async () => {
    const handlers = createCliCommandHandlers({
      benchmarkInspect,
      benchmarkLint,
      checksInspect,
      clearSession,
      codexGoalBrief,
      configureSession,
      doctorHooks,
      doctorSession,
      exportDashboard,
      finalizeCurrentTree: buildFinalizeCurrentTree,
      finalizePreview: buildFinalizePreview,
      gapCandidates: buildGapCandidates,
      guidedSetup,
      interactiveSetup,
      logExperiment,
      ledgerDoctor,
      measureQualityGap,
      newSegment,
      nextExperiment,
      onboardingPacket,
      parseJsonOption,
      partialResultsCommand,
      promoteGate,
      promptPlan,
      publicState,
      recoverProcessIntegrity: async (args: LooseObject) =>
        await recoverTerminationFailedProgress(resolveWorkDir(args.cwd).workDir),
      recordQualityGapDecision,
      recommendNext,
      sessionForensics,
      recipeCommand,
      researchFanout,
      laneRunner,
      serveDashboard,
      setupPlan,
      researchStart,
      setupResearchSession,
      setupSession,
    });
    const requestedCwd = args.workingDir || args.working_dir || args.cwd;
    const execute = async (lockedWorkDir = "", commandArgs: LooseObject = args) => {
      try {
        const outcome = (await runCliCommand(command, commandArgs, handlers)) as LooseObject;
        if (command !== "next") {
          const evidence = terminationFailureEvidence(outcome.result);
          if (evidence) {
            const workDir = lockedWorkDir || resolveWorkDir(requestedCwd).workDir;
            await persistTerminationFailure(workDir, command, evidence);
          }
        }
        return outcome;
      } catch (error: any) {
        const evidence = terminationFailureEvidence(error);
        if (evidence) {
          const workDir = lockedWorkDir || resolveWorkDir(requestedCwd).workDir;
          await persistTerminationFailure(workDir, command, evidence);
        }
        throw error;
      }
    };
    let outcome: LooseObject;
    const requiresMutationLock = commandRequiresSessionMutationLock(command, args);
    if (requiresMutationLock && !commandUsesSessionDecisionProtocol(command, args)) {
      throw new Error(
        `Command-table error: ${command} requires the session lock but does not declare the session decision protocol.`,
      );
    }
    if (requiresMutationLock) {
      // This first resolution selects the existing lock only. The protocol re-captures the
      // routing config from requestedCwd while holding that lock and rejects any drift before
      // the handler can mutate the session.
      const resolution = await resolveInitialSessionMutationRoute({
        requestedCwd: String(requestedCwd || process.cwd()),
        allowOutsideWorkdir: boolOption(args.allowOutsideWorkdir, false),
      });
      const lock = await sessionMutationLockLocation(resolution.workDir);
      const protocol = await withSessionMutationLock(
        lock.root,
        command,
        async () => {
          return await runCommandDecisionProtocol({
            command,
            commandArgs: args,
            requestedCwd: String(requestedCwd || process.cwd()),
            expectedWorkDir: resolution.workDir,
            allowOutsideWorkdir: boolOption(args.allowOutsideWorkdir, false),
            mutate: async (accepted) => {
              const acceptedArgs: LooseObject = { ...args, cwd: accepted.sessionCwd };
              delete acceptedArgs.workingDir;
              delete acceptedArgs.working_dir;
              return await withAcceptedWorkdirResolution(
                {
                  sessionCwd: accepted.sessionCwd,
                  workDir: accepted.workDir,
                  config: accepted.config,
                  coherentSnapshot: accepted.snapshot,
                  canonicalDecisionPlan: accepted.preconditionDecision,
                  canonicalDecisionFacts: accepted.factCollection,
                  sessionPaths: resolveSessionPaths({
                    sessionCwd: accepted.sessionCwd,
                    workDir: accepted.workDir,
                  }),
                },
                async () => await execute(accepted.workDir, acceptedArgs),
              );
            },
          });
        },
        lock.path,
      );
      outcome = attachCommandDecisionProtocol(protocol);
    } else {
      outcome = await execute();
    }
    assertNoCanonicalReadFailure(outcome.result);
    if (outcome.text != null) {
      writeStdout(outcome.text);
      return;
    }
    writeStdout(JSON.stringify(redactCliResponseForOutput(outcome.result), null, 2));
    if (outcome.keepAlive) return await new Promise(() => {});
  });
}

function assertNoCanonicalReadFailure(result: unknown): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const failure = result as LooseObject;
  if (
    failure.ok !== false ||
    !["coherent-snapshot-source-invalid", "coherent-snapshot-unavailable"].includes(
      String(failure.code || ""),
    )
  ) {
    return;
  }
  const diagnostic =
    failure.diagnostic &&
    typeof failure.diagnostic === "object" &&
    !Array.isArray(failure.diagnostic)
      ? (failure.diagnostic as LooseObject)
      : {};
  const error = new Error(String(diagnostic.message || failure.message || failure.code));
  Object.assign(error, { code: failure.code });
  throw error;
}

function attachCommandDecisionProtocol(
  protocol: CommandDecisionProtocolResult<LooseObject>,
): LooseObject {
  const outcome = protocol.result;
  const result =
    outcome.result && typeof outcome.result === "object" && !Array.isArray(outcome.result)
      ? outcome.result
      : outcome.text != null
        ? { output: outcome.text }
        : { value: outcome.result ?? null };
  const {
    decisionPlanProjection: _decisionPlanProjection,
    resolvedDecision: _resolvedDecision,
    continuation: _continuation,
    ...commandResult
  } = result;
  return {
    ...outcome,
    text: undefined,
    result: {
      ...commandResult,
      preconditionDecision: protocol.preconditionDecision,
      mutation: protocol.mutation,
      resultingDecision: protocol.resultingDecision,
    },
  };
}

async function main() {
  const code = await runAutoresearchCli(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  void main();
}
