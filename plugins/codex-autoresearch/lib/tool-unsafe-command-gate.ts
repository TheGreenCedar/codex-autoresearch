type SchemaLike = {
  properties?: Record<string, unknown>;
};

export const TOOL_STYLE_UNSAFE_COMMAND_GATE =
  "Tool-call custom command fields require allow_unsafe_command=true; direct CLI commands intentionally preserve existing shell-command behavior.";

export const UNSAFE_COMMAND_APPROVAL_FIELD = "allow_unsafe_command";

export const UNSAFE_COMMAND_ARGUMENT_FIELDS = [
  "benchmark_command",
  "checks_command",
  "command",
  "command_file",
  "env_file",
  "model_command",
  "packet_env_file",
] as const;

export const UNSAFE_COMMAND_PROPERTY = {
  allow_unsafe_command: { type: "boolean" },
} as const;

const SETUP_CATALOG_COMMAND_TOOLS = new Set([
  "setup_plan",
  "guided_setup",
  "prompt_plan",
  "setup_session",
]);

export function toolSchemaRequiresUnsafeCommandGate(
  toolName: string,
  schema: SchemaLike | null | undefined,
): boolean {
  const properties = schema?.properties || {};
  return Boolean(
    UNSAFE_COMMAND_ARGUMENT_FIELDS.some((field) => hasOwn(properties, field)) ||
    (SETUP_CATALOG_COMMAND_TOOLS.has(toolName) && hasOwn(properties, "catalog")),
  );
}

export function toolArgumentsContainUnsafeCommand(toolName: string, args: Record<string, unknown>) {
  return Boolean(
    UNSAFE_COMMAND_ARGUMENT_FIELDS.some((field) => hasArgumentValue(args[field])) ||
    (SETUP_CATALOG_COMMAND_TOOLS.has(toolName) && hasArgumentValue(args.catalog)),
  );
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasArgumentValue(value: unknown): boolean {
  return value != null && value !== "";
}
