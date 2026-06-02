type LooseObject = Record<string, unknown>;

export interface SourceCleanliness {
  status: "clean" | "source-dirty" | "session-artifacts-dirty" | "unknown";
  sourceDirty: boolean;
  sessionArtifactDirty: boolean;
  sourcePaths: string[];
  sessionArtifactPaths: string[];
  blocks: {
    nextPacket: boolean;
    keepAutomation: boolean;
    finalization: boolean;
  };
  message: string;
  nextAction: string;
  cleanupCommand: string;
  warningCodes: string[];
}

export function buildSourceCleanliness({
  warningDetails = [],
}: {
  warningDetails?: unknown[];
} = {}): SourceCleanliness {
  const warnings = Array.isArray(warningDetails) ? warningDetails.map(recordOrNull) : [];
  const sourceWarnings = warnings.filter((warning) => warning?.code === "git_dirty");
  const sessionWarnings = warnings.filter(
    (warning) => warning?.code === "autoresearch_session_dirty",
  );
  const sourcePaths = uniqueStrings(
    sourceWarnings.flatMap((warning) => stringList(warning?.paths)),
  );
  const sessionArtifactPaths = uniqueStrings(
    sessionWarnings.flatMap((warning) => stringList(warning?.paths)),
  );
  const sourceDirty = sourceWarnings.length > 0;
  const sessionArtifactDirty = sessionWarnings.length > 0;
  const status = sourceDirty
    ? "source-dirty"
    : sessionArtifactDirty
      ? "session-artifacts-dirty"
      : "clean";
  const cleanupCommand = sessionArtifactDirty
    ? sessionArtifactStashCommand(sessionArtifactPaths)
    : "";
  const message = sourceDirty
    ? "Source files are dirty; keep/discard automation and finalization need scoped Git cleanup."
    : sessionArtifactDirty
      ? "Only Autoresearch session artifacts are dirty; source drift is clean, but branch-changing finalization still needs a clean worktree."
      : "No dirty source drift is reported.";
  const nextAction = sourceDirty
    ? "Inspect git status, then set commitPaths/revertPaths or clean the source changes before keep/discard/finalization."
    : sessionArtifactDirty
      ? "Continue read/run work if needed; before finalization, temporarily stash or commit session artifacts, then use finalize-current-tree when the current branch is the review unit."
      : "Proceed from the canonical next action.";

  return {
    status,
    sourceDirty,
    sessionArtifactDirty,
    sourcePaths,
    sessionArtifactPaths,
    blocks: {
      nextPacket: false,
      keepAutomation: sourceDirty,
      finalization: sourceDirty || sessionArtifactDirty,
    },
    message,
    nextAction,
    cleanupCommand,
    warningCodes: uniqueStrings(warnings.map((warning) => stringValue(warning?.code))),
  };
}

function sessionArtifactStashCommand(paths: string[]): string {
  const targets = paths.length
    ? paths.slice(0, 20)
    : [
        "autoresearch.jsonl",
        "autoresearch.md",
        "autoresearch.ideas.md",
        "autoresearch-dashboard.html",
        "autoresearch.research",
        "autoresearch-finalize",
      ];
  return `git stash push --include-untracked -- ${targets.map(shellQuote).join(" ")}`;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean);
}

function recordOrNull(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function shellQuote(value: string): string {
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
}
