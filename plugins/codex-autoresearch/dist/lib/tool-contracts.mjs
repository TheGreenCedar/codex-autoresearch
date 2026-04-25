import { actionPolicyForTool } from "./tool-registry.mjs";
//#region lib/tool-contracts.ts
const CONTRACTS = {
	setup_plan: {
		purpose: "Read-only setup readiness and first-run command plan.",
		whenToUse: "Use before creating files or when the operator needs missing fields and recipe guidance.",
		contrast: "Use setup_session to actually create files.",
		safety: "Never mutates the project.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"missing",
			"recommendedRecipe",
			"guidedFlow"
		])
	},
	guided_setup: {
		purpose: "Return a complete first-run or resume action packet.",
		whenToUse: "Use when an operator asks what to do next from an existing or new session.",
		contrast: "Use setup_plan for read-only setup fields without resume state.",
		safety: "Read-only.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"stage",
			"commands",
			"nextAction"
		])
	},
	prompt_plan: {
		purpose: "Convert a natural-language request into an Autoresearch loop plan.",
		whenToUse: "Use when the user gives a broad goal before benchmark details are known.",
		contrast: "Use setup_plan when the metric and benchmark inputs are already explicit.",
		safety: "Read-only.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"intent",
			"setup",
			"nextAction"
		])
	},
	onboarding_packet: {
		purpose: "Return a compact resume packet for a new human or AI operator.",
		whenToUse: "Use at the start of a turn or handoff before reading the full docs.",
		contrast: "Use read_state for raw state or guided_setup for setup-only flow.",
		safety: "Read-only.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"protocol",
			"nextAction",
			"templates"
		])
	},
	recommend_next: {
		purpose: "Return the single safest next action and its evidence.",
		whenToUse: "Use when the operator asks what to do now or an agent needs one next command.",
		contrast: "Use onboarding_packet for broader handoff context.",
		safety: "Read-only.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"action",
			"whySafe",
			"commands"
		])
	},
	list_recipes: {
		purpose: "List or recommend built-in and catalog benchmark recipes.",
		whenToUse: "Use when choosing or explaining a benchmark starting point.",
		contrast: "Use setup_plan to see a recommendation for one project.",
		safety: "Read-only.",
		outputSchema: basicOutputSchema(["ok", "recipes"])
	},
	setup_session: {
		purpose: "Create session files and metric config.",
		whenToUse: "Use after setup_plan has enough inputs or a recipe supplies defaults.",
		contrast: "Use setup_research_session for qualitative research quality_gap loops.",
		safety: "Writes session artifacts and may initialize autoresearch.jsonl.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"files",
			"init"
		])
	},
	setup_research_session: {
		purpose: "Create a deep-research scratchpad and quality_gap loop.",
		whenToUse: "Use for broad project study or source-backed recommendations.",
		contrast: "Use setup_session for direct numeric benchmark loops.",
		safety: "Writes research scratchpad and session artifacts.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"slug",
			"qualityGap"
		])
	},
	configure_session: {
		purpose: "Update runtime settings such as autonomy mode, policies, paths, and limits.",
		whenToUse: "Use to tune an existing session without recreating it.",
		contrast: "Use setup_session to create a new session.",
		safety: "Writes autoresearch.config.json.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"config",
			"updates"
		])
	},
	init_experiment: {
		purpose: "Append a new metric config segment to autoresearch.jsonl.",
		whenToUse: "Use when changing the primary metric or starting a new segment.",
		contrast: "Use setup_session for initial file bootstrap.",
		safety: "Appends config to the run log.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"config"
		])
	},
	run_experiment: {
		purpose: "Run only the benchmark/check packet.",
		whenToUse: "Use when you need raw benchmark output without preflight or continuation.",
		contrast: "Use next_experiment for the normal loop packet.",
		safety: "Runs configured commands but does not log results.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"parsedMetrics",
			"logHint"
		])
	},
	next_experiment: {
		purpose: "Run preflight plus benchmark and produce the log decision packet.",
		whenToUse: "Use for the normal measured loop iteration.",
		contrast: "Use run_experiment only for low-level benchmark probing.",
		safety: "Runs commands and writes the last-run packet, but does not log keep/discard.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"doctor",
			"run",
			"decision",
			"continuation"
		])
	},
	log_experiment: {
		purpose: "Record a keep/discard/crash/checks_failed decision.",
		whenToUse: "Use after next_experiment, preferably with from_last.",
		contrast: "Use next_experiment before this to create a decision packet.",
		safety: "Can commit kept changes or revert scoped discarded changes.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"experiment",
			"continuation"
		])
	},
	read_state: {
		purpose: "Summarize current run state and continuation.",
		whenToUse: "Use to resume, inspect progress, or feed dashboards.",
		contrast: "Use doctor_session for readiness checks.",
		safety: "Read-only.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"runs",
			"best",
			"warnings",
			"memory"
		])
	},
	measure_quality_gap: {
		purpose: "Measure open and closed research checklist gaps.",
		whenToUse: "Use as the benchmark for qualitative research loops.",
		contrast: "Use gap_candidates to extract new candidate checklist items.",
		safety: "Read-only.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"open",
			"closed",
			"openItems"
		])
	},
	gap_candidates: {
		purpose: "Preview or apply source-backed quality-gap candidates.",
		whenToUse: "Use after synthesis contains recommendations.",
		contrast: "Use measure_quality_gap to count the current checklist.",
		safety: "Preview is read-only; apply mutates quality-gaps.md.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"candidates",
			"qualityGap",
			"stopRecommended",
			"stopStatus"
		])
	},
	finalize_preview: {
		purpose: "Preview review-branch readiness without creating branches.",
		whenToUse: "Use before finalizing kept autoresearch work into review branches.",
		contrast: "Use the finalizer command to create review branches.",
		safety: "Read-only.",
		outputSchema: basicOutputSchema([
			"ok",
			"ready",
			"warnings",
			"nextAction"
		])
	},
	integrations: {
		purpose: "Inspect additive catalogs and model-command integrations.",
		whenToUse: "Use to list, doctor, or sync recipe catalogs.",
		contrast: "Use list_recipes for the current recipe list only.",
		safety: "May write synced catalog state for sync-recipes.",
		outputSchema: basicOutputSchema(["ok"])
	},
	benchmark_inspect: {
		purpose: "Inspect a bounded benchmark probe before a full packet.",
		whenToUse: "Use before benchmark_lint or next_experiment when a list/dry-run/artifact command might prevent an accidental full run.",
		contrast: "Use benchmark_lint to validate METRIC parsing after the probe is known bounded.",
		safety: "Read-only unless a command is explicitly provided; command execution is gated over MCP.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"warnings",
			"hints",
			"outputPreview"
		])
	},
	benchmark_lint: {
		purpose: "Validate benchmark METRIC output without starting a loop.",
		whenToUse: "Use before setup, doctor, or next when the benchmark contract is uncertain.",
		contrast: "Use run_experiment or next_experiment to execute the actual loop packet.",
		safety: "Read-only unless a command is explicitly provided; command execution is gated over MCP.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"issues",
			"parsedMetrics"
		])
	},
	checks_inspect: {
		purpose: "Classify correctness-check command failures before logging a decision.",
		whenToUse: "Use when a checks command fails, looks broad, or may be malformed before treating it as experiment evidence.",
		contrast: "Use benchmark_inspect for metric-producing commands.",
		safety: "Read-only unless a command is explicitly provided; command execution is gated over MCP.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"failedTests",
			"warnings",
			"hints"
		])
	},
	new_segment: {
		purpose: "Start a fresh session segment while preserving old ledger history.",
		whenToUse: "Use when a session is maxed, stale, or intentionally changing phase.",
		contrast: "Use clear_session only when deleting artifacts is intended.",
		safety: "Dry-run is read-only; confirmed run appends a config entry.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"dryRun",
			"entry"
		])
	},
	promote_gate: {
		purpose: "Preview or append a promoted measurement gate as a fresh segment.",
		whenToUse: "Use when moving from exploration to a stronger measurement contract.",
		contrast: "Use new_segment for a generic phase reset without measurement-gate metadata.",
		safety: "Dry-run is read-only; confirmed run appends a config entry.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"dryRun",
			"entry"
		])
	},
	export_dashboard: {
		purpose: "Write the self-contained fallback dashboard HTML.",
		whenToUse: "Use only when an offline snapshot is needed; pass full=true only when the full viewModel is needed.",
		contrast: "Use serve_dashboard for the normal live operator dashboard.",
		safety: "Writes dashboard HTML inside the workdir.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"output",
			"summary",
			"best",
			"nextAction",
			"modeGuidance"
		])
	},
	serve_dashboard: {
		purpose: "Start the live local dashboard and return its URL.",
		whenToUse: "Use after setup or resume before running experiments so the operator gets the live link.",
		contrast: "Use export_dashboard only for an offline fallback snapshot.",
		safety: "Starts a local server bound to 127.0.0.1.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"url",
			"modeGuidance"
		])
	},
	doctor_session: {
		purpose: "Check readiness, git state, benchmark metrics, and version drift.",
		whenToUse: "Use before next or when a session behaves surprisingly.",
		contrast: "Use read_state for a lighter summary.",
		safety: "Read-only unless benchmark check runs configured commands.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"issues",
			"warnings",
			"drift"
		])
	},
	clear_session: {
		purpose: "Preview or delete session artifacts after confirmation.",
		whenToUse: "Use dry_run first to preview targets; use confirmed clear only when the operator explicitly wants to clear a session.",
		contrast: "Use off/stop behavior to pause without deleting files.",
		safety: "Dry-run is read-only; destructive clear requires confirmation.",
		outputSchema: basicOutputSchema([
			"ok",
			"workDir",
			"dryRun",
			"wouldDelete",
			"deleted",
			"missing"
		])
	}
};
const READ_ONLY_TOOLS = new Set([
	"setup_plan",
	"guided_setup",
	"prompt_plan",
	"onboarding_packet",
	"recommend_next",
	"list_recipes",
	"read_state",
	"measure_quality_gap",
	"finalize_preview"
]);
const DESTRUCTIVE_TOOLS = new Set(["log_experiment", "clear_session"]);
const CONDITIONALLY_OPEN_WORLD_TOOLS = new Set([
	"benchmark_inspect",
	"benchmark_lint",
	"checks_inspect",
	"doctor_session",
	"gap_candidates"
]);
function applyToolContracts(toolSchemas) {
	return toolSchemas.map((tool) => {
		const contract = CONTRACTS[tool.name];
		if (!contract) return tool;
		return {
			...tool,
			description: `${contract.purpose} Use when: ${contract.whenToUse} Contrast: ${contract.contrast}`,
			outputSchema: contract.outputSchema,
			annotations: {
				...tool.annotations,
				...toolHintAnnotations(tool.name),
				safety: contract.safety
			}
		};
	});
}
function validateToolContracts(toolSchemas) {
	const issues = [];
	for (const tool of toolSchemas) {
		const contract = CONTRACTS[tool.name];
		if (!contract) {
			issues.push(`${tool.name}: missing contract`);
			continue;
		}
		for (const field of [
			"purpose",
			"whenToUse",
			"contrast",
			"safety",
			"outputSchema"
		]) if (!contract[field]) issues.push(`${tool.name}: missing ${field}`);
		if (String(tool.description || "").length > 280) issues.push(`${tool.name}: description is too long`);
	}
	return {
		ok: issues.length === 0,
		issues
	};
}
function toolGuidanceFor(name) {
	return CONTRACTS[name] || null;
}
function outputContractFor(name) {
	return CONTRACTS[name]?.outputSchema || null;
}
function toolHintAnnotations(name) {
	const readOnly = READ_ONLY_TOOLS.has(name);
	const openWorld = actionPolicyForTool(name) === "process_start" || CONDITIONALLY_OPEN_WORLD_TOOLS.has(name);
	return {
		title: humanizeToolName(name),
		readOnlyHint: readOnly,
		destructiveHint: DESTRUCTIVE_TOOLS.has(name),
		idempotentHint: readOnly,
		openWorldHint: openWorld
	};
}
function humanizeToolName(name) {
	return String(name).split("_").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ");
}
function basicOutputSchema(required) {
	const properties = Object.fromEntries(required.map((field) => [field, schemaForOutputField(field)]));
	return {
		type: "object",
		required: required.filter((field) => field === "ok" || field === "workDir"),
		properties,
		additionalProperties: true
	};
}
function outputFieldSchemas() {
	return {
		action: stringSchema("Safe next action summary."),
		best: objectSchema("Best kept run summary."),
		candidates: arraySchema(objectSchema("Candidate quality-gap item."), "Candidate items."),
		checkedAt: stringSchema("ISO timestamp for a liveness check."),
		closed: numberSchema("Closed quality-gap item count."),
		commands: arraySchema(stringSchema("Command line."), "Copyable command list."),
		config: objectSchema("Autoresearch session config."),
		continuation: objectSchema("Active-loop continuation contract."),
		decision: objectSchema("Allowed logging decision packet."),
		deleted: arraySchema(stringSchema("Deleted artifact path."), "Deleted artifact paths."),
		doctor: objectSchema("Doctor readiness result."),
		drift: objectSchema("Runtime/source drift report."),
		dryRun: booleanSchema("Whether the mutation was previewed only."),
		entry: objectSchema("Ledger/config entry."),
		experiment: objectSchema("Logged experiment entry."),
		failedTests: arraySchema(stringSchema("Failed test or check."), "Failed tests or checks."),
		files: arraySchema(stringSchema("Created or touched file path."), "Created or touched files."),
		finalizePreview: objectSchema("Finalization readiness preview."),
		guidedFlow: arraySchema(objectSchema("Guided workflow step."), "Guided workflow steps."),
		healthUrl: stringSchema("Dashboard health-check URL."),
		hints: arraySchema(stringSchema("Operator hint."), "Operator hints."),
		init: objectSchema("Initial ledger entry result."),
		intent: objectSchema("Inferred prompt intent."),
		issues: arraySchema(stringSchema("Validation or readiness issue."), "Issues."),
		logHint: objectSchema("Suggested log command or payload."),
		memory: objectSchema("Experiment memory summary."),
		missing: arraySchema(stringSchema("Missing required setup field."), "Missing setup fields."),
		modeGuidance: objectSchema("Dashboard mode guidance."),
		nextAction: stringSchema("Recommended next operator action."),
		ok: booleanSchema("True when the tool completed successfully."),
		open: numberSchema("Open quality-gap item count."),
		openItems: arraySchema(stringSchema("Open quality-gap item."), "Open quality-gap items."),
		output: stringSchema("Output file path or command output."),
		outputPreview: stringSchema("Bounded command output preview."),
		parsedMetrics: objectSchema("Parsed METRIC values keyed by metric name."),
		port: numberSchema("Local dashboard port."),
		protocol: objectSchema("Operator protocol guidance."),
		qualityGap: objectSchema("Quality-gap scratchpad summary."),
		ready: booleanSchema("True when the preview is ready to apply."),
		recipes: arraySchema(objectSchema("Recipe summary."), "Available recipes."),
		recommendedRecipe: objectSchema("Recommended benchmark recipe."),
		run: objectSchema("Benchmark run packet."),
		runs: objectSchema("Run-count summary."),
		setup: objectSchema("Setup readiness packet."),
		slug: stringSchema("Research slug."),
		stage: stringSchema("Setup or resume stage."),
		stopRecommended: booleanSchema("True when candidate extraction recommends stopping."),
		stopStatus: stringSchema("Recommended stop status."),
		summary: objectSchema("Dashboard export summary."),
		templates: arraySchema(objectSchema("Report template."), "Report templates."),
		updates: arraySchema(stringSchema("Applied config update."), "Applied updates."),
		url: stringSchema("Served local dashboard URL."),
		verified: booleanSchema("True when the dashboard health check passed."),
		warnings: arraySchema(stringSchema("Warning message."), "Warnings."),
		whySafe: stringSchema("Evidence explaining why the next action is safe."),
		workDir: stringSchema("Resolved project working directory."),
		wouldDelete: arraySchema(stringSchema("Artifact path to delete."), "Previewed deletion targets.")
	};
}
function schemaForOutputField(field) {
	return outputFieldSchemas()[field] || {
		description: `${field} value.`,
		type: [
			"string",
			"number",
			"boolean",
			"object",
			"array",
			"null"
		]
	};
}
function stringSchema(description) {
	return {
		type: "string",
		description
	};
}
function numberSchema(description) {
	return {
		type: "number",
		description
	};
}
function booleanSchema(description) {
	return {
		type: "boolean",
		description
	};
}
function objectSchema(description) {
	return {
		type: "object",
		description,
		additionalProperties: true
	};
}
function arraySchema(items, description) {
	return {
		type: "array",
		description,
		items
	};
}
//#endregion
export { applyToolContracts, outputContractFor, toolGuidanceFor, validateToolContracts };
