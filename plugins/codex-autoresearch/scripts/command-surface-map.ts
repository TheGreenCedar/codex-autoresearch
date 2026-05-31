#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePackageRoot } from "../lib/runtime-paths.js";
import { toolSchemas } from "../lib/tool-schemas.js";
import { toolRegistry } from "../lib/tool-registry.js";

type RegistryEntry = {
  name: string;
  cliCommand: string;
  public: boolean;
  internal: boolean;
  source: string;
};

type SourceScan = {
  label: string;
  path: string;
  commands?: string[];
  toolNames?: string[];
  missingCommands: string[];
  missingToolNames: string[];
  unregisteredCommands: string[];
  unregisteredToolNames: string[];
  required: boolean;
};

type CommandSurfaceMap = {
  ok: boolean;
  registry: RegistryEntry[];
  scans: SourceScan[];
  missingPublicReferences: string[];
  internalReferences: string[];
  argumentIssues: string[];
};

const ROOT = resolvePackageRoot(import.meta.url);

export async function buildCommandSurfaceMap(): Promise<CommandSurfaceMap> {
  const registry = registryEntries();
  const publicEntries = registry.filter((entry) => entry.public);
  const publicCommands = new Set(publicEntries.map((entry) => entry.cliCommand));
  const publicToolNames = new Set(publicEntries.map((entry) => entry.name));
  const commandToEntry = new Map(registry.map((entry) => [entry.cliCommand, entry]));
  const toolNameToEntry = new Map(registry.map((entry) => [entry.name, entry]));

  const scans = await Promise.all([
    scanCommandSource({
      label: "cli-help",
      candidates: ["scripts/autoresearch.ts", "dist/scripts/autoresearch.mjs"],
      extractCommands: extractUsageCommands,
      required: true,
      registryCommands: publicCommands,
      commandToEntry,
    }),
    scanCommandSource({
      label: "cli-handlers",
      candidates: ["lib/cli-handlers.ts", "dist/lib/cli-handlers.mjs"],
      extractCommands: extractCliHandlerCommands,
      required: true,
      registryCommands: publicCommands,
      commandToEntry,
    }),
    scanToolNameSource({
      label: "tool-schemas",
      candidates: ["lib/tool-schemas.ts", "dist/lib/tool-schemas.mjs"],
      extractToolNames,
      required: true,
      registryToolNames: publicToolNames,
      toolNameToEntry,
    }),
  ]);
  const argumentIssues = await validateArgumentCoherence();

  const missingPublicReferences = scans
    .flatMap((scan) => {
      if (!scan.required) return [];
      return [
        ...scan.missingCommands.map((command) => `${scan.label}: ${command}`),
        ...scan.missingToolNames.map((name) => `${scan.label}: ${name}`),
        ...scan.unregisteredCommands.map((command) => `${scan.label}: ${command}`),
        ...scan.unregisteredToolNames.map((name) => `${scan.label}: ${name}`),
      ];
    })
    .concat(argumentIssues);

  return {
    ok: missingPublicReferences.length === 0,
    registry,
    scans,
    missingPublicReferences,
    argumentIssues,
    internalReferences: registry
      .filter((entry) => entry.internal)
      .map((entry) => `${entry.cliCommand} (${entry.name}) from ${entry.source}`),
  };
}

async function validateArgumentCoherence(): Promise<string[]> {
  const issues: string[] = [];
  const onboarding = toolSchemas.find((tool) => tool.name === "onboarding_packet");
  const recommend = toolSchemas.find((tool) => tool.name === "recommend_next");
  const cliHandlers = await readFirstExisting(["lib/cli-handlers.ts", "dist/lib/cli-handlers.mjs"]);
  const onboardingHandler = extractCommandHandlerSource(cliHandlers.content, "onboarding-packet");
  const recommendHandler = extractCommandHandlerSource(cliHandlers.content, "recommend-next");

  if (onboarding?.inputSchema.properties?.operator_checklist) {
    issues.push(
      "onboarding_packet: operator_checklist is exposed but onboarding-packet does not handle it",
    );
  }
  if (!recommend?.inputSchema.properties?.operator_checklist) {
    issues.push(
      "recommend_next: operator_checklist is handled by recommend-next but missing from input schema",
    );
  }
  if (/operatorChecklist/.test(onboardingHandler)) {
    issues.push("onboarding-packet: operatorChecklist handler wiring belongs on recommend-next");
  }
  if (!/operatorChecklist:\s*args\.operatorChecklist/.test(recommendHandler)) {
    issues.push("recommend-next: operatorChecklist handler wiring is missing");
  }

  return issues;
}

function extractCommandHandlerSource(source: string, command: string): string {
  const pattern = new RegExp(
    `["']${escapeRegExp(command)}["']:\\s+async[\\s\\S]*?(?=\\n    ["'][a-z]|\\n    [A-Za-z][A-Za-z0-9]*:\\s+async|\\n  \\}\\);)`,
  );
  return source.match(pattern)?.[0] || "";
}

function registryEntries(): RegistryEntry[] {
  return Object.entries(toolRegistry)
    .map(([name, raw]) => {
      const entry = raw as Record<string, unknown>;
      const internal = entry.internal === true || entry.hidden === true || entry.public === false;
      return {
        name,
        cliCommand: String(entry.cliCommand || ""),
        public: !internal,
        internal,
        source: "lib/tool-registry.ts",
      };
    })
    .filter((entry) => entry.cliCommand)
    .sort((a, b) => a.cliCommand.localeCompare(b.cliCommand));
}

async function scanCommandSource({
  label,
  candidates,
  extractCommands,
  required,
  registryCommands,
  commandToEntry,
}: {
  label: string;
  candidates: string[];
  extractCommands: (source: string) => string[];
  required: boolean;
  registryCommands: Set<string>;
  commandToEntry: Map<string, RegistryEntry>;
}): Promise<SourceScan> {
  const source = await readFirstExisting(candidates);
  const commands = extractCommands(source.content);
  return {
    label,
    path: source.relativePath,
    commands,
    missingCommands: [...registryCommands].filter((command) => !commands.includes(command)),
    missingToolNames: [],
    unregisteredCommands: commands.filter((command) => {
      const entry = commandToEntry.get(command);
      return !entry;
    }),
    unregisteredToolNames: [],
    required,
  };
}

async function scanToolNameSource({
  label,
  candidates,
  extractToolNames,
  required,
  registryToolNames,
  toolNameToEntry,
}: {
  label: string;
  candidates: string[];
  extractToolNames: (source: string) => string[];
  required: boolean;
  registryToolNames: Set<string>;
  toolNameToEntry: Map<string, RegistryEntry>;
}): Promise<SourceScan> {
  const source = await readFirstExisting(candidates);
  const toolNames = extractToolNames(source.content);
  return {
    label,
    path: source.relativePath,
    toolNames,
    missingCommands: [],
    missingToolNames: [...registryToolNames].filter((name) => !toolNames.includes(name)),
    unregisteredCommands: [],
    unregisteredToolNames: toolNames.filter((name) => {
      const entry = toolNameToEntry.get(name);
      return !entry;
    }),
    required,
  };
}

async function readFirstExisting(candidates: string[]) {
  const errors: string[] = [];
  for (const relativePath of candidates) {
    const absolutePath = path.join(ROOT, relativePath);
    try {
      return {
        relativePath,
        content: await fs.readFile(absolutePath, "utf8"),
      };
    } catch (error) {
      errors.push(`${relativePath}: ${String(error)}`);
    }
  }
  throw new Error(`Could not read command surface source:\n${errors.join("\n")}`);
}

function extractUsageCommands(source: string): string[] {
  return uniqueMatches(source, /node scripts\/autoresearch\.mjs\s+([a-z][a-z0-9-]*)/g);
}

function extractCliHandlerCommands(source: string): string[] {
  return uniqueMatches(
    source,
    /^[ \t]+(?:"([a-z][a-z0-9-]+)"|([A-Za-z][A-Za-z0-9]*)):\s+async/gm,
  ).map((command) => (command === "export" ? "export" : command));
}

function extractToolNames(source: string): string[] {
  return uniqueMatches(source, /name:\s+"([a-z][a-z0-9_]*)"/g);
}

function uniqueMatches(source: string, pattern: RegExp): string[] {
  const values = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    values.add(String(match[1] || match[2] || ""));
  }
  return [...values].filter(Boolean).sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatCommandSurfaceMap(map: CommandSurfaceMap): string {
  const lines = ["Command surface map", ""];
  lines.push(`Registry commands: ${map.registry.filter((entry) => entry.public).length} public`);
  for (const scan of map.scans) {
    const missing = scan.missingCommands.length + scan.missingToolNames.length;
    const unregistered = scan.unregisteredCommands.length + scan.unregisteredToolNames.length;
    lines.push(`${scan.label}: ${scan.path}; missing=${missing}; unregistered=${unregistered}`);
    if (scan.missingCommands.length) {
      lines.push(`  missing commands: ${scan.missingCommands.join(", ")}`);
    }
    if (scan.missingToolNames.length) {
      lines.push(`  missing tool names: ${scan.missingToolNames.join(", ")}`);
    }
    if (scan.unregisteredCommands.length) {
      lines.push(`  unregistered commands: ${scan.unregisteredCommands.join(", ")}`);
    }
    if (scan.unregisteredToolNames.length) {
      lines.push(`  unregistered tool names: ${scan.unregisteredToolNames.join(", ")}`);
    }
  }
  if (map.argumentIssues.length) {
    lines.push(`Argument issues: ${map.argumentIssues.join(", ")}`);
  }
  if (map.internalReferences.length) {
    lines.push("");
    lines.push(`Internal commands: ${map.internalReferences.join(", ")}`);
  }
  return lines.join("\n");
}

async function main() {
  const map = await buildCommandSurfaceMap();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(map, null, 2));
  } else {
    console.log(formatCommandSurfaceMap(map));
  }
  process.exit(map.ok ? 0 : 1);
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  await main();
}
