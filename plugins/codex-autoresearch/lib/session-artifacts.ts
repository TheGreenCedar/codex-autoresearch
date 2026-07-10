import {
  AUTORESEARCH_DASHBOARD_FILE,
  AUTORESEARCH_RESEARCH_DIR,
  AUTORESEARCH_SESSION_FILES,
} from "./session-paths.js";

export type SessionArtifactMode = "finalization" | "dirty-tree" | "source-checkout";
export type SessionArtifactPolicy = { mode: SessionArtifactMode };

const SESSION_FILES = new Set([...AUTORESEARCH_SESSION_FILES, AUTORESEARCH_DASHBOARD_FILE]);

const RESEARCH_DIR = AUTORESEARCH_RESEARCH_DIR;
const RESEARCH_DIR_PREFIX = `${AUTORESEARCH_RESEARCH_DIR}/`;
export const REPORT_DIRNAME = "autoresearch-finalize";
export const CLEANUP_SESSION_PATHS = [RESEARCH_DIR, ...SESSION_FILES].sort((a, b) =>
  a.localeCompare(b),
);

export function isAutoresearchSessionArtifact(file: string, mode: SessionArtifactMode): boolean {
  const value = String(file || "");
  const normalized = process.platform === "win32" ? value.replace(/\\/g, "/") : value;
  return shouldExcludeSessionArtifact(normalized, { mode });
}

export function shouldExcludeSessionArtifact(
  normalizedFile: string,
  policy: SessionArtifactPolicy,
): boolean {
  if (isCommonSessionArtifact(normalizedFile)) return true;
  if (policy.mode === "dirty-tree") return isDirtyTreeSessionArtifact(normalizedFile);
  if (policy.mode === "source-checkout") return isSourceCheckoutSessionArtifact(normalizedFile);
  return isFinalizationSessionArtifact(normalizedFile);
}

function isCommonSessionArtifact(normalized: string): boolean {
  return (
    SESSION_FILES.has(normalized) ||
    normalized.startsWith("autoresearch.research/") ||
    normalized.startsWith(".git/autoresearch-runtime/")
  );
}

function isDirtyTreeSessionArtifact(normalized: string): boolean {
  return (
    normalized.startsWith("autoresearch.") ||
    normalized.startsWith("autoresearch-") ||
    normalized === ".gitattributes"
  );
}

function isSourceCheckoutSessionArtifact(normalized: string): boolean {
  return (
    normalized.startsWith("autoresearch.") ||
    normalized.startsWith("autoresearch-") ||
    normalized === REPORT_DIRNAME ||
    normalized.startsWith(`${REPORT_DIRNAME}/`)
  );
}

function isFinalizationSessionArtifact(normalized: string): boolean {
  return (
    normalized.startsWith("autoresearch.") ||
    normalized.startsWith("autoresearch-") ||
    normalized === RESEARCH_DIR ||
    normalized.startsWith(RESEARCH_DIR_PREFIX) ||
    normalized === REPORT_DIRNAME ||
    normalized.startsWith(`${REPORT_DIRNAME}/`)
  );
}
