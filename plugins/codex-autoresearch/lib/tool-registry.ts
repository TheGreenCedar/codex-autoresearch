type LooseObject = Record<string, any>;

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
  { name: "setup_plan", cliCommand: "setup-plan", mutates: false },
  { name: "guided_setup", cliCommand: "guide", mutates: false },
  { name: "list_recipes", cliCommand: "recipes", mutates: false },
  { name: "setup_session", cliCommand: "setup", mutates: true },
  { name: "setup_research_session", cliCommand: "research-setup", mutates: true },
  { name: "configure_session", cliCommand: "config", mutates: true },
  { name: "init_experiment", cliCommand: "init", mutates: true },
  { name: "run_experiment", cliCommand: "run", mutates: true },
  { name: "next_experiment", cliCommand: "next", mutates: true },
  { name: "log_experiment", cliCommand: "log", mutates: true },
  { name: "read_state", cliCommand: "state", mutates: false },
  { name: "measure_quality_gap", cliCommand: "quality-gap", mutates: false },
  { name: "gap_candidates", cliCommand: "gap-candidates", mutates: true },
  { name: "finalize_preview", cliCommand: "finalize-preview", mutates: false },
  { name: "integrations", cliCommand: "integrations", mutates: false },
  { name: "export_dashboard", cliCommand: "export", mutates: true },
  { name: "serve_dashboard", cliCommand: "serve", mutates: true },
  { name: "doctor_session", cliCommand: "doctor", mutates: false },
  { name: "clear_session", cliCommand: "clear", mutates: true },
];

export const toolRegistry = Object.freeze(
  Object.fromEntries(TOOL_REGISTRY.map((tool) => [tool.name, Object.freeze({ ...tool })])),
);

export const toolNames = Object.freeze(TOOL_REGISTRY.map((tool) => tool.name));

export function toolMetadata(name: string): LooseObject | null {
  return toolRegistry[name] || null;
}

export function toolMutates(name: string): boolean {
  return Boolean(toolMetadata(name)?.mutates);
}

export function cliCommandForTool(name: string): string | null {
  return toolMetadata(name)?.cliCommand || null;
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
