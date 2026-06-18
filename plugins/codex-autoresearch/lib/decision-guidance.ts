import path from "node:path";
import { evaluateGateQuality } from "./gate-quality.js";
import { buildPreflightAudit } from "./preflight-audit.js";
import {
  inspectRuntimeDrift,
  summarizeRuntimeAuthority,
  type RuntimeTrustScope,
} from "./runtime-drift-doctor.js";
import { unknownRecordOrEmpty, unknownRecordOrNull, type UnknownRecord } from "./types/json.js";

type LooseObject = UnknownRecord;

export interface DecisionGuidanceInput {
  workDir: string;
  pluginRoot: string;
  pluginVersion: string;
  config?: LooseObject | null;
  state?: LooseObject | null;
  scaffoldHealth?: unknown;
  warningDetails?: unknown[];
  setupMissing?: unknown[];
  qualityConstraints?: Array<Record<string, unknown>> | null;
  runtimeDriftSummary?: LooseObject | null;
  runtimeTrustScope?: RuntimeTrustScope;
  benchmarkCommand?: unknown;
  checksCommand?: unknown;
  defaultBenchmarkCommand: (workDir: string) => Promise<string> | string;
  defaultChecksCommand: (workDir: string) => Promise<string | null> | string | null;
  renderCommand: (argv: readonly unknown[]) => string;
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
  qualityConstraints = null,
  runtimeDriftSummary = null,
  runtimeTrustScope = "source-checkout",
  benchmarkCommand = "",
  checksCommand = "",
  defaultBenchmarkCommand,
  defaultChecksCommand,
  renderCommand,
  errorMessage,
}: DecisionGuidanceInput): Promise<LooseObject> {
  const configRecord = unknownRecordOrEmpty(config);
  const stateRecord = unknownRecordOrEmpty(state);
  const stateConfig = unknownRecordOrEmpty(stateRecord.config);
  const resolvedBenchmarkCommand =
    cleanString(benchmarkCommand) ||
    cleanString(configRecord.benchmarkCommand) ||
    (await defaultBenchmarkCommandOrEmpty(defaultBenchmarkCommand, workDir));
  const resolvedChecksCommand =
    cleanString(checksCommand) ||
    cleanString(configRecord.checksCommand) ||
    cleanString(await defaultChecksCommand(workDir));
  const commandAuthority = {
    benchmarkCommand: resolvedBenchmarkCommand,
    checksCommand: resolvedChecksCommand,
  };
  const metricName = cleanString(stateConfig.metricName || configRecord.metricName) || "metric";
  const benchmarkLintCommand = resolvedBenchmarkCommand
    ? renderCommand([
        "node",
        path.join(pluginRoot, "scripts", "autoresearch.mjs"),
        "benchmark-lint",
        "--cwd",
        workDir,
        "--metric-name",
        metricName,
        "--command",
        resolvedBenchmarkCommand,
      ])
    : "";
  const doctorCommand = renderCommand([
    "node",
    path.join(pluginRoot, "scripts", "autoresearch.mjs"),
    "doctor",
    "--cwd",
    workDir,
    "--check-benchmark",
    "--explain",
  ]);
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
  const runtimeAuthority = summarizeRuntimeAuthority({
    sourceRuntime: runtimeStatusFromSummary(runtimeSummary, "source"),
    installedRuntime: runtimeStatusFromSummary(runtimeSummary, "installed"),
    trustScope: runtimeTrustScope,
  });
  const gateQuality = evaluateGateQuality({
    benchmarkCommand: resolvedBenchmarkCommand,
    checksCommand: resolvedChecksCommand,
    checksPolicy: cleanString(configRecord.checksPolicy) || "always",
    checksRequired: stringList(setupMissing).includes("checks_command"),
    qualityConstraints,
    promotion: unknownRecordOrNull(stateRecord.promotion),
    holdout: holdoutMetadata(config),
  });

  return {
    gateQuality,
    commandAuthority,
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
      runs: Array.isArray(stateRecord.current) ? stateRecord.current.length : stateRecord.runs,
    }),
    runtimeDriftSummary: runtimeSummary,
    runtimeAuthority,
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
  const record = unknownRecordOrEmpty(config);
  if (!Object.keys(record).length) return null;
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
    if (record[field]) return { [field]: record[field] };
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

function runtimeStatusFromSummary(runtimeSummary: LooseObject, kind: "source" | "installed") {
  if (kind === "source") {
    const builtRuntime = cleanString(runtimeSummary.builtRuntime);
    if (!builtRuntime) return null;
    const sourceVersion = cleanString(runtimeSummary.sourceVersion);
    return {
      status: builtRuntime === "available" ? "fresh" : builtRuntime,
      ...(sourceVersion ? { version: sourceVersion } : {}),
    };
  }
  const installedRuntime = cleanString(runtimeSummary.installedRuntime);
  if (!installedRuntime) return null;
  return { status: installedRuntime };
}
