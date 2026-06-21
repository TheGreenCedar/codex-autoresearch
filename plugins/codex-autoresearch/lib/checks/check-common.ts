import path from "node:path";
import { resolvePackageRoot, resolveRepoRoot } from "../runtime-paths.js";
import {
  runCommand as runCheckCommand,
  type CommandResult,
  type CommandSpec,
} from "../../scripts/check-runner.js";

export type {
  CommandResult,
  CommandSpec,
  ResolvedSpawnCommand,
} from "../../scripts/check-runner.js";

export const ROOT = resolvePackageRoot(import.meta.url);
export const REPO_ROOT = resolveRepoRoot(import.meta.url);
export const PACKAGE_ROOT_RELATIVE = normalizePathForGit(path.relative(REPO_ROOT, ROOT));
export const node = process.execPath;

const BENCHMARK_SOURCE = path.join(ROOT, "scripts", "perfection-benchmark.ts");

export function runCommand(
  command: CommandSpec,
  options: { streamOutput?: boolean; timeoutSeconds?: number } = {},
): Promise<CommandResult> {
  return runCheckCommand(command, { cwd: ROOT, ...options });
}

export async function runPhase(
  name: string,
  commands: CommandSpec[],
  options: { streamOutput?: boolean; timeoutSeconds?: number } = {},
): Promise<boolean> {
  console.log(`\n== ${name} ==`);
  const results = await Promise.all(commands.map((command) => runCommand(command, options)));
  for (const result of results) {
    const marker = result.code === 0 ? "ok" : "fail";
    console.log(`${marker} ${result.label}`);
    if (
      !options.streamOutput &&
      (result.code !== 0 || process.env.CODEX_AUTORESEARCH_CHECK_VERBOSE === "1")
    ) {
      const output = `${result.stdout}${result.stderr}`.trim();
      if (output) console.log(indent(output));
    }
    if (result.label === "quality-gap" && process.env.CODEX_AUTORESEARCH_CHECK_VERBOSE === "1") {
      console.log(indent(`Benchmark source: ${BENCHMARK_SOURCE}`));
    }
  }
  return results.every((result) => result.code === 0);
}

export function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizePathForGit(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
}

export function normalizeFsPath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function optionValue(args: string[], name: string): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return String(args[index + 1] || "").trim();
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1).trim();
  }
  return "";
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}
