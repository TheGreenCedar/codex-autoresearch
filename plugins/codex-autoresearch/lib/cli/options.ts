import { parseArgs } from "node:util";

import { toolRegistry } from "../tool-registry.js";
import { toolSchemas } from "../tool-schemas.js";

type ParsedValue = boolean | string | string[];

export interface ParsedAutoresearchArgs {
  _: string[];
  [key: string]: ParsedValue;
}

type OptionKind = "boolean" | "list" | "string";

interface OptionDefinition {
  aliases: string[];
  key: string;
  kind: OptionKind;
  name: string;
}

interface OptionSet {
  aliases: Map<string, OptionDefinition>;
  definitions: Map<string, OptionDefinition>;
}

interface CliSchema {
  properties?: Record<
    string,
    {
      items?: { type?: string | string[] };
      type?: string | string[];
    }
  >;
}

const SHARED_OPTIONS: OptionDefinition[] = [
  option("help", "help", "boolean", ["h"]),
  option("debug", "debug", "boolean"),
  option("all", "all", "boolean"),
  option("json", "json", "boolean"),
  option("allow-outside-workdir", "allowOutsideWorkdir", "boolean", [
    "allowOutsideWorkdir",
    "allow_outside_workdir",
  ]),
];

const COMMAND_OPTIONS: Record<string, OptionDefinition[]> = {
  "setup-plan": [option("shell", "shell", "string"), option("compact", "compact", "boolean")],
  guide: [option("shell", "shell", "string"), option("compact", "compact", "boolean")],
  "prompt-plan": [option("shell", "shell", "string"), option("compact", "compact", "boolean")],
  setup: [option("interactive", "interactive", "boolean"), option("scope", "filesInScope", "list")],
  recipes: [
    option("id", "id", "string"),
    option("recipe", "recipe", "string"),
    option("recipe-id", "recipeId", "string", ["recipeId", "recipe_id"]),
  ],
  "quality-gap": [option("list", "list", "boolean")],
  "new-segment": [
    option("best-direction", "bestDirection", "string", ["bestDirection", "best_direction"]),
  ],
  export: [
    option("showcase", "showcase", "boolean"),
    option("showcase-mode", "showcaseMode", "string", ["showcaseMode", "showcase_mode"]),
    option("verbose", "verbose", "boolean"),
    option("progress-stderr", "progressStderr", "boolean", ["progressStderr", "progress_stderr"]),
  ],
};

const FINALIZER_OPTIONS = optionSet([
  option("help", "help", "boolean", ["h"]),
  option("debug", "debug", "boolean"),
  option("cwd", "cwd", "string", ["working-dir", "workingDir", "working_dir"]),
  option("output", "output", "string"),
  option("goal", "goal", "string"),
  option("trunk", "trunk", "string"),
  option("collapse-overlap", "collapseOverlap", "boolean", ["collapseOverlap", "collapse_overlap"]),
]);
const FINALIZER_LEADING_BOOLEAN_OPTIONS = new Set(["help", "debug"]);

const COMMAND_NAMES = new Set(Object.values(toolRegistry).map((entry) => entry.cliCommand));
const POSITIONAL_COMMAND_NAMES = new Set([...COMMAND_NAMES, "help"]);
const SCHEMA_BY_TOOL = new Map(toolSchemas.map((schema) => [schema.name, schema.inputSchema]));
const COMMAND_OPTION_SETS = new Map<string, OptionSet>();
let aggregateOptionSet: OptionSet | null = null;

export class CliUsageError extends Error {
  readonly command: string | null;

  constructor(message: string, command: string | null = null) {
    super(message);
    this.name = "CliUsageError";
    this.command = command;
  }
}

export function parseAutoresearchCliArgs(argv: readonly string[]): ParsedAutoresearchArgs {
  const aggregate = parseWithOptions(argv, allCommandOptions(), null, false);
  const command = aggregate._[0] || null;

  if (!command) return parseWithOptions(argv, optionSet(SHARED_OPTIONS), null);
  if (command === "help") return parseWithOptions(argv, optionSet(SHARED_OPTIONS), null);

  const commandOptions = optionsForCommand(command);
  if (!commandOptions) throw new CliUsageError(`Unknown command: ${command}`);
  return parseWithOptions(argv, commandOptions, command);
}

export function parseFinalizerCliArgs(argv: readonly string[]): ParsedAutoresearchArgs {
  return parseWithOptions(argv, FINALIZER_OPTIONS, null, true, FINALIZER_LEADING_BOOLEAN_OPTIONS);
}

export function cliDebugRequested(
  argv: readonly string[],
  allowLeadingPositional = false,
): boolean {
  let enabled = false;
  let sawPositional = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") break;
    if (!token.startsWith("-")) {
      sawPositional = true;
      continue;
    }
    if (token === "--debug") {
      const next = argv[index + 1];
      if (next && isBooleanLiteral(next)) {
        enabled = booleanLiteral(next, "--debug");
        index += 1;
      } else if (
        next &&
        next !== "--" &&
        !next.startsWith("-") &&
        !POSITIONAL_COMMAND_NAMES.has(next) &&
        !(allowLeadingPositional && !sawPositional)
      ) {
        enabled = false;
      } else {
        enabled = true;
      }
    } else if (token.startsWith("--debug=")) {
      const value = token.slice("--debug=".length);
      enabled = isBooleanLiteral(value) ? booleanLiteral(value, "--debug") : false;
    } else if (allowLeadingPositional && !token.includes("=")) {
      const definition = FINALIZER_OPTIONS.aliases.get(token.slice(2));
      if (definition && definition.kind !== "boolean") index += 1;
    }
  }
  return enabled;
}

export function isKnownCliCommand(command: string): boolean {
  return COMMAND_NAMES.has(command);
}

function optionsForCommand(command: string): OptionSet | null {
  const cached = COMMAND_OPTION_SETS.get(command);
  if (cached) return cached;

  const registryEntry = Object.values(toolRegistry).find((entry) => entry.cliCommand === command);
  if (!registryEntry) return null;
  const schema = SCHEMA_BY_TOOL.get(registryEntry.name) as CliSchema | undefined;
  const definitions = [
    ...SHARED_OPTIONS,
    ...definitionsFromSchema(schema),
    ...(COMMAND_OPTIONS[command] || []),
  ];
  const result = optionSet(definitions);
  COMMAND_OPTION_SETS.set(command, result);
  return result;
}

function allCommandOptions(): OptionSet {
  if (aggregateOptionSet) return aggregateOptionSet;
  const definitions = [...SHARED_OPTIONS];
  for (const command of COMMAND_NAMES) {
    const options = optionsForCommand(command);
    if (options) definitions.push(...options.definitions.values());
  }
  aggregateOptionSet = optionSet(definitions);
  return aggregateOptionSet;
}

function definitionsFromSchema(schema: CliSchema | undefined): OptionDefinition[] {
  const properties = schema?.properties || {};
  return Object.entries(properties).map(([property, definition]) => {
    const kind: OptionKind =
      definition.type === "boolean"
        ? "boolean"
        : definition.type === "array" && definition.items?.type === "string"
          ? "list"
          : "string";
    const name = property === "working_dir" ? "cwd" : toKebab(property);
    const aliases = new Set([property, toCamel(property), toKebab(property)]);
    if (property === "working_dir") {
      aliases.add("cwd");
      aliases.add("workingDir");
      aliases.add("working-dir");
    }
    if (property === "recipe_id") aliases.add("recipe");
    if (property === "research_slug") aliases.add("slug");
    if (property === "confirm") aliases.add("yes");
    if (property === "json_full") aliases.add("full");
    return option(name, runtimeKey(property), kind, [...aliases]);
  });
}

function optionSet(definitions: OptionDefinition[]): OptionSet {
  const byName = new Map<string, OptionDefinition>();
  const aliases = new Map<string, OptionDefinition>();
  for (const definition of definitions) {
    byName.set(definition.name, definition);
    for (const alias of [definition.name, ...definition.aliases]) aliases.set(alias, definition);
  }
  return { aliases, definitions: byName };
}

function option(
  name: string,
  key: string,
  kind: OptionKind,
  aliases: string[] = [],
): OptionDefinition {
  return { aliases, key, kind, name };
}

function parseWithOptions(
  argv: readonly string[],
  optionSet: OptionSet,
  command: string | null,
  strict = true,
  leadingBooleanOptions: ReadonlySet<string> | null = null,
): ParsedAutoresearchArgs {
  const booleanValues = new Map<string, boolean>();
  const normalized = normalizeArgv(
    argv,
    optionSet,
    booleanValues,
    command,
    strict,
    leadingBooleanOptions,
  );
  const options: Record<
    string,
    { multiple?: boolean; short?: string; type: "boolean" | "string" }
  > = Object.fromEntries(
    [...optionSet.definitions.values()].map((definition) => [
      definition.name,
      {
        type: definition.kind === "boolean" ? "boolean" : "string",
        ...(definition.kind === "list" ? { multiple: true } : {}),
        ...(definition.name === "help" ? { short: "h" } : {}),
      },
    ]),
  );

  try {
    const parsed = parseArgs({
      allowPositionals: true,
      args: normalized,
      options,
      strict,
    });
    const result: ParsedAutoresearchArgs = { _: parsed.positionals };
    for (const [name, value] of Object.entries(parsed.values)) {
      const definition = optionSet.definitions.get(name);
      if (!definition || value === undefined) continue;
      result[definition.key] = normalizeParsedValue(value, definition);
    }
    for (const [key, value] of booleanValues) result[key] = value;
    return result;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(cleanParseError(message), command);
  }
}

function normalizeArgv(
  argv: readonly string[],
  optionSet: OptionSet,
  booleanValues: Map<string, boolean>,
  command: string | null,
  validateBooleans: boolean,
  leadingBooleanOptions: ReadonlySet<string> | null,
): string[] {
  const normalized: string[] = [];
  let sawCommand = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      normalized.push(...argv.slice(index));
      break;
    }
    if (!token.startsWith("--")) {
      normalized.push(token);
      if (!token.startsWith("-")) sawCommand = true;
      continue;
    }

    const equalsAt = token.indexOf("=");
    const rawName = token.slice(2, equalsAt < 0 ? undefined : equalsAt);
    const definition = optionSet.aliases.get(rawName);
    if (!definition) {
      normalized.push(token);
      continue;
    }

    const inlineValue = equalsAt < 0 ? null : token.slice(equalsAt + 1);
    if (definition.kind === "boolean") {
      let value = true;
      if (inlineValue != null) {
        value =
          !validateBooleans && !isBooleanLiteral(inlineValue)
            ? true
            : booleanLiteral(inlineValue, `--${rawName}`, command);
      } else {
        const next = argv[index + 1];
        if (
          next != null &&
          next !== "--" &&
          !next.startsWith("-") &&
          !(
            !sawCommand &&
            (leadingBooleanOptions
              ? leadingBooleanOptions.has(definition.name)
              : POSITIONAL_COMMAND_NAMES.has(next))
          )
        ) {
          value =
            !validateBooleans && !isBooleanLiteral(next)
              ? true
              : booleanLiteral(next, `--${rawName}`, command);
          index += 1;
        }
      }
      booleanValues.set(definition.key, value);
      continue;
    }

    if (inlineValue != null) {
      normalized.push(`--${definition.name}=${inlineValue}`);
      continue;
    }
    const next = argv[index + 1];
    if (next != null && /^-\d/.test(next)) {
      normalized.push(`--${definition.name}=${next}`);
      index += 1;
    } else {
      normalized.push(`--${definition.name}`);
    }
    if (next != null && next !== "--" && !next.startsWith("-")) {
      normalized.push(next);
      index += 1;
    }
  }
  return normalized;
}

function normalizeParsedValue(
  value: boolean | string | (boolean | string)[],
  definition: OptionDefinition,
): ParsedValue {
  if (definition.kind !== "list" || !Array.isArray(value)) {
    return Array.isArray(value) ? value.map(String) : value;
  }
  if (value.length <= 1) return value[0] || "";
  return value.flatMap((entry) =>
    String(entry)
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function booleanLiteral(value: string, optionName: string, command: string | null = null): boolean {
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new CliUsageError(
    `${optionName} expects a boolean value (true or false). Got ${JSON.stringify(value)}.`,
    command,
  );
}

function isBooleanLiteral(value: string): boolean {
  return ["0", "1", "false", "true", "no", "yes", "n", "y"].includes(value.toLowerCase());
}

function cleanParseError(message: string): string {
  return message.replace(/^TypeError \[[^\]]+\]:\s*/, "").replace(/^TypeError:\s*/, "");
}

function runtimeKey(property: string): string {
  if (property === "working_dir") return "cwd";
  return toCamel(property);
}

function toCamel(value: string): string {
  return value.replace(/[_-]([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function toKebab(value: string): string {
  return value
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}
