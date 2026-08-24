export interface SourceHygieneOptions {
  packageRoot?: string;
}

export interface SourceHygieneOffender {
  path: string;
  reason: string;
}

export interface SourceFileSnapshot {
  content: string;
  path: string;
}

const LOOSE_OBJECT_DECLARATION_PATTERN =
  /\b(?:export\s+)?type\s+LooseObject\s*=\s*Record\s*<\s*string\s*,\s*any\s*>\s*;/;

const RETIRED_DECISION_AUTHORITY_FILES = new Set([
  "decision-authority.ts",
  "loop-governance.ts",
  "operator-readout.ts",
]);
const RETIRED_DECISION_AUTHORITY_SYMBOLS = [
  "acceptedCurrentTreeFinalizationIssue",
  "buildDecisionEnvelope",
  "buildLoopContractStatus",
  "canonicalNextActionForLoop",
  "loopContinuation",
  "selectDecisionAuthority",
] as const;
const DECISION_COMPILER_FORBIDDEN_INPUTS = [
  "canonicalNextAction",
  "dashboard",
  "decisionEnvelope",
  "loopContract",
  "resolvedDecision",
] as const;
const DECISION_COMPILER_FORBIDDEN_IMPORTS = [
  "action-metadata",
  "dashboard-view-model",
  "decision-projection",
  "session-decision",
  "session-read-model",
  "terminal-report",
] as const;

const LOOSE_OBJECT_COMPATIBILITY_ALLOWLIST = new Set(
  [
    "plugins/codex-autoresearch/lib/cli-handlers.ts",
    "plugins/codex-autoresearch/lib/commands/dashboard.ts",
    "plugins/codex-autoresearch/lib/commands/inspect.ts",
    "plugins/codex-autoresearch/lib/commands/lane-runner.ts",
    "plugins/codex-autoresearch/lib/commands/partial-results.ts",
    "plugins/codex-autoresearch/lib/commands/session-forensics.ts",
    "plugins/codex-autoresearch/lib/dashboard-view-model.ts",
    "plugins/codex-autoresearch/lib/drift-doctor.ts",
    "plugins/codex-autoresearch/lib/evidence-redaction.ts",
    "plugins/codex-autoresearch/lib/evidence-registry.ts",
    "plugins/codex-autoresearch/lib/experiment-economics.ts",
    "plugins/codex-autoresearch/lib/experiment-memory.ts",
    "plugins/codex-autoresearch/lib/finalization-plan.ts",
    "plugins/codex-autoresearch/lib/finalize-preview.ts",
    "plugins/codex-autoresearch/lib/recipes.ts",
    "plugins/codex-autoresearch/lib/research-gaps.ts",
    "plugins/codex-autoresearch/lib/runner-progress.ts",
    "plugins/codex-autoresearch/lib/session-core.ts",
    "plugins/codex-autoresearch/lib/session-decision-capsule.ts",
    "plugins/codex-autoresearch/lib/session-forensics.ts",
    "plugins/codex-autoresearch/lib/tool-registry.ts",
    "plugins/codex-autoresearch/lib/truth-signals.ts",
    "plugins/codex-autoresearch/lib/workflow-friction.ts",
    "plugins/codex-autoresearch/scripts/autoresearch.ts",
    "plugins/codex-autoresearch/scripts/finalize-autoresearch.ts",
  ].map(normalizeTrackedPath),
);

const PRIVATE_SOURCE_ROOTS = new Map([
  [".cursor", "editor-private source root"],
  [".learnings", "agent-private learning cache"],
]);

const GENERATED_PATH_PREFIXES = new Map([
  ["docs/superpowers/plans/", "generated superpowers plan"],
]);

const GENERATED_ROOTS = new Map([
  [".cache", "generated cache folder"],
  [".logs", "generated log folder"],
  ["archive", "generated archive folder"],
  ["archives", "generated archive folder"],
  ["cache", "generated cache folder"],
  ["caches", "generated cache folder"],
  ["logs", "generated log folder"],
  ["output", "generated output folder"],
  ["outputs", "generated output folder"],
  ["temp", "temporary folder"],
  ["tmp", "temporary folder"],
]);

const SESSION_ARTIFACT_FILES = new Map([
  ["autoresearch.config.json", "generated Autoresearch session config"],
  ["autoresearch.ideas.md", "generated Autoresearch ideas scratchpad"],
  ["autoresearch.jsonl", "generated Autoresearch ledger"],
  ["autoresearch.last-run.json", "generated Autoresearch packet cache"],
  ["autoresearch.md", "generated Autoresearch session brief"],
  ["autoresearch.ps1", "generated Autoresearch shell wrapper"],
  ["autoresearch.sh", "generated Autoresearch shell wrapper"],
  ["autoresearch-dashboard.html", "generated Autoresearch dashboard export"],
]);

const SESSION_ARTIFACT_DIRS = new Map([
  ["autoresearch.research", "generated Autoresearch research scratchpad"],
]);

const DEMO_SESSION_PREFIX = "examples/demo-session/";
const ALLOWED_PACKAGE_SESSION_ARTIFACTS = new Set([
  "examples/demo-session/autoresearch.checks.ps1",
  "examples/demo-session/autoresearch.config.json",
  "examples/demo-session/autoresearch.ideas.md",
  "examples/demo-session/autoresearch.jsonl",
  "examples/demo-session/autoresearch.md",
  "examples/demo-session/autoresearch.ps1",
  "examples/demo-session/autoresearch.sh",
]);

export function findSourceHygieneOffenders(
  trackedPaths: Iterable<string>,
  options: SourceHygieneOptions = {},
): SourceHygieneOffender[] {
  const packageRoot = normalizeTrackedPath(options.packageRoot || "");
  const offenders = new Map<string, SourceHygieneOffender>();

  for (const rawPath of trackedPaths) {
    const trackedPath = normalizeTrackedPath(rawPath);
    if (!trackedPath) continue;
    const reason = sourceHygieneReason(trackedPath, packageRoot);
    if (reason) offenders.set(trackedPath, { path: trackedPath, reason });
  }

  return [...offenders.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function formatSourceHygieneOffenders(offenders: SourceHygieneOffender[]): string {
  const lines = offenders.map((offender) => `- ${offender.path} (${offender.reason})`);
  return [
    "Tracked source-hygiene artifacts were found:",
    ...lines,
    "",
    "Move each file outside the tracked source, delete it, or run git rm --cached <path> if it should remain local-only.",
  ].join("\n");
}

export function findLooseObjectCompatibilityOffenders(
  sourceFiles: Iterable<SourceFileSnapshot>,
): SourceHygieneOffender[] {
  const offenders = new Map<string, SourceHygieneOffender>();

  for (const sourceFile of sourceFiles) {
    const trackedPath = normalizeTrackedPath(sourceFile.path);
    if (!trackedPath || LOOSE_OBJECT_COMPATIBILITY_ALLOWLIST.has(trackedPath)) continue;
    if (!LOOSE_OBJECT_DECLARATION_PATTERN.test(sourceFile.content)) continue;
    offenders.set(trackedPath, {
      path: trackedPath,
      reason: "new local LooseObject compatibility alias; use UnknownRecord from lib/types/json.js",
    });
  }

  return [...offenders.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function findDecisionCompilerBoundaryOffenders(
  sourceFiles: Iterable<SourceFileSnapshot>,
): SourceHygieneOffender[] {
  const offenders = new Map<string, SourceHygieneOffender>();

  for (const sourceFile of sourceFiles) {
    const trackedPath = normalizeTrackedPath(sourceFile.path);
    if (!isProductionTypeScript(trackedPath)) continue;
    const basename = trackedPath.split("/").at(-1) || "";

    if (RETIRED_DECISION_AUTHORITY_FILES.has(basename)) {
      offenders.set(trackedPath, {
        path: trackedPath,
        reason: `retired decision authority module must stay deleted: ${basename}`,
      });
      continue;
    }

    if (trackedPath.endsWith("/lib/cli/source-hygiene.ts")) continue;

    const retiredSymbol = RETIRED_DECISION_AUTHORITY_SYMBOLS.find((symbol) =>
      containsIdentifier(sourceFile.content, symbol),
    );
    if (retiredSymbol) {
      offenders.set(trackedPath, {
        path: trackedPath,
        reason: `retired decision authority symbol must not regain production callers: ${retiredSymbol}`,
      });
      continue;
    }

    if (
      basename === "finalize-preview.ts" &&
      hasPropertyAccess(sourceFile.content, "sessionDecisionCapsule", [
        "enforcement",
        "nextExperiment",
      ])
    ) {
      offenders.set(trackedPath, {
        path: trackedPath,
        reason:
          "legacy session decision capsules may remain display facts but cannot control finalization policy",
      });
      continue;
    }

    if (
      basename === "session-decision.ts" &&
      hasPropertyAccess(sourceFile.content, "finalization", [
        "actionCode",
        "nextAction",
        "suggestedCommand",
      ])
    ) {
      offenders.set(trackedPath, {
        path: trackedPath,
        reason:
          "finalization projections such as nextAction cannot supply canonical compiler diagnostics",
      });
      continue;
    }

    if (basename === "decision-compiler.ts") {
      const forbiddenImport = DECISION_COMPILER_FORBIDDEN_IMPORTS.find((specifier) =>
        importsSpecifier(sourceFile.content, specifier),
      );
      const forbiddenInput = DECISION_COMPILER_FORBIDDEN_INPUTS.find((identifier) =>
        containsIdentifier(sourceFile.content, identifier),
      );
      if (forbiddenImport || forbiddenInput) {
        offenders.set(trackedPath, {
          path: trackedPath,
          reason:
            "canonical compiler inputs must remain snapshot facts and typed diagnostics, never downstream or legacy projections",
        });
      }
      continue;
    }

    if (
      basename === "coherent-session-snapshot.ts" &&
      ["decision-compiler", "session-decision", "decision-projection"].some((specifier) =>
        importsSpecifier(sourceFile.content, specifier),
      )
    ) {
      offenders.set(trackedPath, {
        path: trackedPath,
        reason:
          "coherent snapshot capture must stay below the compiler to prevent an authority cycle",
      });
    }
  }

  return [...offenders.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function isProductionTypeScript(trackedPath: string): boolean {
  if (!trackedPath.endsWith(".ts")) return false;
  return ["plugins/codex-autoresearch/lib/", "plugins/codex-autoresearch/scripts/"].some(
    (prefix) => trackedPath.startsWith(prefix) && trackedPath.length > prefix.length + 3,
  );
}

function containsIdentifier(source: string, identifier: string): boolean {
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(identifier, offset);
    if (index < 0) return false;
    const before = index > 0 ? source[index - 1] : "";
    const after = source[index + identifier.length] || "";
    if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) return true;
    offset = index + identifier.length;
  }
  return false;
}

function hasPropertyAccess(source: string, root: string, properties: readonly string[]): boolean {
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(root, offset);
    if (index < 0) return false;
    const before = index > 0 ? source[index - 1] : "";
    if (isIdentifierCharacter(before)) {
      offset = index + root.length;
      continue;
    }
    let cursor = skipWhitespace(source, index + root.length);
    if (source.startsWith("?.", cursor)) cursor += 2;
    else if (source[cursor] === ".") cursor += 1;
    else {
      offset = index + root.length;
      continue;
    }
    cursor = skipWhitespace(source, cursor);
    if (
      properties.some(
        (property) =>
          source.startsWith(property, cursor) &&
          !isIdentifierCharacter(source[cursor + property.length] || ""),
      )
    ) {
      return true;
    }
    offset = index + root.length;
  }
  return false;
}

function importsSpecifier(source: string, specifier: string): boolean {
  let cursor = 0;
  while (cursor < source.length) {
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      cursor += 1;
      continue;
    }
    const start = cursor;
    cursor += 1;
    let value = "";
    while (cursor < source.length && source[cursor] !== quote) {
      if (source[cursor] === "\\" && cursor + 1 < source.length) {
        value += source[cursor] + source[cursor + 1];
        cursor += 2;
      } else {
        value += source[cursor];
        cursor += 1;
      }
    }
    if (cursor >= source.length) return false;
    if (value.includes(specifier) && isImportStringLiteral(source, start)) return true;
    cursor += 1;
  }
  return false;
}

function isImportStringLiteral(source: string, quoteIndex: number): boolean {
  let cursor = quoteIndex - 1;
  while (cursor >= 0 && isWhitespace(source[cursor])) cursor -= 1;
  if (cursor >= 0 && source[cursor] === "(") {
    cursor -= 1;
    while (cursor >= 0 && isWhitespace(source[cursor])) cursor -= 1;
    const end = cursor + 1;
    while (cursor >= 0 && isIdentifierCharacter(source[cursor])) cursor -= 1;
    if (source.slice(cursor + 1, end) === "import") return true;
  }
  const end = cursor + 1;
  while (cursor >= 0 && isIdentifierCharacter(source[cursor])) cursor -= 1;
  return source.slice(cursor + 1, end) === "from";
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && isWhitespace(source[cursor])) cursor += 1;
  return cursor;
}

function isWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r";
}

function isIdentifierCharacter(value: string): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    code === 36 ||
    (code >= 97 && code <= 122)
  );
}

function sourceHygieneReason(trackedPath: string, packageRoot: string): string {
  const generatedPrefixReason = generatedPathPrefixReason(trackedPath);
  if (generatedPrefixReason) return generatedPrefixReason;

  const segments = trackedPath.split("/");
  const privateSegment = segments.find((segment) => PRIVATE_SOURCE_ROOTS.has(segment));
  if (privateSegment) return `${PRIVATE_SOURCE_ROOTS.get(privateSegment)}: ${privateSegment}`;

  const rootReason = generatedRootReason(segments[0]);
  if (rootReason) return `${rootReason}: ${segments[0]}`;

  const rootSessionReason = sessionArtifactReason(trackedPath);
  if (rootSessionReason) return rootSessionReason;

  const packageRelative = packageRelativePath(trackedPath, packageRoot);
  if (!packageRelative || isAllowedPackageSessionArtifact(packageRelative)) return "";

  const demoSessionReason = nestedDemoSessionReason(packageRelative, packageRoot);
  if (demoSessionReason) return demoSessionReason;

  const packageSegments = packageRelative.split("/");
  const packageGeneratedReason = generatedRootReason(packageSegments[0]);
  if (packageGeneratedReason)
    return `${packageGeneratedReason}: ${packageRoot}/${packageSegments[0]}`;

  return sessionArtifactReason(packageRelative);
}

function generatedPathPrefixReason(trackedPath: string): string {
  for (const [prefix, reason] of GENERATED_PATH_PREFIXES) {
    if (trackedPath.startsWith(prefix)) return reason;
  }
  return "";
}

function generatedRootReason(segment: string | undefined): string {
  if (!segment) return "";
  return GENERATED_ROOTS.get(segment) || "";
}

function sessionArtifactReason(relativePath: string): string {
  if (SESSION_ARTIFACT_FILES.has(relativePath)) {
    return SESSION_ARTIFACT_FILES.get(relativePath) || "";
  }
  const [firstSegment] = relativePath.split("/");
  if (SESSION_ARTIFACT_DIRS.has(firstSegment)) {
    return SESSION_ARTIFACT_DIRS.get(firstSegment) || "";
  }
  return "";
}

function packageRelativePath(trackedPath: string, packageRoot: string): string {
  if (!packageRoot || trackedPath === packageRoot) return "";
  const packagePrefix = `${packageRoot}/`;
  return trackedPath.startsWith(packagePrefix) ? trackedPath.slice(packagePrefix.length) : "";
}

function isAllowedPackageSessionArtifact(packageRelativePath: string): boolean {
  return ALLOWED_PACKAGE_SESSION_ARTIFACTS.has(packageRelativePath);
}

function nestedDemoSessionReason(packageRelativePath: string, packageRoot: string): string {
  if (!packageRelativePath.startsWith(DEMO_SESSION_PREFIX)) return "";
  const demoRelativePath = packageRelativePath.slice(DEMO_SESSION_PREFIX.length);
  const [firstSegment] = demoRelativePath.split("/");
  const generatedReason = generatedRootReason(firstSegment);
  if (generatedReason) {
    return `${generatedReason}: ${packageRoot}/${DEMO_SESSION_PREFIX}${firstSegment}`;
  }
  return sessionArtifactReason(demoRelativePath);
}

function normalizeTrackedPath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .trim();
}
