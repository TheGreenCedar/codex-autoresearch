#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpToolSchemas, validateToolArguments } from "../lib/mcp-interface.mjs";

const MAX_MCP_FRAME_BYTES = 1024 * 1024;
const TOOL_TIMEOUT_SECONDS = 15 * 60;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLI_SCRIPT = path.join(SCRIPT_DIR, "autoresearch.mjs");
const VERSION = "0.2.1";

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > MAX_MCP_FRAME_BYTES + 1024 && buffer.indexOf("\r\n\r\n") < 0) {
    buffer = Buffer.alloc(0);
    sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request too large." } });
    return;
  }

  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (!Number.isFinite(length) || length < 0 || length > MAX_MCP_FRAME_BYTES) {
      sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Request too large. Max frame size is ${MAX_MCP_FRAME_BYTES} bytes.` } });
      buffer = buffer.length >= bodyStart + Math.max(0, length)
        ? buffer.subarray(bodyStart + Math.max(0, length))
        : Buffer.alloc(0);
      continue;
    }
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);

    let message;
    try {
      message = JSON.parse(body);
    } catch (error) {
      sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
      continue;
    }
    handleMcpMessage(message).catch((error) => {
      if (message.id != null) {
        sendMcp({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.stack || error.message || String(error) } });
      }
    });
  }
});

async function handleMcpMessage(message) {
  if (message.method === "initialize") {
    sendMcp({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-autoresearch", version: VERSION },
      },
    });
    return;
  }

  if (message.method === "notifications/initialized") return;

  if (message.method === "tools/list") {
    sendMcp({ jsonrpc: "2.0", id: message.id, result: { tools: mcpToolSchemas } });
    return;
  }

  if (message.method === "tools/call") {
    try {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      validateToolArguments(name, args);
      requireUnsafeCommandGate(name, args);
      const result = await callCliTool(name, args);
      sendMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      });
    } catch (error) {
      sendMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          content: [{ type: "text", text: error.stack || error.message || String(error) }],
        },
      });
    }
    return;
  }

  if (message.id != null) {
    sendMcp({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  }
}

function sendMcp(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function requireUnsafeCommandGate(toolName, args) {
  const hasCustomCommand = Boolean(args.command || args.checks_command || args.checksCommand || args.model_command || args.modelCommand);
  if (hasCustomCommand && !boolOption(args.allow_unsafe_command ?? args.allowUnsafeCommand, false)) {
    throw new Error(`${toolName} custom shell commands require allow_unsafe_command=true over MCP. Prefer a configured autoresearch script when possible.`);
  }
}

async function callCliTool(name, args) {
  const cliArgs = cliArgsForTool(name, args);
  const result = await runCli(cliArgs);
  if (result.code !== 0) {
    throw new Error(`autoresearch CLI failed (${result.code})\n${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: true, output: result.stdout.trim() };
  }
}

function cliArgsForTool(name, args) {
  if (name === "setup_plan") return compactArgs(["setup-plan", cwdFlag(args), option("--recipe", args.recipe_id ?? args.recipeId ?? args.recipe), option("--catalog", args.catalog), option("--name", args.name), option("--metric-name", args.metric_name ?? args.metricName), option("--benchmark-command", args.benchmark_command ?? args.benchmarkCommand)]);
  if (name === "list_recipes") return compactArgs(["recipes", "list", option("--catalog", args.catalog)]);
  if (name === "setup_session") return compactArgs(["setup", cwdFlag(args), option("--recipe", args.recipe_id ?? args.recipeId ?? args.recipe), option("--catalog", args.catalog), option("--name", args.name), option("--goal", args.goal), option("--metric-name", args.metric_name ?? args.metricName), option("--metric-unit", args.metric_unit ?? args.metricUnit), option("--direction", args.direction), option("--benchmark-command", args.benchmark_command ?? args.benchmarkCommand), option("--checks-command", args.checks_command ?? args.checksCommand), option("--shell", args.shell), listOption("--files-in-scope", args.files_in_scope ?? args.filesInScope), listOption("--off-limits", args.off_limits ?? args.offLimits), listOption("--constraints", args.constraints), listOption("--secondary-metrics", args.secondary_metrics ?? args.secondaryMetrics), listOption("--commit-paths", args.commit_paths ?? args.commitPaths), option("--max-iterations", args.max_iterations ?? args.maxIterations), option("--autonomy-mode", args.autonomy_mode ?? args.autonomyMode), option("--checks-policy", args.checks_policy ?? args.checksPolicy), option("--keep-policy", args.keep_policy ?? args.keepPolicy), option("--dashboard-refresh-seconds", args.dashboard_refresh_seconds ?? args.dashboardRefreshSeconds), flag("--overwrite", args.overwrite), flag("--create-checks", args.create_checks ?? args.createChecks), flag("--skip-init", args.skip_init ?? args.skipInit)]);
  if (name === "setup_research_session") return compactArgs(["research-setup", cwdFlag(args), option("--slug", args.slug), option("--goal", args.goal), option("--name", args.name), option("--checks-command", args.checks_command ?? args.checksCommand), option("--shell", args.shell), listOption("--files-in-scope", args.files_in_scope ?? args.filesInScope), listOption("--constraints", args.constraints), listOption("--commit-paths", args.commit_paths ?? args.commitPaths), option("--max-iterations", args.max_iterations ?? args.maxIterations), option("--autonomy-mode", args.autonomy_mode ?? args.autonomyMode), option("--checks-policy", args.checks_policy ?? args.checksPolicy), option("--keep-policy", args.keep_policy ?? args.keepPolicy), option("--dashboard-refresh-seconds", args.dashboard_refresh_seconds ?? args.dashboardRefreshSeconds), flag("--overwrite", args.overwrite), flag("--create-checks", args.create_checks ?? args.createChecks), flag("--skip-init", args.skip_init ?? args.skipInit)]);
  if (name === "configure_session") return compactArgs(["config", cwdFlag(args), option("--autonomy-mode", args.autonomy_mode ?? args.autonomyMode), option("--checks-policy", args.checks_policy ?? args.checksPolicy), option("--keep-policy", args.keep_policy ?? args.keepPolicy), option("--dashboard-refresh-seconds", args.dashboard_refresh_seconds ?? args.dashboardRefreshSeconds), option("--max-iterations", args.max_iterations ?? args.maxIterations), option("--extend", args.extend), listOption("--commit-paths", args.commit_paths ?? args.commitPaths)]);
  if (name === "init_experiment") return compactArgs(["init", cwdFlag(args), option("--name", args.name), option("--metric-name", args.metric_name ?? args.metricName), option("--metric-unit", args.metric_unit ?? args.metricUnit), option("--direction", args.direction)]);
  if (name === "run_experiment") return compactArgs(["run", cwdFlag(args), option("--command", args.command), option("--timeout-seconds", args.timeout_seconds ?? args.timeoutSeconds), option("--checks-command", args.checks_command ?? args.checksCommand), option("--checks-timeout-seconds", args.checks_timeout_seconds ?? args.checksTimeoutSeconds), option("--checks-policy", args.checks_policy ?? args.checksPolicy)]);
  if (name === "next_experiment") return compactArgs(["next", cwdFlag(args), option("--command", args.command), option("--timeout-seconds", args.timeout_seconds ?? args.timeoutSeconds), option("--checks-command", args.checks_command ?? args.checksCommand), option("--checks-timeout-seconds", args.checks_timeout_seconds ?? args.checksTimeoutSeconds), option("--checks-policy", args.checks_policy ?? args.checksPolicy)]);
  if (name === "log_experiment") return compactArgs(["log", cwdFlag(args), option("--commit", args.commit), option("--metric", args.metric), option("--status", args.status), option("--description", args.description), option("--metrics", jsonOption(args.metrics)), option("--asi", jsonOption(args.asi)), listOption("--commit-paths", args.commit_paths ?? args.commitPaths), listOption("--revert-paths", args.revert_paths ?? args.revertPaths), flag("--allow-dirty-revert", args.allow_dirty_revert ?? args.allowDirtyRevert), flag("--from-last", args.from_last ?? args.fromLast)]);
  if (name === "read_state") return compactArgs(["state", cwdFlag(args)]);
  if (name === "measure_quality_gap") return compactArgs(["quality-gap", cwdFlag(args), option("--research-slug", args.research_slug ?? args.researchSlug), "--list"]);
  if (name === "gap_candidates") return compactArgs(["gap-candidates", cwdFlag(args), option("--research-slug", args.research_slug ?? args.researchSlug), flag("--apply", args.apply), option("--model-command", args.model_command ?? args.modelCommand)]);
  if (name === "finalize_preview") return compactArgs(["finalize-preview", cwdFlag(args), option("--trunk", args.trunk)]);
  if (name === "integrations") return compactArgs(["integrations", args.subcommand || "list", option("--catalog", args.catalog)]);
  if (name === "export_dashboard") return compactArgs(["export", cwdFlag(args), option("--output", args.output)]);
  if (name === "doctor_session") return compactArgs(["doctor", cwdFlag(args), option("--command", args.command), flag("--check-benchmark", args.check_benchmark ?? args.checkBenchmark), option("--timeout-seconds", args.timeout_seconds ?? args.timeoutSeconds)]);
  if (name === "clear_session") return compactArgs(["clear", cwdFlag(args), flag("--yes", args.confirm ?? args.yes)]);
  throw new Error(`Unknown tool: ${name}`);
}

function cwdFlag(args) {
  return option("--cwd", args.working_dir ?? args.workingDir ?? args.cwd);
}

function option(name, value) {
  if (value == null || value === "") return [];
  return [name, String(value)];
}

function listOption(name, value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return option(name, value.join(","));
  return option(name, value);
}

function jsonOption(value) {
  if (value == null || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function flag(name, value) {
  return boolOption(value, false) ? [name] : [];
}

function boolOption(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function compactArgs(items) {
  return items.flat().filter((item) => item != null && item !== "");
}

async function runCli(args) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_SCRIPT, ...args], {
      cwd: PLUGIN_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
    }, TOOL_TIMEOUT_SECONDS * 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 1, stdout, stderr: error.stack || error.message || String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
