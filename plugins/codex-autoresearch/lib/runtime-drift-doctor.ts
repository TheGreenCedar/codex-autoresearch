import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type RuntimeAvailability = "fresh" | "stale" | "missing" | "unavailable";
export type BuiltRuntimeStatus = "available" | "missing" | "unavailable";
export type RuntimeTrustScope = "source-checkout" | "installed-plugin";
export type RuntimePackageSurface =
  | "source-checkout"
  | "package-artifact"
  | "active-installed-cache"
  | "unavailable";
export type InstalledRuntimeShape =
  | "hydrated-runtime"
  | "source-shaped-package"
  | "package-artifact"
  | "missing"
  | "unavailable";

export interface InstalledRuntimeProvenance {
  source:
    | "launcher-package-root"
    | "canonical-cache-layout"
    | "legacy-cache-fallback"
    | "plugin-manifest";
  status: "selected" | "ambiguous" | "missing" | "unavailable";
  path: string;
  candidates: string[];
  detail: string;
}

export interface RuntimeStatus {
  status: string;
  version?: string;
}

export interface RuntimeDriftFacts {
  sourceVersion: string;
  packageRoot: string;
  builtRuntimeExists: boolean | null;
  installedRuntimeVersion: string | null;
  installedRuntimePath: string;
  sourceRuntimeFingerprint?: string | null;
  installedRuntimeFingerprint?: string | null;
  packageSurface?: RuntimePackageSurface;
  installedRuntimeShape?: InstalledRuntimeShape;
  installedRuntimeProvenance?: InstalledRuntimeProvenance;
}

export interface RuntimeDriftSummary {
  sourceVersion: string;
  packageRoot: string;
  installedRuntime: RuntimeAvailability;
  builtRuntime: BuiltRuntimeStatus;
  runtimeFingerprint: "matched" | "mismatched" | "unavailable";
  smokeCheck: string;
  nextActionHint: string;
  packageSurface: RuntimePackageSurface;
  installedRuntimePath: string;
  installedRuntimeVersion: string | null;
  installedRuntimeShape: InstalledRuntimeShape;
  installedRuntimeProvenance: InstalledRuntimeProvenance;
}

export function summarizeRuntimeAuthority(input: {
  sourceRuntime?: RuntimeStatus | null;
  installedRuntime?: RuntimeStatus | null;
  trustScope?: RuntimeTrustScope;
}) {
  const trustScope = input.trustScope || "source-checkout";
  const installedStatus = normalizeRuntimeStatus(input.installedRuntime?.status);
  const installedFresh = installedStatus === "fresh";
  const installedNeedsAttention = !installedFresh;
  const blocking = installedNeedsAttention && trustScope === "installed-plugin";
  return {
    sourceRuntime: input.sourceRuntime || null,
    installedRuntime: input.installedRuntime || null,
    trustScope,
    blocking,
    blocker: blocking ? runtimeAuthorityBlocker(installedStatus) : "",
    warning:
      installedNeedsAttention && trustScope === "source-checkout"
        ? runtimeAuthorityWarning(installedStatus)
        : "",
  };
}

function normalizeRuntimeStatus(status: unknown): string {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  return normalized || "unknown";
}

function runtimeAuthorityBlocker(installedStatus: string): string {
  if (installedStatus === "stale") {
    return "Stale installed plugin runtime blocks this installed-runtime verification; inspect or refresh the installed runtime before claiming installed behavior.";
  }
  if (installedStatus === "missing") {
    return "Missing installed plugin runtime blocks this installed-runtime verification; inspect or refresh the installed runtime before claiming installed behavior.";
  }
  if (installedStatus === "unavailable") {
    return "Unavailable installed plugin runtime evidence blocks this installed-runtime verification; inspect the installed runtime before claiming installed behavior.";
  }
  return "Installed plugin runtime is not fresh, so installed-runtime verification is blocked until the installed runtime is inspected or refreshed.";
}

function runtimeAuthorityWarning(installedStatus: string): string {
  if (installedStatus === "stale") {
    return "Stale installed plugin runtime is advisory for source-checkout work; verify installed runtime before claiming live installed behavior.";
  }
  if (installedStatus === "missing") {
    return "Missing installed plugin runtime is advisory for source-checkout work; verify installed runtime before claiming live installed behavior.";
  }
  if (installedStatus === "unavailable") {
    return "Unavailable installed plugin runtime evidence is advisory for source-checkout work; verify installed runtime before claiming live installed behavior.";
  }
  return "Installed plugin runtime freshness is unknown for source-checkout work; verify installed runtime before claiming live installed behavior.";
}

export function inspectRuntimeDriftFromFacts(facts: RuntimeDriftFacts): RuntimeDriftSummary {
  const sourceVersion = facts.sourceVersion.trim();
  const packageRoot = facts.packageRoot;
  const installedRuntime = classifyInstalledRuntime({
    sourceVersion,
    installedRuntimeVersion: facts.installedRuntimeVersion,
    installedRuntimePath: facts.installedRuntimePath,
    sourceRuntimeFingerprint: facts.sourceRuntimeFingerprint ?? null,
    installedRuntimeFingerprint: facts.installedRuntimeFingerprint ?? null,
  });
  const runtimeFingerprint = classifyRuntimeFingerprint({
    sourceRuntimeFingerprint: facts.sourceRuntimeFingerprint ?? null,
    installedRuntimeFingerprint: facts.installedRuntimeFingerprint ?? null,
  });
  const builtRuntime = classifyBuiltRuntime(facts.builtRuntimeExists);
  const smokeCheck = buildSmokeCheck(packageRoot, builtRuntime);
  const inspectionCommand = buildInspectionCommand(packageRoot);
  const installedRuntimeProvenance = facts.installedRuntimeProvenance || {
    source: "plugin-manifest",
    status: "unavailable",
    path: facts.installedRuntimePath,
    candidates: [],
    detail: "Installed runtime provenance was not inspected.",
  };

  return {
    sourceVersion,
    packageRoot,
    installedRuntime,
    builtRuntime,
    runtimeFingerprint,
    smokeCheck,
    packageSurface: facts.packageSurface || "unavailable",
    installedRuntimePath: facts.installedRuntimePath,
    installedRuntimeVersion: facts.installedRuntimeVersion,
    installedRuntimeShape: facts.installedRuntimeShape || "unavailable",
    installedRuntimeProvenance,
    nextActionHint: buildNextActionHint({
      sourceVersion,
      installedRuntime,
      installedRuntimeVersion: facts.installedRuntimeVersion,
      builtRuntime,
      runtimeFingerprint,
      installedRuntimePath: facts.installedRuntimePath,
      installedRuntimeShape: facts.installedRuntimeShape || "unavailable",
      installedRuntimeProvenance,
      inspectionCommand,
      smokeCheck,
    }),
  };
}

export async function inspectRuntimeDrift(input: {
  packageRoot: string;
  sourceVersion: string;
  pluginCacheRoot?: string;
}): Promise<RuntimeDriftSummary> {
  const packageRoot = path.resolve(input.packageRoot);
  const builtRuntimePath = path.join(packageRoot, "dist", "scripts", "autoresearch.mjs");
  const builtRuntimeExists = await fileExists(builtRuntimePath);
  const sourceRuntimeFingerprint =
    builtRuntimeExists === true ? await fileFingerprint(builtRuntimePath) : null;
  const installedRuntime = await inspectInstalledRuntime({
    packageRoot,
    sourceVersion: input.sourceVersion,
    pluginCacheRoot:
      input.pluginCacheRoot ||
      path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache"),
  });

  return inspectRuntimeDriftFromFacts({
    sourceVersion: input.sourceVersion,
    packageRoot,
    builtRuntimeExists,
    installedRuntimeVersion: installedRuntime.version,
    installedRuntimePath: installedRuntime.path,
    sourceRuntimeFingerprint,
    installedRuntimeFingerprint: installedRuntime.fingerprint,
    packageSurface: await packageSurface(packageRoot, installedRuntime),
    installedRuntimeShape: installedRuntime.shape,
    installedRuntimeProvenance: installedRuntime.provenance,
  });
}

function classifyInstalledRuntime({
  sourceVersion,
  installedRuntimeVersion,
  installedRuntimePath,
  sourceRuntimeFingerprint,
  installedRuntimeFingerprint,
}: {
  sourceVersion: string;
  installedRuntimeVersion: string | null;
  installedRuntimePath: string;
  sourceRuntimeFingerprint: string | null;
  installedRuntimeFingerprint: string | null;
}): RuntimeAvailability {
  const knownPath = installedRuntimePath.trim().length > 0;
  if (installedRuntimeVersion === null) {
    return knownPath ? "missing" : "unavailable";
  }
  if (installedRuntimeVersion.trim() !== sourceVersion) return "stale";
  const runtimeFingerprint = classifyRuntimeFingerprint({
    sourceRuntimeFingerprint,
    installedRuntimeFingerprint,
  });
  if (runtimeFingerprint === "matched") return "fresh";
  if (runtimeFingerprint === "mismatched") return "stale";
  return "unavailable";
}

function classifyBuiltRuntime(builtRuntimeExists: boolean | null): BuiltRuntimeStatus {
  if (builtRuntimeExists === true) return "available";
  if (builtRuntimeExists === false) return "missing";
  return "unavailable";
}

function buildSmokeCheck(packageRoot: string, builtRuntime: BuiltRuntimeStatus): string {
  if (builtRuntime !== "available") {
    return "Build the Node runtime with npm run build:node before running the smoke check.";
  }
  return `node ${quoteCommandArg(path.join(packageRoot, "dist", "scripts", "autoresearch.mjs"))} --help`;
}

function buildInspectionCommand(packageRoot: string): string {
  return `node ${quoteCommandArg(path.join(packageRoot, "scripts", "autoresearch.mjs"))} doctor --cwd ${quoteCommandArg(packageRoot)} --explain`;
}

function buildNextActionHint({
  sourceVersion,
  installedRuntime,
  installedRuntimeVersion,
  builtRuntime,
  runtimeFingerprint,
  installedRuntimePath,
  installedRuntimeShape,
  installedRuntimeProvenance,
  inspectionCommand,
  smokeCheck,
}: {
  sourceVersion: string;
  installedRuntime: RuntimeAvailability;
  installedRuntimeVersion: string | null;
  builtRuntime: BuiltRuntimeStatus;
  runtimeFingerprint: "matched" | "mismatched" | "unavailable";
  installedRuntimePath: string;
  installedRuntimeShape: InstalledRuntimeShape;
  installedRuntimeProvenance: InstalledRuntimeProvenance;
  inspectionCommand: string;
  smokeCheck: string;
}): string {
  if (installedRuntimeProvenance.status === "ambiguous") {
    return `Installed runtime discovery is ambiguous across ${installedRuntimeProvenance.candidates.join(
      ", ",
    )}. Remove or disambiguate stale cache entries, then rerun: ${inspectionCommand}`;
  }
  if (builtRuntime === "missing") {
    return `Build the local runtime with npm run build:node, then inspect installed runtime drift with: ${inspectionCommand}`;
  }
  if (builtRuntime === "unavailable") {
    return `Inspect filesystem access for the local runtime build, then rerun runtime drift inspection with: ${inspectionCommand}`;
  }
  if (installedRuntime === "stale") {
    if (installedRuntimeVersion?.trim() === sourceVersion && runtimeFingerprint === "mismatched") {
      return "Installed runtime version matches source but the built entrypoint fingerprint differs. Inspect the installed cache path, refresh the plugin from the Codex plugin UI or configured marketplace, then smoke the installed launcher with --help before trusting runtime behavior.";
    }
    return `Installed runtime is stale for source ${sourceVersion}. Inspect or refresh the runtime with: ${inspectionCommand}`;
  }
  if (installedRuntime === "missing") {
    return `Installed runtime is missing at ${installedRuntimePath}. Inspect or refresh the runtime with: ${inspectionCommand}`;
  }
  if (installedRuntime === "unavailable") {
    if (installedRuntimeShape === "source-shaped-package") {
      return `The installed cache at ${installedRuntimePath} is source-shaped and not hydrated. Run its launcher once, then rerun: ${inspectionCommand}`;
    }
    return `Installed runtime fingerprint evidence is unavailable. Inspect the runtime with: ${inspectionCommand}`;
  }
  return `Runtime surfaces look fresh; smoke check with: ${smokeCheck}`;
}

type PluginIdentity = { publisher: string; plugin: string; version: string };
type RuntimeCandidate = {
  path: string;
  version: string;
  fingerprint: string | null;
  shape: InstalledRuntimeShape;
};
type InstalledRuntimeInspection = {
  path: string;
  version: string | null;
  fingerprint: string | null;
  shape: InstalledRuntimeShape;
  provenance: InstalledRuntimeProvenance;
};

const LEGACY_CACHE_NAMESPACE = "thegreencedar-autoresearch";

async function inspectInstalledRuntime(input: {
  packageRoot: string;
  sourceVersion: string;
  pluginCacheRoot: string;
}): Promise<InstalledRuntimeInspection> {
  const identity = await pluginIdentity(input.packageRoot, input.sourceVersion);
  if (!identity) {
    return emptyInspection("", "plugin-manifest", "unavailable", "Plugin identity is unavailable.");
  }

  const launcherRelative = path.relative(input.pluginCacheRoot, input.packageRoot).split(path.sep);
  if (
    launcherRelative.length === 3 &&
    launcherRelative[0] === identity.publisher &&
    launcherRelative[1] === identity.plugin &&
    launcherRelative[2] === identity.version
  ) {
    const launcher = await runtimeCandidate(input.packageRoot, identity);
    return launcher
      ? selectedInspection(
          launcher,
          "launcher-package-root",
          "Selected the cache package that owns the running launcher.",
        )
      : emptyInspection(
          "",
          "launcher-package-root",
          "unavailable",
          "The running launcher does not match its package metadata.",
        );
  }

  const canonical = await canonicalVersionPaths(input.pluginCacheRoot, identity);
  if (canonical.status === "unavailable") {
    return emptyInspection("", "canonical-cache-layout", "unavailable", canonical.detail);
  }
  if (canonical.status === "found") {
    const candidates = (
      await Promise.all(
        canonical.paths.map((runtimePath) => runtimeCandidate(runtimePath, identity)),
      )
    ).filter((candidate): candidate is RuntimeCandidate => candidate !== null);
    if (candidates.length > 1) {
      return emptyInspection(
        "",
        "canonical-cache-layout",
        "ambiguous",
        "Multiple canonical versions are metadata-valid and no launcher selected one.",
        candidates.map((candidate) => candidate.path),
      );
    }
    if (candidates.length === 1) {
      return selectedInspection(
        candidates[0],
        "canonical-cache-layout",
        "Selected the only metadata-valid canonical cache version.",
      );
    }
    if (canonical.paths.length > 0) {
      return emptyInspection(
        "",
        "canonical-cache-layout",
        "unavailable",
        "Canonical version directories do not match package metadata.",
        canonical.paths,
      );
    }
  }

  const legacyCandidates = await legacyRuntimeCandidates(input.pluginCacheRoot, identity);
  if (legacyCandidates === null) {
    return emptyInspection(
      "",
      "legacy-cache-fallback",
      "unavailable",
      "The legacy cache fallback could not be read.",
    );
  }
  if (legacyCandidates.length > 1) {
    return emptyInspection(
      "",
      "legacy-cache-fallback",
      "ambiguous",
      "Multiple legacy cache versions are metadata-valid.",
      legacyCandidates.map((candidate) => candidate.path),
    );
  }
  if (legacyCandidates.length === 1) {
    return selectedInspection(
      legacyCandidates[0],
      "legacy-cache-fallback",
      "Canonical discovery found no install; selected the only legacy cache version.",
    );
  }
  return emptyInspection(
    canonical.root,
    "canonical-cache-layout",
    "missing",
    "No canonical install was found; the labelled legacy fallback was also empty.",
  );
}

async function runtimeCandidate(
  runtimePath: string,
  expected: PluginIdentity,
): Promise<RuntimeCandidate | null> {
  const version = path.basename(runtimePath);
  const [identity, packageJson] = await Promise.all([
    pluginIdentity(runtimePath, version),
    readJson(path.join(runtimePath, "package.json")),
  ]);
  if (
    !identity ||
    identity.publisher !== expected.publisher ||
    identity.plugin !== expected.plugin ||
    packageJson?.name !== expected.plugin ||
    packageJson?.version !== version
  ) {
    return null;
  }

  const fingerprint = await fileFingerprint(
    path.join(runtimePath, "dist", "scripts", "autoresearch.mjs"),
  );
  const shape = fingerprint
    ? "hydrated-runtime"
    : (await fileExists(path.join(runtimePath, "scripts", "autoresearch.ts"))) === true
      ? "source-shaped-package"
      : (await fileExists(path.join(runtimePath, "scripts", "autoresearch.mjs"))) === true
        ? "package-artifact"
        : "unavailable";
  return { path: runtimePath, version, fingerprint, shape };
}

async function pluginIdentity(
  packageRoot: string,
  expectedVersion: string,
): Promise<PluginIdentity | null> {
  const manifest = await readJson(path.join(packageRoot, ".codex-plugin", "plugin.json"));
  if (
    typeof manifest?.name !== "string" ||
    manifest.version !== expectedVersion ||
    typeof manifest.repository !== "string"
  ) {
    return null;
  }
  try {
    const repository = new URL(manifest.repository);
    const [publisher, plugin] = repository.pathname.split("/").filter(Boolean);
    if (
      repository.hostname.toLowerCase() !== "github.com" ||
      !publisher ||
      plugin?.replace(/\.git$/i, "").toLowerCase() !== manifest.name.toLowerCase()
    ) {
      return null;
    }
    return { publisher, plugin: manifest.name, version: expectedVersion };
  } catch {
    return null;
  }
}

async function legacyRuntimeCandidates(
  pluginCacheRoot: string,
  identity: PluginIdentity,
): Promise<RuntimeCandidate[] | null> {
  const legacyRoot = path.join(pluginCacheRoot, LEGACY_CACHE_NAMESPACE);
  const topLevel = await childDirectories(legacyRoot, true);
  if (topLevel === null) return null;

  const pluginRoots = [
    path.join(legacyRoot, identity.plugin),
    ...topLevel
      .filter((entry) => path.basename(entry).startsWith("plugin-install-"))
      .map((entry) => path.join(entry, identity.plugin)),
  ];
  const versionRoots = (
    await Promise.all(pluginRoots.map((root) => childDirectories(root, true)))
  ).flatMap((entries) => entries || []);
  return (
    await Promise.all(versionRoots.map((runtimePath) => runtimeCandidate(runtimePath, identity)))
  ).filter((candidate): candidate is RuntimeCandidate => candidate !== null);
}

function selectedInspection(
  candidate: RuntimeCandidate,
  source: InstalledRuntimeProvenance["source"],
  detail: string,
): InstalledRuntimeInspection {
  return {
    ...candidate,
    provenance: {
      source,
      status: "selected",
      path: candidate.path,
      candidates: [candidate.path],
      detail,
    },
  };
}

function emptyInspection(
  pathValue: string,
  source: InstalledRuntimeProvenance["source"],
  status: InstalledRuntimeProvenance["status"],
  detail: string,
  candidates: string[] = [],
): InstalledRuntimeInspection {
  return {
    path: pathValue,
    version: null,
    fingerprint: null,
    shape: status === "missing" ? "missing" : "unavailable",
    provenance: { source, status, path: pathValue, candidates: [...candidates].sort(), detail },
  };
}

async function canonicalVersionPaths(
  pluginCacheRoot: string,
  identity: PluginIdentity,
): Promise<{
  status: "found" | "missing" | "unavailable";
  root: string;
  paths: string[];
  detail: string;
}> {
  const root = path.join(pluginCacheRoot, identity.publisher, identity.plugin);
  try {
    const publishers = await fsp.readdir(pluginCacheRoot, { withFileTypes: true });
    const publisher = publishers.find(
      (entry) => entry.isDirectory() && entry.name === identity.publisher,
    );
    if (!publisher) {
      const wrongCase = publishers.some(
        (entry) =>
          entry.isDirectory() && entry.name.toLowerCase() === identity.publisher.toLowerCase(),
      );
      return {
        status: wrongCase ? "unavailable" : "missing",
        root,
        paths: [],
        detail: wrongCase ? `Publisher cache casing must be ${identity.publisher}.` : "",
      };
    }

    const publisherRoot = path.join(pluginCacheRoot, publisher.name);
    const plugins = await fsp.readdir(publisherRoot, { withFileTypes: true });
    const plugin = plugins.find((entry) => entry.isDirectory() && entry.name === identity.plugin);
    if (!plugin) {
      const wrongCase = plugins.some(
        (entry) =>
          entry.isDirectory() && entry.name.toLowerCase() === identity.plugin.toLowerCase(),
      );
      return {
        status: wrongCase ? "unavailable" : "missing",
        root,
        paths: [],
        detail: wrongCase ? `Plugin cache casing must be ${identity.plugin}.` : "",
      };
    }
    const paths = await childDirectories(root);
    return paths === null
      ? { status: "unavailable", root, paths: [], detail: "Version directories are unreadable." }
      : { status: "found", root, paths, detail: "" };
  } catch (error) {
    return isMissingPathError(error)
      ? { status: "missing", root, paths: [], detail: "" }
      : { status: "unavailable", root, paths: [], detail: String(error) };
  }
}

async function childDirectories(parent: string, missingIsEmpty = false): Promise<string[] | null> {
  try {
    return (await fsp.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  } catch (error) {
    return missingIsEmpty && isMissingPathError(error) ? [] : null;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function packageSurface(
  packageRoot: string,
  installed: InstalledRuntimeInspection,
): Promise<RuntimePackageSurface> {
  if (installed.path && samePath(packageRoot, installed.path)) return "active-installed-cache";
  if ((await fileExists(path.join(packageRoot, "scripts", "autoresearch.ts"))) === true) {
    return "source-checkout";
  }
  if ((await fileExists(path.join(packageRoot, "scripts", "autoresearch.mjs"))) === true) {
    return "package-artifact";
  }
  return "unavailable";
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function fileExists(filePath: string): Promise<boolean | null> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch (error) {
    return isMissingPathError(error) ? false : null;
  }
}

async function fileFingerprint(filePath: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return null;
    return createHash("sha256")
      .update(await fsp.readFile(filePath))
      .digest("hex");
  } catch {
    return null;
  }
}

function classifyRuntimeFingerprint({
  sourceRuntimeFingerprint,
  installedRuntimeFingerprint,
}: {
  sourceRuntimeFingerprint: string | null;
  installedRuntimeFingerprint: string | null;
}): "matched" | "mismatched" | "unavailable" {
  const source = sourceRuntimeFingerprint?.trim();
  const installed = installedRuntimeFingerprint?.trim();
  if (!source || !installed) return "unavailable";
  return source === installed ? "matched" : "mismatched";
}

function quoteCommandArg(value: string): string {
  const normalized = (value.trim() || ".").replace(/\\/g, "/");
  if (/^[\w@%+=:,./\\-]+$/.test(normalized)) return normalized;
  return JSON.stringify(normalized);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
