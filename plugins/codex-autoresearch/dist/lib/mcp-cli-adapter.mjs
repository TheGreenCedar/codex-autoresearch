import { actionPolicyForTool, actionPolicyMutates, unsafeCommandFieldsForArgs } from "./tool-registry.mjs";
import { runProcess } from "./runner.mjs";
import path from "node:path";
import { spawn } from "node:child_process";
//#region lib/mcp-cli-adapter.ts
const DEFAULT_TOOL_TIMEOUT_SECONDS = 900;
const MCP_CLI_OUTPUT_CAPTURE_BYTES = 900 * 1024;
function createCliToolCaller({ cliScript, pluginRoot, toolTimeoutSeconds = DEFAULT_TOOL_TIMEOUT_SECONDS }) {
	const liveDashboardProcesses = /* @__PURE__ */ new Map();
	const runCliInvocation = async (invocation) => {
		const result = await runProcess(invocation.command, invocation.args, {
			cwd: invocation.cwd,
			timeoutSeconds: invocation.timeoutSeconds,
			maxOutputBytes: MCP_CLI_OUTPUT_CAPTURE_BYTES
		});
		return {
			code: result.exitCode,
			stdout: result.stdout,
			stderr: result.timedOut ? `${result.stderr || ""}${result.stderr ? "\n" : ""}Timed out after ${toolTimeoutSeconds} seconds.` : result.stderr,
			timedOut: result.timedOut
		};
	};
	const waitForServePayload = async (child, stdoutFn, stderrFn) => {
		const started = Date.now();
		while (Date.now() - started < 5e3) {
			const stdout = stdoutFn().trim();
			if (stdout.endsWith("}")) try {
				return JSON.parse(stdout);
			} catch {}
			if (child.exitCode != null) throw new Error(`autoresearch live dashboard exited (${child.exitCode})\n${stderrFn() || stdoutFn()}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		child.kill();
		throw new Error(`autoresearch live dashboard did not start\n${stderrFn() || stdoutFn()}`);
	};
	const startLiveDashboard = async (args) => {
		const workDir = path.resolve(args.working_dir ?? args.workingDir ?? args.cwd);
		const port = args.port == null || args.port === "" ? null : Number(args.port);
		const key = `${workDir}:${port ?? "auto"}`;
		const existing = liveDashboardProcesses.get(key);
		if (existing && !existing.child.killed) return existing.payload;
		const cliArgs = [
			"serve",
			"--cwd",
			workDir
		];
		if (port != null) cliArgs.push("--port", String(port));
		const child = spawn(process.execPath, [cliScript, ...cliArgs], {
			cwd: pluginRoot,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", () => {
			liveDashboardProcesses.delete(key);
		});
		child.on("error", () => {
			liveDashboardProcesses.delete(key);
		});
		const payload = await waitForServePayload(child, () => stdout, () => stderr);
		liveDashboardProcesses.set(key, {
			child,
			payload
		});
		return payload;
	};
	return async function callCliTool(name, args) {
		if (name === "serve_dashboard") return await startLiveDashboard(args);
		const result = await runCliInvocation(buildCliInvocationForTool(name, args, {
			cliScript,
			cwd: pluginRoot,
			timeoutSeconds: toolTimeoutSeconds
		}));
		if (result.code !== 0) throw new Error(`autoresearch CLI failed (${result.code})\n${result.stderr || result.stdout}`);
		try {
			return JSON.parse(result.stdout);
		} catch {
			return {
				ok: true,
				output: result.stdout.trim()
			};
		}
	};
}
function buildCliInvocationForTool(name, args, options = {}) {
	const cliArgs = cliArgsForTool(name, args);
	const cliScript = options.cliScript || null;
	const actionPolicy = actionPolicyForTool(name, args);
	return {
		command: process.execPath,
		args: cliScript ? [cliScript, ...cliArgs] : cliArgs,
		cwd: options.cwd || options.pluginRoot || process.cwd(),
		mutates: actionPolicyMutates(actionPolicy),
		actionPolicy,
		unsafeFields: unsafeCommandFieldsForArgs(args),
		timeoutSeconds: options.timeoutSeconds || DEFAULT_TOOL_TIMEOUT_SECONDS
	};
}
function cliArgsForTool(name, args) {
	if (name === "setup_plan") return compactArgs([
		"setup-plan",
		cwdFlag(args),
		option("--recipe", args.recipe_id ?? args.recipeId ?? args.recipe),
		option("--catalog", args.catalog),
		option("--name", args.name),
		option("--goal", args.goal),
		option("--metric-name", args.metric_name ?? args.metricName),
		option("--metric-unit", args.metric_unit ?? args.metricUnit),
		option("--direction", args.direction),
		option("--benchmark-command", args.benchmark_command ?? args.benchmarkCommand),
		option("--benchmark-prints-metric", args.benchmark_prints_metric ?? args.benchmarkPrintsMetric),
		option("--checks-command", args.checks_command ?? args.checksCommand),
		listOption("--files-in-scope", args.files_in_scope ?? args.filesInScope),
		listOption("--off-limits", args.off_limits ?? args.offLimits),
		listOption("--constraints", args.constraints),
		listOption("--secondary-metrics", args.secondary_metrics ?? args.secondaryMetrics),
		listOption("--commit-paths", args.commit_paths ?? args.commitPaths),
		option("--max-iterations", args.max_iterations ?? args.maxIterations)
	]);
	if (name === "guided_setup") return compactArgs([
		"guide",
		cwdFlag(args),
		option("--recipe", args.recipe_id ?? args.recipeId ?? args.recipe),
		option("--catalog", args.catalog),
		option("--name", args.name),
		option("--goal", args.goal),
		option("--metric-name", args.metric_name ?? args.metricName),
		option("--metric-unit", args.metric_unit ?? args.metricUnit),
		option("--direction", args.direction),
		option("--benchmark-command", args.benchmark_command ?? args.benchmarkCommand),
		option("--benchmark-prints-metric", args.benchmark_prints_metric ?? args.benchmarkPrintsMetric),
		option("--checks-command", args.checks_command ?? args.checksCommand),
		listOption("--files-in-scope", args.files_in_scope ?? args.filesInScope),
		listOption("--off-limits", args.off_limits ?? args.offLimits),
		listOption("--constraints", args.constraints),
		listOption("--secondary-metrics", args.secondary_metrics ?? args.secondaryMetrics),
		listOption("--commit-paths", args.commit_paths ?? args.commitPaths),
		option("--max-iterations", args.max_iterations ?? args.maxIterations)
	]);
	if (name === "prompt_plan") return compactArgs([
		"prompt-plan",
		cwdFlag(args),
		option("--prompt", args.prompt),
		option("--name", args.name),
		option("--goal", args.goal),
		option("--metric-name", args.metric_name ?? args.metricName),
		option("--metric-unit", args.metric_unit ?? args.metricUnit),
		option("--direction", args.direction),
		option("--benchmark-command", args.benchmark_command ?? args.benchmarkCommand),
		option("--benchmark-prints-metric", args.benchmark_prints_metric ?? args.benchmarkPrintsMetric),
		option("--checks-command", args.checks_command ?? args.checksCommand),
		listOption("--files-in-scope", args.files_in_scope ?? args.filesInScope),
		listOption("--off-limits", args.off_limits ?? args.offLimits),
		listOption("--constraints", args.constraints),
		listOption("--secondary-metrics", args.secondary_metrics ?? args.secondaryMetrics),
		listOption("--commit-paths", args.commit_paths ?? args.commitPaths),
		option("--max-iterations", args.max_iterations ?? args.maxIterations)
	]);
	if (name === "onboarding_packet") return compactArgs([
		"onboarding-packet",
		cwdFlag(args),
		flag("--compact", args.compact)
	]);
	if (name === "recommend_next") return compactArgs([
		"recommend-next",
		cwdFlag(args),
		flag("--compact", args.compact)
	]);
	if (name === "list_recipes") return compactArgs([
		"recipes",
		args.recommend ? "recommend" : "list",
		cwdFlag(args),
		option("--catalog", args.catalog)
	]);
	if (name === "setup_session") return compactArgs([
		"setup",
		cwdFlag(args),
		option("--recipe", args.recipe_id ?? args.recipeId ?? args.recipe),
		option("--catalog", args.catalog),
		option("--name", args.name),
		option("--goal", args.goal),
		option("--metric-name", args.metric_name ?? args.metricName),
		option("--metric-unit", args.metric_unit ?? args.metricUnit),
		option("--direction", args.direction),
		option("--benchmark-command", args.benchmark_command ?? args.benchmarkCommand),
		option("--benchmark-prints-metric", args.benchmark_prints_metric ?? args.benchmarkPrintsMetric),
		option("--checks-command", args.checks_command ?? args.checksCommand),
		option("--shell", args.shell),
		listOption("--files-in-scope", args.files_in_scope ?? args.filesInScope),
		listOption("--off-limits", args.off_limits ?? args.offLimits),
		listOption("--constraints", args.constraints),
		listOption("--secondary-metrics", args.secondary_metrics ?? args.secondaryMetrics),
		listOption("--commit-paths", args.commit_paths ?? args.commitPaths),
		option("--max-iterations", args.max_iterations ?? args.maxIterations),
		option("--autonomy-mode", args.autonomy_mode ?? args.autonomyMode),
		option("--checks-policy", args.checks_policy ?? args.checksPolicy),
		option("--keep-policy", args.keep_policy ?? args.keepPolicy),
		option("--dashboard-refresh-seconds", args.dashboard_refresh_seconds ?? args.dashboardRefreshSeconds),
		flag("--overwrite", args.overwrite),
		flag("--create-checks", args.create_checks ?? args.createChecks),
		flag("--skip-init", args.skip_init ?? args.skipInit)
	]);
	if (name === "setup_research_session") return compactArgs([
		"research-setup",
		cwdFlag(args),
		option("--slug", args.slug),
		option("--goal", args.goal),
		option("--name", args.name),
		option("--checks-command", args.checks_command ?? args.checksCommand),
		option("--shell", args.shell),
		listOption("--files-in-scope", args.files_in_scope ?? args.filesInScope),
		listOption("--constraints", args.constraints),
		listOption("--commit-paths", args.commit_paths ?? args.commitPaths),
		option("--max-iterations", args.max_iterations ?? args.maxIterations),
		option("--autonomy-mode", args.autonomy_mode ?? args.autonomyMode),
		option("--checks-policy", args.checks_policy ?? args.checksPolicy),
		option("--keep-policy", args.keep_policy ?? args.keepPolicy),
		option("--dashboard-refresh-seconds", args.dashboard_refresh_seconds ?? args.dashboardRefreshSeconds),
		flag("--overwrite", args.overwrite),
		flag("--create-checks", args.create_checks ?? args.createChecks),
		flag("--skip-init", args.skip_init ?? args.skipInit)
	]);
	if (name === "configure_session") return compactArgs([
		"config",
		cwdFlag(args),
		option("--autonomy-mode", args.autonomy_mode ?? args.autonomyMode),
		option("--checks-policy", args.checks_policy ?? args.checksPolicy),
		option("--keep-policy", args.keep_policy ?? args.keepPolicy),
		option("--dashboard-refresh-seconds", args.dashboard_refresh_seconds ?? args.dashboardRefreshSeconds),
		option("--max-iterations", args.max_iterations ?? args.maxIterations),
		option("--extend", args.extend),
		listOption("--commit-paths", args.commit_paths ?? args.commitPaths)
	]);
	if (name === "init_experiment") return compactArgs([
		"init",
		cwdFlag(args),
		option("--name", args.name),
		option("--metric-name", args.metric_name ?? args.metricName),
		option("--metric-unit", args.metric_unit ?? args.metricUnit),
		option("--direction", args.direction)
	]);
	if (name === "run_experiment") return compactArgs([
		"run",
		cwdFlag(args),
		option("--command", args.command),
		option("--timeout-seconds", args.timeout_seconds ?? args.timeoutSeconds),
		option("--checks-command", args.checks_command ?? args.checksCommand),
		option("--checks-timeout-seconds", args.checks_timeout_seconds ?? args.checksTimeoutSeconds),
		option("--checks-policy", args.checks_policy ?? args.checksPolicy)
	]);
	if (name === "next_experiment") return compactArgs([
		"next",
		cwdFlag(args),
		option("--command", args.command),
		option("--timeout-seconds", args.timeout_seconds ?? args.timeoutSeconds),
		option("--checks-command", args.checks_command ?? args.checksCommand),
		option("--checks-timeout-seconds", args.checks_timeout_seconds ?? args.checksTimeoutSeconds),
		option("--checks-policy", args.checks_policy ?? args.checksPolicy),
		flag("--compact", args.compact)
	]);
	if (name === "log_experiment") return compactArgs([
		"log",
		cwdFlag(args),
		option("--commit", args.commit),
		option("--metric", args.metric),
		option("--status", args.status),
		option("--description", args.description),
		option("--metrics", jsonOption(args.metrics)),
		option("--asi", jsonOption(args.asi)),
		listOption("--commit-paths", args.commit_paths ?? args.commitPaths),
		listOption("--revert-paths", args.revert_paths ?? args.revertPaths),
		flag("--allow-add-all", args.allow_add_all ?? args.allowAddAll),
		flag("--allow-dirty-revert", args.allow_dirty_revert ?? args.allowDirtyRevert),
		flag("--from-last", args.from_last ?? args.fromLast)
	]);
	if (name === "read_state") return compactArgs([
		"state",
		cwdFlag(args),
		flag("--compact", args.compact)
	]);
	if (name === "measure_quality_gap") return compactArgs([
		"quality-gap",
		cwdFlag(args),
		option("--research-slug", args.research_slug ?? args.researchSlug),
		"--list"
	]);
	if (name === "gap_candidates") return compactArgs([
		"gap-candidates",
		cwdFlag(args),
		option("--research-slug", args.research_slug ?? args.researchSlug),
		flag("--apply", args.apply),
		option("--model-command", args.model_command ?? args.modelCommand),
		option("--model-timeout-seconds", args.model_timeout_seconds ?? args.modelTimeoutSeconds)
	]);
	if (name === "finalize_preview") return compactArgs([
		"finalize-preview",
		cwdFlag(args),
		option("--trunk", args.trunk)
	]);
	if (name === "integrations") return compactArgs([
		"integrations",
		args.subcommand || "list",
		option("--catalog", args.catalog)
	]);
	if (name === "benchmark_lint") return compactArgs([
		"benchmark-lint",
		cwdFlag(args),
		option("--metric-name", args.metric_name ?? args.metricName),
		option("--sample", args.sample),
		option("--command", args.command),
		option("--timeout-seconds", args.timeout_seconds ?? args.timeoutSeconds)
	]);
	if (name === "benchmark_inspect") return compactArgs([
		"benchmark-inspect",
		cwdFlag(args),
		option("--command", args.command),
		option("--timeout-seconds", args.timeout_seconds ?? args.timeoutSeconds)
	]);
	if (name === "checks_inspect") return compactArgs([
		"checks-inspect",
		cwdFlag(args),
		option("--command", args.command ?? args.checks_command ?? args.checksCommand),
		option("--timeout-seconds", args.timeout_seconds ?? args.timeoutSeconds)
	]);
	if (name === "new_segment") return compactArgs([
		"new-segment",
		cwdFlag(args),
		option("--reason", args.reason),
		flag("--dry-run", args.dry_run ?? args.dryRun),
		flag("--yes", args.confirm ?? args.yes)
	]);
	if (name === "promote_gate") return compactArgs([
		"promote-gate",
		cwdFlag(args),
		option("--reason", args.reason),
		option("--gate-name", args.gate_name ?? args.gateName),
		option("--query-count", args.query_count ?? args.queryCount),
		option("--benchmark-command", args.benchmark_command ?? args.benchmarkCommand),
		option("--checks-command", args.checks_command ?? args.checksCommand),
		listOption("--notes", args.notes),
		flag("--dry-run", args.dry_run ?? args.dryRun),
		flag("--yes", args.confirm ?? args.yes)
	]);
	if (name === "export_dashboard") return compactArgs([
		"export",
		cwdFlag(args),
		option("--output", args.output),
		flag("--json-full", args.json_full ?? args.jsonFull ?? args.full)
	]);
	if (name === "serve_dashboard") return compactArgs([
		"serve",
		cwdFlag(args),
		option("--port", args.port)
	]);
	if (name === "doctor_session") return compactArgs([
		"doctor",
		cwdFlag(args),
		option("--command", args.command),
		flag("--check-benchmark", args.check_benchmark ?? args.checkBenchmark),
		flag("--check-installed", args.check_installed ?? args.checkInstalled),
		option("--timeout-seconds", args.timeout_seconds ?? args.timeoutSeconds),
		flag("--explain", args.explain),
		flag("--hooks", args.hooks)
	]);
	if (name === "clear_session") return compactArgs([
		"clear",
		cwdFlag(args),
		flag("--dry-run", args.dry_run ?? args.dryRun),
		flag("--yes", args.confirm ?? args.yes)
	]);
	throw new Error(`Unknown tool: ${name}`);
}
function cwdFlag(args) {
	return option("--cwd", args.working_dir ?? args.workingDir ?? args.cwd);
}
function option(name, value) {
	if (value == null || value === "") return [];
	return [name, String(value)];
}
function listOption(name, value) {
	if (value == null || value === "") return [];
	if (Array.isArray(value)) return option(name, value.join(","));
	return option(name, value);
}
function jsonOption(value) {
	if (value == null || value === "") return null;
	return typeof value === "string" ? value : JSON.stringify(value);
}
function flag(name, value) {
	return boolOption(value, false) ? [name] : [];
}
function boolOption(value, fallback = false) {
	if (value == null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	return [
		"1",
		"true",
		"yes",
		"on"
	].includes(String(value).toLowerCase());
}
function compactArgs(items) {
	return items.flat().filter((item) => item != null && item !== "");
}
//#endregion
export { boolOption, buildCliInvocationForTool, createCliToolCaller };
