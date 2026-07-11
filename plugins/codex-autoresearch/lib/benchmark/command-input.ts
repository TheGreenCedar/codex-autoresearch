import fsp from "node:fs/promises";
import path from "node:path";

import { enumOption } from "../cli/args.js";
import { pathExists } from "../session-core.js";
import type { UnknownRecord } from "../types/json.js";

const PACKET_ENV_MODES = new Set(["inherit", "minimal"]);

export interface BenchmarkCommandInput {
  command: string;
  commandFile?: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  envKeys?: string[];
  explicitEnvKeys?: string[];
  packetEnvMode: "inherit" | "minimal";
  separatorCommand?: boolean;
}

export async function benchmarkCommandFromArgs(
  args: UnknownRecord,
  workDir: string,
  config: UnknownRecord,
): Promise<BenchmarkCommandInput> {
  const commandSource = await resolveBenchmarkCommandSource(args, workDir, {
    fallbackToDefault: true,
    requireCommand: true,
    config,
  });
  const envFile = args.packet_env_file ?? args.packetEnvFile ?? args.env_file ?? args.envFile;
  const env = envFile ? await readEnvFile(String(envFile), workDir) : null;
  const packetEnvMode = packetEnvModeFromArgs(args);
  return {
    command: commandSource.command,
    env: env?.values || undefined,
    packetEnvMode,
    commandFile: commandSource.commandFile,
    envFile: env?.path || "",
    explicitEnvKeys: env ? Object.keys(env.values).sort((a, b) => a.localeCompare(b)) : [],
    envKeys: env ? Object.keys(env.values).sort((a, b) => a.localeCompare(b)) : [],
    separatorCommand: commandSource.separatorCommand,
  };
}

export function packetEnvModeFromArgs(args: UnknownRecord): "inherit" | "minimal" {
  const mode = enumOption(
    args.packet_env_mode ?? args.packetEnvMode,
    PACKET_ENV_MODES,
    "minimal",
    "packetEnvMode",
  );
  return mode === "inherit" ? "inherit" : "minimal";
}

export async function resolveBenchmarkCommandSource(
  args: UnknownRecord,
  workDir: string,
  options: { fallbackToDefault?: boolean; requireCommand?: boolean; config?: UnknownRecord } = {},
) {
  const commandFile = args.command_file ?? args.commandFile;
  if (args.command && commandFile) {
    throw new Error("Use either --command or --command-file, not both.");
  }
  const separatorArgs = Array.isArray(args._) ? args._ : [];
  const separatorCommand = !args.command && separatorArgs.length > 1;
  if (args.command) {
    return {
      command: normalizePowerShellEscapedCommandArg(args.command),
      commandFile: "",
      separatorCommand: false,
      source: "command",
      missingReason: "",
    };
  }
  if (separatorCommand) {
    return {
      command: separatorArgs.slice(1).join(" "),
      commandFile: "",
      separatorCommand: true,
      source: "separator",
      missingReason: "",
    };
  }
  if (commandFile) {
    return {
      command: await readCommandFile(String(commandFile), workDir),
      commandFile: resolveOptionPath(String(commandFile), workDir),
      separatorCommand: false,
      source: "command-file",
      missingReason: "",
    };
  }
  const configuredCommand =
    typeof options.config?.benchmarkCommand === "string"
      ? options.config.benchmarkCommand.trim()
      : "";
  if (configuredCommand) {
    return {
      command: normalizePowerShellEscapedCommandArg(configuredCommand),
      commandFile: "",
      separatorCommand: false,
      source: "config",
      missingReason: "",
    };
  }
  if (options.fallbackToDefault) {
    try {
      return {
        command: await defaultBenchmarkCommand(workDir),
        commandFile: "",
        separatorCommand: false,
        source: "default",
        missingReason: "",
      };
    } catch (error: unknown) {
      if (options.requireCommand) throw error;
      return {
        command: "",
        commandFile: "",
        separatorCommand: false,
        source: "missing",
        missingReason: missingBenchmarkCommandMessage(error),
      };
    }
  }
  return {
    command: "",
    commandFile: "",
    separatorCommand: false,
    source: "missing",
    missingReason: "",
  };
}

export async function defaultBenchmarkCommand(workDir: string): Promise<string> {
  const powershellScript = await pathExists(path.join(workDir, "autoresearch.ps1"));
  const bashScript = await pathExists(path.join(workDir, "autoresearch.sh"));
  if (process.platform !== "win32" && bashScript) return "bash ./autoresearch.sh";
  if (powershellScript) {
    return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1";
  }
  if (bashScript) return "bash ./autoresearch.sh";
  throw new Error(
    "No command provided; expected autoresearch.ps1 or autoresearch.sh in the work directory.",
  );
}

export async function defaultBenchmarkCommandExists(workDir: string): Promise<boolean> {
  return (
    (await pathExists(path.join(workDir, "autoresearch.ps1"))) ||
    (await pathExists(path.join(workDir, "autoresearch.sh")))
  );
}

export function normalizePowerShellEscapedCommandArg(command: unknown): string {
  const text = String(command);
  if (process.platform !== "win32" || !/^\\".+?\\"(?:\s|$)/.test(text)) return text;
  return text.replace(/\\"/g, '"');
}

export function resolveOptionPath(filePath: string, workDir: string): string {
  const input = String(filePath || "").trim();
  return path.isAbsolute(input) ? input : path.resolve(workDir, input);
}

async function readCommandFile(filePath: string, workDir: string): Promise<string> {
  const resolved = resolveOptionPath(filePath, workDir);
  const text = (await fsp.readFile(resolved, "utf8")).trim();
  if (!text) throw new Error(`--command-file is empty: ${resolved}`);
  return text;
}

async function readEnvFile(filePath: string, workDir: string) {
  const resolved = resolveOptionPath(filePath, workDir);
  const text = await fsp.readFile(resolved, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return { path: resolved, values: {} };
  if (trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`--env-file JSON must be an object: ${resolved}`);
    }
    return {
      path: resolved,
      values: Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [validateEnvName(key), String(value ?? "")]),
      ),
    };
  }
  const values: Record<string, string> = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`Invalid --env-file line ${index + 1}: expected NAME=value.`);
    values[validateEnvName(match[1])] = unquoteEnvValue(match[2].trim());
  }
  return { path: resolved, values };
}

function validateEnvName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""))) {
    throw new Error(`Invalid environment variable name in --env-file: ${name}`);
  }
  return String(name);
}

function unquoteEnvValue(value: unknown): string {
  const text = String(value ?? "");
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function missingBenchmarkCommandMessage(error: unknown = null): string {
  const detail = error ? errorMessage(error) : "";
  if (/No command provided/i.test(detail)) {
    return "No benchmark command was provided and no autoresearch script was found.";
  }
  return detail || "No benchmark command was provided and no autoresearch script was found.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
