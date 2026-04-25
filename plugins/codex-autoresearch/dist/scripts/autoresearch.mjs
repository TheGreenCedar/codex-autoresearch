#!/usr/bin/env node
import { parseMetricLines, runProcess as runProcess$1, runShell, tailText } from "../lib/runner.mjs";
import { FAILURE_STATUSES, STATUS_VALUES, appendJsonl, currentState, finiteMetric, isBaselineEligibleMetricRun, iterationLimitInfo, readJsonl } from "../lib/session-core.mjs";
import { gapCandidates, researchRoundGuidance, resolveResearchSlugForQualityGapSync } from "../lib/research-gaps.mjs";
import { createCliCommandHandlers, runCliCommand } from "../lib/cli-handlers.mjs";
import { buildDashboardViewModel } from "../lib/dashboard-view-model.mjs";
import { buildDriftReport } from "../lib/drift-doctor.mjs";
import { buildExperimentMemory } from "../lib/experiment-memory.mjs";
import { resolvePackageRoot, resolveRepoRoot } from "../lib/runtime-paths.mjs";
import { finalizePreview } from "../lib/finalize-preview.mjs";
import { applyResolvedRecipeDefaults, findRecipe, getBuiltInRecipe, listBuiltInRecipes, loadRecipeCatalog, recommendRecipe } from "../lib/recipes.mjs";
import { integrationsCommand } from "../lib/integrations.mjs";
import { serveAutoresearch } from "../lib/live-server.mjs";
import { createMcpInterface } from "../lib/mcp-interface.mjs";
import { createDashboardCommands } from "../lib/commands/dashboard.mjs";
import { createInspectCommands } from "../lib/commands/inspect.mjs";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
//#region scripts/autoresearch.ts
const SESSION_FILES = [
	"autoresearch.jsonl",
	"autoresearch.md",
	"autoresearch.ideas.md",
	"autoresearch.sh",
	"autoresearch.ps1",
	"autoresearch.checks.sh",
	"autoresearch.checks.ps1",
	"autoresearch.config.json",
	"autoresearch.last-run.json"
];
const AUTORESEARCH_GITATTRIBUTES_BLOCK = [
	"# Codex Autoresearch ledger files",
	"autoresearch.jsonl text eol=lf",
	"autoresearch.md text eol=lf",
	"autoresearch.ideas.md text eol=lf"
].join("\n");
const RESEARCH_DIR = "autoresearch.research";
const AUTONOMY_MODES = new Set([
	"guarded",
	"owner-autonomous",
	"manual"
]);
const CHECKS_POLICIES = new Set([
	"always",
	"on-improvement",
	"manual"
]);
const KEEP_POLICIES = new Set(["primary-only", "primary-or-risk-reduction"]);
const DENIED_METRIC_NAMES = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
const METRIC_NAME_PATTERN = /^[^=\s]+$/;
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const MAX_PARSED_METRICS = 512;
const MAX_MCP_FRAME_BYTES = 1024 * 1024;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
const MCP_SCRIPT_PATH = path.join(PLUGIN_ROOT, "scripts", "autoresearch-mcp.mjs");
const PLUGIN_VERSION = "1.1.10";
const DASHBOARD_TEMPLATE_PATH = path.join(PLUGIN_ROOT, "assets", "template.html");
const DASHBOARD_BUILD_DIR = path.join(PLUGIN_ROOT, "assets", "dashboard-build");
const DASHBOARD_DATA_PLACEHOLDER = "__AUTORESEARCH_DATA_PAYLOAD__";
const DASHBOARD_META_PLACEHOLDER = "__AUTORESEARCH_META_PAYLOAD__";
const DASHBOARD_APP_PLACEHOLDER = "__AUTORESEARCH_DASHBOARD_APP__";
const DASHBOARD_CSS_PLACEHOLDER = "__AUTORESEARCH_DASHBOARD_CSS__";
const EMPTY_COMMIT_PATHS_WARNING_CODE = "empty_commit_paths_in_git_repo";
const { exportDashboard, serveDashboard } = createDashboardCommands({
	boolOption,
	buildDriftReport,
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
	serveAutoresearch,
	shellQuote,
	writeFile: fsp.writeFile
});
const { benchmarkLint, benchmarkInspect, checksInspect } = createInspectCommands({
	currentState,
	defaultBenchmarkCommand,
	finiteMetric,
	headText,
	metricParseSource,
	numberOption,
	parseMetricLines,
	resolveWorkDir,
	runShell,
	validateMetricName
});
function usage() {
	return `Codex Autoresearch

Usage:
  node scripts/autoresearch.mjs setup --cwd <project> --name <name> --metric-name <name> [--recipe <id>] [--catalog <path-or-url>] [--benchmark-command <cmd>] [--benchmark-prints-metric true|false] [--checks-command <cmd>] [--shell bash|powershell] [--max-iterations <n>]
  node scripts/autoresearch.mjs setup --cwd <project> --interactive
  node scripts/autoresearch.mjs setup-plan --cwd <project> [--recipe <id>] [--catalog <path-or-url>] [--name <name>] [--metric-name <name>] [--benchmark-command <cmd>] [--checks-command <cmd>] [--commit-paths <paths>] [--max-iterations <n>]
  node scripts/autoresearch.mjs guide --cwd <project> [--recipe <id>] [--catalog <path-or-url>] [--name <name>] [--metric-name <name>] [--benchmark-command <cmd>] [--checks-command <cmd>] [--commit-paths <paths>] [--max-iterations <n>]
  node scripts/autoresearch.mjs prompt-plan --cwd <project> --prompt <text>
  node scripts/autoresearch.mjs onboarding-packet --cwd <project> [--compact]
  node scripts/autoresearch.mjs recommend-next --cwd <project> [--compact]
  node scripts/autoresearch.mjs recipes list|show|recommend [recipe-id] [--cwd <project>] [--catalog <path-or-url>]
  node scripts/autoresearch.mjs init --cwd <project> --name <name> --metric-name <name> [--metric-unit <unit>] [--direction lower|higher]
  node scripts/autoresearch.mjs run --cwd <project> [--command <cmd>] [--timeout-seconds <n>]
  node scripts/autoresearch.mjs next --cwd <project> [--compact] [--command <cmd>] [--timeout-seconds <n>]
  node scripts/autoresearch.mjs config --cwd <project> [--autonomy-mode guarded|owner-autonomous|manual] [--checks-policy always|on-improvement|manual] [--extend <n>]
  node scripts/autoresearch.mjs research-setup --cwd <project> --slug <slug> --goal <goal> [--checks-command <cmd>] [--max-iterations <n>]
  node scripts/autoresearch.mjs quality-gap --cwd <project> [--research-slug <slug>] [--list] [--json]
  node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug> [--apply] [--model-command <cmd>] [--model-timeout-seconds <n>]
  node scripts/autoresearch.mjs finalize-preview --cwd <project> [--trunk main]
  node scripts/autoresearch.mjs serve --cwd <project> [--port <n>]
  node scripts/autoresearch.mjs integrations list|doctor|sync-recipes [--catalog <path-or-url>]
  node scripts/autoresearch.mjs log --cwd <project> (--metric <n>|--from-last) --status keep|discard|crash|checks_failed --description <text> [--metrics <json>] [--asi <json>|--asi-file <path>] [--commit-paths <paths>] [--allow-add-all] [--revert-paths <paths>]
  node scripts/autoresearch.mjs state --cwd <project> [--compact]
  node scripts/autoresearch.mjs doctor --cwd <project> [--command <cmd>] [--check-benchmark] [--explain]
  node scripts/autoresearch.mjs doctor hooks
  node scripts/autoresearch.mjs benchmark-inspect --cwd <project> [--command <cmd>] [--timeout-seconds <n>]
  node scripts/autoresearch.mjs benchmark-lint --cwd <project> [--metric-name <name>] [--sample <text>|--command <cmd>]
  node scripts/autoresearch.mjs checks-inspect --cwd <project> --command <cmd> [--timeout-seconds <n>]
  node scripts/autoresearch.mjs new-segment --cwd <project> [--reason <text>] [--dry-run|--yes]
  node scripts/autoresearch.mjs promote-gate --cwd <project> --reason <text> [--gate-name <name>] [--query-count <n>] [--benchmark-command <cmd>] [--checks-command <cmd>] [--dry-run|--yes]
  node scripts/autoresearch.mjs export --cwd <project> [--output <html>] [--showcase] [--json-full|--verbose]
  node scripts/autoresearch.mjs clear --cwd <project> [--dry-run|--yes]
  node scripts/autoresearch.mjs mcp-smoke
  node scripts/autoresearch.mjs --mcp

Benchmark output format:
  METRIC name=value
`;
}
function parseCliArgs(argv) {
	const out = { _: [] };
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
		const key = (equalsAt > 2 ? arg.slice(2, equalsAt) : arg.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if (equalsAt > 2) {
			out[key] = arg.slice(equalsAt + 1);
			continue;
		}
		const next = argv[i + 1];
		if (next == null || next.startsWith("--")) out[key] = true;
		else {
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
async function parseJsonFileOption(filePath, workDir, optionName) {
	if (filePath == null || filePath === "") return null;
	const input = String(filePath);
	const resolved = path.isAbsolute(input) ? input : path.join(workDir, input);
	try {
		return parseJsonOption(await fsp.readFile(resolved, "utf8"), {});
	} catch (error) {
		throw new Error(`${optionName} must point to a valid JSON file: ${error.message}`);
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
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${optionName} must be a positive integer. Got ${value}`);
	return parsed;
}
function nonNegativeIntegerOption(value, fallback, optionName) {
	const parsed = numberOption(value, fallback);
	if (parsed == null) return parsed;
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${optionName} must be a non-negative integer. Got ${value}`);
	return parsed;
}
function boolOption(value, fallback = false) {
	if (value == null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	return [
		"1",
		"true",
		"yes",
		"y"
	].includes(String(value).toLowerCase());
}
function enumOption(value, allowed, fallback, optionName) {
	if (value == null || value === "") return fallback;
	const normalized = String(value).toLowerCase();
	if (!allowed.has(normalized)) throw new Error(`${optionName} must be one of ${[...allowed].join(", ")}. Got ${value}`);
	return normalized;
}
function listOption(value) {
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (value == null || value === "") return [];
	return String(value).split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}
function safeSlug(value, fallback = "research") {
	return String(value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "") || fallback;
}
function shellQuote(value) {
	return `"${String(value).replace(/"/g, "\\\"")}"`;
}
function slashPath(value) {
	return String(value || "").replace(/\\/g, "/").replace(/\/+$/g, "");
}
function validateMetricName(name) {
	if (!METRIC_NAME_PATTERN.test(String(name || "")) || DENIED_METRIC_NAMES.has(String(name))) throw new Error(`Metric name must match the METRIC parser grammar: one non-empty token without whitespace or "=". Got ${name}`);
	return String(name);
}
function normalizeRelativePaths(paths, optionName = "paths") {
	return listOption(paths).map((item) => {
		const normalized = item.replace(/\\/g, "/").replace(/\/+/g, "/");
		if (!normalized || normalized === "." || path.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../") || normalized === ".." || normalized.startsWith(".git/") || normalized === ".git") throw new Error(`${optionName} must contain project-relative paths that do not escape the working directory: ${item}`);
		return normalized.replace(/\/$/, "");
	});
}
function resolveOutputInside(workDir, output) {
	const target = path.resolve(workDir, output || "autoresearch-dashboard.html");
	const relative = path.relative(workDir, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Dashboard output is outside the working directory: ${target}`);
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
	const sessionCwd = path.resolve(cwdArg || process.env.CODEX_AUTORESEARCH_WORKDIR || process.cwd());
	const config = readConfig(sessionCwd);
	const workDir = config.workingDir ? path.resolve(sessionCwd, config.workingDir) : sessionCwd;
	if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) throw new Error(`Working directory does not exist: ${workDir}`);
	return {
		sessionCwd,
		workDir,
		config
	};
}
function assetPath(fileName) {
	return path.join(PLUGIN_ROOT, "assets", fileName);
}
function readAssetTemplate(fileName) {
	return fs.readFileSync(assetPath(fileName), "utf8");
}
function replaceAllText(text, replacements) {
	let out = text;
	for (const [from, to] of Object.entries(replacements)) out = out.split(from).join(String(to));
	return out;
}
function shellKindFromArgs(args) {
	const requested = String(args.shell || args.script || "").toLowerCase();
	if ([
		"bash",
		"sh",
		"posix"
	].includes(requested)) return "bash";
	if ([
		"powershell",
		"pwsh",
		"ps1",
		"windows"
	].includes(requested)) return "powershell";
	return process.platform === "win32" ? "powershell" : "bash";
}
async function withRecipeDefaults(args) {
	const recipeId = args.recipe_id ?? args.recipeId ?? args.recipe;
	return recipeId ? await applyResolvedRecipeDefaults(args, recipeId, args.catalog) : args;
}
function explicitBenchmarkPrintsMetric(args) {
	const hasExplicitBenchmarkCommand = Boolean(args.benchmark_command || args.benchmarkCommand);
	return boolOption(args.benchmark_prints_metric ?? args.benchmarkPrintsMetric, hasExplicitBenchmarkCommand);
}
function scopeWarningsFromArgs(args) {
	const scope = normalizeRelativePaths(args.files_in_scope ?? args.filesInScope ?? args.scope, "filesInScope").map(slashPath);
	const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths").map(slashPath);
	if (!scope.length || !commitPaths.length) return [];
	const covers = (container, item) => container === item || item.startsWith(`${container}/`) || container.startsWith(`${item}/`);
	const commitOutsideScope = commitPaths.filter((commitPath) => scope.every((scopePath) => !covers(scopePath, commitPath)));
	const scopeOutsideCommit = scope.filter((scopePath) => commitPaths.every((commitPath) => !covers(commitPath, scopePath)));
	const warnings = [];
	if (commitOutsideScope.length) warnings.push(`commitPaths not represented in filesInScope: ${commitOutsideScope.join(", ")}`);
	if (scopeOutsideCommit.length) warnings.push(`filesInScope not represented in commitPaths: ${scopeOutsideCommit.join(", ")}`);
	return warnings;
}
function firstRunChecklist({ setupCommand, benchmarkLintCommand, doctorCommand, checkpoint, baselineCommand, logCommand }) {
	const steps = [{
		step: "setup",
		command: setupCommand,
		purpose: "Create or refresh the session files."
	}];
	if (benchmarkLintCommand) steps.push({
		step: "benchmark-lint",
		command: benchmarkLintCommand,
		purpose: "Validate that the benchmark emits the primary METRIC line before running it live."
	});
	steps.push({
		step: "doctor",
		command: doctorCommand,
		purpose: "Run setup/readiness checks and confirm the benchmark contract."
	});
	if (checkpoint?.commands?.length) steps.push({
		step: "checkpoint",
		command: checkpoint.commands.join(" && "),
		purpose: "Commit generated session files before experiment-scoped keep commits."
	});
	steps.push({
		step: "baseline",
		command: baselineCommand,
		purpose: "Run the first measured packet."
	}, {
		step: "log",
		command: logCommand,
		purpose: "Record the packet with status and ASI before starting another run."
	});
	return steps;
}
async function setupPlan(args) {
	const { sessionCwd, workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
	const requestedRecipe = args.recipe_id ?? args.recipeId ?? args.recipe;
	const storedRecipe = config?.recipeId;
	let recommended = null;
	if (requestedRecipe) {
		recommended = await findRecipe(requestedRecipe, args.catalog);
		if (!recommended) throw new Error(`Unknown recipe: ${requestedRecipe}`);
	} else if (storedRecipe) recommended = await findRecipe(storedRecipe, args.catalog) || await recommendRecipe(workDir);
	else recommended = await recommendRecipe(workDir);
	const state = currentState(workDir);
	const hasDefaultBenchmarkCommand = await defaultBenchmarkCommandExists(workDir);
	const hasBenchmarkInput = Boolean(args.benchmark_command || args.benchmarkCommand);
	const missing = [];
	if (!args.name && !state.config.name && !recommended) missing.push("name");
	if (!args.metric_name && !args.metricName && !state.config.metricName && !recommended) missing.push("metric_name");
	if (state.current.length === 0 && !hasBenchmarkInput && !hasDefaultBenchmarkCommand) missing.push("benchmark_command");
	const planArgs = await withRecipeDefaults({
		...args,
		recipe: recommended?.id,
		name: args.name || recommended?.title || "Autoresearch session"
	});
	const shellKind = shellKindFromArgs(planArgs);
	const setupMaxIterations = positiveIntegerOption(planArgs.max_iterations ?? planArgs.maxIterations, null, "maxIterations");
	const commitPaths = normalizeRelativePaths(planArgs.commit_paths ?? planArgs.commitPaths, "commitPaths");
	const benchmarkCommand = planArgs.benchmark_command || planArgs.benchmarkCommand || "";
	const checksCommand = planArgs.checks_command || planArgs.checksCommand || "";
	const metricName = validateMetricName(planArgs.metric_name || planArgs.metricName || "seconds");
	const benchmarkPrintsMetric = explicitBenchmarkPrintsMetric(planArgs);
	const benchmarkMode = {
		explicitCommand: Boolean(benchmarkCommand),
		printsMetric: benchmarkPrintsMetric,
		note: benchmarkCommand ? benchmarkPrintsMetric ? "Explicit benchmark commands are treated as metric-emitting by default. Pass --benchmark-prints-metric false to time a raw workload instead." : "This explicit benchmark command will be wrapped and timed by the generated script." : "No explicit benchmark command was provided; generated placeholder wrappers must be replaced before use."
	};
	const command = [
		"node",
		shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs")),
		"setup",
		"--cwd",
		shellQuote(workDir),
		"--name",
		shellQuote(planArgs.name || "Autoresearch session"),
		planArgs.goal ? `--goal ${shellQuote(planArgs.goal)}` : "",
		"--metric-name",
		shellQuote(metricName),
		planArgs.metric_unit || planArgs.metricUnit ? `--metric-unit ${shellQuote(planArgs.metric_unit ?? planArgs.metricUnit)}` : "",
		"--direction",
		shellQuote(planArgs.direction || "lower"),
		"--shell",
		shellQuote(shellKind),
		benchmarkCommand ? `--benchmark-command ${shellQuote(benchmarkCommand)}` : "",
		planArgs.benchmark_prints_metric != null || planArgs.benchmarkPrintsMetric != null ? `--benchmark-prints-metric ${shellQuote(planArgs.benchmark_prints_metric ?? planArgs.benchmarkPrintsMetric)}` : "",
		checksCommand ? `--checks-command ${shellQuote(checksCommand)}` : "",
		listOption(planArgs.files_in_scope ?? planArgs.filesInScope).length ? `--files-in-scope ${shellQuote(listOption(planArgs.files_in_scope ?? planArgs.filesInScope).join(","))}` : "",
		listOption(planArgs.off_limits ?? planArgs.offLimits).length ? `--off-limits ${shellQuote(listOption(planArgs.off_limits ?? planArgs.offLimits).join(","))}` : "",
		listOption(planArgs.constraints).length ? `--constraints ${shellQuote(listOption(planArgs.constraints).join(","))}` : "",
		listOption(planArgs.secondary_metrics ?? planArgs.secondaryMetrics).length ? `--secondary-metrics ${shellQuote(listOption(planArgs.secondary_metrics ?? planArgs.secondaryMetrics).join(","))}` : "",
		setupMaxIterations != null ? `--max-iterations ${shellQuote(setupMaxIterations)}` : "",
		commitPaths.length > 0 ? `--commit-paths ${shellQuote(commitPaths.join(","))}` : "",
		recommended ? `--recipe ${shellQuote(recommended.id)}` : "",
		args.catalog ? `--catalog ${shellQuote(args.catalog)}` : ""
	].filter(Boolean).join(" ");
	const doctorCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} doctor --cwd ${shellQuote(workDir)} --check-benchmark`;
	const benchmarkLintCommand = benchmarkCommand ? `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} benchmark-lint --cwd ${shellQuote(workDir)} --metric-name ${shellQuote(metricName)} --command ${shellQuote(benchmarkCommand)}` : hasDefaultBenchmarkCommand ? `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} benchmark-lint --cwd ${shellQuote(workDir)} --metric-name ${shellQuote(metricName)} --command ${shellQuote(await defaultBenchmarkCommand(workDir))}` : "";
	const baselineCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)}`;
	const logCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} log --cwd ${shellQuote(workDir)} --from-last --status keep --description ${shellQuote("Describe the kept change")}`;
	const guideCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} guide --cwd ${shellQuote(workDir)}`;
	const scopeWarnings = scopeWarningsFromArgs(planArgs);
	const checklist = firstRunChecklist({
		setupCommand: command,
		benchmarkLintCommand,
		doctorCommand,
		checkpoint: commitPaths.length > 0 ? {
			paths: [
				"autoresearch.md",
				"autoresearch.ideas.md",
				shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1",
				"autoresearch.config.json",
				".gitattributes"
			],
			commands: [`git add -- ${[
				"autoresearch.md",
				"autoresearch.ideas.md",
				shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1",
				"autoresearch.config.json",
				".gitattributes"
			].map(shellQuote).join(" ")}`, `git commit -m ${shellQuote(`Start autoresearch session: ${planArgs.name || "Autoresearch session"}`)}`],
			note: "Run after setup creates files and before the first experiment-scoped keep commit."
		} : null,
		baselineCommand,
		logCommand
	});
	return {
		ok: true,
		workDir,
		sessionCwd,
		configured: Boolean(config && Object.keys(config).length > 0),
		currentMetric: state.config.metricName,
		recommendedRecipe: recommended,
		missing,
		defaultBenchmarkCommandReady: hasDefaultBenchmarkCommand,
		benchmarkMode,
		benchmarkLintCommand,
		scopeWarnings,
		nextCommand: command,
		guideCommand,
		baselineCommand,
		firstRunChecklist: checklist,
		guidedFlow: checklist,
		notes: [
			"setup-plan is read-only.",
			"Before the first live packet, run benchmark-lint or doctor --check-benchmark so a broken or expensive benchmark is caught early.",
			"Generated recipe scripts remain inspectable and should be checkpointed before experiment-scoped keep commits.",
			benchmarkMode.note,
			...scopeWarnings.map((warning) => `Scope warning: ${warning}`)
		]
	};
}
async function promptPlan(args) {
	const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
	const prompt = String(args.prompt || args.goal || args.request || "").trim();
	if (!prompt) throw new Error("prompt-plan requires --prompt <text>.");
	const intent = await analyzeAutoresearchPrompt(workDir, prompt, args);
	const setup = await setupPlan({
		cwd: workDir,
		...intent.setupDefaults,
		name: args.name || intent.setupDefaults.name,
		goal: args.goal || intent.setupDefaults.goal,
		metricName: args.metricName ?? args.metric_name ?? intent.setupDefaults.metricName,
		metric_name: args.metric_name ?? args.metricName ?? intent.setupDefaults.metricName,
		metricUnit: args.metricUnit ?? args.metric_unit ?? intent.setupDefaults.metricUnit,
		metric_unit: args.metric_unit ?? args.metricUnit ?? intent.setupDefaults.metricUnit,
		direction: args.direction || intent.setupDefaults.direction,
		benchmarkCommand: args.benchmarkCommand ?? args.benchmark_command ?? intent.setupDefaults.benchmarkCommand,
		benchmark_command: args.benchmark_command ?? args.benchmarkCommand ?? intent.setupDefaults.benchmarkCommand,
		checksCommand: args.checksCommand ?? args.checks_command ?? intent.setupDefaults.checksCommand,
		checks_command: args.checks_command ?? args.checksCommand ?? intent.setupDefaults.checksCommand,
		filesInScope: args.filesInScope ?? args.files_in_scope ?? intent.setupDefaults.filesInScope,
		files_in_scope: args.files_in_scope ?? args.filesInScope ?? intent.setupDefaults.filesInScope,
		offLimits: args.offLimits ?? args.off_limits ?? intent.setupDefaults.offLimits,
		off_limits: args.off_limits ?? args.offLimits ?? intent.setupDefaults.offLimits,
		constraints: args.constraints ?? intent.setupDefaults.constraints,
		secondaryMetrics: args.secondaryMetrics ?? args.secondary_metrics ?? intent.setupDefaults.secondaryMetrics,
		secondary_metrics: args.secondary_metrics ?? args.secondaryMetrics ?? intent.setupDefaults.secondaryMetrics,
		commitPaths: args.commitPaths ?? args.commit_paths ?? intent.setupDefaults.commitPaths,
		commit_paths: args.commit_paths ?? args.commitPaths ?? intent.setupDefaults.commitPaths,
		maxIterations: args.maxIterations ?? args.max_iterations ?? intent.setupDefaults.maxIterations,
		max_iterations: args.max_iterations ?? args.maxIterations ?? intent.setupDefaults.maxIterations,
		recipe: args.recipe ?? args.recipe_id ?? args.recipeId ?? intent.setupDefaults.recipe,
		recipe_id: args.recipe_id ?? args.recipeId ?? args.recipe ?? intent.setupDefaults.recipe
	});
	const dashboardCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} serve --cwd ${shellQuote(workDir)}`;
	return {
		ok: true,
		workDir,
		kind: "codex-autoresearch-prompt-plan",
		prompt,
		intent,
		setup,
		commands: {
			promptPlan: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} prompt-plan --cwd ${shellQuote(workDir)} --prompt ${shellQuote(prompt)}`,
			setup: setup.nextCommand,
			doctor: setup.guidedFlow.find((step) => step.step === "doctor")?.command || "",
			dashboard: dashboardCommand,
			firstPacket: setup.baselineCommand
		},
		nextAction: intent.nextAction
	};
}
async function analyzeAutoresearchPrompt(workDir, prompt, args) {
	const explicit = parsePromptFields(prompt);
	const discoveredBenchmark = await discoverAutoresearchBenchmark(workDir, prompt);
	const lower = prompt.toLowerCase();
	const speed = /\b(speed|fast|faster|latency|runtime|p99|p90|performance|slow)\b/.test(lower);
	const memory = /\b(memory|rss|heap|footprint|ram)\b/.test(lower);
	const bugs = /\b(bug|bugs|defect|defects|failure|failures|low hanging fruits?)\b/.test(lower);
	const productResearch = /\b(product|docs?|documentation|ux|dashboard|architecture|study|research|delight)\b/.test(lower);
	const testSpeed = /\b(unit tests?|tests?)\b/.test(lower) && speed;
	const latencyRatio = /\bp99\b/.test(lower) && /\bp90\b/.test(lower);
	const maxIterations = positiveIntegerFromPrompt(prompt) ?? positiveIntegerOption(args.max_iterations ?? args.maxIterations, null, "maxIterations");
	const suspects = parseSuspects(prompt);
	const referencedFiles = parseReferencedFiles(prompt);
	const explicitScope = explicit.scope.length ? explicit.scope : [];
	const repoRecipe = await recommendRecipe(workDir);
	const loopKind = bugs || productResearch && !speed && !memory ? "quality-gap" : "measured-optimization";
	const useDiscoveredBenchmark = loopKind === "measured-optimization" ? discoveredBenchmark : null;
	const metricName = explicit.metricName || useDiscoveredBenchmark?.metricName || (bugs || productResearch && !speed && !memory ? "quality_gap" : latencyRatio ? "p99_p90_ratio" : speed && memory ? "score" : speed ? "seconds" : memory ? "rss_mb" : repoRecipe?.metricName || "seconds");
	const direction = explicit.direction || useDiscoveredBenchmark?.direction || (metricName === "quality_gap" || metricName === "p99_p90_ratio" || metricName === "score" || metricName === "seconds" || metricName === "rss_mb" ? "lower" : repoRecipe?.direction || "lower");
	const metricUnit = explicit.metricUnit || useDiscoveredBenchmark?.metricUnit || (metricName === "quality_gap" ? "gaps" : metricName === "seconds" ? "s" : metricName === "rss_mb" ? "MB" : "");
	const secondaryMetrics = uniqueStrings([
		...explicit.secondaryMetrics,
		...speed && memory ? ["seconds", "rss_mb"] : [],
		...latencyRatio ? ["p90_ms", "p99_ms"] : [],
		...suspects.map((suspect) => `suspect:${suspect}`)
	]);
	const constraints = uniqueStrings([
		...explicit.constraints,
		...useDiscoveredBenchmark?.constraints || [],
		...testSpeed ? ["Do not delete or skip correctness tests to improve runtime."] : [],
		...memory ? ["Treat memory regressions as tradeoffs, not invisible wins."] : [],
		...suspects.length ? [`Evaluate suspect families separately: ${suspects.join(", ")}.`] : [],
		...referencedFiles.length ? [`Use referenced experiment notes before inventing new families: ${referencedFiles.join(", ")}.`] : []
	]);
	const filesInScope = uniqueStrings([
		...explicitScope,
		...useDiscoveredBenchmark ? [useDiscoveredBenchmark.path] : [],
		...testSpeed ? ["test runner config", "test helpers"] : [],
		...repoRecipe?.scope || []
	]);
	const offLimits = uniqueStrings(explicit.offLimits);
	const benchmarkCommand = explicit.benchmarkCommand || useDiscoveredBenchmark?.command || "";
	const checksCommand = explicit.checksCommand || "";
	const recipe = benchmarkCommand ? "" : loopKind === "quality-gap" ? "quality-gap" : repoRecipe?.id || "custom";
	const missing = [];
	if (!benchmarkCommand && loopKind === "measured-optimization") missing.push("benchmark_command");
	if (!checksCommand && (testSpeed || bugs)) missing.push("checks_command");
	if (!filesInScope.length) missing.push("scope");
	const experimentPlan = buildPromptExperimentPlan({
		prompt,
		speed,
		memory,
		bugs,
		latencyRatio,
		testSpeed,
		suspects,
		referencedFiles,
		discoveredBenchmark: useDiscoveredBenchmark
	});
	const nextAction = missing.length > 0 ? `Confirm ${missing.join(", ")} or accept the suggested recipe before setup.` : "Run setup, doctor, live dashboard, then one packet.";
	return {
		loopKind,
		confidence: promptPlanConfidence({
			benchmarkCommand,
			explicit,
			speed,
			memory,
			bugs,
			productResearch
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
			discoveredBenchmark: useDiscoveredBenchmark ? {
				path: useDiscoveredBenchmark.path,
				metricName: useDiscoveredBenchmark.metricName,
				command: useDiscoveredBenchmark.command
			} : null
		},
		metric: {
			name: metricName,
			unit: metricUnit,
			direction
		},
		missing,
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
			secondaryMetrics,
			maxIterations,
			commitPaths: filesInScope
		},
		safeInterpretation: safePromptInterpretation({
			prompt,
			testSpeed,
			bugs,
			speed,
			memory
		}),
		nextAction
	};
}
async function discoverAutoresearchBenchmark(workDir, prompt) {
	const scriptsDir = path.join(workDir, "scripts");
	if (!await pathExists(scriptsDir)) return null;
	const candidates = [];
	for (const entry of await fsp.readdir(scriptsDir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isFile()) continue;
		if (!/^autoresearch[-_].+\.(?:mjs|js|cjs|ts)$/.test(entry.name)) continue;
		const absolute = path.join(scriptsDir, entry.name);
		const text = await fsp.readFile(absolute, "utf8").catch(() => "");
		const metrics = metricNamesFromScript(text);
		if (!metrics.length) continue;
		const relative = path.relative(workDir, absolute).replace(/\\/g, "/");
		candidates.push({
			path: relative,
			command: `node ${relative}`,
			metricName: choosePrimaryMetricName(metrics),
			metrics,
			score: benchmarkPromptScore(prompt, relative, text, metrics),
			constraints: benchmarkConstraintsFromScript(relative, metrics)
		});
	}
	candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	const best = candidates[0];
	if (!best || best.score <= 0) return null;
	return {
		...best,
		direction: metricLooksHigherIsBetter(best.metricName) ? "higher" : "lower",
		metricUnit: metricLooksHigherIsBetter(best.metricName) ? "points" : inferMetricUnit(best.metricName)
	};
}
function metricNamesFromScript(text) {
	const names = /* @__PURE__ */ new Set();
	for (const match of text.matchAll(/METRIC\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=/g)) names.add(match[1]);
	for (const match of text.matchAll(/METRIC\s+\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\s*=/g)) names.add(match[1]);
	return [...names].filter((name) => /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name));
}
function choosePrimaryMetricName(metrics) {
	return metrics.find((metric) => /(^|[_:-])score$/i.test(metric)) || metrics.find((metric) => /^quality_gap$/i.test(metric)) || metrics[0];
}
function benchmarkPromptScore(prompt, relativePath, text, metrics) {
	const haystack = `${relativePath}\n${text.slice(0, 4e3)}`.toLowerCase();
	const words = uniqueStrings(prompt.toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 4));
	let score = relativePath.includes("autoresearch") ? 2 : 0;
	for (const word of words) if (haystack.includes(word)) score += 1;
	if (metrics.some((metric) => /score/i.test(metric))) score += 2;
	if (/parse|index|embed|pipeline|benchmark/.test(prompt.toLowerCase()) && /parse|index|embed|pipeline/.test(haystack)) score += 4;
	return score;
}
function benchmarkConstraintsFromScript(relativePath, metrics) {
	const constraints = [`Use existing benchmark surface ${relativePath} before inventing a new timer.`];
	if (metrics.some((metric) => /quality|score/i.test(metric))) constraints.push("Treat the primary score as the decision contract; inspect quality, speed, and footprint components before promoting a speedup.");
	return constraints;
}
function metricLooksHigherIsBetter(metricName) {
	return /score|quality|throughput|docs_per_second|hit|mrr/i.test(metricName);
}
function inferMetricUnit(metricName) {
	if (/seconds|duration|latency|time/i.test(metricName)) return "s";
	if (/rss|memory|heap|mb/i.test(metricName)) return "MB";
	return "";
}
function parsePromptFields(prompt) {
	const field = (name) => {
		return prompt.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() || "";
	};
	const metricMatch = field("Metric").match(/^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s*\(([^)]+)\))?(?:\s*,\s*(lower|higher)\s+is\s+better)?/i);
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
		secondaryMetrics: splitHumanList(secondaryText)
	};
}
function splitHumanList(value) {
	if (!value) return [];
	return value.split(/\r?\n|,|;|\band\b/i).map((item) => item.trim()).filter(Boolean);
}
function positiveIntegerFromPrompt(prompt) {
	const match = prompt.match(/\b(\d{1,4})\s*(?:times|iterations|packets|runs)\b/i);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isInteger(value) && value > 0 ? value : null;
}
function parseSuspects(prompt) {
	const match = prompt.match(/\bI suspect:\s*([^.\n]+)/i);
	if (!match) return [];
	return uniqueStrings(splitHumanList(match[1]).map((item) => item.replace(/^or\s+/i, "")));
}
function parseReferencedFiles(prompt) {
	return uniqueStrings([...prompt.matchAll(/@([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)/g)].map((m) => m[1]));
}
function uniqueStrings(items) {
	return [...new Set(listOption(items).map((item) => String(item).trim()).filter(Boolean))];
}
function titleFromPrompt(prompt, loopKind) {
	return prompt.replace(/^Use\s+\$?Codex Autoresearch\s+to\s+/i, "").replace(/^Use\s+Codex Autoresearch\s+to\s+/i, "").replace(/\s+/g, " ").trim().split(/[.!?]/)[0].slice(0, 72).trim() || (loopKind === "quality-gap" ? "Quality gap loop" : "Measured improvement loop");
}
function buildPromptExperimentPlan({ speed, memory, bugs, latencyRatio, testSpeed, suspects, referencedFiles, discoveredBenchmark }) {
	const lanes = [];
	if (discoveredBenchmark) lanes.push(`Start from existing benchmark surface ${discoveredBenchmark.path}.`);
	if (latencyRatio) lanes.push("Measure p90 and p99 separately before optimizing the ratio.");
	if (speed) lanes.push("Start with profiling or timing the current slow path.");
	if (memory) lanes.push("Track memory as a secondary or composite metric for every packet.");
	if (testSpeed) lanes.push("Try runner configuration, fixture reuse, and expensive setup isolation before changing assertions.");
	if (bugs) lanes.push("Convert accepted bug findings into quality_gap checklist items, then close them with checks.");
	for (const suspect of suspects) lanes.push(`Run a bounded suspect family: ${suspect}.`);
	for (const file of referencedFiles) lanes.push(`Read ${file} before generating experiment families.`);
	return {
		lanes: lanes.length ? lanes : ["Run one baseline packet, then choose the smallest measurable next experiment."],
		stopRules: [
			"Stop a family when it regresses the primary metric without reducing risk.",
			"Repeat measurement before keeping noisy or surprising wins.",
			"Do not finalize until checks and packet freshness are current."
		]
	};
}
function promptPlanConfidence({ benchmarkCommand, explicit, speed, memory, bugs, productResearch }) {
	let score = .35;
	if (benchmarkCommand) score += .25;
	if (explicit.metricName) score += .15;
	if (explicit.checksCommand) score += .1;
	if (speed || memory || bugs || productResearch) score += .15;
	return Math.min(.95, Number(score.toFixed(2)));
}
function safePromptInterpretation({ prompt, testSpeed, bugs, speed, memory }) {
	if (testSpeed) return "Optimize test runtime by changing runner/config/helpers while preserving test coverage and correctness checks.";
	if (bugs) return "Find likely defects, measure accepted fixes through quality_gap or checks, and avoid broad rewrites without evidence.";
	if (speed && memory) return "Optimize speed with memory as an explicit tradeoff, preferably through a composite metric or secondary metric gate.";
	return `Turn the prompt into a measured Autoresearch session: ${prompt}`;
}
async function guidedSetup(args) {
	const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
	const setup = await setupPlan(args);
	const state = await publicState({ cwd: workDir });
	const doctor = await doctorSession({
		cwd: workDir,
		checkBenchmark: false
	});
	const lastRun = await readLastRunPacket(workDir).catch(() => null);
	const lastRunFingerprint = lastRun ? await lastRunPacketFingerprint(workDir).catch(() => "") : "";
	const lastRunFreshness = lastRun ? await lastRunPacketFreshness(workDir, lastRun) : null;
	const lastRunLogStatus = lastRun ? lastRun.decision?.safeSuggestedStatus || lastRun.decision?.suggestedStatus || (lastRun.decision?.allowedStatuses?.length === 1 ? lastRun.decision.allowedStatuses[0] : "discard") : "";
	const replaceLastRunCommand = lastRun ? replacementNextCommandFromLastRun(workDir, lastRun, setup.defaultBenchmarkCommandReady) : "";
	const dashboardCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} serve --cwd ${shellQuote(workDir)}`;
	const baselineCommand = setup.baselineCommand;
	const logCommand = lastRun ? `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} log --cwd ${shellQuote(workDir)} --from-last --status ${shellQuote(lastRunLogStatus)} --description ${shellQuote("Describe the last packet")}` : setup.guidedFlow.find((step) => step.step === "log")?.command;
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
		nextAction = "Add autoresearch.ps1 or autoresearch.sh, or run setup with a benchmark command before using next.";
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
			nextAction: doctor.nextAction
		},
		lastRun: lastRun ? {
			ok: lastRun.ok,
			allowedStatuses: lastRun.decision?.allowedStatuses || [],
			suggestedStatus: lastRun.decision?.suggestedStatus || "",
			rawSuggestedStatus: lastRun.decision?.rawSuggestedStatus || "",
			safeSuggestedStatus: lastRun.decision?.safeSuggestedStatus || lastRunLogStatus,
			statusGuidance: lastRun.decision?.statusGuidance || "",
			asiTemplate: lastRun.decision?.asiTemplate || {},
			diversityGuidance: lastRun.decision?.diversityGuidance || state.memory?.diversityGuidance || null,
			lanePortfolio: lastRun.decision?.lanePortfolio || state.memory?.lanePortfolio || [],
			metric: lastRun.decision?.metric ?? null,
			path: lastRun.lastRunPath || "",
			fingerprint: lastRunFingerprint,
			freshness: lastRunFreshness
		} : null,
		commands: {
			setup: setup.nextCommand,
			benchmarkLint: setup.benchmarkLintCommand,
			doctor: setup.guidedFlow.find((step) => step.step === "doctor")?.command,
			checkpoint: setup.firstRunChecklist.find((step) => step.step === "checkpoint")?.command || "",
			baseline: baselineCommand,
			logLast: logCommand,
			replaceLast: replaceLastRunCommand,
			dashboard: dashboardCommand
		},
		firstRunChecklist: setup.firstRunChecklist,
		scopeWarnings: setup.scopeWarnings,
		settings: dashboardSettings(config),
		diversityGuidance: state.memory?.diversityGuidance || null,
		lanePortfolio: state.memory?.lanePortfolio || [],
		nextAction
	};
}
async function onboardingPacket(args) {
	const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
	const [state, guide, doctor, next] = await Promise.all([
		publicState({
			cwd: workDir,
			compact: true
		}),
		guidedSetup({ cwd: workDir }).catch((error) => ({
			ok: false,
			stage: "blocked",
			warnings: [error.message],
			nextAction: "Fix the guided setup error before running packets."
		})),
		doctorSession({
			cwd: workDir,
			checkBenchmark: false,
			checkInstalled: true,
			explain: true
		}).catch((error) => ({
			ok: false,
			issues: [error.message],
			warnings: [],
			drift: null,
			nextAction: "Fix doctor before running packets."
		})),
		recommendNext({
			cwd: workDir,
			compact: true
		}).catch((error) => ({
			ok: false,
			action: null,
			nextAction: error.message
		}))
	]);
	const commands = continuationCommands(workDir);
	const nextPacket = next;
	return {
		ok: true,
		workDir,
		kind: "codex-autoresearch-onboarding-packet",
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		protocol: [
			"Inspect state and doctor before editing.",
			"Before the first live packet, benchmark-lint or doctor --check-benchmark must prove the primary METRIC contract.",
			"Checkpoint generated session files before experiment-scoped keep commits.",
			"Run exactly one packet with next_experiment or next.",
			"Log the packet with keep, discard, crash, or checks_failed plus ASI.",
			"Read continuation before deciding whether to continue or finalize."
		],
		readFirst: [
			"autoresearch.md",
			"autoresearch.jsonl",
			"autoresearch.ideas.md",
			"autoresearch.last-run.json when present"
		],
		state,
		guidedSetup: guide,
		doctor: {
			ok: doctor.ok,
			issues: doctor.issues || [],
			warnings: doctor.warnings || [],
			drift: doctor.drift || null,
			nextAction: doctor.nextAction
		},
		runtimeTruth: {
			checkedInstalledRuntime: true,
			drift: doctor.drift || null,
			warnings: doctor.drift?.warnings || [],
			nextAction: doctor.drift?.ok === false ? "Refresh or inspect the installed Codex plugin runtime before trusting source-only changes." : "Installed-runtime drift was checked during onboarding."
		},
		nextAction: nextPacket.action || nextPacket.nextBestAction || nextPacket.nextAction || guide.nextAction,
		hazards: compactHazards({
			doctor,
			guide,
			state
		}),
		commands: {
			...commands,
			guide: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} guide --cwd ${shellQuote(workDir)}`,
			doctorExplain: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} doctor --cwd ${shellQuote(workDir)} --explain`,
			onboardingPacket: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} onboarding-packet --cwd ${shellQuote(workDir)} --compact`,
			newSegmentDryRun: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} new-segment --cwd ${shellQuote(workDir)} --dry-run`
		},
		templates: agentReportTemplates(config)
	};
}
async function recommendNext(args) {
	const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
	const viewModel = await dashboardViewModel(workDir, config, {
		deliveryMode: "cli",
		sourceCwd: workDir,
		pluginVersion: PLUGIN_VERSION
	});
	const compact = await publicState({
		cwd: workDir,
		compact: true
	});
	const action = viewModel.nextBestAction || {};
	return {
		ok: true,
		workDir,
		action,
		nextAction: action.detail || viewModel.readout?.nextAction || compact.nextAction,
		whySafe: action.explanation?.evidence || action.utilityCopy || "Derived from state, doctor warnings, ASI memory, and dashboard trust state.",
		avoids: action.explanation?.avoids || "Avoids running a packet before setup, stale-last-run, or trust blockers are resolved.",
		proof: action.explanation?.proof || "The next command should update state or clear the blocker.",
		blockers: viewModel.trustBlockers || compact.blockers || [],
		commands: {
			primary: action.command || action.primaryCommand?.command || "",
			...compact.commands
		},
		compactState: boolOption(args.compact, false) ? compact : void 0
	};
}
function compactHazards({ doctor, guide, state }) {
	return [
		...Array.isArray(doctor?.issues) ? doctor.issues : [],
		...Array.isArray(doctor?.warnings) ? doctor.warnings : [],
		...Array.isArray(guide?.warnings) ? guide.warnings : [],
		...Array.isArray(state?.blockers) ? state.blockers : []
	].map((item) => typeof item === "object" ? item.message || item.code : item).filter(Boolean).slice(0, 8);
}
function agentReportTemplates(config = {}) {
	return {
		firstResponse: "I found the Autoresearch session, checked state/doctor, verified or restarted the live dashboard, and the next safe action is: <action>. Dashboard: <verified url or command>.",
		progress: `Tried: <plain-English hypothesis>. Result: ${config.metricName || "metric"}=<value>, status=<pending|keep|discard|crash|checks_failed>. Meaning: <what changed versus baseline/incumbent>. Decision: <log/keep/discard>. Next: <ASI next_action_hint or continuation>.`,
		final: "Changed: <files/behavior>. Verified: <commands>. Autoresearch: <runs/kept/best/next>. Risks: <remaining blockers>.",
		blocked: "Blocked by <specific layer>. Evidence: <command/output>. Dashboard: <verified replacement URL or unavailable reason>. Safe next action: <fix or command>."
	};
}
function replacementNextCommandFromLastRun(workDir, packet, defaultBenchmarkCommandReady) {
	const parts = [
		"node",
		shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs")),
		"next",
		"--cwd",
		shellQuote(workDir)
	];
	const command = packet?.run?.command;
	if (command) parts.push("--command", shellQuote(command));
	else if (!defaultBenchmarkCommandReady) return "";
	const checksPolicy = packet?.run?.checksPolicy;
	if (CHECKS_POLICIES.has(checksPolicy)) parts.push("--checks-policy", shellQuote(checksPolicy));
	const checksCommand = packet?.run?.checks?.command;
	if (checksCommand) parts.push("--checks-command", shellQuote(checksCommand));
	return parts.join(" ");
}
async function recipeCommand(subcommand, args) {
	if (!subcommand || subcommand === "list") {
		const catalogRecipes = args.catalog ? await loadRecipeCatalog(args.catalog) : [];
		return {
			ok: true,
			recipes: [...listBuiltInRecipes(), ...catalogRecipes]
		};
	}
	if (subcommand === "recommend") {
		const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
		const recipe = await recommendRecipe(workDir);
		const setup = await setupPlan({
			cwd: workDir,
			recipe: args.recipe || recipe?.id,
			catalog: args.catalog
		});
		return {
			ok: true,
			workDir,
			recommendedRecipe: recipe,
			reason: recipe ? `Detected project shape matches ${recipe.title}.` : "No built-in recipe matched strongly; use custom setup.",
			nextCommand: setup.nextCommand,
			doctorCommand: setup.guidedFlow.find((step) => step.step === "doctor")?.command || ""
		};
	}
	if (subcommand === "show") {
		const id = args._[2] || args.id || args.recipe || args.recipeId;
		if (!id) throw new Error("recipes show requires a recipe id");
		const catalogRecipes = args.catalog ? await loadRecipeCatalog(args.catalog) : [];
		const recipe = [...listBuiltInRecipes(), ...catalogRecipes].find((item) => item.id === id);
		if (!recipe) throw new Error(`Unknown recipe: ${id}`);
		return {
			ok: true,
			recipe
		};
	}
	throw new Error(`Unknown recipes subcommand: ${subcommand}`);
}
async function interactiveSetup(args) {
	const recipe = (await setupPlan(args)).recommendedRecipe || getBuiltInRecipe("custom");
	const rl = createInterface({
		input: stdin,
		output: stdout
	});
	try {
		const ask = async (prompt, fallback) => {
			return (await rl.question(`${prompt}${fallback ? ` (${fallback})` : ""}: `)).trim() || fallback;
		};
		const selectedRecipeId = await ask("Recipe id", recipe?.id || "custom");
		const selectedRecipe = await findRecipe(selectedRecipeId, args.catalog);
		if (!selectedRecipe) throw new Error(`Unknown recipe: ${selectedRecipeId}`);
		const setup = await setupSession(await withRecipeDefaults({
			...args,
			recipe: selectedRecipeId,
			name: await ask("Session name", args.name || selectedRecipe.title || "Autoresearch session"),
			goal: await ask("Goal", args.goal || "Improve the measured target"),
			metricName: await ask("Primary metric", args.metricName || args.metric_name || selectedRecipe.metricName || "seconds"),
			metricUnit: await ask("Metric unit", args.metricUnit || args.metric_unit || selectedRecipe.metricUnit || ""),
			direction: await ask("Direction lower/higher", args.direction || selectedRecipe.direction || "lower"),
			filesInScope: await ask("Files in scope (comma separated)", args.filesInScope || args.files_in_scope || (selectedRecipe.scope || []).join(",")),
			checksCommand: await ask("Checks command", args.checksCommand || args.checks_command || selectedRecipe.checksCommand || ""),
			commitPaths: await ask("Commit paths (comma separated)", args.commitPaths || args.commit_paths || ""),
			maxIterations: await ask("Max iterations", args.maxIterations || args.max_iterations || "50")
		}));
		return {
			ok: true,
			setup,
			doctor: await doctorSession({
				cwd: setup.workDir,
				checkBenchmark: false
			}),
			baselineCommand: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(setup.workDir)}`
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
	const explicitScope = listOption(args.files_in_scope ?? args.filesInScope ?? args.scope);
	const commitScope = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths").map((item) => `\`${item}\`: in configured commit scope`);
	const scope = explicitScope.length ? explicitScope : commitScope;
	const offLimits = listOption(args.off_limits ?? args.offLimits);
	const constraints = listOption(args.constraints);
	const constraintsPlaceholder = "- <Correctness, compatibility, dependency, or budget constraints>";
	const secondary = listOption(args.secondary_metrics ?? args.secondaryMetrics);
	const benchmarkCommand = args.benchmark_command || args.benchmarkCommand || "./autoresearch.sh";
	const metricUnit = args.metric_unit ?? args.metricUnit ?? "";
	const direction = args.direction === "higher" ? "higher" : "lower";
	const primaryMetric = validateMetricName(args.metric_name || args.metricName);
	const metricContractNote = metricLooksHigherIsBetter(primaryMetric) ? `- Decision contract: ${primaryMetric} is treated as a quality-bearing score; faster runs should not be promoted when component evidence shows quality or correctness erosion.` : `- Decision contract: ${primaryMetric} is the primary metric; secondary evidence explains tradeoffs but should not silently override it.`;
	return replaceAllText(readAssetTemplate("autoresearch.md.template"), {
		"<goal>": args.name,
		"<Specific description of what is being optimized and the workload.>": args.goal || args.name,
		"- Primary: <name> (<unit>, lower/higher is better)": `- Primary: ${primaryMetric} (${metricUnit || "unitless"}, ${direction} is better)`,
		"- Secondary: <name>, <name>": secondary.length ? `- Secondary: ${secondary.join(", ")}` : "- Secondary: none yet",
		"`<benchmark command>` prints `METRIC name=value` lines.": `\`${benchmarkCommand}\` prints \`METRIC name=value\` lines.`,
		"- `<path>`: <why it matters>": markdownList(scope, "TBD: add files after initial inspection"),
		"- `<path or behavior>`: <reason>": markdownList(offLimits, "TBD: add off-limits files or behaviors if needed"),
		[constraintsPlaceholder]: markdownList(uniqueStrings([metricContractNote, ...constraints]), "TBD: add correctness and compatibility constraints"),
		"- Baseline: <initial metric and notes>": "- Baseline: pending"
	});
}
function renderIdeasDocument(args) {
	const title = args.name || "Autoresearch";
	const goal = String(args.goal || args.name || "").trim();
	const constraints = listOption(args.constraints);
	const secondary = listOption(args.secondary_metrics ?? args.secondaryMetrics);
	const ideas = uniqueStrings([
		...goal ? [`Baseline the current behavior for: ${goal}`] : [],
		...secondary.length ? [`Track secondary metrics explicitly: ${secondary.join(", ")}.`] : [],
		...constraints.filter((constraint) => !/^Decision contract:/i.test(constraint)).slice(0, 3).map((constraint) => `Validate constraint before promotion: ${constraint}`),
		"Reserve one packet for a distant-scout lane before repeating the same near-neighbor tweak.",
		"If a promotion-grade packet has no decision row, log it as benchmark coverage work rather than a candidate regression."
	]);
	return [
		`# Autoresearch Ideas: ${title}`,
		"",
		...ideas.map((idea) => `- ${idea}`),
		""
	].join("\n");
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
		""
	].join("\n");
}
function renderBenchmarkScript(args, shellKind) {
	const command = args.benchmark_command || args.benchmarkCommand;
	if (!command) return renderMissingCommandScript(shellKind, "benchmark", "--benchmark-command");
	const metricName = validateMetricName(args.metric_name || args.metricName || "elapsed_seconds");
	const hasExplicitBenchmarkCommand = Boolean(args.benchmark_command || args.benchmarkCommand);
	if (boolOption(args.benchmark_prints_metric ?? args.benchmarkPrintsMetric, hasExplicitBenchmarkCommand)) {
		if (shellKind === "bash") return [
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			"",
			"# This recipe command is responsible for printing METRIC lines.",
			command,
			""
		].join("\n");
		return [
			"$ErrorActionPreference = \"Stop\"",
			"",
			"# This recipe command is responsible for printing METRIC lines.",
			"$global:LASTEXITCODE = 0",
			command,
			"if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
			""
		].join("\n");
	}
	return replaceAllText(readAssetTemplate(shellKind === "bash" ? "autoresearch.sh.template" : "autoresearch.ps1.template"), {
		"<benchmark command>": command,
		"<metric name>": metricName
	});
}
function renderChecksScript(args, shellKind) {
	const command = args.checks_command || args.checksCommand;
	if (!command) return renderMissingCommandScript(shellKind, "checks", "--checks-command");
	return replaceAllText(readAssetTemplate(shellKind === "bash" ? "autoresearch.checks.sh.template" : "autoresearch.checks.ps1.template"), { "<check command>": command });
}
function renderMissingCommandScript(shellKind, kind, optionName) {
	const message = `Autoresearch ${kind} command is not configured. Re-run setup with ${optionName}.`;
	if (shellKind === "bash") return [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"",
		`printf '%s\\n' ${shellQuote(message)} >&2`,
		"exit 2",
		""
	].join("\n");
	return [
		"$ErrorActionPreference = \"Stop\"",
		"",
		`Write-Error ${shellQuote(message)}`,
		"exit 2",
		""
	].join("\n");
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
	if (shellKind === "bash") return [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"",
		`${shellQuote(process.execPath)} ${shellQuote(script)} quality-gap --cwd . --research-slug ${shellQuote(slug)}`,
		""
	].join("\n");
	return [
		"$ErrorActionPreference = \"Stop\"",
		"",
		`& ${shellQuote(process.execPath)} ${shellQuote(script)} quality-gap --cwd . --research-slug ${shellQuote(slug)}`,
		"if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
		""
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
`
};
function renderResearchFile(fileName, args, slug) {
	const goal = args.goal || args.name || slug;
	const renderer = RESEARCH_FILE_TEMPLATES[fileName];
	if (renderer) return renderer({
		title: researchTitle(goal),
		goal,
		args
	});
	throw new Error(`Unknown research file template: ${fileName}`);
}
function parseQualityGaps(text) {
	const items = parseQualityGapItems(text);
	return {
		open: items.open.length,
		closed: items.closed.length,
		total: items.open.length + items.closed.length
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
	return {
		open,
		closed
	};
}
async function writeSessionFile(filePath, content, options = {}) {
	const exists = await pathExists(filePath);
	if (exists && !options.overwrite) return {
		path: filePath,
		action: "kept"
	};
	await fsp.writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
	if (options.executable) await fsp.chmod(filePath, 493).catch(() => {});
	return {
		path: filePath,
		action: exists ? "overwritten" : "created"
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
	return bestMetric(runs.filter((run) => run.status === "keep"), direction);
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
function metricParseSource(result) {
	if (!result) return "";
	const retained = result.retainedMetricOutput || "";
	if (result.metricOutput) return [
		result.metricOutput,
		result.metricOutputTruncated && result.fullOutput ? result.fullOutput : "",
		retained
	].filter(Boolean).join("\n");
	return [result.fullOutput || result.output || "", retained].filter(Boolean).join("\n");
}
function headText(text, maxLines = OUTPUT_MAX_LINES, maxBytes = OUTPUT_MAX_BYTES) {
	let trimmed = text;
	if (Buffer.byteLength(trimmed, "utf8") > maxBytes) trimmed = Buffer.from(trimmed, "utf8").subarray(0, maxBytes).toString("utf8");
	const lines = trimmed.split(/\r?\n/);
	if (lines.length > maxLines) trimmed = lines.slice(0, maxLines).join("\n");
	return trimmed;
}
async function defaultBenchmarkCommand(workDir) {
	if (await pathExists(path.join(workDir, "autoresearch.ps1"))) return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
	if (await pathExists(path.join(workDir, "autoresearch.sh"))) return "bash ./autoresearch.sh";
	throw new Error("No command provided; expected autoresearch.ps1 or autoresearch.sh in the work directory.");
}
async function defaultBenchmarkCommandExists(workDir) {
	return await pathExists(path.join(workDir, "autoresearch.ps1")) || await pathExists(path.join(workDir, "autoresearch.sh"));
}
async function defaultChecksCommand(workDir) {
	if (await pathExists(path.join(workDir, "autoresearch.checks.ps1"))) return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.checks.ps1";
	if (await pathExists(path.join(workDir, "autoresearch.checks.sh"))) return "bash ./autoresearch.checks.sh";
	return null;
}
function checksPolicyFromArgs(args, config) {
	return enumOption(args.checks_policy ?? args.checksPolicy ?? config.checksPolicy, CHECKS_POLICIES, "always", "checksPolicy");
}
function shouldRunChecks(policy, context) {
	if (!context.benchmarkPassed || !context.primaryPresent || !context.checksCommand) return false;
	if (policy === "always") return true;
	if (policy === "on-improvement") return context.improvesPrimary || context.explicitChecksCommand;
	return context.explicitChecksCommand;
}
async function runProcess(command, args, cwd, options = {}) {
	const result = await runProcess$1(command, args, {
		cwd,
		timeoutSeconds: options.timeoutMs ? Math.max(1, Number(options.timeoutMs) / 1e3) : 600
	});
	return {
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr
	};
}
async function git(args, cwd) {
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
	const result = await git([
		"rev-parse",
		"--git-path",
		relativePath
	], cwd);
	if (result.code !== 0) throw new Error(`Git path lookup failed: ${gitOutput(result, "unknown error")}`);
	const filePath = result.stdout.trim();
	return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}
async function shortHead(cwd) {
	const result = await git([
		"rev-parse",
		"--short=7",
		"HEAD"
	], cwd);
	return result.code === 0 ? result.stdout.trim() : "";
}
async function resolveCommitRef(cwd, commit) {
	const value = String(commit || "").trim();
	if (!value) throw new Error("commit is required");
	const result = await git([
		"rev-parse",
		"--verify",
		`${value}^{commit}`
	], cwd);
	if (result.code !== 0) throw new Error(`Git commit could not be resolved: ${gitOutput(result, value)}`);
	return result.stdout.trim();
}
async function hasStagedChanges(cwd) {
	return (await git([
		"diff",
		"--cached",
		"--quiet"
	], cwd)).code === 1;
}
async function isGitClean(cwd) {
	if (!await insideGitRepo(cwd)) return null;
	const result = await git(["status", "--porcelain"], cwd);
	if (result.code !== 0) return false;
	return result.stdout.trim() === "";
}
function emptyCommitPathsWarning() {
	return {
		code: EMPTY_COMMIT_PATHS_WARNING_CODE,
		severity: "warning",
		message: "Kept runs will not auto-commit because commitPaths is empty. Configure commitPaths, pass --commit-paths, or use --allow-add-all explicitly.",
		action: "Configure commitPaths for the experiment surface before logging kept changes, or use --allow-add-all when broad staging is intentional."
	};
}
function shouldWarnEmptyCommitPaths({ inGit, commitPaths = [], explicitCommit = false, allowAddAll = false } = {}) {
	return Boolean(inGit && !explicitCommit && !allowAddAll && commitPaths.length === 0);
}
async function gitStatusShort(cwd) {
	const result = await git([
		"status",
		"--porcelain=v1",
		"-uall"
	], cwd);
	if (result.code !== 0) throw new Error(`Git status failed: ${gitOutput(result, "unknown error")}`);
	return result.stdout.trim();
}
function hashText(value) {
	return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}
async function scopedFileFingerprints(workDir, paths = []) {
	const safePaths = normalizeRelativePaths(paths, "commitPaths");
	if (safePaths.length === 0) return [];
	const result = await git([
		"ls-files",
		"--",
		...safePaths
	], workDir);
	if (result.code !== 0) return [];
	const files = result.stdout.split(/\r?\n/).map((file) => file.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
	const fingerprints = [];
	for (const file of files) {
		const filePath = path.join(workDir, file);
		try {
			const bytes = await fsp.readFile(filePath);
			fingerprints.push({
				path: file,
				hash: createHash("sha256").update(bytes).digest("hex")
			});
		} catch (error) {
			fingerprints.push({
				path: file,
				missing: true,
				error: error?.code || error?.message || String(error)
			});
		}
	}
	return fingerprints;
}
function dirtyPathsFromStatus(statusShort) {
	return String(statusShort || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).map((line) => {
		const rawPath = /^.. /.test(line) ? line.slice(3).trim() : line.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim();
		return (rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath).replace(/^"|"$/g, "").replace(/\\"/g, "\"").replace(/\\/g, "/");
	}).filter(Boolean).sort((a, b) => a.localeCompare(b));
}
async function fileFingerprintsForPaths(workDir, paths = []) {
	const fingerprints = [];
	for (const file of [...new Set(paths)].sort((a, b) => a.localeCompare(b))) {
		const filePath = path.join(workDir, file);
		try {
			const stats = await fsp.lstat(filePath);
			if (stats.isDirectory()) {
				const children = await directoryFingerprints(workDir, file);
				fingerprints.push({
					path: file,
					directory: true,
					files: children
				});
				continue;
			}
			if (stats.isSymbolicLink()) {
				fingerprints.push({
					path: file,
					symlink: await fsp.readlink(filePath)
				});
				continue;
			}
			const bytes = await fsp.readFile(filePath);
			fingerprints.push({
				path: file,
				hash: createHash("sha256").update(bytes).digest("hex")
			});
		} catch (error) {
			fingerprints.push({
				path: file,
				missing: true,
				error: error?.code || error?.message || String(error)
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
				entries.push({
					path: relativePath,
					directory: true
				});
				await visit(relativePath);
			} else if (dirent.isSymbolicLink()) entries.push({
				path: relativePath,
				symlink: await fsp.readlink(absolutePath)
			});
			else if (dirent.isFile()) {
				const bytes = await fsp.readFile(absolutePath);
				entries.push({
					path: relativePath,
					hash: createHash("sha256").update(bytes).digest("hex")
				});
			} else {
				const stats = await fsp.lstat(absolutePath);
				entries.push({
					path: relativePath,
					type: stats.isFIFO() ? "fifo" : "other"
				});
			}
		}
	}
	await visit(rootPath);
	return entries;
}
async function lastRunGitSnapshot(workDir, config = {}) {
	if (!await insideGitRepo(workDir).catch(() => false)) return { inside: false };
	const scopedPaths = normalizeRelativePaths(config.commitPaths, "commitPaths");
	const statusShort = await gitStatusShort(workDir);
	return {
		inside: true,
		head: await shortHead(workDir),
		dirty: Boolean(statusShort),
		statusHash: hashText(statusShort),
		scopedPaths,
		fileFingerprints: await scopedFileFingerprints(workDir, scopedPaths),
		dirtyFileFingerprints: await fileFingerprintsForPaths(workDir, dirtyPathsFromStatus(statusShort))
	};
}
async function preserveSessionFiles(workDir) {
	const saved = /* @__PURE__ */ new Map();
	for (const file of SESSION_FILES) {
		const filePath = path.join(workDir, file);
		if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) saved.set(file, {
			type: "file",
			bytes: fs.readFileSync(filePath)
		});
	}
	const researchPath = path.join(workDir, RESEARCH_DIR);
	if (fs.existsSync(researchPath) && fs.statSync(researchPath).isDirectory()) {
		const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-preserve-"));
		fs.cpSync(researchPath, tempPath, { recursive: true });
		saved.set(RESEARCH_DIR, {
			type: "dir",
			tempPath
		});
	}
	return saved;
}
async function restoreSessionFiles(workDir, saved) {
	for (const [file, artifact] of saved.entries()) {
		const filePath = path.join(workDir, file);
		if (artifact.type === "dir") {
			await fsp.rm(filePath, {
				recursive: true,
				force: true
			});
			await fsp.mkdir(path.dirname(filePath), { recursive: true });
			await fsp.cp(artifact.tempPath, filePath, { recursive: true });
			await fsp.rm(artifact.tempPath, {
				recursive: true,
				force: true
			});
		} else {
			await fsp.mkdir(path.dirname(filePath), { recursive: true });
			await fsp.writeFile(filePath, artifact.bytes);
		}
	}
}
async function appendSessionRunNote(workDir, experiment, state, messages = {}) {
	const filePath = path.join(workDir, "autoresearch.md");
	if (!await pathExists(filePath)) return;
	const parts = [
		`- Run ${experiment.run} ${experiment.status}: ${experiment.description}`,
		`metric=${experiment.metric}`,
		`best=${state.best ?? "unknown"}`
	];
	if (experiment.commit) parts.push(`commit=${experiment.commit}`);
	if (messages.revertMessage) parts.push(messages.revertMessage);
	if (messages.gitMessage && experiment.status === "keep") parts.push(messages.gitMessage);
	await fsp.appendFile(filePath, `\n${parts.join("; ")}.\n`, "utf8");
}
async function revertExceptSessionFiles(workDir) {
	if (!await insideGitRepo(workDir)) return "Git: not a repo, skipped revert.";
	const saved = await preserveSessionFiles(workDir);
	const restore = await git([
		"restore",
		"--worktree",
		"--staged",
		"--",
		"."
	], workDir);
	if (restore.code !== 0) {
		await restoreSessionFiles(workDir, saved);
		throw new Error(`Git restore failed during discard cleanup: ${gitOutput(restore, "unknown error")}`);
	}
	const clean = await git(["clean", "-fd"], workDir);
	if (clean.code !== 0) {
		await restoreSessionFiles(workDir, saved);
		throw new Error(`Git clean failed during discard cleanup: ${gitOutput(clean, "unknown error")}`);
	}
	await restoreSessionFiles(workDir, saved);
	return "Git: reverted non-session changes; autoresearch files preserved.";
}
async function revertScopedPathsExceptSessionFiles(workDir, paths) {
	if (!await insideGitRepo(workDir)) return "Git: not a repo, skipped revert.";
	const safePaths = normalizeRelativePaths(paths, "revertPaths");
	if (!safePaths.length) throw new Error("No scoped paths were provided for discard cleanup.");
	const saved = await preserveSessionFiles(workDir);
	const restore = await git([
		"restore",
		"--worktree",
		"--staged",
		"--",
		...safePaths
	], workDir);
	if (restore.code !== 0) {
		await restoreSessionFiles(workDir, saved);
		throw new Error(`Git scoped restore failed during discard cleanup: ${gitOutput(restore, "unknown error")}`);
	}
	const clean = await git([
		"clean",
		"-fd",
		"--",
		...safePaths
	], workDir);
	if (clean.code !== 0) {
		await restoreSessionFiles(workDir, saved);
		throw new Error(`Git scoped clean failed during discard cleanup: ${gitOutput(clean, "unknown error")}`);
	}
	await restoreSessionFiles(workDir, saved);
	return `Git: reverted scoped experiment paths (${safePaths.join(", ")}); autoresearch files preserved.`;
}
async function cleanupDiscardChanges(workDir, args, config) {
	if (!await insideGitRepo(workDir)) return "Git: not a repo, skipped revert.";
	const scopedPaths = normalizeRelativePaths(args.revert_paths ?? args.revertPaths ?? args.commit_paths ?? args.commitPaths ?? config.commitPaths, "revertPaths");
	if (scopedPaths.length > 0) return await revertScopedPathsExceptSessionFiles(workDir, scopedPaths);
	if (!await gitStatusShort(workDir)) return "Git: clean tree, no discard cleanup needed.";
	if (boolOption(args.allow_dirty_revert ?? args.allowDirtyRevert, false)) return await revertExceptSessionFiles(workDir);
	throw new Error("Refusing broad discard cleanup in a dirty Git tree without scoped revert paths. Configure commitPaths/revertPaths or pass --allow-dirty-revert.");
}
function mergeRuntimeConfig(sessionCwd, updates) {
	const configPath = runtimeConfigPath(sessionCwd);
	const nextConfig = {
		...readConfig(sessionCwd),
		...updates
	};
	return {
		configPath,
		nextConfig,
		content: JSON.stringify(nextConfig, null, 2)
	};
}
async function appendRuntimeConfigFile(files, sessionCwd, updates) {
	if (Object.keys(updates).length === 0) return;
	const { configPath, content } = mergeRuntimeConfig(sessionCwd, updates);
	files.push(await writeSessionFile(configPath, content, { overwrite: true }));
}
function setupCheckpointGuidance(workDir, files, name) {
	const paths = [...new Set(files.map((file) => path.relative(workDir, file.path).replace(/\\/g, "/")).filter((filePath) => filePath && !filePath.startsWith("..") && !path.isAbsolute(filePath)))];
	return {
		paths,
		commands: paths.length ? [`git add -- ${paths.map(shellQuote).join(" ")}`, `git commit -m ${shellQuote(`Start autoresearch session: ${name}`)}`] : [],
		note: "Checkpoint these generated session files before the first experiment commit if this project is in Git."
	};
}
async function ensureAutoresearchGitattributes(workDir) {
	const filePath = path.join(workDir, ".gitattributes");
	const exists = await pathExists(filePath);
	const current = exists ? await fsp.readFile(filePath, "utf8") : "";
	const hasJsonlRule = /^autoresearch\.jsonl\s+.*\beol=lf\b/im.test(current);
	const hasMdRule = /^autoresearch\.md\s+.*\beol=lf\b/im.test(current);
	const hasIdeasRule = /^autoresearch\.ideas\.md\s+.*\beol=lf\b/im.test(current);
	if (hasJsonlRule && hasMdRule && hasIdeasRule) return {
		path: filePath,
		action: "kept"
	};
	const separator = current.trimEnd() ? "\n\n" : "";
	await fsp.writeFile(filePath, `${current.trimEnd()}${separator}${AUTORESEARCH_GITATTRIBUTES_BLOCK}\n`, "utf8");
	return {
		path: filePath,
		action: exists ? "updated" : "created"
	};
}
async function writeRuntimeConfig(sessionCwd, updates) {
	if (Object.keys(updates).length === 0) return readConfig(sessionCwd);
	const { configPath, nextConfig, content } = mergeRuntimeConfig(sessionCwd, updates);
	await fsp.writeFile(configPath, `${content}\n`, "utf8");
	return nextConfig;
}
function runtimeConfigUpdatesFromArgs(args) {
	const updates = {};
	const autonomyMode = enumOption(args.autonomy_mode ?? args.autonomyMode, AUTONOMY_MODES, null, "autonomyMode");
	const checksPolicy = enumOption(args.checks_policy ?? args.checksPolicy, CHECKS_POLICIES, null, "checksPolicy");
	const keepPolicy = enumOption(args.keep_policy ?? args.keepPolicy, KEEP_POLICIES, null, "keepPolicy");
	const dashboardRefreshSeconds = numberOption(args.dashboard_refresh_seconds ?? args.dashboardRefreshSeconds, null);
	if (autonomyMode) updates.autonomyMode = autonomyMode;
	if (checksPolicy) updates.checksPolicy = checksPolicy;
	if (keepPolicy) updates.keepPolicy = keepPolicy;
	if (dashboardRefreshSeconds != null) updates.dashboardRefreshSeconds = Math.max(1, Math.floor(dashboardRefreshSeconds));
	return updates;
}
async function writeSetupBootstrapFiles(args, options) {
	const { sessionCwd, workDir } = resolveWorkDir(args.working_dir || args.cwd);
	const overwrite = boolOption(args.overwrite, false);
	const shellKind = shellKindFromArgs(args);
	const benchmarkFile = shellKind === "bash" ? "autoresearch.sh" : "autoresearch.ps1";
	const checksFile = shellKind === "bash" ? "autoresearch.checks.sh" : "autoresearch.checks.ps1";
	const files = [];
	const context = {
		sessionCwd,
		workDir,
		overwrite,
		shellKind,
		benchmarkFile,
		checksFile,
		files
	};
	if (options.beforeCommonFiles) await options.beforeCommonFiles(context);
	files.push(await writeSessionFile(path.join(workDir, "autoresearch.md"), `${renderSessionDocument(options.sessionDocumentArgs(context)).trimEnd()}\n\n${renderResumeBlock(workDir)}`, { overwrite }));
	files.push(await writeSessionFile(path.join(workDir, benchmarkFile), options.benchmarkContent(context), {
		overwrite,
		executable: shellKind === "bash"
	}));
	files.push(await writeSessionFile(path.join(workDir, "autoresearch.ideas.md"), options.ideasContent(context), { overwrite }));
	if (!boolOption(args.skip_gitattributes ?? args.skipGitattributes, false)) files.push(await ensureAutoresearchGitattributes(workDir));
	if (args.checks_command || args.checksCommand || boolOption(args.create_checks ?? args.createChecks, false)) files.push(await writeSessionFile(path.join(workDir, checksFile), renderChecksScript(args, shellKind), {
		overwrite,
		executable: shellKind === "bash"
	}));
	return context;
}
async function setupSession(args) {
	args = await withRecipeDefaults(args);
	if (!args.name) throw new Error("name is required");
	if (!args.metric_name && !args.metricName) throw new Error("metric_name is required");
	validateMetricName(args.metric_name || args.metricName);
	const { sessionCwd, workDir, shellKind, files } = await writeSetupBootstrapFiles(args, {
		sessionDocumentArgs: () => args,
		benchmarkContent: ({ shellKind: setupShellKind }) => renderBenchmarkScript(args, setupShellKind),
		ideasContent: () => renderIdeasDocument(args)
	});
	const maxIterations = positiveIntegerOption(args.max_iterations ?? args.maxIterations, null, "maxIterations");
	const setupConfig = {};
	if (maxIterations != null) setupConfig.maxIterations = maxIterations;
	if (args.recipe_id || args.recipeId || args.recipe) setupConfig.recipeId = args.recipe_id || args.recipeId || args.recipe;
	if (Object.keys(setupConfig).length > 0) await appendRuntimeConfigFile(files, sessionCwd, setupConfig);
	const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
	if (commitPaths.length > 0) await appendRuntimeConfigFile(files, sessionCwd, { commitPaths });
	const runtimeUpdates = runtimeConfigUpdatesFromArgs(args);
	if (Object.keys(runtimeUpdates).length > 0) await appendRuntimeConfigFile(files, sessionCwd, runtimeUpdates);
	let init = null;
	if (!boolOption(args.skip_init ?? args.skipInit, false)) init = await initExperiment(args);
	const checkpoint = setupCheckpointGuidance(workDir, files, args.name);
	const metricName = validateMetricName(args.metric_name || args.metricName);
	const benchmarkCommand = shellKind === "bash" ? "bash ./autoresearch.sh" : "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
	const benchmarkMode = {
		explicitCommand: Boolean(args.benchmark_command || args.benchmarkCommand),
		printsMetric: explicitBenchmarkPrintsMetric(args),
		note: explicitBenchmarkPrintsMetric(args) ? "The benchmark command/script is expected to print METRIC lines." : "The generated benchmark script wraps the command and emits the primary metric from elapsed time."
	};
	const benchmarkLintCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} benchmark-lint --cwd ${shellQuote(workDir)} --metric-name ${shellQuote(metricName)} --command ${shellQuote(benchmarkCommand)}`;
	const doctorCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} doctor --cwd ${shellQuote(workDir)} --check-benchmark`;
	const baselineCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)}`;
	const logCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} log --cwd ${shellQuote(workDir)} --from-last --status keep --description ${shellQuote("Describe the kept change")}`;
	return {
		ok: true,
		workDir,
		sessionCwd,
		shell: shellKind,
		files,
		checkpoint,
		benchmarkMode,
		benchmarkLintCommand,
		scopeWarnings: scopeWarningsFromArgs(args),
		firstRunChecklist: firstRunChecklist({
			setupCommand: "already completed",
			benchmarkLintCommand,
			doctorCommand,
			checkpoint,
			baselineCommand,
			logCommand
		}),
		init
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
				"quality-gaps.md"
			]) setupFiles.push(await writeSessionFile(path.join(researchDir, fileName), renderResearchFile(fileName, args, slug), { overwrite }));
		},
		sessionDocumentArgs: ({ shellKind: setupShellKind }) => {
			const benchmarkCommand = setupShellKind === "bash" ? "./autoresearch.sh" : "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
			const scopedFiles = [researchRelativeDir(slug), ...listOption(args.files_in_scope ?? args.filesInScope ?? args.scope)];
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
					"Use source-backed evidence before implementing recommendations."
				]
			};
		},
		benchmarkContent: ({ shellKind: setupShellKind }) => renderResearchBenchmarkScript(slug, setupShellKind),
		ideasContent: () => `# Autoresearch Ideas: ${goal}\n\n- Add promising research-backed ideas here when they are not tried immediately.\n`
	});
	const researchDir = researchDirPath(workDir, slug);
	const maxIterations = positiveIntegerOption(args.max_iterations ?? args.maxIterations, null, "maxIterations");
	const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
	const runtimeUpdates = runtimeConfigUpdatesFromArgs(args);
	if (maxIterations != null || commitPaths.length > 0 || Object.keys(runtimeUpdates).length > 0) {
		const nextConfig = { ...runtimeUpdates };
		if (maxIterations != null) nextConfig.maxIterations = maxIterations;
		if (commitPaths.length > 0) nextConfig.commitPaths = commitPaths;
		await appendRuntimeConfigFile(files, sessionCwd, nextConfig);
	}
	let init = null;
	if (!boolOption(args.skip_init ?? args.skipInit, false)) init = await initExperiment({
		cwd: workDir,
		name: args.name || `Deep research: ${goal}`,
		metricName: "quality_gap",
		metricUnit: "gaps",
		direction: "lower"
	});
	const gap = await measureQualityGap({
		cwd: workDir,
		researchSlug: slug
	});
	const checkpoint = setupCheckpointGuidance(workDir, files, args.name || `Deep research: ${goal}`);
	const benchmarkCommand = shellKind === "bash" ? "bash ./autoresearch.sh" : "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
	const benchmarkLintCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} benchmark-lint --cwd ${shellQuote(workDir)} --metric-name ${shellQuote("quality_gap")} --command ${shellQuote(benchmarkCommand)}`;
	const doctorCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} doctor --cwd ${shellQuote(workDir)} --check-benchmark`;
	const baselineCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)}`;
	const logCommand = `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} log --cwd ${shellQuote(workDir)} --from-last --status keep --description ${shellQuote("Describe the kept change")}`;
	return {
		ok: true,
		workDir,
		sessionCwd,
		slug,
		researchDir,
		shell: shellKind,
		files,
		checkpoint,
		benchmarkMode: {
			explicitCommand: true,
			printsMetric: true,
			note: "The generated research benchmark emits quality_gap METRIC lines from the scratchpad."
		},
		benchmarkLintCommand,
		scopeWarnings: scopeWarningsFromArgs(args),
		firstRunChecklist: firstRunChecklist({
			setupCommand: "already completed",
			benchmarkLintCommand,
			doctorCommand,
			checkpoint,
			baselineCommand,
			logCommand
		}),
		init,
		qualityGap: {
			open: gap.open,
			closed: gap.closed,
			total: gap.total
		}
	};
}
async function measureQualityGap(args) {
	const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
	const slugResolution = resolveResearchSlugForQualityGapSync(args, workDir);
	const slug = slugResolution.slug;
	const researchDir = researchDirPath(workDir, slug);
	const gapsPath = path.join(researchDir, "quality-gaps.md");
	if (!await pathExists(gapsPath)) throw new Error(`No quality-gaps.md found for research slug '${slug}' at ${gapsPath}`);
	const text = await fsp.readFile(gapsPath, "utf8");
	const counts = parseQualityGaps(text);
	const items = parseQualityGapItems(text);
	const metricOutput = [
		`METRIC quality_gap=${counts.open}`,
		`METRIC quality_total=${counts.total}`,
		`METRIC quality_closed=${counts.closed}`
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
		metricOutput
	};
}
async function currentQualityGapSummary(workDir) {
	const researchRoot = path.join(workDir, RESEARCH_DIR);
	if (!await pathExists(researchRoot)) return null;
	const entries = await fsp.readdir(researchRoot, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const slug = entry.name;
		const gapsPath = path.join(researchRoot, slug, "quality-gaps.md");
		if (!await pathExists(gapsPath)) continue;
		const text = await fsp.readFile(gapsPath, "utf8");
		const counts = parseQualityGaps(text);
		const items = parseQualityGapItems(text);
		return {
			slug,
			path: gapsPath,
			...counts,
			openItems: items.open,
			closedItems: items.closed,
			roundGuidance: researchRoundGuidance()
		};
	}
	return null;
}
function dashboardSettings(config, extra = {}) {
	return {
		autonomyMode: config.autonomyMode || "guarded",
		checksPolicy: config.checksPolicy || "always",
		keepPolicy: config.keepPolicy || "primary-only",
		recipeId: config.recipeId || "",
		...extra
	};
}
async function dashboardViewModel(workDir, config, context = {}) {
	const qualityGap = await currentQualityGapSummary(workDir);
	const state = currentState(workDir);
	const warnings = context.suppressEnvironmentWarnings ? [] : await operatorWarningsForWorkDir(workDir);
	const settings = dashboardSettings(config, context);
	const drift = context.runtimeDrift || await buildDriftReport({
		pluginRoot: PLUGIN_ROOT,
		includeInstalled: Boolean(context.includeInstalledRuntime)
	}).catch((error) => ({
		ok: false,
		warnings: [error.message]
	}));
	const finalizePreview$1 = await finalizePreview({ cwd: workDir }).catch((error) => ({
		ok: false,
		ready: false,
		warnings: [error.message],
		nextAction: "Fix finalization preview errors before relying on review readiness."
	}));
	return buildDashboardViewModel({
		state,
		settings,
		commands: dashboardCommands(workDir, qualityGap),
		setupPlan: await setupPlan({ cwd: workDir }).catch((error) => ({
			ok: false,
			warnings: [error.message]
		})),
		guidedSetup: await guidedSetup({ cwd: workDir }).catch((error) => ({
			ok: false,
			warnings: [error.message]
		})),
		qualityGap,
		finalizePreview: context.suppressEnvironmentWarnings ? suppressEnvironmentWarningsFromPreview(finalizePreview$1) : finalizePreview$1,
		recipes: listBuiltInRecipes().map((recipe) => ({
			id: recipe.id,
			title: recipe.title,
			tags: recipe.tags || []
		})),
		experimentMemory: buildExperimentMemory({
			runs: state.current,
			direction: state.config.bestDirection,
			settings
		}),
		drift,
		warnings
	});
}
async function operatorWarningsForWorkDir(workDir) {
	const inGit = await insideGitRepo(workDir);
	const config = readConfig(workDir);
	const warnings = [];
	if (inGit && await isGitClean(workDir) === false) warnings.push({
		code: "git_dirty",
		severity: "warning",
		message: "Git worktree is dirty; review unrelated changes before logging a keep result.",
		action: "Inspect git status and configure commitPaths or revertPaths before trusting keep/discard automation."
	});
	const missingCommitPaths = [];
	for (const item of listOption(config.commitPaths || config.commit_paths)) if (!await pathExists(path.resolve(workDir, item))) missingCommitPaths.push(item);
	if (missingCommitPaths.length) warnings.push({
		code: "missing_commit_paths",
		severity: "warning",
		message: `Configured commitPaths do not exist: ${missingCommitPaths.slice(0, 5).join(", ")}.`,
		action: "Update commitPaths before relying on keep commits or use explicit --commit-paths for the next log."
	});
	return warnings;
}
function suppressEnvironmentWarningsFromPreview(preview) {
	if (!preview || typeof preview !== "object" || Array.isArray(preview)) return preview;
	const copy = { ...preview };
	const warnings = listOption(copy.warnings).filter((warning) => !/dirty|working tree/i.test(String(warning)));
	if (warnings.length > 0) copy.warnings = warnings;
	else delete copy.warnings;
	delete copy.suggestedCommand;
	delete copy.suggestedCommands;
	return copy;
}
async function configureSession(args) {
	const { sessionCwd, workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
	const updates = runtimeConfigUpdatesFromArgs(args);
	const maxIterations = positiveIntegerOption(args.max_iterations ?? args.maxIterations, null, "maxIterations");
	const extend = nonNegativeIntegerOption(args.extend ?? args.extendLimit, null, "extend");
	const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths, "commitPaths");
	if (maxIterations != null) updates.maxIterations = maxIterations;
	if (extend != null) {
		const activeRuns = currentState(workDir).current.length;
		const currentMax = Number.isFinite(Number(config.maxIterations)) ? Math.floor(Number(config.maxIterations)) : activeRuns;
		updates.maxIterations = Math.max(currentMax, activeRuns) + extend;
	}
	if (commitPaths.length > 0) updates.commitPaths = commitPaths;
	return {
		ok: true,
		workDir,
		sessionCwd,
		config: await writeRuntimeConfig(sessionCwd, updates),
		updates
	};
}
async function initExperiment(args) {
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
		bestDirection: direction
	};
	appendJsonl(workDir, entry);
	return {
		ok: true,
		workDir,
		message: `Initialized ${entry.name}: ${entry.metricName} (${entry.metricUnit || "unitless"}, ${entry.bestDirection} is better).`,
		config: entry
	};
}
async function runExperiment(args) {
	const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
	const state = currentState(workDir);
	const limit = iterationLimitInfo(state, config);
	if (limit.limitReached) throw new Error(`maxIterations reached (${limit.maxIterations}). Start a new segment with init/setup or raise maxIterations before running more experiments.`);
	const command = args.command || await defaultBenchmarkCommand(workDir);
	const benchmark = await runShell(command, workDir, numberOption(args.timeout_seconds ?? args.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS), { retainMetricNames: [state.config.metricName] });
	const benchmarkPassed = benchmark.exitCode === 0 && !benchmark.timedOut;
	const parsedMetricResult = parseMetricLines(metricParseSource(benchmark), {
		primaryMetricName: state.config.metricName,
		maxMetrics: MAX_PARSED_METRICS,
		withTruncation: true
	});
	const parsedMetrics = parsedMetricResult.metrics;
	const primary = parsedMetrics[state.config.metricName] ?? null;
	const primaryPresent = finiteMetric(primary) != null;
	const primaryMetric = finiteMetric(primary);
	const improvesPrimary = primaryMetric != null && (state.best == null || isBetter(primaryMetric, state.best, state.config.bestDirection));
	const isBaseline = state.current.filter(isBaselineEligibleMetricRun).length === 0;
	let checks = null;
	const checksCommand = args.checks_command || args.checksCommand || await defaultChecksCommand(workDir);
	const checksPolicy = checksPolicyFromArgs(args, config);
	if (shouldRunChecks(checksPolicy, {
		benchmarkPassed,
		primaryPresent,
		checksCommand,
		improvesPrimary,
		explicitChecksCommand: Boolean(args.checks_command || args.checksCommand)
	})) checks = await runShell(checksCommand, workDir, numberOption(args.checks_timeout_seconds ?? args.checksTimeoutSeconds, DEFAULT_CHECKS_TIMEOUT_SECONDS));
	const checksPassed = checks ? checks.exitCode === 0 && !checks.timedOut : null;
	const metricError = benchmarkPassed && !primaryPresent ? `Benchmark completed but did not print primary metric METRIC ${state.config.metricName}=<number>.` : null;
	const passed = benchmarkPassed && primaryPresent && (checksPassed === null || checksPassed);
	const failedStatus = benchmarkPassed && primaryPresent ? "checks_failed" : "crash";
	const allowedStatuses = passed ? ["keep", "discard"] : [failedStatus];
	const suggestedStatus = passed ? isBaseline || improvesPrimary ? "keep" : "discard" : failedStatus;
	const safeSuggestedStatus = passed ? suggestedStatus === "keep" && !isBaseline && !(checksPassed === true) ? "discard" : suggestedStatus : failedStatus;
	const statusGuidance = passed ? safeSuggestedStatus === "keep" ? "Safe to consider keep because this is a baseline or a checked improvement; still review ASI before logging." : "Default to discard unless the operator can justify keep with ASI and verification evidence." : `Only ${failedStatus} is allowed because the benchmark or checks failed.`;
	const progress = buildRunProgress({
		benchmark,
		checks,
		checksCommand,
		passed
	});
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
		outputTruncated: Boolean(benchmark.outputTruncated || benchmark.fullOutputTruncated || benchmark.metricOutputTruncated || checks?.outputTruncated || checks?.fullOutputTruncated || checks?.metricOutputTruncated),
		metricsTruncated: Boolean(parsedMetricResult.truncated || benchmark.metricOutputTruncated),
		metricName: state.config.metricName,
		metricUnit: state.config.metricUnit,
		progress,
		checks: checks ? {
			command: checksCommand,
			exitCode: checks.exitCode,
			timedOut: checks.timedOut,
			durationSeconds: checks.durationSeconds,
			passed: checksPassed,
			tailOutput: tailText(checks.output, 80, 16e3)
		} : null,
		tailOutput: tailText(benchmark.output),
		logHint: {
			metric: primary,
			metrics: Object.fromEntries(Object.entries(parsedMetrics).filter(([key]) => key !== state.config.metricName)),
			status: passed ? null : failedStatus,
			suggestedStatus,
			safeSuggestedStatus,
			statusGuidance,
			needsDecision: passed,
			allowedStatuses
		},
		limit
	};
}
function buildRunProgress({ benchmark, checks, checksCommand, passed }) {
	const stages = [progressStage("benchmark", "Run benchmark command", benchmark)];
	if (checksCommand) stages.push(checks ? progressStage("checks", "Run correctness checks", checks) : {
		stage: "checks",
		label: "Run correctness checks",
		status: "skipped",
		durationSeconds: 0,
		exitCode: null,
		timedOut: false,
		outputTail: ""
	});
	const timedOut = stages.some((stage) => stage.timedOut);
	return {
		mode: "synchronous",
		status: timedOut ? "timed_out" : passed ? "completed" : "failed",
		cancellable: false,
		cancelStatus: timedOut ? "timeout-killed" : "not_requested",
		elapsedSeconds: Number(stages.reduce((total, stage) => total + Number(stage.durationSeconds || 0), 0).toFixed(3)),
		stages,
		latestOutputTail: [...stages].reverse().find((stage) => stage.outputTail)?.outputTail || ""
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
		outputTail: tailText(result.output)
	};
}
function operationProgress({ stage, label, startedAt, status = "completed", outputTail = "" }) {
	const durationSeconds = Number(((Date.now() - startedAt) / 1e3).toFixed(3));
	return {
		mode: "synchronous",
		status,
		cancellable: false,
		cancelStatus: "not_requested",
		elapsedSeconds: durationSeconds,
		stages: [{
			stage,
			label,
			status,
			durationSeconds,
			exitCode: null,
			timedOut: false,
			outputTail
		}],
		latestOutputTail: outputTail
	};
}
async function logExperiment(args) {
	const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
	const lastPacket = boolOption(args.from_last ?? args.fromLast, false) ? await readLastRunPacket(workDir) : null;
	if (lastPacket) await assertFreshLastRunPacket(workDir, lastPacket);
	const packetAllowed = Array.isArray(lastPacket?.decision?.allowedStatuses) ? lastPacket.decision.allowedStatuses : [];
	const status = String(args.status || (packetAllowed.length === 1 ? lastPacket?.decision?.suggestedStatus : "") || "");
	if (!status) throw new Error("status is required; choose keep or discard explicitly for successful packets.");
	if (!STATUS_VALUES.has(status)) throw new Error(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
	if (lastPacket?.decision && Array.isArray(lastPacket.decision.allowedStatuses) && !lastPacket.decision.allowedStatuses.includes(status)) throw new Error(`Cannot log status '${status}' for the last run. Allowed statuses: ${lastPacket.decision.allowedStatuses.join(", ")}.`);
	const metric = numberOption(args.metric ?? lastPacket?.decision?.metric, null);
	if (!FAILURE_STATUSES.has(status) && metric == null) throw new Error("metric is required for keep and discard");
	if (status === "keep" && lastPacket?.run?.checks?.passed === false) throw new Error("Cannot keep the last run because correctness checks failed. Log it as checks_failed.");
	const description = args.description || lastPacket?.run?.description || "";
	if (!description) throw new Error("description is required");
	const metrics = args.metrics ?? lastPacket?.decision?.metrics ?? {};
	const asiFilePath = args.asi_file ?? args.asiFile;
	if (asiFilePath && args.asi != null) throw new Error("Use either --asi or --asi-file, not both.");
	const asi = await parseJsonFileOption(asiFilePath, workDir, "--asi-file") ?? args.asi ?? lastPacket?.decision?.asiTemplate ?? {};
	const stateBefore = currentState(workDir);
	const inGit = await insideGitRepo(workDir);
	const explicitCommit = args.commit != null && String(args.commit).trim() !== "";
	const allowAddAll = boolOption(args.allow_add_all ?? args.allowAddAll, false);
	if (explicitCommit && !inGit) throw new Error("--commit requires a Git repository so the commit can be verified.");
	let commit = "";
	if (explicitCommit) commit = (await resolveCommitRef(workDir, args.commit)).slice(0, 12);
	else if (inGit && status !== "keep") commit = await shortHead(workDir);
	let gitMessage = inGit ? "Git: no commit created." : "Git: not a repo.";
	let revertMessage = "";
	if (status === "keep" && inGit) if (explicitCommit) gitMessage = `Git: recorded existing commit ${commit}.`;
	else {
		const resultData = {
			status,
			[stateBefore.config.metricName || "metric"]: metric,
			...metrics
		};
		const commitPaths = normalizeRelativePaths(args.commit_paths ?? args.commitPaths ?? config.commitPaths, "commitPaths");
		if (shouldWarnEmptyCommitPaths({
			inGit,
			commitPaths,
			allowAddAll
		})) throw new Error(`${emptyCommitPathsWarning().message} Pass --allow-add-all only when every dirty file belongs in the kept commit.`);
		const addResult = commitPaths.length > 0 ? await git([
			"add",
			"--",
			...commitPaths
		], workDir) : await git(["add", "-A"], workDir);
		if (addResult.code !== 0) throw new Error(`Git add failed: ${gitOutput(addResult, "unknown error")}`);
		if (await hasStagedChanges(workDir)) {
			const commitResult = await git([
				"commit",
				"-m",
				description,
				"-m",
				`Result: ${JSON.stringify(resultData)}`
			], workDir);
			if (commitResult.code === 0) {
				commit = await shortHead(workDir);
				gitMessage = allowAddAll ? `Git: committed ${commit} using explicit add-all.` : `Git: committed ${commit}.`;
			} else throw new Error(`Git commit failed: ${gitOutput(commitResult, "unknown error")}`);
		} else gitMessage = "Git: nothing to commit.";
	}
	else if (status !== "keep") revertMessage = await cleanupDiscardChanges(workDir, args, config);
	const currentRuns = stateBefore.current;
	const experiment = {
		run: stateBefore.results.length + 1,
		commit: String(commit || "").slice(0, 12),
		metric,
		metrics,
		status,
		description,
		timestamp: Date.now(),
		segment: stateBefore.segment,
		confidence: null
	};
	if (asi && Object.keys(asi).length > 0) experiment.asi = asi;
	experiment.confidence = computeConfidence([...currentRuns, experiment], stateBefore.config.bestDirection);
	appendJsonl(workDir, experiment);
	if (lastPacket) await deleteLastRunPacket(workDir);
	const stateAfter = currentState(workDir);
	const limit = iterationLimitInfo(stateAfter, config);
	await appendSessionRunNote(workDir, experiment, stateAfter, {
		gitMessage,
		revertMessage
	});
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
		continuation: loopContinuation(workDir, stateAfter, config, "logged")
	};
}
async function clearSession(args) {
	const dryRun = boolOption(args.dry_run ?? args.dryRun, false);
	if (!dryRun && !boolOption(args.confirm ?? args.yes, false)) throw new Error("clear requires confirm=true for MCP or --yes for CLI");
	const { sessionCwd, workDir } = resolveWorkDir(args.working_dir || args.cwd);
	const targets = new Set([
		...SESSION_FILES.map((file) => path.join(workDir, file)),
		await resolveLastRunPath(workDir),
		path.join(workDir, RESEARCH_DIR),
		path.join(workDir, "autoresearch-dashboard.html"),
		path.join(sessionCwd, "autoresearch.config.json")
	]);
	const deleted = [];
	const wouldDelete = [];
	const missing = [];
	for (const filePath of [...targets].sort()) if (await pathExists(filePath)) if (dryRun) wouldDelete.push(filePath);
	else {
		await fsp.rm(filePath, {
			recursive: true,
			force: true
		});
		deleted.push(filePath);
	}
	else missing.push(filePath);
	return {
		ok: true,
		workDir,
		sessionCwd,
		dryRun,
		targets: [...targets].sort(),
		wouldDelete,
		deleted,
		missing
	};
}
function dashboardHtml(entries, meta = {}) {
	const dataForClient = meta.deliveryMode === "static-export" || meta.settings?.deliveryMode === "static-export" ? stripDashboardCommandFields(entries) : entries;
	const data = JSON.stringify(dataForClient).replace(/</g, "\\u003c");
	const metaForClient = stripDashboardCommandFields(meta);
	const publicExport = Boolean(meta.publicExport || meta.showcaseMode || meta.settings?.publicExport || meta.settings?.showcaseMode);
	const metaData = JSON.stringify(publicExport ? scrubDashboardPublicExport(metaForClient) : metaForClient).replace(/</g, "\\u003c");
	const template = fs.readFileSync(DASHBOARD_TEMPLATE_PATH, "utf8");
	if (!template.includes(DASHBOARD_DATA_PLACEHOLDER)) throw new Error(`Dashboard template is missing ${DASHBOARD_DATA_PLACEHOLDER}`);
	if (!template.includes(DASHBOARD_APP_PLACEHOLDER) || !template.includes(DASHBOARD_CSS_PLACEHOLDER)) throw new Error("Dashboard template is missing React build placeholders.");
	const dashboardApp = readDashboardBuildAsset("dashboard-app.js").replace(/<\/script/gi, "<\\/script");
	const dashboardCss = readDashboardBuildAsset("dashboard-app.css").replace(/<\/style/gi, "<\\/style");
	return template.replace(DASHBOARD_DATA_PLACEHOLDER, () => data).replace(DASHBOARD_META_PLACEHOLDER, () => metaData).replace(DASHBOARD_CSS_PLACEHOLDER, () => dashboardCss).replace(DASHBOARD_APP_PLACEHOLDER, () => dashboardApp);
}
function readDashboardBuildAsset(fileName) {
	const filePath = path.join(DASHBOARD_BUILD_DIR, fileName);
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") throw new Error(`Dashboard build asset is missing: ${filePath}. Run npm run build:dashboard from ${PLUGIN_ROOT}.`);
		throw error;
	}
}
function stripDashboardCommandFields(value) {
	const commandKeys = new Set([
		"argv",
		"baselineCommand",
		"benchmarkLintCommand",
		"cwd",
		"command",
		"commandLabel",
		"commands",
		"commandsByStatus",
		"display",
		"guideCommand",
		"guidedFlow",
		"liveDashboardCommand",
		"nextCommand",
		"output",
		"outputTail",
		"primaryCommand",
		"sessionCwd",
		"sourceCwd",
		"staticExport",
		"suggestedCommand",
		"suggestedCommands",
		"workDir"
	]);
	if (Array.isArray(value)) return value.map((item) => stripDashboardCommandFields(item));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => !commandKeys.has(key)).map(([key, item]) => [key, stripDashboardCommandFields(item)]));
}
function scrubDashboardPublicExport(value) {
	if (Array.isArray(value)) return value.map((item) => scrubDashboardPublicExport(item));
	if (typeof value === "string") return scrubDashboardPublicExportString(value);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDashboardPublicExport(item)]));
}
function scrubDashboardPublicExportString(value) {
	const placeholders = [
		[PLUGIN_ROOT, "<plugin-root>"],
		[REPO_ROOT, "<repo-root>"],
		[process.execPath, "node"]
	];
	let scrubbed = value;
	for (const [needle, replacement] of placeholders) {
		if (!needle) continue;
		scrubbed = scrubbed.replaceAll(String(needle), replacement);
		scrubbed = scrubbed.replaceAll(String(needle).replaceAll("\\", "/"), replacement);
	}
	return scrubbed.replace(/[A-Za-z]:\\[^\r\n"]+/g, "<local-path>").replace(/[A-Za-z]:\/[^\r\n" ]+/g, "<local-path>");
}
async function resolveLastRunPath(workDir) {
	if (await insideGitRepo(workDir)) return await gitPrivatePath(workDir, "autoresearch/last-run.json");
	return path.join(workDir, "autoresearch.last-run.json");
}
async function writeLastRunPacket(workDir, packet, filePath = null) {
	const target = filePath || await resolveLastRunPath(workDir);
	await fsp.mkdir(path.dirname(target), { recursive: true });
	await fsp.writeFile(target, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
	return target;
}
async function readLastRunPacket(workDir) {
	const filePath = await resolveLastRunPath(workDir);
	const legacyPath = path.join(workDir, "autoresearch.last-run.json");
	const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
	if (!fs.existsSync(readablePath)) throw new Error(`No last-run packet found for ${workDir}. Run next before using --from-last.`);
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
	if (!Number.isFinite(expectedNextRun)) return {
		fresh: false,
		reason: "Last-run packet is missing history metadata. Run next again before logging."
	};
	const state = currentState(workDir);
	const expectedWorkDir = packet.history?.workDir || packet.workDir;
	if (expectedWorkDir && path.resolve(expectedWorkDir) !== path.resolve(workDir)) return {
		fresh: false,
		expectedWorkDir,
		actualWorkDir: workDir,
		reason: "Last-run packet is stale: working directory changed since the packet was created. Run next again before logging."
	};
	const actualNextRun = state.results.length + 1;
	if (Number.isFinite(expectedSegment) && state.segment !== expectedSegment) return {
		fresh: false,
		expectedSegment,
		actualSegment: state.segment,
		reason: `Last-run packet is stale: expected segment #${expectedSegment}, but current segment is #${state.segment}. Run next again before logging.`
	};
	const expectedConfig = packet.history?.config;
	if (!expectedConfig || typeof expectedConfig !== "object") return {
		fresh: false,
		reason: "Last-run packet is missing config metadata. Run next again before logging."
	};
	const actualConfig = lastRunConfigSnapshot(state.config);
	if (JSON.stringify(expectedConfig) !== JSON.stringify(actualConfig)) return {
		fresh: false,
		expectedConfig,
		actualConfig,
		reason: "Last-run packet is stale: session config changed since the packet was created. Run next again before logging."
	};
	if (actualNextRun !== expectedNextRun) return {
		fresh: false,
		expectedNextRun,
		actualNextRun,
		reason: `Last-run packet is stale: expected next log run #${expectedNextRun}, but current history would log #${actualNextRun}. Run next again before logging.`
	};
	const expectedGit = packet.history?.git;
	if (expectedGit?.inside) {
		const actualGit = await lastRunGitSnapshot(workDir, { commitPaths: expectedGit.scopedPaths || [] });
		if (!actualGit.inside) return {
			fresh: false,
			expectedGit,
			actualGit,
			reason: "Last-run packet is stale: the working directory is no longer a Git worktree. Run next again before logging."
		};
		if (expectedGit.head && actualGit.head && expectedGit.head !== actualGit.head) return {
			fresh: false,
			expectedGit,
			actualGit,
			reason: `Last-run packet is stale: Git HEAD changed from ${expectedGit.head} to ${actualGit.head}. Run next again before logging.`
		};
		if (expectedGit.statusHash && actualGit.statusHash && expectedGit.statusHash !== actualGit.statusHash) return {
			fresh: false,
			expectedGit,
			actualGit,
			reason: "Last-run packet is stale: Git dirty state changed since the packet was created. Run next again before logging."
		};
		if (expectedGit.fileFingerprints?.length || actualGit.fileFingerprints?.length) {
			if (JSON.stringify(expectedGit.fileFingerprints || []) !== JSON.stringify(actualGit.fileFingerprints || [])) return {
				fresh: false,
				expectedGit,
				actualGit,
				reason: "Last-run packet is stale: scoped file fingerprints changed since the packet was created. Run next again before logging."
			};
		}
		if (expectedGit.dirtyFileFingerprints?.length || actualGit.dirtyFileFingerprints?.length) {
			if (JSON.stringify(expectedGit.dirtyFileFingerprints || []) !== JSON.stringify(actualGit.dirtyFileFingerprints || [])) return {
				fresh: false,
				expectedGit,
				actualGit,
				reason: "Last-run packet is stale: dirty file contents changed since the packet was created. Run next again before logging."
			};
		}
	}
	return {
		fresh: true,
		expectedNextRun,
		actualNextRun,
		expectedWorkDir: expectedWorkDir || workDir,
		command: packet.history?.command || packet.run?.command || "",
		git: packet.history?.git || null,
		reason: "Last-run packet matches the current ledger."
	};
}
function lastRunConfigSnapshot(config = {}) {
	return {
		name: config.name || null,
		metricName: config.metricName || "metric",
		metricUnit: config.metricUnit ?? "",
		bestDirection: config.bestDirection === "higher" ? "higher" : "lower"
	};
}
async function deleteLastRunPacket(workDir) {
	const filePath = await resolveLastRunPath(workDir);
	const legacyPath = path.join(workDir, "autoresearch.last-run.json");
	for (const target of new Set([filePath, legacyPath])) await fsp.rm(target, { force: true }).catch(() => {});
}
async function publicState(args) {
	const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
	const state = currentState(workDir);
	const warningDetails = await operatorWarningsForWorkDir(workDir);
	const memory = buildExperimentMemory({
		runs: state.current,
		direction: state.config.bestDirection,
		settings: dashboardSettings(config)
	});
	const statusCounts = Object.fromEntries([...STATUS_VALUES].map((status) => [status, state.current.filter((run) => run.status === status).length]));
	const fullState = {
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
			commitPaths: config.commitPaths || []
		},
		commands: dashboardCommands(workDir),
		warnings: warningDetails.map((warning) => warning.message),
		warningDetails,
		memory,
		continuation: loopContinuation(workDir, state, config, "state")
	};
	return boolOption(args.compact, false) ? compactPublicState(fullState) : fullState;
}
function compactPublicState(state) {
	const limit = state.limit || {};
	const continuation = state.continuation || {};
	const blockers = [...Array.isArray(state.warningDetails) ? state.warningDetails.map((warning) => warning.message || warning.code) : [], ...Array.isArray(state.warnings) ? state.warnings : []].filter(Boolean);
	return {
		ok: state.ok,
		workDir: state.workDir,
		name: state.config?.name || "Autoresearch",
		metric: state.config?.metricName || "metric",
		direction: state.config?.bestDirection || "lower",
		segment: state.segment,
		runs: state.runs,
		kept: state.kept,
		discarded: state.discarded,
		baseline: state.baseline,
		best: state.best,
		limitReached: Boolean(limit.limitReached),
		remainingIterations: limit.remainingIterations ?? null,
		nextAction: continuation.nextAction || "Run doctor, then next.",
		shouldContinue: continuation.shouldContinue === true,
		forbidFinalAnswer: continuation.forbidFinalAnswer === true,
		activeBudget: continuation.activeBudget === true,
		requiresLogDecision: continuation.requiresLogDecision === true,
		afterLogAction: continuation.afterLogAction || "",
		finalAnswerPolicy: continuation.finalAnswerPolicy || "",
		blockers: [...new Set(blockers)].slice(0, 6),
		report: {
			happened: `${state.runs} run${state.runs === 1 ? "" : "s"} in this segment; ${state.kept} kept, ${state.discarded} discarded, ${state.crashed} crashed, ${state.checksFailed} checks failed.`,
			decision: continuation.requiresLogDecision === true ? "A packet is waiting for a keep/discard/crash/checks_failed log decision." : state.best == null ? "No best metric yet." : `Best ${state.config?.metricName || "metric"} is ${state.best}.`,
			next: continuation.nextAction || "Run doctor, then next."
		},
		memory: {
			plateau: state.memory?.plateau?.detected === true,
			suggestedLane: state.memory?.summary?.suggestedLane || "",
			latestNextAction: state.memory?.latestNextAction || ""
		},
		commands: continuation.commands || state.commands || {}
	};
}
function dashboardCommands(workDir, qualityGap = null) {
	const cwd = shellQuote(workDir);
	const script = shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"));
	const researchSlug = qualityGap?.slug || currentQualityGapSlug(workDir) || "research";
	return [
		{
			label: "Serve dashboard",
			command: `node ${script} serve --cwd ${cwd}`
		},
		{
			label: "Onboarding packet",
			command: `node ${script} onboarding-packet --cwd ${cwd} --compact`
		},
		{
			label: "Recommend next",
			command: `node ${script} recommend-next --cwd ${cwd} --compact`
		},
		{
			label: "Setup plan",
			command: `node ${script} setup-plan --cwd ${cwd}`
		},
		{
			label: "Doctor",
			command: `node ${script} doctor --cwd ${cwd} --check-benchmark --check-installed`
		},
		{
			label: "Benchmark lint",
			command: `node ${script} benchmark-lint --cwd ${cwd}`
		},
		{
			label: "Benchmark inspect",
			command: `node ${script} benchmark-inspect --cwd ${cwd}`
		},
		{
			label: "Next run",
			command: `node ${script} next --cwd ${cwd} --compact`
		},
		{
			label: "Keep last",
			command: `node ${script} log --cwd ${cwd} --from-last --status keep --description "Describe the kept change"`
		},
		{
			label: "Discard last",
			command: `node ${script} log --cwd ${cwd} --from-last --status discard --description "Describe the discarded change"`
		},
		{
			label: "Gap candidates",
			command: `node ${script} gap-candidates --cwd ${cwd} --research-slug ${shellQuote(researchSlug)}`
		},
		{
			label: "Finalize preview",
			command: `node ${script} finalize-preview --cwd ${cwd}`
		},
		{
			label: "Export dashboard",
			command: `node ${script} export --cwd ${cwd}`
		},
		{
			label: "Extend limit",
			command: `node ${script} config --cwd ${cwd} --extend 10`
		},
		{
			label: "New segment",
			command: `node ${script} new-segment --cwd ${cwd} --dry-run`
		},
		{
			label: "Promote gate",
			command: `node ${script} promote-gate --cwd ${cwd} --reason "describe promoted measurement" --dry-run`
		}
	];
}
function loopContinuation(workDir, state, config = {}, stage = "state", options = {}) {
	const mode = config.autonomyMode || "guarded";
	const limit = iterationLimitInfo(state, config);
	const activeBudget = limit.maxIterations != null && Number(limit.remainingIterations) > 0 && mode !== "manual";
	const commands = continuationCommands(workDir);
	const memory = buildExperimentMemory({
		runs: state.current,
		direction: state.config.bestDirection,
		settings: dashboardSettings(config)
	});
	const topLane = memory.diversityGuidance || memory.lanePortfolio?.[0];
	const stopConditions = [
		"user interrupts or turns the loop off",
		"iteration limit is reached",
		"benchmark or correctness checks are blocked",
		"the task is genuinely exhausted"
	];
	if (options.stopReason) return {
		mode,
		stage,
		shouldContinue: false,
		shouldAskUser: false,
		stopReason: options.stopReason,
		nextAction: options.stopReason,
		commands,
		stopConditions
	};
	if (stage === "needs-log-decision") {
		const logThenContinue = options.requiredStatus ? `Log this packet as ${options.requiredStatus} with rollback ASI, then continue to the next hypothesis.` : "Log this packet as keep or discard with ASI, then continue to the next hypothesis.";
		return {
			mode,
			stage,
			activeBudget,
			shouldContinue: activeBudget,
			shouldAskUser: false,
			requiresLogDecision: true,
			forbidFinalAnswer: mode === "owner-autonomous" || activeBudget,
			finalAnswerPolicy: mode === "owner-autonomous" || activeBudget ? "Do not send a final answer after this packet; log it, read continuation, and keep the budget moving until a stop condition appears." : "Report the pending log decision if the user only asked for state.",
			logThenContinue: true,
			afterLogAction: "After the log command succeeds, immediately read the returned continuation and run the next packet when the user asked for an ongoing budget.",
			nextAction: logThenContinue,
			commands,
			stopConditions
		};
	}
	if (limit.limitReached) return {
		mode,
		stage,
		shouldContinue: false,
		shouldAskUser: false,
		stopReason: `maxIterations reached (${limit.maxIterations}).`,
		nextAction: "Export the dashboard and summarize the limit, or extend the session before more experiments.",
		commands,
		stopConditions
	};
	if (mode === "manual") return {
		mode,
		stage,
		shouldContinue: false,
		shouldAskUser: true,
		stopReason: "autonomy_mode is manual.",
		nextAction: "Return the current state and wait for the operator before the next experiment.",
		commands,
		stopConditions
	};
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
		finalAnswerPolicy: ownerAutonomous || activeBudget ? "Do not stop at a status report while iterations remain; continue running packets until the limit, blocker, exhaustion, or user interruption." : "A status report is acceptable when the user asked only to inspect state.",
		nextAction: ownerAutonomous ? memory.plateau?.detected ? `Keep the floor: run the ${topLane?.label || "distant scout"} lane next because the current search is plateauing.` : "Keep the floor: choose the next hypothesis from ASI/autoresearch.ideas.md, edit the scoped files, run next_experiment, and log the result without asking the user to invoke another subskill." : activeBudget ? memory.plateau?.detected ? `Keep going: run the ${topLane?.label || "distant scout"} lane next, log it, and continue because the active budget still has ${limit.remainingIterations} iteration${limit.remainingIterations === 1 ? "" : "s"} left.` : `Keep going: choose the next hypothesis, run next --compact, log the packet, and continue because the active budget still has ${limit.remainingIterations} iteration${limit.remainingIterations === 1 ? "" : "s"} left.` : "Continue the active loop when the current user request asks for iteration; otherwise report the state and next command.",
		commands,
		stopConditions
	};
}
function continuationCommands(workDir) {
	const cwd = shellQuote(workDir);
	const script = shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"));
	return {
		state: `node ${script} state --cwd ${cwd}`,
		next: `node ${script} next --cwd ${cwd} --compact`,
		nextFull: `node ${script} next --cwd ${cwd}`,
		keepLast: `node ${script} log --cwd ${cwd} --from-last --status keep --description "Describe the kept change"`,
		discardLast: `node ${script} log --cwd ${cwd} --from-last --status discard --description "Describe the discarded change"`,
		liveDashboard: `node ${script} serve --cwd ${cwd}`,
		exportDashboard: `node ${script} export --cwd ${cwd}`,
		extendLimit: `node ${script} config --cwd ${cwd} --extend 10`,
		onboardingPacket: `node ${script} onboarding-packet --cwd ${cwd} --compact`,
		recommendNext: `node ${script} recommend-next --cwd ${cwd} --compact`,
		benchmarkInspect: `node ${script} benchmark-inspect --cwd ${cwd}`,
		benchmarkLint: `node ${script} benchmark-lint --cwd ${cwd}`,
		checksInspect: `node ${script} checks-inspect --cwd ${cwd} --command "replace with exact checks command"`,
		newSegmentDryRun: `node ${script} new-segment --cwd ${cwd} --dry-run`,
		promoteGateDryRun: `node ${script} promote-gate --cwd ${cwd} --reason "describe promoted measurement" --dry-run`
	};
}
function currentQualityGapSlug(workDir) {
	const researchRoot = path.join(workDir, RESEARCH_DIR);
	try {
		for (const entry of fs.readdirSync(researchRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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
	const state = await publicState({
		...args,
		compact: false
	});
	const issues = [];
	const warnings = [];
	const warningDetails = [];
	const inGit = await insideGitRepo(workDir);
	const clean = await isGitClean(workDir);
	if (!state.config.metricName) issues.push("No primary metric is configured.");
	if (state.runs === 0) warnings.push("No runs are logged yet. Run a baseline before experimenting.");
	warnings.push(...state.memory?.warnings || []);
	if (inGit && clean === false) warnings.push("Git worktree is dirty; review unrelated changes before logging a keep result.");
	if (!inGit) warnings.push("Working directory is not a Git repository; keep commits and discard reverts are unavailable.");
	const drift = await buildDriftReport({
		pluginRoot: PLUGIN_ROOT,
		includeInstalled: boolOption(args.check_installed ?? args.checkInstalled, false)
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
		progress: null
	};
	if (boolOption(args.check_benchmark ?? args.checkBenchmark, false)) {
		benchmark.checked = true;
		benchmark.command = args.command || await defaultBenchmarkCommand(workDir);
		if (!benchmark.command) {
			benchmark.metricError = "No benchmark command was provided and no autoresearch script was found.";
			issues.push(benchmark.metricError);
		} else {
			const run = await runShell(benchmark.command, workDir, numberOption(args.timeout_seconds ?? args.timeoutSeconds, 60), { retainMetricNames: [state.config.metricName] });
			benchmark.exitCode = run.exitCode;
			benchmark.timedOut = run.timedOut;
			benchmark.parsedMetrics = parseMetricLines(metricParseSource(run));
			benchmark.emitsPrimary = finiteMetric(benchmark.parsedMetrics[state.config.metricName]) != null;
			benchmark.progress = buildRunProgress({
				benchmark: run,
				checks: null,
				checksCommand: null,
				passed: run.exitCode === 0 && !run.timedOut && benchmark.emitsPrimary
			});
			if (run.exitCode !== 0 || run.timedOut) issues.push(`Benchmark command failed during doctor check: exit ${run.exitCode ?? "none"}${run.timedOut ? " (timed out)" : ""}.`);
			else if (!benchmark.emitsPrimary) {
				benchmark.metricError = `Benchmark did not emit primary metric METRIC ${state.config.metricName}=<number>.`;
				issues.push(benchmark.metricError);
			}
			const driftWarning = benchmarkDriftWarning({
				currentMetric: benchmark.parsedMetrics[state.config.metricName],
				bestMetric: state.best,
				direction: state.config.bestDirection,
				metricName: state.config.metricName
			});
			if (driftWarning) warnings.push(driftWarning);
		}
	}
	let nextAction = "Run the next experiment, then log keep or discard with ASI.";
	if (issues.some((issue) => /primary metric|Benchmark/.test(issue))) nextAction = "Fix the benchmark command so it emits the configured primary metric before continuing.";
	else if (state.runs === 0) nextAction = "Run and log a baseline before trying optimizations.";
	else if (state.limit.limitReached) nextAction = "Iteration limit reached; export the dashboard or start a new segment.";
	else if (warnings.some((warning) => /dirty/.test(String(warning)))) nextAction = "Review the dirty Git state before logging a kept result.";
	const result = {
		ok: issues.length === 0,
		workDir,
		config: state.config,
		state,
		git: {
			inside: inGit,
			clean
		},
		benchmark,
		drift,
		issues,
		warnings,
		warningDetails,
		nextAction,
		continuation: loopContinuation(workDir, currentState(workDir), config, "doctor")
	};
	if (boolOption(args.explain, false)) result.explanation = doctorExplanation(result);
	return result;
}
function benchmarkDriftWarning({ currentMetric, bestMetric, direction, metricName }) {
	const current = finiteMetric(currentMetric);
	const best = finiteMetric(bestMetric);
	if (current == null || best == null || best === 0) return "";
	if (!(direction === "higher" ? current < best && Math.abs((best - current) / best) >= .25 : current > best && Math.abs((current - best) / best) >= .25)) return "";
	return `Benchmark drift: current ${metricName}=${current} is far worse than historical best ${best}. Treat the old best as historical evidence, not current runtime proof.`;
}
function doctorExplanation(result) {
	return {
		verdict: result.ok ? "Doctor found no blocking issues." : "Doctor found issues that must be fixed before trusting the loop.",
		priorityFixes: [...result.issues || [], ...(result.warnings || []).filter((warning) => /dirty|drift|benchmark|missing|stale|commitPaths/i.test(String(warning)))].slice(0, 5),
		nextSafeAction: result.nextAction,
		readAs: "Issues block the loop. Warnings reduce trust and should be resolved before keeping results when they affect evidence, Git, or runtime drift."
	};
}
async function doctorHooks(args = {}) {
	const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
	const platformSupported = process.platform !== "win32";
	return {
		ok: true,
		workDir,
		feature: "codex_hooks",
		defaultEnabled: false,
		supportedNow: platformSupported,
		platform: process.platform,
		verdict: platformSupported ? "Hooks can be explored as opt-in reminders, but should not be required for core Autoresearch behavior." : "Hooks are not a dependable default on this Windows environment; keep them as docs/templates only.",
		limitations: [
			"Codex hooks are experimental.",
			"Use them as reminders or context injection, not irreversible enforcement.",
			"Current hook behavior is best suited to shell/Bash-style tool observations, not complete MCP/write/web-search coverage.",
			"Autoresearch core behavior must remain correct without hooks."
		],
		templates: {
			sessionStart: "SessionStart: run `node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact` and surface the next safe action.",
			postToolUse: "PostToolUse: when shell output contains `METRIC name=value`, remind the agent to log the packet with ASI.",
			stop: "Stop: if `autoresearch.last-run.json` exists or continuation.forbidFinalAnswer is true, warn before a final answer."
		},
		docs: ["https://developers.openai.com/codex/hooks", "https://developers.openai.com/codex/concepts/customization#skills"]
	};
}
async function newSegment(args) {
	const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
	const state = currentState(workDir);
	const dryRun = boolOption(args.dry_run ?? args.dryRun, false);
	const confirmed = boolOption(args.confirm ?? args.yes, false);
	const reason = String(args.reason || "Start a fresh segment while preserving history.").trim();
	const entry = {
		type: "config",
		name: state.config.name || "Autoresearch",
		metricName: state.config.metricName || "metric",
		metricUnit: state.config.metricUnit ?? "",
		bestDirection: state.config.bestDirection === "higher" ? "higher" : "lower",
		segmentReason: reason,
		timestamp: (/* @__PURE__ */ new Date()).toISOString()
	};
	if (!dryRun && !confirmed) throw new Error("new-segment requires --dry-run or --yes because it appends to autoresearch.jsonl.");
	if (!dryRun) appendJsonl(workDir, entry);
	return {
		ok: true,
		workDir,
		dryRun,
		previousSegment: state.segment,
		nextSegment: state.segment + 1,
		entry,
		nextAction: dryRun ? "Review the segment entry, then rerun with --yes to append it." : "Run and log a fresh baseline or next packet for the new segment."
	};
}
async function promoteGate(args) {
	const { workDir } = resolveWorkDir(args.working_dir || args.cwd);
	const state = currentState(workDir);
	const dryRun = boolOption(args.dry_run ?? args.dryRun, false);
	const confirmed = boolOption(args.confirm ?? args.yes, false);
	const reason = String(args.reason || "").trim();
	if (!reason) throw new Error("promote-gate requires --reason <text>.");
	if (!dryRun && !confirmed) throw new Error("promote-gate requires --dry-run or --yes because it appends a new measurement segment.");
	const queryCount = positiveIntegerOption(args.query_count ?? args.queryCount, null, "queryCount");
	const entry = {
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
			notes: listOption(args.notes)
		},
		timestamp: (/* @__PURE__ */ new Date()).toISOString()
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
			next: `node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)} --compact`
		},
		nextAction: dryRun ? "Review the promoted measurement gate, then rerun with --yes to append the new segment." : "Run a fresh compact packet under the promoted measurement gate and log the decision with ASI."
	};
}
async function nextExperiment(args) {
	const { workDir, config } = resolveWorkDir(args.working_dir || args.cwd);
	const doctor = await doctorSession({
		...args,
		check_benchmark: false,
		checkBenchmark: false
	});
	if (!doctor.ok) return {
		ok: false,
		workDir: doctor.workDir,
		doctor,
		run: null,
		decision: null,
		nextAction: doctor.nextAction,
		continuation: loopContinuation(doctor.workDir, currentState(doctor.workDir), config, "blocked", { stopReason: doctor.nextAction })
	};
	const run = await runExperiment(args);
	const stateBeforeLog = currentState(run.workDir);
	const memory = buildExperimentMemory({
		runs: stateBeforeLog.current,
		direction: stateBeforeLog.config.bestDirection,
		settings: dashboardSettings(config)
	});
	const decision = {
		metric: run.parsedPrimary,
		metrics: run.logHint.metrics,
		allowedStatuses: run.logHint.allowedStatuses,
		suggestedStatus: run.logHint.safeSuggestedStatus ?? run.logHint.suggestedStatus ?? run.logHint.status,
		rawSuggestedStatus: run.logHint.suggestedStatus ?? run.logHint.status,
		safeSuggestedStatus: run.logHint.safeSuggestedStatus ?? run.logHint.suggestedStatus ?? run.logHint.status,
		statusGuidance: run.logHint.statusGuidance || "",
		diversityGuidance: memory.diversityGuidance,
		lanePortfolio: memory.lanePortfolio,
		plateau: memory.plateau,
		novelty: memory.novelty,
		needsDecision: run.logHint.needsDecision,
		asiTemplate: run.ok ? {
			hypothesis: "",
			evidence: `${run.metricName}=${run.parsedPrimary}${run.metricUnit || ""}`,
			lane: memory.diversityGuidance?.id || "",
			family: "",
			next_action_hint: ""
		} : {
			evidence: run.metricError || `Benchmark exit ${run.exitCode ?? "none"}`,
			rollback_reason: "",
			lane: memory.diversityGuidance?.id || "",
			family: "",
			next_action_hint: ""
		}
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
				error: error.message || String(error)
			}))
		},
		doctor,
		run,
		decision,
		nextAction: run.ok ? `Log this run as ${decision.safeSuggestedStatus || "keep/discard"} unless review evidence says otherwise, include ASI, then continue with the next ${memory.diversityGuidance?.label || "diversity"} lane.` : `Log this run as ${run.logHint.status} with rollback ASI before trying another change.`,
		continuation: loopContinuation(workDir, currentState(workDir), config, "needs-log-decision", { requiredStatus: run.logHint.status })
	};
	await writeLastRunPacket(run.workDir, packet, lastRunFile);
	return boolOption(args.compact, false) ? compactNextExperimentPacket(packet) : packet;
}
function compactNextExperimentPacket(packet) {
	const run = packet.run || {};
	const decision = packet.decision || {};
	const continuation = packet.continuation || {};
	const metricName = run.metricName || packet.history?.config?.metricName || "metric";
	const metricUnit = run.metricUnit || packet.history?.config?.metricUnit || "";
	const metricText = decision.metric == null ? "no primary metric" : `${metricName}=${decision.metric}${metricUnit}`;
	const suggested = decision.safeSuggestedStatus || decision.suggestedStatus || "review";
	return {
		ok: packet.ok,
		workDir: packet.workDir,
		lastRunPath: packet.lastRunPath,
		history: {
			segment: packet.history?.segment,
			currentRuns: packet.history?.currentRuns,
			totalRuns: packet.history?.totalRuns,
			nextRun: packet.history?.nextRun
		},
		run: {
			ok: run.ok,
			command: run.command,
			metricName,
			parsedPrimary: run.parsedPrimary,
			parsedMetrics: run.parsedMetrics,
			checks: run.checks ? {
				ok: run.checks.ok,
				policy: run.checks.policy,
				exitCode: run.checks.exitCode,
				timedOut: run.checks.timedOut
			} : null,
			progress: run.progress ? {
				mode: run.progress.mode,
				status: run.progress.status,
				durationMs: run.progress.durationMs
			} : null,
			outputTruncated: run.outputTruncated === true,
			metricsTruncated: run.metricsTruncated === true
		},
		decision: {
			metric: decision.metric,
			metrics: decision.metrics,
			allowedStatuses: decision.allowedStatuses || [],
			suggestedStatus: suggested,
			statusGuidance: decision.statusGuidance || "",
			asiTemplate: decision.asiTemplate || {},
			diversityGuidance: decision.diversityGuidance || null,
			plateau: decision.plateau || null
		},
		report: {
			tried: `Ran packet #${packet.history?.nextRun || "?"} with ${metricText}.`,
			means: decision.statusGuidance || (run.ok ? "Benchmark produced a decision packet." : "Benchmark did not complete cleanly."),
			decision: `Log as ${suggested} unless review evidence changes the call.`,
			next: continuation.nextAction || packet.nextAction || "Log the packet, then read continuation."
		},
		nextAction: packet.nextAction,
		continuation,
		fullPacket: "The complete doctor/run output is preserved in lastRunPath for audit and log --from-last."
	};
}
const { callTool, toolSchemas, validateToolArguments } = createMcpInterface({
	boolOption,
	benchmarkInspect,
	benchmarkLint,
	checksInspect,
	clearSession,
	configureSession,
	doctorHooks,
	doctorSession,
	exportDashboard,
	finalizePreview,
	gapCandidates,
	guidedSetup,
	initExperiment,
	integrationsCommand,
	logExperiment,
	measureQualityGap,
	newSegment,
	nextExperiment,
	onboardingPacket,
	parseJsonOption,
	parseJsonFileOption,
	promoteGate,
	promptPlan,
	publicState,
	recommendNext,
	recipeCommand,
	runExperiment,
	serveDashboard,
	setupPlan,
	setupResearchSession,
	setupSession
});
function startMcpServer() {
	let buffer = Buffer.alloc(0);
	process.stdin.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		if (buffer.length > MAX_MCP_FRAME_BYTES + 1024 && buffer.indexOf("\r\n\r\n") < 0) {
			buffer = Buffer.alloc(0);
			sendMcp({
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32e3,
					message: "Request too large."
				}
			});
			return;
		}
		for (;;) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const match = buffer.subarray(0, headerEnd).toString("utf8").match(/Content-Length:\s*(\d+)/i);
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
						code: -32e3,
						message: `Request too large. Max frame size is ${MAX_MCP_FRAME_BYTES} bytes.`
					}
				});
				buffer = buffer.length >= bodyStart + Math.max(0, length) ? buffer.subarray(bodyStart + Math.max(0, length)) : Buffer.alloc(0);
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
					error: {
						code: -32700,
						message: `Parse error: ${error.message}`
					}
				});
				continue;
			}
			handleMcpMessage(message).catch((error) => {
				sendMcp({
					jsonrpc: "2.0",
					id: null,
					error: {
						code: -32e3,
						message: error.message
					}
				});
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
				serverInfo: {
					name: "codex-autoresearch",
					version: "1.1.10"
				}
			}
		});
		return;
	}
	if (message.method === "notifications/initialized") return;
	if (message.method === "tools/list") {
		sendMcp({
			jsonrpc: "2.0",
			id: message.id,
			result: { tools: toolSchemas }
		});
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
					structuredContent: payload,
					content: [{
						type: "text",
						text: JSON.stringify(payload, null, 2)
					}]
				}
			});
		} catch (error) {
			const payload = mcpErrorEnvelope(message.params?.name, error);
			sendMcp({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					isError: true,
					structuredContent: payload,
					content: [{
						type: "text",
						text: JSON.stringify(payload, null, 2)
					}]
				}
			});
		}
		return;
	}
	if (message.id != null) sendMcp({
		jsonrpc: "2.0",
		id: message.id,
		error: {
			code: -32601,
			message: `Unknown method: ${message.method}`
		}
	});
}
function mcpSuccessEnvelope(tool, result) {
	const body = result && typeof result === "object" && !Array.isArray(result) ? result : { value: result };
	return {
		...body,
		ok: body.ok !== false,
		tool,
		workDir: body.workDir || body.working_dir,
		result: body
	};
}
function mcpErrorEnvelope(tool, error) {
	return {
		ok: false,
		tool: tool || "unknown",
		error: error.message || String(error)
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
		const match = remaining.subarray(0, headerEnd).toString("utf8").match(/Content-Length:\s*(\d+)/i);
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
			messages.push({
				jsonrpc: "2.0",
				error: {
					code: -32700,
					message: error.message
				}
			});
		}
	}
}
function waitForMcpResponse(messages, id, timeoutMs) {
	const started = Date.now();
	return new Promise((resolve) => {
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
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		]
	});
	child.stdout.on("data", (chunk) => {
		buffer = collectMcpFrames(Buffer.concat([buffer, chunk]), messages);
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	child.stdin.write(mcpFrame({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: {
				name: "codex-autoresearch-smoke",
				version: "0"
			}
		}
	}));
	child.stdin.write(mcpFrame({
		jsonrpc: "2.0",
		method: "notifications/initialized",
		params: {}
	}));
	child.stdin.write(mcpFrame({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/list",
		params: {}
	}));
	const initialize = await waitForMcpResponse(messages, 1, 1500);
	const toolsList = await waitForMcpResponse(messages, 2, 1500);
	child.kill();
	const tools = toolsList?.result?.tools || [];
	const toolNames = tools.map((tool) => tool.name).filter(Boolean);
	const missingRequiredTools = [
		"setup_plan",
		"setup_session",
		"next_experiment",
		"prompt_plan",
		"onboarding_packet",
		"recommend_next",
		"read_state",
		"benchmark_inspect",
		"benchmark_lint",
		"checks_inspect",
		"new_segment",
		"promote_gate",
		"doctor_session",
		"serve_dashboard",
		"clear_session"
	].filter((tool) => !toolNames.includes(tool));
	return {
		ok: Boolean(initialize?.result?.serverInfo?.name === "codex-autoresearch" && tools.length > 0 && missingRequiredTools.length === 0),
		pluginRoot: PLUGIN_ROOT,
		command: `${process.execPath} ${MCP_SCRIPT_PATH}`,
		initialize: initialize?.result || initialize?.error || null,
		toolCount: tools.length,
		toolNames,
		missingRequiredTools,
		stderr: stderr.trim(),
		note: "This validates the plugin stdio server directly. If this is ok but Codex does not show MCP tools, the failure is in Codex tool surfacing or session registration, not this server process."
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
	const outcome = await runCliCommand(command, args, createCliCommandHandlers({
		benchmarkInspect,
		benchmarkLint,
		checksInspect,
		buildDriftReport,
		buildDashboardViewModel,
		clearSession,
		configureSession,
		dashboardCommands,
		dashboardHtml,
		dashboardSettings,
		dashboardViewModel,
		doctorHooks,
		doctorSession,
		exportDashboard,
		finalizePreview,
		gapCandidates,
		guidedSetup,
		initExperiment,
		integrationsCommand,
		interactiveSetup,
		logExperiment,
		measureQualityGap,
		newSegment,
		nextExperiment,
		onboardingPacket,
		parseJsonOption,
		pluginRoot: PLUGIN_ROOT,
		pluginVersion: PLUGIN_VERSION,
		promoteGate,
		promptPlan,
		publicState,
		recommendNext,
		readJsonl,
		recipeCommand,
		resolveWorkDir,
		runExperiment,
		serveAutoresearch,
		setupPlan,
		setupResearchSession,
		setupSession
	}));
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
//#endregion
export {};
