import { spawn } from "node:child_process";

export function mcpFrame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

export function parseMcpFrames(stdout) {
  const frames = [];
  let remaining = Buffer.from(stdout, "utf8");
  for (;;) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd < 0) return frames;
    const header = remaining.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return frames;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (remaining.length < bodyStart + length) return frames;
    frames.push(JSON.parse(remaining.subarray(bodyStart, bodyStart + length).toString("utf8")));
    remaining = remaining.subarray(bodyStart + length);
  }
}

export async function waitForMcpResponseById(stdoutFn, stderrFn, id, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = parseMcpFrames(stdoutFn()).find((message) => message.id === id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No MCP response for ${id}\nstdout=${stdoutFn()}\nstderr=${stderrFn()}`);
}

export async function callMcpRequest({
  args,
  cwd,
  initialize = false,
  method,
  params = {},
  timeoutMs = 5000,
}) {
  const child = spawn(process.execPath, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const send = (message) => {
    child.stdin.write(mcpFrame(message));
  };
  const requestId = initialize ? 2 : 1;

  try {
    if (initialize) {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {} },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    }
    send({ jsonrpc: "2.0", id: requestId, method, params });
    return await waitForMcpResponseById(
      () => stdout,
      () => stderr,
      requestId,
      timeoutMs,
    );
  } finally {
    child.kill();
  }
}
