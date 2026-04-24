//#region lib/tool-registry.ts
const COMMAND_ARGUMENT_FIELDS = [
	"command",
	"benchmark_command",
	"benchmarkCommand",
	"checks_command",
	"checksCommand",
	"model_command",
	"modelCommand"
];
const TOOL_REGISTRY = [
	{
		name: "setup_plan",
		cliCommand: "setup-plan",
		actionPolicy: "read"
	},
	{
		name: "guided_setup",
		cliCommand: "guide",
		actionPolicy: "read"
	},
	{
		name: "prompt_plan",
		cliCommand: "prompt-plan",
		actionPolicy: "read"
	},
	{
		name: "onboarding_packet",
		cliCommand: "onboarding-packet",
		actionPolicy: "read"
	},
	{
		name: "recommend_next",
		cliCommand: "recommend-next",
		actionPolicy: "read"
	},
	{
		name: "list_recipes",
		cliCommand: "recipes",
		actionPolicy: "read"
	},
	{
		name: "setup_session",
		cliCommand: "setup",
		actionPolicy: "state_mutation"
	},
	{
		name: "setup_research_session",
		cliCommand: "research-setup",
		actionPolicy: "state_mutation"
	},
	{
		name: "configure_session",
		cliCommand: "config",
		actionPolicy: "state_mutation"
	},
	{
		name: "init_experiment",
		cliCommand: "init",
		actionPolicy: "state_mutation"
	},
	{
		name: "run_experiment",
		cliCommand: "run",
		actionPolicy: "process_start"
	},
	{
		name: "next_experiment",
		cliCommand: "next",
		actionPolicy: "process_start"
	},
	{
		name: "log_experiment",
		cliCommand: "log",
		actionPolicy: "git_mutation"
	},
	{
		name: "read_state",
		cliCommand: "state",
		actionPolicy: "read"
	},
	{
		name: "measure_quality_gap",
		cliCommand: "quality-gap",
		actionPolicy: "read"
	},
	{
		name: "gap_candidates",
		cliCommand: "gap-candidates",
		actionPolicy: "preview"
	},
	{
		name: "finalize_preview",
		cliCommand: "finalize-preview",
		actionPolicy: "read"
	},
	{
		name: "integrations",
		cliCommand: "integrations",
		actionPolicy: "read"
	},
	{
		name: "benchmark_lint",
		cliCommand: "benchmark-lint",
		actionPolicy: "read"
	},
	{
		name: "new_segment",
		cliCommand: "new-segment",
		actionPolicy: "state_mutation"
	},
	{
		name: "export_dashboard",
		cliCommand: "export",
		actionPolicy: "artifact_write"
	},
	{
		name: "serve_dashboard",
		cliCommand: "serve",
		actionPolicy: "process_start"
	},
	{
		name: "doctor_session",
		cliCommand: "doctor",
		actionPolicy: "read"
	},
	{
		name: "clear_session",
		cliCommand: "clear",
		actionPolicy: "destructive"
	}
];
const toolRegistry = Object.freeze(Object.fromEntries(TOOL_REGISTRY.map((tool) => [tool.name, Object.freeze({ ...tool })])));
const toolNames = Object.freeze(TOOL_REGISTRY.map((tool) => tool.name));
function toolMetadata(name) {
	return toolRegistry[name] || null;
}
function toolMutates(name) {
	return actionPolicyMutates(actionPolicyForTool(name));
}
function actionPolicyForTool(name, args = {}) {
	const base = toolMetadata(name)?.actionPolicy || "read";
	if (name === "gap_candidates" && (args.apply || args.apply === "true")) return "state_mutation";
	if (name === "doctor_session" && args.check_benchmark) return "process_start";
	if (name === "benchmark_lint" && args.command) return "process_start";
	return base;
}
function actionPolicyMutates(policy) {
	return [
		"artifact_write",
		"state_mutation",
		"git_mutation",
		"process_start",
		"destructive"
	].includes(policy);
}
function cliCommandForTool(name) {
	return toolMetadata(name)?.cliCommand || null;
}
function unsafeCommandFieldsForArgs(args = {}) {
	return COMMAND_ARGUMENT_FIELDS.filter((field) => args?.[field] != null && args[field] !== "");
}
function validateToolRegistry(schemaTools) {
	const schemaNames = schemaTools.map((tool) => tool.name).sort();
	const registryNames = [...toolNames].sort();
	const missingRegistry = schemaNames.filter((name) => !toolRegistry[name]);
	const missingSchema = registryNames.filter((name) => !schemaNames.includes(name));
	return {
		ok: missingRegistry.length === 0 && missingSchema.length === 0,
		missingRegistry,
		missingSchema
	};
}
//#endregion
export { COMMAND_ARGUMENT_FIELDS, actionPolicyForTool, actionPolicyMutates, cliCommandForTool, toolMetadata, toolMutates, toolNames, toolRegistry, unsafeCommandFieldsForArgs, validateToolRegistry };
