import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { finiteMetric, isPromotionGradeRun, promotionGradeValue } from "./session-core.js";

type LooseObject = Record<string, any>;

const FAILURE_STATUSES = new Set(["discard", "crash", "checks_failed"]);

export async function buildScaffoldHealth({
  workDir,
  config = {},
}: {
  workDir: string;
  config?: LooseObject;
}) {
  const checks = [
    ...(await wrapperHealthChecks(workDir)),
    ...configuredPathHealthChecks(workDir, config),
  ];
  const gitLock = await gitIndexLockHealth(workDir);
  if (gitLock) checks.push(gitLock);
  const dirtyFiles = await classifyDirtyFiles(workDir, config).catch(() => null);
  const blockers = checks.filter((check) => check.severity === "blocker");
  return {
    ok: blockers.length === 0,
    status: blockers.length ? "blocked" : checks.length ? "warning" : "ok",
    checks,
    dirtyFiles,
    recoveryGuidance: recoveryGuidance(checks),
  };
}

async function wrapperHealthChecks(workDir: string) {
  const checks: LooseObject[] = [];
  for (const fileName of ["autoresearch.ps1", "autoresearch.sh"]) {
    const filePath = path.join(workDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    const text = await fsp.readFile(filePath, "utf8").catch(() => "");
    if (wrapperCallsItself(fileName, text)) {
      checks.push({
        code: "self_recursive_wrapper",
        severity: "blocker",
        ok: false,
        path: fileName,
        message: `${fileName} appears to call itself instead of a real benchmark workload.`,
        action:
          "Replace the wrapper body with the real benchmark command or rerun setup with --benchmark-command.",
      });
    }
    if (wrapperHasNoWorkload(text)) {
      checks.push({
        code: "missing_benchmark_workload",
        severity: "warning",
        ok: false,
        path: fileName,
        message: `${fileName} does not contain a real benchmark workload yet.`,
        action: "Configure the benchmark command before running the first packet.",
      });
    }
  }
  return checks;
}

function configuredPathHealthChecks(workDir: string, config: LooseObject) {
  const checks: LooseObject[] = [];
  for (const [field, code] of [
    ["commitPaths", "missing_commit_path"],
    ["revertPaths", "missing_revert_path"],
  ] as const) {
    for (const relative of listOption(config[field] ?? config[toSnake(field)])) {
      if (!relativePathLooksSafe(relative)) continue;
      if (fs.existsSync(path.join(workDir, relative))) continue;
      checks.push({
        code,
        severity: "blocker",
        ok: false,
        path: slashPath(relative),
        message: `Configured ${field} path does not exist: ${slashPath(relative)}.`,
        action: `Update ${field} before setup/doctor can trust keep or discard automation.`,
      });
    }
  }
  return checks;
}

export function buildResearchIntegrity({
  state = {},
  config = {},
  parsedMetrics = null,
  metricName = "",
  sample = "",
}: {
  state?: LooseObject;
  config?: LooseObject;
  parsedMetrics?: LooseObject | null;
  metricName?: string;
  sample?: string;
} = {}) {
  const current = Array.isArray(state.current) ? state.current : [];
  const results = Array.isArray(state.results) ? state.results : current;
  const latest = current.at(-1) || null;
  const bestDevelopment = state.development?.bestRun || bestKeptRun(current, state.config);
  const promotionBest = state.promotion?.bestRun || null;
  const metrics = parsedMetrics || latest?.metrics || {};
  const primaryMetricName = metricName || state.config?.metricName || config.metricName || "metric";
  const labels = buildResearchEvidenceLabels({
    current,
    latest,
    results,
    segment: state.segment,
    bestDevelopment,
    promotionBest,
  });
  const perfectSignals = buildPerfectMetricSignals({
    metrics,
    primaryMetricName,
    bestDevelopment,
  });
  const promotionGrade = bestDevelopment ? promotionGradeValue(bestDevelopment) : null;
  const hasIntegrityGuard = hasConfiguredIntegrityGuard(config);
  const { warnings, blockers } = buildResearchIntegrityMessages({
    current,
    latest,
    results,
    parsedMetrics,
    bestDevelopment,
    perfectSignals,
    promotionGrade,
    hasIntegrityGuard,
  });
  const notPromotableBecause = buildPromotabilityReasons(warnings, blockers);

  return {
    ok: blockers.length === 0 && warnings.length === 0,
    evidenceLabels: labels,
    currentLabel: labels[0] || "blocked",
    metricParsing: parsedMetrics
      ? {
          checked: true,
          metricName: primaryMetricName,
          parsedMetricCount: Object.keys(parsedMetrics).length,
        }
      : { checked: false },
    promotion: buildPromotionSummary(labels, state),
    suspiciousPerfectMetrics: perfectSignals,
    notPromotableBecause,
    blockers,
    warnings: uniqueStrings(warnings),
    hasIntegrityGuard,
    sampleHash: sample ? simpleHash(sample) : "",
  };
}

function buildResearchEvidenceLabels({
  current,
  latest,
  results,
  segment,
  bestDevelopment,
  promotionBest,
}: {
  current: LooseObject[];
  latest: LooseObject | null;
  results: LooseObject[];
  segment: unknown;
  bestDevelopment: LooseObject | null;
  promotionBest: LooseObject | null;
}) {
  const evidenceLabels = new Set<string>();
  if (results.some((run) => run.segment !== segment)) evidenceLabels.add("historical");
  if (!current.length) evidenceLabels.add("blocked");
  if (latest && FAILURE_STATUSES.has(latest.status)) {
    evidenceLabels.add(invalidationText(latest) ? "invalidated" : "blocked");
  }
  if (bestDevelopment && bestDevelopment.status === "keep") {
    if (isPromotionGradeRun(bestDevelopment)) evidenceLabels.add("promotion_eligible");
    else evidenceLabels.add("dev_best");
  }
  if (promotionBest) evidenceLabels.add("promotion_eligible");
  if (latest && pendingRepeat(latest)) evidenceLabels.add("pending_repeat");
  if (results.some((run) => run.status === "discard" && invalidationText(run))) {
    evidenceLabels.add("invalidated");
  }
  return [...evidenceLabels];
}

function buildPerfectMetricSignals({
  metrics,
  primaryMetricName,
  bestDevelopment,
}: {
  metrics: LooseObject;
  primaryMetricName: string;
  bestDevelopment: LooseObject | null;
}) {
  const perfect = suspiciousPerfectMetrics(metrics, primaryMetricName);
  const bestPerfect = bestDevelopment
    ? suspiciousPerfectMetrics(
        { [primaryMetricName]: bestDevelopment.metric, ...bestDevelopment.metrics },
        primaryMetricName,
      )
    : [];
  return uniqueStrings([...perfect, ...bestPerfect]);
}

function buildResearchIntegrityMessages({
  current,
  latest,
  results,
  parsedMetrics,
  bestDevelopment,
  perfectSignals,
  promotionGrade,
  hasIntegrityGuard,
}: {
  current: LooseObject[];
  latest: LooseObject | null;
  results: LooseObject[];
  parsedMetrics: LooseObject | null;
  bestDevelopment: LooseObject | null;
  perfectSignals: string[];
  promotionGrade: unknown;
  hasIntegrityGuard: boolean;
}) {
  const warnings: string[] = [];
  const blockers: string[] = [];
  if (perfectSignals.length && promotionGrade !== true) {
    warnings.push(
      `Perfect metric signal (${perfectSignals.join(", ")}) is dev-only until repeat, freshness, breadth, and holdout/promotion metadata are present.`,
    );
  }
  if (bestDevelopment && bestDevelopment.status === "keep" && promotionGrade !== true) {
    warnings.push(
      "Current best is development-only; it is not promotable without promotion-grade metadata.",
    );
  }
  if (latest && pendingRepeat(latest)) {
    warnings.push(
      "Latest improvement is pending repeat; promotion is blocked until repeat passes.",
    );
  }
  if (!hasIntegrityGuard && (current.length === 0 || parsedMetrics)) {
    warnings.push(
      "Research integrity is incomplete: no holdout, repeat, contamination, or promotion guard is configured.",
    );
  }
  const invalidated = results.filter((run) => invalidationText(run));
  if (invalidated.length) {
    blockers.push("A later ledger entry explicitly invalidated or contaminated previous evidence.");
  }
  return { warnings, blockers };
}

function buildPromotabilityReasons(warnings: string[], blockers: string[]) {
  return uniqueStrings([
    ...warnings.filter((warning) =>
      /not promotable|dev-only|pending repeat|perfect|integrity/i.test(warning),
    ),
    ...blockers,
  ]);
}

function buildPromotionSummary(labels: string[], state: LooseObject) {
  return {
    eligible: labels.includes("promotion_eligible"),
    best: state.promotion?.best ?? null,
    kept: state.promotion?.kept ?? 0,
  };
}

export function commandDiagnostics({
  command = "",
  commandFile = "",
  envFile = "",
  separatorCommand = false,
  result = null,
}: LooseObject = {}) {
  const output = `${result?.stdout || ""}\n${result?.stderr || ""}\n${result?.output || ""}\n${result?.fullOutput || ""}`;
  const hints: string[] = [];
  if (separatorCommand) {
    hints.push("Command was parsed from the explicit -- separator.");
  }
  if (result && (result.exitCode !== 0 || result.timedOut)) {
    if (
      /ParserError|Unexpected token|not recognized|cannot find|No such file|The term '.+' is not recognized/i.test(
        output,
      )
    ) {
      hints.push(
        "This looks like command-shape or quoting failure. Prefer --command-file for multi-line commands or --packet-env-file/--env-file for environment setup.",
      );
    }
    if (!commandFile) {
      hints.push("Use --command-file when shell quoting is uncertain, especially on Windows.");
    }
  }
  return {
    source: commandFile ? "command_file" : separatorCommand ? "separator" : "inline",
    commandFile,
    envFile,
    commandLength: String(command || "").length,
    tokenEstimate: shellTokenEstimate(command),
    hints: uniqueStrings(hints),
  };
}

function wrapperCallsItself(fileName: string, text: string) {
  if (!text) return false;
  const escaped = escapeRegExp(fileName);
  const relativePrefix = String.raw`(?:\.[\\/])?`;
  const patterns = fileName.endsWith(".ps1")
    ? [
        new RegExp(
          `(?:powershell|pwsh)[^\\n\\r]*(?:-File\\s+)?["']?${relativePrefix}${escaped}`,
          "i",
        ),
        new RegExp(`&\\s*["']?${relativePrefix}${escaped}`, "i"),
      ]
    : [
        new RegExp(`\\b(?:bash|sh)\\s+["']?${relativePrefix}${escaped}`, "i"),
        new RegExp(`(?:^|\\s)\\./${escaped}(?:\\s|$)`, "i"),
      ];
  return patterns.some((pattern) => pattern.test(text));
}

function wrapperHasNoWorkload(text: string) {
  return (
    !text.trim() ||
    /Missing .*--benchmark-command|Replace this placeholder|No benchmark command/i.test(text)
  );
}

async function gitIndexLockHealth(workDir: string) {
  const gitPath = await gitOk(["rev-parse", "--git-path", "index.lock"], workDir);
  if (!gitPath.ok || !gitPath.stdout.trim()) return null;
  const lockPath = path.resolve(workDir, gitPath.stdout.trim());
  if (!fs.existsSync(lockPath)) return null;
  const stat = await fsp.stat(lockPath).catch(() => null);
  const ageSeconds = stat ? Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)) : null;
  return {
    code: "git_index_lock",
    severity: "blocker",
    ok: false,
    path: lockPath,
    ageSeconds,
    message: `Git index lock exists${ageSeconds == null ? "" : ` (${ageSeconds}s old)`}: ${lockPath}.`,
    action:
      "Wait for active Git commands to finish; if none are active, remove index.lock and retry the exact command.",
  };
}

async function classifyDirtyFiles(workDir: string, config: LooseObject = {}) {
  const status = await gitOk(["status", "--porcelain=v1", "-uall"], workDir);
  if (!status.ok) return null;
  const commitPaths = listOption(config.commitPaths ?? config.commit_paths).map(slashPath);
  const sessionArtifacts: string[] = [];
  const scopedExperimentFiles: string[] = [];
  const unrelatedFiles: string[] = [];
  for (const line of status.stdout.split(/\r?\n/).filter(Boolean)) {
    const file = slashPath(line.slice(3).replace(/^"|"$/g, ""));
    if (isSessionFile(file)) sessionArtifacts.push(file);
    else if (commitPaths.some((scope) => file === scope || file.startsWith(`${scope}/`))) {
      scopedExperimentFiles.push(file);
    } else {
      unrelatedFiles.push(file);
    }
  }
  return { sessionArtifacts, scopedExperimentFiles, unrelatedFiles };
}

function bestKeptRun(current: LooseObject[], config: LooseObject = {}) {
  const direction = config?.bestDirection === "higher" ? "higher" : "lower";
  let best: LooseObject | null = null;
  for (const run of current.filter((item) => item.status === "keep")) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    if (!best) best = run;
    else if (
      direction === "higher"
        ? metric > finiteMetric(best.metric)!
        : metric < finiteMetric(best.metric)!
    ) {
      best = run;
    }
  }
  return best;
}

function pendingRepeat(run: LooseObject) {
  const metrics = run.metrics || {};
  const asi = run.asi || {};
  return Boolean(
    truthy(metrics.repeatRequired) ||
    truthy(metrics.repeat_required) ||
    truthy(asi.repeatRequired) ||
    truthy(asi.repeat_required) ||
    /pending repeat|repeat required|needs repeat/i.test(
      `${run.description || ""} ${JSON.stringify(asi)}`,
    ),
  );
}

function invalidationText(run: LooseObject) {
  const text = `${run.description || ""} ${JSON.stringify(run.asi || {})}`.toLowerCase();
  return /invalidat|contaminat|taint|failed repeat|cache replay|(?:source|query|holdout|evaluator|benchmark|cache|data)\s+leak(?:age)?/.test(
    text,
  )
    ? text
    : "";
}

function suspiciousPerfectMetrics(metrics: LooseObject = {}, primaryMetricName = "metric") {
  const names: string[] = [];
  for (const [name, rawValue] of Object.entries(metrics || {})) {
    const value = finiteMetric(rawValue);
    if (value == null) continue;
    const metricName = String(name || primaryMetricName);
    if (/quality_gap|gap/i.test(metricName) && value === 0) names.push(`${metricName}=0`);
    else if (/score|quality|hit|mrr|precision|recall|accuracy/i.test(metricName) && value >= 1) {
      names.push(`${metricName}=${value}`);
    }
  }
  return names;
}

function hasConfiguredIntegrityGuard(config: LooseObject = {}) {
  return Boolean(
    config.benchmarkIntegrityCommand ||
    config.benchmark_integrity_command ||
    config.contaminationCheckCommand ||
    config.contamination_check_command ||
    config.promotionBenchmarkCommand ||
    config.promotion_benchmark_command ||
    config.holdoutCommand ||
    config.holdout_command ||
    config.devHoldoutSplit ||
    config.dev_holdout_split ||
    config.repeatPolicy ||
    config.repeat_policy,
  );
}

function recoveryGuidance(checks: LooseObject[]) {
  return uniqueStrings(
    checks.map((check) => {
      if (check.code === "self_recursive_wrapper") {
        return "Broken layer: bad wrapper. Replace the self-recursive script with the real workload.";
      }
      if (check.code === "missing_commit_path" || check.code === "missing_revert_path") {
        return "Broken layer: stale config path. Update commitPaths/revertPaths before the first packet.";
      }
      if (check.code === "git_index_lock") {
        return "Broken layer: Git lock. Wait, inspect live Git processes, then retry.";
      }
      if (check.code === "missing_benchmark_workload") {
        return "Broken layer: missing benchmark. Configure a real benchmark command.";
      }
      return String(check.action || check.message || "");
    }),
  ).filter(Boolean);
}

async function gitOk(args: string[], cwd: string) {
  return await new Promise<LooseObject>((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve({ code: -1, ok: false, stdout, stderr: String(error.message || error) }),
    );
    child.on("close", (code) => resolve({ code, ok: code === 0, stdout, stderr }));
  });
}

function isSessionFile(file: string) {
  const normalized = slashPath(file);
  return (
    normalized.startsWith("autoresearch.") ||
    normalized.startsWith("autoresearch-") ||
    normalized.startsWith("autoresearch.research/") ||
    normalized === ".gitattributes"
  );
}

function listOption(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value))
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function slashPath(value: string) {
  return String(value || "").replace(/\\/g, "/");
}

function relativePathLooksSafe(value: string) {
  const text = String(value || "");
  return Boolean(text && !path.isAbsolute(text) && !text.split(/[\\/]+/).includes(".."));
}

function toSnake(value: string) {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function truthy(value: unknown) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") return /^(true|yes|1|required|pending)$/i.test(value.trim());
  return false;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellTokenEstimate(command: string) {
  if (!command) return 0;
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) || []).length;
}

function simpleHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}
