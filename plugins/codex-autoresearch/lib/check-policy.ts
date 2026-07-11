import path from "node:path";

import { enumOption } from "./cli/args.js";
import { pathExists } from "./session-core.js";
import type { UnknownRecord } from "./types/json.js";

const CHECKS_POLICIES = new Set(["always", "on-improvement", "manual"]);

export async function defaultChecksCommand(workDir: string): Promise<string | null> {
  if (await pathExists(path.join(workDir, "autoresearch.checks.ps1"))) {
    return "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.checks.ps1";
  }
  if (await pathExists(path.join(workDir, "autoresearch.checks.sh"))) {
    return "bash ./autoresearch.checks.sh";
  }
  return null;
}

export function checksPolicyFromArgs(args: UnknownRecord, config: UnknownRecord): string | null {
  return enumOption(
    args.checks_policy ?? args.checksPolicy ?? config.checksPolicy,
    CHECKS_POLICIES,
    "always",
    "checksPolicy",
  );
}

export function shouldRunChecks(
  policy: string | null,
  context: {
    benchmarkPassed: boolean;
    checksCommand: string;
    explicitChecksCommand: boolean;
    improvesPrimary: boolean;
    primaryPresent: boolean;
  },
): boolean {
  if (!context.benchmarkPassed || !context.primaryPresent || !context.checksCommand) return false;
  if (policy === "always") return true;
  if (policy === "on-improvement") {
    return context.improvesPrimary || context.explicitChecksCommand;
  }
  return context.explicitChecksCommand;
}
