import { commandDefinitionForCli, commandTable } from "../command-table.js";

export interface HelpOptions {
  all?: boolean;
  command?: string | null;
}

const HAPPY_PATH = "setup -> doctor -> next -> log -> state -> finalize-preview";

const FULL_GUIDANCE_LINES = [
  "",
  "Global authorization:",
  "  --allow-outside-workdir permits a configured workingDir outside --cwd for this command only.",
  "  Packet processes use a minimal environment by default; pass --packet-env-mode inherit to inherit credentials.",
  "",
  "Current-tree finalization:",
  "  finalize-current-tree is for stale or incomplete commit-level kept evidence when the current branch tree is the review unit.",
  "  It writes a plan only from a clean Git-backed non-trunk source branch; session artifacts are excluded by default.",
  "  After reviewing the plan, run the finalizer with that plan file.",
];

export function renderCliHelp({ all = false, command = null }: HelpOptions = {}): string {
  if (command) return renderCommandHelp(command);
  const commands = all ? commandTable : commandTable.filter((entry) => entry.defaultHelp);
  const planningCommands = commands.filter(
    (entry) => !all && entry.category === "setup" && entry.actionPolicy === "read",
  );
  const usageLines = all
    ? commands.flatMap((entry) => entry.help.map(indentUsage))
    : [
        "  Read-only planning:",
        ...planningCommands.flatMap((entry) => entry.help.map(indentUsage)),
        "  Writes session files:",
        ...commands
          .filter((entry) => !planningCommands.includes(entry))
          .flatMap((entry) => entry.help.map(indentUsage)),
      ];
  const sections = [
    "Codex Autoresearch",
    "",
    `Happy path: ${HAPPY_PATH}`,
    "",
    "Usage:",
    ...usageLines,
  ];
  if (!all) {
    sections.push("", "Run `--help --all` for advanced diagnostics and maintainer commands.");
  } else {
    sections.push(...FULL_GUIDANCE_LINES);
  }
  const compatibility = commandTable.filter((entry) => entry.compatibility);
  if (all && compatibility.length) {
    sections.push("", "Compatibility commands:");
    for (const entry of compatibility) {
      const migration = entry.compatibility!;
      sections.push(
        `  ${entry.cliCommand} -> ${migration.replacement}; removal after ${migration.removeAfter}`,
      );
    }
  }
  sections.push(
    "",
    "Global options:",
    "  -h, --help  Show root or command help.",
    "  --debug     Include a stack trace when a command fails.",
    "",
    "Benchmark output format:",
    "  METRIC name=value",
    "  ARTIFACT name=path",
    "",
  );
  return sections.join("\n");
}

function renderCommandHelp(command: string): string {
  const definition = commandDefinitionForCli(command);
  const usage = definition?.help.length
    ? definition.help.map(indentUsage)
    : [`  node scripts/autoresearch.mjs ${command}`];
  const sections = ["Codex Autoresearch", "", `Command: ${command}`, "", "Usage:", ...usage];
  if (definition?.compatibility) sections.push("", `Migration: ${definition.compatibility.error}`);
  sections.push(
    "",
    "Options:",
    "  -h, --help  Show this help.",
    "  --debug     Include a stack trace when the command fails.",
    "",
  );
  return sections.join("\n");
}

function indentUsage(usage: string): string {
  return `  ${usage}`;
}
