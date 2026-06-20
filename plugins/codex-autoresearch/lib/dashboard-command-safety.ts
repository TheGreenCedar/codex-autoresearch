import {
  COMMAND_ARGUMENT_FIELDS,
  actionPolicyForTool,
  actionPolicyMutates,
  toolNameForCliCommand,
  toolRegistry,
} from "./tool-registry.js";
import { resolvePackageRoot } from "./runtime-paths.js";
import type { UnknownRecord } from "./types/json.js";

type LooseObject = UnknownRecord;

export const DASHBOARD_COMMAND_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  doctorExplain: "doctor",
  liveDashboard: "serve dashboard",
  newSegmentDryRun: "new segment",
  promoteGateDryRun: "promote gate",
  state: "state",
});

export const DASHBOARD_COMMAND_FIELD_NAMES: ReadonlySet<string> = new Set([
  "argv",
  "applyCommand",
  "baselineCommand",
  "benchmarkInspect",
  "benchmarkLint",
  "benchmarkLintCommand",
  "checksInspect",
  "codexGoalBrief",
  "command",
  "commandLabel",
  "commands",
  "commandsByStatus",
  "cleanupCommand",
  "discardLast",
  "display",
  "doctorExplain",
  "exportDashboard",
  "finalizeCurrentTree",
  "finalizePreview",
  "gapCandidates",
  "guideCommand",
  "guidedFlow",
  "keepLast",
  "laneRunner",
  "liveAction",
  "liveDashboard",
  "liveDashboardCommand",
  "logLast",
  "newSegmentDryRun",
  "nextCommand",
  "nextFull",
  "nextRun",
  "onboardingPacket",
  "output",
  "outputTail",
  "partialResults",
  "planCommand",
  "planOutput",
  "primaryCommand",
  "promoteGateDryRun",
  "recommendNext",
  "replaceLast",
  "setupPlan",
  "stateCompact",
  "staticExport",
  "suggestedCommand",
  "suggestedCommands",
  "finalizeCommand",
  "finalizerCommand",
]);

export const DASHBOARD_PATH_FIELD_NAMES: ReadonlySet<string> = new Set([
  "cwd",
  "sessionCwd",
  "sourceCwd",
  "workDir",
]);

export const DASHBOARD_EXPORT_FIELD_NAMES: ReadonlySet<string> = new Set([
  ...DASHBOARD_COMMAND_FIELD_NAMES,
  ...DASHBOARD_PATH_FIELD_NAMES,
]);

export const DASHBOARD_COMMAND_CONTEXT_FIELD_NAMES: ReadonlySet<string> =
  DASHBOARD_COMMAND_FIELD_NAMES;

const DASHBOARD_DRY_RUN_ONLY_AUTORESEARCH_COMMANDS = new Set([
  "lane-runner",
  "new-segment",
  "promote-gate",
  "research-fanout",
  "session-forensics",
]);

const DASHBOARD_KNOWN_AUTORESEARCH_COMMANDS = new Set([
  ...Object.values(toolRegistry).map((tool) => tool.cliCommand),
  "help",
]);

const DASHBOARD_BLOCKED_PROCESS_COMMAND_FLAGS = new Set(
  COMMAND_ARGUMENT_FIELDS.flatMap(commandArgumentFlagVariants),
);

export interface DashboardCommandSafetyResult {
  commandName: string;
  reason: string;
  safe: boolean;
}

export interface StripDashboardCommandFieldsOptions {
  extraFieldNames?: Iterable<string>;
  stringScrubber?: (value: string) => unknown;
}

export function dashboardReadOnlyCommand(value: unknown): string {
  return readoutSafeCommand(value);
}

export function readoutSafeCommand(value: unknown): string {
  const command = cleanCommandText(value);
  if (!command) return "";
  return isDashboardReadOnlyCommand(command) ? command : "";
}

export function isDashboardReadOnlyCommand(command: unknown): boolean {
  return dashboardCommandSafety(command).safe;
}

export function dashboardCommandSafety(command: unknown): DashboardCommandSafetyResult {
  const text = cleanCommandText(command);
  if (!text) return { safe: false, commandName: "", reason: "empty command" };

  const unsafeShellOperator = firstUnsafeShellOperator(text);
  if (unsafeShellOperator) {
    return {
      safe: false,
      commandName: "",
      reason: `shell operator ${unsafeShellOperator} is not dashboard-safe`,
    };
  }

  const tokens = tokenizeDashboardCommand(text);
  const invocation = extractAutoresearchInvocation(tokens);
  const commandName = invocation.commandName;
  if (!commandName) {
    return {
      safe: false,
      commandName: "",
      reason: "not a node-launched autoresearch command",
    };
  }
  if (tokens.includes("--")) {
    return {
      safe: false,
      commandName,
      reason: "argument separator payloads are not dashboard-safe",
    };
  }
  const processCommandFlag = firstProcessCommandFlag(tokens);
  if (processCommandFlag) {
    return {
      safe: false,
      commandName,
      reason: `${processCommandFlag} can execute arbitrary commands`,
    };
  }
  if (DASHBOARD_DRY_RUN_ONLY_AUTORESEARCH_COMMANDS.has(commandName)) {
    const safe = hasEnabledFlag(tokens, "--dry-run");
    if (!safe) {
      return {
        safe: false,
        commandName,
        reason: `${commandName} requires --dry-run for dashboard use`,
      };
    }
  }
  if (
    commandName === "integrations" &&
    (tokens.some((token) => normalizeCommandName(token) === "sync-recipes") ||
      hasOptionValue(tokens, "--subcommand", "sync-recipes"))
  ) {
    return { safe: false, commandName, reason: "integrations sync-recipes mutates recipes" };
  }
  const toolName = toolNameForCliCommand(commandName);
  if (!toolName) {
    return { safe: false, commandName, reason: "autoresearch command is not dashboard-safe" };
  }
  const policy = actionPolicyForTool(
    toolName,
    argsForActionPolicy(tokens, invocation.commandIndex),
  );
  if (actionPolicyMutates(policy)) {
    return { safe: false, commandName, reason: `${commandName} is ${policy}` };
  }
  return { safe: true, commandName, reason: "read-only dashboard command" };
}

export function stripDashboardGuidanceCommandFields<T>(
  value: T,
  options: StripDashboardCommandFieldsOptions = {},
): T | null {
  return stripDashboardFields(value, mergeFieldNames(DASHBOARD_COMMAND_FIELD_NAMES, options), {
    stringScrubber: options.stringScrubber,
  }) as T | null;
}

export function stripDashboardExportCommandFields<T>(
  value: T,
  options: StripDashboardCommandFieldsOptions = {},
): T | null {
  return stripDashboardFields(value, mergeFieldNames(DASHBOARD_EXPORT_FIELD_NAMES, options), {
    stringScrubber: options.stringScrubber,
  }) as T | null;
}

export function collectDashboardCommandFields(
  value: unknown,
  key = "",
  inCommandBlock = false,
): string[] {
  const commandContext = inCommandBlock || DASHBOARD_COMMAND_CONTEXT_FIELD_NAMES.has(key);
  if (typeof value === "string") return commandContext ? [value] : [];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectDashboardCommandFields(item, key, commandContext));
  }
  return Object.entries(value).flatMap(([childKey, child]) =>
    collectDashboardCommandFields(child, childKey, commandContext),
  );
}

export function dashboardCommandMapKey(key: string): string {
  if (DASHBOARD_COMMAND_KEY_ALIASES[key]) return DASHBOARD_COMMAND_KEY_ALIASES[key];
  return key.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`).toLowerCase();
}

function stripDashboardFields(
  value: unknown,
  fieldNames: ReadonlySet<string>,
  { stringScrubber }: { stringScrubber?: (value: string) => unknown },
): unknown {
  if (typeof value === "string") return stringScrubber ? stringScrubber(value) : value;
  if (Array.isArray(value)) {
    return value.map((item) => stripDashboardFields(item, fieldNames, { stringScrubber }));
  }
  if (!value || typeof value !== "object") return value;
  const result: LooseObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (fieldNames.has(key)) continue;
    result[key] = stripDashboardFields(nested, fieldNames, { stringScrubber });
  }
  return result;
}

function mergeFieldNames(
  base: ReadonlySet<string>,
  options: StripDashboardCommandFieldsOptions,
): ReadonlySet<string> {
  if (!options.extraFieldNames) return base;
  return new Set([...base, ...options.extraFieldNames]);
}

function cleanCommandText(value: unknown): string {
  return String(value ?? "").trim();
}

function extractAutoresearchInvocation(tokens: string[]): {
  commandIndex: number;
  commandName: string;
} {
  if (!isAllowedNodeAutoresearchInvocation(tokens)) return { commandIndex: -1, commandName: "" };
  const commandName = normalizeCommandName(tokens[2]);
  return {
    commandIndex: 2,
    commandName: DASHBOARD_KNOWN_AUTORESEARCH_COMMANDS.has(commandName) ? commandName : "",
  };
}

function normalizeCommandName(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function hasEnabledFlag(tokens: string[], flag: string): boolean {
  return tokens.some((token) => {
    const value = token.toLowerCase();
    if (value === flag) return true;
    if (!value.startsWith(`${flag}=`)) return false;
    return !["0", "false", "no"].includes(value.slice(flag.length + 1));
  });
}

function hasOptionValue(tokens: string[], flag: string, expected: string): boolean {
  const normalizedFlag = flag.toLowerCase();
  const normalizedExpected = expected.toLowerCase();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    if (
      token === normalizedFlag &&
      (tokens[index + 1] || "").toLowerCase() === normalizedExpected
    ) {
      return true;
    }
    if (token === `${normalizedFlag}=${normalizedExpected}`) return true;
  }
  return false;
}

function firstProcessCommandFlag(tokens: string[]): string {
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    for (const flag of DASHBOARD_BLOCKED_PROCESS_COMMAND_FLAGS) {
      const normalizedFlag = flag.toLowerCase();
      if (normalized === normalizedFlag || normalized.startsWith(`${normalizedFlag}=`)) return flag;
    }
  }
  return "";
}

function argsForActionPolicy(tokens: string[], commandIndex: number): LooseObject {
  const args: LooseObject = {};
  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--") || token === "--") continue;
    const raw = token.slice(2);
    const equalsIndex = raw.indexOf("=");
    const name = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
    const inlineValue = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : null;
    const next = tokens[index + 1] || "";
    const value =
      inlineValue != null ? inlineValue : next && !next.startsWith("--") ? tokens[++index] : true;
    assignFlagArg(args, name, value);
  }
  return args;
}

function assignFlagArg(args: LooseObject, name: string, value: unknown): void {
  const snake = name.replace(/-/g, "_");
  const camel = snake.replace(/_([a-z])/g, (_match, char) => String(char).toUpperCase());
  args[name] = value;
  args[snake] = value;
  args[camel] = value;
}

function isAllowedNodeAutoresearchInvocation(tokens: string[]): boolean {
  return tokens.length >= 3 && isNodeExecutable(tokens[0]) && isAutoresearchScript(tokens[1]);
}

function isAutoresearchScript(token: string): boolean {
  const normalized = token.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  if (!isAbsolutePathToken(token)) {
    return (
      normalized === "scripts/autoresearch.mjs" ||
      normalized === "./scripts/autoresearch.mjs" ||
      normalized === "dist/scripts/autoresearch.mjs" ||
      normalized === "./dist/scripts/autoresearch.mjs"
    );
  }
  if (!/(?:^|\/)(?:dist\/)?scripts\/autoresearch\.mjs$/.test(normalized)) return false;
  const packageRoot = resolvePackageRoot(import.meta.url)
    .replace(/\\/g, "/")
    .toLowerCase();
  return (
    normalized === `${packageRoot}/scripts/autoresearch.mjs` ||
    normalized === `${packageRoot}/dist/scripts/autoresearch.mjs`
  );
}

function isAbsolutePathToken(token: string): boolean {
  return /^[a-z]:[\\/]/i.test(token) || token.startsWith("/") || token.startsWith("\\\\");
}

function isNodeExecutable(token: string): boolean {
  const normalized = token.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename === "node" || basename === "node.exe";
}

function firstUnsafeShellOperator(command: string): string {
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = "";
      else if (quote !== "'" && char === "$" && command[index + 1] === "(") return "$()";
      else if (quote !== "'" && char === "`") return "`";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\r" || char === "\n") return "newline";
    if (char === "$" && command[index + 1] === "(") return "$()";
    if (char === "`") return "`";
    if (char === "&" && command[index + 1] === "&") return "&&";
    if (char === "|" && command[index + 1] === "|") return "||";
    if (char === ">" && command[index + 1] === ">") return ">>";
    if (char === ";" || char === "|" || char === "&") return char;
    if (char === "<" || char === ">") return char;
    if (char === "(" || char === ")") return char;
  }
  return quote ? "unterminated quote" : "";
}

function tokenizeDashboardCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function commandArgumentFlagVariants(field: string): string[] {
  const snake = field.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  const camel = snake.replace(/_([a-z])/g, (_match, char) => String(char).toUpperCase());
  return [`--${field}`, `--${snake}`, `--${snake.replace(/_/g, "-")}`, `--${camel}`];
}
