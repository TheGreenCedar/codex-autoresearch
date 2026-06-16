import fs from "node:fs/promises";
import path from "node:path";

export interface ParsedCliArgs {
  _: string[];
  [key: string]: boolean | string | string[];
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const out: ParsedCliArgs = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const equalsAt = arg.indexOf("=");
    const rawKey = equalsAt > 2 ? arg.slice(2, equalsAt) : arg.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    if (equalsAt > 2) {
      out[key] = arg.slice(equalsAt + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export function parseJsonOption(value: unknown, fallback: unknown): any {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    const parseError = error as Error;
    throw new Error(`Invalid JSON option: ${parseError.message}`);
  }
}

export async function parseJsonFileOption(
  filePath: string | null | undefined,
  workDir: string,
  optionName: string,
): Promise<any> {
  if (filePath == null || filePath === "") return null;
  const input = String(filePath);
  const resolved = path.isAbsolute(input) ? input : path.join(workDir, input);
  try {
    return parseJsonOption(await fs.readFile(resolved, "utf8"), {});
  } catch (error) {
    const parseError = error as Error;
    throw new Error(`${optionName} must point to a valid JSON file: ${parseError.message}`);
  }
}

export function numberOption(value: unknown, fallback: number): number;
export function numberOption(value: unknown, fallback: null): number | null;
export function numberOption(value: unknown, fallback: number | null): number | null;
export function numberOption(value: unknown, fallback: number | null): number | null {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") throw new Error(`Expected a number, got ${value}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}`);
  return parsed;
}

export function positiveIntegerOption(
  value: unknown,
  fallback: number | null,
  optionName: string,
): number | null {
  const parsed = numberOption(value, fallback);
  if (parsed == null) return parsed;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer. Got ${value}`);
  }
  return parsed;
}

export function nonNegativeIntegerOption(
  value: unknown,
  fallback: number | null,
  optionName: string,
): number | null {
  const parsed = numberOption(value, fallback);
  if (parsed == null) return parsed;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer. Got ${value}`);
  }
  return parsed;
}

export function boolOption(value: unknown, fallback = false): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

export function enumOption<T extends string>(
  value: unknown,
  allowed: Set<T>,
  fallback: T | null,
  optionName: string,
): T | null {
  if (value == null || value === "") return fallback;
  const normalized = String(value).toLowerCase() as T;
  if (!allowed.has(normalized)) {
    throw new Error(`${optionName} must be one of ${[...allowed].join(", ")}. Got ${value}`);
  }
  return normalized as T;
}
