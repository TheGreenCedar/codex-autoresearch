import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";

export const STATUS_VALUES = new Set(["keep", "discard", "crash", "checks_failed", "measure"]);
export const FAILURE_STATUSES = new Set(["crash", "checks_failed"]);
export const NON_PROMOTIONAL_STATUSES = new Set(["crash", "checks_failed", "measure"]);
export const RESEARCH_DIR = "autoresearch.research";
type LooseObject = Record<string, any>;
type Direction = "lower" | "higher";
type RunRecord = LooseObject & {
  run?: number;
  metric?: unknown;
  status?: string;
  segment?: number;
  metrics?: LooseObject;
  asi?: LooseObject;
};
type StateConfig = LooseObject & {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: Direction;
};
type SessionState = LooseObject & {
  config: StateConfig;
  segment: number;
  results: RunRecord[];
  current: RunRecord[];
};

export function listOption(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function safeSlug(value: unknown, fallback = "research"): string {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function shellQuote(value: unknown): string {
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
}

const METRIC_VALUE_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function finiteMetric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !METRIC_VALUE_PATTERN.test(trimmed)) return null;
  const metric = Number(trimmed);
  return Number.isFinite(metric) ? metric : null;
}

export function hasFiniteMetric(run: RunRecord | null | undefined): boolean {
  return finiteMetric(run?.metric) != null;
}

export function isFailureStatus(status: unknown): boolean {
  return FAILURE_STATUSES.has(String(status));
}

export function isPromotionalStatus(status: unknown): boolean {
  return !NON_PROMOTIONAL_STATUSES.has(String(status));
}

export function isBaselineEligibleMetricRun(run: RunRecord | null | undefined): boolean {
  return hasFiniteMetric(run) && !isFailureStatus(run?.status);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function readConfig(sessionCwd: string): LooseObject {
  const configPath = path.join(sessionCwd, "autoresearch.config.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

export function resolveWorkDir(cwdArg?: string): {
  sessionCwd: string;
  workDir: string;
  config: LooseObject;
} {
  const sessionCwd = path.resolve(
    cwdArg || process.env.CODEX_AUTORESEARCH_WORKDIR || process.cwd(),
  );
  const config = readConfig(sessionCwd);
  const workDir = config.workingDir ? path.resolve(sessionCwd, config.workingDir) : sessionCwd;
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error(`Working directory does not exist: ${workDir}`);
  }
  return { sessionCwd, workDir, config };
}

export function jsonlPath(workDir: string): string {
  return path.join(workDir, "autoresearch.jsonl");
}

export function appendJsonl(workDir: string, entry: LooseObject): void {
  fs.appendFileSync(jsonlPath(workDir), `${JSON.stringify(entry)}\n`);
}

export function readJsonl(workDir: string): LooseObject[] {
  const filePath = jsonlPath(workDir);
  if (!fs.existsSync(filePath)) return [];
  return parseJsonlLines(fs.readFileSync(filePath, "utf8"), filePath);
}

export async function* streamJsonl(workDir: string): AsyncGenerator<LooseObject> {
  const filePath = jsonlPath(workDir);
  if (!fs.existsSync(filePath)) return;
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const rawLine of lines) {
      index += 1;
      const line = String(rawLine).trim();
      if (!line) continue;
      yield parseJsonlLine(line, filePath, index);
    }
  } finally {
    stream.destroy();
  }
}

export async function readJsonlTail(workDir: string, maxEntries = 50): Promise<LooseObject[]> {
  const limit = Math.max(0, Math.floor(Number(maxEntries) || 0));
  if (limit === 0) return [];
  const tail = [];
  for await (const entry of streamJsonl(workDir)) {
    tail.push(entry);
    if (tail.length > limit) tail.shift();
  }
  return tail;
}

function parseJsonlLines(text: string, filePath: string): LooseObject[] {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseJsonlLine(line, filePath, index + 1));
}

function parseJsonlLine(line: string, filePath: string, index: number): LooseObject {
  try {
    return JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSONL in ${filePath} at line ${index}: ${message}`);
  }
}

export function bestMetric(runs: RunRecord[], direction: Direction | string): number | null {
  let best = null;
  for (const run of runs) {
    const metric = finiteMetric(run.metric);
    if (metric == null) continue;
    if (best == null || isBetter(metric, best, direction)) best = metric;
  }
  return best;
}

export function bestKeptMetric(runs: RunRecord[], direction: Direction | string): number | null {
  return bestMetric(
    runs.filter((run) => run.status === "keep"),
    direction,
  );
}

function bestMetricRun(runs: RunRecord[], direction: Direction | string): RunRecord | null {
  let bestRun = null;
  let best = null;
  for (const run of runs) {
    const metric = finiteMetric(run?.metric);
    if (metric == null) continue;
    if (best == null || isBetter(metric, best, direction)) {
      best = metric;
      bestRun = run;
    }
  }
  return bestRun;
}

function boolOrNull(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    if (/^(true|yes|1|promotion|promoted)$/i.test(value.trim())) return true;
    if (/^(false|no|0|dev|development)$/i.test(value.trim())) return false;
  }
  return null;
}

export function promotionGradeValue(run: RunRecord | null | undefined): boolean | null {
  const metrics = run?.metrics || {};
  const asi = run?.asi || {};
  for (const value of [
    run?.promotionGrade,
    run?.promotion_grade,
    run?.promotionEligible,
    run?.promotion_eligible,
    metrics.promotionGrade,
    metrics.promotion_grade,
    metrics.promotionEligible,
    metrics.promotion_eligible,
    asi.promotionGrade,
    asi.promotion_grade,
    asi.promotionEligible,
    asi.promotion_eligible,
  ]) {
    const result = boolOrNull(value);
    if (result !== null) return result;
  }
  return null;
}

export function isPromotionGradeRun(run: RunRecord | null | undefined): boolean {
  return promotionGradeValue(run) === true;
}

function evidenceTrack(runs: RunRecord[], direction: Direction | string) {
  const kept = runs.filter((run) => run.status === "keep");
  const bestRun = bestMetricRun(kept, direction);
  return {
    count: runs.length,
    kept: kept.length,
    baseline: finiteMetric(runs.find(isBaselineEligibleMetricRun)?.metric),
    best: finiteMetric(bestRun?.metric),
    bestRun: bestRun || null,
    latest: runs.at(-1) || null,
  };
}

export function isBetter(value: number, current: number, direction: Direction | string): boolean {
  return direction === "higher" ? value > current : value < current;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeConfidence(runs: RunRecord[], direction: Direction | string): number | null {
  const values = runs
    .filter(isBaselineEligibleMetricRun)
    .map((run) => finiteMetric(run.metric))
    .filter((value): value is number => value != null);
  if (values.length < 3) return null;
  const baseline = values[0];
  const best = bestKeptMetric(runs, direction);
  if (best == null || best === baseline) return null;
  const med = median(values);
  const mad = median(values.map((value) => Math.abs(value - med)));
  if (mad === 0) return null;
  return Math.abs(best - baseline) / mad;
}

export function currentState(workDir: string): SessionState {
  const entries = readJsonl(workDir);
  let config: StateConfig = {
    name: null,
    metricName: "metric",
    metricUnit: "",
    bestDirection: "lower",
  };
  let segment = 0;
  const results: RunRecord[] = [];
  for (const entry of entries) {
    if (entry.type === "config") {
      if (results.length > 0) segment += 1;
      config = {
        name: entry.name || config.name,
        metricName: entry.metricName || config.metricName,
        metricUnit: entry.metricUnit ?? config.metricUnit,
        bestDirection: entry.bestDirection === "higher" ? "higher" : "lower",
      };
      continue;
    }
    if (entry.run != null) {
      const run: RunRecord = { ...entry, segment: entry.segment ?? segment };
      if (Object.hasOwn(entry, "metric")) run.metric = finiteMetric(entry.metric);
      results.push(run);
    }
  }
  const current = results.filter((run) => run.segment === segment);
  const baseline = finiteMetric(current.find(isBaselineEligibleMetricRun)?.metric);
  const best = bestKeptMetric(current, config.bestDirection);
  const confidence = computeConfidence(current, config.bestDirection);
  const promotionRuns = current.filter((run) => run.status === "keep" && isPromotionGradeRun(run));
  return {
    config,
    segment,
    results,
    current,
    baseline,
    best,
    confidence,
    development: evidenceTrack(current, config.bestDirection),
    promotion: evidenceTrack(promotionRuns, config.bestDirection),
  };
}

function bestRunSummary(run: RunRecord | null | undefined): LooseObject | null {
  if (!run) return null;
  return {
    run: run.run ?? null,
    metric: finiteMetric(run.metric),
    status: run.status || "",
    segment: run.segment ?? null,
    description: run.description || "",
    promotionGrade: promotionGradeValue(run),
  };
}

function warningCodes(warnings: unknown): Set<string> {
  if (!Array.isArray(warnings)) return new Set();
  return new Set(
    warnings
      .map((warning: any) =>
        typeof warning === "object" && warning ? String(warning.code || "") : "",
      )
      .filter(Boolean),
  );
}

function qualityRoundState(qualityGap: LooseObject | null | undefined): LooseObject {
  if (!qualityGap) return { active: false, open: null, closed: null, total: null, done: null };
  const open = finiteMetric(qualityGap.open);
  const closed = finiteMetric(qualityGap.closed);
  const total = finiteMetric(qualityGap.total);
  return {
    active: true,
    slug: qualityGap.slug || "",
    open,
    closed,
    total,
    done: open === 0,
  };
}

export function buildDecisionEnvelope({
  state,
  nextAction,
  lastRunFreshness = null,
  warningDetails = [],
  scaffoldHealth = null,
  researchIntegrity = null,
  finalization = null,
  qualityGap = null,
}: LooseObject): LooseObject {
  const current: RunRecord[] = Array.isArray(state?.current) ? state.current : [];
  const all: RunRecord[] = Array.isArray(state?.results) ? state.results : current;
  const direction = state?.config?.bestDirection || "lower";
  const historicalBest = bestMetricRun(
    all.filter((run) => run.status === "keep"),
    direction,
  );
  const promotionBest = bestMetricRun(
    current.filter((run) => run.status === "keep" && isPromotionGradeRun(run)),
    direction,
  );
  const codes = warningCodes(warningDetails);
  const scaffoldBlockers = Array.isArray(scaffoldHealth?.checks)
    ? scaffoldHealth.checks
        .filter((check: any) => check?.severity === "blocker")
        .map((check: any) => check.message || check.code)
    : [];
  return {
    activeSegment: {
      segment: state?.segment ?? 0,
      runs: current.length,
      baseline: state?.baseline ?? null,
      best: state?.best ?? null,
      developmentBest: state?.development?.best ?? null,
    },
    historicalBest: bestRunSummary(historicalBest),
    promotionGradeBest: bestRunSummary(promotionBest),
    latestPacketFreshness: lastRunFreshness
      ? {
          fresh: lastRunFreshness.fresh === true,
          reason: lastRunFreshness.reason || "",
          expectedNextRun: lastRunFreshness.expectedNextRun ?? null,
          actualNextRun: lastRunFreshness.actualNextRun ?? null,
        }
      : {
          fresh: null,
          reason: "No last-run packet is pending.",
          expectedNextRun: null,
          actualNextRun: null,
        },
    benchmarkConfigDrift: {
      drifted: codes.has("benchmark_contract_changed"),
      warnings: Array.isArray(warningDetails)
        ? warningDetails.filter((warning: any) => warning?.code === "benchmark_contract_changed")
        : [],
    },
    dirtySourceDrift: {
      dirty: codes.has("git_dirty"),
      warnings: Array.isArray(warningDetails)
        ? warningDetails.filter((warning: any) =>
            ["git_dirty", "missing_commit_paths"].includes(String(warning?.code || "")),
          )
        : [],
    },
    qualityRound: qualityRoundState(qualityGap),
    scaffoldHealth: scaffoldHealth
      ? {
          ok: scaffoldHealth.ok,
          status: scaffoldHealth.status || "",
          blockers: scaffoldBlockers,
        }
      : null,
    researchIntegrity: researchIntegrity
      ? {
          ok: researchIntegrity.ok,
          currentLabel: researchIntegrity.currentLabel || "",
          evidenceLabels: researchIntegrity.evidenceLabels || [],
          notPromotableBecause: researchIntegrity.notPromotableBecause || [],
        }
      : null,
    finalizationReadiness: finalization
      ? {
          available: true,
          ready: finalization.ready === true,
          nextAction: finalization.nextAction || "",
          warnings: finalization.warnings || [],
        }
      : { available: false, ready: null, nextAction: "", warnings: [] },
    nextAction: nextAction || "Run doctor, then next.",
  };
}

export function lastRunConfigSnapshot(config: LooseObject = {}) {
  return {
    name: config.name || null,
    metricName: config.metricName || "metric",
    metricUnit: config.metricUnit ?? "",
    bestDirection: config.bestDirection === "higher" ? "higher" : "lower",
  };
}

export function statusHash(value: unknown): string {
  return createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

export function normalizeScopedFileFingerprints(fingerprints: unknown): Record<string, string> {
  if (!fingerprints || typeof fingerprints !== "object" || Array.isArray(fingerprints)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(fingerprints)
      .filter(([key, value]) => key && value != null)
      .map(([key, value]) => [String(key).replace(/\\/g, "/"), String(value)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildLastRunFreshnessSnapshot(workDir: string, context: LooseObject = {}) {
  const state = context.state || currentState(workDir);
  const snapshot: LooseObject = {
    segment: state.segment,
    config: context.configSnapshot || lastRunConfigSnapshot(state.config),
    currentRuns: state.current.length,
    totalRuns: state.results.length,
    nextRun: state.results.length + 1,
  };
  addSnapshotString(snapshot, "command", context.command);
  addSnapshotPath(snapshot, "cwd", context.cwd);
  addSnapshotPath(snapshot, "workingDir", context.workingDir);
  addSnapshotString(snapshot, "gitHead", context.gitHead);
  addSnapshotString(snapshot, "dirtyStatusHash", context.dirtyStatusHash);
  if (context.scopedFileFingerprints != null) {
    snapshot.scopedFileFingerprints = normalizeScopedFileFingerprints(
      context.scopedFileFingerprints,
    );
  }
  return snapshot;
}

export function lastRunPacketFreshness(
  workDir: string,
  packet: LooseObject,
  context: LooseObject = {},
) {
  const expected = packet?.history;
  if (!expected || typeof expected !== "object") {
    return {
      fresh: false,
      reason: "Last-run packet is missing history metadata. Run next again before logging.",
    };
  }
  const actual = buildLastRunFreshnessSnapshot(workDir, context);
  if (!Number.isFinite(Number(expected.nextRun))) {
    return {
      fresh: false,
      reason: "Last-run packet is missing history metadata. Run next again before logging.",
    };
  }
  if (Number.isFinite(Number(expected.segment)) && actual.segment !== Number(expected.segment)) {
    return {
      fresh: false,
      expectedSegment: Number(expected.segment),
      actualSegment: actual.segment,
      reason: `Last-run packet is stale: expected segment #${Number(expected.segment)}, but current segment is #${actual.segment}. Run next again before logging.`,
    };
  }
  if (!expected.config || typeof expected.config !== "object") {
    return {
      fresh: false,
      reason: "Last-run packet is missing config metadata. Run next again before logging.",
    };
  }
  if (JSON.stringify(expected.config) !== JSON.stringify(actual.config)) {
    return {
      fresh: false,
      expectedConfig: expected.config,
      actualConfig: actual.config,
      reason:
        "Last-run packet is stale: session config changed since the packet was created. Run next again before logging.",
    };
  }
  if (Number(expected.nextRun) !== actual.nextRun) {
    return {
      fresh: false,
      expectedNextRun: Number(expected.nextRun),
      actualNextRun: actual.nextRun,
      reason: `Last-run packet is stale: expected next log run #${Number(expected.nextRun)}, but current history would log #${actual.nextRun}. Run next again before logging.`,
    };
  }
  const contextualMismatch = firstFreshnessContextMismatch(expected, actual);
  if (contextualMismatch) return contextualMismatch;
  return {
    fresh: true,
    expectedNextRun: Number(expected.nextRun),
    actualNextRun: actual.nextRun,
    reason: "Last-run packet matches the current ledger.",
  };
}

export function assertFreshLastRunPacket(
  workDir: string,
  packet: LooseObject,
  context: LooseObject = {},
) {
  const freshness = lastRunPacketFreshness(workDir, packet, context);
  if (!freshness.fresh) throw new Error(freshness.reason);
  return freshness;
}

function addSnapshotString(snapshot: LooseObject, key: string, value: unknown): void {
  if (value != null && value !== "") snapshot[key] = String(value);
}

function addSnapshotPath(snapshot: LooseObject, key: string, value: unknown): void {
  if (value != null && value !== "") snapshot[key] = path.resolve(String(value));
}

function firstFreshnessContextMismatch(expected: LooseObject, actual: LooseObject) {
  for (const key of ["command", "cwd", "workingDir", "gitHead", "dirtyStatusHash"]) {
    if (!Object.hasOwn(expected, key)) continue;
    if (expected[key] !== actual[key]) {
      return {
        fresh: false,
        expectedValue: expected[key],
        actualValue: actual[key] ?? null,
        reason: `Last-run packet is stale: ${key} changed since the packet was created. Run next again before logging.`,
      };
    }
  }
  if (Object.hasOwn(expected, "scopedFileFingerprints")) {
    const expectedFingerprints = normalizeScopedFileFingerprints(expected.scopedFileFingerprints);
    const actualFingerprints = normalizeScopedFileFingerprints(actual.scopedFileFingerprints);
    if (JSON.stringify(expectedFingerprints) !== JSON.stringify(actualFingerprints)) {
      return {
        fresh: false,
        expectedValue: expectedFingerprints,
        actualValue: actualFingerprints,
        reason:
          "Last-run packet is stale: scoped file fingerprints changed since the packet was created. Run next again before logging.",
      };
    }
  }
  return null;
}

export function iterationLimitInfo(state: SessionState, runtimeConfig: LooseObject) {
  const maxIterations = Number(runtimeConfig.maxIterations);
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) {
    return {
      maxIterations: null,
      remainingIterations: null,
      limitReached: false,
    };
  }
  const max = Math.floor(maxIterations);
  const remaining = Math.max(0, max - state.current.length);
  return {
    maxIterations: max,
    remainingIterations: remaining,
    limitReached: state.current.length >= max,
  };
}

export function parseQualityGaps(text: string) {
  let open = 0;
  let closed = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s+\S/);
    if (!match) continue;
    if (match[1].toLowerCase() === "x") closed += 1;
    else open += 1;
  }
  return { open, closed, total: open + closed };
}

export function researchSlugFromArgs(args: LooseObject): string {
  return safeSlug(args.research_slug ?? args.researchSlug ?? args.slug ?? args.name ?? "research");
}

export function researchDirPath(workDir: string, slug: string): string {
  return path.join(workDir, RESEARCH_DIR, slug);
}
