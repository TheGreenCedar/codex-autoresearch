type LooseObject = Record<string, any>;
export type ActionPolicy =
  | "read"
  | "preview"
  | "artifact_write"
  | "state_mutation"
  | "git_mutation"
  | "process_start"
  | "destructive"
  | "unsafe_open_world";

export const COMMAND_ARGUMENT_FIELDS = [
  "command",
  "benchmark_command",
  "benchmarkCommand",
  "checks_command",
  "checksCommand",
  "model_command",
  "modelCommand",
];

const TOOL_REGISTRY = [
  { name: "setup_plan", cliCommand: "setup-plan", actionPolicy: "read" },
  { name: "guided_setup", cliCommand: "guide", actionPolicy: "read" },
  { name: "prompt_plan", cliCommand: "prompt-plan", actionPolicy: "read" },
  { name: "onboarding_packet", cliCommand: "onboarding-packet", actionPolicy: "read" },
  { name: "recommend_next", cliCommand: "recommend-next", actionPolicy: "read" },
  { name: "codex_goal_bridge", cliCommand: "codex-goal-brief", actionPolicy: "read" },
  { name: "session_forensics", cliCommand: "session-forensics", actionPolicy: "read" },
  { name: "list_recipes", cliCommand: "recipes", actionPolicy: "read" },
  { name: "setup_session", cliCommand: "setup", actionPolicy: "state_mutation" },
  { name: "setup_research_session", cliCommand: "research-setup", actionPolicy: "state_mutation" },
  { name: "research_fanout", cliCommand: "research-fanout", actionPolicy: "read" },
  { name: "lane_runner", cliCommand: "lane-runner", actionPolicy: "read" },
  { name: "configure_session", cliCommand: "config", actionPolicy: "state_mutation" },
  { name: "init_experiment", cliCommand: "init", actionPolicy: "state_mutation" },
  { name: "run_experiment", cliCommand: "run", actionPolicy: "process_start" },
  { name: "next_experiment", cliCommand: "next", actionPolicy: "process_start" },
  { name: "partial_results", cliCommand: "partial-results", actionPolicy: "read" },
  { name: "log_experiment", cliCommand: "log", actionPolicy: "git_mutation" },
  { name: "read_state", cliCommand: "state", actionPolicy: "read" },
  { name: "measure_quality_gap", cliCommand: "quality-gap", actionPolicy: "read" },
  { name: "gap_candidates", cliCommand: "gap-candidates", actionPolicy: "preview" },
  { name: "finalize_preview", cliCommand: "finalize-preview", actionPolicy: "read" },
  {
    name: "finalize_current_tree",
    cliCommand: "finalize-current-tree",
    actionPolicy: "artifact_write",
  },
  { name: "integrations", cliCommand: "integrations", actionPolicy: "read" },
  { name: "benchmark_inspect", cliCommand: "benchmark-inspect", actionPolicy: "read" },
  { name: "checks_inspect", cliCommand: "checks-inspect", actionPolicy: "read" },
  { name: "benchmark_lint", cliCommand: "benchmark-lint", actionPolicy: "read" },
  { name: "new_segment", cliCommand: "new-segment", actionPolicy: "state_mutation" },
  { name: "promote_gate", cliCommand: "promote-gate", actionPolicy: "state_mutation" },
  { name: "export_dashboard", cliCommand: "export", actionPolicy: "artifact_write" },
  { name: "serve_dashboard", cliCommand: "serve", actionPolicy: "process_start" },
  { name: "doctor_session", cliCommand: "doctor", actionPolicy: "read" },
  { name: "clear_session", cliCommand: "clear", actionPolicy: "destructive" },
];

export const toolRegistry = Object.freeze(
  Object.fromEntries(TOOL_REGISTRY.map((tool) => [tool.name, Object.freeze({ ...tool })])),
);

export const toolNames = Object.freeze(TOOL_REGISTRY.map((tool) => tool.name));

const toolNameByCliCommand: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(TOOL_REGISTRY.map((tool) => [tool.cliCommand, tool.name])),
);

export function toolMetadata(name: string): LooseObject | null {
  return toolRegistry[name] || null;
}

export function toolMutates(name: string): boolean {
  return actionPolicyMutates(actionPolicyForTool(name));
}

export function actionPolicyForTool(name: string, args: LooseObject = {}): ActionPolicy {
  const base = (toolMetadata(name)?.actionPolicy || "read") as ActionPolicy;
  if (name === "gap_candidates" && enabledArg(args.apply)) {
    return "state_mutation";
  }
  if (name === "session_forensics" && enabledArg(args.apply)) {
    return "artifact_write";
  }
  if (name === "research_fanout" && enabledArg(args.yes)) {
    return "state_mutation";
  }
  if (name === "lane_runner" && (args.command || enabledArg(args.yes))) {
    return args.command ? "process_start" : "state_mutation";
  }
  if (name === "partial_results" && enabledArg(args.record)) return "artifact_write";
  if (
    name === "guided_setup" &&
    (enabledArg(args.start_dashboard) || enabledArg(args.startDashboard))
  ) {
    return "process_start";
  }
  if (
    name === "doctor_session" &&
    (enabledArg(args.check_benchmark) || enabledArg(args.checkBenchmark))
  ) {
    return "process_start";
  }
  if (name === "benchmark_inspect" && args.command) return "process_start";
  if (name === "checks_inspect" && (args.command || args.checks_command || args.checksCommand))
    return "process_start";
  if (name === "benchmark_lint" && !args.sample && !args.sampleText && !args.sample_text) {
    return "process_start";
  }
  if (name === "new_segment" && (enabledArg(args.dry_run) || enabledArg(args.dryRun))) {
    return "preview";
  }
  if (name === "promote_gate" && (enabledArg(args.dry_run) || enabledArg(args.dryRun))) {
    return "preview";
  }
  return base;
}

export function actionPolicyMutates(policy: ActionPolicy): boolean {
  return [
    "artifact_write",
    "state_mutation",
    "git_mutation",
    "process_start",
    "destructive",
  ].includes(policy);
}

export function cliCommandForTool(name: string): string | null {
  return toolMetadata(name)?.cliCommand || null;
}

export function toolNameForCliCommand(command: string): string | null {
  return toolNameByCliCommand[command] || null;
}

export function unsafeCommandFieldsForArgs(args: LooseObject = {}) {
  return COMMAND_ARGUMENT_FIELDS.filter((field) => args?.[field] != null && args[field] !== "");
}

export function validateToolRegistry(schemaTools: Array<{ name: string }>) {
  const schemaNames = schemaTools.map((tool) => tool.name).sort();
  const registryNames = [...toolNames].sort();
  const missingRegistry = schemaNames.filter((name) => !toolRegistry[name]);
  const missingSchema = registryNames.filter((name) => !schemaNames.includes(name));
  return {
    ok: missingRegistry.length === 0 && missingSchema.length === 0,
    missingRegistry,
    missingSchema,
  };
}

function enabledArg(value: unknown): boolean {
  if (value == null || value === false) return false;
  if (typeof value === "string") return !["", "0", "false", "no"].includes(value.toLowerCase());
  return true;
}
