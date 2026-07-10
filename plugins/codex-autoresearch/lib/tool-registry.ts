import { type UnknownRecord } from "./types/json.js";

type LooseObject = UnknownRecord;
export type ActionPolicy =
  | "read"
  | "preview"
  | "artifact_write"
  | "state_mutation"
  | "git_mutation"
  | "process_start"
  | "destructive"
  | "unsafe_open_world";
export type CommandCategory =
  | "happy_path"
  | "setup"
  | "diagnostic"
  | "advanced"
  | "integration"
  | "dangerous";
export type CommandAudience = "default" | "advanced" | "maintainer";

export interface ToolRegistryEntry {
  actionPolicy: ActionPolicy;
  actionAliases?: Readonly<Record<string, string>>;
  audience: CommandAudience;
  category: CommandCategory;
  cliCommand: string;
  conditionallyMutating?: boolean;
  name: string;
  openWorld?: boolean;
}

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
  registryEntry("setup_plan", "setup-plan", "read", "setup", "default"),
  registryEntry("guided_setup", "guide", "read", "setup", "default", {
    conditionallyMutating: true,
    openWorld: true,
  }),
  registryEntry("prompt_plan", "prompt-plan", "read", "setup", "default"),
  registryEntry("onboarding_packet", "onboarding-packet", "read", "setup", "default"),
  registryEntry("recommend_next", "recommend-next", "read", "diagnostic", "default"),
  registryEntry("codex_goal_bridge", "codex-goal-brief", "read", "integration", "advanced"),
  registryEntry("session_forensics", "session-forensics", "read", "diagnostic", "advanced", {
    conditionallyMutating: true,
  }),
  registryEntry("list_recipes", "recipes", "read", "setup", "advanced"),
  registryEntry("setup_session", "setup", "state_mutation", "happy_path", "default"),
  registryEntry(
    "setup_research_session",
    "research-setup",
    "state_mutation",
    "advanced",
    "advanced",
  ),
  registryEntry("start_research_loop", "research-start", "process_start", "happy_path", "default"),
  registryEntry("research_fanout", "research-fanout", "read", "advanced", "advanced", {
    conditionallyMutating: true,
  }),
  registryEntry("lane_runner", "lane-runner", "read", "advanced", "advanced", {
    conditionallyMutating: true,
    openWorld: true,
  }),
  registryEntry("configure_session", "config", "state_mutation", "advanced", "advanced"),
  registryEntry("init_experiment", "init", "state_mutation", "advanced", "maintainer"),
  registryEntry("run_experiment", "run", "process_start", "advanced", "advanced"),
  registryEntry("next_experiment", "next", "process_start", "happy_path", "default"),
  registryEntry("partial_results", "partial-results", "read", "diagnostic", "advanced", {
    conditionallyMutating: true,
  }),
  registryEntry("log_experiment", "log", "git_mutation", "happy_path", "default"),
  registryEntry("read_state", "state", "read", "happy_path", "default"),
  registryEntry("ledger_doctor", "ledger-doctor", "read", "diagnostic", "default", {
    conditionallyMutating: true,
  }),
  registryEntry("measure_quality_gap", "quality-gap", "read", "diagnostic", "advanced"),
  registryEntry("gap_candidates", "gap-candidates", "preview", "diagnostic", "advanced", {
    conditionallyMutating: true,
    openWorld: true,
  }),
  registryEntry("finalize_preview", "finalize-preview", "read", "happy_path", "default"),
  {
    name: "finalize_current_tree",
    cliCommand: "finalize-current-tree",
    actionPolicy: "artifact_write",
    category: "dangerous",
    audience: "advanced",
  },
  registryEntry("integrations", "integrations", "read", "integration", "advanced", {
    conditionallyMutating: true,
  }),
  registryEntry("benchmark_inspect", "benchmark-inspect", "read", "diagnostic", "advanced", {
    conditionallyMutating: true,
    openWorld: true,
  }),
  registryEntry("checks_inspect", "checks-inspect", "read", "diagnostic", "advanced", {
    conditionallyMutating: true,
    openWorld: true,
  }),
  registryEntry("benchmark_lint", "benchmark-lint", "read", "diagnostic", "default", {
    conditionallyMutating: true,
    openWorld: true,
  }),
  registryEntry("new_segment", "new-segment", "state_mutation", "advanced", "advanced", {
    actionAliases: { newSegmentDryRun: "new segment" },
  }),
  registryEntry("promote_gate", "promote-gate", "state_mutation", "advanced", "advanced", {
    actionAliases: { promoteGateDryRun: "promote gate" },
  }),
  registryEntry("export_dashboard", "export", "artifact_write", "advanced", "advanced"),
  registryEntry("serve_dashboard", "serve", "process_start", "advanced", "advanced", {
    actionAliases: { liveDashboard: "serve dashboard" },
  }),
  registryEntry("doctor_session", "doctor", "read", "happy_path", "default", {
    actionAliases: { doctorExplain: "doctor" },
    conditionallyMutating: true,
    openWorld: true,
  }),
  registryEntry("clear_session", "clear", "destructive", "dangerous", "maintainer"),
] satisfies ToolRegistryEntry[];

export const toolRegistry = Object.freeze(
  Object.fromEntries(TOOL_REGISTRY.map((tool) => [tool.name, Object.freeze({ ...tool })])),
);

export const toolNames = Object.freeze(TOOL_REGISTRY.map((tool) => tool.name));

export const commandActionAliases: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(TOOL_REGISTRY.flatMap((tool) => Object.entries(tool.actionAliases || {}))),
);

const toolNameByCliCommand: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(TOOL_REGISTRY.map((tool) => [tool.cliCommand, tool.name])),
);

export function toolMetadata(name: string): ToolRegistryEntry | null {
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
  if (
    name === "integrations" &&
    String(args.subcommand || args.command || "").toLowerCase() === "sync-recipes"
  ) {
    return "artifact_write";
  }
  if (name === "partial_results" && enabledArg(args.record)) return "artifact_write";
  if (name === "ledger_doctor" && enabledArg(args.repair)) return "artifact_write";
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

function registryEntry(
  name: string,
  cliCommand: string,
  actionPolicy: ActionPolicy,
  category: CommandCategory,
  audience: CommandAudience,
  options: Pick<ToolRegistryEntry, "actionAliases" | "conditionallyMutating" | "openWorld"> = {},
): ToolRegistryEntry {
  return { name, cliCommand, actionPolicy, category, audience, ...options };
}
