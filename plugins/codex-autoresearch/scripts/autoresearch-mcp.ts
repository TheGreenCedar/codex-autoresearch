#!/usr/bin/env node
import path from "node:path";
import { boolOption, createCliToolCaller } from "../lib/mcp-cli-adapter.js";
import {
  mcpToolSchemas,
  requireUnsafeCommandGate,
  validateToolArguments,
} from "../lib/mcp-interface.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";

const MAX_MCP_FRAME_BYTES = 1024 * 1024;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const CLI_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs");
const VERSION = "1.1.5";
const callCliTool = createCliToolCaller({ cliScript: CLI_SCRIPT, pluginRoot: PLUGIN_ROOT });

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
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
      sendMcp({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: `Request too large. Max frame size is ${MAX_MCP_FRAME_BYTES} bytes.`,
        },
      });
      buffer =
        buffer.length >= bodyStart + Math.max(0, length)
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
      sendMcp({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${error.message}` },
      });
      continue;
    }
    handleMcpMessage(message).catch((error) => {
      if (message.id != null) {
        sendMcp({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: error.message || String(error) },
        });
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
      const normalizedArgs = validateToolArguments(name, args);
      requireUnsafeCommandGate(name, normalizedArgs, boolOption);
      const result = await callCliTool(name, normalizedArgs);
      const payload = mcpSuccessEnvelope(name, result);
      sendMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          structuredContent: payload,
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        },
      });
    } catch (error) {
      const payload = mcpErrorEnvelope(message.params?.name, error);
      sendMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          structuredContent: payload,
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        },
      });
    }
    return;
  }

  if (message.id != null) {
    sendMcp({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unknown method: ${message.method}` },
    });
  }
}

function mcpSuccessEnvelope(tool, result) {
  const body =
    result && typeof result === "object" && !Array.isArray(result) ? result : { value: result };
  return {
    ...body,
    ok: body.ok !== false,
    tool,
    workDir: body.workDir || body.working_dir,
    result: body,
  };
}

function mcpErrorEnvelope(tool, error) {
  return {
    ok: false,
    tool: tool || "unknown",
    error: error.message || String(error),
  };
}

function sendMcp(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
