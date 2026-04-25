import { normalizeCliCommandArguments } from "./mcp-tool-schemas.mjs";
import path from "node:path";
//#region lib/cli-handlers.ts
function createCliCommandHandlers(deps) {
	return normalizeCliHandlers({
		setup: async (args) => {
			if (args.interactive) return { result: await deps.interactiveSetup({
				cwd: args.cwd,
				recipe: args.recipe,
				catalog: args.catalog,
				shell: args.shell
			}) };
			return { result: await deps.setupSession({
				cwd: args.cwd,
				recipe: args.recipe,
				recipeId: args.recipeId,
				catalog: args.catalog,
				name: args.name,
				goal: args.goal,
				metricName: args.metricName,
				metricUnit: args.metricUnit,
				direction: args.direction,
				benchmarkCommand: args.benchmarkCommand,
				benchmarkPrintsMetric: args.benchmarkPrintsMetric,
				checksCommand: args.checksCommand,
				shell: args.shell,
				filesInScope: args.filesInScope,
				offLimits: args.offLimits,
				constraints: args.constraints,
				secondaryMetrics: args.secondaryMetrics,
				commitPaths: args.commitPaths,
				maxIterations: args.maxIterations,
				autonomyMode: args.autonomyMode,
				checksPolicy: args.checksPolicy,
				keepPolicy: args.keepPolicy,
				dashboardRefreshSeconds: args.dashboardRefreshSeconds,
				overwrite: args.overwrite,
				createChecks: args.createChecks,
				skipInit: args.skipInit
			}) };
		},
		"setup-plan": async (args) => ({ result: await deps.setupPlan({
			cwd: args.cwd,
			recipe: args.recipe,
			recipeId: args.recipeId,
			catalog: args.catalog,
			name: args.name,
			goal: args.goal,
			metricName: args.metricName,
			metricUnit: args.metricUnit,
			direction: args.direction,
			benchmarkCommand: args.benchmarkCommand,
			benchmarkPrintsMetric: args.benchmarkPrintsMetric,
			checksCommand: args.checksCommand,
			filesInScope: args.filesInScope,
			offLimits: args.offLimits,
			constraints: args.constraints,
			secondaryMetrics: args.secondaryMetrics,
			commitPaths: args.commitPaths,
			maxIterations: args.maxIterations
		}) }),
		guide: async (args) => ({ result: await deps.guidedSetup({
			cwd: args.cwd,
			recipe: args.recipe,
			recipeId: args.recipeId,
			catalog: args.catalog,
			name: args.name,
			goal: args.goal,
			metricName: args.metricName,
			metricUnit: args.metricUnit,
			benchmarkCommand: args.benchmarkCommand,
			benchmarkPrintsMetric: args.benchmarkPrintsMetric,
			checksCommand: args.checksCommand,
			filesInScope: args.filesInScope,
			offLimits: args.offLimits,
			constraints: args.constraints,
			secondaryMetrics: args.secondaryMetrics,
			commitPaths: args.commitPaths,
			maxIterations: args.maxIterations
		}) }),
		"prompt-plan": async (args) => ({ result: await deps.promptPlan({
			cwd: args.cwd,
			prompt: args.prompt,
			goal: args.goal,
			recipe: args.recipe,
			recipeId: args.recipeId,
			catalog: args.catalog,
			name: args.name,
			metricName: args.metricName,
			metricUnit: args.metricUnit,
			direction: args.direction,
			benchmarkCommand: args.benchmarkCommand,
			benchmarkPrintsMetric: args.benchmarkPrintsMetric,
			checksCommand: args.checksCommand,
			filesInScope: args.filesInScope,
			offLimits: args.offLimits,
			constraints: args.constraints,
			secondaryMetrics: args.secondaryMetrics,
			commitPaths: args.commitPaths,
			maxIterations: args.maxIterations
		}) }),
		"onboarding-packet": async (args) => ({ result: await deps.onboardingPacket({
			cwd: args.cwd,
			compact: args.compact
		}) }),
		"recommend-next": async (args) => ({ result: await deps.recommendNext({
			cwd: args.cwd,
			compact: args.compact
		}) }),
		recipes: async (args) => ({ result: await deps.recipeCommand(args._[1] || "list", args) }),
		"research-setup": async (args) => ({ result: await deps.setupResearchSession({
			cwd: args.cwd,
			slug: args.slug,
			goal: args.goal,
			name: args.name,
			checksCommand: args.checksCommand,
			shell: args.shell,
			filesInScope: args.filesInScope,
			constraints: args.constraints,
			commitPaths: args.commitPaths,
			maxIterations: args.maxIterations,
			autonomyMode: args.autonomyMode,
			checksPolicy: args.checksPolicy,
			keepPolicy: args.keepPolicy,
			dashboardRefreshSeconds: args.dashboardRefreshSeconds,
			overwrite: args.overwrite,
			createChecks: args.createChecks,
			skipInit: args.skipInit
		}) }),
		config: async (args) => ({ result: await deps.configureSession({
			cwd: args.cwd,
			autonomyMode: args.autonomyMode,
			checksPolicy: args.checksPolicy,
			keepPolicy: args.keepPolicy,
			dashboardRefreshSeconds: args.dashboardRefreshSeconds,
			maxIterations: args.maxIterations,
			extend: args.extend,
			commitPaths: args.commitPaths
		}) }),
		"quality-gap": async (args) => {
			const result = await deps.measureQualityGap({
				cwd: args.cwd,
				researchSlug: args.researchSlug,
				slug: args.slug
			});
			if (args.list || args.json) return { result };
			return { text: result.metricOutput };
		},
		"gap-candidates": async (args) => ({ result: await deps.gapCandidates({
			cwd: args.cwd,
			researchSlug: args.researchSlug,
			slug: args.slug,
			apply: args.apply,
			modelCommand: args.modelCommand,
			modelTimeoutSeconds: args.modelTimeoutSeconds
		}) }),
		"finalize-preview": async (args) => ({ result: await deps.finalizePreview({
			cwd: args.cwd,
			trunk: args.trunk
		}) }),
		serve: async (args) => await serveCommand(args, deps),
		integrations: async (args) => ({ result: await deps.integrationsCommand(args._[1] || "list", args) }),
		init: async (args) => ({ result: await deps.initExperiment({
			cwd: args.cwd,
			name: args.name,
			metricName: args.metricName,
			metricUnit: args.metricUnit,
			direction: args.direction
		}) }),
		run: async (args) => ({ result: await deps.runExperiment({
			cwd: args.cwd,
			command: args.command,
			timeoutSeconds: args.timeoutSeconds,
			checksCommand: args.checksCommand,
			checksTimeoutSeconds: args.checksTimeoutSeconds,
			checksPolicy: args.checksPolicy
		}) }),
		next: async (args) => ({ result: await deps.nextExperiment({
			cwd: args.cwd,
			command: args.command,
			compact: args.compact,
			timeoutSeconds: args.timeoutSeconds,
			checksCommand: args.checksCommand,
			checksTimeoutSeconds: args.checksTimeoutSeconds,
			checksPolicy: args.checksPolicy
		}) }),
		log: async (args) => ({ result: await deps.logExperiment({
			cwd: args.cwd,
			commit: args.commit,
			metric: args.metric,
			status: args.status,
			description: args.description,
			metrics: deps.parseJsonOption(args.metrics, null),
			asi: deps.parseJsonOption(args.asi, null),
			asiFile: args.asiFile,
			commitPaths: args.commitPaths,
			revertPaths: args.revertPaths,
			allowAddAll: args.allowAddAll,
			allowDirtyRevert: args.allowDirtyRevert,
			fromLast: args.fromLast
		}) }),
		state: async (args) => ({ result: await deps.publicState({
			cwd: args.cwd,
			compact: args.compact
		}) }),
		doctor: async (args) => ({ result: await (args._[1] === "hooks" || args.hooks ? deps.doctorHooks({ cwd: args.cwd }) : deps.doctorSession({
			cwd: args.cwd,
			command: args.command,
			checkBenchmark: args.checkBenchmark,
			checkInstalled: args.checkInstalled,
			explain: args.explain,
			timeoutSeconds: args.timeoutSeconds
		})) }),
		"benchmark-lint": async (args) => ({ result: await deps.benchmarkLint({
			cwd: args.cwd,
			metricName: args.metricName,
			sample: args.sample,
			command: args.command,
			timeoutSeconds: args.timeoutSeconds
		}) }),
		"benchmark-inspect": async (args) => ({ result: await deps.benchmarkInspect({
			cwd: args.cwd,
			command: args.command,
			timeoutSeconds: args.timeoutSeconds
		}) }),
		"checks-inspect": async (args) => ({ result: await deps.checksInspect({
			cwd: args.cwd,
			command: args.command || args.checksCommand,
			timeoutSeconds: args.timeoutSeconds
		}) }),
		"new-segment": async (args) => ({ result: await deps.newSegment({
			cwd: args.cwd,
			reason: args.reason,
			dryRun: args.dryRun,
			yes: args.yes,
			confirm: args.confirm
		}) }),
		"promote-gate": async (args) => ({ result: await deps.promoteGate({
			cwd: args.cwd,
			reason: args.reason,
			gateName: args.gateName,
			queryCount: args.queryCount,
			benchmarkCommand: args.benchmarkCommand,
			checksCommand: args.checksCommand,
			notes: args.notes,
			dryRun: args.dryRun,
			yes: args.yes,
			confirm: args.confirm
		}) }),
		export: async (args) => ({ result: await deps.exportDashboard({
			cwd: args.cwd,
			output: args.output,
			showcase: args.showcase,
			showcaseMode: args.showcaseMode,
			jsonFull: args.jsonFull,
			verbose: args.verbose
		}) }),
		clear: async (args) => ({ result: await deps.clearSession({
			cwd: args.cwd,
			yes: args.yes,
			confirm: args.confirm,
			dryRun: args.dryRun
		}) })
	});
}
function normalizeCliHandlers(handlers) {
	return Object.fromEntries(Object.entries(handlers).map(([command, handler]) => [command, (args) => handler(normalizeCliCommandArguments(command, args))]));
}
async function runCliCommand(command, args, handlers) {
	const handler = handlers[command];
	if (!handler) throw new Error(`Unknown command: ${command}`);
	return await handler(args);
}
async function serveCommand(args, deps) {
	const resolved = deps.resolveWorkDir(args.cwd);
	let liveUrl = "";
	const runtimeDrift = deps.buildDriftReport ? await deps.buildDriftReport({
		pluginRoot: deps.pluginRoot,
		includeInstalled: true
	}).catch((error) => ({
		ok: false,
		warnings: [error.message]
	})) : null;
	const serveResult = await deps.serveAutoresearch({
		cwd: resolved.workDir,
		port: args.port,
		scriptPath: path.join(deps.pluginRoot, "scripts", "autoresearch.mjs"),
		dashboardHtml: async ({ actionNonce, actionNonceHeader } = {}) => {
			const { workDir, config } = deps.resolveWorkDir(args.cwd);
			const entries = deps.readJsonl(workDir);
			const commands = deps.dashboardCommands(workDir);
			const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
			const dashboardContext = {
				deliveryMode: "live-server",
				liveUrl,
				generatedAt,
				sourceCwd: workDir,
				pluginVersion: deps.pluginVersion || "unknown",
				runtimeDrift
			};
			return deps.dashboardHtml(entries, {
				workDir,
				generatedAt,
				jsonlName: "autoresearch.jsonl",
				deliveryMode: "live-server",
				liveRefreshAvailable: true,
				liveActionsAvailable: false,
				actionNonce,
				actionNonceHeader,
				modeGuidance: {
					title: "Live dashboard",
					detail: "Live refresh is available; actions stay in CLI or MCP."
				},
				refreshMs: Math.max(1, Number(config.dashboardRefreshSeconds || 5)) * 1e3,
				commands,
				settings: deps.dashboardSettings(config, dashboardContext),
				viewModel: await deps.dashboardViewModel(workDir, config, dashboardContext)
			});
		},
		viewModel: async () => {
			const { workDir, config } = deps.resolveWorkDir(args.cwd);
			return deps.dashboardViewModel(workDir, config, {
				deliveryMode: "live-server",
				liveUrl,
				generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				sourceCwd: workDir,
				pluginVersion: deps.pluginVersion || "unknown",
				runtimeDrift
			});
		}
	});
	liveUrl = serveResult.url;
	const health = await verifyLiveDashboardUrl(liveUrl);
	return {
		keepAlive: true,
		result: {
			ok: true,
			workDir: serveResult.workDir,
			port: serveResult.port,
			url: serveResult.url,
			verified: health.ok,
			healthUrl: health.url,
			checkedAt: health.checkedAt,
			modeGuidance: {
				deliveryMode: "live-server",
				difference: health.ok ? "This served URL was liveness-checked for live refresh; use CLI or MCP for actions, while exported file:// dashboards remain read-only snapshots." : `Dashboard server started but liveness check failed: ${health.error}. Restart serve before handing this URL to a user.`
			}
		}
	};
}
async function verifyLiveDashboardUrl(url) {
	const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
	const healthUrl = new URL("health", url).toString();
	try {
		const response = await fetch(healthUrl);
		if (!response.ok) return {
			ok: false,
			url: healthUrl,
			checkedAt,
			error: `GET /health returned ${response.status}`
		};
		const payload = await response.json().catch(() => null);
		return {
			ok: payload?.ok === true,
			url: healthUrl,
			checkedAt,
			error: payload?.ok === true ? "" : "GET /health did not return ok=true"
		};
	} catch (error) {
		return {
			ok: false,
			url: healthUrl,
			checkedAt,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
//#endregion
export { createCliCommandHandlers, runCliCommand };
