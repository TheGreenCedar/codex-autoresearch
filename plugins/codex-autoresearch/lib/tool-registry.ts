import {
  commandDefinitionForCli,
  commandDefinitionForTool,
  commandTable,
  type ActionPolicy,
  type CommandAudience,
  type CommandCategory,
} from "./command-table.js";
import { type UnknownRecord } from "./types/json.js";

type LooseObject = UnknownRecord;
export type { ActionPolicy, CommandAudience, CommandCategory } from "./command-table.js";

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

export const toolRegistry: Readonly<Record<string, ToolRegistryEntry>> = Object.freeze(
  Object.fromEntries(
    commandTable.map((command) => [
      command.name,
      Object.freeze({
        name: command.name,
        cliCommand: command.cliCommand,
        actionPolicy: command.actionPolicy,
        category: command.category,
        audience: command.audience,
        actionAliases: command.actionAliases as Readonly<Record<string, string>> | undefined,
        conditionallyMutating: command.conditionallyMutating,
        openWorld: command.openWorld,
      }),
    ]),
  ),
);

export const toolNames = Object.freeze(commandTable.map((command) => command.name));

export const commandActionAliases: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    commandTable.flatMap((command) =>
      Object.entries(command.actionAliases || {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  ),
);

export function toolMetadata(name: string): ToolRegistryEntry | null {
  return toolRegistry[name] || null;
}

export function toolMutates(name: string): boolean {
  return actionPolicyMutates(actionPolicyForTool(name));
}

export function actionPolicyForTool(name: string, args: LooseObject = {}): ActionPolicy {
  const command = commandDefinitionForTool(name);
  if (!command) return "read";
  return command.resolveActionPolicy?.(args) || command.actionPolicy;
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
  return commandDefinitionForTool(name)?.cliCommand || null;
}

export function toolNameForCliCommand(command: string): string | null {
  return commandDefinitionForCli(command)?.name || null;
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
