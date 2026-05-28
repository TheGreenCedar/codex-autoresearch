import { resolveDecisionThresholds } from "./decision-thresholds.js";
import { commandClassFor, type RunnerProgressSnapshot } from "./runner-progress.js";
import { finiteMetric } from "./session-core.js";

type LooseObject = Record<string, any>;

export type RuntimeClass = "short" | "medium" | "long" | "expensive";

export interface ExperimentEconomicsWarning {
  code: string;
  message: string;
  recommendation: string;
  details?: LooseObject;
}

export interface ExperimentEconomicsSummary {
  runtimeClass: RuntimeClass;
  expectedRuntimeSeconds: number | null;
  baselineFreshness: "missing" | "current" | "stale" | "unknown";
  freshRunRequired: boolean;
  freshRunReason: string;
  warnings: ExperimentEconomicsWarning[];
  progress: RunnerProgressSnapshot | null;
}

export function runtimeClassFor(seconds: unknown, fallbackLong = false): RuntimeClass {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return fallbackLong ? "expensive" : "medium";
  if (value < 60) return "short";
  if (value < 600) return "medium";
  if (value < 1800) return "long";
  return "expensive";
}

export function analyzeExperimentEconomics({
  state = {},
  lastRun = null,
  progress = null,
  thresholds: thresholdConfig = {},
}: LooseObject = {}): ExperimentEconomicsSummary {
  const thresholds = resolveDecisionThresholds({ decisionThresholds: thresholdConfig });
  const runs = Array.isArray(state.current) ? state.current : [];
  const recentRuns = runs.slice(-thresholds.repeatedSmallProbeWindow);
  const warnings: ExperimentEconomicsWarning[] = [];
  const lastDuration =
    finiteMetric(lastRun?.run?.durationSeconds) ??
    finiteMetric(progress?.elapsedSeconds) ??
    finiteMetric(lastRun?.packetEvidence?.progressSnapshot?.elapsedSeconds) ??
    median(
      recentRuns
        .map((run: LooseObject) => finiteMetric(run.durationSeconds ?? run.elapsedSeconds))
        .filter((value: number | null): value is number => value != null),
    );
  const runtimeClass = runtimeClassFor(
    lastDuration,
    Boolean(progress?.staleProgressReason || lastRun?.packetEvidence?.timedOut),
  );
  const outerTimeout = finiteMetric(lastRun?.packetEvidence?.timeoutSeconds);
  const innerTimeout = innerTimeoutSeconds(lastRun);
  if (outerTimeout != null && innerTimeout != null && outerTimeout < innerTimeout) {
    warnings.push({
      code: "outer_timeout_shorter_than_inner",
      message: `Packet timeout ${outerTimeout}s is shorter than inner workload timeout ${innerTimeout}s.`,
      recommendation:
        "Raise the outer packet timeout or lower the inner benchmark timeout before rerunning.",
      details: { outerTimeout, innerTimeout },
    });
  }
  const repeated = repeatedSmallProbeWarning(recentRuns, thresholds, runtimeClass);
  if (repeated) warnings.push(repeated);
  if (progress?.staleProgressReason) {
    warnings.push({
      code: "stale_progress",
      message: progress.staleProgressReason,
      recommendation: "Inspect the active artifact or child command before restarting the packet.",
      details: {
        commandClass: progress.commandClass,
        latestArtifactRow: progress.latestArtifactRow,
      },
    });
  }
  const baselineFreshness = baselineFreshnessFor(state);
  return {
    runtimeClass,
    expectedRuntimeSeconds: lastDuration,
    baselineFreshness,
    freshRunRequired: baselineFreshness !== "current" || warnings.length > 0,
    freshRunReason:
      baselineFreshness === "current" && warnings.length === 0
        ? "Current segment has baseline evidence and no economics warning."
        : warnings[0]?.recommendation || "Run a fresh packet after restoring baseline confidence.",
    warnings,
    progress,
  };
}

function repeatedSmallProbeWarning(
  recentRuns: LooseObject[],
  thresholds: ReturnType<typeof resolveDecisionThresholds>,
  runtimeClass: RuntimeClass,
): ExperimentEconomicsWarning | null {
  if (!["medium", "long", "expensive"].includes(runtimeClass)) return null;
  const weakRuns = recentRuns.filter(isRejectedOrRegressed);
  if (weakRuns.length < thresholds.repeatedSmallProbeMinimum) return null;
  return {
    code: "repeated_small_probe",
    message: `${weakRuns.length} of the last ${recentRuns.length} runs were rejected, crashed, checks-failed, or regressed.`,
    recommendation:
      "Pivot to a changed precondition or distant-scout lane before spending another packet.",
    details: {
      runs: weakRuns.map((run) => run.run).filter(Boolean),
      runtimeClass,
    },
  };
}

function isRejectedOrRegressed(run: LooseObject): boolean {
  const status = String(run.status || "");
  if (["discard", "crash", "checks_failed"].includes(status)) return true;
  return Boolean(run.asi?.regression || run.regression || run.promotion?.label === "invalidated");
}

function baselineFreshnessFor(state: LooseObject): ExperimentEconomicsSummary["baselineFreshness"] {
  if (finiteMetric(state.baseline) == null) return "missing";
  if (state.config?.benchmarkContractChanged || state.benchmarkConfigDrift?.drifted) return "stale";
  return "current";
}

function innerTimeoutSeconds(lastRun: LooseObject | null): number | null {
  const explicit =
    finiteMetric(lastRun?.run?.benchmarkContract?.innerTimeoutSeconds) ??
    finiteMetric(lastRun?.run?.innerTimeoutSeconds) ??
    finiteMetric(lastRun?.packetEvidence?.commandIdentity?.innerTimeoutSeconds);
  if (explicit != null) return explicit;
  const command = String(
    lastRun?.packetEvidence?.commandIdentity?.command || lastRun?.run?.command || "",
  );
  const parsed = parseTimeoutFromCommand(command);
  return parsed ?? null;
}

function parseTimeoutFromCommand(command: string): number | null {
  const match = command.match(
    /(?:--(?:test[-_]?timeout(?:-seconds|Seconds)?)|--timeout(?:-seconds|Seconds)?|timeout(?:Seconds)?)=?\s*([0-9.]+)/i,
  );
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const flag = match[0].replace(/\s*=?[\s]*[0-9.]+$/, "");
  const usesMilliseconds = /--test[-_]?timeout(?![-_]?seconds)/i.test(flag) && value > 1000;
  return usesMilliseconds ? value / 1000 : value;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function economicsCommandClass(lastRun: LooseObject | null): string {
  return commandClassFor(
    lastRun?.packetEvidence?.commandIdentity?.command || lastRun?.run?.command || "",
  );
}
