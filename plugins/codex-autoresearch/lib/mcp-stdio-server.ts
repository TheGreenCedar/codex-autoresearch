import { spawn } from "node:child_process";
import {
  getMcpPrompt,
  listMcpPrompts,
  listMcpResourceTemplates,
  listMcpResources,
  readMcpResource,
} from "./mcp-protocol.js";

type LooseObject = Record<string, any>;

interface McpStdioServerOptions {
  callTool: (name: string, args: LooseObject) => Promise<unknown>;
  maxFrameBytes?: number;
  serverVersion: string;
  toolSchemas: LooseObject[];
  validateToolArguments: (name: string, args: LooseObject) => unknown;
}

interface McpSmokeOptions {
  mcpScriptPath: string;
  pluginRoot: string;
  timeoutMs?: number;
}

const DEFAULT_MAX_MCP_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MCP_SMOKE_TIMEOUT_MS = 1500;

export function startMcpStdioServer({
  callTool,
  maxFrameBytes = DEFAULT_MAX_MCP_FRAME_BYTES,
  serverVersion,
  toolSchemas,
  validateToolArguments,
}: McpStdioServerOptions) {
  const server = createMcpStdioHandler({
    callTool,
    serverVersion,
    toolSchemas,
    validateToolArguments,
  });
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxFrameBytes + 1024 && buffer.indexOf("\r\n\r\n") < 0) {
      buffer = Buffer.alloc(0);
      sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request too large." } });
      return;
    }
    for (;;) {
      const frame = readNextMcpFrame(buffer, maxFrameBytes);
      if (frame.status === "incomplete") return;
      buffer = frame.remaining;
      if (frame.status === "skip") continue;
      if (frame.status === "too-large") {
        sendMcp({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message: `Request too large. Max frame size is ${maxFrameBytes} bytes.`,
          },
        });
        continue;
      }
      if (frame.status === "parse-error") {
        sendMcp({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${frame.error}` },
        });
        continue;
      }
      server(frame.message).catch((error) => {
        sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32000, message: error.message } });
      });
    }
  });
}

export async function runMcpSmoke({
  mcpScriptPath,
  pluginRoot,
  timeoutMs = DEFAULT_MCP_SMOKE_TIMEOUT_MS,
}: McpSmokeOptions) {
  const messages = [];
  let buffer = Buffer.alloc(0);
  let stderr = "";
  const child = spawn(process.execPath, [mcpScriptPath], {
    cwd: pluginRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    buffer = collectMcpFrames(Buffer.concat([buffer, chunk]), messages);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.stdin.write(
    mcpFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codex-autoresearch-smoke", version: "0" },
      },
    }),
  );
  child.stdin.write(mcpFrame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
  child.stdin.write(mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));

  const initialize = await waitForMcpResponse(messages, 1, timeoutMs);
  const toolsList = await waitForMcpResponse(messages, 2, timeoutMs);
  child.kill();

  const tools = toolsList?.result?.tools || [];
  const toolNames = tools.map((tool) => tool.name).filter(Boolean);
  const requiredTools = [
    "setup_plan",
    "setup_session",
    "next_experiment",
    "prompt_plan",
    "onboarding_packet",
    "recommend_next",
    "read_state",
    "benchmark_inspect",
    "benchmark_lint",
    "checks_inspect",
    "new_segment",
    "promote_gate",
    "doctor_session",
    "serve_dashboard",
    "clear_session",
  ];
  const missingRequiredTools = requiredTools.filter((tool) => !toolNames.includes(tool));
  return {
    ok: Boolean(
      initialize?.result?.serverInfo?.name === "codex-autoresearch" &&
      tools.length > 0 &&
      missingRequiredTools.length === 0,
    ),
    pluginRoot,
    command: `${process.execPath} ${mcpScriptPath}`,
    initialize: initialize?.result || initialize?.error || null,
    toolCount: tools.length,
    toolNames,
    missingRequiredTools,
    stderr: stderr.trim(),
    note: "This validates the plugin stdio server directly. If this is ok but Codex does not show MCP tools, the failure is in Codex tool surfacing or session registration, not this server process.",
  };
}

function createMcpStdioHandler({
  callTool,
  serverVersion,
  toolSchemas,
  validateToolArguments,
}: McpStdioServerOptions) {
  return async function handleMcpMessage(message) {
    if (message.method === "initialize") {
      sendMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "codex-autoresearch", version: serverVersion },
        },
      });
      return;
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "tools/list") {
      sendMcp({ jsonrpc: "2.0", id: message.id, result: { tools: toolSchemas } });
      return;
    }

    if (message.method === "resources/list") {
      sendMcp({ jsonrpc: "2.0", id: message.id, result: listMcpResources() });
      return;
    }

    if (message.method === "resources/templates/list") {
      sendMcp({ jsonrpc: "2.0", id: message.id, result: listMcpResourceTemplates() });
      return;
    }

    if (message.method === "resources/read") {
      try {
        const result = await readMcpResource(message.params?.uri, callTool);
        sendMcp({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        sendMcp({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: error.message || String(error) },
        });
      }
      return;
    }

    if (message.method === "prompts/list") {
      sendMcp({ jsonrpc: "2.0", id: message.id, result: listMcpPrompts() });
      return;
    }

    if (message.method === "prompts/get") {
      try {
        const result = getMcpPrompt(message.params?.name, message.params?.arguments || {});
        sendMcp({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        sendMcp({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: error.message || String(error) },
        });
      }
      return;
    }
    if (message.method === "tools/call") {
      try {
        validateToolArguments(message.params?.name, message.params?.arguments || {});
        const result = await callTool(message.params.name, message.params.arguments || {});
        const payload = mcpSuccessEnvelope(message.params.name, result);
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
  };
}

function readNextMcpFrame(buffer: Buffer, maxFrameBytes: number): LooseObject {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return { status: "incomplete", remaining: buffer };
  const header = buffer.subarray(0, headerEnd).toString("utf8");
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return { status: "skip", remaining: buffer.subarray(headerEnd + 4) };
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  if (!Number.isFinite(length) || length < 0 || length > maxFrameBytes) {
    const remaining =
      buffer.length >= bodyStart + Math.max(0, length)
        ? buffer.subarray(bodyStart + Math.max(0, length))
        : Buffer.alloc(0);
    return { status: "too-large", remaining };
  }
  if (buffer.length < bodyStart + length) return { status: "incomplete", remaining: buffer };
  const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
  const remaining = buffer.subarray(bodyStart + length);
  try {
    return { status: "message", message: JSON.parse(body), remaining };
  } catch (error) {
    return { status: "parse-error", error: error.message, remaining };
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

function mcpFrame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function collectMcpFrames(buffer, messages) {
  let remaining = buffer;
  for (;;) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd < 0) return remaining;
    const header = remaining.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      remaining = remaining.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (!Number.isFinite(length) || length < 0) {
      remaining = remaining.subarray(bodyStart);
      continue;
    }
    if (remaining.length < bodyStart + length) return remaining;
    const body = remaining.subarray(bodyStart, bodyStart + length).toString("utf8");
    remaining = remaining.subarray(bodyStart + length);
    try {
      messages.push(JSON.parse(body));
    } catch (error) {
      messages.push({ jsonrpc: "2.0", error: { code: -32700, message: error.message } });
    }
  }
}

function waitForMcpResponse(messages, id, timeoutMs): Promise<any> {
  const started = Date.now();
  return new Promise<any>((resolve) => {
    const check = () => {
      const message = messages.find((item) => item.id === id);
      if (message || Date.now() - started >= timeoutMs) {
        resolve(message || null);
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}
