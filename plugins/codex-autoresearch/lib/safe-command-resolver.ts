import { readoutSafeCommand } from "./dashboard-command-safety.js";

export type SafeCommandMode = "operational" | "readout";

export interface ResolveCommandOptions {
  keyVariants?: (key: string) => Iterable<string>;
  mode?: SafeCommandMode;
}

export function resolveSafeCommand(command: unknown, mode: SafeCommandMode = "readout"): string {
  const text = concreteCommand(command);
  if (!text) return "";
  return mode === "operational" ? text : readoutSafeCommand(text);
}

export function firstSafeCommand(
  commands: Iterable<unknown>,
  mode: SafeCommandMode = "readout",
): string {
  for (const command of commands) {
    const resolved = resolveSafeCommand(command, mode);
    if (resolved) return resolved;
  }
  return "";
}

export function resolveCommandByKeys(
  lookup: (key: string) => unknown,
  keys: Iterable<string>,
  options: ResolveCommandOptions = {},
): string {
  const mode = options.mode || "readout";
  const keyVariants = options.keyVariants || defaultCommandKeyVariants;
  for (const key of keys) {
    for (const variant of keyVariants(key)) {
      const command = resolveSafeCommand(lookup(variant), mode);
      if (command) return command;
    }
  }
  return "";
}

export function createCommandLookup(commands: unknown): (key: string) => string {
  const entries = new Map<string, string>();
  const add = (key: unknown, command: unknown) => {
    const normalized = normalizeActionCommandKey(key);
    const text = concreteCommand(command);
    if (normalized && text && !entries.has(normalized)) entries.set(normalized, text);
  };
  if (Array.isArray(commands)) {
    for (const item of commands) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      add(record.key, record.command);
      add(record.name, record.command);
      add(record.label, record.command);
    }
  } else if (commands && typeof commands === "object") {
    for (const [key, command] of Object.entries(commands as Record<string, unknown>)) {
      add(key, command);
    }
  }
  return (key: string) => entries.get(normalizeActionCommandKey(key)) || "";
}

export function normalizeActionCommandKey(value: unknown): string {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

export function defaultCommandKeyVariants(key: string): string[] {
  return [key, spacedKey(key), normalizeActionCommandKey(key)];
}

function spacedKey(value: string): string {
  return value.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`).toLowerCase();
}

function concreteCommand(command: unknown): string {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text || /<[^>]+>/.test(text)) return "";
  return text;
}
