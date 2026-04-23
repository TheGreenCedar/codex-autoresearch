#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { buildDashboardViewModel } from "../lib/dashboard-view-model.js";
import { createCliCommandHandlers, runCliCommand } from "../lib/cli-handlers.js";
import { buildDriftReport } from "../lib/drift-doctor.js";
import { buildExperimentMemory } from "../lib/experiment-memory.js";
import { finalizePreview as buildFinalizePreview } from "../lib/finalize-preview.js";
import { integrationsCommand } from "../lib/integrations.js";
import { createMcpInterface } from "../lib/mcp-interface.js";
import {
  gapCandidates as buildGapCandidates,
  researchRoundGuidance,
  resolveResearchSlugForQualityGapSync,
} from "../lib/research-gaps.js";
import {
  applyResolvedRecipeDefaults,
  findRecipe,
  getBuiltInRecipe,
  listBuiltInRecipes,
  loadRecipeCatalog,
  recommendRecipe,
} from "../lib/recipes.js";
import { serveAutoresearch } from "../lib/live-server.js";
import {
  STATUS_VALUES,
  FAILURE_STATUSES,
  finiteMetric,
  isBaselineEligibleMetricRun,
} from "../lib/session-core.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";

type LooseObject = Record<string, any>;

interface LocalProcessResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

interface LocalShellResult {
  command: string;
  durationSeconds: number;
  exitCode: number | null;
  fullOutput: string;
  fullOutputTruncated: boolean;
  metricOutput: string;
  metricOutputTruncated: boolean;
  output: string;
  outputTruncated: boolean;
  retainedMetricOutput: string;
  timedOut: boolean;
}

const SESSION_FILES = [
  "autoresearch.jsonl",
  "autoresearch.md",
  "autoresearch.ideas.md",
  "autoresearch.sh",
  "autoresearch.ps1",
  "autoresearch.checks.sh",
  "autoresearch.checks.ps1",
  "autoresearch.config.json",
  "autoresearch.last-run.json",
];
const RESEARCH_DIR = "autoresearch.research";

const AUTONOMY_MODES = new Set(["guarded", "owner-autonomous", "manual"]);
const CHECKS_POLICIES = new Set(["always", "on-improvement", "manual"]);
const KEEP_POLICIES = new Set(["primary-only", "primary-or-risk-reduction"]);
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const METRIC_NAME_PATTERN = /^[^=\s]+$/;
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const OUTPUT_CAPTURE_BYTES = 16384;
const FULL_OUTPUT_CAPTURE_BYTES = 1024 * 1024;
const METRIC_LINE_MAX_CHARS = 4096;
const METRIC_OUTPUT_CAPTURE_BYTES = 64 * 1024;
const MAX_PARSED_METRICS = 512;
const MAX_MCP_FRAME_BYTES = 1024 * 1024;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const MCP_SCRIPT_PATH = path.join(PLUGIN_ROOT, "scripts", "autoresearch-mcp.mjs");
const PLUGIN_VERSION = "0.6.0";
const DASHBOARD_TEMPLATE_PATH = path.join(PLUGIN_ROOT, "assets", "template.html");
const DASHBOARD_BUILD_DIR = path.join(PLUGIN_ROOT, "assets", "dashboard-build");
const DASHBOARD_DATA_PLACEHOLDER = "__AUTORESEARCH_DATA_PAYLOAD__";
const DASHBOARD_META_PLACEHOLDER = "__AUTORESEARCH_META_PAYLOAD__";
const DASHBOARD_APP_PLACEHOLDER = "__AUTORESEARCH_DASHBOARD_APP__";
const DASHBOARD_CSS_PLACEHOLDER = "__AUTORESEARCH_DASHBOARD_CSS__";
const EMPTY_COMMIT_PATHS_WARNING_CODE = "empty_commit_paths_in_git_repo";
const liveDashboardServers = new Set();

function usage() {
  return `Codex Autoresearch

Usage:
  node scripts/autoresearch.mjs setup --cwd <project> --name <name> --metric-name <name> [--recipe <id>] [--catalog <path-or-url>] [--benchmark-command <cmd>] [--checks-command <cmd>] [--shell bash|powershell] [--max-iterations <n>]
  node scripts/autoresearch.mjs setup --cwd <project> --interactive
  node scripts/autoresearch.mjs setup-plan --cwd <project> [--recipe <id>] [--catalog <path-or-url>] [--name <name>] [--metric-name <name>] [--benchmark-command <cmd>] [--checks-command <cmd>] [--commit-paths <paths>] [--max-iterations <n>]
  node scripts/autoresearch.mjs guide --cwd <project> [--recipe <id>] [--catalog <path-or-url>] [--name <name>] [--metric-name <name>] [--benchmark-command <cmd>] [--checks-command <cmd>] [--commit-paths <paths>] [--max-iterations <n>]
  node scripts/autoresearch.mjs recipes list|show [recipe-id] [--catalog <path-or-url>]
  node scripts/autoresearch.mjs init --cwd <project> --name <name> --metric-name <name> [--metric-unit <unit>] [--direction lower|higher]
  node scripts/autoresearch.mjs run --cwd <project> [--command <cmd>] [--timeout-seconds <n>]
  node scripts/autoresearch.mjs next --cwd <project> [--command <cmd>] [--timeout-seconds <n>]
  node scripts/autoresearch.mjs config --cwd <project> [--autonomy-mode guarded|owner-autonomous|manual] [--checks-policy always|on-improvement|manual] [--extend <n>]
  node scripts/autoresearch.mjs research-setup --cwd <project> --slug <slug> --goal <goal> [--checks-command <cmd>] [--max-iterations <n>]
  node scripts/autoresearch.mjs quality-gap --cwd <project> [--research-slug <slug>] [--list] [--json]
  node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug> [--apply] [--model-command <cmd>] [--model-timeout-seconds <n>]
  node scripts/autoresearch.mjs finalize-preview --cwd <project> [--trunk main]
  node scripts/autoresearch.mjs serve --cwd <project> [--port <n>]
  node scripts/autoresearch.mjs integrations list|doctor|sync-recipes [--catalog <path-or-url>]
  node scripts/autoresearch.mjs log --cwd <project> (--metric <n>|--from-last) --status keep|discard|crash|checks_failed --description <text> [--metrics <json>] [--asi <json>] [--commit-paths <paths>] [--allow-add-all] [--revert-paths <paths>]
  node scripts/autoresearch.mjs state --cwd <project>
  node scripts/autoresearch.mjs doctor --cwd <project> [--command <cmd>] [--check-benchmark]
  node scripts/autoresearch.mjs export --cwd <project> [--output <html>] [--json-full|--verbose]
  node scripts/autoresearch.mjs clear --cwd <project> [--dry-run|--yes]
  node scripts/autoresearch.mjs mcp-smoke
  node scripts/autoresearch.mjs --mcp

Benchmark output format:
  METRIC name=value
`;
}

function parseCliArgs(argv): LooseObject {
  const out: LooseObject = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const equalsAt = arg.indexOf("=");
    const rawKey = equalsAt > 2 ? arg.slice(2, equalsAt) : arg.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (equalsAt > 2) {
      out[key] = arg.slice(equalsAt + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseJsonOption(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON option: ${error.message}`);
  }
}

function numberOption(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}`);
  return parsed;
}

function positiveIntegerOption(value, fallback, optionName) {
  const parsed = numberOption(value, fallback);
  if (parsed == null) return parsed;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer. Got ${value}`);
  }
  return parsed;
}

function nonNegativeIntegerOption(value, fallback, optionName) {
  const parsed = numberOption(value, fallback);
  if (parsed == null) return parsed;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer. Got ${value}`);
  }
  return parsed;
}

function boolOption(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function enumOption(value, allowed, fallback, optionName) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`${optionName} must be one of ${[...allowed].join(", ")}. Got ${value}`);
  }
  return normalized;
}

function listOption(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeSlug(value, fallback = "research") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function validateMetricName(name) {
  if (!METRIC_NAME_PATTERN.test(String(name || "")) || DENIED_METRIC_NAMES.has(String(name))) {
    throw new Error(
      `Metric name must match the METRIC parser grammar: one non-empty token without whitespace or "=". Got ${name}`,
    );
  }
  return String(name);
}

function normalizeRelativePaths(paths, optionName = "paths") {
  return listOption(paths).map((item) => {
    const normalized = item.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (
      !normalized ||
      normalized === "." ||
      path.isAbsolute(normalized) ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized === ".." ||
      normalized.startsWith(".git/") ||
      normalized === ".git"
    ) {
      throw new Error(
        `${optionName} must contain project-relative paths that do not escape the working directory: ${item}`,
      );
    }
    return normalized.replace(/\/$/, "");
  });
}

function resolveOutputInside(workDir, output) {
  const target = path.resolve(workDir, output || "autoresearch-dashboard.html");
  const relative = path.relative(workDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Dashboard output is outside the working directory: ${target}`);
  }
  return target;
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function readConfig(sessionCwd) {
  const configPath = path.join(sessionCwd, "autoresearch.config.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function runtimeConfigPath(sessionCwd) {
  return path.join(sessionCwd, "autoresearch.config.json");
}

function resolveWorkDir(cwdArg) {
  const sessionCwd = path.resolve(
    cwdArg || process.env.CODEX_AUTORESEARCH_WORKDIR || process.cwd(),
  );
  const config = readConfig(sessionCwd);
  const workDir = config.workingDir ? path.resolve(sessionCwd, config.workingDir) : sessionCwd;
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error(`Working directory does not exist: ${workDir}`);
  }
  return { sessionCwd, workDir, config };
}

function jsonlPath(workDir) {
  return path.join(workDir, "autoresearch.jsonl");
}

function assetPath(fileName) {
  return path.join(PLUGIN_ROOT, "assets", fileName);
}

function readAssetTemplate(fileName) {
  return fs.readFileSync(assetPath(fileName), "utf8");
}

function replaceAllText(text, replacements) {
  let out = text;
  for (const [from, to] of Object.entries(replacements)) {
    out = out.split(from).join(String(to));
  }
  return out;
}

function shellKindFromArgs(args) {
  const requested = String(args.shell || args.script || "").toLowerCase();
  if (["bash", "sh", "posix"].includes(requested)) return "bash";
  if (["powershell", "pwsh", "ps1", "windows"].includes(requested)) return "powershell";
  return process.platform === "win32" ? "powershell" : "bash";
}

async function withRecipeDefaults(args) {
  const recipeId = args.recipe_id ?? args.recipeId ?? args.recipe;
  return recipeId ? await applyResolvedRecipeDefaults(args, recipeId, args.catalog) : args;
}

async function setupPlan(args) {
  const { sessionCwd, workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const requestedRecipe = args.recipe_id ?? args.recipeId ?? args.recipe;
  const storedRecipe = config?.recipeId;
  let recommended = null;
  if (requestedRecipe) {
    recommended = await findRecipe(requestedRecipe, args.catalog);
    if (!recommended) throw new Error(`Unknown recipe: ${requestedRecipe}`);
  } else if (storedRecipe) {
    recommended =
      (await findRecipe(storedRecipe, args.catalog)) || (await recommendRecipe(workDir));
  } else {
    recommended = await recommendRecipe(workDir);
  }
  const state = currentState(workDir);
  const hasDefaultBenchmarkCommand = await defaultBenchmarkCommandExists(workDir);
  const hasBenchmarkInput = Boolean(args.benchmark_command || args.benchmarkCommand);
  const missing = [];
  if (!args.name && !state.config.name && !recommended) missing.push("name");
  if (!args.metric_name && !args.metricName && !state.config.metricName && !recommended)
    missing.push("metric_name");
  if (state.current.length === 0 && !hasBenchmarkInput && !hasDefaultBenchmarkCommand) {
    missing.push("benchmark_command");
  }
  const planArgs = await withRecipeDefaults({
    ...args,
    recipe: recommended?.id,
    name: args.name || recommended?.title || "Autoresearch session",
  });
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
  const benchmarkCommand = planArgs.benchmark_command || planArgs.benchmarkCommand || "";
  const checksCommand = planArgs.checks_command || planArgs.checksCommand || "";
  const command = [
    "node",
    shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs")),
    "setup",
    "--cwd",
    shellQuote(workDir),
    "--name",
    shellQuote(planArgs.name || "Autoresearch session"),
    "--metric-name",
    shellQuote(planArgs.metric_name || planArgs.metricName || "seconds"),
    "--direction",
    shellQuote(planArgs.direction || "lower"),
    "--shell",
    shellQuote(shellKind),
    benchmarkCommand ? `--benchmark-command ${shellQuote(benchmarkCommand)}` : "",
    checksCommand ? `--checks-command ${shellQuote(checksCommand)}` : "",
    setupMaxIterations != null ? `--max-iterations ${shellQuote(setupMaxIterations)}` : "",
    commitPaths.length > 0 ? `--commit-paths ${shellQuote(commitPaths.join(","))}` : "",
    recommended ? `--recipe ${shellQuote(recommended.id)}` : "",
    args.catalog ? `--catalog ${shellQuote(args.catalog)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const doctorCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} doctor --cwd ${shellQuote(workDir)} --check-benchmark`;
  const baselineCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)}`;
  const logCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} log --cwd ${shellQuote(workDir)} --from-last --status keep --description ${shellQuote("Describe the kept change")}`;
  const guideCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} guide --cwd ${shellQuote(workDir)}`;
  return {
    ok: true,
    workDir,
    sessionCwd,
    configured: Boolean(config && Object.keys(config).length > 0),
    currentMetric: state.config.metricName,
    recommendedRecipe: recommended,
    missing,
    defaultBenchmarkCommandReady: hasDefaultBenchmarkCommand,
    nextCommand: command,
    guideCommand,
    baselineCommand,
    guidedFlow: [
      { step: "setup", command, purpose: "Create the session files and metric config." },
      {
        step: "doctor",
        command: doctorCommand,
        purpose: "Verify the benchmark emits the configured metric.",
      },
      { step: "baseline", command: baselineCommand, purpose: "Run the first measured packet." },
      {
        step: "log",
        command: logCommand,
        purpose: "Record the last packet with a deliberate keep/discard decision.",
      },
    ],
    notes: [
      "setup-plan is read-only.",
      "Generated recipe scripts remain inspectable and should be checked with doctor before logging a keep.",
    ],
  };
}

async function guidedSetup(args) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const setup = await setupPlan(args);
  const state = await publicState({ cwd: workDir });
  const doctor = await doctorSession({ cwd: workDir, checkBenchmark: false });
  const lastRun = await readLastRunPacket(workDir).catch(() => null);
  const lastRunFingerprint = lastRun ? await lastRunPacketFingerprint(workDir).catch(() => "") : "";
  const lastRunFreshness = lastRun ? await lastRunPacketFreshness(workDir, lastRun) : null;
  const lastRunLogStatus = lastRun
    ? lastRun.decision?.safeSuggestedStatus ||
      lastRun.decision?.suggestedStatus ||
      (lastRun.decision?.allowedStatuses?.length === 1
        ? lastRun.decision.allowedStatuses[0]
        : "discard")
    : "";
  const replaceLastRunCommand = lastRun
    ? replacementNextCommandFromLastRun(workDir, lastRun, setup.defaultBenchmarkCommandReady)
    : "";
  const dashboardCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} serve --cwd ${shellQuote(workDir)}`;
  const baselineCommand = setup.baselineCommand;
  const logCommand = lastRun
    ? `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} log --cwd ${shellQuote(workDir)} --from-last --status ${shellQuote(lastRunLogStatus)} --description ${shellQuote("Describe the last packet")}`
    : setup.guidedFlow.find((step) => step.step === "log")?.command;
  let stage = "ready";
  let nextAction = "Run the next measured packet.";
  if (setup.missing.length && state.runs === 0) {
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
  return {
    ok: doctor.issues.length === 0,
    workDir,
    stage,
    setup,
    state,
    doctor: {
      ok: doctor.ok,
      issues: doctor.issues,
      warnings: doctor.warnings,
      nextAction: doctor.nextAction,
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
          path: lastRun.lastRunPath || "",
          fingerprint: lastRunFingerprint,
          freshness: lastRunFreshness,
        }
      : null,
    commands: {
      setup: setup.nextCommand,
      doctor: setup.guidedFlow.find((step) => step.step === "doctor")?.command,
      baseline: baselineCommand,
      logLast: logCommand,
      replaceLast: replaceLastRunCommand,
      dashboard: dashboardCommand,
    },
    settings: dashboardSettings(config),
    diversityGuidance: state.memory?.diversityGuidance || null,
    lanePortfolio: state.memory?.lanePortfolio || [],
    nextAction,
  };
}

function replacementNextCommandFromLastRun(workDir, packet, defaultBenchmarkCommandReady) {
  const parts = [
    "node",
    shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs")),
    "next",
    "--cwd",
    shellQuote(workDir),
  ];
  const command = packet?.run?.command;
  if (command) {
    parts.push("--command", shellQuote(command));
  } else if (!defaultBenchmarkCommandReady) {
    return "";
  }
  const checksPolicy = packet?.run?.checksPolicy;
  if (CHECKS_POLICIES.has(checksPolicy)) {
    parts.push("--checks-policy", shellQuote(checksPolicy));
  }
  const checksCommand = packet?.run?.checks?.command;
  if (checksCommand) {
    parts.push("--checks-command", shellQuote(checksCommand));
  }
  return parts.join(" ");
}

async function recipeCommand(subcommand, args) {
  if (!subcommand || subcommand === "list") {
    const catalogRecipes = args.catalog ? await loadRecipeCatalog(args.catalog) : [];
    return { ok: true, recipes: [...listBuiltInRecipes(), ...catalogRecipes] };
  }
  if (subcommand === "show") {
    const id = args._[2] || args.id || args.recipe || args.recipeId;
    if (!id) throw new Error("recipes show requires a recipe id");
    const catalogRecipes = args.catalog ? await loadRecipeCatalog(args.catalog) : [];
    const recipe = [...listBuiltInRecipes(), ...catalogRecipes].find((item) => item.id === id);
    if (!recipe) throw new Error(`Unknown recipe: ${id}`);
    return { ok: true, recipe };
  }
  throw new Error(`Unknown recipes subcommand: ${subcommand}`);
}

async function interactiveSetup(args) {
  const plan = await setupPlan(args);
  const recipe = plan.recommendedRecipe || getBuiltInRecipe("custom");
  const rl = createInterface({ input, output });
  try {
    const ask = async (prompt, fallback) => {
      const answer = await rl.question(`${prompt}${fallback ? ` (${fallback})` : ""}: `);
      return answer.trim() || fallback;
    };
    const selectedRecipeId = await ask("Recipe id", recipe?.id || "custom");
    const selectedRecipe = await findRecipe(selectedRecipeId, args.catalog);
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

function markdownList(items, emptyText) {
  if (!items.length) return `- ${emptyText}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function renderSessionDocument(args) {
  const scope = listOption(args.files_in_scope ?? args.filesInScope ?? args.scope);
  const offLimits = listOption(args.off_limits ?? args.offLimits);
  const constraints = listOption(args.constraints);
  const constraintsPlaceholder =
    "- <Correctness, compatibility, dependency," + " or budget constraints>";
  const secondary = listOption(args.secondary_metrics ?? args.secondaryMetrics);
  const benchmarkCommand = args.benchmark_command || args.benchmarkCommand || "./autoresearch.sh";
  const metricUnit = args.metric_unit ?? args.metricUnit ?? "";
  const direction = args.direction === "higher" ? "higher" : "lower";
  const primaryMetric = validateMetricName(args.metric_name || args.metricName);
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
      constraints,
      "TBD: add correctness and compatibility constraints",
    ),
    "- Baseline: <initial metric and notes>": "- Baseline: pending",
  });
}

function renderResumeBlock(workDir) {
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

function renderBenchmarkScript(args, shellKind) {
  const command =
    args.benchmark_command || args.benchmarkCommand || "# TODO: replace with the real workload";
  const metricName = validateMetricName(args.metric_name || args.metricName || "elapsed_seconds");
  if (boolOption(args.benchmark_prints_metric ?? args.benchmarkPrintsMetric, false)) {
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

function renderChecksScript(args, shellKind) {
  const command = args.checks_command || args.checksCommand || "# TODO: add correctness checks";
  const templateName =
    shellKind === "bash" ? "autoresearch.checks.sh.template" : "autoresearch.checks.ps1.template";
  return replaceAllText(readAssetTemplate(templateName), {
    "<check command>": command,
  });
}

function researchSlugFromArgs(args) {
  return safeSlug(args.research_slug ?? args.researchSlug ?? args.slug ?? args.name ?? "research");
}

function researchRelativeDir(slug) {
  return `${RESEARCH_DIR}/${slug}`;
}

function researchDirPath(workDir, slug) {
  return path.join(workDir, RESEARCH_DIR, slug);
}

function renderResearchBenchmarkScript(slug, shellKind) {
  const script = path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs");
  if (shellKind === "bash") {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      `${shellQuote(process.execPath)} ${shellQuote(script)} quality-gap --cwd . --research-slug ${shellQuote(slug)}`,
      "",
    ].join("\n");
  }
  return [
    '$ErrorActionPreference = "Stop"',
    "",
    `& ${shellQuote(process.execPath)} ${shellQuote(script)} quality-gap --cwd . --research-slug ${shellQuote(slug)}`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "",
  ].join("\n");
}

function researchTitle(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

const RESEARCH_FILE_TEMPLATES = {
  "brief.md": ({ title, goal, args }) => `# Research Brief: ${title}

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
  "plan.md": ({ title }) => `# Research Plan: ${title}

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
  "tasks.md": ({ title }) => `# Research Tasks: ${title}

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
  "sources.md": ({ title }) => `# Research Sources: ${title}

| Source | Date Checked | Claim Supported | Confidence |
| --- | --- | --- | --- |
| TBD | TBD | TBD | TBD |
`,
  "synthesis.md": ({ title }) => `# Research Synthesis: ${title}

## Project Essence
- TBD: summarize what the project is trying to become.

## High-Impact Findings
- TBD: list source-backed findings and why they matter.

## Quality-Gap Translation
- Keep \`quality-gaps.md\` aligned with the current synthesis.

## Confidence And Gaps
- TBD: record confidence, contradictions, and unresolved questions.
`,
  "quality-gaps.md": ({ title }) => `# Quality Gaps: ${title}

- [ ] Project essence is accurate and source-backed.
- [ ] Sources are logged with dates, claims, and confidence.
- [ ] Synthesis separates high-impact changes from small QoL fixes.
- [ ] Each high-impact recommendation is implemented or rejected with evidence.
- [ ] Correctness checks pass after kept changes.
- [ ] Final handoff includes dashboard or state evidence.
`,
};

function renderResearchFile(fileName, args, slug) {
  const goal = args.goal || args.name || slug;
  const renderer = RESEARCH_FILE_TEMPLATES[fileName];
  if (renderer) return renderer({ title: researchTitle(goal), goal, args });
  throw new Error(`Unknown research file template: ${fileName}`);
}

function parseQualityGaps(text) {
  const items = parseQualityGapItems(text);
  return {
    open: items.open.length,
    closed: items.closed.length,
    total: items.open.length + items.closed.length,
  };
}

function parseQualityGapItems(text) {
  const open = [];
  const closed = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/);
    if (!match) continue;
    const item = match[2].trim();
    if (match[1].toLowerCase() === "x") closed.push(item);
    else open.push(item);
  }
  return { open, closed };
}

async function writeSessionFile(filePath, content, options: LooseObject = {}) {
  const exists = await pathExists(filePath);
  if (exists && !options.overwrite) return { path: filePath, action: "kept" };
  await fsp.writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  if (options.executable) {
    await fsp.chmod(filePath, 0o755).catch(() => {});
  }
  return { path: filePath, action: exists ? "overwritten" : "created" };
}

function appendJsonl(workDir, entry) {
  fs.appendFileSync(jsonlPath(workDir), JSON.stringify(entry) + os.EOL);
}

function readJsonl(workDir) {
  const filePath = jsonlPath(workDir);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: ${error.message}`);
      }
    });
}

function currentState(workDir) {
  const entries = readJsonl(workDir);
  let config = {
    name: null,
    metricName: "metric",
    metricUnit: "",
    bestDirection: "lower",
  };
  let segment = 0;
  const results = [];
  for (const entry of entries) {
    if (entry.type === "config") {
      if (results.length > 0) segment += 1;
      config = {
        name: entry.name || config.name,
        metricName: entry.metricName || config.metricName,
        metricUnit: entry.metricUnit ?? config.metricUnit,
        bestDirection: entry.bestDirection === "higher" ? "higher" : "lower",
      };
      continue;
    }
    if (entry.run != null) {
      const run = { ...entry, segment: entry.segment ?? segment };
      if (Object.hasOwn(entry, "metric")) run.metric = finiteMetric(entry.metric);
      results.push(run);
    }
  }
  const current = results.filter((run) => run.segment === segment);
  const baseline = finiteMetric(current.find(isBaselineEligibleMetricRun)?.metric);
  const best = bestKeptMetric(current, config.bestDirection);
  const confidence = computeConfidence(current, config.bestDirection);
  return { config, segment, results, current, baseline, best, confidence };
}

function iterationLimitInfo(state, runtimeConfig) {
  const maxIterations = Number(runtimeConfig.maxIterations);
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) {
    return {
      maxIterations: null,
      remainingIterations: null,
      limitReached: false,
    };
  }
  const max = Math.floor(maxIterations);
  const remaining = Math.max(0, max - state.current.length);
  return {
    maxIterations: max,
    remainingIterations: remaining,
    limitReached: state.current.length >= max,
  };
}

function bestMetric(runs, direction) {
  let best = null;
  for (const run of runs) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    if (best == null || isBetter(metric, best, direction)) best = metric;
  }
  return best;
}

function bestKeptMetric(runs, direction) {
  return bestMetric(
    runs.filter((run) => run.status === "keep"),
    direction,
  );
}

function isBetter(value, current, direction) {
  return direction === "higher" ? value > current : value < current;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeConfidence(runs, direction) {
  const values = runs.filter(isBaselineEligibleMetricRun).map((run) => finiteMetric(run.metric));
  if (values.length < 3) return null;
  const baseline = values[0];
  const best = bestKeptMetric(runs, direction);
  if (best == null || best === baseline) return null;
  const med = median(values);
  const mad = median(values.map((value) => Math.abs(value - med)));
  if (mad === 0) return null;
  return Math.abs(best - baseline) / mad;
}

function parseMetricLines(output, options: LooseObject = {}): any {
  const metrics = {};
  const maxMetrics =
    Number.isInteger(options.maxMetrics) && options.maxMetrics > 0 ? options.maxMetrics : Infinity;
  const primaryMetricName = options.primaryMetricName ? String(options.primaryMetricName) : "";
  const withTruncation = Boolean(options.withTruncation);
  let truncated = false;
  let retainedCount = 0;
  const regex = /^METRIC\s+([^=\s]+)=(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/gim;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (Object.hasOwn(metrics, name)) {
      metrics[name] = value;
    } else if (name === primaryMetricName || retainedCount < maxMetrics) {
      metrics[name] = value;
      retainedCount += 1;
    } else {
      truncated = true;
    }
  }
  return withTruncation ? { metrics, truncated } : metrics;
}

function metricParseSource(result) {
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

function metricLineName(line) {
  const match = String(line || "")
    .trim()
    .match(/^METRIC\s+([^=\s]+)=/i);
  return match && !DENIED_METRIC_NAMES.has(match[1]) ? match[1] : "";
}

function tailText(text, maxLines = OUTPUT_MAX_LINES, maxBytes = OUTPUT_MAX_BYTES) {
  let trimmed = text;
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    const buf = Buffer.from(trimmed, "utf8");
    trimmed = buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > maxLines) trimmed = lines.slice(-maxLines).join("\n");
  return trimmed;
}

async function runShell(
  command,
  cwd,
  timeoutSeconds,
  options: LooseObject = {},
): Promise<LocalShellResult> {
  const startedAt = Date.now();
  return await new Promise<LocalShellResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let fullOutput = "";
    let metricOutput = "";
    let metricOutputBytes = 0;
    let pendingMetricText = "";
    const retainedMetricNames = new Set(
      (options.retainMetricNames || []).map(String).filter(Boolean),
    );
    const retainedMetricLines = new Map<string, string>();
    let outputTruncated = false;
    let fullOutputTruncated = false;
    let metricOutputTruncated = false;
    let timedOut = false;
    const appendMetricLine = (line: string) => {
      const name = metricLineName(line);
      if (name && retainedMetricNames.has(name)) {
        retainedMetricLines.set(name, line);
      }
      const text = `${line}\n`;
      const bytes = Buffer.byteLength(text, "utf8");
      if (metricOutputBytes + bytes > METRIC_OUTPUT_CAPTURE_BYTES) {
        metricOutputTruncated = true;
        return;
      }
      metricOutput += text;
      metricOutputBytes += bytes;
    };
    const appendMetricLines = (text: string) => {
      pendingMetricText += text;
      const lines = pendingMetricText.split(/\r?\n/);
      pendingMetricText = lines.pop() || "";
      if (pendingMetricText.length > METRIC_LINE_MAX_CHARS) {
        pendingMetricText = pendingMetricText.slice(-METRIC_LINE_MAX_CHARS);
      }
      for (const line of lines) {
        if (/^METRIC\s+/i.test(line.trim())) appendMetricLine(line);
      }
    };
    const appendOutput = (text: string) => {
      appendMetricLines(text);
      fullOutput += text;
      if (Buffer.byteLength(fullOutput, "utf8") > FULL_OUTPUT_CAPTURE_BYTES) {
        const buf = Buffer.from(fullOutput, "utf8");
        fullOutput = buf
          .subarray(Math.max(0, buf.length - FULL_OUTPUT_CAPTURE_BYTES))
          .toString("utf8");
        fullOutputTruncated = true;
      }
      output += text;
      if (Buffer.byteLength(output, "utf8") > OUTPUT_CAPTURE_BYTES) {
        const buf = Buffer.from(output, "utf8");
        output = buf.subarray(Math.max(0, buf.length - OUTPUT_CAPTURE_BYTES)).toString("utf8");
        outputTruncated = true;
      }
    };
    const timeout = setTimeout(
      () => {
        timedOut = true;
        killProcess(child.pid);
      },
      Math.max(1, timeoutSeconds) * 1000,
    );
    child.stdout.on("data", (chunk) => {
      appendOutput(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      appendOutput(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (/^METRIC\s+/i.test(pendingMetricText.trim())) appendMetricLine(pendingMetricText);
      const retainedMetricOutput = [...retainedMetricLines.values()]
        .map((line) => `${line}\n`)
        .join("");
      resolve({
        command,
        exitCode: null,
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
        output: String(error.stack || error.message || error),
        fullOutput: `${fullOutput}${fullOutput ? "\n" : ""}${String(error.stack || error.message || error)}`,
        metricOutput,
        retainedMetricOutput,
        metricOutputTruncated,
        outputTruncated,
        fullOutputTruncated,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (/^METRIC\s+/i.test(pendingMetricText.trim())) appendMetricLine(pendingMetricText);
      const retainedMetricOutput = [...retainedMetricLines.values()]
        .map((line) => `${line}\n`)
        .join("");
      resolve({
        command,
        exitCode: code,
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
        output,
        fullOutput,
        metricOutput,
        retainedMetricOutput,
        metricOutputTruncated,
        outputTruncated,
        fullOutputTruncated,
      });
    });
  });
}

function killProcess(pid?: number) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

async function defaultBenchmarkCommand(workDir) {
  if (await pathExists(path.join(workDir, "autoresearch.ps1"))) {
    return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
  }
  if (await pathExists(path.join(workDir, "autoresearch.sh"))) {
    return "bash ./autoresearch.sh";
  }
  throw new Error(
    "No command provided; expected autoresearch.ps1 or autoresearch.sh in the work directory.",
  );
}

async function defaultBenchmarkCommandExists(workDir) {
  return (
    (await pathExists(path.join(workDir, "autoresearch.ps1"))) ||
    (await pathExists(path.join(workDir, "autoresearch.sh")))
  );
}

async function defaultChecksCommand(workDir) {
  if (await pathExists(path.join(workDir, "autoresearch.checks.ps1"))) {
    return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.checks.ps1";
  }
  if (await pathExists(path.join(workDir, "autoresearch.checks.sh"))) {
    return "bash ./autoresearch.checks.sh";
  }
  return null;
}

function checksPolicyFromArgs(args, config) {
  return enumOption(
    args.checks_policy ?? args.checksPolicy ?? config.checksPolicy,
    CHECKS_POLICIES,
    "always",
    "checksPolicy",
  );
}

function shouldRunChecks(policy, context) {
  if (!context.benchmarkPassed || !context.primaryPresent || !context.checksCommand) return false;
  if (policy === "always") return true;
  if (policy === "on-improvement") return context.improvesPrimary || context.explicitChecksCommand;
  return context.explicitChecksCommand;
}

async function runProcess(
  command,
  args,
  cwd,
  options: LooseObject = {},
): Promise<LocalProcessResult> {
  return await new Promise<LocalProcessResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: String(error.message || error) }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.timeoutMs) {
      setTimeout(() => killProcess(child.pid), options.timeoutMs);
    }
  });
}

async function git(args, cwd): Promise<LocalProcessResult> {
  return await runProcess("git", args, cwd);
}

function gitOutput(result, fallback) {
  return (result.stderr || result.stdout || fallback || "").trim();
}

async function insideGitRepo(cwd) {
  const result = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.code === 0 && result.stdout.trim() === "true";
}

async function gitPrivatePath(cwd, relativePath) {
  const result = await git(["rev-parse", "--git-path", relativePath], cwd);
  if (result.code !== 0)
    throw new Error(`Git path lookup failed: ${gitOutput(result, "unknown error")}`);
  const filePath = result.stdout.trim();
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

async function shortHead(cwd) {
  const result = await git(["rev-parse", "--short=7", "HEAD"], cwd);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function resolveCommitRef(cwd, commit) {
  const value = String(commit || "").trim();
  if (!value) throw new Error("commit is required");
  const result = await git(["rev-parse", "--verify", `${value}^{commit}`], cwd);
  if (result.code !== 0)
    throw new Error(`Git commit could not be resolved: ${gitOutput(result, value)}`);
  return result.stdout.trim();
}

async function hasStagedChanges(cwd) {
  const result = await git(["diff", "--cached", "--quiet"], cwd);
  return result.code === 1;
}

async function isGitClean(cwd) {
  if (!(await insideGitRepo(cwd))) return null;
  const result = await git(["status", "--porcelain"], cwd);
  if (result.code !== 0) return false;
  return result.stdout.trim() === "";
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

async function gitStatusShort(cwd) {
  const result = await git(["status", "--porcelain=v1", "-uall"], cwd);
  if (result.code !== 0)
    throw new Error(`Git status failed: ${gitOutput(result, "unknown error")}`);
  return result.stdout.trim();
}

function hashText(value) {
  return createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

async function scopedFileFingerprints(workDir, paths = []) {
  const safePaths = normalizeRelativePaths(paths, "commitPaths");
  if (safePaths.length === 0) return [];
  const result = await git(["ls-files", "--", ...safePaths], workDir);
  if (result.code !== 0) return [];
  const files = result.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const fingerprints = [];
  for (const file of files) {
    const filePath = path.join(workDir, file);
    try {
      const bytes = await fsp.readFile(filePath);
      fingerprints.push({ path: file, hash: createHash("sha256").update(bytes).digest("hex") });
    } catch (error) {
      fingerprints.push({
        path: file,
        missing: true,
        error: error?.code || error?.message || String(error),
      });
    }
  }
  return fingerprints;
}

function dirtyPathsFromStatus(statusShort) {
  return String(statusShort || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawPath = /^.. /.test(line)
        ? line.slice(3).trim()
        : line.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim();
      const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
      return renamedPath.replace(/^"|"$/g, "").replace(/\\"/g, '"').replace(/\\/g, "/");
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

async function fileFingerprintsForPaths(workDir, paths = []) {
  const fingerprints = [];
  for (const file of [...new Set(paths)].sort((a, b) => a.localeCompare(b))) {
    const filePath = path.join(workDir, file);
    try {
      const stats = await fsp.lstat(filePath);
      if (stats.isDirectory()) {
        const children = await directoryFingerprints(workDir, file);
        fingerprints.push({ path: file, directory: true, files: children });
        continue;
      }
      if (stats.isSymbolicLink()) {
        fingerprints.push({ path: file, symlink: await fsp.readlink(filePath) });
        continue;
      }
      const bytes = await fsp.readFile(filePath);
      fingerprints.push({ path: file, hash: createHash("sha256").update(bytes).digest("hex") });
    } catch (error) {
      fingerprints.push({
        path: file,
        missing: true,
        error: error?.code || error?.message || String(error),
      });
    }
  }
  return fingerprints;
}

async function directoryFingerprints(workDir, rootPath) {
  const root = path.resolve(workDir, rootPath);
  const base = path.resolve(workDir);
  const relativeRoot = path.relative(base, root);
  if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) return [];
  const entries = [];
  async function visit(relativeDir) {
    const absoluteDir = path.join(workDir, relativeDir);
    const dirents = await fsp.readdir(absoluteDir, { withFileTypes: true });
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = path.join(relativeDir, dirent.name).replace(/\\/g, "/");
      const absolutePath = path.join(workDir, relativePath);
      if (dirent.isDirectory()) {
        entries.push({ path: relativePath, directory: true });
        await visit(relativePath);
      } else if (dirent.isSymbolicLink()) {
        entries.push({ path: relativePath, symlink: await fsp.readlink(absolutePath) });
      } else if (dirent.isFile()) {
        const bytes = await fsp.readFile(absolutePath);
        entries.push({
          path: relativePath,
          hash: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        const stats = await fsp.lstat(absolutePath);
        entries.push({ path: relativePath, type: stats.isFIFO() ? "fifo" : "other" });
      }
    }
  }
  await visit(rootPath);
  return entries;
}

async function lastRunGitSnapshot(workDir, config: LooseObject = {}) {
  if (!(await insideGitRepo(workDir).catch(() => false))) return { inside: false };
  const scopedPaths = normalizeRelativePaths(config.commitPaths, "commitPaths");
  const statusShort = await gitStatusShort(workDir);
  return {
    inside: true,
    head: await shortHead(workDir),
    dirty: Boolean(statusShort),
    statusHash: hashText(statusShort),
    scopedPaths,
    fileFingerprints: await scopedFileFingerprints(workDir, scopedPaths),
    dirtyFileFingerprints: await fileFingerprintsForPaths(
      workDir,
      dirtyPathsFromStatus(statusShort),
    ),
  };
}

async function preserveSessionFiles(workDir) {
  const saved = new Map();
  for (const file of SESSION_FILES) {
    const filePath = path.join(workDir, file);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      saved.set(file, { type: "file", bytes: fs.readFileSync(filePath) });
    }
  }
  const researchPath = path.join(workDir, RESEARCH_DIR);
  if (fs.existsSync(researchPath) && fs.statSync(researchPath).isDirectory()) {
    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-preserve-"));
    fs.cpSync(researchPath, tempPath, { recursive: true });
    saved.set(RESEARCH_DIR, { type: "dir", tempPath });
  }
  return saved;
}

async function restoreSessionFiles(workDir, saved) {
  for (const [file, artifact] of saved.entries()) {
    const filePath = path.join(workDir, file);
    if (artifact.type === "dir") {
      await fsp.rm(filePath, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.cp(artifact.tempPath, filePath, { recursive: true });
      await fsp.rm(artifact.tempPath, { recursive: true, force: true });
    } else {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, artifact.bytes);
    }
  }
}

async function appendSessionRunNote(workDir, experiment, state, messages: LooseObject = {}) {
  const filePath = path.join(workDir, "autoresearch.md");
  if (!(await pathExists(filePath))) return;
  const parts = [
    `- Run ${experiment.run} ${experiment.status}: ${experiment.description}`,
    `metric=${experiment.metric}`,
    `best=${state.best ?? "unknown"}`,
  ];
  if (experiment.commit) parts.push(`commit=${experiment.commit}`);
  if (messages.revertMessage) parts.push(messages.revertMessage);
  if (messages.gitMessage && experiment.status === "keep") parts.push(messages.gitMessage);
  await fsp.appendFile(filePath, `\n${parts.join("; ")}.\n`, "utf8");
}

async function revertExceptSessionFiles(workDir) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const saved = await preserveSessionFiles(workDir);
  const restore = await git(["restore", "--worktree", "--staged", "--", "."], workDir);
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

async function revertScopedPathsExceptSessionFiles(workDir, paths) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const safePaths = normalizeRelativePaths(paths, "revertPaths");
  if (!safePaths.length) throw new Error("No scoped paths were provided for discard cleanup.");
  const saved = await preserveSessionFiles(workDir);
  const restore = await git(["restore", "--worktree", "--staged", "--", ...safePaths], workDir);
  if (restore.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git scoped restore failed during discard cleanup: ${gitOutput(restore, "unknown error")}`,
    );
  }
  const clean = await git(["clean", "-fd", "--", ...safePaths], workDir);
  if (clean.code !== 0) {
    await restoreSessionFiles(workDir, saved);
    throw new Error(
      `Git scoped clean failed during discard cleanup: ${gitOutput(clean, "unknown error")}`,
    );
  }
  await restoreSessionFiles(workDir, saved);
  return `Git: reverted scoped experiment paths (${safePaths.join(", ")}); autoresearch files preserved.`;
}

async function cleanupDiscardChanges(workDir, args, config) {
  if (!(await insideGitRepo(workDir))) return "Git: not a repo, skipped revert.";
  const scopedPaths = normalizeRelativePaths(
    args.revert_paths ??
      args.revertPaths ??
      args.commit_paths ??
      args.commitPaths ??
      config.commitPaths,
    "revertPaths",
  );
  if (scopedPaths.length > 0)
    return await revertScopedPathsExceptSessionFiles(workDir, scopedPaths);
  const dirty = await gitStatusShort(workDir);
  if (!dirty) return "Git: clean tree, no discard cleanup needed.";
  if (boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false)) {
    return await revertExceptSessionFiles(workDir);
  }
  throw new Error(
    "Refusing broad discard cleanup in a dirty Git tree without scoped revert paths. Configure commitPaths/revertPaths or pass --allow-dirty-revert.",
  );
}

function mergeRuntimeConfig(sessionCwd, updates) {
  const configPath = runtimeConfigPath(sessionCwd);
  const existing = readConfig(sessionCwd);
  const nextConfig = { ...existing, ...updates };
  return {
    configPath,
    nextConfig,
    content: JSON.stringify(nextConfig, null, 2),
  };
}

async function appendRuntimeConfigFile(files, sessionCwd, updates) {
  if (Object.keys(updates).length === 0) return;
  const { configPath, content } = mergeRuntimeConfig(sessionCwd, updates);
  files.push(await writeSessionFile(configPath, content, { overwrite: true }));
}

async function writeRuntimeConfig(sessionCwd, updates) {
  if (Object.keys(updates).length === 0) return readConfig(sessionCwd);
  const { configPath, nextConfig, content } = mergeRuntimeConfig(sessionCwd, updates);
  await fsp.writeFile(configPath, `${content}\n`, "utf8");
  return nextConfig;
}

function runtimeConfigUpdatesFromArgs(args: LooseObject) {
  const updates: LooseObject = {};
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
  if (autonomyMode) updates.autonomyMode = autonomyMode;
  if (checksPolicy) updates.checksPolicy = checksPolicy;
  if (keepPolicy) updates.keepPolicy = keepPolicy;
  if (dashboardRefreshSeconds != null)
    updates.dashboardRefreshSeconds = Math.max(1, Math.floor(dashboardRefreshSeconds));
  return updates;
}

async function writeSetupBootstrapFiles(args: LooseObject, options: LooseObject) {
  const { sessionCwd, workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const overwrite = boolOption(args.overwrite, false);
  const shellKind = shellKindFromArgs(args);
  const benchmarkFile = shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1";
  const checksFile = shellKind === "bash" ? "autoresearch.checks.sh" : "autoresearch.checks.ps1";
  const files = [];
  const context = { sessionCwd, workDir, overwrite, shellKind, benchmarkFile, checksFile, files };

  if (options.beforeCommonFiles) await options.beforeCommonFiles(context);

  files.push(
    await writeSessionFile(
      path.join(workDir, "autoresearch.md"),
      `${renderSessionDocument(options.sessionDocumentArgs(context)).trimEnd()}\n\n${renderResumeBlock(workDir)}`,
      { overwrite },
    ),
  );
  files.push(
    await writeSessionFile(path.join(workDir, benchmarkFile), options.benchmarkContent(context), {
      overwrite,
      executable: shellKind === "bash",
    }),
  );
  files.push(
    await writeSessionFile(
      path.join(workDir, "autoresearch.ideas.md"),
      options.ideasContent(context),
      { overwrite },
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
    benchmarkContent: ({ shellKind: setupShellKind }) =>
      renderBenchmarkScript(args, setupShellKind),
    ideasContent: () =>
      `# Autoresearch Ideas: ${args.name}\n\n- Add promising ideas here when they are not tried immediately.\n`,
  });

  const maxIterations = positiveIntegerOption(
    args.max_iterations ?? args.maxIterations,
    null,
    "maxIterations",
  );
  const setupConfig: LooseObject = {};
  if (maxIterations != null) setupConfig.maxIterations = maxIterations;
  if (args.recipe_id || args.recipeId || args.recipe)
    setupConfig.recipeId = args.recipe_id || args.recipeId || args.recipe;
  if (Object.keys(setupConfig).length > 0)
    await appendRuntimeConfigFile(files, sessionCwd, setupConfig);
  const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
  if (commitPaths.length > 0) {
    await appendRuntimeConfigFile(files, sessionCwd, { commitPaths });
  }
  const runtimeUpdates = runtimeConfigUpdatesFromArgs(args);
  if (Object.keys(runtimeUpdates).length > 0) {
    await appendRuntimeConfigFile(files, sessionCwd, runtimeUpdates);
  }

  let init = null;
  if (!boolOption(args.skip_init ?? args.skipInit, false)) {
    init = await initExperiment(args);
  }

  return {
    ok: true,
    workDir,
    sessionCwd,
    shell: shellKind,
    files,
    init,
  };
}

async function setupResearchSession(args) {
  const slug = researchSlugFromArgs(args);
  const goal = args.goal || args.name || slug;
  const { sessionCwd, workDir, shellKind, files } = await writeSetupBootstrapFiles(args, {
    beforeCommonFiles: async ({ workDir: setupWorkDir, overwrite, files: setupFiles }) => {
      const researchDir = researchDirPath(setupWorkDir, slug);
      await fsp.mkdir(path.join(researchDir, "notes"), { recursive: true });
      await fsp.mkdir(path.join(researchDir, "deliverables"), { recursive: true });
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
            { overwrite },
          ),
        );
      }
    },
    sessionDocumentArgs: ({ shellKind: setupShellKind }) => {
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
    benchmarkContent: ({ shellKind: setupShellKind }) =>
      renderResearchBenchmarkScript(slug, setupShellKind),
    ideasContent: () =>
      `# Autoresearch Ideas: ${goal}\n\n- Add promising research-backed ideas here when they are not tried immediately.\n`,
  });
  const researchDir = researchDirPath(workDir, slug);

  const maxIterations = positiveIntegerOption(
    args.max_iterations ?? args.maxIterations,
    null,
    "maxIterations",
  );
  const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
  const runtimeUpdates = runtimeConfigUpdatesFromArgs(args);
  if (maxIterations != null || commitPaths.length > 0 || Object.keys(runtimeUpdates).length > 0) {
    const nextConfig: LooseObject = { ...runtimeUpdates };
    if (maxIterations != null) nextConfig.maxIterations = maxIterations;
    if (commitPaths.length > 0) nextConfig.commitPaths = commitPaths;
    await appendRuntimeConfigFile(files, sessionCwd, nextConfig);
  }

  let init = null;
  if (!boolOption(args.skip_init ?? args.skipInit, false)) {
    init = await initExperiment({
      cwd: workDir,
      name: args.name || `Deep research: ${goal}`,
      metricName: "quality_gap",
      metricUnit: "gaps",
      direction: "lower",
    });
  }

  const gap = await measureQualityGap({ cwd: workDir, researchSlug: slug });
  return {
    ok: true,
    workDir,
    sessionCwd,
    slug,
    researchDir,
    shell: shellKind,
    files,
    init,
    qualityGap: {
      open: gap.open,
      closed: gap.closed,
      total: gap.total,
    },
  };
}

async function measureQualityGap(args) {
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

async function currentQualityGapSummary(workDir) {
  const researchRoot = path.join(workDir, RESEARCH_DIR);
  if (!(await pathExists(researchRoot))) return null;
  const entries = await fsp.readdir(researchRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const gapsPath = path.join(researchRoot, slug, "quality-gaps.md");
    if (!(await pathExists(gapsPath))) continue;
    const text = await fsp.readFile(gapsPath, "utf8");
    const counts = parseQualityGaps(text);
    const items = parseQualityGapItems(text);
    return {
      slug,
      path: gapsPath,
      ...counts,
      openItems: items.open,
      closedItems: items.closed,
      roundGuidance: researchRoundGuidance(),
    };
  }
  return null;
}

function dashboardSettings(config, extra: LooseObject = {}) {
  return {
    autonomyMode: config.autonomyMode || "guarded",
    checksPolicy: config.checksPolicy || "always",
    keepPolicy: config.keepPolicy || "primary-only",
    recipeId: config.recipeId || "",
    ...extra,
  };
}

async function dashboardViewModel(workDir, config, context: LooseObject = {}) {
  const qualityGap = await currentQualityGapSummary(workDir);
  const state = currentState(workDir);
  const warnings = await operatorWarningsForWorkDir(workDir);
  const settings = dashboardSettings(config, context);
  const drift =
    context.runtimeDrift ||
    (await buildDriftReport({
      pluginRoot: PLUGIN_ROOT,
      includeInstalled: Boolean(context.includeInstalledRuntime),
    }).catch((error) => ({
      ok: false,
      warnings: [error.message],
    })));
  return buildDashboardViewModel({
    state,
    settings,
    commands: dashboardCommands(workDir, qualityGap),
    setupPlan: await setupPlan({ cwd: workDir }).catch((error) => ({
      ok: false,
      warnings: [error.message],
    })),
    guidedSetup: await guidedSetup({ cwd: workDir }).catch((error) => ({
      ok: false,
      warnings: [error.message],
    })),
    qualityGap,
    finalizePreview: await buildFinalizePreview({ cwd: workDir }).catch((error) => ({
      ok: false,
      ready: false,
      warnings: [error.message],
      nextAction: "Fix finalization preview errors before relying on review readiness.",
    })),
    recipes: listBuiltInRecipes().map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      tags: recipe.tags || [],
    })),
    experimentMemory: buildExperimentMemory({
      runs: state.current,
      direction: state.config.bestDirection,
      settings,
    }),
    drift,
    warnings,
  });
}

async function operatorWarningsForWorkDir(workDir) {
  const inGit = await insideGitRepo(workDir);
  const warnings = [];
  if (inGit && (await isGitClean(workDir)) === false) {
    warnings.push({
      code: "git_dirty",
      severity: "warning",
      message: "Git worktree is dirty; review unrelated changes before logging a keep result.",
      action:
        "Inspect git status and configure commitPaths or revertPaths before trusting keep/discard automation.",
    });
  }
  return warnings;
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
  if (commitPaths.length > 0) updates.commitPaths = commitPaths;
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
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = currentState(workDir);
  const limit = iterationLimitInfo(state, config);
  if (limit.limitReached) {
    throw new Error(
      `maxIterations reached (${limit.maxIterations}). Start a new segment with init/setup or raise maxIterations before running more experiments.`,
    );
  }
  const command = args.command || (await defaultBenchmarkCommand(workDir));
  const benchmark = await runShell(
    command,
    workDir,
    numberOption(args.timeout_seconds ?? args.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
    {
      retainMetricNames: [state.config.metricName],
    },
  );
  const benchmarkPassed = benchmark.exitCode === 0 && !benchmark.timedOut;
  const parsedMetricResult = parseMetricLines(metricParseSource(benchmark), {
    primaryMetricName: state.config.metricName,
    maxMetrics: MAX_PARSED_METRICS,
    withTruncation: true,
  }) as { metrics: LooseObject; truncated?: boolean };
  const parsedMetrics = parsedMetricResult.metrics;
  const primary = parsedMetrics[state.config.metricName] ?? null;
  const primaryPresent = finiteMetric(primary) != null;
  const primaryMetric = finiteMetric(primary);
  const improvesPrimary =
    primaryMetric != null &&
    (state.best == null || isBetter(primaryMetric, state.best, state.config.bestDirection));
  const isBaseline = state.current.filter(isBaselineEligibleMetricRun).length === 0;
  let checks = null;
  const checksCommand =
    args.checks_command || args.checksCommand || (await defaultChecksCommand(workDir));
  const checksPolicy = checksPolicyFromArgs(args, config);
  const explicitChecksCommand = Boolean(args.checks_command || args.checksCommand);
  if (
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
    );
  }
  const checksPassed = checks ? checks.exitCode === 0 && !checks.timedOut : null;
  const metricError =
    benchmarkPassed && !primaryPresent
      ? `Benchmark completed but did not print primary metric METRIC ${state.config.metricName}=<number>.`
      : null;
  const checksPassedOrSkipped = checksPassed === null || checksPassed;
  const passed = benchmarkPassed && primaryPresent && checksPassedOrSkipped;
  const failedStatus = benchmarkPassed && primaryPresent ? "checks_failed" : "crash";
  const allowedStatuses = passed ? ["keep", "discard"] : [failedStatus];
  const suggestedStatus = passed
    ? isBaseline || improvesPrimary
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
      ? "Safe to consider keep because this is a baseline or a checked improvement; still review ASI before logging."
      : "Default to discard unless the operator can justify keep with ASI and verification evidence."
    : `Only ${failedStatus} is allowed because the benchmark or checks failed.`;
  const progress = buildRunProgress({ benchmark, checks, checksCommand, passed });
  return {
    ok: passed,
    workDir,
    command,
    exitCode: benchmark.exitCode,
    timedOut: benchmark.timedOut,
    durationSeconds: benchmark.durationSeconds,
    parsedMetrics,
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
    checks: checks
      ? {
          command: checksCommand,
          exitCode: checks.exitCode,
          timedOut: checks.timedOut,
          durationSeconds: checks.durationSeconds,
          passed: checksPassed,
          tailOutput: tailText(checks.output, 80, 16000),
        }
      : null,
    tailOutput: tailText(benchmark.output),
    logHint: {
      metric: primary,
      metrics: Object.fromEntries(
        Object.entries(parsedMetrics).filter(([key]) => key !== state.config.metricName),
      ),
      status: passed ? null : failedStatus,
      suggestedStatus,
      safeSuggestedStatus,
      statusGuidance,
      needsDecision: passed,
      allowedStatuses,
    },
    limit,
  };
}

function buildRunProgress({ benchmark, checks, checksCommand, passed }) {
  const stages = [progressStage("benchmark", "Run benchmark command", benchmark)];
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
  return {
    mode: "synchronous",
    status: timedOut ? "timed_out" : passed ? "completed" : "failed",
    cancellable: false,
    cancelStatus: timedOut ? "timeout-killed" : "not_requested",
    elapsedSeconds: Number(
      stages.reduce((total, stage) => total + Number(stage.durationSeconds || 0), 0).toFixed(3),
    ),
    stages,
    latestOutputTail: [...stages].reverse().find((stage) => stage.outputTail)?.outputTail || "",
  };
}

function progressStage(stage, label, result) {
  return {
    stage,
    label,
    status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "completed" : "failed",
    durationSeconds: result.durationSeconds,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputTail: tailText(result.output),
  };
}

function operationProgress({ stage, label, startedAt, status = "completed", outputTail = "" }) {
  const durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(3));
  return {
    mode: "synchronous",
    status,
    cancellable: false,
    cancelStatus: "not_requested",
    elapsedSeconds: durationSeconds,
    stages: [
      {
        stage,
        label,
        status,
        durationSeconds,
        exitCode: null,
        timedOut: false,
        outputTail,
      },
    ],
    latestOutputTail: outputTail,
  };
}

async function logExperiment(args) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const lastPacket = boolOption(args.from_last ?? args.fromLast, false)
    ? await readLastRunPacket(workDir)
    : null;
  if (lastPacket) await assertFreshLastRunPacket(workDir, lastPacket);
  const packetAllowed = Array.isArray(lastPacket?.decision?.allowedStatuses)
    ? lastPacket.decision.allowedStatuses
    : [];
  const status = String(
    args.status || (packetAllowed.length === 1 ? lastPacket?.decision?.suggestedStatus : "") || "",
  );
  if (!status)
    throw new Error(
      "status is required; choose keep or discard explicitly for successful packets.",
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
    throw new Error("metric is required for keep and discard");
  }
  if (status === "keep" && lastPacket?.run?.checks?.passed === false) {
    throw new Error(
      "Cannot keep the last run because correctness checks failed. Log it as checks_failed.",
    );
  }
  const description = args.description || lastPacket?.run?.description || "";
  if (!description) throw new Error("description is required");
  const metrics = args.metrics ?? lastPacket?.decision?.metrics ?? {};
  const asi = args.asi ?? lastPacket?.decision?.asiTemplate ?? {};

  const stateBefore = currentState(workDir);
  const inGit = await insideGitRepo(workDir);
  const explicitCommit = args.commit != null && String(args.commit).trim() !== "";
  const allowAddAll = boolOption(args.allow_add_all ?? args.allowAddAll, false);
  if (explicitCommit && !inGit) {
    throw new Error("--commit requires a Git repository so the commit can be verified.");
  }
  let commit = "";
  if (explicitCommit) {
    commit = (await resolveCommitRef(workDir, args.commit)).slice(0, 12);
  } else if (inGit && status !== "keep") {
    commit = await shortHead(workDir);
  }
  let gitMessage = inGit ? "Git: no commit created." : "Git: not a repo.";
  let revertMessage = "";

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
      const addResult =
        commitPaths.length > 0
          ? await git(["add", "--", ...commitPaths], workDir)
          : await git(["add", "-A"], workDir);
      if (addResult.code !== 0) {
        throw new Error(`Git add failed: ${gitOutput(addResult, "unknown error")}`);
      }
      if (await hasStagedChanges(workDir)) {
        const commitResult = await git(
          ["commit", "-m", description, "-m", `Result: ${JSON.stringify(resultData)}`],
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
  } else if (status !== "keep") {
    revertMessage = await cleanupDiscardChanges(workDir, args, config);
  }

  const currentRuns = stateBefore.current;
  const experiment: LooseObject = {
    run: stateBefore.results.length + 1,
    commit: String(commit || "").slice(0, 12),
    metric,
    metrics,
    status,
    description,
    timestamp: Date.now(),
    segment: stateBefore.segment,
    confidence: null,
  };
  if (asi && Object.keys(asi).length > 0) experiment.asi = asi;
  experiment.confidence = computeConfidence(
    [...currentRuns, experiment],
    stateBefore.config.bestDirection,
  );
  appendJsonl(workDir, experiment);
  if (lastPacket) await deleteLastRunPacket(workDir);

  const stateAfter = currentState(workDir);
  const limit = iterationLimitInfo(stateAfter, config);
  await appendSessionRunNote(workDir, experiment, stateAfter, { gitMessage, revertMessage });
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
    lastRunCleared: Boolean(lastPacket),
    continuation: loopContinuation(workDir, stateAfter, config, "logged"),
  };
}

async function exportDashboard(args) {
  const startedAt = Date.now();
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const entries = readJsonl(workDir);
  if (entries.length === 0) throw new Error(`No autoresearch.jsonl found in ${workDir}`);
  const output = resolveOutputInside(workDir, args.output || "autoresearch-dashboard.html");
  const commands = dashboardCommands(workDir);
  const generatedAt = new Date().toISOString();
  const runtimeDrift = await buildDriftReport({
    pluginRoot: PLUGIN_ROOT,
    includeInstalled: false,
  }).catch((error) => ({
    ok: false,
    warnings: [error.message],
  }));
  const dashboardContext = {
    deliveryMode: "static-export",
    generatedAt,
    sourceCwd: workDir,
    pluginVersion: PLUGIN_VERSION,
    runtimeDrift,
  };
  const viewModel = await dashboardViewModel(workDir, config, dashboardContext);
  const html = dashboardHtml(entries, {
    workDir,
    generatedAt,
    jsonlName: "autoresearch.jsonl",
    deliveryMode: "static-export",
    liveActionsAvailable: false,
    modeGuidance: {
      title: "Static snapshot",
      detail: "Read-only snapshot.",
    },
    refreshMs: Math.max(1, Number(config.dashboardRefreshSeconds || 5)) * 1000,
    commands,
    settings: dashboardSettings(config, dashboardContext),
    viewModel,
  });
  await fsp.writeFile(output, html, "utf8");
  const modeGuidance = {
    staticExport: output,
    liveDashboardCommand: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} serve --cwd ${shellQuote(workDir)}`,
    difference:
      "The exported HTML is a read-only fallback snapshot; share the served dashboard URL when the operator needs a live link.",
    fullJson:
      "Pass --json-full/--verbose on the CLI or full=true over MCP to include the full viewModel in the command response.",
  };
  const progress = operationProgress({
    stage: "export",
    label: "Write dashboard HTML",
    startedAt,
    status: "completed",
    outputTail: output,
  });
  const fullJson = boolOption(args.json_full ?? args.jsonFull ?? args.full ?? args.verbose, false);
  const result: LooseObject = {
    ok: true,
    workDir,
    output,
    summary: viewModel.summary,
    baseline: viewModel.summary?.baseline ?? null,
    best: viewModel.summary?.best ?? null,
    nextAction: viewModel.nextBestAction?.detail || viewModel.readout?.nextAction || "",
    modeGuidance,
    progress,
  };
  if (fullJson) result.viewModel = viewModel;
  return result;
}

async function serveDashboard(args) {
  const startedAt = Date.now();
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  let liveUrl = "";
  const runtimeDrift = await buildDriftReport({
    pluginRoot: PLUGIN_ROOT,
    includeInstalled: true,
  }).catch((error) => ({
    ok: false,
    warnings: [error.message],
  }));
  const serveResult = await serveAutoresearch({
    cwd: workDir,
    port: args.port,
    scriptPath: path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
    dashboardHtml: async ({ actionNonce, actionNonceHeader }: LooseObject = {}) => {
      const entries = readJsonl(workDir);
      const generatedAt = new Date().toISOString();
      const dashboardContext = {
        deliveryMode: "live-server",
        liveUrl,
        generatedAt,
        sourceCwd: workDir,
        pluginVersion: PLUGIN_VERSION,
        runtimeDrift,
      };
      return dashboardHtml(entries, {
        workDir,
        generatedAt,
        jsonlName: "autoresearch.jsonl",
        deliveryMode: "live-server",
        liveActionsAvailable: true,
        actionNonce,
        actionNonceHeader,
        modeGuidance: {
          title: "Live dashboard",
          detail: "Live refresh and guarded actions are available.",
        },
        refreshMs: Math.max(1, Number(config.dashboardRefreshSeconds || 5)) * 1000,
        commands: dashboardCommands(workDir),
        settings: dashboardSettings(config, dashboardContext),
        viewModel: await dashboardViewModel(workDir, config, dashboardContext),
      });
    },
    viewModel: async () =>
      dashboardViewModel(workDir, config, {
        deliveryMode: "live-server",
        liveUrl,
        generatedAt: new Date().toISOString(),
        sourceCwd: workDir,
        pluginVersion: PLUGIN_VERSION,
        runtimeDrift,
      }),
  });
  liveUrl = serveResult.url;
  liveDashboardServers.add(serveResult.server);
  serveResult.server.on("close", () => {
    liveDashboardServers.delete(serveResult.server);
  });
  return {
    ok: true,
    workDir: serveResult.workDir,
    port: serveResult.port,
    url: serveResult.url,
    modeGuidance: {
      deliveryMode: "live-server",
      difference:
        "This is the dashboard link to hand to the operator; exported HTML is only a read-only fallback snapshot.",
    },
    progress: operationProgress({
      stage: "serve",
      label: "Start live dashboard",
      startedAt,
      status: "completed",
      outputTail: serveResult.url,
    }),
  };
}

async function clearSession(args) {
  const dryRun = boolOption(args.dry_run ?? args.dryRun, false);
  if (!dryRun && !boolOption(args.confirm ?? args.yes, false)) {
    throw new Error("clear requires confirm=true for MCP or --yes for CLI");
  }
  const { sessionCwd, workDir } = resolveWorkDir(args.working_dir || args.cwd);
  const targets = new Set([
    ...SESSION_FILES.map((file) => path.join(workDir, file)),
    await resolveLastRunPath(workDir),
    path.join(workDir, RESEARCH_DIR),
    path.join(workDir, "autoresearch-dashboard.html"),
    path.join(sessionCwd, "autoresearch.config.json"),
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

function dashboardHtml(entries, meta: LooseObject = {}) {
  const data = JSON.stringify(entries).replace(/</g, "\\u003c");
  const metaData = JSON.stringify(stripDashboardCommandFields(meta)).replace(/</g, "\\u003c");
  const template = fs.readFileSync(DASHBOARD_TEMPLATE_PATH, "utf8");
  if (!template.includes(DASHBOARD_DATA_PLACEHOLDER)) {
    throw new Error(`Dashboard template is missing ${DASHBOARD_DATA_PLACEHOLDER}`);
  }
  if (
    !template.includes(DASHBOARD_APP_PLACEHOLDER) ||
    !template.includes(DASHBOARD_CSS_PLACEHOLDER)
  ) {
    throw new Error("Dashboard template is missing React build placeholders.");
  }
  const dashboardApp = readDashboardBuildAsset("dashboard-app.js").replace(
    /<\/script/gi,
    "<\\/script",
  );
  const dashboardCss = readDashboardBuildAsset("dashboard-app.css").replace(
    /<\/style/gi,
    "<\\/style",
  );
  return template
    .replace(DASHBOARD_DATA_PLACEHOLDER, () => data)
    .replace(DASHBOARD_META_PLACEHOLDER, () => metaData)
    .replace(DASHBOARD_CSS_PLACEHOLDER, () => dashboardCss)
    .replace(DASHBOARD_APP_PLACEHOLDER, () => dashboardApp);
}

function readDashboardBuildAsset(fileName) {
  const filePath = path.join(DASHBOARD_BUILD_DIR, fileName);
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Dashboard build asset is missing: ${filePath}. Run npm run build:dashboard from ${PLUGIN_ROOT}.`,
      );
    }
    throw error;
  }
}

function stripDashboardCommandFields(value) {
  const commandKeys = new Set([
    "baselineCommand",
    "command",
    "commandLabel",
    "commands",
    "commandsByStatus",
    "guideCommand",
    "guidedFlow",
    "nextCommand",
    "primaryCommand",
  ]);
  if (Array.isArray(value)) return value.map((item) => stripDashboardCommandFields(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !commandKeys.has(key))
      .map(([key, item]) => [key, stripDashboardCommandFields(item)]),
  );
}

async function resolveLastRunPath(workDir) {
  if (await insideGitRepo(workDir)) {
    return await gitPrivatePath(workDir, "autoresearch/last-run.json");
  }
  return path.join(workDir, "autoresearch.last-run.json");
}

async function writeLastRunPacket(workDir, packet, filePath = null) {
  const target = filePath || (await resolveLastRunPath(workDir));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  return target;
}

async function readLastRunPacket(workDir) {
  const filePath = await resolveLastRunPath(workDir);
  const legacyPath = path.join(workDir, "autoresearch.last-run.json");
  const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(readablePath))
    throw new Error(`No last-run packet found for ${workDir}. Run next before using --from-last.`);
  return JSON.parse(fs.readFileSync(readablePath, "utf8"));
}

async function lastRunPacketFingerprint(workDir) {
  const filePath = await resolveLastRunPath(workDir);
  const legacyPath = path.join(workDir, "autoresearch.last-run.json");
  const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(readablePath)) return "";
  return createHash("sha256").update(fs.readFileSync(readablePath, "utf8")).digest("hex");
}

async function assertFreshLastRunPacket(workDir, packet) {
  const freshness = await lastRunPacketFreshness(workDir, packet);
  if (!freshness.fresh) throw new Error(freshness.reason);
}

async function lastRunPacketFreshness(workDir, packet) {
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
    command: packet.history?.command || packet.run?.command || "",
    git: packet.history?.git || null,
    reason: "Last-run packet matches the current ledger.",
  };
}

function lastRunConfigSnapshot(config: LooseObject = {}) {
  return {
    name: config.name || null,
    metricName: config.metricName || "metric",
    metricUnit: config.metricUnit ?? "",
    bestDirection: config.bestDirection === "higher" ? "higher" : "lower",
  };
}

async function deleteLastRunPacket(workDir) {
  const filePath = await resolveLastRunPath(workDir);
  const legacyPath = path.join(workDir, "autoresearch.last-run.json");
  for (const target of new Set([filePath, legacyPath])) {
    await fsp.rm(target, { force: true }).catch(() => {});
  }
}

async function publicState(args) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = currentState(workDir);
  const warningDetails = await operatorWarningsForWorkDir(workDir);
  const memory = buildExperimentMemory({
    runs: state.current,
    direction: state.config.bestDirection,
    settings: dashboardSettings(config),
  });
  const statusCounts = Object.fromEntries(
    [...STATUS_VALUES].map((status) => [
      status,
      state.current.filter((run) => run.status === status).length,
    ]),
  );
  return {
    ok: true,
    workDir,
    config: state.config,
    segment: state.segment,
    runs: state.current.length,
    totalRuns: state.results.length,
    kept: statusCounts.keep,
    discarded: statusCounts.discard,
    crashed: statusCounts.crash,
    checksFailed: statusCounts.checks_failed,
    baseline: state.baseline,
    best: state.best,
    confidence: state.confidence,
    limit: iterationLimitInfo(state, config),
    settings: {
      autonomyMode: config.autonomyMode || "guarded",
      checksPolicy: config.checksPolicy || "always",
      keepPolicy: config.keepPolicy || "primary-only",
      dashboardRefreshSeconds: config.dashboardRefreshSeconds || 5,
      commitPaths: config.commitPaths || [],
    },
    commands: dashboardCommands(workDir),
    warnings: warningDetails.map((warning) => warning.message),
    warningDetails,
    memory,
    continuation: loopContinuation(workDir, state, config, "state"),
  };
}

function dashboardCommands(workDir, qualityGap = null) {
  const cwd = shellQuote(workDir);
  const script = shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"));
  const researchSlug = qualityGap?.slug || currentQualityGapSlug(workDir) || "research";
  return [
    { label: "Serve dashboard", command: `node ${script} serve --cwd ${cwd}` },
    { label: "Setup plan", command: `node ${script} setup-plan --cwd ${cwd}` },
    {
      label: "Doctor",
      command: `node ${script} doctor --cwd ${cwd} --check-benchmark --check-installed`,
    },
    { label: "Next run", command: `node ${script} next --cwd ${cwd}` },
    {
      label: "Keep last",
      command: `node ${script} log --cwd ${cwd} --from-last --status keep --description "Describe the kept change"`,
    },
    {
      label: "Discard last",
      command: `node ${script} log --cwd ${cwd} --from-last --status discard --description "Describe the discarded change"`,
    },
    {
      label: "Gap candidates",
      command: `node ${script} gap-candidates --cwd ${cwd} --research-slug ${shellQuote(researchSlug)}`,
    },
    { label: "Finalize preview", command: `node ${script} finalize-preview --cwd ${cwd}` },
    { label: "Export dashboard", command: `node ${script} export --cwd ${cwd}` },
    { label: "Extend limit", command: `node ${script} config --cwd ${cwd} --extend 10` },
  ];
}

function loopContinuation(
  workDir,
  state,
  config: LooseObject = {},
  stage = "state",
  options: LooseObject = {},
) {
  const mode = config.autonomyMode || "guarded";
  const limit = iterationLimitInfo(state, config);
  const commands = continuationCommands(workDir);
  const memory = buildExperimentMemory({
    runs: state.current,
    direction: state.config.bestDirection,
    settings: dashboardSettings(config),
  });
  const topLane = memory.diversityGuidance || memory.lanePortfolio?.[0];
  const stopConditions = [
    "user interrupts or turns the loop off",
    "iteration limit is reached",
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
    return {
      mode,
      stage,
      shouldContinue: false,
      shouldAskUser: false,
      requiresLogDecision: true,
      forbidFinalAnswer: mode === "owner-autonomous",
      nextAction: options.requiredStatus
        ? `Log this packet as ${options.requiredStatus} with rollback ASI, then continue to the next hypothesis.`
        : "Log this packet as keep or discard with ASI, then continue to the next hypothesis.",
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
      stopReason: `maxIterations reached (${limit.maxIterations}).`,
      nextAction:
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
    plateau: memory.plateau,
    lanePortfolio: memory.lanePortfolio,
    shouldContinue: true,
    shouldAskUser: false,
    forbidFinalAnswer: ownerAutonomous,
    nextAction: ownerAutonomous
      ? memory.plateau?.detected
        ? `Keep the floor: run the ${topLane?.label || "distant scout"} lane next because the current search is plateauing.`
        : "Keep the floor: choose the next hypothesis from ASI/autoresearch.ideas.md, edit the scoped files, run next_experiment, and log the result without asking the user to invoke another subskill."
      : "Continue the active loop when the current user request asks for iteration; otherwise report the state and next command.",
    commands,
    stopConditions,
  };
}

function continuationCommands(workDir) {
  const cwd = shellQuote(workDir);
  const script = shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"));
  return {
    state: `node ${script} state --cwd ${cwd}`,
    next: `node ${script} next --cwd ${cwd}`,
    keepLast: `node ${script} log --cwd ${cwd} --from-last --status keep --description "Describe the kept change"`,
    discardLast: `node ${script} log --cwd ${cwd} --from-last --status discard --description "Describe the discarded change"`,
    liveDashboard: `node ${script} serve --cwd ${cwd}`,
    exportDashboard: `node ${script} export --cwd ${cwd}`,
    extendLimit: `node ${script} config --cwd ${cwd} --extend 10`,
  };
}

function currentQualityGapSlug(workDir) {
  const researchRoot = path.join(workDir, RESEARCH_DIR);
  try {
    for (const entry of fs
      .readdirSync(researchRoot, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(researchRoot, entry.name, "quality-gaps.md"))) return entry.name;
    }
  } catch {
    return null;
  }
  return null;
}

async function doctorSession(args) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const state = await publicState(args);
  const issues = [];
  const warnings = [];
  const warningDetails = [];
  const inGit = await insideGitRepo(workDir);
  const clean = await isGitClean(workDir);

  if (!state.config.metricName) issues.push("No primary metric is configured.");
  if (state.runs === 0)
    warnings.push("No runs are logged yet. Run a baseline before experimenting.");
  warnings.push(...(state.memory?.warnings || []));
  if (inGit && clean === false)
    warnings.push("Git worktree is dirty; review unrelated changes before logging a keep result.");
  if (!inGit)
    warnings.push(
      "Working directory is not a Git repository; keep commits and discard reverts are unavailable.",
    );
  const drift = await buildDriftReport({
    pluginRoot: PLUGIN_ROOT,
    includeInstalled: boolOption(args.check_installed ?? args.checkInstalled, false),
  });
  warnings.push(...drift.warnings);

  const benchmark = {
    checked: false,
    command: args.command || "",
    emitsPrimary: null,
    parsedMetrics: {},
    exitCode: null,
    timedOut: false,
    metricError: null,
    progress: null,
  };

  if (boolOption(args.check_benchmark ?? args.checkBenchmark, false)) {
    benchmark.checked = true;
    benchmark.command = args.command || (await defaultBenchmarkCommand(workDir));
    if (!benchmark.command) {
      benchmark.metricError =
        "No benchmark command was provided and no autoresearch script was found.";
      issues.push(benchmark.metricError);
    } else {
      const run = await runShell(
        benchmark.command,
        workDir,
        numberOption(args.timeout_seconds ?? args.timeoutSeconds, 60),
        {
          retainMetricNames: [state.config.metricName],
        },
      );
      benchmark.exitCode = run.exitCode;
      benchmark.timedOut = run.timedOut;
      benchmark.parsedMetrics = parseMetricLines(metricParseSource(run));
      benchmark.emitsPrimary =
        finiteMetric(benchmark.parsedMetrics[state.config.metricName]) != null;
      benchmark.progress = buildRunProgress({
        benchmark: run,
        checks: null,
        checksCommand: null,
        passed: run.exitCode === 0 && !run.timedOut && benchmark.emitsPrimary,
      });
      if (run.exitCode !== 0 || run.timedOut) {
        issues.push(
          `Benchmark command failed during doctor check: exit ${run.exitCode ?? "none"}${run.timedOut ? " (timed out)" : ""}.`,
        );
      } else if (!benchmark.emitsPrimary) {
        benchmark.metricError = `Benchmark did not emit primary metric METRIC ${state.config.metricName}=<number>.`;
        issues.push(benchmark.metricError);
      }
    }
  }

  let nextAction = "Run the next experiment, then log keep or discard with ASI.";
  if (issues.some((issue) => /primary metric|Benchmark/.test(issue))) {
    nextAction =
      "Fix the benchmark command so it emits the configured primary metric before continuing.";
  } else if (state.runs === 0) {
    nextAction = "Run and log a baseline before trying optimizations.";
  } else if (state.limit.limitReached) {
    nextAction = "Iteration limit reached; export the dashboard or start a new segment.";
  } else if (warnings.some((warning) => /dirty/.test(String(warning)))) {
    nextAction = "Review the dirty Git state before logging a kept result.";
  }

  return {
    ok: issues.length === 0,
    workDir,
    config: state.config,
    state,
    git: {
      inside: inGit,
      clean,
    },
    benchmark,
    drift,
    issues,
    warnings,
    warningDetails,
    nextAction,
    continuation: loopContinuation(workDir, currentState(workDir), config, "doctor"),
  };
}

async function nextExperiment(args) {
  const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
  const doctor = await doctorSession({
    ...args,
    check_benchmark: false,
    checkBenchmark: false,
  });
  if (!doctor.ok) {
    return {
      ok: false,
      workDir: doctor.workDir,
      doctor,
      run: null,
      decision: null,
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
  const packet = {
    ok: doctor.ok && run.ok,
    workDir: run.workDir,
    lastRunPath: lastRunFile,
    history: {
      segment: stateBeforeLog.segment,
      config: lastRunConfigSnapshot(stateBeforeLog.config),
      command: run.command,
      workDir: run.workDir,
      currentRuns: stateBeforeLog.current.length,
      totalRuns: stateBeforeLog.results.length,
      nextRun: stateBeforeLog.results.length + 1,
      git: await lastRunGitSnapshot(run.workDir, config).catch((error) => ({
        inside: null,
        error: error.message || String(error),
      })),
    },
    doctor,
    run,
    decision,
    nextAction: run.ok
      ? `Log this run as ${decision.safeSuggestedStatus || "keep/discard"} unless review evidence says otherwise, include ASI, then continue with the next ${memory.diversityGuidance?.label || "diversity"} lane.`
      : `Log this run as ${run.logHint.status} with rollback ASI before trying another change.`,
    continuation: loopContinuation(workDir, currentState(workDir), config, "needs-log-decision", {
      requiredStatus: run.logHint.status,
    }),
  };
  await writeLastRunPacket(run.workDir, packet, lastRunFile);
  return packet;
}

const mcpInterface = createMcpInterface({
  boolOption,
  clearSession,
  configureSession,
  doctorSession,
  exportDashboard,
  finalizePreview: buildFinalizePreview,
  gapCandidates: buildGapCandidates,
  guidedSetup,
  initExperiment,
  integrationsCommand,
  logExperiment,
  measureQualityGap,
  nextExperiment,
  parseJsonOption,
  publicState,
  recipeCommand,
  runExperiment,
  serveDashboard,
  setupPlan,
  setupResearchSession,
  setupSession,
});
const { callTool, toolSchemas, validateToolArguments } = mcpInterface;

function startMcpServer() {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_FRAME_BYTES + 1024 && buffer.indexOf("\r\n\r\n") < 0) {
      buffer = Buffer.alloc(0);
      sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request too large." } });
      return;
    }
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (!Number.isFinite(length) || length < 0 || length > MAX_MCP_FRAME_BYTES) {
        sendMcp({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message: `Request too large. Max frame size is ${MAX_MCP_FRAME_BYTES} bytes.`,
          },
        });
        buffer =
          buffer.length >= bodyStart + Math.max(0, length)
            ? buffer.subarray(bodyStart + Math.max(0, length))
            : Buffer.alloc(0);
        continue;
      }
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        sendMcp({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${error.message}` },
        });
        continue;
      }
      handleMcpMessage(message).catch((error) => {
        sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32000, message: error.message } });
      });
    }
  });
}

async function handleMcpMessage(message) {
  if (message.method === "initialize") {
    sendMcp({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-autoresearch", version: "0.6.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    sendMcp({ jsonrpc: "2.0", id: message.id, result: { tools: toolSchemas } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      validateToolArguments(message.params?.name, message.params?.arguments || {});
      const result = await callTool(message.params.name, message.params.arguments || {});
      const payload = mcpSuccessEnvelope(message.params.name, result);
      sendMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        },
      });
    } catch (error) {
      const payload = mcpErrorEnvelope(message.params?.name, error);
      sendMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        },
      });
    }
    return;
  }
  if (message.id != null) {
    sendMcp({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unknown method: ${message.method}` },
    });
  }
}

function mcpSuccessEnvelope(tool, result) {
  const body =
    result && typeof result === "object" && !Array.isArray(result) ? result : { value: result };
  return {
    ...body,
    ok: body.ok !== false,
    tool,
    workDir: body.workDir || body.working_dir,
    result: body,
  };
}

function mcpErrorEnvelope(tool, error) {
  return {
    ok: false,
    tool: tool || "unknown",
    error: error.message || String(error),
  };
}

function sendMcp(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function mcpFrame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function collectMcpFrames(buffer, messages) {
  let remaining = buffer;
  for (;;) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd < 0) return remaining;
    const header = remaining.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      remaining = remaining.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (!Number.isFinite(length) || length < 0) {
      remaining = remaining.subarray(bodyStart);
      continue;
    }
    if (remaining.length < bodyStart + length) return remaining;
    const body = remaining.subarray(bodyStart, bodyStart + length).toString("utf8");
    remaining = remaining.subarray(bodyStart + length);
    try {
      messages.push(JSON.parse(body));
    } catch (error) {
      messages.push({ jsonrpc: "2.0", error: { code: -32700, message: error.message } });
    }
  }
}

function waitForMcpResponse(messages, id, timeoutMs): Promise<any> {
  const started = Date.now();
  return new Promise<any>((resolve) => {
    const check = () => {
      const message = messages.find((item) => item.id === id);
      if (message || Date.now() - started >= timeoutMs) {
        resolve(message || null);
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

async function mcpSmoke() {
  const messages = [];
  let buffer = Buffer.alloc(0);
  let stderr = "";
  const child = spawn(process.execPath, [MCP_SCRIPT_PATH], {
    cwd: PLUGIN_ROOT,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    buffer = collectMcpFrames(Buffer.concat([buffer, chunk]), messages);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.stdin.write(
    mcpFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codex-autoresearch-smoke", version: "0" },
      },
    }),
  );
  child.stdin.write(mcpFrame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
  child.stdin.write(mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));

  const initialize = await waitForMcpResponse(messages, 1, 1500);
  const toolsList = await waitForMcpResponse(messages, 2, 1500);
  child.kill();

  const tools = toolsList?.result?.tools || [];
  const toolNames = tools.map((tool) => tool.name).filter(Boolean);
  const requiredTools = [
    "setup_plan",
    "setup_session",
    "next_experiment",
    "read_state",
    "doctor_session",
    "serve_dashboard",
    "clear_session",
  ];
  const missingRequiredTools = requiredTools.filter((tool) => !toolNames.includes(tool));
  return {
    ok: Boolean(
      initialize?.result?.serverInfo?.name === "codex-autoresearch" &&
      tools.length > 0 &&
      missingRequiredTools.length === 0,
    ),
    pluginRoot: PLUGIN_ROOT,
    command: `${process.execPath} ${MCP_SCRIPT_PATH}`,
    initialize: initialize?.result || initialize?.error || null,
    toolCount: tools.length,
    toolNames,
    missingRequiredTools,
    stderr: stderr.trim(),
    note: "This validates the plugin stdio server directly. If this is ok but Codex does not show MCP tools, the failure is in Codex tool surfacing or session registration, not this server process.",
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.mcp) {
    startMcpServer();
    return;
  }
  const command = args._[0];
  if (!command || args.help || command === "help") {
    console.log(usage());
    return;
  }
  if (command === "mcp-smoke") {
    console.log(JSON.stringify(await mcpSmoke(), null, 2));
    return;
  }
  const handlers = createCliCommandHandlers({
    buildDriftReport,
    buildDashboardViewModel,
    clearSession,
    configureSession,
    dashboardCommands,
    dashboardHtml,
    dashboardSettings,
    dashboardViewModel,
    doctorSession,
    exportDashboard,
    finalizePreview: buildFinalizePreview,
    gapCandidates: buildGapCandidates,
    guidedSetup,
    initExperiment,
    integrationsCommand,
    interactiveSetup,
    logExperiment,
    measureQualityGap,
    nextExperiment,
    parseJsonOption,
    pluginRoot: PLUGIN_ROOT,
    pluginVersion: PLUGIN_VERSION,
    publicState,
    readJsonl,
    recipeCommand,
    resolveWorkDir,
    runExperiment,
    serveAutoresearch,
    setupPlan,
    setupResearchSession,
    setupSession,
  });
  const outcome = (await runCliCommand(command, args, handlers)) as LooseObject;
  if (outcome.text != null) {
    console.log(outcome.text);
    return;
  }
  console.log(JSON.stringify(outcome.result, null, 2));
  if (outcome.keepAlive) return await new Promise(() => {});
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
