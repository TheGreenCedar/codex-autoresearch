import { firstSafeCommand } from "./safe-command-resolver.js";

export type PreflightStatus = "blocked" | "ready" | "unknown";

export interface PreflightAuditInput {
  metricName?: unknown;
  benchmarkCommand?: unknown;
  benchmarkLintCommand?: unknown;
  doctorCommand?: unknown;
  setupPlanCommand?: unknown;
  gateQuality?: {
    posture?: unknown;
    blockers?: unknown[];
    warnings?: unknown[];
  } | null;
  scaffoldHealth?: unknown;
  warningDetails?: unknown[];
  runtimeDrift?: {
    installedRuntime?: unknown;
    builtRuntime?: unknown;
    nextActionHint?: unknown;
  } | null;
  setupMissing?: unknown[];
  runs?: unknown;
}

export interface PreflightAudit {
  status: PreflightStatus;
  blockers: string[];
  warnings: string[];
  checked: string[];
  nextCommand: string;
}

export function buildPreflightAudit(input: PreflightAuditInput): PreflightAudit {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const checked: string[] = [];

  if (cleanString(input.metricName)) {
    checked.push("primary metric configured");
  } else {
    blockers.push("No primary metric is configured.");
  }

  const runCount = Number(input.runs ?? 0);
  if (cleanString(input.benchmarkCommand)) {
    checked.push("benchmark command available");
  } else {
    blockers.push(
      runCount === 0
        ? "No benchmark command is available for the first packet."
        : "No benchmark command is available for future packets.",
    );
  }

  for (const missing of stringList(input.setupMissing)) {
    blockers.push(`Missing setup field: ${missing}.`);
  }

  const gate = input.gateQuality || null;
  if (gate) {
    const gatePosture = cleanString(gate.posture) || "unknown";
    checked.push(`gate quality: ${gatePosture}`);
    blockers.push(...stringList(gate.blockers));
    warnings.push(...stringList(gate.warnings));
    if (
      (gatePosture === "missing" || gatePosture === "advisory-missing") &&
      Number(input.runs ?? 0) === 0
    ) {
      warnings.push("No independent checks gate is configured for the first packet.");
    }
  }

  const scaffoldBlockers = scaffoldHealthBlockers(input.scaffoldHealth);
  blockers.push(...scaffoldBlockers);
  if (scaffoldBlockers.length === 0 && input.scaffoldHealth) {
    checked.push("scaffold health checked");
  }

  for (const warning of warningDetails(input.warningDetails)) {
    if (warning.severity === "blocker") blockers.push(warning.message);
    else warnings.push(warning.message);
  }

  const runtime = input.runtimeDrift || null;
  if (runtime) {
    checked.push(`runtime drift: ${cleanString(runtime.installedRuntime) || "unknown"}`);
    if (runtime.installedRuntime === "stale") {
      warnings.push(
        cleanString(runtime.nextActionHint) ||
          "Installed runtime drift is stale; refresh it before claiming installed-plugin behavior.",
      );
    } else if (
      runtime.installedRuntime === "missing" ||
      runtime.installedRuntime === "unavailable"
    ) {
      warnings.push(
        cleanString(runtime.nextActionHint) || "Runtime drift evidence is unavailable.",
      );
    }
    if (runtime.builtRuntime === "missing") {
      blockers.push(cleanString(runtime.nextActionHint) || "Build or inspect the local runtime.");
    } else if (runtime.builtRuntime === "unavailable") {
      warnings.push(cleanString(runtime.nextActionHint) || "Inspect the local runtime build.");
    }
  }

  const uniqueBlockers = uniqueStrings(blockers);
  const uniqueWarnings = uniqueStrings(warnings).filter(
    (warning) => !uniqueBlockers.includes(warning),
  );
  return {
    status: uniqueBlockers.length > 0 ? "blocked" : checked.length > 0 ? "ready" : "unknown",
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    checked: uniqueStrings(checked),
    nextCommand: nextCommand(input, uniqueBlockers, uniqueWarnings),
  };
}

function nextCommand(input: PreflightAuditInput, blockers: string[], warnings: string[]): string {
  const benchmarkLintCommand = cleanString(input.benchmarkLintCommand);
  const doctorCommand = cleanString(input.doctorCommand);
  const setupPlanCommand = cleanString(input.setupPlanCommand);
  if (blockers.some((blocker) => /benchmark|metric|setup|gate/i.test(blocker))) {
    if (
      blockers.some((blocker) =>
        /No benchmark command|Missing setup|No primary metric/i.test(blocker),
      )
    ) {
      return firstSafeCommand(
        [setupPlanCommand, benchmarkLintCommand, doctorCommand],
        "operational",
      );
    }
    return firstSafeCommand([benchmarkLintCommand, setupPlanCommand, doctorCommand], "operational");
  }
  if (blockers.length > 0 || warnings.some((warning) => /dirty|runtime|stale/i.test(warning))) {
    return firstSafeCommand([doctorCommand, benchmarkLintCommand], "operational");
  }
  return firstSafeCommand([benchmarkLintCommand, doctorCommand], "operational");
}

function scaffoldHealthBlockers(value: unknown): string[] {
  const record = recordOrNull(value);
  const checks = Array.isArray(record?.checks) ? record.checks : [];
  return checks
    .map(recordOrNull)
    .filter((check) => check?.severity === "blocker")
    .map((check) => cleanString(check?.message || check?.code))
    .filter(Boolean);
}

function warningDetails(value: unknown): Array<{ severity: string; message: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map(recordOrNull)
    .map((warning) => ({
      severity: cleanString(warning?.severity),
      message: cleanString(warning?.message || warning?.code),
    }))
    .filter((warning) => warning.message);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
