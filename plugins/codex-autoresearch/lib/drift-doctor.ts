import fsp from "node:fs/promises";
import path from "node:path";
import { runProcess, tailText } from "./runner.js";
import { PLUGIN_VERSION } from "./plugin-version.js";

type LooseObject = Record<string, any>;

export async function inspectVersionSurfaces({ pluginRoot }) {
  const surfaces = {
    packageJson: await readJsonVersion(path.join(pluginRoot, "package.json")),
    manifest: await readJsonVersion(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
    cliServer: await readRegexVersionCandidate(
      [
        path.join(pluginRoot, "scripts", "autoresearch.ts"),
        path.join(pluginRoot, "dist", "scripts", "autoresearch.mjs"),
        path.join(pluginRoot, "scripts", "autoresearch.mjs"),
      ],
      /serverInfo:\s*\{\s*name:\s*"codex-autoresearch",\s*version:\s*(?:"([^"]+)"|PLUGIN_VERSION)/s,
      PLUGIN_VERSION,
    ),
    mcpEntrypoint: await readRegexVersionCandidate(
      [
        path.join(pluginRoot, "scripts", "autoresearch-mcp.ts"),
        path.join(pluginRoot, "dist", "scripts", "autoresearch-mcp.mjs"),
        path.join(pluginRoot, "scripts", "autoresearch-mcp.mjs"),
      ],
      /serverInfo:\s*\{\s*name:\s*"codex-autoresearch",\s*version:\s*(?:"([^"]+)"|PLUGIN_VERSION)/s,
      PLUGIN_VERSION,
    ),
  };
  const values = Object.values(surfaces).filter(Boolean);
  const unique = [...new Set(values)];
  const missing = Object.entries(surfaces)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  const warnings = [];
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
  timeoutMs = 5000,
  run = runCodex,
}: LooseObject = {}) {
  if (!/^[a-z0-9._-]+$/i.test(String(pluginName))) {
    return {
      ok: false,
      available: false,
      warning: `Unable to inspect installed MCP routing: unsafe plugin name ${pluginName}`,
    };
  }
  const result = await run(["mcp", "get", pluginName], timeoutMs);
  if (result.code !== 0) {
    return {
      ok: false,
      available: false,
      warning: typedWarning(
        "codex_mcp_route_unavailable",
        `Unable to inspect installed MCP routing: ${result.stderr || result.stdout || "codex command failed"}`,
      ),
    };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const structured = parseCodexRoutingJson(output);
  const pathMatch =
    structured.path ||
    output.match(/[A-Z]:\\[^\r\n"]*codex-autoresearch[^\r\n"]*/i)?.[0] ||
    output.match(/\/[^\r\n"]*codex-autoresearch[^\r\n"]*/i)?.[0] ||
    "";
  const versionMatch =
    structured.version ||
    output.match(/codex-autoresearch[\\/](\d+\.\d+\.\d+)/i)?.[1] ||
    output.match(/version[^\d]*(\d+\.\d+\.\d+)/i)?.[1] ||
    "";
  return {
    ok: true,
    available: true,
    pluginName,
    path: pathMatch,
    version: versionMatch,
    confidence: structured.found
      ? versionMatch && pathMatch
        ? "structured"
        : "structured-partial"
      : versionMatch || pathMatch
        ? "heuristic"
        : "unavailable",
  };
}

export async function buildDriftReport({
  pluginRoot,
  includeInstalled = false,
  inspectInstalled = inspectInstalledRouting,
}: LooseObject = {}) {
  const local = await inspectVersionSurfaces({ pluginRoot });
  const report = {
    ok: local.ok,
    local,
    installed: null,
    warnings: [...local.warnings],
  };
  if (includeInstalled) {
    const installed = await inspectInstalled();
    report.installed = installed;
    if (!installed.available) {
      report.warnings.push(installed.warning);
    } else if (installed.confidence === "unavailable") {
      report.warnings.push(
        typedWarning(
          "codex_mcp_route_low_confidence",
          "Installed Codex MCP route was available, but no version or path could be identified from codex mcp get output.",
        ),
      );
    } else if (installed.version && local.version && installed.version !== local.version) {
      report.warnings.push(
        typedWarning(
          "codex_mcp_version_drift",
          `Installed Codex MCP runtime is ${installed.version}, while local source is ${local.version}. Run codex mcp get codex-autoresearch for the active route, refresh the plugin cache, then restart Codex before trusting live MCP behavior.`,
        ),
      );
    }
  }
  report.ok = report.warnings.length === 0;
  return report;
}

function parseCodexRoutingJson(output) {
  const trimmed = String(output || "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { found: false };
  try {
    const parsed = JSON.parse(trimmed);
    return {
      found: true,
      version: findStringField(parsed, "version"),
      path: findPathLikeString(parsed),
    };
  } catch {
    return { found: false };
  }
}

function findStringField(value, field) {
  if (!value || typeof value !== "object") return "";
  if (typeof value[field] === "string") return value[field];
  for (const child of Object.values(value)) {
    const found = findStringField(child, field);
    if (found) return found;
  }
  return "";
}

function findPathLikeString(value) {
  if (typeof value === "string" && /codex-autoresearch/i.test(value)) return value;
  if (!value || typeof value !== "object") return "";
  for (const child of Object.values(value)) {
    const found = findPathLikeString(child);
    if (found) return found;
  }
  return "";
}

async function readJsonVersion(filePath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return parsed.version || "";
  } catch {
    return "";
  }
}

async function readRegexVersion(filePath, regex, fallbackVersion = "") {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    const match = text.match(regex);
    if (!match) return "";
    return match[1] || fallbackVersion;
  } catch {
    return "";
  }
}

async function readRegexVersionCandidate(filePaths, regex, fallbackVersion = "") {
  for (const filePath of filePaths) {
    const version = await readRegexVersion(filePath, regex, fallbackVersion);
    if (version) return version;
  }
  return "";
}

async function runCodex(args, timeoutMs) {
  const timeoutSeconds = Math.max(1, Number(timeoutMs) / 1000);
  const command = process.platform === "win32" ? "cmd.exe" : "codex";
  const commandArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", ["codex", ...args].join(" ")] : args;
  const result = await runProcess(command, commandArgs, {
    timeoutSeconds,
    maxOutputBytes: 32 * 1024,
  });
  return {
    code: result.timedOut ? -1 : result.code,
    stdout: result.stdout,
    stderr: result.timedOut
      ? `${tailText(result.stderr, 20, 8192)}\nTimed out inspecting codex routing.`.trim()
      : result.stderr,
  };
}

function typedWarning(code, message) {
  return `[${code}] ${message}`;
}
