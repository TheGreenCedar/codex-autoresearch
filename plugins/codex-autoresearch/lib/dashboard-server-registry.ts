import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type DashboardHealthSummary, verifyDashboardHealthSummary } from "./dashboard-health.js";
import { resolveSessionPaths, sessionPathIdentity, type SessionPaths } from "./session-paths.js";

type Liveness = "alive" | "dead" | "unknown";
type CwdRelation = "same-cwd" | "different-cwd" | "unknown";
type SessionRelation = "same-session" | "different-session" | "unknown";

export interface DashboardServeRegistryRecord {
  pid: number;
  port: number;
  cwd: string;
  startedAt: string;
  version: string;
  healthUrl: string;
  debugLedger?: boolean;
  sessionCwd?: string;
  sessionPathIdentity?: string;
  previous?: DashboardServeRegistrySummary | null;
}

export interface DashboardServeRegistrySummary {
  available: boolean;
  stale: boolean | null;
  sameCwd: boolean | null;
  cwdRelation: CwdRelation;
  sameSession: boolean | null;
  sessionRelation: SessionRelation;
  liveness: Liveness;
  currentProcess: boolean | null;
  message: string;
  record: DashboardServeRegistryRecord | null;
}

export interface DashboardServeRegistryHealthInput {
  url: string;
  port?: number;
  pid?: number;
  registryPath: string;
  cwd: string;
  sessionCwd: string;
  sessionPathIdentity: string;
  version?: string;
  startedAt?: string;
  previous: DashboardServeRegistrySummary;
  timeoutMs?: number;
}

export interface DashboardServeRegistryLookup {
  available: boolean;
  reusable: boolean;
  registryPath: string;
  dashboardUrl: string;
  healthUrl: string;
  recoveryCommand: string;
  pid: number | null;
  port: number | null;
  cwd: string;
  version: string;
  startedAt: string;
  checkedAt: string;
  liveness: Liveness;
  stale: boolean | null;
  message: string;
  record: DashboardServeRegistryRecord | null;
  previous: DashboardServeRegistrySummary;
  health: DashboardHealthSummary | null;
}

export function registryPathForWorkDir(workDir: string): string {
  const resolvedWorkDir = path.resolve(workDir);
  const gitDir = findGitDir(resolvedWorkDir);
  if (gitDir) return path.join(gitDir, "autoresearch", "serve-registry.json");
  return path.join(
    resolveSessionPaths({ workDir: resolvedWorkDir }).researchRoot,
    ".runtime",
    "serve-registry.json",
  );
}

export async function readServeRegistry(
  workDir: string,
): Promise<DashboardServeRegistryRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(registryPathForWorkDir(workDir), "utf8"));
    return normalizeRecord(parsed);
  } catch {
    return null;
  }
}

export async function writeServeRegistry(
  workDir: string,
  record: DashboardServeRegistryRecord,
): Promise<{
  path: string;
  record: DashboardServeRegistryRecord;
  previous: DashboardServeRegistrySummary;
}> {
  const previousRecord = await readServeRegistry(workDir);
  const normalized = normalizeRecord(record);
  const previous = summarizeServeRegistry(previousRecord, {
    currentCwd: normalized.cwd,
    currentPid: normalized.pid,
  });
  const storedRecord = {
    ...normalized,
    previous: previous.available ? compactSummary(previous) : null,
  };
  const filePath = registryPathForWorkDir(workDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(storedRecord, null, 2)}\n`, "utf8");
  return { path: filePath, record: storedRecord, previous };
}

export function summarizeServeRegistry(
  record: DashboardServeRegistryRecord | null,
  options: {
    currentPid?: number;
    currentCwd?: string;
    sessionCwd?: string;
    sessionPathIdentity?: string;
  } = {},
): DashboardServeRegistrySummary {
  if (!record) {
    return {
      available: false,
      stale: null,
      sameCwd: null,
      cwdRelation: "unknown",
      sameSession: null,
      sessionRelation: "unknown",
      liveness: "unknown",
      currentProcess: null,
      message: "No dashboard serve registry record is available.",
      record: null,
    };
  }

  const normalized = normalizeRecord(record);
  const currentPid = finitePositiveInteger(options.currentPid);
  const currentCwd = cleanString(options.currentCwd);
  const sameCwd = currentCwd && normalized.cwd ? samePath(normalized.cwd, currentCwd) : null;
  const cwdRelation: CwdRelation =
    sameCwd == null ? "unknown" : sameCwd ? "same-cwd" : "different-cwd";
  const sameSession = registrySessionMatches(normalized, options);
  const sessionRelation: SessionRelation =
    sameSession == null ? "unknown" : sameSession ? "same-session" : "different-session";
  const liveness = inspectProcessLiveness(normalized.pid);
  const currentProcess = currentPid == null ? null : normalized.pid === currentPid;
  const stale =
    sameCwd === false || sameSession === false
      ? true
      : liveness === "dead"
        ? true
        : currentProcess === true
          ? false
          : liveness === "alive" && sameCwd === true
            ? false
            : null;

  return {
    available: true,
    stale,
    sameCwd,
    cwdRelation,
    sameSession,
    sessionRelation,
    liveness,
    currentProcess,
    message: registryMessage({
      record: normalized,
      stale,
      cwdRelation,
      sessionRelation,
      liveness,
      currentProcess,
    }),
    record: normalized,
  };
}

export function buildServeRegistryHealthInput(
  workDir: string,
  record: DashboardServeRegistryRecord | null,
  options: {
    expectedVersion?: string;
    timeoutMs?: number;
    sessionCwd?: string;
    sessionPathIdentity?: string;
  } = {},
): DashboardServeRegistryHealthInput {
  const requestedCwd = path.resolve(workDir);
  const normalized = record ? normalizeRecord(record) : null;
  const previous = summarizeServeRegistry(normalized, {
    currentCwd: requestedCwd,
    sessionCwd: options.sessionCwd,
    sessionPathIdentity: options.sessionPathIdentity,
  });
  return {
    url: normalized?.port ? `http://127.0.0.1:${normalized.port}/` : "",
    port: normalized?.port,
    pid: normalized?.pid,
    registryPath: registryPathForWorkDir(requestedCwd),
    cwd: requestedCwd,
    sessionCwd: cleanString(options.sessionCwd) || normalized?.sessionCwd || "",
    sessionPathIdentity:
      cleanString(options.sessionPathIdentity) || normalized?.sessionPathIdentity || "",
    version: cleanString(options.expectedVersion) || normalized?.version,
    startedAt: normalized?.startedAt,
    previous,
    timeoutMs: options.timeoutMs,
  };
}

export async function findReusableServeRegistry(
  workDir: string,
  options: {
    expectedVersion?: string;
    timeoutMs?: number;
    debugLedger?: boolean;
    sessionPaths?: SessionPaths;
  } = {},
): Promise<DashboardServeRegistryLookup> {
  const requestedCwd = path.resolve(workDir);
  const expectedSessionCwd = options.sessionPaths?.sessionCwd || "";
  const expectedSessionPathIdentity = options.sessionPaths
    ? sessionPathIdentity(options.sessionPaths)
    : "";
  const record = await readServeRegistry(requestedCwd);
  const previous = summarizeServeRegistry(record, {
    currentCwd: requestedCwd,
    sessionCwd: expectedSessionCwd,
    sessionPathIdentity: expectedSessionPathIdentity,
  });
  const registryPath = registryPathForWorkDir(requestedCwd);
  const recoveryCommand = serveRecoveryCommand(requestedCwd);
  if (!record) {
    return {
      available: false,
      reusable: false,
      registryPath,
      dashboardUrl: "",
      healthUrl: "",
      recoveryCommand,
      pid: null,
      port: null,
      cwd: requestedCwd,
      version: cleanString(options.expectedVersion),
      startedAt: "",
      checkedAt: new Date().toISOString(),
      liveness: "unknown",
      stale: null,
      message: previous.message,
      record: null,
      previous,
      health: null,
    };
  }

  const health = await verifyDashboardHealthSummary(
    buildServeRegistryHealthInput(requestedCwd, record, {
      expectedVersion: options.expectedVersion,
      timeoutMs: options.timeoutMs,
      sessionCwd: expectedSessionCwd,
      sessionPathIdentity: expectedSessionPathIdentity,
    }),
  );
  const reusable =
    health.liveness === "alive" &&
    health.stale === false &&
    Boolean(record.debugLedger) === Boolean(options.debugLedger);
  const healthUrl = health.healthUrl || record.healthUrl;
  const dashboardUrl = health.url || (record.port ? `http://127.0.0.1:${record.port}/` : "");
  const liveness = health.liveness === "alive" ? "alive" : health.liveness || previous.liveness;
  const stale =
    reusable === true
      ? false
      : health.stale === true
        ? true
        : previous.stale === true
          ? true
          : health.stale;
  return {
    available: true,
    reusable,
    registryPath,
    dashboardUrl,
    healthUrl,
    recoveryCommand,
    pid: health.pid ?? record.pid,
    port: health.port ?? record.port,
    cwd: requestedCwd,
    version: cleanString(options.expectedVersion) || record.version,
    startedAt: record.startedAt,
    checkedAt: new Date().toISOString(),
    liveness,
    stale,
    message: reusable
      ? "Dashboard registry points at a healthy same-cwd server for this plugin version."
      : `Dashboard registry is stale or dead. Run ${recoveryCommand}.`,
    record,
    previous,
    health,
  };
}

function findGitDir(startDir: string): string | null {
  let cursor = startDir;
  while (true) {
    const candidate = path.join(cursor, ".git");
    const stats = statOrNull(candidate);
    if (stats?.isDirectory()) return candidate;
    if (stats?.isFile()) {
      const gitDir = parseGitDirFile(candidate);
      if (gitDir) return gitDir;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function parseGitDirFile(filePath: string): string | null {
  try {
    const line = readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0]?.trim() || "";
    const match = /^gitdir:\s*(.+)$/i.exec(line);
    if (!match) return null;
    return path.resolve(path.dirname(filePath), match[1]);
  } catch {
    return null;
  }
}

function statOrNull(filePath: string) {
  try {
    if (!existsSync(filePath)) return null;
    return statSync(filePath);
  } catch {
    return null;
  }
}

function normalizeRecord(record: unknown): DashboardServeRegistryRecord {
  const source =
    record && typeof record === "object" && !Array.isArray(record)
      ? (record as Record<string, unknown>)
      : {};
  return {
    pid: finitePositiveInteger(source.pid) ?? 0,
    port: finitePositiveInteger(source.port) ?? 0,
    cwd: path.resolve(cleanString(source.cwd) || process.cwd()),
    startedAt: cleanString(source.startedAt) || new Date(0).toISOString(),
    version: cleanString(source.version),
    healthUrl: cleanString(source.healthUrl),
    debugLedger: source.debugLedger === true,
    sessionCwd: cleanString(source.sessionCwd),
    sessionPathIdentity: cleanString(source.sessionPathIdentity),
  };
}

function compactSummary(summary: DashboardServeRegistrySummary): DashboardServeRegistrySummary {
  return {
    available: summary.available,
    stale: summary.stale,
    sameCwd: summary.sameCwd,
    cwdRelation: summary.cwdRelation,
    sameSession: summary.sameSession,
    sessionRelation: summary.sessionRelation,
    liveness: summary.liveness,
    currentProcess: summary.currentProcess,
    message: summary.message,
    record: summary.record,
  };
}

function inspectProcessLiveness(pid: number): Liveness {
  if (!finitePositiveInteger(pid)) return "unknown";
  if (pid === process.pid) return "alive";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

function registryMessage({
  record,
  stale,
  cwdRelation,
  sessionRelation,
  liveness,
  currentProcess,
}: {
  record: DashboardServeRegistryRecord;
  stale: boolean | null;
  cwdRelation: CwdRelation;
  sessionRelation: SessionRelation;
  liveness: Liveness;
  currentProcess: boolean | null;
}): string {
  if (cwdRelation === "different-cwd") {
    return `Dashboard registry points at a different cwd: ${record.cwd}.`;
  }
  if (sessionRelation === "different-session") {
    return "Dashboard registry points at a different session path contract.";
  }
  if (currentProcess) return "Dashboard serve registry matches this process.";
  if (liveness === "dead") return `Dashboard registry pid ${record.pid} is not running.`;
  if (stale === false) return "Dashboard registry points at a live same-cwd server.";
  return "Dashboard registry liveness could not be fully inspected.";
}

function registrySessionMatches(
  record: DashboardServeRegistryRecord,
  options: { sessionCwd?: string; sessionPathIdentity?: string },
): boolean | null {
  const expectedIdentity = cleanString(options.sessionPathIdentity);
  if (expectedIdentity) return cleanString(record.sessionPathIdentity) === expectedIdentity;
  const expectedSessionCwd = cleanString(options.sessionCwd);
  if (expectedSessionCwd) {
    return record.sessionCwd ? samePath(record.sessionCwd, expectedSessionCwd) : false;
  }
  return null;
}

function finitePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function serveRecoveryCommand(cwd: string): string {
  return cwd ? `node scripts/autoresearch.mjs serve --cwd ${quoteCommandArg(cwd)}` : "";
}

function quoteCommandArg(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}
