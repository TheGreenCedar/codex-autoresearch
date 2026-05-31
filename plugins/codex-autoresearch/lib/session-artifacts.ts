export type SessionArtifactMode = "finalization" | "dirty-tree" | "source-checkout";

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
export const REPORT_DIRNAME = "autoresearch-finalize";
export const CLEANUP_SESSION_PATHS = [RESEARCH_DIR, ...SESSION_FILES].sort((a, b) =>
  a.localeCompare(b),
);

export function isAutoresearchSessionArtifact(file: string, mode: SessionArtifactMode): boolean {
  const normalized = String(file || "").replace(/\\/g, "/");
  const common =
    SESSION_FILES.has(normalized) ||
    normalized.startsWith("autoresearch.research/") ||
    normalized.startsWith(".git/autoresearch-runtime/");
  if (common) return true;
  if (mode === "dirty-tree") {
    return (
      normalized.startsWith("autoresearch.") ||
      normalized.startsWith("autoresearch-") ||
      normalized === ".gitattributes"
    );
  }
  if (mode === "source-checkout") {
    return (
      normalized.startsWith("autoresearch.") ||
      normalized.startsWith("autoresearch-") ||
      normalized === REPORT_DIRNAME ||
      normalized.startsWith(`${REPORT_DIRNAME}/`)
    );
  }
  return (
    normalized.startsWith("autoresearch.") ||
    normalized.startsWith("autoresearch-") ||
    normalized === RESEARCH_DIR ||
    normalized.startsWith("autoresearch.research/") ||
    normalized === REPORT_DIRNAME ||
    normalized.startsWith(`${REPORT_DIRNAME}/`)
  );
}
