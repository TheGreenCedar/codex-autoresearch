import { spawn } from "node:child_process";
import { resolvePackageRoot } from "../../lib/runtime-paths.js";

const pluginRoot = resolvePackageRoot(import.meta.url);

export async function runNode(args, { cwd = pluginRoot, env = process.env } = {}) {
  return await new Promise((resolve) => {
    const childEnv = { ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: String(error.message || error) }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runShellCommand(command, { cwd = pluginRoot } = {}) {
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args =
    process.platform === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
      : ["-c", command];
  return await new Promise((resolve) => {
    const child = spawn(shell, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: String(error.message || error) }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
