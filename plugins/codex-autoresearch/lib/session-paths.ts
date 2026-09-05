import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

export const AUTORESEARCH_LEDGER_FILE = "autoresearch.jsonl";
export const AUTORESEARCH_CONFIG_FILE = "autoresearch.config.json";
export const AUTORESEARCH_NOTES_FILE = "autoresearch.md";
export const AUTORESEARCH_IDEAS_FILE = "autoresearch.ideas.md";
export const AUTORESEARCH_DASHBOARD_FILE = "autoresearch-dashboard.html";
export const AUTORESEARCH_LAST_RUN_FILE = "autoresearch.last-run.json";
export const AUTORESEARCH_PROGRESS_FILE = "autoresearch.progress.json";
export const AUTORESEARCH_PENDING_TRANSACTION_FILE = "autoresearch.pending-transaction.json";
export const AUTORESEARCH_RESEARCH_DIR = "autoresearch.research";
export const AUTORESEARCH_DOCUMENT_DIR = ".autoresearch";
export const AUTORESEARCH_OWNED_DIRS = [
  AUTORESEARCH_DOCUMENT_DIR,
  AUTORESEARCH_RESEARCH_DIR,
  "target/autoresearch",
  ".autoresearch-cache",
] as const;

export const AUTORESEARCH_SESSION_FILES = [
  AUTORESEARCH_LEDGER_FILE,
  AUTORESEARCH_NOTES_FILE,
  AUTORESEARCH_IDEAS_FILE,
  "autoresearch.sh",
  "autoresearch.ps1",
  "autoresearch.checks.sh",
  "autoresearch.checks.ps1",
  AUTORESEARCH_CONFIG_FILE,
  AUTORESEARCH_LAST_RUN_FILE,
  AUTORESEARCH_PROGRESS_FILE,
  AUTORESEARCH_PENDING_TRANSACTION_FILE,
] as const;

export interface ResolveSessionPathsInput {
  cwd?: string;
  sessionCwd?: string;
  workDir?: string;
}

export interface SessionPaths {
  mode: "repo";
  targetCwd: string;
  sessionCwd: string;
  sessionDir: string;
  ledgerPath: string;
  configPath: string;
  notesPath: string;
  ideasPath: string;
  researchRoot: string;
  dashboardExportPath: string;
  lastRunFallbackPath: string;
  progressFallbackPath: string;
  pendingLogTransactionFallbackPath: string;
  sessionFilePaths: string[];
  clearTargets: string[];
}

export function resolveSessionPaths(input: ResolveSessionPathsInput = {}): SessionPaths {
  const targetCwd = path.resolve(input.workDir || input.cwd || input.sessionCwd || process.cwd());
  const sessionCwd = path.resolve(input.sessionCwd || targetCwd);
  const sessionDir = targetCwd;
  const sessionFilePaths = AUTORESEARCH_SESSION_FILES.map((fileName) =>
    fileName === AUTORESEARCH_NOTES_FILE || fileName === AUTORESEARCH_IDEAS_FILE
      ? documentPath(sessionDir, fileName)
      : path.join(sessionDir, fileName),
  );
  const configPath = path.join(sessionCwd, AUTORESEARCH_CONFIG_FILE);
  const researchRoot = path.join(sessionDir, AUTORESEARCH_RESEARCH_DIR);
  const dashboardExportPath = path.join(sessionDir, AUTORESEARCH_DASHBOARD_FILE);
  return {
    mode: "repo",
    targetCwd,
    sessionCwd,
    sessionDir,
    ledgerPath: path.join(sessionDir, AUTORESEARCH_LEDGER_FILE),
    configPath,
    notesPath: documentPath(sessionDir, AUTORESEARCH_NOTES_FILE),
    ideasPath: documentPath(sessionDir, AUTORESEARCH_IDEAS_FILE),
    researchRoot,
    dashboardExportPath,
    lastRunFallbackPath: path.join(sessionDir, AUTORESEARCH_LAST_RUN_FILE),
    progressFallbackPath: path.join(sessionDir, AUTORESEARCH_PROGRESS_FILE),
    pendingLogTransactionFallbackPath: path.join(sessionDir, AUTORESEARCH_PENDING_TRANSACTION_FILE),
    sessionFilePaths,
    clearTargets: [...sessionFilePaths, researchRoot, dashboardExportPath, configPath],
  };
}

function documentPath(root: string, name: string): string {
  const legacy = path.join(root, name);
  const compact = path.join(root, AUTORESEARCH_DOCUMENT_DIR, name);
  if (fs.existsSync(legacy) && fs.existsSync(compact)) {
    throw new Error(
      `Conflicting session documents: ${legacy} and ${compact}. Keep one authoritative copy before continuing.`,
    );
  }
  return fs.existsSync(legacy) ? legacy : compact;
}

export function researchDirPathForSession(workDir: string, slug: string): string {
  return path.join(resolveSessionPaths({ workDir }).researchRoot, slug);
}

export function sessionPathIdentity(sessionPaths: SessionPaths): string {
  const identity = {
    targetCwd: normalizeIdentityPath(sessionPaths.targetCwd),
    sessionCwd: normalizeIdentityPath(sessionPaths.sessionCwd),
    ledgerPath: normalizeIdentityPath(sessionPaths.ledgerPath),
    configPath: normalizeIdentityPath(sessionPaths.configPath),
    notesPath: normalizeIdentityPath(sessionPaths.notesPath),
    ideasPath: normalizeIdentityPath(sessionPaths.ideasPath),
    lastRunFallbackPath: normalizeIdentityPath(sessionPaths.lastRunFallbackPath),
    researchRoot: normalizeIdentityPath(sessionPaths.researchRoot),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function normalizeIdentityPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
