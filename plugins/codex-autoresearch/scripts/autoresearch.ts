#!/usr/bin/env node
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { buildWatchdogSummary } from "../lib/watchdog-summary.js";
import { verifyDashboardHealthSummary } from "../lib/dashboard-health.js";
import { buildDecisionGuidanceContext } from "../lib/decision-guidance.js";
import {
  buildServeRegistryHealthInput,
  readServeRegistry,
} from "../lib/dashboard-server-registry.js";
import { stripDashboardGuidanceCommandFields } from "../lib/dashboard-command-safety.js";
import { dashboardHtml, dashboardSafeGuidanceText } from "../lib/dashboard-transport.js";
import {
  buildDashboardCommands,
  buildDashboardSettings as dashboardSettings,
  createDashboardCommands,
  operationProgress,
} from "../lib/commands/dashboard.js";
import { buildContinuationCommands } from "../lib/commands/continuation.js";
import {
  buildCompactRecommendNextResponse,
  buildRecommendNextResponse,
  selectRecommendNextRuntimeAuthority,
} from "../lib/commands/recommend-next.js";
import { createDoctorCommandService } from "../lib/commands/doctor.js";
import { createStateCommandService } from "../lib/commands/state.js";
import {
  clearFilesWithWarnings,
  clearPendingLogTransactionWithWarning,
} from "../lib/commands/log.js";
import {
  defaultCommandShell,
  normalizeCommandShell,
  quoteShellArg,
  renderShellCommand,
  type CommandShell,
} from "../lib/command-rendering.js";
import {
  actionSafeActionForKind,
  actionTitleForKind,
  isPacketBrakeKind,
  resolveActionCommand,
} from "../lib/action-metadata.js";
import { renderCliHelp } from "../lib/cli/help.js";
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
  parseJsonFileOption,
  parseJsonOption,
  positiveIntegerOption,
} from "../lib/cli/args.js";
import { createCliCommandHandlers, runCliCommand } from "../lib/cli-handlers.js";
import { buildDriftReport } from "../lib/drift-doctor.js";
import { inspectRuntimeDrift } from "../lib/runtime-drift-doctor.js";
import { analyzeExperimentEconomics } from "../lib/experiment-economics.js";
import { createCoalescingProgressWriter } from "../lib/active-progress-writer.js";
import { buildSourceCleanliness } from "../lib/source-cleanliness.js";
import { buildTerminalReport } from "../lib/terminal-report.js";
import {
  buildCheapFinalizationPressure,
  buildSessionReadModel,
  buildSessionReadModelState,
  statusCountsFromState,
} from "../lib/session-read-model.js";
import { shouldSuppressPreflightGateBlockerForCapsule } from "../lib/loop-governance.js";
import {
  buildProtectedBenchmarkGuard,
  buildProtectedBenchmarkSnapshot,
  normalizeProtectedBenchmarkPaths,
  protectedBenchmarkGuardBlocksKeep,
  protectedBenchmarkPathsFromConfig,
  protectedBenchmarkWarningFromGuard,
} from "../lib/benchmark/contract-guards.js";
import {
  evaluateSecondaryMetricConstraints,
  normalizeSecondaryMetricConstraintMode,
  normalizeSecondaryMetricConstraints,
} from "../lib/benchmark/multi-metric-constraints.js";
import {
  redactCommandDisplay,
  redactEvidenceObject,
  redactEvidenceText,
  redactPathDisplay,
} from "../lib/evidence-redaction.js";
import {
  EVIDENCE_STATUSES,
  artifactEvidenceList,
  artifactList,
  defaultEvidenceStatusForRun,
  isAcceptedCurrentRun,
} from "../lib/evidence-registry.js";
import { isPathInside, resolvePathInsideRootSync } from "../lib/path-containment.js";
import { resolveSafeResearchPath } from "../lib/research-path-guard.js";
import { buildExperimentMemory } from "../lib/experiment-memory.js";
import { displayGitPath, parseNulPathList, parsePorcelainV1Z } from "../lib/git-paths.js";
import {
  buildGoalContract,
  buildGoalFrame,
  goalCompletionUnresolvedBlockers,
} from "../lib/goal-frame.js";
import {
  fixedControlStateSummary,
  fixedControlViolationForCommand,
  fixedControlViolationSummary,
  normalizeFixedControlConfig,
  type FixedControlViolation,
} from "../lib/fixed-control.js";
import { buildLaneLifecycle } from "../lib/lane-lifecycle.js";
import { normalizeLaneBrief, summarizeLaneLessons } from "../lib/lane-briefs.js";
import { buildOperatorChecklist } from "../lib/operator-checklist.js";
import {
  classifyPacketDiagnostics,
  benchmarkContractDiagnostics,
} from "../lib/packet-diagnostics.js";
import {
  activeQualityGapSlugCandidatesSync,
  currentQualityGapSummary,
  gapCandidates as buildGapCandidates,
  resolveResearchSlugForQualityGapSync,
} from "../lib/research-gaps.js";
import { recommendPortfolioDirection } from "../lib/portfolio-advisor.js";
import { assertRunResourcePreflight, buildActiveRunPacketId } from "../lib/process-governor.js";
import {
  applyResolvedRecipeDefaults,
  findRecipe,
  getBuiltInRecipe,
  listBuiltInRecipes,
  loadRecipeCatalog,
  recommendRecipe,
  revalidateRecipeCatalogProvenance,
} from "../lib/recipes.js";
import {
  parseMetricLines,
  runProcess as runBoundedProcess,
  runShell,
  tailText,
} from "../lib/runner.js";
import {
  createProgressSnapshot,
  finishProgressSnapshot,
  progressSnapshotFromRun,
  staleProgressReason,
  type RunnerProgressSnapshot,
  updateProgressSnapshot,
} from "../lib/runner-progress.js";
import {
  STATUS_VALUES,
  FAILURE_STATUSES,
  appendJsonl,
  buildDecisionEnvelope,
  computeConfidence,
  createSessionReadCache,
  finiteMetric,
  currentState,
  isBetter,
  loadSessionRecords,
  loadSessionState,
  listOption,
  pathExists,
  parseQualityGapItems,
  parseQualityGaps,
  readJsonl,
  safeSlug,
  iterationLimitInfo,
  isBaselineEligibleMetricRun,
  isMetricEligibleStatus,
  promotionGradeValue,
  readConfig as readSessionConfig,
  resolveWorkDir as resolveSessionWorkDir,
} from "../lib/session-core.js";
import {
  buildResearchIntegrity,
  buildScaffoldHealth,
  commandDiagnostics,
} from "../lib/truth-signals.js";
import {
  analyzeLedgerHealth,
  readLedgerRecordsTolerant,
  repairLedgerRecords,
} from "../lib/ledger-health.js";
import { analyzeWorkflowFriction } from "../lib/workflow-friction.js";
import { resolvePackageRoot, resolveRepoRoot } from "../lib/runtime-paths.js";
import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import { isBoundedNextAllowedByCapsule } from "../lib/session-decision-capsule.js";
import {
  AUTORESEARCH_DASHBOARD_FILE,
  AUTORESEARCH_RESEARCH_DIR,
  AUTORESEARCH_SESSION_FILES,
  researchDirPathForSession,
  resolveSessionPaths,
  type SessionPaths,
} from "../lib/session-paths.js";
import { indexTaskArtifacts } from "../lib/task-artifact-indexer.js";
import {
  assertSafeDirectoryTree,
  checkedAtomicWriteFile,
  checkedEnsureDirectory,
  checkedReplaceDirectory,
} from "../lib/checked-write.js";
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
type ProcessRunResult = LooseObject & {
  durationSeconds?: number;
  exitCode?: number | null;
  output?: string;
  terminationFailed?: boolean;
  timedOut?: boolean;
};
type ProgressStageResult = {
  durationSeconds: number;
  exitCode: number | null;
  label: string;
  outputTail: string;
  stage: string;
  status: string;
  termination?: LooseObject | null;
  terminationFailed?: boolean;
  timedOut: boolean;
};

interface LocalProcessResult {
  code: number | null;
  stderr: string;
  stderrTruncated?: boolean;
  stdout: string;
  stdoutTruncated?: boolean;
}

const SESSION_FILES: readonly string[] = AUTORESEARCH_SESSION_FILES;
const AUTORESEARCH_GITATTRIBUTES_BLOCK = [
  "# Codex Autoresearch ledger files",
  "autoresearch.jsonl text eol=lf",
  "autoresearch.md text eol=lf",
  "autoresearch.ideas.md text eol=lf",
].join("\n");
const RESEARCH_DIR = AUTORESEARCH_RESEARCH_DIR;
const AUTORESEARCH_OWNED_FILES = [AUTORESEARCH_DASHBOARD_FILE];
const AUTORESEARCH_OWNED_DIRS = [RESEARCH_DIR, "target/autoresearch", ".autoresearch-cache"];

const AUTONOMY_MODES = new Set(["guarded", "owner-autonomous", "manual"]);
const CHECKS_POLICIES = new Set(["always", "on-improvement", "manual"]);
const KEEP_POLICIES = new Set(["primary-only", "primary-or-risk-reduction"]);
const SECONDARY_METRIC_CONSTRAINT_MODES = new Set(["advisory", "blocking"]);
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const METRIC_NAME_PATTERN = /^[^=\s]+$/;
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;
const DIRECTORY_FINGERPRINT_ENTRY_LIMIT = 500;
const DIRECTORY_FINGERPRINT_DEPTH_LIMIT = 6;
const FINGERPRINT_TOTAL_BYTE_LIMIT = 16 * 1024 * 1024;
const COMMAND_EXECUTION_BOUNDARY = {
  mode: "not_sandboxed",
  note: "Benchmark and checks commands run as local shell commands with the current user's permissions.",
  recommendation:
    "Prefer project-local scripts or --command-file for reviewable command text and safer quoting.",
};
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;

type DashboardViewModelModule = typeof import("../lib/dashboard-view-model.js");
type FinalizePreviewModule = typeof import("../lib/finalize-preview.js");
type PartialResultsModule = typeof import("../lib/partial-results.js");
type InspectCommandsModule = typeof import("../lib/commands/inspect.js");
type LaneRunnerCommandModule = typeof import("../lib/commands/lane-runner.js");
type PartialResultsCommandModule = typeof import("../lib/commands/partial-results.js");
type IntegrationsModule = typeof import("../lib/integrations.js");
type LiveServerModule = typeof import("../lib/live-server.js");
type InspectCommandHandlers = ReturnType<InspectCommandsModule["createInspectCommands"]>;

let dashboardViewModelModulePromise: Promise<DashboardViewModelModule> | null = null;
let finalizePreviewModulePromise: Promise<FinalizePreviewModule> | null = null;
let partialResultsModulePromise: Promise<PartialResultsModule> | null = null;
let inspectCommandsModulePromise: Promise<InspectCommandsModule> | null = null;
let laneRunnerCommandModulePromise: Promise<LaneRunnerCommandModule> | null = null;
let partialResultsCommandModulePromise: Promise<PartialResultsCommandModule> | null = null;
let integrationsModulePromise: Promise<IntegrationsModule> | null = null;
let liveServerModulePromise: Promise<LiveServerModule> | null = null;

function dashboardViewModelModule(): Promise<DashboardViewModelModule> {
  dashboardViewModelModulePromise ??= import("../lib/dashboard-view-model.js");
  return dashboardViewModelModulePromise;
}

function finalizePreviewModule(): Promise<FinalizePreviewModule> {
  finalizePreviewModulePromise ??= import("../lib/finalize-preview.js");
  return finalizePreviewModulePromise;
}

function partialResultsModule(): Promise<PartialResultsModule> {
  partialResultsModulePromise ??= import("../lib/partial-results.js");
  return partialResultsModulePromise;
}

function inspectCommandsModule(): Promise<InspectCommandsModule> {
  inspectCommandsModulePromise ??= import("../lib/commands/inspect.js");
  return inspectCommandsModulePromise;
}

function laneRunnerCommandModule(): Promise<LaneRunnerCommandModule> {
  laneRunnerCommandModulePromise ??= import("../lib/commands/lane-runner.js");
  return laneRunnerCommandModulePromise;
}

function partialResultsCommandModule(): Promise<PartialResultsCommandModule> {
  partialResultsCommandModulePromise ??= import("../lib/commands/partial-results.js");
  return partialResultsCommandModulePromise;
}

function integrationsModule(): Promise<IntegrationsModule> {
  integrationsModulePromise ??= import("../lib/integrations.js");
  return integrationsModulePromise;
}

function liveServerModule(): Promise<LiveServerModule> {
  liveServerModulePromise ??= import("../lib/live-server.js");
  return liveServerModulePromise;
}

async function buildDashboardViewModelLazy(
  ...args: Parameters<DashboardViewModelModule["buildDashboardViewModel"]>
): Promise<ReturnType<DashboardViewModelModule["buildDashboardViewModel"]>> {
  return (await dashboardViewModelModule()).buildDashboardViewModel(...args);
}

async function buildFinalizePreview(
  ...args: Parameters<FinalizePreviewModule["finalizePreview"]>
): Promise<Awaited<ReturnType<FinalizePreviewModule["finalizePreview"]>>> {
  return (await finalizePreviewModule()).finalizePreview(...args);
}

async function buildFinalizeCurrentTree(
  ...args: Parameters<FinalizePreviewModule["finalizeCurrentTree"]>
): Promise<Awaited<ReturnType<FinalizePreviewModule["finalizeCurrentTree"]>>> {
  return (await finalizePreviewModule()).finalizeCurrentTree(...args);
}

async function discoverPartialResultCandidatesLazy(
  ...args: Parameters<PartialResultsModule["discoverPartialResultCandidates"]>
): Promise<Awaited<ReturnType<PartialResultsModule["discoverPartialResultCandidates"]>>> {
  return (await partialResultsModule()).discoverPartialResultCandidates(...args);
}

async function integrationsCommandLazy(
  ...args: Parameters<IntegrationsModule["integrationsCommand"]>
): Promise<Awaited<ReturnType<IntegrationsModule["integrationsCommand"]>>> {
  return (await integrationsModule()).integrationsCommand(...args);
}

async function serveAutoresearchLazy(
  ...args: Parameters<LiveServerModule["serveAutoresearch"]>
): Promise<Awaited<ReturnType<LiveServerModule["serveAutoresearch"]>>> {
  return (await liveServerModule()).serveAutoresearch(...args);
}
const MAX_PARSED_METRICS = 512;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
const EMPTY_COMMIT_PATHS_WARNING_CODE = "empty_commit_paths_in_git_repo";
const PENDING_LOG_TRANSACTION_CODE = "pending_log_transaction";

const stateCommandService = createStateCommandService({
  actionMessage,
  analyzeExperimentEconomics,
  analyzeLedgerHealth,
  analyzeWorkflowFriction,
  boolOption,
  buildCheapFinalizationPressure,
  buildDecisionEnvelope,
  buildFinalizePreview,
  buildGoalContract,
  buildGoalFrame,
  buildLaneLifecycle,
  buildParallelOrchestrationContext,
  buildResearchIntegrity,
  buildScaffoldHealth,
  buildServeRegistryHealthInput,
  buildSessionReadModel,
  buildSessionReadModelState,
  buildSourceCleanliness,
  buildTerminalReport,
  classifyPacketDiagnostics,
  commandExecutionBoundary: COMMAND_EXECUTION_BOUNDARY,
  continuationCommands,
  createSessionReadCache,
  currentQualityGapSummary,
  dashboardCommands,
  dashboardSettings,
  decisionGuidance,
  discoverLastRunPartialResults,
  errorMessage,
  fixedControlStateSummary,
  isAcceptedCurrentRun,
  isPacketBrakeKind,
  iterationLimitInfo,
  lastRunPacketFreshness,
  listBuiltInRecipes,
  loadSessionRecords,
  loadSessionState,
  loopContinuation,
  operatorWarningsForWorkDir,
  pendingLogTransactionCode: PENDING_LOG_TRANSACTION_CODE,
  pluginRoot: PLUGIN_ROOT,
  pluginVersion: PLUGIN_VERSION,
  readActiveProgressSnapshot,
  readLastRunPacket,
  readLedgerRecordsTolerant,
  readServeRegistry,
  recommendPortfolioDirection,
  redactCommandDisplay,
  redactEvidenceObject,
  replacementNextCommandForLastRun,
  resolveWorkDir,
  runtimeProvenance,
  statusCountsFromState,
  uniqueStrings,
  verifyDashboardHealthSummary,
  withCanonicalActionCommand,
});
async function publicState(args: LooseObject): Promise<LooseObject> {
  return await stateCommandService.publicState(args);
}

function compactPublicState(state: LooseObject): LooseObject {
  return stateCommandService.compactPublicState(state);
}

async function finalizationPressureForWorkDir(args: {
  workDir: string;
  state: LooseObject;
  qualityGap: LooseObject | null;
  warningDetails: LooseObject[];
}): Promise<LooseObject> {
  return await stateCommandService.finalizationPressureForWorkDir(args);
}

const doctorCommandService = createDoctorCommandService({
  actionMessage,
  benchmarkContractDiagnostics,
  boolOption,
  buildDecisionEnvelope,
  buildDriftReport,
  buildRunProgress,
  commandExecutionBoundary: COMMAND_EXECUTION_BOUNDARY,
  continuationCommands,
  currentState,
  decisionGuidance,
  errorMessage,
  finiteMetric,
  fixedControlBlockForCommand,
  insideGitRepo,
  inspectRuntimeDrift,
  latestBenchmarkContractEntry,
  listOption,
  loopContinuation,
  metricParseSource,
  missingBenchmarkCommandMessage,
  numberOption,
  packetEnvModeFromArgs,
  parseMetricLines,
  pluginRoot: PLUGIN_ROOT,
  pluginVersion: PLUGIN_VERSION,
  publicState,
  redactCommandDisplay,
  redactEvidenceObject,
  revalidateRecipeCatalogProvenance,
  resolveBenchmarkCommandSource,
  resolveWorkDir,
  runShell,
  runtimeProvenance,
  shouldSuppressPreflightGateBlockerForCapsule,
  uniqueStrings,
  withCanonicalActionCommand,
});

async function doctorSession(args: LooseObject): Promise<LooseObject> {
  return await doctorCommandService.doctorSession(args);
}
const PENDING_LOG_TRANSACTION_GIT_PATH = "autoresearch/pending-log-transaction.json";
const DASHBOARD_GUIDANCE_EXTRA_DROP_FIELDS = new Set([
  "runtimeDriftSummary",
  "gateQuality",
  "preflight",
]);

const { exportDashboard, serveDashboard } = createDashboardCommands({
  boolOption,
  buildDriftReport,
  createSessionReadCache,
  dashboardCommands,
  dashboardHtml,
  dashboardSettings,
  dashboardViewModel,
  operationProgress,
  pluginRoot: PLUGIN_ROOT,
  pluginVersion: PLUGIN_VERSION,
  readJsonl,
  resolveOutputInside,
  resolveWorkDir,
  serveAutoresearch: serveAutoresearchLazy,
  shellQuote,
  writeFile: fsp.writeFile,
});

let inspectCommandHandlers: InspectCommandHandlers | null = null;

async function getInspectCommandHandlers(): Promise<InspectCommandHandlers> {
  if (!inspectCommandHandlers) {
    const { createInspectCommands } = await inspectCommandsModule();
    inspectCommandHandlers = createInspectCommands({
      currentState,
      defaultBenchmarkCommand,
      fixedControlBlockForCommand,
      finiteMetric,
      headText,
      metricParseSource,
      numberOption,
      parseMetricLines,
      resolveBenchmarkCommand: async (args: LooseObject, workDir: string, config: LooseObject) =>
        await resolveBenchmarkCommandSource(args, workDir, {
          fallbackToDefault: true,
          requireCommand: false,
          config,
        }),
      resolveWorkDir,
      runShell,
      validateMetricName,
    });
  }
  return inspectCommandHandlers;
}

async function benchmarkLint(args: LooseObject): Promise<LooseObject> {
  return await (await getInspectCommandHandlers()).benchmarkLint(args);
}

async function benchmarkInspect(args: LooseObject): Promise<LooseObject> {
  return await (await getInspectCommandHandlers()).benchmarkInspect(args);
}

async function checksInspect(args: LooseObject): Promise<LooseObject> {
  return await (await getInspectCommandHandlers()).checksInspect(args);
}

let partialResultsCommandHandler: ((args: LooseObject) => Promise<LooseObject>) | null = null;

async function partialResultsCommand(args: LooseObject): Promise<LooseObject> {
  if (!partialResultsCommandHandler) {
    const { createPartialResultsCommand } = await partialResultsCommandModule();
    partialResultsCommandHandler = createPartialResultsCommand({
      appendJsonl,
      assertFreshLastRunPacket,
      boolOption,
      computeConfidence,
      currentState,
      deleteLastRunPacket: async (workDir: string) => {
        await deleteLastRunPacket(workDir);
      },
      finiteMetric,
      loopContinuation,
      readConfig,
      readLastRunPacket,
      researchSlugFromArgs,
      resolveWorkDir,
    });
  }
  return await partialResultsCommandHandler(args);
}

let sessionForensicsCommand: ((args: LooseObject) => Promise<LooseObject>) | null = null;

async function sessionForensics(args: LooseObject): Promise<LooseObject> {
  if (!sessionForensicsCommand) {
    const { createSessionForensicsCommand } = await import("../lib/commands/session-forensics.js");
    sessionForensicsCommand = createSessionForensicsCommand({
      boolOption,
      pluginRoot: PLUGIN_ROOT,
      positiveIntegerOption,
      resolveWorkDir,
      shellQuote,
    });
  }
  return await sessionForensicsCommand(args);
}

let laneRunnerHandler: ((args: LooseObject) => Promise<LooseObject>) | null = null;

async function laneRunner(args: LooseObject): Promise<LooseObject> {
  if (!laneRunnerHandler) {
    const { createLaneRunnerCommand } = await laneRunnerCommandModule();
    laneRunnerHandler = createLaneRunnerCommand({
      appendJsonl,
      assertNoDirtyPathsOutsideWriteScope,
      assertWriteScopeIntegrity,
      boolOption,
      buildParallelOrchestrationContext,
      commandLooksUnsafeForWriteScope,
      currentState,
      dashboardSettings,
      latestLaneResults,
      normalizeLaneMode,
      normalizeParallelLane,
      normalizeRelativePaths,
      positiveIntegerOption,
      readJsonl,
      resolveLaneWorktree,
      resolveWorkDir,
      runProcess: runBoundedProcess,
      runShell,
      synthesizeLaneDecision,
      tailText,
      writeScopeSnapshot,
    });
  }
  return await laneRunnerHandler(args);
}

function usage(options: { all?: boolean; command?: string | null } = {}) {
  return renderCliHelp(options);
}

function evidenceStatusOption(value: unknown, status: string) {
  return enumOption(
    value,
    EVIDENCE_STATUSES,
    defaultEvidenceStatusForRun({ status }),
    "--evidence-status",
  );
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

function validateMetricName(name: string) {
  if (!METRIC_NAME_PATTERN.test(String(name || "")) || DENIED_METRIC_NAMES.has(String(name))) {
    throw new Error(
      `Metric name must match the METRIC parser grammar: one non-empty token without whitespace or "=". Got ${name}`,
    );
  }
  return String(name);
}

function normalizeRelativePaths(paths: unknown, optionName: string = "paths"): string[] {
  return listOption(paths).map((item) => {
    const normalized = item.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (
      !normalized ||
      normalized === "." ||
      path.isAbsolute(normalized) ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized === ".." ||
      normalized.startsWith(":") ||
      /[*?[\]]/.test(normalized) ||
      normalized.startsWith(".git/") ||
      normalized === ".git"
    ) {
      throw new Error(
        `${optionName} must contain literal project-relative paths that do not escape the working directory or use Git pathspec magic: ${item}`,
      );
    }
    return normalized.replace(/\/$/, "");
  });
}

const outsideWorkdirAuthorization = new AsyncLocalStorage<boolean>();

function resolveOutputInside(workDir: string, output?: string) {
  const defaultOutput = resolveSessionPaths({ workDir }).dashboardExportPath;
  const resolved = output
    ? resolvePathInsideRootSync(workDir, output)
    : { absolutePath: defaultOutput, inside: true, relativePath: AUTORESEARCH_DASHBOARD_FILE };
  if (!resolved.inside) {
    throw new Error(`Dashboard output is outside the working directory: ${resolved.absolutePath}`);
  }
  return resolved.absolutePath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWithRequiredCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
  cleanupLabel: string,
): Promise<T> {
  let value!: T;
  let actionFailed = false;
  let primaryError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    value = await action();
  } catch (error) {
    actionFailed = true;
    primaryError = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }
  if (cleanupFailed) {
    if (!actionFailed) throw cleanupError;
    throw new AggregateError(
      [primaryError, cleanupError],
      `${errorMessage(primaryError)}\n${cleanupLabel}: ${errorMessage(cleanupError)}`,
    );
  }
  if (actionFailed) throw primaryError;
  return value;
}

function errorCodeOrMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const payload = error as { code?: unknown; message?: unknown };
    return String(payload.code || payload.message || error);
  }
  return String(error);
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
  return resolveSessionWorkDir(String(cwdArg || "") || undefined, {
    allowOutsideWorkdir: outsideWorkdirAuthorization.getStore() === true,
  });
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
            "autoresearch.md",
            "autoresearch.ideas.md",
            shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1",
            "autoresearch.config.json",
            ".gitattributes",
          ],
          commands: [
            commandLine(
              [
                "git",
                "add",
                "--",
                "autoresearch.md",
                "autoresearch.ideas.md",
                shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1",
                "autoresearch.config.json",
                ".gitattributes",
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

function canonicalActionForGuidedSetup({
  doctor,
  explicitBenchmarkCommand,
  stage,
}: LooseObject): LooseObject | null {
  if (
    stage === "stale-last-run" ||
    stage === "needs-log-decision" ||
    stage === "needs-setup" ||
    stage === "needs-benchmark-command"
  ) {
    return null;
  }
  const loopContract = doctor?.loopContract || {};
  const canonicalNextAction = doctor?.canonicalNextAction || null;
  const action = blockingLoopAction(loopContract, canonicalNextAction);
  if (!action || action.kind === "next-packet") return null;
  if (stage === "needs-baseline" && action.kind === "preflight" && explicitBenchmarkCommand) {
    return null;
  }
  if (loopContract.canRunNextPacket !== false) return null;
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
  if (kind === "setup" || kind === "benchmark-command") return "setup_session";
  if (kind === "decision-capsule") return "recommend_next";
  if (kind === "partial-salvage" || kind === "packet-diagnostic") return "partial_results";
  if (kind === "segment-transition") return "new_segment";
  if (kind === "finalization" || kind === "finalize-preview") return "finalize_preview";
  if (kind === "context-distillation") return "session_forensics";
  return actionSafeActionForKind(kind, kind).replace(/-/g, "_");
}

function guidedSafetyForCanonicalKind(kind: string): string {
  if (kind === "setup" || kind === "segment-transition") return "state_mutation";
  if (kind === "next-packet" || kind === "baseline") return "process_start";
  if (kind === "log-decision") return "git_mutation";
  return "read";
}

async function promptPlan(args: LooseObject): Promise<LooseObject> {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const prompt = String(args.prompt || args.goal || args.request || "").trim();
  if (!prompt) throw new Error("prompt-plan requires --prompt <text>.");
  const intent = await analyzeAutoresearchPrompt(workDir, prompt, args);
  const setupDefaults = intent.setupDefaults as LooseObject;
  const setupArgs = {
    cwd: workDir,
    ...intent.setupDefaults,
    name: args.name || intent.setupDefaults.name,
    goal: args.goal || intent.setupDefaults.goal,
    metricName: args.metricName ?? args.metric_name ?? intent.setupDefaults.metricName,
    metric_name: args.metric_name ?? args.metricName ?? intent.setupDefaults.metricName,
    metricUnit: args.metricUnit ?? args.metric_unit ?? intent.setupDefaults.metricUnit,
    metric_unit: args.metric_unit ?? args.metricUnit ?? intent.setupDefaults.metricUnit,
    direction: args.direction || intent.setupDefaults.direction,
    benchmarkCommand:
      args.benchmarkCommand ?? args.benchmark_command ?? intent.setupDefaults.benchmarkCommand,
    benchmark_command:
      args.benchmark_command ?? args.benchmarkCommand ?? intent.setupDefaults.benchmarkCommand,
    checksCommand: args.checksCommand ?? args.checks_command ?? intent.setupDefaults.checksCommand,
    checks_command: args.checks_command ?? args.checksCommand ?? intent.setupDefaults.checksCommand,
    filesInScope: args.filesInScope ?? args.files_in_scope ?? intent.setupDefaults.filesInScope,
    files_in_scope: args.files_in_scope ?? args.filesInScope ?? intent.setupDefaults.filesInScope,
    offLimits: args.offLimits ?? args.off_limits ?? intent.setupDefaults.offLimits,
    off_limits: args.off_limits ?? args.offLimits ?? intent.setupDefaults.offLimits,
    constraints: args.constraints ?? intent.setupDefaults.constraints,
    qualityConstraints:
      args.qualityConstraints ??
      args.quality_constraints ??
      intent.setupDefaults.qualityConstraints,
    quality_constraints:
      args.quality_constraints ??
      args.qualityConstraints ??
      intent.setupDefaults.qualityConstraints,
    secondaryMetrics:
      args.secondaryMetrics ?? args.secondary_metrics ?? intent.setupDefaults.secondaryMetrics,
    secondary_metrics:
      args.secondary_metrics ?? args.secondaryMetrics ?? intent.setupDefaults.secondaryMetrics,
    commitPaths: args.commitPaths ?? args.commit_paths ?? intent.setupDefaults.commitPaths,
    commit_paths: args.commit_paths ?? args.commitPaths ?? intent.setupDefaults.commitPaths,
    maxIterations: args.maxIterations ?? args.max_iterations ?? intent.setupDefaults.maxIterations,
    max_iterations: args.max_iterations ?? args.maxIterations ?? intent.setupDefaults.maxIterations,
    recipe: args.recipe ?? args.recipe_id ?? args.recipeId ?? intent.setupDefaults.recipe,
    recipe_id: args.recipe_id ?? args.recipeId ?? args.recipe ?? intent.setupDefaults.recipe,
    catalog: args.catalog ?? setupDefaults.catalog,
    trustCatalog: args.trustCatalog ?? args.trust_catalog ?? setupDefaults.trustCatalog,
    trust_catalog: args.trust_catalog ?? args.trustCatalog ?? setupDefaults.trustCatalog,
  };
  const setup = await setupPlan(setupArgs);
  const dashboardCommand = commandLine([
    "node",
    path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
    "serve",
    "--cwd",
    workDir,
  ]);
  return {
    ok: true,
    workDir,
    kind: "codex-autoresearch-prompt-plan",
    prompt,
    intent,
    qualityConstraints: intent.qualityConstraints,
    setup,
    commands: {
      promptPlan: commandLine([
        "node",
        path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
        "prompt-plan",
        "--cwd",
        workDir,
        "--prompt",
        prompt,
      ]),
      setup: setup.nextCommand,
      doctor: setup.guidedFlow.find((step: any) => step.step === "doctor")?.command || "",
      dashboard: dashboardCommand,
      firstPacket: setup.baselineCommand,
    },
    missingEssentials: intent.missing || setup.missing || [],
    nextStep:
      setup.nextStep ||
      sharedNextStep({
        stage: "setup-repair",
        title: "Create session setup",
        reason: intent.nextAction,
        command: setup.nextCommand,
        toolName: "setup_session",
        safety: "state_mutation",
        missingEssentials: intent.missing || setup.missing || [],
      }),
    nextAction: intent.nextAction,
  };
}

async function analyzeAutoresearchPrompt(workDir: string, prompt: string, args: LooseObject) {
  const explicit = parsePromptFields(prompt);
  const discoveredBenchmark = await discoverAutoresearchBenchmark(workDir, prompt);
  const lower = prompt.toLowerCase();
  const speed = /\b(speed|fast|faster|latency|runtime|p99|p90|performance|slow)\b/.test(lower);
  const memory = /\b(memory|rss|heap|footprint|ram)\b/.test(lower);
  const bugs = /\b(bug|bugs|defect|defects|failure|failures|low hanging fruits?)\b/.test(lower);
  const productResearch =
    /\b(product|docs?|documentation|ux|dashboard|architecture|study|research|delight)\b/.test(
      lower,
    );
  const testSpeed = /\b(unit tests?|tests?)\b/.test(lower) && speed;
  const latencyRatio = /\bp99\b/.test(lower) && /\bp90\b/.test(lower);
  const qualityGapIntent =
    /\bquality[_ -]?gap\b/.test(lower) ||
    /\b(friction|smooth|manual tests?|manual-test|end to end|e2e|user experience|ai experience|skill-first|security hygiene|evidence hygiene|release readiness|release path|operator ux|readout ux|dashboard ux)\b/.test(
      lower,
    );
  const explicitMeasuredContract =
    !/\bquality[_ -]?gap\b/.test(lower) &&
    Boolean(explicit.benchmarkCommand || explicit.metricName);
  const maxIterations =
    positiveIntegerFromPrompt(prompt) ??
    positiveIntegerOption(args.max_iterations ?? args.maxIterations, null, "maxIterations");
  const suspects = parseSuspects(prompt);
  const referencedFiles = parseReferencedFiles(prompt);
  const qualityConstraints = qualityConstraintsForText(prompt);
  const explicitScope = explicit.scope.length ? explicit.scope : [];
  const repoRecipe = await recommendRecipe(workDir);
  const loopKind =
    !explicitMeasuredContract &&
    (bugs || qualityGapIntent || (productResearch && !speed && !memory))
      ? "quality-gap"
      : "measured-optimization";
  const useDiscoveredBenchmark = loopKind === "measured-optimization" ? discoveredBenchmark : null;
  const metricName =
    explicit.metricName ||
    useDiscoveredBenchmark?.metricName ||
    (bugs || qualityGapIntent || (productResearch && !speed && !memory)
      ? "quality_gap"
      : latencyRatio
        ? "p99_p90_ratio"
        : speed && memory
          ? "score"
          : speed
            ? "seconds"
            : memory
              ? "rss_mb"
              : repoRecipe?.metricName || "seconds");
  const direction =
    explicit.direction ||
    useDiscoveredBenchmark?.direction ||
    (metricName === "quality_gap" ||
    metricName === "p99_p90_ratio" ||
    metricName === "seconds" ||
    metricName === "rss_mb"
      ? "lower"
      : metricLooksHigherIsBetter(metricName)
        ? "higher"
        : repoRecipe?.direction || "lower");
  const metricUnit =
    explicit.metricUnit ||
    useDiscoveredBenchmark?.metricUnit ||
    (metricName === "quality_gap"
      ? "gaps"
      : metricName === "seconds"
        ? "s"
        : metricName === "rss_mb"
          ? "MB"
          : "");
  const secondaryMetrics = uniqueStrings([
    ...explicit.secondaryMetrics,
    ...(speed && memory ? ["seconds", "rss_mb"] : []),
    ...(latencyRatio ? ["p90_ms", "p99_ms"] : []),
    ...suspects.map((suspect: any) => `suspect:${suspect}`),
  ]);
  const constraints = uniqueStrings([
    ...explicit.constraints,
    ...(useDiscoveredBenchmark?.constraints || []),
    ...(testSpeed ? ["Do not delete or skip correctness tests to improve runtime."] : []),
    ...(memory ? ["Treat memory regressions as tradeoffs, not invisible wins."] : []),
    ...(suspects.length ? [`Evaluate suspect families separately: ${suspects.join(", ")}.`] : []),
    ...(referencedFiles.length
      ? [
          `Use referenced experiment notes before inventing new families: ${referencedFiles.join(", ")}.`,
        ]
      : []),
    ...qualityConstraints.map(
      (constraint) => `Quality constraint (${constraint.domain}): ${constraint.guidance}`,
    ),
  ]);
  const filesInScope = uniqueStrings([
    ...explicitScope,
    ...(useDiscoveredBenchmark ? [useDiscoveredBenchmark.path] : []),
    ...(testSpeed ? ["test runner config", "test helpers"] : []),
    ...(repoRecipe?.scope || []),
  ]);
  const offLimits = uniqueStrings(explicit.offLimits);
  const benchmarkCommand = explicit.benchmarkCommand || useDiscoveredBenchmark?.command || "";
  const checksCommand = explicit.checksCommand || "";
  const recipe = benchmarkCommand
    ? ""
    : loopKind === "quality-gap"
      ? "quality-gap"
      : repoRecipe?.id || "custom";
  const missing = [];
  if (!benchmarkCommand && loopKind === "measured-optimization") {
    missing.push("benchmark_command");
  }
  if (!checksCommand && qualityConstraints.length > 0) missing.push("checks_command");
  if (!checksCommand && (testSpeed || bugs)) missing.push("checks_command");
  if (!filesInScope.length) missing.push("scope");
  const setupMissing = uniqueStrings(missing);
  const experimentPlan = buildPromptExperimentPlan({
    prompt,
    speed,
    memory,
    bugs,
    latencyRatio,
    testSpeed,
    suspects,
    referencedFiles,
    discoveredBenchmark: useDiscoveredBenchmark,
  });
  const nextAction =
    setupMissing.length > 0
      ? `Confirm ${setupMissing.join(", ")} or accept the suggested recipe before setup.`
      : "Run setup, doctor, then one packet. Serve the live dashboard only if the operator asks or freshness needs a browser readout.";
  return {
    loopKind,
    confidence: promptPlanConfidence({
      benchmarkCommand,
      explicit,
      speed,
      memory,
      bugs,
      productResearch,
    }),
    inferredFrom: {
      speed,
      memory,
      bugs,
      productResearch,
      latencyRatio,
      testSpeed,
      maxIterations,
      suspects,
      referencedFiles,
      discoveredBenchmark: useDiscoveredBenchmark
        ? {
            path: useDiscoveredBenchmark.path,
            metricName: useDiscoveredBenchmark.metricName,
            command: useDiscoveredBenchmark.command,
          }
        : null,
    },
    metric: { name: metricName, unit: metricUnit, direction },
    missing: setupMissing,
    qualityConstraints,
    experimentPlan,
    setupDefaults: {
      recipe,
      name: titleFromPrompt(prompt, loopKind),
      goal: prompt,
      metricName,
      metricUnit,
      direction,
      benchmarkCommand,
      checksCommand,
      filesInScope,
      offLimits,
      constraints,
      qualityConstraints,
      secondaryMetrics,
      maxIterations,
      commitPaths: filesInScope,
    },
    safeInterpretation: safePromptInterpretation({ prompt, testSpeed, bugs, speed, memory }),
    nextAction,
  };
}

async function discoverAutoresearchBenchmark(workDir: string, prompt: string) {
  const candidates = [];
  for (const script of await discoverBenchmarkFiles(workDir)) {
    const absolute = path.join(workDir, script.path);
    const text = await fsp.readFile(absolute, "utf8").catch(() => "");
    const metrics = metricNamesFromScript(text);
    if (!metrics.length) continue;
    candidates.push({
      path: script.path,
      command: script.command,
      metricName: choosePrimaryMetricName(metrics),
      metrics,
      score: benchmarkPromptScore(prompt, script.path, text, metrics),
      constraints: benchmarkConstraintsFromScript(script.path, metrics),
    });
  }
  candidates.push(...(await discoverDocumentationBenchmarkHints(workDir, prompt)));
  candidates.push(...(await discoverPackageBenchmarkScripts(workDir, prompt)));
  candidates.push(...(await discoverCargoBenchmarkHints(workDir, prompt)));
  candidates.sort((a: any, b: any) => b.score - a.score || a.path.localeCompare(b.path));
  const best = candidates[0];
  if (!best || best.score <= 0) return null;
  return {
    ...best,
    direction: metricLooksHigherIsBetter(best.metricName) ? "higher" : "lower",
    metricUnit: metricLooksHigherIsBetter(best.metricName)
      ? "points"
      : inferMetricUnit(best.metricName),
  };
}

async function discoverDocumentationBenchmarkHints(workDir: string, prompt: string) {
  const docsRoot = path.join(workDir, "docs");
  if (!(await pathExists(docsRoot))) return [];
  const files: string[] = [];
  await collectDocumentationHintFiles(workDir, docsRoot, files, 0);
  const candidates = [];
  for (const relative of files) {
    const text = await fsp.readFile(path.join(workDir, relative), "utf8").catch(() => "");
    const metrics = metricNamesFromScript(text);
    const command = commandFromDocumentationHint(text);
    if (!metrics.length || !command) continue;
    candidates.push({
      path: relative,
      command,
      metricName: choosePrimaryMetricName(metrics),
      metrics,
      score: benchmarkPromptScore(prompt, relative, text, metrics) + 6,
      constraints: benchmarkConstraintsFromScript(relative, metrics),
    });
  }
  return candidates;
}

async function collectDocumentationHintFiles(
  workDir: string,
  dir: string,
  files: string[],
  depth: number,
) {
  if (depth > 2 || files.length >= 100) return;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch((): [] => [])) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectDocumentationHintFiles(workDir, absolute, files, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(workDir, absolute).replace(/\\/g, "/");
    if (!/\.(?:md|mdx|txt)$/i.test(relative)) continue;
    if (
      !/autoresearch|benchmark|bench|perf|score|quality|eval|evaluator|holdout|promotion|research/i.test(
        relative,
      )
    ) {
      continue;
    }
    files.push(relative);
  }
}

function commandFromDocumentationHint(text: string) {
  const commandMatches = [
    ...String(text).matchAll(
      /`([^`\r\n]*(?:node|python|cargo|npm|pnpm|yarn|bash|powershell|pwsh)[^`\r\n]*)`/gi,
    ),
  ];
  const preferred = commandMatches.find((match: any) =>
    /METRIC|holdout|benchmark|autoresearch|score|eval|harness/i.test(
      `${match[1]}\n${text.slice(Math.max(0, match.index || 0), (match.index || 0) + 800)}`,
    ),
  );
  return String((preferred || commandMatches[0])?.[1] || "").trim();
}

async function discoverBenchmarkFiles(workDir: string) {
  const roots = ["scripts", "bench", "benches", "benchmarks", "test", "tests", "docs"];
  const candidates: LooseObject[] = [];
  for (const rootName of roots) {
    const root = path.join(workDir, rootName);
    if (!(await pathExists(root))) continue;
    await collectBenchmarkFiles(workDir, root, candidates, 0);
  }
  const gitHints = path.join(workDir, ".git", "autoresearch");
  if (await pathExists(gitHints)) await collectBenchmarkFiles(workDir, gitHints, candidates, 0);
  const seen = new Set<string>();
  return candidates.filter((candidate: any) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

async function collectBenchmarkFiles(
  workDir: string,
  dir: string,
  candidates: any[],
  depth: number,
) {
  if (depth > 3 || candidates.length >= 200) return;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch((): [] => [])) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectBenchmarkFiles(workDir, absolute, candidates, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(workDir, absolute).replace(/\\/g, "/");
    if (!benchmarkFileNameLooksRelevant(relative)) continue;
    const command = commandForBenchmarkFile(relative);
    if (!command) continue;
    candidates.push({ path: relative, command });
  }
}

function benchmarkFileNameLooksRelevant(relativePath: string) {
  return (
    /\.(?:mjs|js|cjs|ts|py|ps1|sh)$/i.test(relativePath) &&
    /autoresearch|benchmark|bench|perf|score|quality|eval|evaluator|holdout|promotion|research/i.test(
      relativePath,
    )
  );
}

function commandForBenchmarkFile(relativePath: string) {
  const quoted = shellQuote(relativePath);
  if (/\.(?:mjs|js|cjs|ts)$/i.test(relativePath)) return `node ${quoted}`;
  if (/\.py$/i.test(relativePath)) return `python ${quoted}`;
  if (/\.ps1$/i.test(relativePath)) {
    return `powershell -NoProfile -ExecutionPolicy Bypass -File ${quoted}`;
  }
  if (/\.sh$/i.test(relativePath)) return `bash ${quoted}`;
  return "";
}

async function discoverPackageBenchmarkScripts(workDir: string, prompt: string) {
  const packagePath = path.join(workDir, "package.json");
  if (!(await pathExists(packagePath))) return [];
  const parsed = JSON.parse(await fsp.readFile(packagePath, "utf8"));
  const scripts = parsed?.scripts || {};
  const candidates = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (
      !/autoresearch|benchmark|bench|perf|score|quality|eval|holdout|promotion|research/i.test(name)
    )
      continue;
    const text = String(command || "");
    const metrics = metricNamesFromScript(text);
    if (!metrics.length) continue;
    candidates.push({
      path: `package.json#scripts.${name}`,
      command: `npm run ${shellQuote(name)}`,
      metricName: choosePrimaryMetricName(metrics),
      metrics,
      score: benchmarkPromptScore(prompt, `package.json ${name}`, text, metrics) + 1,
      constraints: benchmarkConstraintsFromScript(`package.json#scripts.${name}`, metrics),
    });
  }
  return candidates;
}

async function discoverCargoBenchmarkHints(workDir: string, prompt: string) {
  const cargoPath = path.join(workDir, "Cargo.toml");
  if (!(await pathExists(cargoPath))) return [];
  const text = await fsp.readFile(cargoPath, "utf8").catch(() => "");
  if (!/\[\[bench\]\]|\bcriterion\b|\biai\b/i.test(text)) return [];
  const score = benchmarkPromptScore(prompt, "Cargo.toml cargo bench", text, ["score"]) + 1;
  return [
    {
      path: "Cargo.toml#bench",
      command: "",
      metricName: "score",
      metrics: ["score"],
      requiresWrapper: true,
      score,
      constraints: [
        "Create or choose a Cargo benchmark wrapper that prints METRIC score=<number>; raw cargo bench output is not a valid Autoresearch packet command.",
      ],
    },
  ];
}

function metricNamesFromScript(text: string) {
  const names = new Set<string>();
  for (const match of text.matchAll(/METRIC\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=/g)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/METRIC\s+\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\s*=/g)) {
    names.add(match[1]);
  }
  return [...names].filter((name: string) => /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name));
}

function choosePrimaryMetricName(metrics: string[]) {
  return (
    metrics.find((metric: any) => /(^|[_:-])score$/i.test(metric)) ||
    metrics.find((metric: any) => /^quality_gap$/i.test(metric)) ||
    metrics[0]
  );
}

function benchmarkPromptScore(
  prompt: string,
  relativePath: string,
  text: string,
  metrics: string[],
) {
  const haystack = `${relativePath}\n${text.slice(0, 4000)}`.toLowerCase();
  const words = uniqueStrings(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((word: any) => word.length >= 4),
  );
  let score = relativePath.includes("autoresearch") ? 2 : 0;
  for (const word of words) {
    if (haystack.includes(word)) score += 1;
  }
  if (metrics.some((metric: any) => /score/i.test(metric))) score += 2;
  if (
    /parse|index|embed|pipeline|benchmark/.test(prompt.toLowerCase()) &&
    /parse|index|embed|pipeline/.test(haystack)
  ) {
    score += 4;
  }
  return score;
}

function benchmarkConstraintsFromScript(relativePath: string, metrics: string[]) {
  const constraints = [
    `Use existing benchmark surface ${relativePath} before inventing a new timer.`,
  ];
  if (metrics.some((metric: any) => /quality|score/i.test(metric))) {
    constraints.push(
      "Treat the primary score as the decision contract; inspect quality, speed, and footprint components before promoting a speedup.",
    );
  }
  return constraints;
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

function inferMetricUnit(metricName: string) {
  if (/seconds|duration|latency|time/i.test(metricName)) return "s";
  if (/rss|memory|heap|mb/i.test(metricName)) return "MB";
  return "";
}

function parsePromptFields(prompt: string) {
  const field = (name: string) => {
    const match = prompt.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
    return match?.[1]?.trim() || "";
  };
  const metricText = field("Metric");
  const metricMatch = metricText.match(
    /^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s*\(([^)]+)\))?(?:\s*,\s*(lower|higher)\s+is\s+better)?/i,
  );
  const secondaryText = field("Secondary metrics") || field("Secondary");
  return {
    benchmarkCommand: field("Benchmark"),
    checksCommand: field("Checks"),
    metricName: metricMatch ? validateMetricName(metricMatch[1]) : "",
    metricUnit: metricMatch?.[2] || "",
    direction: metricMatch?.[3]?.toLowerCase() || "",
    scope: splitHumanList(field("Scope")),
    offLimits: splitHumanList(field("Off limits") || field("Off-limits")),
    constraints: splitHumanList(field("Constraints")),
    secondaryMetrics: splitHumanList(secondaryText),
  };
}

function splitHumanList(value: string) {
  if (!value) return [];
  return value
    .split(/\r?\n|,|;|\band\b/i)
    .map((item: any) => item.trim())
    .filter(Boolean);
}

function positiveIntegerFromPrompt(prompt: string) {
  const match = prompt.match(/\b(\d{1,4})\s*(?:times|iterations|packets|runs)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseSuspects(prompt: string) {
  const match = prompt.match(/\bI suspect:\s*([^.\n]+)/i);
  if (!match) return [];
  return uniqueStrings(splitHumanList(match[1]).map((item: any) => item.replace(/^or\s+/i, "")));
}

function parseReferencedFiles(prompt: string) {
  return uniqueStrings(
    [...prompt.matchAll(/@([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)/g)].map((m: any) => m[1]),
  );
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

function titleFromPrompt(prompt: string, loopKind: string) {
  const stripped = prompt
    .replace(/^Use\s+\$?Codex Autoresearch\s+to\s+/i, "")
    .replace(/^Use\s+Codex Autoresearch\s+to\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const title = stripped.split(/[.!?]/)[0].slice(0, 72).trim();
  return title || (loopKind === "quality-gap" ? "Quality gap loop" : "Measured improvement loop");
}

function buildPromptExperimentPlan({
  speed,
  memory,
  bugs,
  latencyRatio,
  testSpeed,
  suspects,
  referencedFiles,
  discoveredBenchmark,
}: LooseObject) {
  const lanes = [];
  if (discoveredBenchmark)
    lanes.push(`Start from existing benchmark surface ${discoveredBenchmark.path}.`);
  if (latencyRatio) lanes.push("Measure p90 and p99 separately before optimizing the ratio.");
  if (speed) lanes.push("Start with profiling or timing the current slow path.");
  if (memory) lanes.push("Track memory as a secondary or composite metric for every packet.");
  if (testSpeed)
    lanes.push(
      "Try runner configuration, fixture reuse, and expensive setup isolation before changing assertions.",
    );
  if (bugs)
    lanes.push(
      "Convert accepted bug findings into quality_gap checklist items, then close them with checks.",
    );
  for (const suspect of suspects) lanes.push(`Run a bounded suspect family: ${suspect}.`);
  for (const file of referencedFiles)
    lanes.push(`Read ${file} before generating experiment families.`);
  return {
    lanes: lanes.length
      ? lanes
      : ["Run one baseline packet, then choose the smallest measurable next experiment."],
    stopRules: [
      "Stop a family when it regresses the primary metric without reducing risk.",
      "Repeat measurement before keeping noisy or surprising wins.",
      "Do not finalize until checks and packet freshness are current.",
    ],
  };
}

function promptPlanConfidence({
  benchmarkCommand,
  explicit,
  speed,
  memory,
  bugs,
  productResearch,
}: LooseObject) {
  let score = 0.35;
  if (benchmarkCommand) score += 0.25;
  if (explicit.metricName) score += 0.15;
  if (explicit.checksCommand) score += 0.1;
  if (speed || memory || bugs || productResearch) score += 0.15;
  return Math.min(0.95, Number(score.toFixed(2)));
}

function safePromptInterpretation({ prompt, testSpeed, bugs, speed, memory }: LooseObject) {
  if (testSpeed)
    return "Optimize test runtime by changing runner/config/helpers while preserving test coverage and correctness checks.";
  if (bugs)
    return "Find likely defects, measure accepted fixes through quality_gap or checks, and avoid broad rewrites without evidence.";
  if (speed && memory)
    return "Optimize speed with memory as an explicit tradeoff, preferably through a composite metric or secondary metric gate.";
  return `Turn the prompt into a measured Autoresearch session: ${prompt}`;
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
    explicitBenchmarkCommand: Boolean(args.benchmarkCommand || args.benchmark_command),
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
      canonicalNextAction: doctor.canonicalNextAction || null,
      loopContract: doctor.loopContract || null,
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
  const canonicalNextAction = state.canonicalNextAction || null;
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
  const decisionEnvelope =
    nextPacket.decisionEnvelope ||
    nextPacket.resumeAudit ||
    state.decisionEnvelope ||
    state.resumeAudit ||
    null;
  return {
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
      "autoresearch.md",
      "autoresearch.jsonl",
      "autoresearch.ideas.md",
      "autoresearch.last-run.json when present",
    ],
    state,
    sessionDecisionCapsule:
      decisionEnvelope?.sessionDecisionCapsule || state.sessionDecisionCapsule || null,
    resumeAudit: decisionEnvelope,
    decisionEnvelope,
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
}

async function recommendNext(args: LooseObject): Promise<LooseObject> {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const readCache = args.readCache;
  if (boolOption(args.compact, false) && !boolOption(args.full, false)) {
    const compact = await publicState({
      cwd: workDir,
      compact: true,
      codexGoalObjective: args.codexGoalObjective || args.codex_goal_objective,
      readCache,
    });
    const response = buildCompactRecommendNextResponse({
      workDir,
      compactState: compactStateForRecommendHandoff(compact),
    });
    withCanonicalDecisionEnvelopeToolName(response as LooseObject);
    if (boolOption(args.operatorChecklist ?? args.operator_checklist, false)) {
      const action = (response.action || {}) as LooseObject;
      const canonicalNextAction = (compact.canonicalNextAction || {}) as LooseObject;
      return {
        ...response,
        operatorChecklist: buildOperatorChecklist(action, {
          workDir,
          pluginRoot: PLUGIN_ROOT,
          primaryCommand: (response.commands as LooseObject)?.primary,
          loopContract: (response.loopContract || null) as LooseObject | null,
          source: recommendNextChecklistSource(
            action,
            canonicalNextAction,
            (response.loopContract || null) as LooseObject | null,
          ),
        }),
      };
    }
    return response;
  }
  const viewModel = await dashboardViewModel(workDir, config, {
    deliveryMode: "cli",
    sourceCwd: workDir,
    pluginVersion: PLUGIN_VERSION,
  });
  const compact: LooseObject = await publicState({ cwd: workDir, compact: true, readCache });
  const authority = selectRecommendNextRuntimeAuthority({ viewModel, compact }) as LooseObject;
  const canonicalNextAction = authority.canonicalNextAction || null;
  const action = canonicalNextAction
    ? canonicalActionForRecommendNext(
        canonicalNextAction,
        viewModel.nextBestAction,
        compact.commands,
      )
    : ((viewModel.nextBestAction || {}) as LooseObject);
  const nextAction =
    canonicalNextAction?.reason ||
    action.detail ||
    viewModel.readout?.nextAction ||
    compact.nextAction;
  const baseEnvelope = authority.decisionEnvelope || null;
  const decisionEnvelope = baseEnvelope
    ? {
        ...baseEnvelope,
        finalizationReadiness: viewModel.finalizePreview
          ? {
              available: true,
              ready: viewModel.finalizePreview.ready === true,
              productGradeReady: viewModel.finalizePreview.productGradeReady !== false,
              productGradeIssue: viewModel.finalizePreview.productGradeIssue || null,
              nextAction: viewModel.finalizePreview.nextAction || "",
              warnings: viewModel.finalizePreview.warnings || [],
            }
          : baseEnvelope.finalizationReadiness,
        nextAction,
        canonicalNextAction: action.kind
          ? {
              ...baseEnvelope.canonicalNextAction,
              ...canonicalNextAction,
              command: action.command || canonicalNextAction?.command || "",
            }
          : baseEnvelope.canonicalNextAction,
      }
    : null;
  const loopContract = decisionEnvelope?.loopContract || authority.loopContract || null;
  const operatorChecklist = boolOption(args.operatorChecklist ?? args.operator_checklist, false)
    ? buildOperatorChecklist(action, {
        workDir,
        pluginRoot: PLUGIN_ROOT,
        loopContract,
        source: recommendNextChecklistSource(action, canonicalNextAction, loopContract),
      })
    : undefined;
  return buildRecommendNextResponse({
    ok: true,
    workDir,
    action,
    nextAction,
    whySafe:
      action.explanation?.evidence ||
      action.utilityCopy ||
      "Derived from state, doctor warnings, ASI memory, and dashboard trust state.",
    avoids:
      action.explanation?.avoids ||
      "Avoids running a packet before setup, stale-last-run, or trust blockers are resolved.",
    proof:
      action.explanation?.proof || "The next command should update state or clear the blocker.",
    blockers: viewModel.trustBlockers || compact.blockers || [],
    commands: {
      primary: action.command || action.primaryCommand?.command || "",
      ...compact.commands,
    },
    nextStep:
      viewModel.guidedSetup?.nextStep || recommendedActionNextStep(action, viewModel, compact),
    compactState: boolOption(args.compact, false) ? compact : undefined,
    resumeAudit: decisionEnvelope,
    decisionEnvelope,
    operatorChecklist,
    runtimeProvenance: authority.runtimeProvenance,
    loopContract,
    approvalLedger: compact.approvalLedger,
    resourcePreflight: compact.resourcePreflight,
    evidenceMaturity: compact.evidenceMaturity,
    laneOrchestration: compact.laneOrchestration,
    finalizationRunway: compact.finalizationRunway,
    operatorReadout: compact.operatorReadout || decisionEnvelope?.operatorReadout || null,
    laneLifecycle: compact.laneLifecycle,
    packetDiagnostics: compact.packetDiagnostics,
    portfolioRecommendation: compact.portfolioRecommendation,
    sessionDecisionCapsule:
      decisionEnvelope?.sessionDecisionCapsule || compact.sessionDecisionCapsule || null,
  });
}

function withCanonicalDecisionEnvelopeToolName(response: LooseObject): LooseObject {
  const action = compactRecord(compactRecord(response.decisionEnvelope)?.canonicalNextAction);
  if (action && !action.toolName) {
    action.toolName = guidedToolNameForCanonicalKind(String(action.kind || ""));
  }
  return response;
}

function compactStateForRecommendHandoff(compact: LooseObject): LooseObject {
  const envelope = compactRecord(compact.decisionEnvelope) || compactRecord(compact.resumeAudit);
  const envelopeCanonical = compactRecord(envelope?.canonicalNextAction);
  const compactCanonical = compactRecord(compact.canonicalNextAction);
  const canonicalNextAction =
    envelopeCanonical && compactCanonical && envelopeCanonical.kind === compactCanonical.kind
      ? { ...envelopeCanonical, command: envelopeCanonical.command || compactCanonical.command }
      : envelopeCanonical || compactCanonical;
  const sessionDecisionCapsule = compactSessionCapsuleForHandoff(
    compact.sessionDecisionCapsule || envelope?.sessionDecisionCapsule,
  );
  const minimalEnvelope = envelope
    ? {
        activeSegment: envelope.activeSegment || null,
        nextAction: envelope.nextAction || compact.nextAction || "",
        canonicalNextAction: canonicalNextAction || envelope.canonicalNextAction || null,
        finalizationReadiness: envelope.finalizationReadiness || null,
        latestPacketFreshness: envelope.latestPacketFreshness || null,
        loopContract: envelope.loopContract || compact.loopContract || null,
        sessionDecisionCapsule: compactSessionCapsuleIdentity(sessionDecisionCapsule),
        watchdog: envelope.watchdog || compact.watchdogSummary || null,
      }
    : null;
  return {
    ok: compact.ok,
    workDir: compact.workDir,
    name: compact.name,
    goal: compact.goal,
    metric: compact.metric,
    direction: compact.direction,
    segment: compact.segment,
    runs: compact.runs,
    kept: compact.kept,
    discarded: compact.discarded,
    measured: compact.measured,
    baseline: compact.baseline,
    best: compact.best,
    historicalBest: compact.historicalBest,
    developmentBest: compact.developmentBest,
    promotionBest: compact.promotionBest,
    goalFrame: compact.goalFrame,
    goalContract: compact.goalContract,
    operatorHandoff: compact.operatorHandoff,
    canonicalNextAction,
    nextAction: compact.nextAction,
    blockers: compact.blockers,
    commands: compactRecommendCommands(compactRecord(compact.commands), canonicalNextAction),
    decisionEnvelope: minimalEnvelope,
    sessionDecisionCapsule,
    portfolioRecommendation: compact.portfolioRecommendation,
    approvalLedger: compact.approvalLedger,
    resourcePreflight: compact.resourcePreflight,
    evidenceMaturity: compact.evidenceMaturity,
    laneOrchestration: compact.laneOrchestration,
    finalizationRunway: compact.finalizationRunway,
    operatorReadout: compact.operatorReadout,
    workflowFriction: compact.workflowFriction,
  };
}

function compactRecommendCommands(
  commands: LooseObject | null,
  canonicalNextAction: LooseObject | null,
): LooseObject {
  if (!commands) return {};
  const compactCommands: LooseObject = {};
  const primary = canonicalNextAction?.command || commands.stateCompact || commands.state;
  if (primary) compactCommands.primary = primary;
  if (commands.stateCompact) compactCommands.stateCompact = commands.stateCompact;
  if (commands.state) compactCommands.state = commands.state;
  return compactCommands;
}

function compactRecord(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

function compactSessionCapsuleForHandoff(value: unknown): LooseObject | null {
  const capsule = compactRecord(value);
  if (!capsule) return null;
  const enforcement = compactRecord(capsule.enforcement);
  return {
    kind: capsule.kind || null,
    status: capsule.status || null,
    enforcement: enforcement
      ? {
          mode: enforcement.mode || null,
          canRunNextPacket: enforcement.canRunNextPacket ?? null,
          allowBoundedNext: enforcement.allowBoundedNext ?? null,
          blocksFinalization: enforcement.blocksFinalization ?? null,
          commandHint: enforcement.commandHint || "",
          triggeredBy: enforcement.triggeredBy || [],
        }
      : null,
    evidence: Array.isArray(capsule.evidence) ? capsule.evidence.slice(0, 3) : [],
    nextExperiment: capsule.nextExperiment || "",
    wrongNextActions: Array.isArray(capsule.wrongNextActions)
      ? capsule.wrongNextActions.slice(0, 3)
      : [],
    doNotRepeat: Array.isArray(capsule.doNotRepeat) ? capsule.doNotRepeat.slice(0, 3) : [],
    commandBudgetWarnings: Array.isArray(capsule.commandBudgetWarnings)
      ? capsule.commandBudgetWarnings.slice(0, 3)
      : [],
  };
}

function compactSessionCapsuleIdentity(capsule: LooseObject | null): LooseObject | null {
  if (!capsule) return null;
  return {
    kind: capsule.kind || null,
    status: capsule.status || null,
    enforcement: capsule.enforcement
      ? {
          canRunNextPacket: (capsule.enforcement as LooseObject).canRunNextPacket ?? null,
          blocksFinalization: (capsule.enforcement as LooseObject).blocksFinalization ?? null,
          commandHint: (capsule.enforcement as LooseObject).commandHint || "",
        }
      : null,
  };
}

function recommendNextChecklistSource(
  action: LooseObject,
  canonicalNextAction: LooseObject | null,
  loopContract: LooseObject | null,
) {
  const actionSource = String(action.source || "");
  return (
    (actionSource === "decision-envelope" ? "" : actionSource) ||
    String(canonicalNextAction?.triggeredBy || "") ||
    String(loopContract?.strongestAction?.triggeredBy || "") ||
    actionSource ||
    "recommend-next"
  );
}

function canonicalActionForRecommendNext(
  canonical: LooseObject,
  existing: unknown,
  commands: unknown,
): LooseObject {
  const base = existing && typeof existing === "object" ? (existing as LooseObject) : {};
  const command = resolveActionCommand(canonical.kind, commands, {
    explicitCommand: canonical.command,
  });
  return {
    ...base,
    kind: canonical.kind || base.kind || "next-packet",
    priority: String(canonical.priority ?? base.priority ?? "Next"),
    title: actionTitleForKind(canonical.kind, String(base.title || "Next action")),
    detail: canonical.reason || base.detail || "",
    utilityCopy: base.utilityCopy || "Decision envelope is the authoritative next-action source.",
    safeAction:
      base.safeAction || actionSafeActionForKind(canonical.kind, String(canonical.kind || "")),
    command,
    primaryCommand: command ? { label: "Run", command } : base.primaryCommand || null,
    source: "decision-envelope",
  };
}

async function codexGoalBrief(args: LooseObject): Promise<LooseObject> {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = await publicState({ cwd: workDir, compact: false, readCache: args.readCache });
  const compact = compactPublicState(state);
  const commands = continuationCommands(workDir);
  const importedGoal = importedCodexGoal(args);
  const objectiveDraft = codexGoalObjectiveDraft(state, importedGoal);
  const completionAudit = codexGoalCompletionAudit({
    args,
    compact,
    importedGoal,
    state,
  });
  return {
    ok: true,
    kind: "codex-autoresearch-goal-bridge",
    workDir,
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
      decisionEnvelope: state.decisionEnvelope || state.resumeAudit || null,
    },
    settings: {
      autonomyMode: config.autonomyMode || "guarded",
      maxIterations: state.limit?.maxIterations ?? null,
    },
  };
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
  importedGoal,
  state,
}: LooseObject): LooseObject {
  const completionEvidence = String(
    args.completionEvidence || args.completion_evidence || "",
  ).trim();
  const completionConfirmed = boolOption(
    args.completionConfirmed ?? args.completion_confirmed,
    false,
  );
  const evidenceBlockers = [
    ...(Array.isArray(compact.blockers) ? compact.blockers : []),
    ...(Array.isArray(state.researchIntegrity?.notPromotableBecause)
      ? state.researchIntegrity.notPromotableBecause
      : []),
    ...(Array.isArray(state.decisionEnvelope?.researchIntegrity?.notPromotableBecause)
      ? state.decisionEnvelope.researchIntegrity.notPromotableBecause
      : []),
  ].filter(Boolean);
  const limitReached = compact.limitReached === true;
  const finalizationReady = state.decisionEnvelope?.finalizationReadiness?.ready === true;
  const qualityRound = state.decisionEnvelope?.qualityRound || {};
  const completionRequested = completionConfirmed && Boolean(completionEvidence);
  const blockers = [
    ...new Set([
      ...evidenceBlockers.map((blocker) => String(blocker)),
      ...goalCompletionUnresolvedBlockers({
        completionClaimed: completionRequested,
        blockers: evidenceBlockers,
        finalizationReadiness: state.decisionEnvelope?.finalizationReadiness,
        preflight: state.preflight,
        qualityRound,
        warningDetails: state.warningDetails,
        workflowFriction:
          state.workflowFriction ||
          state.decisionEnvelope?.workflowFriction ||
          compact.workflowFriction,
      }),
    ]),
  ];
  const importedGoalCompletable = importedGoal?.status === "active";
  const hasMeasuredEvidence =
    Number(state.runs) > 0 &&
    (state.best != null || state.development?.best != null || state.promotion?.best != null);
  const hasLocalCompletionEvidence =
    hasMeasuredEvidence || finalizationReady || (qualityRound.active && qualityRound.done === true);
  const completionBlockingIssues = blockers.filter(
    (blocker) =>
      !/finalize-current-tree|current non-session branch diff/i.test(blocker) &&
      !/No benchmark command is available for future packets/i.test(blocker),
  );
  let status = "active";
  if (importedGoal?.status === "budget_limited" || limitReached) {
    status = "budget_limited";
  } else if (compact.requiresLogDecision) {
    status = "pending_log_decision";
  } else if (completionRequested && !importedGoal) {
    status = "no_codex_goal_imported";
  } else if (completionRequested && !importedGoalCompletable) {
    status = "codex_goal_not_active";
  } else if (
    completionRequested &&
    hasLocalCompletionEvidence &&
    completionBlockingIssues.length === 0
  ) {
    status = "complete";
  } else if (blockers.length) {
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

function recommendedActionNextStep(
  action: LooseObject,
  viewModel: LooseObject,
  compact: LooseObject,
) {
  const kind = String(action.kind || action.safeAction || "");
  const stage = kind.includes("finalize")
    ? "finalization-preview"
    : kind.includes("segment")
      ? "segment-reset"
      : kind.includes("log")
        ? "log-decision"
        : kind.includes("serve") || kind.includes("dashboard")
          ? "dashboard-serve"
          : kind.includes("doctor")
            ? "doctor"
            : (viewModel.trustBlockers || compact.blockers || []).length
              ? "blocker"
              : "baseline-packet";
  return sharedNextStep({
    stage,
    title: action.title || "Run next safe action",
    reason: action.detail || viewModel.readout?.nextAction || compact.nextAction,
    command: action.command || action.primaryCommand?.command || "",
    toolName:
      stage === "log-decision"
        ? "log_experiment"
        : stage === "finalization-preview"
          ? "finalize_preview"
          : stage === "segment-reset"
            ? "new_segment"
            : stage === "doctor"
              ? "doctor_session"
              : stage === "blocker"
                ? ""
                : "next_experiment",
    safety:
      stage === "log-decision" ? "git_mutation" : stage === "blocker" ? "read" : "process_start",
  });
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

function replacementNextCommandFromLastRun(
  workDir: string,
  packet: any,
  defaultBenchmarkCommandReady: boolean,
) {
  const argv = [
    "node",
    path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
    "next",
    "--cwd",
    workDir,
  ];
  const command = packet?.history?.replayCommand || packet?.run?.command;
  if (command) {
    argv.push("--command", command);
  } else if (!defaultBenchmarkCommandReady) {
    return "";
  }
  const checksPolicy = packet?.run?.checksPolicy;
  if (CHECKS_POLICIES.has(checksPolicy)) {
    argv.push("--checks-policy", checksPolicy);
  }
  const checksCommand = packet?.history?.replayChecksCommand || packet?.run?.checks?.command;
  if (checksCommand) {
    argv.push("--checks-command", checksCommand);
  }
  return commandLine(argv);
}

async function replacementNextCommandForLastRun(
  workDir: string,
  packet: any,
  defaultBenchmarkCommandReady?: boolean,
) {
  if (!packet) return "";
  const defaultReady =
    typeof defaultBenchmarkCommandReady === "boolean"
      ? defaultBenchmarkCommandReady
      : await defaultBenchmarkCommandExists(workDir);
  return replacementNextCommandFromLastRun(workDir, packet, defaultReady);
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
    "Reserve one packet for a distant-scout lane before repeating the same near-neighbor tweak.",
    "If a promotion-grade packet has no decision row, log it as benchmark coverage work rather than a candidate regression.",
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
    "Use these commands to pick the loop back up without rediscovering state:",
    "",
    "```bash",
    `node ${script} state --cwd ${cwd}`,
    `node ${script} doctor --cwd ${cwd} --check-benchmark`,
    `node ${script} next --cwd ${cwd}`,
    `node ${script} log --cwd ${cwd} --from-last --status keep --description "Describe the kept change"`,
    `node ${script} export --cwd ${cwd}`,
    "```",
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

function metricParseSource(result: any) {
  if (!result) return "";
  const retained = result.retainedMetricOutput || "";
  if (result.metricOutput) {
    return [
      result.metricOutput,
      result.metricOutputTruncated && result.fullOutput ? result.fullOutput : "",
      retained,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [result.fullOutput || result.output || "", retained].filter(Boolean).join("\n");
}

function parseArtifactLines(output: string, workDir: string) {
  const artifacts: Record<string, string> = {};
  const artifactWarnings: string[] = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^ARTIFACT\s+([A-Za-z_][A-Za-z0-9_.:-]*)=(.+)$/);
    if (!match) continue;
    const name = match[1];
    const value = match[2].trim();
    if (!value) continue;
    const resolved = resolvePathInsideRootSync(workDir, value);
    if (resolved.inside && resolved.relativePath) {
      artifacts[name] = resolved.relativePath;
    } else {
      artifacts[name] = "<outside-workdir>";
      artifactWarnings.push(
        `ARTIFACT ${name} points outside the working directory and was quarantined: ${redactPathDisplay(value, workDir)}.`,
      );
    }
  }
  return { artifacts, artifactWarnings };
}

function headText(
  text: string,
  maxLines: any = OUTPUT_MAX_LINES,
  maxBytes: number = OUTPUT_MAX_BYTES,
) {
  let trimmed = text;
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    const buf = Buffer.from(trimmed, "utf8");
    trimmed = buf.subarray(0, maxBytes).toString("utf8");
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > maxLines) trimmed = lines.slice(0, maxLines).join("\n");
  return trimmed;
}

async function defaultBenchmarkCommand(workDir: string) {
  const powershellScript = await pathExists(path.join(workDir, "autoresearch.ps1"));
  const bashScript = await pathExists(path.join(workDir, "autoresearch.sh"));
  if (process.platform !== "win32" && bashScript) {
    return "bash ./autoresearch.sh";
  }
  if (powershellScript) {
    return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
  }
  if (bashScript) {
    return "bash ./autoresearch.sh";
  }
  throw new Error(
    "No command provided; expected autoresearch.ps1 or autoresearch.sh in the work directory.",
  );
}

async function defaultBenchmarkCommandExists(workDir: string) {
  return (
    (await pathExists(path.join(workDir, "autoresearch.ps1"))) ||
    (await pathExists(path.join(workDir, "autoresearch.sh")))
  );
}

async function benchmarkCommandFromArgs(
  args: LooseObject,
  workDir: string,
  config: LooseObject = readConfig(workDir),
) {
  const commandSource = await resolveBenchmarkCommandSource(args, workDir, {
    fallbackToDefault: true,
    requireCommand: true,
    config,
  });
  const envFile = args.packet_env_file ?? args.packetEnvFile ?? args.env_file ?? args.envFile;
  const env = envFile ? await readEnvFile(envFile, workDir) : null;
  const packetEnvMode = packetEnvModeFromArgs(args);
  return {
    command: commandSource.command,
    env: env?.values || undefined,
    packetEnvMode,
    commandFile: commandSource.commandFile,
    envFile: env?.path || "",
    explicitEnvKeys: env
      ? Object.keys(env.values).sort((a: any, b: any) => a.localeCompare(b))
      : [],
    envKeys: env ? Object.keys(env.values).sort((a: any, b: any) => a.localeCompare(b)) : [],
    separatorCommand: commandSource.separatorCommand,
  };
}

function packetEnvModeFromArgs(args: LooseObject): "inherit" | "minimal" {
  return (
    enumOption(
      args.packet_env_mode ?? args.packetEnvMode,
      new Set(["inherit", "minimal"]),
      "minimal",
      "packetEnvMode",
    ) || "minimal"
  );
}

async function resolveBenchmarkCommandSource(
  args: LooseObject,
  workDir: string,
  options: { fallbackToDefault?: boolean; requireCommand?: boolean; config?: LooseObject } = {},
) {
  const commandFile = args.command_file ?? args.commandFile;
  if (args.command && commandFile) {
    throw new Error("Use either --command or --command-file, not both.");
  }
  const separatorCommand = !args.command && Array.isArray(args._) && args._.length > 1;
  if (args.command) {
    return {
      command: normalizePowerShellEscapedCommandArg(args.command),
      commandFile: "",
      separatorCommand: false,
      source: "command",
      missingReason: "",
    };
  }
  if (separatorCommand) {
    return {
      command: args._.slice(1).join(" "),
      commandFile: "",
      separatorCommand: true,
      source: "separator",
      missingReason: "",
    };
  }
  if (commandFile) {
    return {
      command: await readCommandFile(commandFile, workDir),
      commandFile: resolveOptionPath(commandFile, workDir),
      separatorCommand: false,
      source: "command-file",
      missingReason: "",
    };
  }
  const configuredCommand =
    typeof options.config?.benchmarkCommand === "string"
      ? options.config.benchmarkCommand.trim()
      : "";
  if (configuredCommand) {
    return {
      command: normalizePowerShellEscapedCommandArg(configuredCommand),
      commandFile: "",
      separatorCommand: false,
      source: "config",
      missingReason: "",
    };
  }
  if (options.fallbackToDefault) {
    try {
      return {
        command: await defaultBenchmarkCommand(workDir),
        commandFile: "",
        separatorCommand: false,
        source: "default",
        missingReason: "",
      };
    } catch (error: unknown) {
      if (options.requireCommand) throw error;
      return {
        command: "",
        commandFile: "",
        separatorCommand: false,
        source: "missing",
        missingReason: missingBenchmarkCommandMessage(error),
      };
    }
  }
  return {
    command: "",
    commandFile: "",
    separatorCommand: false,
    source: "missing",
    missingReason: "",
  };
}

function missingBenchmarkCommandMessage(error: unknown = null): string {
  const detail = error ? errorMessage(error) : "";
  if (/No command provided/i.test(detail)) {
    return "No benchmark command was provided and no autoresearch script was found.";
  }
  return detail || "No benchmark command was provided and no autoresearch script was found.";
}

function allowFixedControlRerun(args: LooseObject): boolean {
  return boolOption(args.allow_fixed_control_rerun ?? args.allowFixedControlRerun, false);
}

type FixedControlBlock = {
  code: FixedControlViolation["code"];
  commandHint: string;
  fixedControlViolation: ReturnType<typeof fixedControlViolationSummary>;
  issue: string;
  message: string;
};

function fixedControlBlockForCommand(
  command: unknown,
  config: LooseObject,
  args: LooseObject = {},
): FixedControlBlock | null {
  const violation = fixedControlViolationForCommand(
    command,
    normalizeFixedControlConfig(config.fixedControl),
  );
  if (!violation || allowFixedControlRerun(args)) return null;
  const summary = fixedControlViolationSummary(violation);
  const message = summary?.message || violation.message;
  return {
    code: violation.code,
    commandHint: summary?.reuseCommandHint || "",
    fixedControlViolation: summary,
    issue: `${violation.code}: ${message}`,
    message,
  };
}

function fixedControlRerunError(block: FixedControlBlock): Error {
  const error = new Error(block.message);
  (error as Error & { code?: string; fixedControlViolation?: unknown }).code = block.code;
  (error as Error & { fixedControlViolation?: unknown }).fixedControlViolation =
    block.fixedControlViolation;
  return error;
}

function fixedControlBlockedDoctorSummary(doctor: LooseObject): LooseObject {
  return redactEvidenceObject({
    ok: doctor.ok === true,
    workDir: doctor.workDir || "",
    issues: Array.isArray(doctor.issues) ? doctor.issues.slice(0, 10) : [],
    warnings: Array.isArray(doctor.warnings) ? doctor.warnings.slice(0, 10) : [],
    nextAction: typeof doctor.nextAction === "string" ? doctor.nextAction : "",
  }) as LooseObject;
}

function resolveOptionPath(filePath: string, workDir: string) {
  const input = String(filePath || "").trim();
  return path.isAbsolute(input) ? input : path.resolve(workDir, input);
}

async function readCommandFile(filePath: string, workDir: string) {
  const resolved = resolveOptionPath(filePath, workDir);
  const text = (await fsp.readFile(resolved, "utf8")).trim();
  if (!text) throw new Error(`--command-file is empty: ${resolved}`);
  return text;
}

async function readEnvFile(filePath: string, workDir: string) {
  const resolved = resolveOptionPath(filePath, workDir);
  const text = await fsp.readFile(resolved, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return { path: resolved, values: {} };
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`--env-file JSON must be an object: ${resolved}`);
    }
    return {
      path: resolved,
      values: Object.fromEntries(
        Object.entries(parsed).map(([key, value]: [string, unknown]) => [
          validateEnvName(key),
          String(value ?? ""),
        ]),
      ),
    };
  }
  const values: Record<string, string> = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`Invalid --env-file line ${index + 1}: expected NAME=value.`);
    values[validateEnvName(match[1])] = unquoteEnvValue(match[2].trim());
  }
  return { path: resolved, values };
}

function validateEnvName(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""))) {
    throw new Error(`Invalid environment variable name in --env-file: ${name}`);
  }
  return String(name);
}

function unquoteEnvValue(value: any) {
  const text = String(value ?? "");
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

async function defaultChecksCommand(workDir: string) {
  if (await pathExists(path.join(workDir, "autoresearch.checks.ps1"))) {
    return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.checks.ps1";
  }
  if (await pathExists(path.join(workDir, "autoresearch.checks.sh"))) {
    return "bash ./autoresearch.checks.sh";
  }
  return null;
}

function checksPolicyFromArgs(args: any, config: any) {
  return enumOption(
    args.checks_policy ?? args.checksPolicy ?? config.checksPolicy,
    CHECKS_POLICIES,
    "always",
    "checksPolicy",
  );
}

function shouldRunChecks(policy: any, context: any) {
  if (!context.benchmarkPassed || !context.primaryPresent || !context.checksCommand) return false;
  if (policy === "always") return true;
  if (policy === "on-improvement") return context.improvesPrimary || context.explicitChecksCommand;
  return context.explicitChecksCommand;
}

async function runProcess(
  command: string,
  args: any,
  cwd: string,
  options: LooseObject = {},
): Promise<LocalProcessResult> {
  const result = await runBoundedProcess(command, args, {
    cwd,
    maxOutputBytes: options.maxOutputBytes,
    timeoutSeconds: options.timeoutMs ? Math.max(1, Number(options.timeoutMs) / 1000) : 600,
  });
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}

async function git(args: any, cwd: string): Promise<LocalProcessResult> {
  return await runProcess("git", args, cwd, { maxOutputBytes: 16 * 1024 * 1024 });
}

function gitOutput(result: any, fallback: any) {
  return (result.stderr || result.stdout || fallback || "").trim();
}

async function insideGitRepo(cwd: string) {
  if (!hasGitMarker(cwd)) return false;
  const result = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.code === 0 && result.stdout.trim() === "true";
}

function hasGitMarker(cwd: string): boolean {
  let current = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function gitPrivatePath(cwd: string, relativePath: string) {
  const result = await git(["rev-parse", "--git-path", relativePath], cwd);
  if (result.code !== 0)
    throw new Error(`Git path lookup failed: ${gitOutput(result, "unknown error")}`);
  const filePath = result.stdout.trim();
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

async function gitPrivateRoot(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--git-dir"], cwd);
  if (result.code !== 0) {
    throw new Error(`Git directory lookup failed: ${gitOutput(result, "unknown error")}`);
  }
  const gitDir = result.stdout.trim();
  return path.isAbsolute(gitDir) ? path.resolve(gitDir) : path.resolve(cwd, gitDir);
}

async function privateStateWriteRoot(workDir: string, target: string): Promise<string> {
  if (!(await insideGitRepo(workDir).catch(() => false))) return workDir;
  const gitRoot = await gitPrivateRoot(workDir);
  if (!isPathInside(gitRoot, target)) {
    throw new Error(`Git-private state path escapes the Git directory: ${target}`);
  }
  return gitRoot;
}

function fallbackPendingLogTransactionPath(workDir: string) {
  return resolveSessionPaths({ workDir }).pendingLogTransactionFallbackPath;
}

async function pendingLogTransactionPath(workDir: string, inGit?: boolean) {
  const gitRepo = inGit ?? (await insideGitRepo(workDir).catch(() => false));
  if (gitRepo) {
    return await gitPrivatePath(workDir, PENDING_LOG_TRANSACTION_GIT_PATH);
  }
  return fallbackPendingLogTransactionPath(workDir);
}

async function pendingLogTransactionCandidatePaths(workDir: string, inGit?: boolean) {
  const candidates = [fallbackPendingLogTransactionPath(workDir)];
  const gitRepo = inGit ?? (await insideGitRepo(workDir).catch(() => false));
  if (gitRepo) {
    try {
      candidates.unshift(await gitPrivatePath(workDir, PENDING_LOG_TRANSACTION_GIT_PATH));
    } catch {
      // Fall back to the workspace marker below when Git cannot resolve its private path.
    }
  }
  return [...new Set(candidates)];
}

async function writePendingLogTransaction(workDir: string, inGit: boolean, receipt: LooseObject) {
  const receiptPath = await pendingLogTransactionPath(workDir, inGit);
  await checkedAtomicWriteFile(
    inGit ? await gitPrivateRoot(workDir) : workDir,
    receiptPath,
    `${JSON.stringify(
      {
        type: "autoresearch.log.pending",
        version: 1,
        createdAt: new Date().toISOString(),
        workDir,
        ledgerPath: resolveSessionPaths({ workDir }).ledgerPath,
        ...receipt,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return receiptPath;
}

async function pendingLogTransactionWarnings(workDir: string, inGit?: boolean) {
  const warnings = [];
  for (const receiptPath of await pendingLogTransactionCandidatePaths(workDir, inGit)) {
    if (!(await pathExists(receiptPath))) continue;
    warnings.push({
      code: PENDING_LOG_TRANSACTION_CODE,
      severity: "blocker",
      message:
        "A previous log mutation has a pending receipt and may not be recorded in autoresearch.jsonl; inspect the receipt before another packet.",
      action:
        "Compare the receipt with git status and autoresearch.jsonl, then remove the receipt after recovery.",
      path: receiptPath,
      paths: [receiptPath],
    });
  }
  return warnings;
}

async function assertNoGitIndexLock(workDir: string, phase: string = "git operation") {
  const lockPath = await gitPrivatePath(workDir, "index.lock");
  if (!(await pathExists(lockPath))) return;
  throw new Error(await gitIndexLockMessage(workDir, lockPath, phase, false));
}

function gitIndexLockFailure(result: any) {
  return /index\.lock|another git process|Unable to create/i.test(gitOutput(result, ""));
}

async function gitIndexLockMessage(
  workDir: string,
  lockPath: string,
  phase: string,
  stagedMayHaveChanged: boolean,
) {
  const liveGit = await liveGitProcessSummary(workDir);
  return [
    `Git index lock blocked ${phase}: ${lockPath}.`,
    `Live git process check: ${liveGit}.`,
    stagedMayHaveChanged
      ? "Autoresearch could not prove whether staging partially changed; inspect git status before retrying."
      : "Autoresearch has not staged or committed anything for this log attempt.",
    "Wait for active Git commands to finish, then retry. If no Git process is active, remove the index.lock file and rerun the exact log command.",
  ].join(" ");
}

async function liveGitProcessSummary(workDir: string) {
  try {
    const result =
      process.platform === "win32"
        ? await runProcess(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              "Get-Process git -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
            ],
            workDir,
            { timeoutMs: 2000 },
          )
        : await runProcess("pgrep", ["-fl", "git"], workDir, { timeoutMs: 2000 });
    const outputText = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    if (!outputText) return "no live git process found";
    return outputText.split(/\r?\n/).slice(0, 5).join(", ");
  } catch (error) {
    return `process check unavailable (${errorMessage(error)})`;
  }
}

function normalizePowerShellEscapedCommandArg(command: unknown): string {
  const text = String(command);
  if (process.platform !== "win32" || !/^\\".+?\\"(?:\s|$)/.test(text)) return text;
  return text.replace(/\\"/g, '"');
}

async function shortHead(cwd: string) {
  const result = await git(["rev-parse", "--short=7", "HEAD"], cwd);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function resolveCommitRef(cwd: string, commit: any) {
  const value = String(commit || "").trim();
  if (!value) throw new Error("commit is required");
  const result = await git(["rev-parse", "--verify", `${value}^{commit}`], cwd);
  if (result.code !== 0)
    throw new Error(`Git commit could not be resolved: ${gitOutput(result, value)}`);
  return result.stdout.trim();
}

async function hasStagedChanges(cwd: string) {
  const result = await git(["diff", "--cached", "--quiet"], cwd);
  return result.code === 1;
}

async function hasStagedChangesInPaths(cwd: string, paths: string[]) {
  const result = await git(
    ["--literal-pathspecs", "diff", "--cached", "--quiet", "--", ...paths],
    cwd,
  );
  return result.code === 1;
}

async function gitDirtyPathDetails(cwd: string) {
  if (!(await insideGitRepo(cwd))) return [];
  const result = await git(["status", "--porcelain=v1", "-z", "-uall"], cwd);
  if (result.code !== 0)
    throw new Error(`Git status failed: ${gitOutput(result, "unknown error")}`);
  assertCompleteGitPathOutput(result);
  return parsePorcelainV1Z(result.stdout).flatMap((entry) =>
    entry.paths.map((gitPath) => ({
      status: entry.status,
      path: gitPath,
      raw: `${entry.status} ${displayGitPath(gitPath)}`,
    })),
  );
}

function isAutoresearchOwnedDirtyPath(relativePath: string) {
  const normalized = relativePath;
  return (
    SESSION_FILES.includes(normalized) ||
    AUTORESEARCH_OWNED_FILES.includes(normalized) ||
    AUTORESEARCH_OWNED_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))
  );
}

function emptyCommitPathsWarning() {
  return {
    code: EMPTY_COMMIT_PATHS_WARNING_CODE,
    severity: "warning",
    message:
      "Kept runs will not auto-commit because commitPaths is empty. Configure commitPaths, pass --commit-paths, or use --allow-add-all explicitly.",
    action:
      "Configure commitPaths for the experiment surface before logging kept changes, or use --allow-add-all when broad staging is intentional.",
  };
}

function shouldWarnEmptyCommitPaths({
  inGit,
  commitPaths = [],
  explicitCommit = false,
  allowAddAll = false,
}: LooseObject = {}) {
  return Boolean(inGit && !explicitCommit && !allowAddAll && commitPaths.length === 0);
}

async function assertCommitPathsExist(workDir: string, commitPaths: any[]) {
  const missing: string[] = [];
  for (const relative of commitPaths) {
    if (await pathExists(path.join(workDir, relative))) continue;
    if (await gitPathIsTracked(workDir, relative)) continue;
    missing.push(relative);
  }
  if (!missing.length) return;
  const remaining = commitPaths.filter((item: any) => !missing.includes(item));
  throw new Error(
    [
      `Configured commitPaths do not exist before git add: ${missing.slice(0, 8).join(", ")}.`,
      remaining.length
        ? `Repair with: node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} config --cwd ${shellQuote(workDir)} --commit-paths ${shellQuote(remaining.join(","))}`
        : "Repair by configuring commitPaths that exist or by passing --commit-paths for this log.",
      "No git add or commit was attempted.",
    ].join(" "),
  );
}

async function gitPathIsTracked(workDir: string, relativePath: string) {
  const result = await git(["--literal-pathspecs", "ls-files", "-z", "--", relativePath], workDir);
  return result.code === 0 && result.stdout.length > 0;
}

async function gitStatusShort(cwd: string) {
  const result = await git(["status", "--porcelain=v1", "-z", "-uall"], cwd);
  if (result.code !== 0)
    throw new Error(`Git status failed: ${gitOutput(result, "unknown error")}`);
  assertCompleteGitPathOutput(result);
  return result.stdout;
}

function assertCompleteGitPathOutput(result: LocalProcessResult) {
  if (result.stdoutTruncated) {
    throw new Error(
      "Git path output exceeded the capture limit; refusing an incomplete trust check.",
    );
  }
}

function hashText(value: any) {
  return createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

async function scopedFileFingerprints(
  workDir: string,
  paths: any[] = [],
  budget = { remaining: FINGERPRINT_TOTAL_BYTE_LIMIT },
) {
  const safePaths = normalizeRelativePaths(paths, "commitPaths");
  if (safePaths.length === 0) return [];
  const result = await git(["--literal-pathspecs", "ls-files", "-z", "--", ...safePaths], workDir);
  if (result.code !== 0) return [];
  assertCompleteGitPathOutput(result);
  const files = parseNulPathList(result.stdout).sort((a, b) => a.localeCompare(b));
  const fingerprints = [];
  for (const file of files) {
    if (fingerprints.length >= DIRECTORY_FINGERPRINT_ENTRY_LIMIT) {
      fingerprints.push({
        path: "<scoped-files>",
        truncated: true,
        reason: "scoped_file_entry_limit",
        maxEntries: DIRECTORY_FINGERPRINT_ENTRY_LIMIT,
        totalFiles: files.length,
      });
      break;
    }
    const filePath = path.join(workDir, file);
    try {
      const fingerprint = await hashFileWithBudget(filePath, budget);
      fingerprints.push({ path: file, ...fingerprint });
      if (fingerprint.truncated) break;
    } catch (error) {
      fingerprints.push({
        path: file,
        missing: true,
        error: errorCodeOrMessage(error),
      });
    }
  }
  return fingerprints;
}

function dirtyPathsFromStatus(statusShort: string) {
  return parsePorcelainV1Z(statusShort)
    .flatMap((entry) => entry.paths)
    .sort((a: any, b: any) => a.localeCompare(b));
}

async function fileFingerprintsForPaths(
  workDir: string,
  paths: any[] = [],
  budget = { remaining: FINGERPRINT_TOTAL_BYTE_LIMIT },
) {
  const fingerprints = [];
  const uniquePaths = [...new Set(paths)].sort((a: any, b: any) => a.localeCompare(b));
  for (const file of uniquePaths) {
    if (fingerprints.length >= DIRECTORY_FINGERPRINT_ENTRY_LIMIT) {
      fingerprints.push({
        path: "<dirty-files>",
        truncated: true,
        reason: "dirty_file_entry_limit",
        maxEntries: DIRECTORY_FINGERPRINT_ENTRY_LIMIT,
        totalFiles: uniquePaths.length,
      });
      break;
    }
    const filePath = path.join(workDir, file);
    try {
      const stats = await fsp.lstat(filePath);
      if (stats.isDirectory()) {
        const children = await directoryFingerprints(workDir, file, budget);
        fingerprints.push({ path: file, directory: true, files: children });
        continue;
      }
      if (stats.isSymbolicLink()) {
        fingerprints.push({ path: file, symlink: await fsp.readlink(filePath) });
        continue;
      }
      const fingerprint = await hashFileWithBudget(filePath, budget);
      fingerprints.push({ path: file, ...fingerprint });
      if (fingerprint.truncated) break;
    } catch (error) {
      fingerprints.push({
        path: file,
        missing: true,
        error: errorCodeOrMessage(error),
      });
    }
  }
  return fingerprints;
}

async function directoryFingerprints(
  workDir: string,
  rootPath: string,
  budget = { remaining: FINGERPRINT_TOTAL_BYTE_LIMIT },
) {
  const root = path.resolve(workDir, rootPath);
  const base = path.resolve(workDir);
  const relativeRoot = path.relative(base, root);
  if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) return [];
  const entries: LooseObject[] = [];
  let truncated = false;
  const markTruncated = (relativePath: string, reason: string) => {
    if (truncated) return;
    truncated = true;
    entries.push({
      path: relativePath,
      truncated: true,
      reason,
      maxDepth: DIRECTORY_FINGERPRINT_DEPTH_LIMIT,
      maxEntries: DIRECTORY_FINGERPRINT_ENTRY_LIMIT,
    });
  };
  async function visit(relativeDir: any, depth = 0) {
    if (truncated) return;
    if (depth > DIRECTORY_FINGERPRINT_DEPTH_LIMIT) {
      markTruncated(relativeDir, "directory_depth_limit");
      return;
    }
    const absoluteDir = path.join(workDir, relativeDir);
    const dirents = await fsp.readdir(absoluteDir, { withFileTypes: true });
    for (const dirent of dirents.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      if (entries.length >= DIRECTORY_FINGERPRINT_ENTRY_LIMIT) {
        markTruncated(relativeDir, "directory_entry_limit");
        return;
      }
      const relativePath = path.join(relativeDir, dirent.name).replace(/\\/g, "/");
      const absolutePath = path.join(workDir, relativePath);
      if (dirent.isDirectory()) {
        entries.push({ path: relativePath, directory: true });
        await visit(relativePath, depth + 1);
        if (truncated) return;
      } else if (dirent.isSymbolicLink()) {
        entries.push({ path: relativePath, symlink: await fsp.readlink(absolutePath) });
      } else if (dirent.isFile()) {
        const fingerprint = await hashFileWithBudget(absolutePath, budget);
        entries.push({
          path: relativePath,
          ...fingerprint,
        });
        if (fingerprint.truncated) {
          truncated = true;
          return;
        }
      } else {
        const stats = await fsp.lstat(absolutePath);
        entries.push({ path: relativePath, type: stats.isFIFO() ? "fifo" : "other" });
      }
    }
  }
  await visit(rootPath);
  return entries;
}

async function lastRunGitSnapshot(workDir: string, config: LooseObject = {}) {
  if (!(await insideGitRepo(workDir).catch(() => false))) return { inside: false };
  const scopedPaths = normalizeRelativePaths(config.commitPaths, "commitPaths");
  const statusShort = await gitStatusShort(workDir);
  const fingerprintBudget = { remaining: FINGERPRINT_TOTAL_BYTE_LIMIT };
  return {
    inside: true,
    head: await shortHead(workDir),
    dirty: Boolean(statusShort),
    statusHash: hashText(statusShort),
    scopedPaths,
    fileFingerprints: await scopedFileFingerprints(workDir, scopedPaths, fingerprintBudget),
    dirtyFileFingerprints: await fileFingerprintsForPaths(
      workDir,
      dirtyPathsFromStatus(statusShort),
      fingerprintBudget,
    ),
  };
}

async function hashFileWithBudget(
  filePath: string,
  budget: { remaining: number },
): Promise<LooseObject> {
  const stats = await fsp.stat(filePath);
  if (stats.size > budget.remaining) {
    return {
      truncated: true,
      reason: "fingerprint_byte_budget",
      maxBytes: FINGERPRINT_TOTAL_BYTE_LIMIT,
      size: stats.size,
    };
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const length = (chunk as Buffer).byteLength;
    if (length > budget.remaining) {
      return {
        truncated: true,
        reason: "fingerprint_byte_budget",
        maxBytes: FINGERPRINT_TOTAL_BYTE_LIMIT,
        size: Math.max(stats.size, bytes + length),
      };
    }
    budget.remaining -= length;
    bytes += length;
    hash.update(chunk as Buffer);
  }
  return { hash: hash.digest("hex"), size: bytes };
}

async function benchmarkContractSnapshot(workDir: string, context: LooseObject = {}) {
  const fixedFiles = [
    "autoresearch.sh",
    "autoresearch.ps1",
    "autoresearch.checks.sh",
    "autoresearch.checks.ps1",
    "autoresearch.config.json",
    "package.json",
    "Cargo.toml",
  ];
  const fingerprintBudget = { remaining: FINGERPRINT_TOTAL_BYTE_LIMIT };
  const fileFingerprints = [];
  for (const relative of fixedFiles) {
    const filePath = path.join(workDir, relative);
    if (!(await pathExists(filePath))) continue;
    fileFingerprints.push(
      await contractFileFingerprint(workDir, filePath, relative, fingerprintBudget),
    );
  }
  const command = String(context.command || "").trim();
  const checksCommand = String(context.checksCommand || "").trim();
  const normalizedCommand = command.replace(/\s+/g, " ");
  const normalizedChecksCommand = checksCommand.replace(/\s+/g, " ");
  const commandFile = contractPathLabel(workDir, context.commandFile);
  const envFile = contractPathLabel(workDir, context.envFile);
  const hasPacketEnvMode = Object.hasOwn(context, "packetEnvMode");
  const packetEnvMode = hasPacketEnvMode ? packetEnvModeFromArgs(context) : "";
  for (const [label, filePath] of [
    [commandFile, context.commandFile],
    [envFile, context.envFile],
  ]) {
    if (filePath) {
      fileFingerprints.push(
        await contractFileFingerprint(workDir, filePath, label, fingerprintBudget),
      );
    }
  }
  const contractSurface: LooseObject = {
    command: normalizedCommand,
    checksCommand: normalizedChecksCommand,
    commandFile,
    envFile,
    files: fileFingerprints,
  };
  if (hasPacketEnvMode) contractSurface.packetEnvMode = packetEnvMode;
  const surfaceHash = hashText(JSON.stringify(contractSurface));
  const snapshot: LooseObject = {
    command,
    checksCommand,
    commandFile,
    envFile,
    surfaceHash,
    files: fileFingerprints,
    fingerprintByteBudgetExceeded: fingerprintsContainReason(
      fileFingerprints,
      "fingerprint_byte_budget",
    ),
    capturedAt: new Date().toISOString(),
  };
  if (hasPacketEnvMode) snapshot.packetEnvMode = packetEnvMode;
  return snapshot;
}

async function contractFileFingerprint(
  workDir: string,
  filePath: string,
  label: any = "",
  budget: { remaining: number } = { remaining: FINGERPRINT_TOTAL_BYTE_LIMIT },
) {
  const resolved = resolveOptionPath(filePath, workDir);
  const display = label || contractPathLabel(workDir, resolved);
  try {
    const fingerprint = await hashFileWithBudget(resolved, budget);
    return {
      path: display,
      ...fingerprint,
    };
  } catch (error) {
    return {
      path: display,
      missing: true,
      error: errorCodeOrMessage(error),
    };
  }
}

function contractPathLabel(workDir: string, filePath: string) {
  const input = String(filePath || "").trim();
  if (!input) return "";
  const resolved = resolveOptionPath(input, workDir);
  const relative = path.relative(workDir, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : resolved;
}

function latestBenchmarkContractEntry(
  workDir: string,
  state: LooseObject | null | undefined,
): LooseObject | null {
  const fromState = latestBenchmarkContractEntryFromState(state);
  if (fromState) return fromState;
  try {
    const fromCurrentState = latestBenchmarkContractEntryFromState(currentState(workDir));
    if (fromCurrentState) return fromCurrentState;
  } catch {
    // Fall back to the raw ledger below if state reconstruction is unavailable.
  }
  return (
    [...readJsonl(workDir)].reverse().find((entry: LooseObject) => {
      return entry?.benchmarkContract?.surfaceHash;
    }) || null
  );
}

function latestBenchmarkContractEntryFromState(
  state: LooseObject | null | undefined,
): LooseObject | null {
  const activeConfigEntry =
    state?.activeConfigEntry && typeof state.activeConfigEntry === "object"
      ? (state.activeConfigEntry as LooseObject)
      : null;
  if (
    activeConfigEntry?.benchmarkContractAccepted === true &&
    activeConfigEntry?.benchmarkContractScope === "segment" &&
    activeConfigEntry?.benchmarkContract?.surfaceHash
  ) {
    return activeConfigEntry;
  }
  const current = Array.isArray(state?.current) ? state.current : [];
  return (
    [...current].reverse().find((run: LooseObject) => run?.benchmarkContract?.surfaceHash) || null
  );
}

async function benchmarkContractDrift(workDir: string, state: any) {
  const latest = latestBenchmarkContractEntry(workDir, state);
  if (!latest) return null;
  const current = await benchmarkContractSnapshot(workDir, {
    command: latest.benchmarkContract.command,
    checksCommand: latest.benchmarkContract.checksCommand,
    commandFile: latest.benchmarkContract.commandFile,
    envFile: latest.benchmarkContract.envFile,
    ...(Object.hasOwn(latest.benchmarkContract, "packetEnvMode")
      ? { packetEnvMode: latest.benchmarkContract.packetEnvMode }
      : {}),
  });
  if (
    fingerprintsContainReason(latest.benchmarkContract.files, "fingerprint_byte_budget") ||
    fingerprintsContainReason(current.files, "fingerprint_byte_budget")
  ) {
    return {
      code: "benchmark_contract_fingerprint_budget_exceeded",
      severity: "error",
      run: latest.run ?? null,
      message:
        "Benchmark/check/config contract files exceed the shared fingerprint byte budget, so freshness cannot be proven.",
      action: "Reduce or remove oversized contract files, then run next again.",
    };
  }
  if (current.surfaceHash === latest.benchmarkContract.surfaceHash) return null;
  const driftReference =
    latest.run != null
      ? `logged run #${latest.run}`
      : latest.segment != null
        ? `segment ${latest.segment} contract`
        : "the active benchmark contract";
  return {
    code: "benchmark_contract_changed",
    severity: "error",
    run: latest.run ?? null,
    message: `Benchmark/check/config contract changed since ${driftReference}. Start a new segment or explicitly invalidate old evidence before running more packets or finalizing.`,
    action: "Run new-segment --dry-run, then --yes after reviewing the changed benchmark contract.",
    previousHash: latest.benchmarkContract.surfaceHash,
    currentHash: current.surfaceHash,
  };
}

async function protectedBenchmarkGuardForWorkDir(
  workDir: string,
  config: LooseObject,
  state: LooseObject,
) {
  const dirtyPaths = (await gitDirtyPathDetails(workDir)).map((entry: LooseObject) => entry.path);
  return await buildProtectedBenchmarkGuard({ workDir, config, state, dirtyPaths });
}

function protectedBenchmarkGuardError(guard: LooseObject) {
  return [guard.message, guard.action].filter(Boolean).join(" ");
}

async function preserveSessionFiles(workDir: string) {
  const saved = new Map();
  for (const file of [...SESSION_FILES, ...AUTORESEARCH_OWNED_FILES]) {
    const filePath = path.join(workDir, file);
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Session artifact must not be a symlink or junction: ${filePath}`);
    }
    if (stat.isFile()) {
      saved.set(file, { type: "file", bytes: fs.readFileSync(filePath) });
    }
  }
  for (const dir of AUTORESEARCH_OWNED_DIRS) {
    const researchPath = path.join(workDir, dir);
    if (!fs.existsSync(researchPath)) continue;
    await assertSafeDirectoryTree(workDir, researchPath);
    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-preserve-"));
    fs.cpSync(researchPath, tempPath, { recursive: true });
    saved.set(dir, { type: "dir", tempPath });
  }
  return saved;
}

async function restoreSessionFiles(workDir: string, saved: any) {
  for (const [file, artifact] of saved.entries()) {
    const filePath = path.join(workDir, file);
    if (artifact.type === "dir") {
      await checkedReplaceDirectory(workDir, filePath, artifact.tempPath);
      await fsp.rm(artifact.tempPath, { recursive: true, force: true });
    } else {
      await checkedAtomicWriteFile(workDir, filePath, artifact.bytes, { mode: 0o600 });
    }
  }
}

async function appendSessionRunNote(
  workDir: string,
  experiment: any,
  state: any,
  messages: LooseObject = {},
) {
  const filePath = path.join(workDir, "autoresearch.md");
  if (!(await pathExists(filePath))) return;
  const startMarker = "<!-- AUTORESEARCH_RUN_LEDGER:START -->";
  const endMarker = "<!-- AUTORESEARCH_RUN_LEDGER:END -->";
  const parts = [
    `- Run ${experiment.run} ${experiment.status}: ${experiment.description}`,
    `metric=${experiment.metric}`,
    `best=${state.best ?? "unknown"}`,
  ];
  if (experiment.commit) parts.push(`commit=${experiment.commit}`);
  if (messages.revertMessage) parts.push(messages.revertMessage);
  if (messages.gitMessage && experiment.status === "keep") parts.push(messages.gitMessage);
  const line = `${parts.join("; ")}.`;
  const existing = await fsp.readFile(filePath, "utf8");
  if (existing.includes(startMarker) && existing.includes(endMarker)) {
    const next = existing.replace(endMarker, `${line}\n${endMarker}`);
    await checkedAtomicWriteFile(workDir, filePath, next, { mode: 0o600 });
    return;
  }
  const block = ["", "## Run Ledger", "", startMarker, `${line}`, endMarker, ""].join("\n");
  await checkedAtomicWriteFile(workDir, filePath, `${existing.trimEnd()}\n${block}`, {
    mode: 0o600,
  });
}

async function revertExceptSessionFiles(workDir: string) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const saved = await preserveSessionFiles(workDir);
  const restore = await git(
    ["--literal-pathspecs", "restore", "--worktree", "--staged", "--", "."],
    workDir,
  );
  if (restore.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git restore failed during discard cleanup: ${gitOutput(restore, "unknown error")}`,
    );
  }
  const clean = await git(["clean", "-fd"], workDir);
  if (clean.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git clean failed during discard cleanup: ${gitOutput(clean, "unknown error")}`,
    );
  }
  await restoreSessionFiles(workDir, saved);
  return "Git: reverted non-session changes; autoresearch files preserved.";
}

async function revertScopedPathsExceptSessionFiles(workDir: string, paths: any[]) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const safePaths = normalizeRelativePaths(paths, "revertPaths");
  if (!safePaths.length) throw new Error("No scoped paths were provided for discard cleanup.");
  const saved = await preserveSessionFiles(workDir);
  const restore = await git(
    ["--literal-pathspecs", "restore", "--worktree", "--staged", "--", ...safePaths],
    workDir,
  );
  if (restore.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git scoped restore failed during discard cleanup: ${gitOutput(restore, "unknown error")}`,
    );
  }
  const clean = await git(["--literal-pathspecs", "clean", "-fd", "--", ...safePaths], workDir);
  if (clean.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git scoped clean failed during discard cleanup: ${gitOutput(clean, "unknown error")}`,
    );
  }
  await restoreSessionFiles(workDir, saved);
  return `Git: reverted scoped experiment paths (${safePaths.join(", ")}); autoresearch files preserved.`;
}

async function discardCleanupPlan(workDir: string, args: any, config: any) {
  const scopedPaths = normalizeRelativePaths(
    args.revert_paths ??
      args.revertPaths ??
      args.commit_paths ??
      args.commitPaths ??
      config.commitPaths,
    "revertPaths",
  );
  const statusShort = await gitStatusShort(workDir);
  const dirtyPaths = dirtyPathsFromStatus(statusShort);
  const ownedDirtyPaths = dirtyPaths.filter((dirtyPath: any) =>
    scopedPaths.some((scopedPath: any) => pathIsCoveredByScope(dirtyPath, scopedPath)),
  );
  const unownedDirtyPaths = dirtyPaths.filter(
    (dirtyPath: any) => !ownedDirtyPaths.includes(dirtyPath),
  );
  return {
    scopedPaths,
    dirtyPaths,
    ownedDirtyPaths,
    unownedDirtyPaths,
    fingerprint: hashText(
      JSON.stringify({ scopedPaths, ownedDirtyPaths, unownedDirtyPaths, statusShort }),
    ),
    willRevert: scopedPaths.length > 0 ? ownedDirtyPaths : dirtyPaths,
  };
}

function pathIsCoveredByScope(filePath: string, scopePath: any) {
  const file = process.platform === "win32" ? slashPath(filePath) : filePath;
  const scope = slashPath(scopePath);
  return file === scope || file.startsWith(`${scope}/`);
}

function discardCleanupWillMutate(plan: LooseObject, args: LooseObject) {
  if (Array.isArray(plan.scopedPaths) && plan.scopedPaths.length > 0) {
    return Array.isArray(plan.ownedDirtyPaths) && plan.ownedDirtyPaths.length > 0;
  }
  return (
    Array.isArray(plan.dirtyPaths) &&
    plan.dirtyPaths.length > 0 &&
    boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false)
  );
}

async function cleanupDiscardChanges(
  workDir: string,
  args: any,
  config: any,
  precomputedPlan: LooseObject | null = null,
) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const plan = precomputedPlan || (await discardCleanupPlan(workDir, args, config));
  if (plan.scopedPaths.length > 0) {
    if (!plan.ownedDirtyPaths.length) {
      return `Git: no scoped experiment changes to revert; preserved ${plan.unownedDirtyPaths.length} unowned dirty path(s). cleanup=${plan.fingerprint.slice(0, 12)}.`;
    }
    const message = await revertScopedPathsExceptSessionFiles(workDir, plan.scopedPaths);
    return `${message} Preserved ${plan.unownedDirtyPaths.length} unowned dirty path(s). cleanup=${plan.fingerprint.slice(0, 12)}.`;
  }
  if (!plan.dirtyPaths.length) return "Git: clean tree, no discard cleanup needed.";
  if (boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false)) {
    return await revertExceptSessionFiles(workDir);
  }
  throw new Error(
    "Refusing broad discard cleanup in a dirty Git tree without scoped revert paths. Configure commitPaths/revertPaths or pass --allow-dirty-revert.",
  );
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

async function ensureAutoresearchGitattributes(workDir: string) {
  const filePath = path.join(workDir, ".gitattributes");
  const exists = await pathExists(filePath);
  const current = exists ? await fsp.readFile(filePath, "utf8") : "";
  const hasJsonlRule = /^autoresearch\.jsonl\s+.*\beol=lf\b/im.test(current);
  const hasMdRule = /^autoresearch\.md\s+.*\beol=lf\b/im.test(current);
  const hasIdeasRule = /^autoresearch\.ideas\.md\s+.*\beol=lf\b/im.test(current);
  if (hasJsonlRule && hasMdRule && hasIdeasRule) {
    return { path: filePath, action: "kept" };
  }
  const separator = current.trimEnd() ? "\n\n" : "";
  await checkedAtomicWriteFile(
    workDir,
    filePath,
    `${current.trimEnd()}${separator}${AUTORESEARCH_GITATTRIBUTES_BLOCK}\n`,
    { mode: 0o600 },
  );
  return { path: filePath, action: exists ? "updated" : "created" };
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
  const overwrite = boolOption(args.overwrite, false);
  const shellKind = shellKindFromArgs(args);
  const benchmarkFile = shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1";
  const checksFile = shellKind === "bash" ? "autoresearch.checks.sh" : "autoresearch.checks.ps1";
  const files: LooseObject[] = [];
  const context = { sessionCwd, workDir, overwrite, shellKind, benchmarkFile, checksFile, files };

  if (options.beforeCommonFiles) await options.beforeCommonFiles(context);

  files.push(
    await writeSessionFile(
      path.join(workDir, "autoresearch.md"),
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
      path.join(workDir, "autoresearch.ideas.md"),
      options.ideasContent(context),
      { overwrite, root: workDir },
    ),
  );
  if (!boolOption(args.skip_gitattributes ?? args.skipGitattributes, false)) {
    files.push(await ensureAutoresearchGitattributes(workDir));
  }

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
  const { sessionCwd, workDir, shellKind, files } = await writeSetupBootstrapFiles(args, {
    sessionDocumentArgs: () => args,
    benchmarkContent: ({ shellKind: setupShellKind }: LooseObject) =>
      renderBenchmarkScript(args, setupShellKind),
    ideasContent: () => renderIdeasDocument(args),
  });

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
    ...responseFields,
    init,
  };
}

async function setupResearchSession(args: any) {
  const slug = researchSlugFromArgs(args);
  const goal = args.goal || args.name || slug;
  const { sessionCwd, workDir, shellKind, files } = await writeSetupBootstrapFiles(args, {
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
  });
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
    ...responseFields,
    init,
    qualityGap: {
      open: gap.open,
      closed: gap.closed,
      total: gap.total,
    },
  };
}

async function researchStart(args: LooseObject) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const slug = safeSlug(args.slug || "research");
  const goal = String(args.goal || "").trim();
  if (!goal) throw new Error("research-start requires --goal.");

  const dryRun = boolOption(args.dry_run ?? args.dryRun, false);
  const skipInit = boolOption(args.skipInit ?? args.skip_init, false);
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
    metricName: "quality_gap",
    baselineLogged: false,
    baselineSkippedReason: skipInit ? "skip-init disables the default baseline/log step." : "",
    commands: {
      setup: setupParts.join(" "),
      benchmarkLint: commands.benchmarkLint,
      doctor: `node ${shellQuote(scriptPath)} doctor --cwd ${shellQuote(workDir)} --check-benchmark --explain`,
      baseline: commands.next,
      logBaseline: commands.measureLast,
      resume: commands.recommendNext,
      state: commands.state,
    },
  };
  if (dryRun) return output;

  const setup = await setupResearchSession({ ...args, cwd: workDir, slug, goal });
  const benchmarkCommand = await defaultBenchmarkCommand(workDir);
  const runtimeConfig = await writeRuntimeConfig(setup.sessionCwd, {
    name: args.name || `Deep research: ${goal}`,
    goal,
    metricName: "quality_gap",
    metricUnit: "gaps",
    bestDirection: "lower",
    benchmarkCommand,
  });
  const lint = await benchmarkLint({ cwd: workDir, metricName: "quality_gap" });
  const doctor = await doctorSession({
    cwd: workDir,
    checkBenchmark: true,
    explain: true,
    metricName: "quality_gap",
  });
  let baselinePacket: LooseObject | null = null;
  let baselineLogResult: LooseObject | null = null;
  if (shouldLogBaseline) {
    baselinePacket = await nextExperiment({ cwd: workDir, compact: true });
    baselineLogResult = await logExperiment({
      cwd: workDir,
      fromLast: true,
      status: "measure",
      description: "Baseline quality_gap measurement",
    });
  }
  return {
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
  const counts = parseQualityGaps(text);
  const items = parseQualityGapItems(text);
  const metricOutput = [
    `METRIC quality_gap=${counts.open}`,
    `METRIC quality_total=${counts.total}`,
    `METRIC quality_closed=${counts.closed}`,
  ].join("\n");
  return {
    ok: true,
    workDir,
    slug,
    slugInferred: slugResolution.inferred,
    slugCandidates: slugResolution.candidates,
    researchDir,
    qualityGapsPath: gapsPath,
    open: counts.open,
    closed: counts.closed,
    total: counts.total,
    openItems: items.open,
    closedItems: items.closed,
    metricOutput,
  };
}

async function decisionGuidance({
  workDir,
  config,
  state,
  scaffoldHealth = null,
  warningDetails = [],
  setupMissing = [],
  qualityConstraints: explicitQualityConstraints = null,
  runtimeDriftSummary = null,
  runtimeTrustScope = "source-checkout",
  benchmarkCommand = "",
  checksCommand = "",
}: LooseObject) {
  const constraintList = (value: unknown) =>
    Array.isArray(value) && value.length > 0 ? value : null;
  // Persisted constraints live in the runtime config (autoresearch.config.json),
  // not the ledger-derived state.config, so the runtime config must win.
  const qualityConstraints =
    constraintList(explicitQualityConstraints) ||
    constraintList(config?.qualityConstraints) ||
    constraintList(state?.config?.qualityConstraints);
  return buildDecisionGuidanceContext({
    workDir,
    pluginRoot: PLUGIN_ROOT,
    pluginVersion: PLUGIN_VERSION,
    config,
    state,
    scaffoldHealth,
    warningDetails,
    setupMissing,
    qualityConstraints,
    runtimeDriftSummary,
    runtimeTrustScope,
    benchmarkCommand,
    checksCommand,
    defaultBenchmarkCommand,
    defaultChecksCommand,
    renderCommand: commandLine,
    errorMessage,
  });
}

function decisionSetupState(guided: any, plan: any) {
  const blockers = [...listOption(plan?.missing), ...listOption(plan?.missingEssentials)];
  if (!guided?.stage && blockers.length === 0) return null;
  return {
    stage: guided?.stage || "",
    blockers,
    nextAction:
      guided?.nextStep?.nextAction?.reason ||
      guided?.nextAction ||
      plan?.nextStep?.nextAction?.reason ||
      "",
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

async function dashboardViewModel(workDir: string, config: any, context: LooseObject = {}) {
  const readCache = context.readCache || createSessionReadCache();
  const qualityGap = await currentQualityGapSummary(workDir);
  const state = loadSessionState(workDir, readCache);
  const scaffoldHealth = await buildScaffoldHealth({ workDir, config });
  const researchIntegrity = buildResearchIntegrity({ state, config });
  const warnings = context.suppressEnvironmentWarnings
    ? []
    : await operatorWarningsForWorkDir(workDir, state);
  const settings = dashboardSettings(config, context);
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
  const lastRunFreshness = lastRun ? await lastRunPacketFreshness(workDir, lastRun, config) : null;
  const replaceLastRunCommand = await replacementNextCommandForLastRun(workDir, lastRun);
  const continuation = loopContinuation(workDir, state, config, "dashboard");
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
  const records = loadSessionRecords(workDir, readCache);
  const ledgerHealth = analyzeLedgerHealth(records);
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
  const partialResults = await discoverLastRunPartialResults(workDir, state, lastRun);
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
  const readModel = buildSessionReadModel({
    workDir,
    config,
    state,
    records,
    codexGoalObjective: context.codexGoalObjective || context.codex_goal_objective,
    parallelLanes,
    workflowFriction,
    finalization: effectiveFinalizePreview,
    commands: continuationCommands(workDir),
    qualityGap,
    laneLifecycle,
    packetDiagnostics,
    runtimeProvenance: currentRuntimeProvenance,
    runtimeDriftSummary: guidance.runtimeDriftSummary,
    sourceCleanliness,
    gateQuality: guidance.gateQuality,
    preflight: guidance.preflight,
  });
  const controlPlane = readModel.controlPlane;
  const commands = dashboardCommands(workDir, qualityGap);
  const guidedCommands = (dashboardGuidedSetup as LooseObject).commands || {};
  const canonicalCommandHints = {
    ...commandLookupObject(commands),
    replaceLast: replaceLastRunCommand || guidedCommands.replaceLast || "",
    logLast: guidedCommands.logLast || "",
    setup: guidedCommands.setup || "",
  };
  const decisionInput = {
    state: {
      ...stateWithQualityGap,
      ...controlPlane,
      limit: iterationLimitInfo(state, config),
    },
    nextAction: continuation.nextAction,
    lastRunFreshness,
    warningDetails: warnings,
    scaffoldHealth,
    researchIntegrity,
    qualityGap,
    finalization: effectiveFinalizePreview,
    experimentEconomics,
    salvageCandidates: partialResults.candidates,
    workflowFriction,
    experimentMemory: memory,
    setupState: decisionSetupState(dashboardGuidedSetup, dashboardSetupPlan),
    watchdog: watchdogSummary,
  };
  const preliminaryDecisionEnvelope = buildDecisionEnvelope(decisionInput);
  const portfolioRecommendation =
    preliminaryDecisionEnvelope.loopContract?.canRunNextPacket === false
      ? null
      : recommendPortfolioDirection({
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
  const decisionEnvelope = withCanonicalActionCommand(
    portfolioRecommendation
      ? buildDecisionEnvelope({
          ...decisionInput,
          state: { ...decisionInput.state, portfolioRecommendation },
        })
      : preliminaryDecisionEnvelope,
    canonicalCommandHints,
  );
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
    resumeAudit: decisionEnvelope,
    decisionEnvelope,
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

async function operatorWarningsForWorkDir(
  workDir: string,
  stateOverride: LooseObject | null = null,
) {
  const inGit = await insideGitRepo(workDir);
  const config = readConfig(workDir);
  const state = stateOverride || currentState(workDir);
  const warnings = [];
  warnings.push(...(await pendingLogTransactionWarnings(workDir, inGit)));
  if (inGit) {
    const dirtyPaths = await gitDirtyPathDetails(workDir);
    const sourceDirtyPaths = dirtyPaths.filter(
      (entry: any) => !isAutoresearchOwnedDirtyPath(entry.path),
    );
    if (sourceDirtyPaths.length > 0) {
      warnings.push({
        code: "git_dirty",
        severity: "warning",
        message: "Git worktree is dirty; review unrelated changes before logging a keep result.",
        action:
          "Inspect git status and configure commitPaths or revertPaths before trusting keep/discard automation.",
        paths: sourceDirtyPaths.map((entry: any) => entry.path).slice(0, 12),
      });
    } else if (dirtyPaths.length > 0) {
      warnings.push({
        code: "autoresearch_session_dirty",
        severity: "info",
        message:
          "Only Autoresearch session artifacts are dirty; source drift checks will not block the next action.",
        action: "Continue the loop, then include or exclude session artifacts during finalization.",
        paths: dirtyPaths.map((entry: any) => entry.path).slice(0, 12),
      });
    }
  }
  const missingCommitPaths = [];
  for (const item of listOption(config.commitPaths || config.commit_paths)) {
    if (!(await pathExists(path.resolve(workDir, item)))) missingCommitPaths.push(item);
  }
  if (missingCommitPaths.length) {
    warnings.push({
      code: "missing_commit_paths",
      severity: "warning",
      message: `Configured commitPaths do not exist: ${missingCommitPaths.slice(0, 5).join(", ")}.`,
      action:
        "Update commitPaths before relying on keep commits or use explicit --commit-paths for the next log.",
    });
  }
  const contractDrift = await benchmarkContractDrift(workDir, state);
  if (contractDrift) warnings.push(contractDrift);
  const protectedBenchmarkGuard = await protectedBenchmarkGuardForWorkDir(workDir, config, state);
  const protectedBenchmarkWarning = protectedBenchmarkWarningFromGuard(protectedBenchmarkGuard);
  if (protectedBenchmarkWarning) warnings.push(protectedBenchmarkWarning);
  warnings.push(...(await benchmarkIntegrityPreflight(workDir, config, state, { inGit })));
  return warnings;
}

async function benchmarkIntegrityPreflight(
  workDir: string,
  config: any,
  state: any,
  options: { inGit?: boolean } = {},
) {
  const warnings = [];
  const hasIntegrityGuard = Boolean(
    config.benchmarkIntegrityCommand ||
    config.benchmark_integrity_command ||
    config.contaminationCheckCommand ||
    config.contamination_check_command ||
    config.promotionBenchmarkCommand ||
    config.promotion_benchmark_command ||
    config.holdoutCommand ||
    config.holdout_command ||
    config.devHoldoutSplit ||
    config.dev_holdout_split,
  );
  if (state.current.length === 0 && !hasIntegrityGuard) {
    warnings.push({
      code: "benchmark_integrity_preflight_missing",
      severity: "warning",
      message:
        "No evaluator-contamination guard is configured for the first packet: benchmark leakage, stale artifacts, cache reuse, and dev/holdout split are unproven.",
      action:
        "Add a benchmarkIntegrityCommand/holdout or run benchmark-inspect plus benchmark-lint before trusting the baseline.",
    });
  }
  const staleArtifactRoots = [];
  for (const relative of ["target/autoresearch", ".autoresearch-cache"]) {
    if (await pathExists(path.join(workDir, relative))) staleArtifactRoots.push(relative);
  }
  const inGit = options.inGit ?? (await insideGitRepo(workDir).catch(() => false));
  if (inGit && (await gitPrivateDirectoryHasBenchmarkArtifacts(workDir, "autoresearch"))) {
    staleArtifactRoots.push(".git/autoresearch");
  }
  if (staleArtifactRoots.length && !boolOption(config.allowStaleArtifacts, false)) {
    warnings.push({
      code: "stale_benchmark_artifacts",
      severity: "warning",
      message: `Previous benchmark/autoresearch artifacts exist: ${staleArtifactRoots.join(", ")}.`,
      action:
        "Clear or namespace benchmark artifacts before the first packet, or set an explicit freshness guard in the benchmark contract.",
    });
  }
  return warnings;
}

async function gitPrivateDirectoryHasBenchmarkArtifacts(workDir: string, relativePath: string) {
  try {
    const directory = await gitPrivatePath(workDir, relativePath);
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((): [] => []);
    return entries.some((entry: any) => entry.name !== "last-run.json");
  } catch {
    return false;
  }
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
    const activeRuns = state.current.length;
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

async function initExperiment(args: LooseObject) {
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

async function runExperiment(args: LooseObject) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const progressWriter = await createActiveProgressWriter(workDir);
  return await runWithRequiredCleanup(
    () => runExperimentWithProgressWriter(args, progressWriter),
    () => progressWriter.close(),
    "Failed to close active progress writer",
  );
}

async function runExperimentWithProgressWriter(
  args: LooseObject,
  progressWriter: Awaited<ReturnType<typeof createActiveProgressWriter>>,
) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = currentState(workDir);
  const limit = iterationLimitInfo(state, config);
  if (limit.limitReached) {
    throw new Error(
      limit.stopReason ||
        `maxIterations reached (${limit.maxIterations}). Start a new segment with init/setup or raise maxIterations before running more experiments.`,
    );
  }
  const protectedBenchmarkGuard = await protectedBenchmarkGuardForWorkDir(workDir, config, state);
  if (protectedBenchmarkGuard.configured && !protectedBenchmarkGuard.ok) {
    throw new Error(protectedBenchmarkGuardError(protectedBenchmarkGuard));
  }
  const commandInput = await benchmarkCommandFromArgs(args, workDir, config);
  const { command } = commandInput;
  const fixedControlBlock = fixedControlBlockForCommand(command, config, args);
  if (fixedControlBlock) throw fixedControlRerunError(fixedControlBlock);
  const timeoutSeconds = numberOption(
    args.timeout_seconds ?? args.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const resourcePreflight = assertRunResourcePreflight({
    command,
    config,
    entries: readJsonl(workDir),
  });
  let progressSnapshot = createProgressSnapshot({
    packetId: buildActiveRunPacketId(state.results.length + 1),
    command,
    startedAt: new Date().toISOString(),
    timeoutSeconds,
    artifactRoot: ".",
  });
  progressSnapshot = progressWriter.queue(progressSnapshot);
  await progressWriter.flush();
  const updateProgress = ({ observedAt, output }: { observedAt: string; output: string }) => {
    progressSnapshot = updateProgressSnapshot(progressSnapshot, { output, observedAt });
    progressSnapshot = {
      ...progressSnapshot,
      staleProgressReason: staleProgressReason(progressSnapshot, {
        now: observedAt,
        staleAfterSeconds: numberOption(
          config.staleProgressSeconds ?? config.progressStaleSeconds,
          300,
        ),
      }),
    };
    progressSnapshot = progressWriter.queue(progressSnapshot);
  };
  const benchmark = await runShell(command, workDir, timeoutSeconds, {
    env: commandInput.env,
    envMode: commandInput.packetEnvMode,
    onProgress: updateProgress,
    retainMetricNames: [state.config.metricName],
  });
  const benchmarkPassed = benchmark.exitCode === 0 && !benchmark.timedOut;
  const parseSource = metricParseSource(benchmark);
  const parsedMetricResult = parseMetricLines(parseSource, {
    primaryMetricName: state.config.metricName,
    maxMetrics: MAX_PARSED_METRICS,
    withTruncation: true,
  });
  const { artifacts, artifactWarnings } = parseArtifactLines(
    benchmark.fullOutput || benchmark.output || parseSource,
    workDir,
  );
  const parsedMetrics = parsedMetricResult.metrics;
  const primary = parsedMetrics[state.config.metricName] ?? null;
  const primaryPresent = finiteMetric(primary) != null;
  const primaryMetric = finiteMetric(primary);
  const improvesPrimary =
    primaryMetric != null &&
    (state.best == null || isBetter(primaryMetric, state.best, state.config.bestDirection));
  const isBaseline = state.current.filter(isBaselineEligibleMetricRun).length === 0;
  let checks = null;
  const rawChecksCommand =
    args.checks_command || args.checksCommand || (await defaultChecksCommand(workDir));
  const checksCommand = rawChecksCommand
    ? normalizePowerShellEscapedCommandArg(rawChecksCommand)
    : "";
  const checksPolicy = checksPolicyFromArgs(args, config);
  const explicitChecksCommand = Boolean(args.checks_command || args.checksCommand);
  if (
    checksCommand &&
    shouldRunChecks(checksPolicy, {
      benchmarkPassed,
      primaryPresent,
      checksCommand,
      improvesPrimary,
      explicitChecksCommand,
    })
  ) {
    checks = await runShell(
      checksCommand,
      workDir,
      numberOption(
        args.checks_timeout_seconds ?? args.checksTimeoutSeconds,
        DEFAULT_CHECKS_TIMEOUT_SECONDS,
      ),
      {
        env: commandInput.env,
        envMode: commandInput.packetEnvMode,
        onProgress: updateProgress,
      },
    );
  }
  const checksPassed = checks ? checks.exitCode === 0 && !checks.timedOut : null;
  const terminationFailed = Boolean(benchmark.terminationFailed || checks?.terminationFailed);
  const termination = checks?.termination ?? benchmark.termination;
  const metricError =
    benchmarkPassed && !primaryPresent
      ? `Benchmark completed but did not print primary metric METRIC ${state.config.metricName}=<number>.`
      : null;
  const checksPassedOrSkipped = checksPassed === null || checksPassed;
  const passed = benchmarkPassed && primaryPresent && checksPassedOrSkipped;
  const failedStatus = benchmarkPassed && primaryPresent ? "checks_failed" : "crash";
  const allowedStatuses = passed ? ["keep", "discard", "measure"] : [failedStatus];
  const suggestedStatus = passed
    ? isBaseline
      ? "measure"
      : improvesPrimary
        ? "keep"
        : "discard"
    : failedStatus;
  const checksWereVerified = checksPassed === true;
  const safeSuggestedStatus = passed
    ? suggestedStatus === "keep" && !isBaseline && !checksWereVerified
      ? "discard"
      : suggestedStatus
    : failedStatus;
  const statusGuidance = passed
    ? safeSuggestedStatus === "keep"
      ? "Safe to consider keep because this is a checked improvement; still review ASI before logging."
      : safeSuggestedStatus === "measure"
        ? "Log this as measure because it is a baseline or diagnostic packet without a prior improvement comparison; use keep only when real improvement evidence exists."
        : "Default to discard unless the operator can justify keep with ASI and verification evidence; use measure for non-promotional metric evidence."
    : `Only ${failedStatus} is allowed because the benchmark or checks failed.`;
  const progress = buildRunProgress({ benchmark, checks, checksCommand, passed });
  if (terminationFailed) {
    progressSnapshot = finishProgressSnapshot(progressSnapshot, {
      exitCode: null,
      timedOut: true,
      terminationFailed: true,
      termination,
      timeoutPhase: benchmark.terminationFailed ? "benchmark" : "checks",
      completedAt: checks?.finishedAt || benchmark.finishedAt,
      artifacts,
    });
    progressSnapshot = progressWriter.queue(progressSnapshot);
    await progressWriter.flush();
  }
  return {
    ok: passed,
    workDir,
    command,
    commandExecutionBoundary: COMMAND_EXECUTION_BOUNDARY.mode,
    commandExecutionBoundaryNote: COMMAND_EXECUTION_BOUNDARY.note,
    timeoutSeconds,
    commandFile: commandInput.commandFile,
    envFile: commandInput.envFile,
    envKeys: commandInput.envKeys,
    explicitEnvKeys: commandInput.explicitEnvKeys,
    packetEnvMode: commandInput.packetEnvMode,
    commandDiagnostics: commandDiagnostics({
      command,
      commandFile: commandInput.commandFile,
      envFile: commandInput.envFile,
      separatorCommand: commandInput.separatorCommand,
      result: benchmark,
    }),
    startedAt: benchmark.startedAt,
    finishedAt: checks?.finishedAt || benchmark.finishedAt,
    lastOutputAt: checks?.lastOutputAt || benchmark.lastOutputAt,
    progressSnapshot,
    exitCode: benchmark.exitCode,
    timedOut: benchmark.timedOut || Boolean(checks?.timedOut),
    termination,
    terminationFailed,
    timeoutPhase: benchmark.timedOut ? "benchmark" : checks?.timedOut ? "checks" : "none",
    durationSeconds: benchmark.durationSeconds,
    parsedMetrics,
    artifacts,
    artifactWarnings,
    parsedPrimary: primary,
    metricError,
    checksPolicy,
    improvesPrimary,
    outputTruncated: Boolean(
      benchmark.outputTruncated ||
      benchmark.fullOutputTruncated ||
      benchmark.metricOutputTruncated ||
      checks?.outputTruncated ||
      checks?.fullOutputTruncated ||
      checks?.metricOutputTruncated,
    ),
    metricsTruncated: Boolean(parsedMetricResult.truncated || benchmark.metricOutputTruncated),
    metricName: state.config.metricName,
    metricUnit: state.config.metricUnit,
    progress,
    protectedBenchmarkGuard,
    resourcePreflight,
    checks: checks
      ? {
          command: checksCommand,
          exitCode: checks.exitCode,
          timedOut: checks.timedOut,
          termination: checks.termination,
          terminationFailed: checks.terminationFailed,
          durationSeconds: checks.durationSeconds,
          passed: checksPassed,
          tailOutput: tailText(checks.output, 80, 16000),
        }
      : null,
    tailOutput: tailText(benchmark.output),
    logHint: {
      metric: primary,
      metrics: Object.fromEntries(
        Object.entries(parsedMetrics).filter(
          ([key]: [string, unknown]) => key !== state.config.metricName,
        ),
      ),
      status: passed ? null : failedStatus,
      suggestedStatus,
      safeSuggestedStatus,
      statusGuidance,
      needsDecision: passed,
      allowedStatuses,
    },
    limit,
    benchmarkContract: await benchmarkContractSnapshot(workDir, {
      command,
      checksCommand,
      commandFile: commandInput.commandFile,
      envFile: commandInput.envFile,
      packetEnvMode: commandInput.packetEnvMode,
    }),
  };
}

function buildRunProgress({
  benchmark,
  checks,
  checksCommand,
  passed,
}: {
  benchmark: ProcessRunResult;
  checks: ProcessRunResult | null;
  checksCommand: string | null;
  passed: boolean;
}) {
  const stages: ProgressStageResult[] = [
    progressStage("benchmark", "Run benchmark command", benchmark),
  ];
  if (checksCommand) {
    stages.push(
      checks
        ? progressStage("checks", "Run correctness checks", checks)
        : {
            stage: "checks",
            label: "Run correctness checks",
            status: "skipped",
            durationSeconds: 0,
            exitCode: null,
            timedOut: false,
            outputTail: "",
          },
    );
  }
  const timedOut = stages.some((stage) => stage.timedOut);
  const terminationFailed = stages.some((stage) => stage.terminationFailed);
  return {
    mode: "synchronous",
    status: terminationFailed
      ? "termination_failed"
      : timedOut
        ? "timed_out"
        : passed
          ? "completed"
          : "failed",
    cancellable: false,
    cancelStatus: terminationFailed
      ? "termination-failed"
      : timedOut
        ? "timeout-terminated"
        : "not_requested",
    elapsedSeconds: Number(
      stages.reduce((total, stage) => total + Number(stage.durationSeconds || 0), 0).toFixed(3),
    ),
    stages,
    latestOutputTail: [...stages].reverse().find((stage) => stage.outputTail)?.outputTail || "",
  };
}

function progressStage(
  stage: string,
  label: string,
  result: ProcessRunResult,
): ProgressStageResult {
  return {
    stage,
    label,
    status: result.terminationFailed
      ? "termination_failed"
      : result.timedOut
        ? "timed_out"
        : result.exitCode === 0
          ? "completed"
          : "failed",
    durationSeconds: Number(result.durationSeconds || 0),
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    termination: result.termination || null,
    terminationFailed: Boolean(result.terminationFailed),
    outputTail: tailText(result.output || ""),
  };
}

async function logExperiment(args: any) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const existingPendingReceipts = await pendingLogTransactionWarnings(workDir);
  if (existingPendingReceipts.length > 0) {
    throw new Error(existingPendingReceipts[0].message);
  }
  const lastPacket = boolOption(args.from_last ?? args.fromLast, false)
    ? await readLastRunPacket(workDir)
    : null;
  if (lastPacket) await assertFreshLastRunPacket(workDir, lastPacket, config);
  const packetAllowed = Array.isArray(lastPacket?.decision?.allowedStatuses)
    ? lastPacket.decision.allowedStatuses
    : [];
  const status = String(
    args.status || (packetAllowed.length === 1 ? lastPacket?.decision?.suggestedStatus : "") || "",
  );
  if (!status)
    throw new Error(
      "status is required; choose keep, discard, or measure explicitly for successful packets.",
    );
  if (!STATUS_VALUES.has(status))
    throw new Error(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
  if (
    lastPacket?.decision &&
    Array.isArray(lastPacket.decision.allowedStatuses) &&
    !lastPacket.decision.allowedStatuses.includes(status)
  ) {
    throw new Error(
      `Cannot log status '${status}' for the last run. Allowed statuses: ${lastPacket.decision.allowedStatuses.join(", ")}.`,
    );
  }
  const metric = numberOption(args.metric ?? lastPacket?.decision?.metric, null);
  if (!FAILURE_STATUSES.has(status) && metric == null) {
    throw new Error("metric is required for keep, discard, and measure");
  }
  if (status === "keep" && lastPacket?.run?.checks?.passed === false) {
    throw new Error(
      "Cannot keep the last run because correctness checks failed. Log it as checks_failed.",
    );
  }
  const description = args.description || lastPacket?.run?.description || "";
  if (!description) throw new Error("description is required");
  const metricsFilePath = args.metrics_file ?? args.metricsFile;
  if (metricsFilePath && args.metrics != null) {
    throw new Error("Use either --metrics or --metrics-file, not both.");
  }
  const metricsFromFile = await parseJsonFileOption(metricsFilePath, workDir, "--metrics-file");
  const metrics = metricsFromFile ?? args.metrics ?? lastPacket?.decision?.metrics ?? {};
  const artifacts = args.artifacts ?? lastPacket?.run?.artifacts ?? {};
  const legacyAsiFilePath = args.asi_file ?? args.asiFile;
  const asiJsonFilePath = args.asi_json_file ?? args.asiJsonFile;
  if (legacyAsiFilePath && asiJsonFilePath) {
    throw new Error("Use either --asi-json-file or --asi-file, not both.");
  }
  const asiFilePath = asiJsonFilePath ?? legacyAsiFilePath;
  const asiFileOptionName = asiJsonFilePath ? "--asi-json-file" : "--asi-file";
  if (asiFilePath && args.asi != null) {
    throw new Error(`Use either --asi or ${asiFileOptionName}, not both.`);
  }
  const asiFromFile = await parseJsonFileOption(asiFilePath, workDir, asiFileOptionName);
  const asi = asiFromFile ?? args.asi ?? lastPacket?.decision?.asiTemplate ?? {};
  let evidenceStatus =
    evidenceStatusOption(args.evidence_status ?? args.evidenceStatus, status) ||
    defaultEvidenceStatusForRun({ status });

  const stateBefore = currentState(workDir);
  const constraintRunMetrics = {
    ...metrics,
    [stateBefore.config.metricName || "metric"]: metric,
  };
  const constraintState =
    stateBefore.current.some(isBaselineEligibleMetricRun) || !isMetricEligibleStatus(status)
      ? stateBefore
      : {
          ...stateBefore,
          current: [
            ...stateBefore.current,
            {
              run: stateBefore.results.length + 1,
              metric,
              metrics,
              status,
            },
          ],
        };
  const secondaryMetricConstraints = evaluateSecondaryMetricConstraints({
    config,
    state: constraintState,
    runMetrics: constraintRunMetrics,
  });
  if (
    status === "keep" &&
    secondaryMetricConstraints.blockPromotion &&
    evidenceStatus === "accepted"
  ) {
    evidenceStatus = "provisional";
  }
  const protectedBenchmarkGuard = await protectedBenchmarkGuardForWorkDir(
    workDir,
    config,
    stateBefore,
  );
  if (status === "keep" && protectedBenchmarkGuardBlocksKeep(protectedBenchmarkGuard)) {
    throw new Error(protectedBenchmarkGuardError(protectedBenchmarkGuard));
  }
  const inGit = await insideGitRepo(workDir);
  const explicitCommit = args.commit != null && String(args.commit).trim() !== "";
  const allowAddAll = boolOption(args.allow_add_all ?? args.allowAddAll, false);
  if (explicitCommit && !inGit) {
    throw new Error("--commit requires a Git repository so the commit can be verified.");
  }
  if (explicitCommit && status === "measure") {
    throw new Error(
      "--commit is not allowed for measure logs; measure records trend evidence only.",
    );
  }
  let commit = "";
  if (explicitCommit) {
    commit = (await resolveCommitRef(workDir, args.commit)).slice(0, 12);
  } else if (inGit && status !== "keep" && status !== "measure") {
    commit = await shortHead(workDir);
  }
  let gitMessage = inGit ? "Git: no commit created." : "Git: not a repo.";
  let revertMessage = "";
  let pendingLogReceiptPath: string | null = null;
  let pendingLogReceiptWarning = "";
  const logWarnings: string[] = [];

  if (status === "keep" && inGit) {
    if (explicitCommit) {
      gitMessage = `Git: recorded existing commit ${commit}.`;
    } else {
      const resultData = {
        status,
        [stateBefore.config.metricName || "metric"]: metric,
        ...metrics,
      };
      const commitPaths = normalizeRelativePaths(
        args.commit_paths ?? args.commitPaths ?? config.commitPaths,
        "commitPaths",
      );
      if (shouldWarnEmptyCommitPaths({ inGit, commitPaths, allowAddAll })) {
        throw new Error(
          `${emptyCommitPathsWarning().message} Pass --allow-add-all only when every dirty file belongs in the kept commit.`,
        );
      }
      if (commitPaths.length > 0) await assertCommitPathsExist(workDir, commitPaths);
      await assertNoGitIndexLock(workDir, "git add");
      pendingLogReceiptPath = await writePendingLogTransaction(workDir, inGit, {
        run: stateBefore.results.length + 1,
        status,
        description,
        metric,
        mutation: "keep-commit",
        commitPaths,
        allowAddAll,
        explicitCommit: false,
      });
      const addResult =
        commitPaths.length > 0
          ? await git(["--literal-pathspecs", "add", "--", ...commitPaths], workDir)
          : await git(["add", "-A"], workDir);
      if (addResult.code !== 0) {
        if (gitIndexLockFailure(addResult)) {
          const lockPath = await gitPrivatePath(workDir, "index.lock");
          throw new Error(await gitIndexLockMessage(workDir, lockPath, "git add", true));
        }
        throw new Error(`Git add failed: ${gitOutput(addResult, "unknown error")}`);
      }
      const stagedChanges = commitPaths.length
        ? await hasStagedChangesInPaths(workDir, commitPaths)
        : await hasStagedChanges(workDir);
      if (stagedChanges) {
        const commitResult = await git(
          commitPaths.length
            ? [
                "--literal-pathspecs",
                "commit",
                "--only",
                "-m",
                description,
                "-m",
                `Result: ${JSON.stringify(resultData)}`,
                "--",
                ...commitPaths,
              ]
            : ["commit", "-m", description, "-m", `Result: ${JSON.stringify(resultData)}`],
          workDir,
        );
        if (commitResult.code === 0) {
          commit = await shortHead(workDir);
          gitMessage = allowAddAll
            ? `Git: committed ${commit} using explicit add-all.`
            : `Git: committed ${commit}.`;
        } else {
          throw new Error(`Git commit failed: ${gitOutput(commitResult, "unknown error")}`);
        }
      } else {
        gitMessage = "Git: nothing to commit.";
      }
    }
  } else if (status !== "keep" && status !== "measure") {
    const discardPlan = inGit ? await discardCleanupPlan(workDir, args, config) : null;
    if (discardPlan && discardCleanupWillMutate(discardPlan, args)) {
      pendingLogReceiptPath = await writePendingLogTransaction(workDir, inGit, {
        run: stateBefore.results.length + 1,
        status,
        description,
        metric,
        mutation: "discard-cleanup",
        revertPaths: discardPlan.scopedPaths || [],
        willRevert: Array.isArray(discardPlan.willRevert)
          ? discardPlan.willRevert.slice(0, 50)
          : [],
        cleanupFingerprint: discardPlan.fingerprint || "",
        allowDirtyRevert: boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false),
      });
    }
    revertMessage = await cleanupDiscardChanges(workDir, args, config, discardPlan);
  }

  const currentRuns = stateBefore.current;
  const experiment: LooseObject = {
    run: stateBefore.results.length + 1,
    commit: String(commit || "").slice(0, 12),
    metric,
    metrics,
    metricEligible: isMetricEligibleStatus(status) && finiteMetric(metric) != null,
    status,
    evidenceStatus,
    description,
    timestamp: Date.now(),
    segment: stateBefore.segment,
    confidence: null,
  };
  if (lastPacket?.packetEvidence?.freshnessFingerprint) {
    experiment.packetFingerprint = lastPacket.packetEvidence.freshnessFingerprint;
  }
  if (lastPacket?.packetEvidence?.commandExecutionBoundary) {
    experiment.commandExecutionBoundary = lastPacket.packetEvidence.commandExecutionBoundary;
  }
  const protectedPaths = protectedBenchmarkPathsFromConfig(config);
  if (protectedPaths.length > 0 && isBaselineEligibleMetricRun(experiment)) {
    experiment.protectedBenchmarkSnapshot = await buildProtectedBenchmarkSnapshot({
      workDir,
      paths: protectedPaths,
    });
  }
  const protectedBenchmarkWarning = protectedBenchmarkWarningFromGuard(protectedBenchmarkGuard);
  if (protectedBenchmarkWarning) {
    experiment.protectedBenchmarkGuard = protectedBenchmarkWarning;
  }
  if (secondaryMetricConstraints.configured) {
    experiment.secondaryMetricConstraints = secondaryMetricConstraints;
  }
  experiment.promotion = promotionStateForLoggedDecision({
    status,
    metric,
    metrics,
    packetPromotion: lastPacket?.decision?.promotion,
  });
  if (secondaryMetricConstraints.blockPromotion) {
    experiment.promotion = {
      label: "blocked",
      reasons: [
        "Blocking secondary metric constraints failed or were unavailable.",
        ...secondaryMetricConstraints.messages,
      ],
    };
  }
  if (asi && Object.keys(asi).length > 0) experiment.asi = asi;
  if (artifacts && Object.keys(artifacts).length > 0) {
    experiment.artifacts = artifacts;
    experiment.artifactEvidence = artifactEvidenceList(artifacts, workDir, evidenceStatus);
  }
  if (
    lastPacket?.packetEvidence?.taskArtifacts &&
    typeof lastPacket.packetEvidence.taskArtifacts === "object" &&
    !Array.isArray(lastPacket.packetEvidence.taskArtifacts)
  ) {
    experiment.taskArtifacts = lastPacket.packetEvidence.taskArtifacts;
    experiment.taskArtifactsScope = "durable";
  }
  const benchmarkContract =
    lastPacket?.history?.benchmarkContract ||
    (await benchmarkContractSnapshot(workDir, {
      command: lastPacket?.history?.command || "",
      checksCommand: lastPacket?.run?.checks?.command || "",
    }));
  if (benchmarkContract?.surfaceHash) experiment.benchmarkContract = benchmarkContract;
  experiment.confidence = computeConfidence(
    [...currentRuns, experiment],
    stateBefore.config.bestDirection,
  );
  appendJsonl(workDir, experiment);
  if (pendingLogReceiptPath) {
    const cleanupWarning = await clearPendingLogTransactionWithWarning(
      pendingLogReceiptPath,
      undefined,
      { workDir },
    );
    if (cleanupWarning) {
      pendingLogReceiptWarning = cleanupWarning;
      logWarnings.push(pendingLogReceiptWarning);
    }
  }
  const lastRunCleanupWarnings = lastPacket ? await deleteLastRunPacket(workDir) : [];
  logWarnings.push(...lastRunCleanupWarnings.map((warning) => warning.message));

  const stateAfter = currentState(workDir);
  const limit = iterationLimitInfo(stateAfter, config);
  try {
    await appendSessionRunNote(workDir, experiment, stateAfter, {
      gitMessage: [gitMessage, pendingLogReceiptWarning].filter(Boolean).join(" "),
      revertMessage,
    });
  } catch (error: unknown) {
    logWarnings.push(
      `Run was durably logged to autoresearch.jsonl, but autoresearch.md could not be updated: ${errorMessage(error)}.`,
    );
  }
  return {
    ok: true,
    workDir,
    experiment,
    baseline: stateAfter.baseline,
    best: stateAfter.best,
    confidence: stateAfter.confidence,
    limit,
    git: gitMessage,
    revert: revertMessage,
    recovery: logWarnings.join(" "),
    warnings: logWarnings,
    warningDetails: lastRunCleanupWarnings,
    lastRunCleared: Boolean(lastPacket) && lastRunCleanupWarnings.length === 0,
    continuation: loopContinuation(workDir, stateAfter, config, "logged"),
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
    await resolveLastRunPath(workDir),
    await resolveProgressPath(workDir),
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

async function resolveLastRunPath(workDir: string) {
  if (await insideGitRepo(workDir)) {
    return await gitPrivatePath(workDir, "autoresearch/last-run.json");
  }
  return resolveSessionPaths({ workDir }).lastRunFallbackPath;
}

async function resolveProgressPath(workDir: string) {
  if (await insideGitRepo(workDir)) {
    return await gitPrivatePath(workDir, "autoresearch/progress.json");
  }
  return resolveSessionPaths({ workDir }).progressFallbackPath;
}

async function writeLastRunPacket(workDir: string, packet: any, filePath: string | null = null) {
  const target = filePath || (await resolveLastRunPath(workDir));
  await checkedAtomicWriteFile(
    await privateStateWriteRoot(workDir, target),
    target,
    `${JSON.stringify(redactLastRunPacketForStorage(packet), null, 2)}\n`,
    { mode: 0o600 },
  );
  return target;
}

async function writeActiveProgressSnapshot(workDir: string, snapshot: LooseObject) {
  const target = await resolveProgressPath(workDir);
  const generation = activeProgressGeneration(snapshot);
  if (generation <= activeProgressGeneration(readProgressSnapshot(target))) return target;
  await checkedAtomicWriteFile(
    await privateStateWriteRoot(workDir, target),
    target,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  return target;
}

async function readActiveProgressSnapshot(workDir: string, config: LooseObject = {}) {
  const target = await resolveProgressPath(workDir);
  const snapshot = readProgressSnapshot(target);
  if (!snapshot || snapshot.exitState !== "running") return snapshot;
  return {
    ...snapshot,
    staleProgressReason: staleProgressReason(snapshot as RunnerProgressSnapshot, {
      staleAfterSeconds: numberOption(
        config.staleProgressSeconds ?? config.progressStaleSeconds,
        300,
      ),
    }),
  };
}

async function createActiveProgressWriter(workDir: string) {
  const current = await readActiveProgressSnapshot(workDir);
  return createCoalescingProgressWriter<RunnerProgressSnapshot>({
    initialGeneration: activeProgressGeneration(current),
    write: async (snapshot) => {
      await writeActiveProgressSnapshot(workDir, snapshot);
    },
  });
}

function readProgressSnapshot(target: string): LooseObject | null {
  if (!fs.existsSync(target)) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(target, "utf8"));
    return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

function activeProgressGeneration(snapshot: LooseObject | null): number {
  const generation = Number(snapshot?.generation);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

async function deleteActiveProgressSnapshot(workDir: string) {
  try {
    await fsp.rm(await resolveProgressPath(workDir));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

async function deleteActiveProgressSnapshotIfSafe(workDir: string) {
  const snapshot = await readActiveProgressSnapshot(workDir);
  if (snapshot?.exitState === "termination_failed") return;
  await deleteActiveProgressSnapshot(workDir);
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

async function readLastRunPacket(workDir: string) {
  const filePath = await resolveLastRunPath(workDir);
  const legacyPath = resolveSessionPaths({ workDir }).lastRunFallbackPath;
  const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(readablePath))
    throw new Error(
      [
        `No last-run packet found for ${workDir}.`,
        `Recovery: run ${shellQuote("node")} ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)} --compact,`,
        `or manually log measurement evidence with log --cwd ${shellQuote(workDir)} --metric <value> --status measure --description ${shellQuote("Describe the measurement")}.`,
      ].join(" "),
    );
  return JSON.parse(fs.readFileSync(readablePath, "utf8"));
}

async function lastRunPacketFingerprint(workDir: string) {
  const filePath = await resolveLastRunPath(workDir);
  const legacyPath = resolveSessionPaths({ workDir }).lastRunFallbackPath;
  const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(readablePath)) return "";
  return createHash("sha256").update(fs.readFileSync(readablePath, "utf8")).digest("hex");
}

async function assertFreshLastRunPacket(
  workDir: string,
  packet: any,
  config: LooseObject | null = null,
) {
  const freshness = await lastRunPacketFreshness(workDir, packet, config);
  if (!freshness.fresh) throw new Error(`${freshness.reason} ${lastRunRecoveryText(workDir)}`);
}

function lastRunRecoveryText(workDir: string) {
  return [
    `Recovery: run node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)} --compact,`,
    `or manually log measurement evidence with log --cwd ${shellQuote(workDir)} --metric <value> --status measure --description ${shellQuote("Describe the measurement")}.`,
  ].join(" ");
}

async function lastRunPacketFreshness(
  workDir: string,
  packet: any,
  runtimeConfig: LooseObject | null = null,
) {
  const expectedNextRun = Number(packet.history?.nextRun);
  const expectedSegment = Number(packet.history?.segment);
  if (!Number.isFinite(expectedNextRun)) {
    return {
      fresh: false,
      reason: "Last-run packet is missing history metadata. Run next again before logging.",
    };
  }
  const state = currentState(workDir);
  const expectedWorkDir = packet.history?.workDir || packet.workDir;
  if (expectedWorkDir && path.resolve(expectedWorkDir) !== path.resolve(workDir)) {
    return {
      fresh: false,
      expectedWorkDir,
      actualWorkDir: workDir,
      reason:
        "Last-run packet is stale: working directory changed since the packet was created. Run next again before logging.",
    };
  }
  const actualNextRun = state.results.length + 1;
  if (Number.isFinite(expectedSegment) && state.segment !== expectedSegment) {
    return {
      fresh: false,
      expectedSegment,
      actualSegment: state.segment,
      reason: `Last-run packet is stale: expected segment #${expectedSegment}, but current segment is #${state.segment}. Run next again before logging.`,
    };
  }
  const expectedConfig = packet.history?.config;
  if (!expectedConfig || typeof expectedConfig !== "object") {
    return {
      fresh: false,
      reason: "Last-run packet is missing config metadata. Run next again before logging.",
    };
  }
  const actualConfig = lastRunConfigSnapshot(state.config);
  if (JSON.stringify(expectedConfig) !== JSON.stringify(actualConfig)) {
    return {
      fresh: false,
      expectedConfig,
      actualConfig,
      reason:
        "Last-run packet is stale: session config changed since the packet was created. Run next again before logging.",
    };
  }
  if (actualNextRun !== expectedNextRun) {
    return {
      fresh: false,
      expectedNextRun,
      actualNextRun,
      reason: `Last-run packet is stale: expected next log run #${expectedNextRun}, but current history would log #${actualNextRun}. Run next again before logging.`,
    };
  }
  if (packet.history?.trustConfig && runtimeConfig) {
    const actualTrustConfig = lastRunTrustConfigSnapshot(workDir, runtimeConfig, {
      benchmarkContractHash: packet.history?.benchmarkContract?.surfaceHash,
      benchmarkCommand:
        packet.run?.command ||
        packet.history?.benchmarkContract?.command ||
        packet.history?.command,
      checksCommand:
        packet.run?.checks?.command || packet.history?.benchmarkContract?.checksCommand,
      checksPolicy: packet.run?.checksPolicy,
      packetEnvMode: packet.history?.packetEnvMode || packet.run?.packetEnvMode,
    });
    if (packet.history.trustConfig.hash !== actualTrustConfig.hash) {
      return {
        fresh: false,
        expectedTrustFields: packet.history.trustConfig.fields,
        actualTrustFields: actualTrustConfig.fields,
        reason:
          "Last-run packet is stale: execution, checks, scope, or recipe trust configuration changed since the packet was created. Run next again before logging.",
      };
    }
  }
  if (
    fingerprintsContainReason(packet.history?.benchmarkContract?.files, "fingerprint_byte_budget")
  ) {
    return {
      fresh: false,
      expectedTrustFields: packet.history?.trustConfig?.fields || [],
      reason:
        "Last-run packet is stale: benchmark, checks, config, command, or environment files exceeded the shared fingerprint byte budget. Reduce those files, then run next again before logging.",
    };
  }
  const expectedGit = packet.history?.git;
  if (expectedGit?.inside) {
    const actualGit = await lastRunGitSnapshot(workDir, {
      commitPaths: expectedGit.scopedPaths || [],
    });
    if (!actualGit.inside) {
      return {
        fresh: false,
        expectedGit,
        actualGit,
        reason:
          "Last-run packet is stale: the working directory is no longer a Git worktree. Run next again before logging.",
      };
    }
    if (expectedGit.head && actualGit.head && expectedGit.head !== actualGit.head) {
      return {
        fresh: false,
        expectedGit,
        actualGit,
        reason: `Last-run packet is stale: Git HEAD changed from ${expectedGit.head} to ${actualGit.head}. Run next again before logging.`,
      };
    }
    if (
      expectedGit.statusHash &&
      actualGit.statusHash &&
      expectedGit.statusHash !== actualGit.statusHash
    ) {
      return {
        fresh: false,
        expectedGit,
        actualGit,
        reason:
          "Last-run packet is stale: Git dirty state changed since the packet was created. Run next again before logging.",
      };
    }
    if (
      gitSnapshotContainsDirtyFingerprintTruncation(expectedGit) ||
      gitSnapshotContainsDirtyFingerprintTruncation(actualGit)
    ) {
      return {
        fresh: false,
        expectedGit,
        actualGit,
        reason:
          "Last-run packet is stale: dirty file fingerprints were truncated before freshness could be proven. Clean or narrow the dirty tree, then run next again before logging.",
      };
    }
    if (expectedGit.fileFingerprints?.length || actualGit.fileFingerprints?.length) {
      const expectedFiles = JSON.stringify(expectedGit.fileFingerprints || []);
      const actualFiles = JSON.stringify(actualGit.fileFingerprints || []);
      if (expectedFiles !== actualFiles) {
        return {
          fresh: false,
          expectedGit,
          actualGit,
          reason:
            "Last-run packet is stale: scoped file fingerprints changed since the packet was created. Run next again before logging.",
        };
      }
    }
    if (expectedGit.dirtyFileFingerprints?.length || actualGit.dirtyFileFingerprints?.length) {
      const expectedDirtyFiles = JSON.stringify(expectedGit.dirtyFileFingerprints || []);
      const actualDirtyFiles = JSON.stringify(actualGit.dirtyFileFingerprints || []);
      if (expectedDirtyFiles !== actualDirtyFiles) {
        return {
          fresh: false,
          expectedGit,
          actualGit,
          reason:
            "Last-run packet is stale: dirty file contents changed since the packet was created. Run next again before logging.",
        };
      }
    }
  }
  return {
    fresh: true,
    expectedNextRun,
    actualNextRun,
    expectedWorkDir: expectedWorkDir || workDir,
    command: packet.history?.replayCommand || packet.history?.command || packet.run?.command || "",
    git: packet.history?.git || null,
    reason: "Last-run packet matches the current ledger.",
  };
}

function fingerprintsContainTruncation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => fingerprintsContainTruncation(item));
  if (!value || typeof value !== "object") return false;
  const record = value as LooseObject;
  if (record.truncated === true) return true;
  return Object.values(record).some((item) => fingerprintsContainTruncation(item));
}

function gitSnapshotContainsDirtyFingerprintTruncation(git: LooseObject): boolean {
  return (
    fingerprintsContainReason(git.fileFingerprints, "fingerprint_byte_budget") ||
    fingerprintsContainTruncation(git.dirtyFileFingerprints)
  );
}

function fingerprintsContainReason(value: unknown, reason: string): boolean {
  if (Array.isArray(value)) return value.some((item) => fingerprintsContainReason(item, reason));
  if (!value || typeof value !== "object") return false;
  const record = value as LooseObject;
  if (record.truncated === true && record.reason === reason) return true;
  return Object.values(record).some((item) => fingerprintsContainReason(item, reason));
}

function lastRunConfigSnapshot(config: LooseObject = {}) {
  return {
    name: config.name || null,
    metricName: config.metricName || "metric",
    metricUnit: config.metricUnit ?? "",
    bestDirection: config.bestDirection === "higher" ? "higher" : "lower",
  };
}

function lastRunTrustConfigSnapshot(
  workDir: string,
  config: LooseObject = {},
  context: LooseObject = {},
) {
  const surface = {
    benchmarkContractHash: String(context.benchmarkContractHash || ""),
    benchmarkCommandHash: hashText(normalizedTrustCommand(context.benchmarkCommand)),
    checksCommandHash: hashText(normalizedTrustCommand(context.checksCommand)),
    checksPolicy: String(config.checksPolicy || context.checksPolicy || "always"),
    protectedBenchmarkPaths: normalizeStringListForTrustHash(config.protectedBenchmarkPaths),
    fixedControl: config.fixedControl || null,
    secondaryMetricConstraints: normalizeStringListForTrustHash(config.secondaryMetricConstraints),
    secondaryMetricConstraintMode: String(config.secondaryMetricConstraintMode || "advisory"),
    packetEnvMode: String(context.packetEnvMode || "minimal"),
    commitPaths: normalizeRelativePaths(config.commitPaths, "commitPaths").sort(),
    workingDirectory: path.resolve(workDir),
    recipeProvenance: config.recipeCatalogProvenance || config.recipe_catalog_provenance || null,
  };
  return {
    hash: hashText(stableTrustJson(surface)),
    fields: Object.keys(surface).sort(),
  };
}

function normalizedTrustCommand(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeStringListForTrustHash(value: unknown): string[] {
  const items = Array.isArray(value) ? value : listOption(value);
  return items
    .map((item) => stableTrustJson(item))
    .filter(Boolean)
    .sort();
}

function stableTrustJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTrustJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as LooseObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableTrustJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function deleteLastRunPacket(workDir: string) {
  const filePath = await resolveLastRunPath(workDir);
  const legacyPath = resolveSessionPaths({ workDir }).lastRunFallbackPath;
  return await clearFilesWithWarnings([filePath, legacyPath], undefined, { workDir });
}

async function discoverLastRunPartialResults(
  workDir: string,
  state: LooseObject,
  lastRun: LooseObject | null,
) {
  if (!lastRun || !partialResultEligiblePacket(lastRun)) {
    return { candidates: [], skippedArtifacts: [] };
  }
  return await discoverPartialResultCandidatesLazy({
    workDir,
    primaryMetricName: state.config?.metricName || "metric",
    lastRunPacket: lastRun,
  }).catch((error: any) => ({
    candidates: [],
    skippedArtifacts: [
      {
        artifactName: "last-run",
        artifactPath: lastRun?.lastRunPath || "",
        reason: error.message || String(error),
      },
    ],
  }));
}

function partialResultEligiblePacket(packet: LooseObject | null): boolean {
  if (!packet) return false;
  const run = packet.run || {};
  const packetEvidence = packet.packetEvidence || {};
  if (packet.ok === false || run.timedOut === true || packetEvidence.timedOut === true) return true;
  const exitCode = finiteMetric(run.exitCode ?? packetEvidence.exitStatus);
  return exitCode != null && exitCode !== 0;
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

function dashboardCommands(workDir: string, qualityGap: any = null) {
  return buildDashboardCommands({
    researchSlug: qualityGap?.slug || currentQualityGapSlug(workDir) || "research",
    scriptPath: path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
    shellQuote,
    workDir,
  });
}

function runtimeProvenance(drift: LooseObject | null = null) {
  const unavailable = runtimeDriftUnavailable(drift);
  const drifted = confirmedRuntimeDrift(drift);
  return {
    pluginVersion: PLUGIN_VERSION,
    sourceRoot: PLUGIN_ROOT,
    repoRoot: REPO_ROOT,
    localVersion: PLUGIN_VERSION,
    installedVersion:
      drift?.installed?.version || drift?.installed?.pluginVersion || drift?.routing?.version || "",
    installedCachePath:
      drift?.installed?.cachePath || drift?.installed?.path || drift?.routing?.cachePath || "",
    drifted,
    status: drift
      ? unavailable
        ? "unavailable"
        : drifted
          ? "drift-detected"
          : "checked"
      : "unavailable",
    driftConfidence: drift
      ? unavailable
        ? "unavailable"
        : drifted
          ? "drift-detected"
          : "checked"
      : "source-only",
    reason: drifted
      ? "Source and installed runtime drift needs inspection before public claims."
      : "",
    inspectCommand: "",
  };
}

function runtimeDriftUnavailable(drift: LooseObject | null): boolean {
  if (!drift) return true;
  if (drift.probeFailed === true || drift.unavailable === true) return true;
  const status = String(drift.status || drift.driftStatus || "").toLowerCase();
  return ["unavailable", "probe-failed", "probe_failed", "error", "unknown"].includes(status);
}

function confirmedRuntimeDrift(drift: LooseObject | null): boolean {
  if (!drift || runtimeDriftUnavailable(drift)) return false;
  if (
    drift.drifted === true ||
    drift.mismatched === true ||
    drift.stale === true ||
    drift.needsInspection === true
  ) {
    return true;
  }
  const warnings = Array.isArray(drift.warnings) ? drift.warnings.map(String) : [];
  if (
    warnings.some((warning) =>
      /version_surface_mismatch|runtime.*drift|source.*differs/i.test(warning),
    )
  ) {
    return true;
  }
  return false;
}

function loopContinuation(
  workDir: string,
  state: any,
  config: LooseObject = {},
  stage: any = "state",
  options: LooseObject = {},
) {
  const mode = config.autonomyMode || "guarded";
  const limit = iterationLimitInfo(state, config);
  const activeBudget = loopBudgetActive(limit) && mode !== "manual";
  const remainingBudget = loopBudgetRemainingText(limit);
  const commands = continuationCommands(workDir);
  const memory = buildExperimentMemory({
    runs: state.current,
    direction: state.config.bestDirection,
    settings: dashboardSettings(config),
  });
  const topLane = memory.diversityGuidance || memory.lanePortfolio?.[0];
  const stopConditions = [
    "user interrupts or turns the loop off",
    "packet, wall-clock, or iteration budget is reached",
    "benchmark or correctness checks are blocked",
    "the task is genuinely exhausted",
  ];
  if (options.stopReason) {
    return {
      mode,
      stage,
      shouldContinue: false,
      shouldAskUser: false,
      stopReason: options.stopReason,
      nextAction: options.stopReason,
      commands,
      stopConditions,
    };
  }
  if (stage === "needs-log-decision") {
    const logThenContinue = options.requiredStatus
      ? `Log this packet as ${options.requiredStatus} with rollback ASI, then continue to the next hypothesis.`
      : "Log this packet as keep or discard with ASI, then continue to the next hypothesis.";
    return {
      mode,
      stage,
      activeBudget,
      shouldContinue: activeBudget,
      shouldAskUser: false,
      requiresLogDecision: true,
      forbidFinalAnswer: mode === "owner-autonomous" || activeBudget,
      finalAnswerPolicy:
        mode === "owner-autonomous" || activeBudget
          ? "Do not send a final answer after this packet; log it, read continuation, and keep the budget moving until a stop condition appears."
          : "Report the pending log decision if the user only asked for state.",
      logThenContinue: true,
      afterLogAction:
        "After the log command succeeds, immediately read the returned continuation and run the next packet when the user asked for an ongoing budget.",
      nextAction: logThenContinue,
      commands,
      stopConditions,
    };
  }
  if (limit.limitReached) {
    return {
      mode,
      stage,
      shouldContinue: false,
      shouldAskUser: false,
      stopReason: limit.stopReason || `maxIterations reached (${limit.maxIterations}).`,
      nextAction:
        limit.budgetStatus?.nextAction ||
        "Export the dashboard and summarize the limit, or extend the session before more experiments.",
      commands,
      stopConditions,
    };
  }
  if (mode === "manual") {
    return {
      mode,
      stage,
      shouldContinue: false,
      shouldAskUser: true,
      stopReason: "autonomy_mode is manual.",
      nextAction: "Return the current state and wait for the operator before the next experiment.",
      commands,
      stopConditions,
    };
  }
  const ownerAutonomous = mode === "owner-autonomous";
  return {
    mode,
    stage,
    activeBudget,
    plateau: memory.plateau,
    lanePortfolio: memory.lanePortfolio,
    shouldContinue: true,
    shouldAskUser: false,
    forbidFinalAnswer: ownerAutonomous || activeBudget,
    finalAnswerPolicy:
      ownerAutonomous || activeBudget
        ? "Do not stop at a status report while iterations remain; continue running packets until the limit, blocker, exhaustion, or user interruption."
        : "A status report is acceptable when the user asked only to inspect state.",
    nextAction: ownerAutonomous
      ? memory.plateau?.detected
        ? `Keep the floor: run the ${topLane?.label || "distant scout"} lane next because the current search is plateauing.`
        : "Keep the floor: choose the next hypothesis from ASI/autoresearch.ideas.md, edit the scoped files, run next_experiment, and log the result without asking the user to invoke another subskill."
      : activeBudget
        ? memory.plateau?.detected
          ? `Keep going: run the ${topLane?.label || "distant scout"} lane next, log it, and continue because ${remainingBudget}.`
          : `Keep going: choose the next hypothesis, run next --compact, log the packet, and continue because ${remainingBudget}.`
        : "Continue the active loop when the current user request asks for iteration; otherwise report the state and next command.",
    commands,
    stopConditions,
  };
}

function loopBudgetActive(limit: LooseObject): boolean {
  if (limit.limitReached) return false;
  if (limit.maxIterations != null && Number(limit.remainingIterations) > 0) return true;
  const budget = limit.budgetStatus || {};
  if (budget.configured !== true) return false;
  if (budget.exhausted === true) return false;
  if (budget.packetsRemaining != null && Number(budget.packetsRemaining) <= 0) return false;
  if (budget.wallClockRemainingSeconds != null && Number(budget.wallClockRemainingSeconds) <= 0) {
    return false;
  }
  return true;
}

function loopBudgetRemainingText(limit: LooseObject): string {
  const parts = [];
  if (limit.maxIterations != null && limit.remainingIterations != null) {
    parts.push(
      `${limit.remainingIterations} iteration${limit.remainingIterations === 1 ? "" : "s"}`,
    );
  }
  const budget = limit.budgetStatus || {};
  if (budget.packetsRemaining != null) {
    parts.push(
      `${budget.packetsRemaining} packet${budget.packetsRemaining === 1 ? "" : "s"} in the packet budget`,
    );
  }
  if (budget.wallClockRemainingSeconds != null) {
    parts.push(`${budget.wallClockRemainingSeconds} wall-clock second(s)`);
  }
  return parts.length
    ? `the active budget still has ${parts.join(" and ")} left`
    : "the loop is still active";
}

function resolveFanoutForSegment(workDir: string, segment: number, records?: LooseObject[] | null) {
  const entry = [...recordsOrReadJsonl(workDir, records)]
    .reverse()
    .find(
      (item: any) =>
        item?.type === "research_fanout" &&
        item.fanoutPlan &&
        Number(item.segment) === Number(segment),
    );
  if (!entry) {
    return {
      fanoutPlan: null,
      fanoutProvenance: {
        source: "memory_or_defaults",
        segment,
        matchedSegment: false,
      },
    };
  }
  return {
    fanoutPlan: entry.fanoutPlan,
    fanoutProvenance: {
      source: "segment_plan",
      segment,
      matchedSegment: true,
      planId: entry.fanoutPlan.id || null,
      createdAt: entry.fanoutPlan.createdAt || null,
    },
  };
}

function enrichParallelLanesWithLaneResults(lanes: LooseObject[], laneResults: LooseObject[]) {
  const latestByLane = new Map<string, LooseObject>();
  for (const entry of laneResults) {
    const laneId = entry?.lane?.id;
    if (!laneId) continue;
    const existing = latestByLane.get(laneId);
    if (!existing || Number(entry.timestamp || 0) >= Number(existing.timestamp || 0)) {
      latestByLane.set(laneId, entry);
    }
  }
  return lanes.map((lane) => {
    const entry = latestByLane.get(lane.id);
    if (!entry?.result) return lane;
    const resultStatus = String(entry.result.status || "").toLowerCase();
    const completed = resultStatus === "completed" || resultStatus === "approved";
    const accepted = completed && laneResultHasAcceptedEvidence(entry.result);
    return {
      ...lane,
      status: completed ? "completed" : entry.result.status || lane.status,
      evidenceStatus: accepted ? "accepted" : entry.result.evidenceStatus || lane.evidenceStatus,
      completedAt:
        accepted && entry.timestamp ? new Date(entry.timestamp).toISOString() : lane.completedAt,
      lastLaneResult: {
        status: entry.result.status,
        summary: entry.result.summary || "",
        recommendation: entry.result.recommendation || "",
      },
    };
  });
}

function laneResultHasAcceptedEvidence(result: LooseObject) {
  return result?.evidenceAccepted === true;
}

function buildParallelOrchestrationContext({
  workDir,
  state,
  config,
  settings = {},
  memory = null,
  records = null,
}: {
  workDir: string;
  state: LooseObject;
  config: LooseObject;
  settings?: LooseObject;
  memory?: LooseObject | null;
  records?: LooseObject[] | null;
}) {
  const resolvedMemory =
    memory ||
    buildExperimentMemory({
      runs: state.current,
      direction: state.config.bestDirection,
      settings: Object.keys(settings).length ? settings : dashboardSettings(config),
    });
  const { fanoutPlan, fanoutProvenance } = resolveFanoutForSegment(workDir, state.segment, records);
  const laneResults = latestLaneResults(workDir, state.segment, records);
  const baseLanes = buildParallelLanes({
    memory: resolvedMemory,
    fanoutPlan,
    config,
  });
  const parallelLanes = enrichParallelLanesWithLaneResults(baseLanes, laneResults);
  const watchdogSummary = buildWatchdogSummary({
    state,
    settings,
    current: state.current,
    parallelLanes,
    fanoutPlan,
  });
  return {
    memory: resolvedMemory,
    fanoutPlan,
    fanoutProvenance,
    parallelLanes,
    laneResults,
    watchdogSummary,
  };
}

function buildParallelLanes({
  memory,
  fanoutPlan = null,
  config = {},
}: {
  memory: LooseObject;
  fanoutPlan?: LooseObject | null;
  config?: LooseObject;
}) {
  const planned = Array.isArray(fanoutPlan?.lanes) ? fanoutPlan.lanes : [];
  if (planned.length > 0) {
    return planned.map((lane: LooseObject, index: number) =>
      normalizeParallelLane(lane, index, config),
    );
  }
  const memoryLanes = Array.isArray(memory?.lanePortfolio) ? memory.lanePortfolio : [];
  const lanes = memoryLanes.map((lane: LooseObject, index: number) =>
    normalizeParallelLane(lane, index, config),
  );
  const existingIds = new Set(lanes.map((lane) => lane.id));
  for (const seed of defaultParallelLaneSeeds(config)) {
    const normalized = normalizeParallelLane(seed, lanes.length, config);
    if (existingIds.has(normalized.id)) continue;
    lanes.push(normalized);
    existingIds.add(normalized.id);
  }
  return lanes;
}

function defaultParallelLaneSeeds(config: LooseObject) {
  const metricName = config.metricName || "primary metric";
  return [
    {
      id: "read-only-scout",
      label: "Read-only scout",
      priority: "high",
      nextActionHint: `Find one evidence-backed hypothesis that could move ${metricName}.`,
      brief: {
        objective: `Find one evidence-backed hypothesis that could move ${metricName}.`,
        evidencePoint: "Current ledger, ASI memory, and recent packet evidence.",
        boundaries: ["read-only", "do not edit files", "return one candidate next action"],
        pointers: ["autoresearch.jsonl", "autoresearch.ideas.md"],
        expectedDecisionOutput: "one scout recommendation with evidence and a next measured action",
      },
    },
    {
      id: "benchmark-contract",
      label: "Benchmark contract",
      priority: "high",
      nextActionHint:
        "Check whether the benchmark, parsed metric, and checks still measure the intended outcome.",
      brief: {
        objective:
          "Check that benchmark, parsed metric, and checks still measure the intended outcome.",
        evidencePoint:
          "Benchmark contract, METRIC parser output, checks command, and doctor warnings.",
        boundaries: ["read-only", "do not change benchmark code in this lane"],
        pointers: ["autoresearch.config.json", "autoresearch.last-run.json"],
        expectedDecisionOutput: "one benchmark-trust recommendation or repair candidate",
      },
    },
    {
      id: "implementation-candidate",
      label: "Implementation candidate",
      priority: "medium",
      nextActionHint:
        "Prepare one isolated edit lane only after a scout produces a concrete hypothesis.",
      brief: {
        objective:
          "Prepare one isolated edit candidate after a scout produces a concrete hypothesis.",
        evidencePoint: "Accepted scout recommendation and current commit path boundaries.",
        boundaries: ["use a separate worktree or owned write scope", "keep edits scoped"],
        pointers: ["autoresearch.ideas.md", "autoresearch.config.json"],
        expectedDecisionOutput: "one implementation plan with files, risks, and verification",
      },
    },
    {
      id: "promotion-readiness",
      label: "Promotion readiness",
      priority: "medium",
      nextActionHint:
        "Identify repeat, holdout, or finalization evidence still needed before a keep can promote.",
      brief: {
        objective:
          "Identify repeat, holdout, or finalization evidence still needed before promotion.",
        evidencePoint:
          "Kept runs, promotion-grade measurements, finalization preview, and gate quality.",
        boundaries: ["read-only", "do not promote evidence from this lane"],
        pointers: ["autoresearch.jsonl", "autoresearch.research"],
        expectedDecisionOutput: "one promotion-readiness gap or finalization recommendation",
      },
    },
  ];
}

function normalizeParallelLane(lane: LooseObject, index: number, config: LooseObject) {
  const rawId = lane.id || lane.label || lane.title || `lane-${index + 1}`;
  const id = safeSlug(String(rawId)) || `lane-${index + 1}`;
  const label = lane.label || lane.title || `Lane ${index + 1}`;
  const readOnly =
    !/implementation|edit|candidate|worktree/i.test(String(id)) &&
    !/implementation|edit|candidate|worktree/i.test(String(label));
  const executionBoundary = readOnly
    ? "strict Git read-only argv allowlist before execution; Git porcelain is best-effort detection only"
    : "use a separate worktree or declared write scope; no filesystem or process containment is provided";
  const nextActionHint =
    lane.nextActionHint ||
    lane.recommendation ||
    "Return a concise hypothesis, evidence, and next measured action.";
  const brief = normalizeLaneBrief(lane.brief || lane, {
    objective: lane.objective || nextActionHint,
    evidencePoint:
      lane.evidencePoint ||
      lane.evidence ||
      `Current ${config.metricName || "primary metric"} evidence and session memory.`,
    boundaries: [executionBoundary],
    pointers: ["autoresearch.jsonl", "autoresearch.ideas.md"],
    expectedDecisionOutput: "one recommendation, supporting evidence, and the next measured action",
    lessonsToAvoid: [],
  });
  return {
    id,
    title: label,
    label,
    status: lane.status || "planned",
    priority: lane.priority || (index === 0 ? "high" : "medium"),
    mode: readOnly ? "read_only_scout" : "implementation",
    executionBoundary,
    evidenceStatus: lane.evidenceStatus || "provisional",
    owner: lane.owner || "subagent",
    writeScope: readOnly ? [] : listOption(config.commitPaths || config.commit_paths),
    reason: lane.reason || lane.evidence || "Parallel lane planned from current session memory.",
    nextActionHint,
    brief,
  };
}

function latestLaneResults(
  workDir: string,
  segment: number | null = null,
  records?: LooseObject[] | null,
) {
  return recordsOrReadJsonl(workDir, records).filter(
    (entry: any) =>
      entry?.type === "lane_result" && (segment == null || Number(entry.segment) === segment),
  );
}

function recordsOrReadJsonl(workDir: string, records?: LooseObject[] | null): LooseObject[] {
  return Array.isArray(records) ? records : readJsonl(workDir);
}

function normalizeLaneMode(value: unknown, fallback: string) {
  const raw = String(value || fallback || "read_only_scout")
    .toLowerCase()
    .replace(/-/g, "_");
  if (["read_only", "readonly", "scout", "read_only_scout"].includes(raw)) return "read_only_scout";
  if (["implementation", "isolated_worktree", "mutating"].includes(raw)) return "implementation";
  if (["big_idea", "bigidea", "architecture", "distant"].includes(raw)) return "big_idea";
  throw new Error("--mode must be read_only_scout, implementation, or big_idea.");
}

type LaneCommandSafety = {
  unsafeForWriteScope: boolean;
};

const LANE_GIT_WRITE_SCOPE_UNSAFE =
  "am|apply|bisect|checkout|cherry-pick|clean|commit|merge|pull|push|rebase|reset|restore|revert|stash|switch|tag|worktree";
const LANE_PACKAGE_MANAGER_MUTATING =
  "(?:npm\\s+(?:ci|install|i|update|uninstall|remove|add)|pnpm\\s+(?:add|install|remove|update|uninstall)|yarn\\s+(?:add|install|remove|upgrade|uninstall)|bun\\s+(?:add|install|remove))";

function classifyLaneCommandSafety(command: string): LaneCommandSafety {
  const packageMutating = new RegExp(
    `(^|[\\s;&|])${LANE_PACKAGE_MANAGER_MUTATING}(\\s|$)`,
    "i",
  ).test(command);
  const gitUnsafeForWriteScope = new RegExp(
    `(^|[\\s;&|])git\\b[^\\r\\n;&|]*\\b(${LANE_GIT_WRITE_SCOPE_UNSAFE})\\b`,
    "i",
  ).test(command);
  return {
    unsafeForWriteScope: gitUnsafeForWriteScope || packageMutating,
  };
}

function commandLooksUnsafeForWriteScope(command: string) {
  return classifyLaneCommandSafety(command).unsafeForWriteScope;
}

async function gitTopLevel(cwd: string) {
  const result = await git(["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) throw new Error(`Git worktree lookup failed: ${gitOutput(result, cwd)}`);
  return path.resolve(cwd, result.stdout.trim());
}

async function gitCommonDirectory(cwd: string) {
  const result = await git(["rev-parse", "--git-common-dir"], cwd);
  if (result.code !== 0) throw new Error(`Git common-dir lookup failed: ${gitOutput(result, cwd)}`);
  const value = result.stdout.trim();
  return path.resolve(cwd, value);
}

async function gitRef(cwd: string, ref: string) {
  const result = await git(["rev-parse", "--verify", ref], cwd);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function resolveLaneWorktree(workDir: string, worktreePath: string) {
  const runCwd = path.resolve(workDir, worktreePath);
  const [baseTopLevel, laneInsideGit] = await Promise.all([
    gitTopLevel(workDir),
    insideGitRepo(runCwd).catch(() => false),
  ]);
  if (!laneInsideGit) {
    throw new Error(`Implementation lane worktree must be an existing Git worktree: ${runCwd}`);
  }
  const laneTopLevel = await gitTopLevel(runCwd);
  if (path.resolve(baseTopLevel) === path.resolve(laneTopLevel)) {
    throw new Error("Implementation lane --worktree must point at a separate Git worktree.");
  }
  const [baseCommonDir, laneCommonDir] = await Promise.all([
    gitCommonDirectory(baseTopLevel),
    gitCommonDirectory(laneTopLevel),
  ]);
  if (path.resolve(baseCommonDir) !== path.resolve(laneCommonDir)) {
    throw new Error("Implementation lane --worktree must belong to the same Git repository.");
  }
  return laneTopLevel;
}

function dirtyPathWithinScope(relativePath: string, writeScope: string[]) {
  return writeScope.some((scope) => relativePath === scope || relativePath.startsWith(`${scope}/`));
}

async function assertDirtyPathsWithinWriteScope(workDir: string, writeScope: string[]) {
  if (!(await insideGitRepo(workDir).catch(() => false))) {
    throw new Error("Implementation lane --write-scope verification requires a Git worktree.");
  }
  const dirty = await gitDirtyPathDetails(workDir);
  const outside = dirty
    .map((entry: any) => entry.path)
    .filter((relativePath: string) => !dirtyPathWithinScope(relativePath, writeScope));
  if (outside.length) {
    throw new Error(
      `Implementation lane changed files outside --write-scope: ${outside
        .slice(0, 8)
        .map(displayGitPath)
        .join(", ")}`,
    );
  }
}

async function assertNoDirtyPathsOutsideWriteScope(workDir: string, writeScope: string[]) {
  if (!(await insideGitRepo(workDir).catch(() => false))) {
    throw new Error("Implementation lane --write-scope verification requires a Git worktree.");
  }
  const dirty = await gitDirtyPathDetails(workDir);
  const outside = dirty
    .map((entry: any) => entry.path)
    .filter((relativePath: string) => !dirtyPathWithinScope(relativePath, writeScope));
  if (outside.length) {
    throw new Error(
      `Implementation lane --write-scope cannot start with dirty files outside scope: ${outside
        .slice(0, 8)
        .map(displayGitPath)
        .join(", ")}`,
    );
  }
}

async function writeScopeSnapshot(workDir: string) {
  if (!(await insideGitRepo(workDir).catch(() => false))) {
    throw new Error("Implementation lane --write-scope verification requires a Git worktree.");
  }
  return {
    head: await gitRef(workDir, "HEAD"),
    stash: await gitRef(workDir, "refs/stash"),
  };
}

async function assertWriteScopeIntegrity(
  workDir: string,
  writeScope: string[],
  before: LooseObject,
) {
  const after = await writeScopeSnapshot(workDir);
  if (before.head !== after.head) {
    throw new Error(
      "Implementation lane --write-scope cannot move HEAD; use a separate --worktree for commits or history changes.",
    );
  }
  if (before.stash !== after.stash) {
    throw new Error(
      "Implementation lane --write-scope cannot create or change git stash entries; use a separate --worktree for hidden cleanup.",
    );
  }
  await assertDirtyPathsWithinWriteScope(workDir, writeScope);
}

function synthesizeLaneDecision({
  workDir,
  laneResults,
  fallbackLane,
}: {
  workDir: string;
  laneResults: LooseObject[];
  fallbackLane?: LooseObject | null;
}) {
  const completed = laneResults
    .filter((entry) => selectableLaneResult(entry?.result))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const selected = completed.find((entry) => entry.result?.recommendation || entry.result?.summary);
  const nextAction =
    selected?.result?.recommendation ||
    selected?.result?.summary ||
    fallbackLane?.nextActionHint ||
    "Run one read-only scout lane, then choose one isolated implementation candidate for the next measured packet.";
  const lessonsToAvoid = summarizeLaneLessons(laneResults);
  return {
    status: selected ? "ready" : "needs_lane_result",
    sourceLane: selected?.lane?.id || fallbackLane?.id || "",
    nextAction,
    lessonsToAvoid,
    measuredPacket:
      "Run exactly one next measured packet for the selected action, then log keep/discard/crash with ASI.",
    commandHint: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)} --compact`,
  };
}

function selectableLaneResult(result: LooseObject | null | undefined): boolean {
  const status = String(result?.status || "").toLowerCase();
  return (
    (status === "completed" || status === "approved") &&
    (result?.evidenceAccepted === true || Boolean(result?.recommendation || result?.summary))
  );
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
  const lanes = buildParallelLanes({ memory, config }).slice(0, laneLimit);
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

function continuationCommands(workDir: string) {
  return buildContinuationCommands({
    researchSlug: currentQualityGapSlug(workDir) || "research",
    scriptPath: path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
    shellQuote,
    workDir,
  });
}

function withCanonicalActionCommand(envelope: LooseObject, commands: unknown): LooseObject {
  const action = envelope?.canonicalNextAction;
  if (!action) return envelope;
  const command = resolveActionCommand(action.kind, commands, {
    explicitCommand: action.command,
  });
  return {
    ...envelope,
    canonicalNextAction: {
      ...action,
      command,
      safeAction:
        action.safeAction || actionSafeActionForKind(action.kind, String(action.kind || "")),
      toolName: action.toolName || guidedToolNameForCanonicalKind(String(action.kind || "")),
    },
  };
}

function commandLookupObject(commands: unknown): LooseObject {
  if (Array.isArray(commands)) {
    const result: LooseObject = {};
    for (const item of commands) {
      const label = String(item?.label || "")
        .replace(/\s+([a-z])/g, (_match, char) => String(char).toUpperCase())
        .replace(/^[A-Z]/, (char) => char.toLowerCase());
      if (label) result[label] = item.command || "";
    }
    return result;
  }
  return commands && typeof commands === "object" ? (commands as LooseObject) : {};
}

function currentQualityGapSlug(workDir: string) {
  return activeQualityGapSlugCandidatesSync(workDir)[0]?.slug || null;
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
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
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
  const benchmarkCommand = String(args.benchmark_command || args.benchmarkCommand || "").trim();
  const checksCommand = String(args.checks_command || args.checksCommand || "").trim();
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
  if (!dryRun && !confirmed) {
    throw new Error(
      "new-segment requires --dry-run or --yes because it appends to autoresearch.jsonl.",
    );
  }
  if (!dryRun) appendJsonl(workDir, entry);
  return {
    ok: true,
    workDir,
    dryRun,
    previousSegment: state.segment,
    nextSegment: state.segment + 1,
    entry,
    metricSemanticsWarning,
    benchmarkContract: entry.benchmarkContract || null,
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

function promotionStateForLoggedDecision({
  status,
  metric,
  metrics = {},
  packetPromotion = null,
}: LooseObject) {
  if (status === "keep") {
    if (packetPromotion?.label) return packetPromotion;
    if (promotionGradeValue({ metrics }) === true) {
      return {
        label: "promotion_eligible",
        reasons: ["Logged keep carries explicit promotion-grade metadata."],
      };
    }
    return finiteMetric(metric) == null
      ? {
          label: "blocked",
          reasons: ["Kept decisions require a finite metric before promotion can be assessed."],
        }
      : {
          label: "exploratory",
          reasons: [
            "Logged keep is exploratory until repeat, holdout, breadth, or promotion-gate metadata is recorded.",
          ],
        };
  }
  if (status === "discard") {
    return {
      label: "invalidated",
      reasons: ["Logged as discard; metric evidence is retained but not promotable."],
    };
  }
  if (status === "measure") {
    return {
      label: "measurement",
      reasons: ["Logged as measure; metric evidence is trend-only and not finalizer evidence."],
    };
  }
  return {
    label: "blocked",
    reasons: [
      status === "checks_failed"
        ? "Correctness checks failed; packet evidence is blocked from promotion."
        : "Crash evidence is retained without sentinel metrics and is blocked from promotion.",
    ],
  };
}

async function nextExperiment(args: any) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  return await runWithRequiredCleanup(
    () => nextExperimentWithActiveProgress(args),
    () => deleteActiveProgressSnapshotIfSafe(workDir),
    "Failed to remove active progress snapshot",
  );
}

async function nextExperimentWithActiveProgress(args: any) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const retainedProgress = await readActiveProgressSnapshot(workDir, config);
  if (retainedProgress?.exitState === "termination_failed") {
    const state = currentState(workDir);
    const decisionEnvelope = withCanonicalActionCommand(
      buildDecisionEnvelope({
        state,
        nextAction: "Prove the prior process tree is gone before another packet.",
        experimentEconomics: { progress: retainedProgress },
      }),
      continuationCommands(workDir),
    );
    const loopContract = decisionEnvelope.loopContract || {};
    const blockingAction = blockingLoopAction(loopContract, decisionEnvelope.canonicalNextAction);
    return {
      ok: false,
      workDir,
      refused: true,
      code: "termination_failed",
      run: null,
      decision: null,
      blockingAction,
      loopContract,
      decisionEnvelope,
      progress: retainedProgress,
      nextAction: blockingAction?.reason || "Prove the prior process tree is gone.",
      clearingCondition:
        "Verify the reported PID and descendants are absent, then clear the retained progress marker before retrying next.",
      commandHint: continuationCommands(workDir).state,
      continuation: loopContinuation(workDir, state, config, "blocked", {
        stopReason: blockingAction?.reason || "Prior process-tree termination is unproven.",
      }),
    };
  }
  await writeNextPreflightProgressSnapshot(workDir, args, config);
  const doctor = await doctorSession({
    ...args,
    check_benchmark: false,
    checkBenchmark: false,
  });
  if (!doctor.ok) {
    const loopContract = doctor.loopContract || {};
    const blockingAction = blockingLoopAction(loopContract, doctor.canonicalNextAction);
    if (
      shouldRefuseBeforeRun({
        blockingAction,
        loopContract,
        capsule: currentState(doctor.workDir).sessionDecisionCapsule || null,
        args,
      })
    ) {
      const state = currentState(doctor.workDir);
      const capsule = state.sessionDecisionCapsule || null;
      return {
        ok: false,
        workDir: doctor.workDir,
        refused: true,
        code: "next_blocked_by_loop_contract",
        doctor,
        run: null as LooseObject | null,
        decision: null as LooseObject | null,
        blockingAction,
        loopContract,
        sessionDecisionCapsule: capsule,
        decisionEnvelope: {
          ...doctor.decisionEnvelope,
          loopContract,
          canonicalNextAction: blockingAction,
        },
        nextAction:
          blockingAction.reason ||
          capsule?.nextExperiment ||
          "Resolve loop-governance blockers before running another packet.",
        clearingCondition:
          capsule?.enforcement?.clearingCondition ||
          "Resolve the loop-governance blocker or warning, then retry next.",
        commandHint:
          blockingAction.command ||
          capsule?.enforcement?.commandHint ||
          continuationCommands(doctor.workDir).state,
        continuation: loopContinuation(doctor.workDir, state, config, "blocked", {
          stopReason:
            blockingAction.reason ||
            capsule?.nextExperiment ||
            "Loop contract blocked the next packet.",
        }),
      };
    }
    return {
      ok: false,
      workDir: doctor.workDir,
      doctor,
      run: null as LooseObject | null,
      decision: null as LooseObject | null,
      nextAction: doctor.nextAction,
      continuation: loopContinuation(
        doctor.workDir,
        currentState(doctor.workDir),
        config,
        "blocked",
        {
          stopReason: doctor.nextAction,
        },
      ),
    };
  }
  const stateBeforeRun = currentState(workDir);
  const lastRun = await readLastRunPacket(workDir).catch((): null => null);
  const lastRunFreshness = lastRun ? await lastRunPacketFreshness(workDir, lastRun, config) : null;
  const preflightEnvelope = withCanonicalActionCommand(
    buildDecisionEnvelope({
      state: stateBeforeRun,
      nextAction: "Run the next measured packet.",
      lastRunFreshness,
      finalization: doctor.decisionEnvelope?.finalizationReadiness || null,
    }),
    continuationCommands(workDir),
  );
  const loopContract = preflightEnvelope.loopContract || {};
  const blockingAction = blockingLoopAction(loopContract, preflightEnvelope.canonicalNextAction);
  const capsule = stateBeforeRun.sessionDecisionCapsule || null;
  const boundedNextAllowed =
    blockingAction?.kind === "decision-capsule" && isBoundedNextAllowedByCapsule(capsule, args);
  const loopBlockers = Array.isArray(loopContract.blockers) ? loopContract.blockers : [];
  const stalePacketReplacementAllowed =
    blockingAction?.kind === "stale-packet" &&
    loopBlockers.length > 0 &&
    loopBlockers.every((blocker: LooseObject) => blocker?.kind === "stale-packet");
  if (
    loopContract.canRunNextPacket === false &&
    !boundedNextAllowed &&
    !stalePacketReplacementAllowed
  ) {
    return {
      ok: false,
      workDir,
      refused: true,
      code: "next_blocked_by_loop_contract",
      doctor,
      run: null as LooseObject | null,
      decision: null as LooseObject | null,
      blockingAction,
      loopContract,
      sessionDecisionCapsule: capsule,
      decisionEnvelope: preflightEnvelope,
      nextAction:
        blockingAction?.reason ||
        capsule?.nextExperiment ||
        "Resolve loop-governance blockers before running another packet.",
      clearingCondition:
        capsule?.enforcement?.clearingCondition ||
        "Resolve the loop-governance blocker or warning, then retry next.",
      commandHint:
        blockingAction?.command ||
        capsule?.enforcement?.commandHint ||
        continuationCommands(workDir).state,
      continuation: loopContinuation(workDir, stateBeforeRun, config, "blocked", {
        stopReason:
          blockingAction?.reason ||
          capsule?.nextExperiment ||
          "Loop contract blocked the next packet.",
      }),
    };
  }
  const fixedControlCommandSource = await resolveBenchmarkCommandSource(args, workDir, {
    fallbackToDefault: true,
    requireCommand: true,
    config,
  });
  const fixedControlBlock = fixedControlBlockForCommand(
    fixedControlCommandSource.command,
    config,
    args,
  );
  if (fixedControlBlock) {
    const nextAction =
      fixedControlBlock.message ||
      "A fixed control artifact is active; reuse it instead of rerunning the control command.";
    return {
      ok: false,
      workDir,
      refused: true,
      code: fixedControlBlock.code,
      doctor: fixedControlBlockedDoctorSummary(doctor),
      run: null as LooseObject | null,
      decision: null as LooseObject | null,
      fixedControlViolation: fixedControlBlock.fixedControlViolation,
      nextAction,
      clearingCondition:
        "Reuse the fixed control artifact, update the fixedControl config when an invalidator changes, or pass --allow-fixed-control-rerun explicitly.",
      commandHint: fixedControlBlock.commandHint || continuationCommands(workDir).state,
      continuation: loopContinuation(workDir, stateBeforeRun, config, "blocked", {
        stopReason: nextAction,
      }),
    };
  }
  const preRunGit = await lastRunGitSnapshot(workDir, config).catch((error: any) => ({
    inside: null as boolean | null,
    error: error.message || String(error),
  }));
  if (gitSnapshotContainsDirtyFingerprintTruncation(preRunGit)) {
    const nextAction =
      "Clean or narrow the dirty tree before running next; dirty file fingerprints were truncated before packet freshness could be proven.";
    return {
      ok: false,
      workDir,
      refused: true,
      code: "next_blocked_by_truncated_fingerprints",
      doctor,
      run: null as LooseObject | null,
      decision: null as LooseObject | null,
      git: preRunGit,
      nextAction,
      clearingCondition:
        "Commit, stash, remove, or scope the dirty files so Autoresearch can fingerprint the packet inputs, then retry next.",
      commandHint: continuationCommands(workDir).state,
      continuation: loopContinuation(workDir, stateBeforeRun, config, "blocked", {
        stopReason: nextAction,
      }),
    };
  }
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
    continuation: loopContinuation(workDir, currentState(workDir), config, "needs-log-decision", {
      requiredStatus: run.logHint.status,
    }),
  };
  await writeLastRunPacket(run.workDir, packet, lastRunFile);
  return boolOption(args.compact, false) ? compactNextExperimentPacket(packet) : packet;
}

async function runStandaloneExperiment(args: LooseObject) {
  const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
  return await runWithRequiredCleanup(
    async () => {
      const retainedProgress = await readActiveProgressSnapshot(workDir);
      if (retainedProgress?.exitState === "termination_failed") {
        const error = new Error(
          "Prior process-tree termination is unproven. Verify the reported PID and descendants are absent, then clear retained progress before another run.",
        ) as Error & { code: string };
        error.code = "termination_failed";
        throw error;
      }
      return await runExperiment(args);
    },
    () => deleteActiveProgressSnapshotIfSafe(workDir),
    "Failed to remove active progress snapshot",
  );
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

function blockingLoopAction(loopContract: LooseObject, canonicalNextAction: LooseObject | null) {
  const strongestAction = loopContract?.strongestAction || null;
  if (
    strongestAction &&
    canonicalNextAction &&
    strongestAction.kind === canonicalNextAction.kind &&
    canonicalNextAction.command &&
    !strongestAction.command
  ) {
    return { ...strongestAction, command: canonicalNextAction.command };
  }
  return strongestAction || canonicalNextAction || null;
}

function shouldRefuseBeforeRun({
  blockingAction,
  loopContract,
  capsule,
  args,
}: {
  blockingAction: LooseObject | null;
  loopContract: LooseObject;
  capsule: LooseObject | null;
  args: LooseObject;
}) {
  if (!blockingAction || loopContract.canRunNextPacket !== false) return false;
  if (blockingAction.kind === "current-tree-finalization") return true;
  if (blockingAction.kind !== "decision-capsule") return false;
  return !isBoundedNextAllowedByCapsule(capsule as any, args);
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
  await outsideWorkdirAuthorization.run(boolOption(args.allowOutsideWorkdir, false), async () => {
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
      initExperiment,
      integrationsCommand: integrationsCommandLazy,
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
      recommendNext,
      sessionForensics,
      recipeCommand,
      researchFanout,
      laneRunner,
      runExperiment: runStandaloneExperiment,
      serveDashboard,
      setupPlan,
      researchStart,
      setupResearchSession,
      setupSession,
    });
    const execute = async () => {
      try {
        const outcome = (await runCliCommand(command, args, handlers)) as LooseObject;
        if (command !== "next" && command !== "run") {
          const evidence = terminationFailureEvidence(outcome.result);
          if (evidence) {
            const resolution = resolveWorkDir(args.workingDir || args.working_dir || args.cwd);
            await persistTerminationFailure(resolution.workDir, command, evidence);
          }
        }
        return outcome;
      } catch (error: any) {
        const evidence = terminationFailureEvidence(error);
        if (evidence) {
          const resolution = resolveWorkDir(args.workingDir || args.working_dir || args.cwd);
          await persistTerminationFailure(resolution.workDir, command, evidence);
        }
        throw error;
      }
    };
    let outcome: LooseObject;
    if (requiresSessionMutationLock(command, args)) {
      const resolution = resolveWorkDir(args.workingDir || args.cwd);
      const lock = await sessionMutationLockLocation(resolution.workDir);
      outcome = await withSessionMutationLock(lock.root, command, execute, lock.path);
    } else {
      outcome = await execute();
    }
    if (outcome.text != null) {
      writeStdout(outcome.text);
      return;
    }
    writeStdout(JSON.stringify(redactCliResponseForOutput(outcome.result), null, 2));
    if (outcome.keepAlive) return await new Promise(() => {});
  });
}

function requiresSessionMutationLock(command: string, args: LooseObject): boolean {
  if (boolOption(args.dryRun, false)) return false;
  if (command === "ledger-doctor") return boolOption(args.repair, false);
  if (command === "doctor") return boolOption(args.checkBenchmark || args.check_benchmark, false);
  if (command === "gap-candidates") {
    return boolOption(args.apply, false) || Boolean(args.modelCommand || args.model_command);
  }
  if (command === "partial-results") return boolOption(args.record, false);
  if (command === "session-forensics") return boolOption(args.apply, false);
  if (command === "integrations")
    return !["list", "status", "doctor"].includes(String(args._[1] || "list"));
  return new Set([
    "setup",
    "research-setup",
    "research-start",
    "research-fanout",
    "lane-runner",
    "benchmark-lint",
    "benchmark-inspect",
    "checks-inspect",
    "config",
    "finalize-current-tree",
    "init",
    "run",
    "next",
    "log",
    "new-segment",
    "promote-gate",
    "clear",
  ]).has(command);
}

async function main() {
  const code = await runAutoresearchCli(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  void main();
}
