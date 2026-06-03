import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type RuntimeAvailability = "fresh" | "stale" | "missing" | "unavailable";
export type BuiltRuntimeStatus = "available" | "missing" | "unavailable";

export interface RuntimeDriftFacts {
  sourceVersion: string;
  packageRoot: string;
  builtRuntimeExists: boolean | null;
  installedRuntimeVersion: string | null;
  installedRuntimePath: string;
  sourceRuntimeFingerprint?: string | null;
  installedRuntimeFingerprint?: string | null;
}

export interface RuntimeDriftSummary {
  sourceVersion: string;
  packageRoot: string;
  installedRuntime: RuntimeAvailability;
  builtRuntime: BuiltRuntimeStatus;
  runtimeFingerprint: "matched" | "mismatched" | "unavailable";
  smokeCheck: string;
  nextActionHint: string;
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

  return {
    sourceVersion,
    packageRoot,
    installedRuntime,
    builtRuntime,
    runtimeFingerprint,
    smokeCheck,
    nextActionHint: buildNextActionHint({
      sourceVersion,
      installedRuntime,
      installedRuntimeVersion: facts.installedRuntimeVersion,
      builtRuntime,
      runtimeFingerprint,
      installedRuntimePath: facts.installedRuntimePath,
      inspectionCommand,
      smokeCheck,
    }),
  };
}

export async function inspectRuntimeDrift(input: {
  packageRoot: string;
  sourceVersion: string;
}): Promise<RuntimeDriftSummary> {
  const packageRoot = path.resolve(input.packageRoot);
  const builtRuntimePath = path.join(packageRoot, "dist", "scripts", "autoresearch.mjs");
  const builtRuntimeExists = await fileExists(builtRuntimePath);
  const sourceRuntimeFingerprint =
    builtRuntimeExists === true ? await fileFingerprint(builtRuntimePath) : null;
  const installedRuntime = await inspectInstalledRuntime(input.sourceVersion);

  return inspectRuntimeDriftFromFacts({
    sourceVersion: input.sourceVersion,
    packageRoot,
    builtRuntimeExists,
    installedRuntimeVersion: installedRuntime.version,
    installedRuntimePath: installedRuntime.path,
    sourceRuntimeFingerprint,
    installedRuntimeFingerprint: installedRuntime.fingerprint,
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
  inspectionCommand,
  smokeCheck,
}: {
  sourceVersion: string;
  installedRuntime: RuntimeAvailability;
  installedRuntimeVersion: string | null;
  builtRuntime: BuiltRuntimeStatus;
  runtimeFingerprint: "matched" | "mismatched" | "unavailable";
  installedRuntimePath: string;
  inspectionCommand: string;
  smokeCheck: string;
}): string {
  if (builtRuntime === "missing") {
    return `Build the local runtime with npm run build:node, then inspect installed runtime drift with: ${inspectionCommand}`;
  }
  if (builtRuntime === "unavailable") {
    return `Inspect filesystem access for the local runtime build, then rerun runtime drift inspection with: ${inspectionCommand}`;
  }
  if (installedRuntime === "stale") {
    if (installedRuntimeVersion?.trim() === sourceVersion && runtimeFingerprint === "mismatched") {
      return `Installed runtime version matches source ${sourceVersion}, but the built entrypoint fingerprint differs. Inspect or refresh the runtime with: ${inspectionCommand}`;
    }
    return `Installed runtime is stale for source ${sourceVersion}. Inspect or refresh the runtime with: ${inspectionCommand}`;
  }
  if (installedRuntime === "missing") {
    return `Installed runtime is missing at ${installedRuntimePath}. Inspect or refresh the runtime with: ${inspectionCommand}`;
  }
  if (installedRuntime === "unavailable") {
    return `Installed runtime fingerprint evidence is unavailable. Inspect the runtime with: ${inspectionCommand}`;
  }
  return `Runtime surfaces look fresh; smoke check with: ${smokeCheck}`;
}

async function inspectInstalledRuntime(sourceVersion: string): Promise<{
  path: string;
  version: string | null;
  fingerprint: string | null;
}> {
  const cacheRoot = path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "thegreencedar-autoresearch",
    "codex-autoresearch",
  );

  let entries: string[];
  try {
    entries = (await fsp.readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    return isMissingPathError(error)
      ? { path: cacheRoot, version: null, fingerprint: null }
      : { path: "", version: null, fingerprint: null };
  }

  if (entries.length === 0) return { path: cacheRoot, version: null, fingerprint: null };

  const preferred = entries.includes(sourceVersion)
    ? sourceVersion
    : sortVersionCandidates(entries)[0];
  const installedRuntimePath = path.join(cacheRoot, preferred);
  const installedVersion = await readPackageVersion(installedRuntimePath);
  const fingerprint = await fileFingerprint(
    path.join(installedRuntimePath, "dist", "scripts", "autoresearch.mjs"),
  );
  return { path: installedRuntimePath, version: installedVersion, fingerprint };
}

async function readPackageVersion(installedRuntimePath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(path.join(installedRuntimePath, "package.json"), "utf8"),
    );
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version : null;
  } catch {
    return null;
  }
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

function sortVersionCandidates(versions: string[]): string[] {
  return [...versions].sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }),
  );
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
