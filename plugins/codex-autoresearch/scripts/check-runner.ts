import { spawn } from "node:child_process";

export type CommandSpec = [label: string, command: string, args: string[]];

export interface CommandResult {
  code: number | null;
  label: string;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface ResolvedSpawnCommand {
  args: string[];
  command: string;
}

export function runCommand(
  [label, command, args]: CommandSpec,
  {
    cwd,
    env,
    streamOutput = false,
    timeoutSeconds = 300,
  }: { cwd: string; env?: NodeJS.ProcessEnv; streamOutput?: boolean; timeoutSeconds?: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const resolved = resolveSpawnCommand(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      detached: process.platform !== "win32",
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutFallback: NodeJS.Timeout | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timeoutFallback) clearTimeout(timeoutFallback);
      resolve(result);
    };
    const timeout = setTimeout(
      () => {
        timedOut = true;
        stderr += `Command timed out after ${Math.max(1, timeoutSeconds)} seconds.\n`;
        killCommandProcess(child.pid);
        timeoutFallback = setTimeout(
          () => finish({ label, code: null, stdout, stderr, timedOut: true }),
          5000,
        );
      },
      Math.max(1, timeoutSeconds) * 1000,
    );
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (streamOutput) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (streamOutput) process.stderr.write(text);
    });
    child.on("error", (error) =>
      finish({ label, code: -1, stdout, stderr: `${stderr}${error.message}\n`, timedOut }),
    );
    child.on("close", (code) =>
      finish({ label, code: timedOut ? null : code, stdout, stderr, timedOut }),
    );
  });
}

export function resolveSpawnCommand(
  command: string,
  args: string[],
  {
    comSpec = process.env.ComSpec,
    platform = process.platform,
  }: { comSpec?: string; platform?: NodeJS.Platform } = {},
): ResolvedSpawnCommand {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: comSpec || "cmd.exe",
      args: ["/d", "/c", "call", command, ...args],
    };
  }
  return { command, args };
}

function killCommandProcess(pid?: number): void {
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
      // Process already exited.
    }
  }
}
