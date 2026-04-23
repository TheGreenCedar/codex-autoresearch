import { spawn } from "node:child_process";

const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const OUTPUT_MAX_LINES = 20;
const OUTPUT_MAX_BYTES = 8192;
const OUTPUT_CAPTURE_BYTES = 16384;
const PROCESS_OUTPUT_CAPTURE_BYTES = 32768;

export function parseMetricLines(output) {
  const metrics = Object.create(null);
  const regex = /^METRIC\s+([^=\s]+)=(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/gim;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics[name] = value;
  }
  return metrics;
}

export function tailText(text, maxLines = OUTPUT_MAX_LINES, maxBytes = OUTPUT_MAX_BYTES) {
  let trimmed = text;
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    const buf = Buffer.from(trimmed, "utf8");
    trimmed = buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > maxLines) trimmed = lines.slice(-maxLines).join("\n");
  return trimmed;
}

export async function runShell(command, cwd, timeoutSeconds = 600) {
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputTruncated = false;
    let timedOut = false;
    const appendOutput = (text) => {
      output += text;
      if (Buffer.byteLength(output, "utf8") > OUTPUT_CAPTURE_BYTES) {
        const buf = Buffer.from(output, "utf8");
        output = buf.subarray(Math.max(0, buf.length - OUTPUT_CAPTURE_BYTES)).toString("utf8");
        outputTruncated = true;
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(child.pid);
    }, Math.max(1, timeoutSeconds) * 1000);
    child.stdout.on("data", (chunk) => {
      appendOutput(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      appendOutput(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: null,
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
        output: String(error.stack || error.message || error),
        outputTruncated,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: code,
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
        output,
        outputTruncated,
      });
    });
  });
}

export async function runProcess(command, args = [], {
  cwd,
  timeoutSeconds = 600,
  maxOutputBytes = PROCESS_OUTPUT_CAPTURE_BYTES,
} = {}) {
  const startedAt = Date.now();
  const argv = Array.isArray(args) ? args.map(String) : [];
  const commandDisplay = [command, ...argv].map(shellDisplayPart).join(" ");
  return await new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const appendOutput = (target, text) => {
      let value = target === "stdout" ? stdout : stderr;
      let truncated = target === "stdout" ? stdoutTruncated : stderrTruncated;
      value += text;
      if (Buffer.byteLength(value, "utf8") > maxOutputBytes) {
        const buf = Buffer.from(value, "utf8");
        value = buf.subarray(Math.max(0, buf.length - maxOutputBytes)).toString("utf8");
        truncated = true;
      }
      if (target === "stdout") {
        stdout = value;
        stdoutTruncated = truncated;
      } else {
        stderr = value;
        stderrTruncated = truncated;
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(child.pid);
    }, Math.max(1, Number(timeoutSeconds) || 1) * 1000);
    child.stdout.on("data", (chunk) => {
      appendOutput("stdout", chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      appendOutput("stderr", chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve(processResult({
        commandDisplay,
        exitCode: null,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message || String(error)}`,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        startedAt,
      }));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(processResult({
        commandDisplay,
        exitCode: code,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        startedAt,
      }));
    });
  });
}

function processResult({
  commandDisplay,
  exitCode,
  stdout,
  stderr,
  stdoutTruncated,
  stderrTruncated,
  timedOut,
  startedAt,
}) {
  const durationSeconds = (Date.now() - startedAt) / 1000;
  return {
    command: commandDisplay,
    commandDisplay,
    code: exitCode,
    exitCode,
    stdout,
    stderr,
    combinedOutput: `${stdout || ""}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`,
    timedOut,
    durationSeconds,
    durationMs: Math.round(durationSeconds * 1000),
    outputTruncated: Boolean(stdoutTruncated || stderrTruncated),
    stdoutTruncated,
    stderrTruncated,
  };
}

function shellDisplayPart(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
}

export function killProcess(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}
