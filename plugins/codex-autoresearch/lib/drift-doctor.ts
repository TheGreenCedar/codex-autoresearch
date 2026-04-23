import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

type LooseObject = Record<string, any>;

export async function inspectVersionSurfaces({ pluginRoot }) {
  const surfaces = {
    packageJson: await readJsonVersion(path.join(pluginRoot, "package.json")),
    manifest: await readJsonVersion(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
    cliServer: await readRegexVersion(
      path.join(pluginRoot, "scripts", "autoresearch.mjs"),
      /serverInfo:\s*\{\s*name:\s*"codex-autoresearch",\s*version:\s*"([^"]+)"/s,
    ),
    mcpEntrypoint: await readRegexVersion(
      path.join(pluginRoot, "scripts", "autoresearch-mcp.mjs"),
      /const VERSION = "([^"]+)"/,
    ),
  };
  const values = Object.values(surfaces).filter(Boolean);
  const unique = [...new Set(values)];
  const warnings =
    unique.length > 1
      ? [
          `Local version surfaces disagree: ${Object.entries(surfaces)
            .map(([key, value]) => `${key}=${value || "missing"}`)
            .join(", ")}.`,
        ]
      : [];
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
      warning: `Unable to inspect installed MCP routing: ${result.stderr || result.stdout || "codex command failed"}`,
    };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const pathMatch =
    output.match(/[A-Z]:\\[^\r\n"]*codex-autoresearch[^\r\n"]*/i) ||
    output.match(/\/[^\r\n"]*codex-autoresearch[^\r\n"]*/i);
  const versionMatch =
    output.match(/codex-autoresearch[\\/](\d+\.\d+\.\d+)/i) ||
    output.match(/version[^\d]*(\d+\.\d+\.\d+)/i);
  return {
    ok: true,
    available: true,
    pluginName,
    path: pathMatch?.[0] || "",
    version: versionMatch?.[1] || "",
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
    } else if (installed.version && local.version && installed.version !== local.version) {
      report.warnings.push(
        `Installed Codex MCP runtime is ${installed.version}, while local source is ${local.version}. Run codex mcp get codex-autoresearch for the active route, refresh the plugin cache, then restart Codex before trusting live MCP behavior.`,
      );
    }
  }
  report.ok = report.warnings.length === 0;
  return report;
}

async function readJsonVersion(filePath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return parsed.version || "";
  } catch {
    return "";
  }
}

async function readRegexVersion(filePath, regex) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    return text.match(regex)?.[1] || "";
  } catch {
    return "";
  }
}

async function runCodex(args, timeoutMs) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    let child;
    try {
      if (process.platform === "win32") {
        child = spawn("cmd.exe", ["/d", "/s", "/c", ["codex", ...args].join(" ")], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        child = spawn("codex", args, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (error) {
      resolve({
        code: -1,
        stdout: "",
        stderr: String((error as Error)?.message || error),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\nTimed out inspecting codex routing.`.trim(),
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr: String(error.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
