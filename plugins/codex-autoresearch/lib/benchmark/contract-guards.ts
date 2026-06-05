import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { isUnknownRecord, type UnknownRecord } from "../types/json.js";

export interface ProtectedBenchmarkSnapshot {
  configured: string[];
  capturedAt: string;
  surfaceHash: string;
  files: UnknownRecord[];
  quarantined: UnknownRecord[];
  warnings: string[];
}

export interface ProtectedBenchmarkGuard {
  configured: boolean;
  ok: boolean;
  status:
    | "not-configured"
    | "baseline-pending"
    | "baseline-pending-dirty"
    | "clean"
    | "changed"
    | "dirty"
    | "baseline-missing"
    | "quarantined"
    | "invalid-config";
  code: string;
  severity: "info" | "warning" | "error";
  baselineRun: number | null;
  baselineSegment: number | null;
  current: ProtectedBenchmarkSnapshot | null;
  baseline: ProtectedBenchmarkSnapshot | null;
  dirtyPaths: string[];
  message: string;
  action: string;
}

const FAILURE_STATUSES = new Set(["crash", "checks_failed"]);

export function protectedBenchmarkPathsFromConfig(config: UnknownRecord = {}): string[] {
  return normalizeProtectedBenchmarkPaths(
    config.protectedBenchmarkPaths ?? config.protected_benchmark_paths,
    "protectedBenchmarkPaths",
  );
}

export function normalizeProtectedBenchmarkPaths(
  paths: unknown,
  optionName = "protectedBenchmarkPaths",
): string[] {
  return uniqueStrings(listOption(paths).map((item) => normalizeProtectedPath(item, optionName)));
}

export function protectedPathCovers(scopePath: string, filePath: string): boolean {
  const scope = slashPath(scopePath);
  const file = slashPath(filePath);
  return file === scope || file.startsWith(`${scope}/`);
}

export async function buildProtectedBenchmarkSnapshot({
  workDir,
  paths,
  capturedAt = new Date().toISOString(),
}: {
  workDir: string;
  paths: unknown;
  capturedAt?: string;
}): Promise<ProtectedBenchmarkSnapshot> {
  let configured: string[] = [];
  const files: UnknownRecord[] = [];
  const quarantined: UnknownRecord[] = [];
  const warnings: string[] = [];
  try {
    configured = normalizeProtectedBenchmarkPaths(paths);
  } catch (error) {
    const message = errorMessage(error);
    quarantined.push({ path: "<config>", reason: "invalid_config", detail: message });
    warnings.push(message);
    return snapshotFromParts({ configured, capturedAt, files, quarantined, warnings });
  }

  const workDirResolved = path.resolve(workDir);
  const workDirReal = await realPathOrResolved(workDirResolved);
  for (const relativePath of configured) {
    await collectProtectedPath({
      workDir: workDirResolved,
      workDirReal,
      relativePath,
      files,
      quarantined,
      warnings,
    });
  }
  return snapshotFromParts({ configured, capturedAt, files, quarantined, warnings });
}

export async function buildProtectedBenchmarkGuard({
  workDir,
  config = {},
  state = {},
  dirtyPaths = [],
}: {
  workDir: string;
  config?: UnknownRecord;
  state?: UnknownRecord;
  dirtyPaths?: unknown[];
}): Promise<ProtectedBenchmarkGuard> {
  let configured: string[] = [];
  try {
    configured = protectedBenchmarkPathsFromConfig(config);
  } catch (error) {
    return guardResult({
      configured: true,
      ok: false,
      status: "invalid-config",
      code: "protected_benchmark_invalid_config",
      severity: "error",
      message: errorMessage(error),
      action:
        "Configure protectedBenchmarkPaths as project-relative paths inside the working directory.",
    });
  }

  if (configured.length === 0) {
    return guardResult({
      configured: false,
      ok: true,
      status: "not-configured",
      code: "protected_benchmark_not_configured",
      severity: "info",
      message: "No protected benchmark paths are configured.",
      action: "",
    });
  }

  const current = await buildProtectedBenchmarkSnapshot({ workDir, paths: configured });
  const baselineRun = baselineRunForState(state);
  const dirtyProtectedPaths = uniqueStrings(
    dirtyPaths
      .map(String)
      .filter((dirtyPath) =>
        configured.some((scopePath) => protectedPathCovers(scopePath, dirtyPath)),
      ),
  );
  if (current.quarantined.length > 0) {
    return guardResult({
      configured: true,
      ok: false,
      status: "quarantined",
      code: "protected_benchmark_path_quarantined",
      severity: "error",
      baselineRun: runNumber(baselineRun),
      baselineSegment: segmentNumber(baselineRun),
      current,
      dirtyPaths: dirtyProtectedPaths,
      message: `Protected benchmark path was quarantined: ${quarantineSummary(current)}.`,
      action:
        "Fix protectedBenchmarkPaths so every configured path and realpath stays inside the working directory.",
    });
  }

  if (!baselineRun) {
    return guardResult({
      configured: true,
      ok: true,
      status: dirtyProtectedPaths.length ? "baseline-pending-dirty" : "baseline-pending",
      code: dirtyProtectedPaths.length
        ? "protected_benchmark_baseline_pending_dirty"
        : "protected_benchmark_baseline_pending",
      severity: dirtyProtectedPaths.length ? "warning" : "info",
      current,
      dirtyPaths: dirtyProtectedPaths,
      message: dirtyProtectedPaths.length
        ? `Protected benchmark paths are dirty before the first baseline: ${dirtyProtectedPaths.join(", ")}.`
        : "Protected benchmark paths are configured; the first metric-bearing log in this segment will capture the baseline snapshot.",
      action: dirtyProtectedPaths.length
        ? "Review or commit the protected benchmark paths before treating the baseline as trusted."
        : "Run and log a baseline for the current segment.",
    });
  }

  const baseline = snapshotFromRun(baselineRun);
  if (!baseline) {
    return guardResult({
      configured: true,
      ok: false,
      status: "baseline-missing",
      code: "protected_benchmark_baseline_missing",
      severity: "error",
      baselineRun: runNumber(baselineRun),
      baselineSegment: segmentNumber(baselineRun),
      current,
      dirtyPaths: dirtyProtectedPaths,
      message: `Current baseline run #${runNumber(
        baselineRun,
      )} has no protected benchmark snapshot.`,
      action:
        "Start a new segment or promotion gate so the protected benchmark contract is recorded before more packets or keeps.",
    });
  }

  const configuredChanged =
    JSON.stringify(normalizeSnapshotPaths(baseline.configured)) !== JSON.stringify(configured);
  const hashChanged = baseline.surfaceHash !== current.surfaceHash;
  if (configuredChanged || hashChanged) {
    return guardResult({
      configured: true,
      ok: false,
      status: "changed",
      code: "protected_benchmark_changed",
      severity: "error",
      baselineRun: runNumber(baselineRun),
      baselineSegment: segmentNumber(baselineRun),
      current,
      baseline,
      dirtyPaths: dirtyProtectedPaths,
      message: `Protected benchmark paths changed after baseline run #${runNumber(baselineRun)}.`,
      action:
        "Start a new segment or promotion gate to record the benchmark change before running more packets or logging keep.",
    });
  }

  if (dirtyProtectedPaths.length > 0) {
    return guardResult({
      configured: true,
      ok: false,
      status: "dirty",
      code: "protected_benchmark_dirty",
      severity: "error",
      baselineRun: runNumber(baselineRun),
      baselineSegment: segmentNumber(baselineRun),
      current,
      baseline,
      dirtyPaths: dirtyProtectedPaths,
      message: `Protected benchmark paths are dirty after baseline run #${runNumber(
        baselineRun,
      )}: ${dirtyProtectedPaths.join(", ")}.`,
      action:
        "Commit or revert the protected benchmark paths, or start a new segment/promotion gate if the benchmark contract intentionally changed.",
    });
  }

  return guardResult({
    configured: true,
    ok: true,
    status: "clean",
    code: "protected_benchmark_clean",
    severity: "info",
    baselineRun: runNumber(baselineRun),
    baselineSegment: segmentNumber(baselineRun),
    current,
    baseline,
    message: "Protected benchmark paths match the current segment baseline.",
    action: "Continue from the canonical next action.",
  });
}

export function protectedBenchmarkWarningFromGuard(
  guard: ProtectedBenchmarkGuard,
): UnknownRecord | null {
  if (!guard.configured || guard.status === "clean" || guard.status === "baseline-pending") {
    return null;
  }
  return {
    code: guard.code,
    severity: guard.severity,
    message: guard.message,
    action: guard.action,
    baselineRun: guard.baselineRun,
    baselineSegment: guard.baselineSegment,
    paths: guard.current?.configured || [],
    dirtyPaths: guard.dirtyPaths,
    quarantined: guard.current?.quarantined || [],
    previousHash: guard.baseline?.surfaceHash || "",
    currentHash: guard.current?.surfaceHash || "",
  };
}

export function protectedBenchmarkGuardBlocksKeep(guard: ProtectedBenchmarkGuard): boolean {
  return guard.configured && guard.ok === false;
}

function snapshotFromParts({
  configured,
  capturedAt,
  files,
  quarantined,
  warnings,
}: Omit<ProtectedBenchmarkSnapshot, "surfaceHash">): ProtectedBenchmarkSnapshot {
  const sortedFiles = sortRecords(files);
  const sortedQuarantined = sortRecords(quarantined);
  const surfaceHash = hashText(
    JSON.stringify({
      configured: normalizeSnapshotPaths(configured),
      files: sortedFiles,
      quarantined: sortedQuarantined,
    }),
  );
  return {
    configured: normalizeSnapshotPaths(configured),
    capturedAt,
    surfaceHash,
    files: sortedFiles,
    quarantined: sortedQuarantined,
    warnings: uniqueStrings(warnings),
  };
}

async function collectProtectedPath({
  workDir,
  workDirReal,
  relativePath,
  files,
  quarantined,
  warnings,
}: {
  workDir: string;
  workDirReal: string;
  relativePath: string;
  files: UnknownRecord[];
  quarantined: UnknownRecord[];
  warnings: string[];
}) {
  const absolutePath = path.resolve(workDir, relativePath);
  if (!isPathInside(workDir, absolutePath)) {
    quarantine({
      path: relativePath,
      reason: "outside_workdir",
      detail: "configured path escapes the working directory",
      quarantined,
      warnings,
    });
    return;
  }
  const lstat = await lstatOrNull(absolutePath);
  if (!lstat) {
    files.push({ path: relativePath, missing: true });
    return;
  }
  if (
    !(await protectedRealPathStaysInside({
      absolutePath,
      relativePath,
      workDirReal,
      quarantined,
      warnings,
    }))
  )
    return;
  if (lstat.isDirectory()) {
    files.push({ path: relativePath, directory: true });
    await collectProtectedDirectory({
      workDir,
      workDirReal,
      relativePath,
      files,
      quarantined,
      warnings,
    });
    return;
  }
  await collectProtectedLeaf({ absolutePath, relativePath, files, quarantined, warnings });
}

async function collectProtectedDirectory({
  workDir,
  workDirReal,
  relativePath,
  files,
  quarantined,
  warnings,
}: {
  workDir: string;
  workDirReal: string;
  relativePath: string;
  files: UnknownRecord[];
  quarantined: UnknownRecord[];
  warnings: string[];
}) {
  const absoluteDir = path.resolve(workDir, relativePath);
  const entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = slashPath(path.join(relativePath, entry.name));
    const childAbsolute = path.resolve(workDir, childRelative);
    if (
      !(await protectedRealPathStaysInside({
        absolutePath: childAbsolute,
        relativePath: childRelative,
        workDirReal,
        quarantined,
        warnings,
      }))
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push({ path: childRelative, directory: true });
      await collectProtectedDirectory({
        workDir,
        workDirReal,
        relativePath: childRelative,
        files,
        quarantined,
        warnings,
      });
    } else {
      await collectProtectedLeaf({
        absolutePath: childAbsolute,
        relativePath: childRelative,
        files,
        quarantined,
        warnings,
      });
    }
  }
}

async function protectedRealPathStaysInside({
  absolutePath,
  relativePath,
  workDirReal,
  quarantined,
  warnings,
}: {
  absolutePath: string;
  relativePath: string;
  workDirReal: string;
  quarantined: UnknownRecord[];
  warnings: string[];
}): Promise<boolean> {
  const realPath = await realPathOrNull(absolutePath);
  if (!realPath.path) {
    quarantine({
      path: relativePath,
      reason: "realpath_failed",
      detail: realPath.error,
      quarantined,
      warnings,
    });
    return false;
  }
  if (!isPathInside(workDirReal, realPath.path)) {
    quarantine({
      path: relativePath,
      reason: "outside_workdir_realpath",
      detail: "realpath escapes the working directory",
      quarantined,
      warnings,
    });
    return false;
  }
  return true;
}

async function collectProtectedLeaf({
  absolutePath,
  relativePath,
  files,
  quarantined,
  warnings,
}: {
  absolutePath: string;
  relativePath: string;
  files: UnknownRecord[];
  quarantined: UnknownRecord[];
  warnings: string[];
}) {
  const lstat = await fsp.lstat(absolutePath);
  if (lstat.isSymbolicLink()) {
    const target = await fsp.readlink(absolutePath);
    const stat = await fsp.stat(absolutePath);
    if (stat.isFile()) {
      files.push({ path: relativePath, symlink: target, hash: await fileHash(absolutePath) });
    } else if (stat.isDirectory()) {
      quarantine({
        path: relativePath,
        reason: "symlink_directory",
        detail:
          "symlinked directories are quarantined so recursive benchmark contents cannot drift outside the recorded protected surface",
        quarantined,
        warnings,
      });
    } else {
      files.push({ path: relativePath, symlink: target, type: fileType(stat) });
    }
    return;
  }
  if (lstat.isFile()) {
    files.push({ path: relativePath, hash: await fileHash(absolutePath) });
  } else {
    files.push({ path: relativePath, type: fileType(lstat) });
  }
}

async function fileHash(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fsp.readFile(filePath))
    .digest("hex");
}

function snapshotFromRun(run: UnknownRecord | null): ProtectedBenchmarkSnapshot | null {
  const value = run?.protectedBenchmarkPaths || run?.protectedBenchmarkSnapshot || null;
  if (!isUnknownRecord(value)) return null;
  return {
    configured: normalizeSnapshotPaths(value.configured),
    capturedAt: String(value.capturedAt || ""),
    surfaceHash: String(value.surfaceHash || ""),
    files: Array.isArray(value.files) ? value.files : [],
    quarantined: Array.isArray(value.quarantined) ? value.quarantined : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : [],
  };
}

function baselineRunForState(state: UnknownRecord): UnknownRecord | null {
  const runs = Array.isArray(state.current) ? state.current : [];
  return (
    runs.find((run) => finiteMetric(run?.metric) != null && !FAILURE_STATUSES.has(run?.status)) ||
    null
  );
}

function guardResult(input: Partial<ProtectedBenchmarkGuard>): ProtectedBenchmarkGuard {
  return {
    configured: input.configured === true,
    ok: input.ok !== false,
    status: input.status || "not-configured",
    code: input.code || "",
    severity: input.severity || "info",
    baselineRun: input.baselineRun ?? null,
    baselineSegment: input.baselineSegment ?? null,
    current: input.current || null,
    baseline: input.baseline || null,
    dirtyPaths: input.dirtyPaths || [],
    message: input.message || "",
    action: input.action || "",
  };
}

function normalizeProtectedPath(item: string, optionName: string): string {
  const normalized = slashPath(item).replace(/\/+/g, "/");
  if (
    !normalized ||
    normalized === "." ||
    path.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === ".." ||
    normalized.startsWith(".git/") ||
    normalized === ".git"
  ) {
    throw new Error(
      `${optionName} must contain project-relative paths that do not escape the working directory: ${item}`,
    );
  }
  return normalized.replace(/\/$/, "");
}

function listOption(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function finiteMetric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
  const metric = Number(trimmed);
  return Number.isFinite(metric) ? metric : null;
}

function slashPath(value: unknown): string {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeSnapshotPaths(paths: unknown): string[] {
  return uniqueStrings(Array.isArray(paths) ? paths.map(String).map(slashPath) : []);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function sortRecords(records: UnknownRecord[]): UnknownRecord[] {
  return [...records].sort((left, right) =>
    String(left.path || "").localeCompare(String(right.path || "")),
  );
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target)).replace(/\\/g, "/");
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative))
  );
}

async function lstatOrNull(filePath: string) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return null;
    throw error;
  }
}

async function realPathOrNull(filePath: string): Promise<{ path: string; error: string }> {
  try {
    return { path: await fsp.realpath(filePath), error: "" };
  } catch (error) {
    return { path: "", error: errorMessage(error) };
  }
}

async function realPathOrResolved(filePath: string): Promise<string> {
  try {
    return await fsp.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function quarantine({
  path: quarantinedPath,
  reason,
  detail,
  quarantined,
  warnings,
}: {
  path: string;
  reason: string;
  detail: string;
  quarantined: UnknownRecord[];
  warnings: string[];
}) {
  quarantined.push({ path: slashPath(quarantinedPath), reason, detail });
  warnings.push(`Protected benchmark path ${quarantinedPath} quarantined: ${detail}.`);
}

function quarantineSummary(snapshot: ProtectedBenchmarkSnapshot): string {
  return snapshot.quarantined
    .map((entry) => `${entry.path || "<unknown>"} (${entry.reason || "quarantined"})`)
    .join(", ");
}

function fileType(stats: { isFIFO?: () => boolean; isSocket?: () => boolean }): string {
  if (stats.isFIFO?.()) return "fifo";
  if (stats.isSocket?.()) return "socket";
  return "other";
}

function runNumber(run: UnknownRecord | null | undefined): number | null {
  const value = Number(run?.run);
  return Number.isFinite(value) ? value : null;
}

function segmentNumber(run: UnknownRecord | null | undefined): number | null {
  const value = Number(run?.segment);
  return Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
