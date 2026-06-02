import path from "node:path";
import { evaluateGateQuality } from "./gate-quality.js";
import { buildPreflightAudit } from "./preflight-audit.js";
import { inspectRuntimeDrift } from "./runtime-drift-doctor.js";

type LooseObject = Record<string, any>;

export interface DecisionGuidanceInput {
  workDir: string;
  pluginRoot: string;
  pluginVersion: string;
  config?: LooseObject | null;
  state?: LooseObject | null;
  scaffoldHealth?: unknown;
  warningDetails?: unknown[];
  setupMissing?: unknown[];
  runtimeDriftSummary?: LooseObject | null;
  benchmarkCommand?: unknown;
  checksCommand?: unknown;
  defaultBenchmarkCommand: (workDir: string) => Promise<string> | string;
  defaultChecksCommand: (workDir: string) => Promise<string | null> | string | null;
  shellQuote: (value: string) => string;
  errorMessage: (error: unknown) => string;
}

export async function buildDecisionGuidanceContext({
  workDir,
  pluginRoot,
  pluginVersion,
  config = null,
  state = null,
  scaffoldHealth = null,
  warningDetails = [],
  setupMissing = [],
  runtimeDriftSummary = null,
  benchmarkCommand = "",
  checksCommand = "",
  defaultBenchmarkCommand,
  defaultChecksCommand,
  shellQuote,
  errorMessage,
}: DecisionGuidanceInput): Promise<LooseObject> {
  const resolvedBenchmarkCommand =
    cleanString(benchmarkCommand) ||
    (await defaultBenchmarkCommandOrEmpty(defaultBenchmarkCommand, workDir));
  const resolvedChecksCommand =
    cleanString(checksCommand) || cleanString(await defaultChecksCommand(workDir));
  const metricName = state?.config?.metricName || config?.metricName || "metric";
  const benchmarkLintCommand = resolvedBenchmarkCommand
    ? `node ${shellQuote(path.join(pluginRoot, "scripts", "autoresearch.mjs"))} benchmark-lint --cwd ${shellQuote(workDir)} --metric-name ${shellQuote(metricName)} --command ${shellQuote(resolvedBenchmarkCommand)}`
    : "";
  const doctorCommand = `node ${shellQuote(path.join(pluginRoot, "scripts", "autoresearch.mjs"))} doctor --cwd ${shellQuote(workDir)} --check-benchmark --explain`;
  const runtimeSummary =
    runtimeDriftSummary ||
    (await inspectRuntimeDrift({
      packageRoot: pluginRoot,
      sourceVersion: pluginVersion,
    }).catch((error: unknown) => ({
      sourceVersion: pluginVersion,
      packageRoot: pluginRoot,
      installedRuntime: "unavailable",
      builtRuntime: "unavailable",
      smokeCheck: "",
      nextActionHint: `Runtime drift inspection failed: ${errorMessage(error)}`,
    })));
  const gateQuality = evaluateGateQuality({
    benchmarkCommand: resolvedBenchmarkCommand,
    checksCommand: resolvedChecksCommand,
    checksPolicy: config?.checksPolicy || "always",
    checksRequired: stringList(setupMissing).includes("checks_command"),
    promotion: state?.promotion || null,
    holdout: holdoutMetadata(config),
  });

  return {
    gateQuality,
    preflight: buildPreflightAudit({
      metricName,
      benchmarkCommand: resolvedBenchmarkCommand,
      benchmarkLintCommand,
      doctorCommand,
      gateQuality,
      scaffoldHealth,
      warningDetails,
      runtimeDrift: runtimeSummary,
      setupMissing,
      runs: Array.isArray(state?.current) ? state.current.length : state?.runs,
    }),
    runtimeDriftSummary: runtimeSummary,
  };
}

async function defaultBenchmarkCommandOrEmpty(
  defaultBenchmarkCommand: (workDir: string) => Promise<string> | string,
  workDir: string,
): Promise<string> {
  try {
    return cleanString(await defaultBenchmarkCommand(workDir));
  } catch {
    return "";
  }
}

function holdoutMetadata(config: LooseObject | null | undefined): LooseObject | null {
  if (!config) return null;
  const fields = [
    "holdoutCommand",
    "holdout_command",
    "devHoldoutSplit",
    "dev_holdout_split",
    "promotionBenchmarkCommand",
    "promotion_benchmark_command",
    "benchmarkIntegrityCommand",
    "benchmark_integrity_command",
  ];
  for (const field of fields) {
    if (config[field]) return { [field]: config[field] };
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item)).filter(Boolean);
}

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}
