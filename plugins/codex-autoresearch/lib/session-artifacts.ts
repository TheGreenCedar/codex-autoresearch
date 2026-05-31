export type SessionArtifactMode = "finalization" | "dirty-tree" | "source-checkout";
export type SessionArtifactPolicy = { mode: SessionArtifactMode };

const SESSION_FILES = new Set([
  "autoresearch.jsonl",
  "autoresearch.md",
  "autoresearch.ideas.md",
  "autoresearch.config.json",
  "autoresearch.last-run.json",
  "autoresearch-dashboard.html",
  "autoresearch.sh",
  "autoresearch.ps1",
  "autoresearch.checks.sh",
  "autoresearch.checks.ps1",
]);

const RESEARCH_DIR = "autoresearch.research";
const RESEARCH_DIR_PREFIX = "autoresearch.research/";
export const REPORT_DIRNAME = "autoresearch-finalize";
export const CLEANUP_SESSION_PATHS = [RESEARCH_DIR, ...SESSION_FILES].sort((a, b) =>
  a.localeCompare(b),
);

export function isAutoresearchSessionArtifact(file: string, mode: SessionArtifactMode): boolean {
  const normalized = String(file || "").replace(/\\/g, "/");
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
