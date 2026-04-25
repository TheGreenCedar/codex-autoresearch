import { parseMetricLines, runShell, tailText } from "../lib/runner.mjs";
import { appendJsonl, currentState, iterationLimitInfo, parseQualityGaps } from "../lib/session-core.mjs";
import { resolvePackageRoot } from "../lib/runtime-paths.mjs";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
//#region tests/full-product.test.ts
const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const runProcess = (command, args, cwd) => {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
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
		child.on("error", (error) => resolve({
			code: -1,
			stdout,
			stderr: String(error.message || error)
		}));
		child.on("close", (code) => resolve({
			code,
			stdout,
			stderr
		}));
	});
};
const runCli = (args, options = {}) => {
	return runProcess(process.execPath, [cli, ...args], options.cwd || pluginRoot);
};
const runCliWithAnswers = (args, answers, options = {}) => {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, ...args], {
			cwd: options.cwd || pluginRoot,
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let answered = 0;
		let seenPrompts = 0;
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
			const promptCount = (stdout.match(/: /g) || []).length;
			while (seenPrompts < promptCount && answered < answers.length) {
				child.stdin.write(`${answers[answered]}\n`);
				answered += 1;
				seenPrompts += 1;
			}
			if (answered === answers.length && !child.stdin.destroyed) child.stdin.end();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => resolve({
			code: -1,
			stdout,
			stderr: String(error.message || error)
		}));
		child.on("close", (code) => resolve({
			code,
			stdout,
			stderr
		}));
	});
};
const withTempDir = async (name, fn) => {
	const dir = await mkdtemp(path.join(tmpdir(), `autoresearch-full-${name}-`));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, {
			recursive: true,
			force: true
		});
	}
};
const git = async (cwd, args) => {
	const result = await runProcess("git", args, cwd);
	assert.equal(result.code, 0, `git ${args.join(" ")} failed\n${result.stderr}${result.stdout}`);
	return result.stdout.trim();
};
async function callMcpTool(name, args) {
	const child = spawn(process.execPath, [cli, "--mcp"], {
		cwd: pluginRoot,
		windowsHide: true,
		stdio: [
			"pipe",
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
	const request = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name,
			arguments: args
		}
	});
	child.stdin.write(`Content-Length: ${Buffer.byteLength(request, "utf8")}\r\n\r\n${request}`);
	try {
		const response = await waitForMcpResponse(() => stdout, () => stderr);
		assert.equal(response.id, 1);
		return response;
	} finally {
		child.kill();
	}
}
async function waitForMcpResponse(stdoutFn, stderrFn) {
	const started = Date.now();
	while (Date.now() - started < 5e3) {
		const frame = parseFirstMcpFrame(stdoutFn());
		if (frame) return frame;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`MCP response timed out\n${stderrFn()}`);
}
function parseFirstMcpFrame(stdout) {
	const headerEnd = stdout.indexOf("\r\n\r\n");
	if (headerEnd < 0) return null;
	const match = stdout.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
	if (!match) return null;
	const length = Number(match[1]);
	const bodyStart = headerEnd + 4;
	if (stdout.length < bodyStart + length) return null;
	return JSON.parse(stdout.slice(bodyStart, bodyStart + length));
}
test("session core handles finite metrics, segments, limits, and quality gaps", async () => {
	await withTempDir("session-core", async (dir) => {
		appendJsonl(dir, {
			type: "config",
			name: "core",
			metricName: "delta",
			bestDirection: "lower"
		});
		appendJsonl(dir, {
			run: 1,
			metric: 0,
			status: "keep",
			description: "Zero baseline"
		});
		appendJsonl(dir, {
			run: 2,
			metric: -2,
			status: "keep",
			description: "Negative improvement"
		});
		let state = currentState(dir);
		assert.equal(state.baseline, 0);
		assert.equal(state.best, -2);
		assert.equal(iterationLimitInfo(state, { maxIterations: 3 }).remainingIterations, 1);
		appendJsonl(dir, {
			type: "config",
			name: "second",
			metricName: "seconds",
			bestDirection: "higher"
		});
		appendJsonl(dir, {
			run: 3,
			metric: 5,
			status: "discard",
			description: "Segment reset"
		});
		state = currentState(dir);
		assert.equal(state.segment, 1);
		assert.equal(state.current.length, 1);
		assert.equal(iterationLimitInfo(state, { maxIterations: 1 }).limitReached, true);
		assert.deepEqual(parseQualityGaps("- [ ] Open\n- [x] Closed\n- [X] Rejected\n"), {
			open: 1,
			closed: 2,
			total: 3
		});
	});
});
test("runner parses metrics, truncates tails, and reports timeouts", async () => {
	const metrics = parseMetricLines([
		"metric seconds=1.25",
		"METRIC delta=-2",
		"METRIC scaled=1.5e+2",
		"METRIC __proto__=99"
	].join("\n"));
	assert.equal(metrics.seconds, 1.25);
	assert.equal(metrics.delta, -2);
	assert.equal(metrics.scaled, 150);
	assert.equal(Object.hasOwn(metrics, "__proto__"), false);
	const tail = tailText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"), 5, 2e3);
	assert.equal(tail.split(/\r?\n/).length, 5);
	assert.match(tail, /line 39/);
	const result = await runShell(`${JSON.stringify(process.execPath)} -e "setTimeout(()=>{}, 2000)"`, pluginRoot, 1);
	assert.equal(result.timedOut, true);
});
test("setup-plan, recipes, and recipe-backed setup are wired through the CLI", async () => {
	await withTempDir("setup-recipes", async (dir) => {
		await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('ok')\"" } }, null, 2));
		const plan = await runCli([
			"setup-plan",
			"--cwd",
			dir
		]);
		assert.equal(plan.code, 0, plan.stderr);
		const planPayload = JSON.parse(plan.stdout);
		assert.equal(planPayload.recommendedRecipe.id, "node-test-runtime");
		assert.match(planPayload.nextCommand, /setup/);
		assert.match(planPayload.guideCommand, / guide /);
		assert.deepEqual(planPayload.guidedFlow.map((step) => step.step), [
			"setup",
			"benchmark-lint",
			"doctor",
			"baseline",
			"log"
		]);
		const recipes = await runCli(["recipes", "list"]);
		assert.equal(recipes.code, 0, recipes.stderr);
		assert.match(recipes.stdout, /memory-usage/);
		const memoryRecipe = JSON.parse(recipes.stdout).recipes.find((recipe) => recipe.id === "memory-usage");
		assert.ok(memoryRecipe.tags.includes("memory"));
		const firstGuide = await runCli([
			"guide",
			"--cwd",
			dir
		]);
		assert.equal(firstGuide.code, 0, firstGuide.stderr);
		const firstGuidePayload = JSON.parse(firstGuide.stdout);
		assert.equal(firstGuidePayload.stage, "needs-setup");
		assert.match(firstGuidePayload.commands.setup, / setup /);
		assert.match(firstGuidePayload.commands.dashboard, / serve /);
		const setup = await runCli([
			"setup",
			"--cwd",
			dir,
			"--recipe",
			"memory-usage",
			"--name",
			"Memory loop"
		]);
		assert.equal(setup.code, 0, setup.stderr);
		const payload = JSON.parse(setup.stdout);
		assert.equal(payload.init.config.metricName, "rss_mb");
		const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
		assert.equal(config.recipeId, "memory-usage");
		assert.match(await readFile(path.join(dir, "autoresearch.md"), "utf8"), /## Resume This Session/);
		const resumeGuide = await runCli([
			"guide",
			"--cwd",
			dir
		]);
		assert.equal(resumeGuide.code, 0, resumeGuide.stderr);
		const resumeGuidePayload = JSON.parse(resumeGuide.stdout);
		assert.equal(resumeGuidePayload.stage, "needs-baseline");
		assert.equal(resumeGuidePayload.setup.recommendedRecipe.id, "memory-usage");
		assert.equal(resumeGuidePayload.doctor.ok, true);
		const doctor = await runCli([
			"doctor",
			"--cwd",
			dir,
			"--check-benchmark"
		]);
		assert.equal(doctor.code, 0, doctor.stderr);
		const doctorPayload = JSON.parse(doctor.stdout);
		assert.equal(doctorPayload.ok, true);
		assert.equal(doctorPayload.drift.local.surfaces.packageJson, "1.1.10");
		assert.equal(doctorPayload.drift.ok, true);
	});
});
test("delight commands provide compact state, onboarding, linting, hooks, and new segments", async () => {
	await withTempDir("delight-commands", async (dir) => {
		await runCli([
			"init",
			"--cwd",
			dir,
			"--name",
			"Delight loop",
			"--metric-name",
			"score"
		]);
		await runCli([
			"log",
			"--cwd",
			dir,
			"--metric",
			"5",
			"--status",
			"keep",
			"--description",
			"Baseline",
			"--asi",
			JSON.stringify({
				hypothesis: "baseline",
				evidence: "score=5"
			})
		]);
		const compact = await runCli([
			"state",
			"--cwd",
			dir,
			"--compact"
		]);
		assert.equal(compact.code, 0, compact.stderr);
		const compactPayload = JSON.parse(compact.stdout);
		assert.equal(compactPayload.metric, "score");
		assert.equal(compactPayload.runs, 1);
		assert.equal(compactPayload.commands.newSegmentDryRun.includes("new-segment"), true);
		const lint = await runCli([
			"benchmark-lint",
			"--cwd",
			dir,
			"--metric-name",
			"score",
			"--sample",
			"METRIC score=4.2"
		]);
		assert.equal(lint.code, 0, lint.stderr);
		const lintPayload = JSON.parse(lint.stdout);
		assert.equal(lintPayload.ok, true);
		assert.equal(lintPayload.parsedMetrics.score, 4.2);
		const inspect = await runCli([
			"benchmark-inspect",
			"--cwd",
			dir
		]);
		assert.equal(inspect.code, 0, inspect.stderr);
		const inspectPayload = JSON.parse(inspect.stdout);
		assert.equal(inspectPayload.ranCommand, false);
		assert.match(inspectPayload.hints.join("\n"), /METRIC score=<number>/);
		const checksInspect = await runCli([
			"checks-inspect",
			"--cwd",
			dir
		]);
		assert.equal(checksInspect.code, 0, checksInspect.stderr);
		const checksInspectPayload = JSON.parse(checksInspect.stdout);
		assert.equal(checksInspectPayload.ranCommand, false);
		assert.match(checksInspectPayload.hints.join("\n"), /Cargo/);
		const recommend = await runCli([
			"recommend-next",
			"--cwd",
			dir,
			"--compact"
		]);
		assert.equal(recommend.code, 0, recommend.stderr);
		const recommendPayload = JSON.parse(recommend.stdout);
		assert.equal(recommendPayload.ok, true);
		assert.ok(recommendPayload.nextAction);
		const onboarding = await runCli([
			"onboarding-packet",
			"--cwd",
			dir,
			"--compact"
		]);
		assert.equal(onboarding.code, 0, onboarding.stderr);
		const onboardingPayload = JSON.parse(onboarding.stdout);
		assert.equal(onboardingPayload.kind, "codex-autoresearch-onboarding-packet");
		assert.ok(onboardingPayload.templates.firstResponse);
		const promptPlan = await runCli([
			"prompt-plan",
			"--cwd",
			dir,
			"--prompt",
			[
				"Use $Codex Autoresearch to optimize my unit tests' speed.",
				"Benchmark: node -e \"console.log('METRIC seconds=1')\"",
				"Metric: seconds, lower is better",
				"Checks: node -e \"process.exit(0)\"",
				"Scope: test runner config and test helpers only"
			].join("\n")
		]);
		assert.equal(promptPlan.code, 0, promptPlan.stderr);
		const promptPayload = JSON.parse(promptPlan.stdout);
		assert.equal(promptPayload.kind, "codex-autoresearch-prompt-plan");
		assert.equal(promptPayload.intent.metric.name, "seconds");
		assert.match(promptPayload.intent.safeInterpretation, /preserving test coverage/);
		assert.match(promptPayload.setup.nextCommand, /--files-in-scope/);
		await mkdir(path.join(dir, "scripts"), { recursive: true });
		await writeFile(path.join(dir, "scripts", "autoresearch-indexer-embedder-pipeline.mjs"), "console.log('METRIC pipeline_score=123')\nconsole.log('METRIC quality_component=1')\n");
		const pipelinePromptPlan = await runCli([
			"prompt-plan",
			"--cwd",
			dir,
			"--prompt",
			"Start a new Codex Autoresearch session to improve the performance of the parse + index + embed pipeline."
		]);
		assert.equal(pipelinePromptPlan.code, 0, pipelinePromptPlan.stderr);
		const pipelinePayload = JSON.parse(pipelinePromptPlan.stdout);
		assert.equal(pipelinePayload.intent.metric.name, "pipeline_score");
		assert.equal(pipelinePayload.intent.metric.direction, "higher");
		assert.match(pipelinePayload.intent.setupDefaults.benchmarkCommand, /scripts\/autoresearch-indexer-embedder-pipeline\.mjs/);
		assert.match(pipelinePayload.intent.setupDefaults.constraints.join("\n"), /primary score/);
		const broadPromptPlan = await runCli([
			"prompt-plan",
			"--cwd",
			dir,
			"--prompt",
			"Use $Codex Autoresearch to keep reducing bugs in the codebase, starting with the most obvious low hanging fruits. Keep doing this 100 times."
		]);
		assert.equal(broadPromptPlan.code, 0, broadPromptPlan.stderr);
		const broadPayload = JSON.parse(broadPromptPlan.stdout);
		assert.equal(broadPayload.intent.loopKind, "quality-gap");
		assert.equal(broadPayload.intent.setupDefaults.maxIterations, 100);
		const hooks = await runCli([
			"doctor",
			"hooks",
			"--cwd",
			dir
		]);
		assert.equal(hooks.code, 0, hooks.stderr);
		const hooksPayload = JSON.parse(hooks.stdout);
		assert.equal(hooksPayload.defaultEnabled, false);
		assert.ok(Array.isArray(hooksPayload.limitations));
		const dryRun = await runCli([
			"new-segment",
			"--cwd",
			dir,
			"--dry-run"
		]);
		assert.equal(dryRun.code, 0, dryRun.stderr);
		assert.equal(JSON.parse(dryRun.stdout).dryRun, true);
		const segment = await runCli([
			"new-segment",
			"--cwd",
			dir,
			"--reason",
			"fresh phase",
			"--yes"
		]);
		assert.equal(segment.code, 0, segment.stderr);
		const segmentPayload = JSON.parse(segment.stdout);
		assert.equal(segmentPayload.nextSegment, 1);
		const promote = await runCli([
			"promote-gate",
			"--cwd",
			dir,
			"--reason",
			"larger sample",
			"--query-count",
			"25",
			"--dry-run"
		]);
		assert.equal(promote.code, 0, promote.stderr);
		const promotePayload = JSON.parse(promote.stdout);
		assert.equal(promotePayload.entry.measurementGate.queryCount, 25);
		const after = await runCli([
			"state",
			"--cwd",
			dir,
			"--compact"
		]);
		assert.equal(after.code, 0, after.stderr);
		const afterPayload = JSON.parse(after.stdout);
		assert.equal(afterPayload.segment, 1);
		assert.equal(afterPayload.runs, 0);
	});
});
test("MCP setup_session can use recipe defaults without explicit name and metric", async () => {
	await withTempDir("mcp-recipe-setup", async (dir) => {
		const response = await callMcpTool("setup_session", {
			working_dir: dir,
			recipe_id: "memory-usage"
		});
		assert.equal(response.result?.isError, void 0, response.result?.content?.[0]?.text);
		const payload = JSON.parse(response.result.content[0].text);
		assert.equal(payload.init.config.metricName, "rss_mb");
	});
});
test("MCP exposes onboarding, prompt planning, benchmark probes, recommend-next, and segment tools", async () => {
	await withTempDir("mcp-delight-tools", async (dir) => {
		await runCli([
			"init",
			"--cwd",
			dir,
			"--name",
			"mcp delight",
			"--metric-name",
			"score"
		]);
		await runCli([
			"log",
			"--cwd",
			dir,
			"--metric",
			"3",
			"--status",
			"keep",
			"--description",
			"Baseline",
			"--asi",
			JSON.stringify({
				hypothesis: "baseline",
				evidence: "score=3"
			})
		]);
		const onboarding = await callMcpTool("onboarding_packet", {
			working_dir: dir,
			compact: true
		});
		assert.equal(onboarding.result?.isError, void 0, onboarding.result?.content?.[0]?.text);
		assert.match(onboarding.result.content[0].text, /codex-autoresearch-onboarding-packet/);
		const promptPlan = await callMcpTool("prompt_plan", {
			working_dir: dir,
			prompt: "Use $Codex Autoresearch to figure out why p99 latency is so much higher than p90. I suspect: DNS lookup, event loop throttling, memory spike, CPU spike. Use @experiments.md."
		});
		assert.equal(promptPlan.result?.isError, void 0, promptPlan.result?.content?.[0]?.text);
		assert.match(promptPlan.result.content[0].text, /p99_p90_ratio/);
		assert.match(promptPlan.result.content[0].text, /DNS lookup/);
		assert.match(promptPlan.result.content[0].text, /experiments\.md/);
		const lint = await callMcpTool("benchmark_lint", {
			working_dir: dir,
			metric_name: "score",
			sample: "METRIC score=2"
		});
		assert.equal(lint.result?.isError, void 0, lint.result?.content?.[0]?.text);
		assert.match(lint.result.content[0].text, /"emitsPrimary": true/);
		const inspect = await callMcpTool("benchmark_inspect", { working_dir: dir });
		assert.equal(inspect.result?.isError, void 0, inspect.result?.content?.[0]?.text);
		assert.match(inspect.result.content[0].text, /benchmark-native list/);
		const checksInspect = await callMcpTool("checks_inspect", { working_dir: dir });
		assert.equal(checksInspect.result?.isError, void 0, checksInspect.result?.content?.[0]?.text);
		assert.match(checksInspect.result.content[0].text, /correctness command/);
		const next = await callMcpTool("recommend_next", {
			working_dir: dir,
			compact: true
		});
		assert.equal(next.result?.isError, void 0, next.result?.content?.[0]?.text);
		assert.match(next.result.content[0].text, /"whySafe"/);
		const dryRun = await callMcpTool("new_segment", {
			working_dir: dir,
			dry_run: true
		});
		assert.equal(dryRun.result?.isError, void 0, dryRun.result?.content?.[0]?.text);
		assert.match(dryRun.result.content[0].text, /"dryRun": true/);
		const promote = await callMcpTool("promote_gate", {
			working_dir: dir,
			reason: "larger gate",
			query_count: 20,
			dry_run: true
		});
		assert.equal(promote.result?.isError, void 0, promote.result?.content?.[0]?.text);
		assert.match(promote.result.content[0].text, /"queryCount": 20/);
	});
});
test("MCP export_dashboard supports compact and full payloads", async () => {
	await withTempDir("mcp-export", async (dir) => {
		await runCli([
			"init",
			"--cwd",
			dir,
			"--name",
			"mcp export",
			"--metric-name",
			"seconds"
		]);
		await runCli([
			"log",
			"--cwd",
			dir,
			"--metric",
			"1",
			"--status",
			"keep",
			"--description",
			"Baseline"
		]);
		const compact = await callMcpTool("export_dashboard", { working_dir: dir });
		assert.equal(compact.result?.isError, void 0, compact.result?.content?.[0]?.text);
		const compactPayload = JSON.parse(compact.result.content[0].text);
		assert.equal(compactPayload.summary.runs, 1);
		assert.equal(compactPayload.viewModel, void 0);
		const full = await callMcpTool("export_dashboard", {
			working_dir: dir,
			full: true
		});
		assert.equal(full.result?.isError, void 0, full.result?.content?.[0]?.text);
		const fullPayload = JSON.parse(full.result.content[0].text);
		assert.equal(fullPayload.viewModel.summary.runs, 1);
	});
});
test("MCP serve_dashboard returns a live dashboard URL", async () => {
	await withTempDir("mcp-serve", async (dir) => {
		await runCli([
			"init",
			"--cwd",
			dir,
			"--name",
			"mcp serve",
			"--metric-name",
			"seconds"
		]);
		await runCli([
			"log",
			"--cwd",
			dir,
			"--metric",
			"1",
			"--status",
			"keep",
			"--description",
			"Baseline"
		]);
		const response = await callMcpTool("serve_dashboard", {
			working_dir: dir,
			port: 0
		});
		assert.equal(response.result?.isError, void 0, response.result?.content?.[0]?.text);
		const payload = JSON.parse(response.result.content[0].text);
		assert.equal(payload.modeGuidance.deliveryMode, "live-server");
		assert.equal(payload.verified, true);
		assert.match(payload.healthUrl, /^http:\/\/127\.0\.0\.1:\d+\/health$/);
		assert.match(payload.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
	});
});
test("MCP gap_candidates requires the unsafe command gate for model commands", async () => {
	await withTempDir("mcp-gap-gate", async (dir) => {
		const response = await callMcpTool("gap_candidates", {
			working_dir: dir,
			research_slug: "study",
			model_command: `${JSON.stringify(process.execPath)} -e "console.log([])"`
		});
		assert.equal(response.result?.isError, true);
		assert.match(response.result.content[0].text, /allow_unsafe_command=true/);
	});
});
test("catalog recipes can drive setup-plan and setup", async () => {
	await withTempDir("catalog-setup", async (dir) => {
		const catalog = path.join(dir, "recipes.json");
		await writeFile(catalog, JSON.stringify({ recipes: [{
			id: "catalog-demo",
			title: "Catalog Demo",
			metricName: "demo_score",
			metricUnit: "points",
			direction: "higher",
			benchmarkCommand: "node -e \"console.log('METRIC demo_score=42')\"",
			benchmarkPrintsMetric: true,
			checksCommand: "node -e \"process.exit(0)\"",
			scope: ["src"]
		}] }, null, 2));
		const plan = await runCli([
			"setup-plan",
			"--cwd",
			dir,
			"--recipe",
			"catalog-demo",
			"--catalog",
			catalog
		]);
		assert.equal(plan.code, 0, plan.stderr);
		const planPayload = JSON.parse(plan.stdout);
		assert.equal(planPayload.recommendedRecipe.id, "catalog-demo");
		assert.match(planPayload.nextCommand, /--catalog/);
		const setup = await runCli([
			"setup",
			"--cwd",
			dir,
			"--recipe",
			"catalog-demo",
			"--catalog",
			catalog
		]);
		assert.equal(setup.code, 0, setup.stderr);
		const setupPayload = JSON.parse(setup.stdout);
		assert.equal(setupPayload.init.config.metricName, "demo_score");
		const doctor = await runCli([
			"doctor",
			"--cwd",
			dir,
			"--check-benchmark"
		]);
		assert.equal(doctor.code, 0, doctor.stderr);
		assert.equal(JSON.parse(doctor.stdout).ok, true);
	});
});
test("interactive setup uses defaults from the recipe selected by the operator", async () => {
	await withTempDir("interactive-recipe", async (dir) => {
		await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('ok')\"" } }, null, 2));
		const interactive = await runCliWithAnswers([
			"setup",
			"--cwd",
			dir,
			"--interactive"
		], [
			"memory-usage",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			""
		]);
		assert.equal(interactive.code, 0, interactive.stderr);
		const state = await runCli([
			"state",
			"--cwd",
			dir
		]);
		assert.equal(state.code, 0, state.stderr);
		assert.equal(JSON.parse(state.stdout).config.metricName, "rss_mb");
	});
});
test("quality-gap recipe benchmarks through the plugin CLI", async () => {
	await withTempDir("quality-gap-recipe", async (dir) => {
		const researchDir = path.join(dir, "autoresearch.research", "research");
		await mkdir(researchDir, { recursive: true });
		await writeFile(path.join(researchDir, "quality-gaps.md"), "- [ ] Existing gap\n");
		const setup = await runCli([
			"setup",
			"--cwd",
			dir,
			"--recipe",
			"quality-gap"
		]);
		assert.equal(setup.code, 0, setup.stderr);
		const setupPayload = JSON.parse(setup.stdout);
		assert.equal(setupPayload.init.config.metricName, "quality_gap");
		const doctor = await runCli([
			"doctor",
			"--cwd",
			dir,
			"--check-benchmark"
		]);
		assert.equal(doctor.code, 0, doctor.stderr);
		assert.equal(JSON.parse(doctor.stdout).ok, true);
	});
});
test("quality-gap auto-detects the active research slug for JSON output", async () => {
	await withTempDir("quality-gap-autodetect", async (dir) => {
		await runCli([
			"research-setup",
			"--cwd",
			dir,
			"--slug",
			"Delight Study",
			"--goal",
			"Study project delight"
		]);
		await writeFile(path.join(dir, "autoresearch.research", "delight-study", "quality-gaps.md"), "- [ ] Open delight gap\n- [x] Closed delight gap\n", "utf8");
		const result = await runCli([
			"quality-gap",
			"--cwd",
			dir,
			"--json"
		]);
		assert.equal(result.code, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.equal(payload.slug, "delight-study");
		assert.equal(payload.open, 1);
		assert.deepEqual(payload.openItems, ["Open delight gap"]);
	});
});
test("gap-candidates extracts, dedupes, applies, and rejects malformed model output", async () => {
	await withTempDir("gap-candidates", async (dir) => {
		await runCli([
			"research-setup",
			"--cwd",
			dir,
			"--slug",
			"study",
			"--goal",
			"Study delight"
		]);
		const synthesisPath = path.join(dir, "autoresearch.research", "study", "synthesis.md");
		await writeFile(synthesisPath, [
			"# Research Synthesis",
			"",
			"## High-Impact Findings",
			"- Build a guided setup flow with recipe suggestions.",
			"- Build a guided setup flow with recipe suggestions.",
			""
		].join("\n"));
		const preview = await runCli([
			"gap-candidates",
			"--cwd",
			dir,
			"--research-slug",
			"study"
		]);
		assert.equal(preview.code, 0, preview.stderr);
		const previewPayload = JSON.parse(preview.stdout);
		assert.equal(previewPayload.candidates.length, 1);
		assert.equal(previewPayload.applied, false);
		assert.equal(previewPayload.roundGuidance.unit, "research-round");
		assert.match(previewPayload.roundGuidance.metricScope, /does not discover fresh recommendations/);
		assert.match(previewPayload.roundGuidance.requiredRefresh, /rerun the project-study prompt/);
		assert.ok(previewPayload.roundGuidance.hallucinationFilter.some((item) => /validation path/.test(item)));
		assert.match(previewPayload.roundGuidance.stopRule, /fresh research round/);
		const applied = await runCli([
			"gap-candidates",
			"--cwd",
			dir,
			"--research-slug",
			"study",
			"--apply"
		]);
		assert.equal(applied.code, 0, applied.stderr);
		const appliedPayload = JSON.parse(applied.stdout);
		assert.equal(appliedPayload.applied, true);
		assert.equal(appliedPayload.qualityGap.total, 7);
		await writeFile(synthesisPath, [
			"# Research Synthesis",
			"",
			"## High-Impact Findings",
			"- Build a guided setup flow with recipe suggestions.",
			"- Add a resume cockpit that explains the exact next operator action.",
			""
		].join("\n"));
		const reapplied = await runCli([
			"gap-candidates",
			"--cwd",
			dir,
			"--research-slug",
			"study",
			"--apply"
		]);
		assert.equal(reapplied.code, 0, reapplied.stderr);
		const reappliedPayload = JSON.parse(reapplied.stdout);
		assert.equal(reappliedPayload.qualityGap.total, 8);
		const gaps = await readFile(path.join(dir, "autoresearch.research", "study", "quality-gaps.md"), "utf8");
		assert.equal((gaps.match(/## Candidate Gaps/g) || []).length, 1);
		assert.equal((gaps.match(/<!-- codex-autoresearch:generated-candidates -->/g) || []).length, 1);
		assert.match(gaps, /resume cockpit/);
		assert.match(gaps, /guided setup flow/);
		await writeFile(synthesisPath, [
			"# Research Synthesis",
			"",
			"## High-Impact Findings",
			"- Add a resume cockpit that explains the exact next operator action.",
			""
		].join("\n"));
		const refreshed = await runCli([
			"gap-candidates",
			"--cwd",
			dir,
			"--research-slug",
			"study",
			"--apply"
		]);
		assert.equal(refreshed.code, 0, refreshed.stderr);
		const refreshedPayload = JSON.parse(refreshed.stdout);
		assert.equal(refreshedPayload.qualityGap.total, 7);
		const refreshedGaps = await readFile(path.join(dir, "autoresearch.research", "study", "quality-gaps.md"), "utf8");
		assert.equal((refreshedGaps.match(/## Candidate Gaps/g) || []).length, 1);
		assert.match(refreshedGaps, /resume cockpit/);
		assert.doesNotMatch(refreshedGaps, /guided setup flow/);
		await writeFile(synthesisPath, "# Research Synthesis\n\n## High-Impact Findings\n\n");
		const cleared = await runCli([
			"gap-candidates",
			"--cwd",
			dir,
			"--research-slug",
			"study",
			"--apply"
		]);
		assert.equal(cleared.code, 0, cleared.stderr);
		const clearedPayload = JSON.parse(cleared.stdout);
		assert.equal(clearedPayload.qualityGap.total, 6);
		const clearedGaps = await readFile(path.join(dir, "autoresearch.research", "study", "quality-gaps.md"), "utf8");
		assert.doesNotMatch(clearedGaps, /## Candidate Gaps/);
		await writeFile(path.join(dir, "autoresearch.research", "study", "quality-gaps.md"), [
			"# Quality Gaps",
			"",
			"- [x] Build a guided setup flow with recipe suggestions. Evidence: implemented in round 1.",
			""
		].join("\n"), "utf8");
		await writeFile(synthesisPath, [
			"# Research Synthesis",
			"",
			"## High-Impact Findings",
			"- Build a guided setup flow with recipe suggestions.",
			""
		].join("\n"));
		const closedDuplicate = await runCli([
			"gap-candidates",
			"--cwd",
			dir,
			"--research-slug",
			"study"
		]);
		assert.equal(closedDuplicate.code, 0, closedDuplicate.stderr);
		const closedDuplicatePayload = JSON.parse(closedDuplicate.stdout);
		assert.equal(closedDuplicatePayload.candidates.length, 0);
		assert.equal(closedDuplicatePayload.stopRecommended, true);
		assert.equal(closedDuplicatePayload.stopStatus.researchExhausted, true);
		assert.equal(closedDuplicatePayload.stopStatus.requiresPassingChecks, true);
		await writeFile(path.join(dir, "autoresearch.research", "study", "quality-gaps.md"), [
			"# Quality Gaps",
			"",
			"- [x] Build an Evidence: ledger for accepted gaps.",
			""
		].join("\n"), "utf8");
		await writeFile(synthesisPath, [
			"# Research Synthesis",
			"",
			"## High-Impact Findings",
			"- Build an Evidence: panel for candidate provenance.",
			""
		].join("\n"));
		const evidenceTitle = await runCli([
			"gap-candidates",
			"--cwd",
			dir,
			"--research-slug",
			"study"
		]);
		assert.equal(evidenceTitle.code, 0, evidenceTitle.stderr);
		const evidenceTitlePayload = JSON.parse(evidenceTitle.stdout);
		assert.equal(evidenceTitlePayload.candidates.length, 1);
		assert.equal(evidenceTitlePayload.stopRecommended, false);
		const badModel = await runCli([
			"gap-candidates",
			"--cwd",
			dir,
			"--research-slug",
			"study",
			"--model-command",
			`${JSON.stringify(process.execPath)} -e "console.log('not json')"`
		]);
		assert.notEqual(badModel.code, 0);
		assert.match(badModel.stderr, /model-command must print a JSON array/);
		const timedOutModel = await runCli([
			"gap-candidates",
			"--cwd",
			dir,
			"--research-slug",
			"study",
			"--model-command",
			`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 2000)"`,
			"--model-timeout-seconds",
			"1"
		]);
		assert.notEqual(timedOutModel.code, 0);
		assert.match(timedOutModel.stderr, /model-command failed \(timed out\)/);
	});
});
test("finalize-preview summarizes kept commits without creating branches", async () => {
	await withTempDir("finalize-preview", async (dir) => {
		await git(dir, [
			"init",
			"-b",
			"main"
		]);
		await git(dir, [
			"config",
			"user.email",
			"codex@example.test"
		]);
		await git(dir, [
			"config",
			"user.name",
			"Codex Test"
		]);
		await mkdir(path.join(dir, "src"), { recursive: true });
		await writeFile(path.join(dir, "src", "value.txt"), "base\n");
		await git(dir, ["add", "-A"]);
		await git(dir, [
			"commit",
			"-m",
			"base"
		]);
		await git(dir, ["branch", "develop"]);
		await git(dir, [
			"switch",
			"-c",
			"codex/autoresearch-preview"
		]);
		await runCli([
			"init",
			"--cwd",
			dir,
			"--name",
			"preview",
			"--metric-name",
			"seconds"
		]);
		await git(dir, ["add", "autoresearch.jsonl"]);
		await git(dir, [
			"commit",
			"-m",
			"session"
		]);
		await writeFile(path.join(dir, "src", "value.txt"), "kept\n");
		const keep = await runCli([
			"log",
			"--cwd",
			dir,
			"--metric",
			"1",
			"--status",
			"keep",
			"--description",
			"Keep value",
			"--commit-paths",
			"src"
		]);
		assert.equal(keep.code, 0, keep.stderr);
		await git(dir, ["add", "autoresearch.jsonl"]);
		await git(dir, [
			"commit",
			"-m",
			"record run"
		]);
		const preview = await runCli([
			"finalize-preview",
			"--cwd",
			dir
		]);
		assert.equal(preview.code, 0, preview.stderr);
		const payload = JSON.parse(preview.stdout);
		assert.equal(payload.ready, true);
		assert.equal(payload.progress.mode, "synchronous");
		assert.equal(payload.progress.status, "completed");
		assert.equal(payload.progress.stages[0].stage, "finalize-preview");
		assert.equal(payload.groups.length, 1);
		assert.deepEqual(payload.groups[0].files, ["src/value.txt"]);
		const developPreview = await runCli([
			"finalize-preview",
			"--cwd",
			dir,
			"--trunk",
			"develop"
		]);
		assert.equal(developPreview.code, 0, developPreview.stderr);
		assert.match(JSON.parse(developPreview.stdout).suggestedCommand, /--trunk "develop"/);
		const branches = await git(dir, [
			"branch",
			"--list",
			"autoresearch-review/*"
		]);
		assert.equal(branches, "");
	});
});
test("integrations can load local recipe catalogs", async () => {
	await withTempDir("integrations", async (dir) => {
		const catalog = path.join(dir, "recipes.json");
		await writeFile(catalog, JSON.stringify({ recipes: [{
			id: "demo-recipe",
			title: "Demo Recipe",
			metricName: "demo",
			direction: "higher",
			benchmarkCommand: "node -e \"console.log('METRIC demo=1')\""
		}] }, null, 2));
		const synced = await runCli([
			"integrations",
			"sync-recipes",
			"--catalog",
			catalog
		]);
		assert.equal(synced.code, 0, synced.stderr);
		const payload = JSON.parse(synced.stdout);
		assert.equal(payload.synced, false);
		assert.ok(payload.recipes.some((recipe) => recipe.id === "demo-recipe"));
		const doctor = await runCli([
			"integrations",
			"doctor",
			"--catalog",
			catalog
		]);
		assert.equal(doctor.code, 0, doctor.stderr);
		assert.match(doctor.stdout, /Configured recipe catalog/);
	});
});
test("live server exposes health and view-model endpoints", async () => {
	await withTempDir("live-server", async (dir) => {
		await runCli([
			"init",
			"--cwd",
			dir,
			"--name",
			"live",
			"--metric-name",
			"seconds"
		]);
		await runCli([
			"log",
			"--cwd",
			dir,
			"--metric",
			"1",
			"--status",
			"keep",
			"--description",
			"Baseline"
		]);
		const child = spawn(process.execPath, [
			cli,
			"serve",
			"--cwd",
			dir,
			"--port",
			"0"
		], {
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
		try {
			const payload = await waitForServerPayload(() => stdout, () => stderr);
			assert.equal(payload.modeGuidance.deliveryMode, "live-server");
			assert.equal(payload.verified, true);
			assert.match(payload.healthUrl, /^http:\/\/127\.0\.0\.1:\d+\/health$/);
			assert.match(payload.modeGuidance.difference, /read-only snapshots|fallback snapshot/);
			const health = await fetch(`${payload.url}health`).then((res) => res.json());
			assert.equal(health.ok, true);
			const html = await fetch(payload.url).then((res) => res.text());
			assert.match(html, /"deliveryMode":"live-server"/);
			assert.doesNotMatch(html, /Live actions available/);
			assert.doesNotMatch(html, /live-actions-panel/);
			const viewModel = await fetch(`${payload.url}view-model.json`).then((res) => res.json());
			assert.equal(viewModel.summary.runs, 1);
		} finally {
			child.kill();
		}
	});
});
test("live server rejects dashboard actions because CLI and MCP own mutations", async () => {
	await withTempDir("live-gap-action", async (dir) => {
		await runCli([
			"research-setup",
			"--cwd",
			dir,
			"--slug",
			"Custom Study",
			"--goal",
			"Study live gaps"
		]);
		const child = spawn(process.execPath, [
			cli,
			"serve",
			"--cwd",
			dir,
			"--port",
			"0"
		], {
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
		try {
			const payload = await waitForServerPayload(() => stdout, () => stderr);
			const action = await fetch(`${payload.url}actions/gap-candidates`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Origin: new URL(payload.url).origin
				},
				body: JSON.stringify({})
			});
			assert.equal(action.status, 403);
			const body = await action.json();
			assert.equal(body.ok, false);
			assert.equal(body.code, "actions_disabled");
		} finally {
			child.kill();
		}
	});
});
test("live server log actions stay disabled and leave last-run packets untouched", async () => {
	await withTempDir("live-log-action", async (dir) => {
		await runCli([
			"init",
			"--cwd",
			dir,
			"--name",
			"live log",
			"--metric-name",
			"seconds"
		]);
		const benchmarkFile = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
		const benchmarkBody = process.platform === "win32" ? "Write-Output \"METRIC seconds=2\"\n" : "#!/bin/sh\nprintf 'METRIC seconds=2\\n'\n";
		await writeFile(path.join(dir, benchmarkFile), benchmarkBody, "utf8");
		const next = await runCli([
			"next",
			"--cwd",
			dir
		]);
		assert.equal(next.code, 0, next.stderr);
		const packet = JSON.parse(next.stdout);
		assert.equal(packet.continuation.stage, "needs-log-decision");
		const child = spawn(process.execPath, [
			cli,
			"serve",
			"--cwd",
			dir,
			"--port",
			"0"
		], {
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
		try {
			const payload = await waitForServerPayload(() => stdout, () => stderr);
			const viewModel = await fetch(`${payload.url}view-model.json`).then((res) => res.json());
			assert.equal(viewModel.missionControl.logDecision.available, true);
			const action = await fetch(`${payload.url}actions/log-keep`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Origin: new URL(payload.url).origin
				},
				body: JSON.stringify({
					confirm: "log-keep",
					lastRunFingerprint: viewModel.missionControl.logDecision.lastRunFingerprint,
					description: "Live kept packet",
					asi: {
						hypothesis: "Live packet improved the metric.",
						evidence: "seconds=2",
						next_action_hint: "Review finalization."
					}
				})
			});
			assert.equal(action.status, 403);
			const actionBody = await action.json();
			assert.equal(actionBody.ok, false);
			assert.equal(actionBody.code, "actions_disabled");
			const state = JSON.parse((await runCli([
				"state",
				"--cwd",
				dir
			])).stdout);
			assert.equal(state.runs, 0);
			assert.equal(state.kept, 0);
		} finally {
			child.kill();
		}
	});
});
async function waitForServerPayload(stdoutFn, stderrFn) {
	const started = Date.now();
	while (Date.now() - started < 5e3) {
		const stdout = stdoutFn();
		if (stdout.trim().endsWith("}")) return JSON.parse(stdout);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`serve did not print startup JSON\n${stderrFn()}`);
}
//#endregion
export {};
