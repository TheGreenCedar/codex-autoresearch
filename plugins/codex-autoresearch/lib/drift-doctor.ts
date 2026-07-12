import fsp from "node:fs/promises";
import path from "node:path";
import { PLUGIN_VERSION } from "./plugin-version.js";
import { resolvePackageRoot, resolveRepoRoot } from "./runtime-paths.js";

type LooseObject = Record<string, any>;
type Warning = string;
type VersionSurfaces = Record<string, string>;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
type RoutingResult = {
  ok: boolean;
  available: boolean;
  warning?: Warning;
  pluginName?: string;
  path?: string;
  version?: string;
  confidence?: string;
};

export async function inspectVersionSurfaces({ pluginRoot }: { pluginRoot: string }) {
  const surfaces: VersionSurfaces = {
    packageJson: await readJsonVersion(path.join(pluginRoot, "package.json")),
    manifest: await readJsonVersion(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
    cliRuntime: await readRegexVersionCandidate(
      [
        path.join(pluginRoot, "scripts", "autoresearch.ts"),
        path.join(pluginRoot, "dist", "scripts", "autoresearch.mjs"),
        path.join(pluginRoot, "scripts", "autoresearch.mjs"),
      ],
      /pluginVersion:\s*PLUGIN_VERSION/s,
      PLUGIN_VERSION,
    ),
  };
  const values = Object.values(surfaces).filter(Boolean);
  const unique = [...new Set(values)];
  const missing = Object.entries(surfaces)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  const warnings: Warning[] = [];
  if (missing.length) {
    warnings.push(
      typedWarning(
        "local_version_surface_missing",
        `Missing local version surfaces: ${missing.join(", ")}.`,
      ),
    );
  }
  if (unique.length > 1) {
    warnings.push(
      typedWarning(
        "local_version_surface_mismatch",
        `Local version surfaces disagree: ${Object.entries(surfaces)
          .map(([key, value]) => `${key}=${value || "missing"}`)
          .join(", ")}.`,
      ),
    );
  }
  return {
    ok: warnings.length === 0,
    surfaces,
    version: unique.length === 1 ? unique[0] : null,
    warnings,
  };
}

export async function inspectInstalledRouting({
  pluginName = "codex-autoresearch",
}: LooseObject = {}) {
  if (!/^[a-z0-9._-]+$/i.test(String(pluginName))) {
    return {
      ok: false,
      available: false,
      warning: `Unable to inspect installed routing: unsafe plugin name ${pluginName}`,
    };
  }
  return {
    ok: true,
    available: false,
    pluginName,
    confidence: "not-applicable",
    warning: "Installed routing is not used; Codex Autoresearch is CLI/skill-only.",
  };
}

export async function buildDriftReport({
  pluginRoot,
  includeInstalled = false,
  inspectInstalled = inspectInstalledRouting,
}: LooseObject = {}) {
  const local = await inspectVersionSurfaces({ pluginRoot });
  const report: {
    ok: boolean;
    local: Awaited<ReturnType<typeof inspectVersionSurfaces>>;
    installed: RoutingResult | null;
    warnings: Warning[];
  } = {
    ok: local.ok,
    local,
    installed: null,
    warnings: [...local.warnings],
  };
  if (includeInstalled) {
    const installed = await inspectInstalled();
    report.installed = installed;
    if (installed.ok === false && !installed.available) {
      report.warnings.push(installed.warning);
    }
  }
  report.ok = report.warnings.length === 0;
  return report;
}

export function runtimeProvenance(drift: LooseObject | null = null): LooseObject {
  const unavailable = runtimeDriftUnavailable(drift);
  const drifted = confirmedRuntimeDrift(drift);
  return {
    pluginVersion: PLUGIN_VERSION,
    sourceRoot: PLUGIN_ROOT,
    repoRoot: REPO_ROOT,
    localVersion: PLUGIN_VERSION,
    installedVersion:
      drift?.installed?.version || drift?.installed?.pluginVersion || drift?.routing?.version || "",
    installedCachePath:
      drift?.installed?.cachePath || drift?.installed?.path || drift?.routing?.cachePath || "",
    drifted,
    status: drift
      ? unavailable
        ? "unavailable"
        : drifted
          ? "drift-detected"
          : "checked"
      : "unavailable",
    driftConfidence: drift
      ? unavailable
        ? "unavailable"
        : drifted
          ? "drift-detected"
          : "checked"
      : "source-only",
    reason: drifted
      ? "Source and installed runtime drift needs inspection before public claims."
      : "",
    inspectCommand: "",
  };
}

function runtimeDriftUnavailable(drift: LooseObject | null): boolean {
  if (!drift) return true;
  if (drift.probeFailed === true || drift.unavailable === true) return true;
  const status = String(drift.status || drift.driftStatus || "").toLowerCase();
  return ["unavailable", "probe-failed", "probe_failed", "error", "unknown"].includes(status);
}

function confirmedRuntimeDrift(drift: LooseObject | null): boolean {
  if (!drift || runtimeDriftUnavailable(drift)) return false;
  if (
    drift.drifted === true ||
    drift.mismatched === true ||
    drift.stale === true ||
    drift.needsInspection === true
  ) {
    return true;
  }
  const warnings = Array.isArray(drift.warnings) ? drift.warnings.map(String) : [];
  return warnings.some((warning) =>
    /version_surface_mismatch|runtime.*drift|source.*differs/i.test(warning),
  );
}

async function readJsonVersion(filePath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return parsed.version || "";
  } catch {
    return "";
  }
}

async function readRegexVersion(
  filePath: string,
  regex: RegExp,
  fallbackVersion = "",
): Promise<string> {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    const match = text.match(regex);
    if (!match) return "";
    return match[1] || fallbackVersion;
  } catch {
    return "";
  }
}

async function readRegexVersionCandidate(
  filePaths: string[],
  regex: RegExp,
  fallbackVersion = "",
): Promise<string> {
  for (const filePath of filePaths) {
    const version = await readRegexVersion(filePath, regex, fallbackVersion);
    if (version) return version;
  }
  return "";
}

function typedWarning(code: string, message: string): Warning {
  return `[${code}] ${message}`;
}
