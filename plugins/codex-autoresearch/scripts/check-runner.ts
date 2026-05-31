import { spawn } from "node:child_process";

export type CommandSpec = [label: string, command: string, args: string[]];

export interface CommandResult {
  code: number | null;
  label: string;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export function runCommand(
  [label, command, args]: CommandSpec,
  { cwd, timeoutSeconds = 300 }: { cwd: string; timeoutSeconds?: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const needsShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      shell: needsShell,
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
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) =>
      finish({ label, code: -1, stdout, stderr: `${stderr}${error.message}\n`, timedOut }),
    );
    child.on("close", (code) =>
      finish({ label, code: timedOut ? null : code, stdout, stderr, timedOut }),
    );
  });
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
