import path from "node:path";
import { fileURLToPath } from "node:url";

import { ACTION_METADATA } from "../lib/action-metadata.js";
import { commandTable, type CommandDefinition } from "../lib/command-table.js";
import { validateToolContracts } from "../lib/tool-contracts.js";
import { toolSchemas } from "../lib/tool-schemas.js";

type RegistryEntry = {
  audience: string;
  category: string;
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
  metadataIssues: string[];
  contractIssues: string[];
  actionMetadataIssues: string[];
  internalReferences: string[];
  argumentIssues: string[];
};

const VALID_CATEGORIES = new Set([
  "happy_path",
  "setup",
  "diagnostic",
  "advanced",
  "integration",
  "dangerous",
]);
const VALID_AUDIENCES = new Set(["default", "advanced", "maintainer"]);

export async function buildCommandSurfaceMap(): Promise<CommandSurfaceMap> {
  const registry = registryEntries();
  const commandNames = commandTable.map((entry) => entry.cliCommand);
  const toolNames = commandTable.map((entry) => entry.name);
  const commandToEntry = new Map(registry.map((entry) => [entry.cliCommand, entry]));
  const metadataIssues = validateCommandMetadata(commandTable);
  const contractIssues = validateToolContracts(toolSchemas).issues;
  const actionMetadataIssues = validateActionMetadata(commandToEntry);
  const scans: SourceScan[] = [
    {
      label: "command-table",
      path: "lib/command-table.ts",
      commands: commandNames,
      toolNames,
      missingCommands: [],
      missingToolNames: [],
      unregisteredCommands: [],
      unregisteredToolNames: [],
      required: true,
    },
  ];
  return {
    ok:
      metadataIssues.length === 0 &&
      contractIssues.length === 0 &&
      actionMetadataIssues.length === 0,
    registry,
    scans,
    missingPublicReferences: [],
    metadataIssues,
    contractIssues,
    actionMetadataIssues,
    argumentIssues: [],
    internalReferences: [],
  };
}

function registryEntries(): RegistryEntry[] {
  return commandTable
    .map((entry) => ({
      name: entry.name,
      cliCommand: entry.cliCommand,
      category: entry.category,
      audience: entry.audience,
      public: true,
      internal: false,
      source: "lib/command-table.ts",
    }))
    .sort((a, b) => a.cliCommand.localeCompare(b.cliCommand));
}

function validateCommandMetadata(commands: readonly CommandDefinition[]): string[] {
  const issues: string[] = [];
  const cliNames = new Set<string>();
  const toolNames = new Set<string>();
  for (const command of commands) {
    if (!VALID_CATEGORIES.has(command.category)) {
      issues.push(`${command.cliCommand}: missing or invalid category`);
    }
    if (!VALID_AUDIENCES.has(command.audience)) {
      issues.push(`${command.cliCommand}: missing or invalid audience`);
    }
    if (!command.handler) issues.push(`${command.cliCommand}: missing handler binding`);
    if (!command.help.length) issues.push(`${command.cliCommand}: missing help usage`);
    if (cliNames.has(command.cliCommand))
      issues.push(`${command.cliCommand}: duplicate CLI command`);
    if (toolNames.has(command.name)) issues.push(`${command.name}: duplicate tool name`);
    cliNames.add(command.cliCommand);
    toolNames.add(command.name);
    if (command.compatibility) {
      if (!command.compatibility.error.trim()) {
        issues.push(`${command.cliCommand}: compatibility command missing migration error`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(command.compatibility.removeAfter)) {
        issues.push(`${command.cliCommand}: compatibility command missing removal date`);
      }
      if (!cliNames.has(command.compatibility.replacement)) {
        const replacementExists = commands.some(
          (candidate) => candidate.cliCommand === command.compatibility?.replacement,
        );
        if (!replacementExists) {
          issues.push(
            `${command.cliCommand}: replacement ${command.compatibility.replacement} is not registered`,
          );
        }
      }
    }
  }
  return issues;
}

function validateActionMetadata(commandToEntry: Map<string, RegistryEntry>): string[] {
  const issues: string[] = [];
  for (const [kind, metadata] of Object.entries(ACTION_METADATA)) {
    if (!metadata.label.trim()) issues.push(`${kind}: missing action label`);
    if (!metadata.commandLabel.trim()) issues.push(`${kind}: missing command label`);
    if (!metadata.safeAction.trim()) {
      issues.push(`${kind}: missing safeAction`);
    } else if (!commandToEntry.has(metadata.safeAction)) {
      issues.push(`${kind}: safeAction ${metadata.safeAction} is not a registered CLI command`);
    }
    if (!metadata.fallbackKeys.length) issues.push(`${kind}: missing fallback keys`);
    if (new Set(metadata.fallbackKeys).size !== metadata.fallbackKeys.length) {
      issues.push(`${kind}: duplicate fallback keys`);
    }
  }
  return issues;
}

export function formatCommandSurfaceMap(map: CommandSurfaceMap): string {
  const lines = ["Command surface map", "", `Registry commands: ${map.registry.length} public`];
  lines.push(`metadata: missing=${map.metadataIssues.length}`);
  if (map.metadataIssues.length) lines.push(`  metadata issues: ${map.metadataIssues.join(", ")}`);
  lines.push(`contracts: issues=${map.contractIssues.length}`);
  if (map.contractIssues.length) lines.push(`  contract issues: ${map.contractIssues.join(", ")}`);
  lines.push(`action metadata: issues=${map.actionMetadataIssues.length}`);
  if (map.actionMetadataIssues.length) {
    lines.push(`  action metadata issues: ${map.actionMetadataIssues.join(", ")}`);
  }
  for (const scan of map.scans) {
    lines.push(`${scan.label}: ${scan.path}; missing=0; unregistered=0`);
  }
  return lines.join("\n");
}

async function main() {
  const map = await buildCommandSurfaceMap();
  console.log(
    process.argv.includes("--json") ? JSON.stringify(map, null, 2) : formatCommandSurfaceMap(map),
  );
  process.exit(map.ok ? 0 : 1);
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) await main();
