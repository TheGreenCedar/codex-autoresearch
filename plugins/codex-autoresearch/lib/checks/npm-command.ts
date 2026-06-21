import fsp from "node:fs/promises";
import path from "node:path";
import { node, type ResolvedSpawnCommand } from "./check-common.js";

export interface NpmCommandResolveOptions {
  access?: (candidate: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  platform?: NodeJS.Platform;
}

export async function resolveNpmCommand(
  args: string[],
  options: NpmCommandResolveOptions = {},
): Promise<ResolvedSpawnCommand> {
  const nodeCommand = options.nodeExecPath || node;
  const platform = options.platform || process.platform;
  const npmExecPath = await resolveNpmExecPath({ ...options, nodeExecPath: nodeCommand, platform });
  if (npmExecPath) return { command: nodeCommand, args: [npmExecPath, ...args] };
  if (platform === "win32") {
    throw new Error(
      [
        "Could not locate npm-cli.js for shell-free npm execution on Windows.",
        "The check runner will not fall back to npm.cmd, npm.ps1, or bare npm because those require a shell wrapper.",
        "Run through npm so npm_execpath is set, or install npm next to Node.js/user npm so node can execute npm-cli.js directly.",
      ].join(" "),
    );
  }
  return { command: "npm", args };
}

async function resolveNpmExecPath(options: NpmCommandResolveOptions = {}) {
  const access = options.access || ((candidate: string) => fsp.access(candidate));
  for (const candidate of npmExecPathCandidates(options)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return "";
}

function npmExecPathCandidates({
  env = process.env,
  nodeExecPath = process.execPath,
  platform = process.platform,
}: NpmCommandResolveOptions = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const candidates = [
    env.npm_execpath,
    pathApi.join(pathApi.dirname(nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  if (platform === "win32") {
    candidates.push(
      env.APPDATA
        ? pathApi.join(env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js")
        : "",
      env.LOCALAPPDATA
        ? pathApi.join(
            env.LOCALAPPDATA,
            "Programs",
            "nodejs",
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          )
        : "",
      env.ProgramFiles
        ? pathApi.join(env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js")
        : "",
      env["ProgramFiles(x86)"]
        ? pathApi.join(
            env["ProgramFiles(x86)"],
            "nodejs",
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          )
        : "",
    );
  }

  for (const pathDir of splitPathEnv(env, platform)) {
    candidates.push(pathApi.join(pathDir, "node_modules", "npm", "bin", "npm-cli.js"));
  }

  return uniqueStrings(candidates.filter(isJavaScriptFilePath));
}

function splitPathEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const value = env.Path || env.PATH || "";
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter;
  return value.split(delimiter).filter(Boolean);
}

function isJavaScriptFilePath(value: unknown): value is string {
  return typeof value === "string" && /\.(?:m?js)$/i.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
