import fsp from "node:fs/promises";
import path from "node:path";
import { PLUGIN_VERSION } from "./plugin-version.js";

type LooseObject = Record<string, any>;
type Warning = string;
type VersionSurfaces = Record<string, string>;
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
