import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import { withTempDir as withNamedTempDir } from "./process.js";

export const withAutoresearchTempDir = (name, fn) => withNamedTempDir("autoresearch", name, fn);

export const pathExists = async (target: string) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

export function isolatedRuntimeEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
}

export async function writeInstalledRuntimeFixture(homeDir: string, status: string) {
  const cacheRoot = path.join(
    homeDir,
    ".codex",
    "plugins",
    "cache",
    "thegreencedar-autoresearch",
    "codex-autoresearch",
  );
  const runtimeDir = path.join(cacheRoot, status === "stale" ? "0.0.0" : PLUGIN_VERSION);
  await mkdir(runtimeDir, { recursive: true });
  if (status === "stale") {
    await writeFile(
      path.join(runtimeDir, "package.json"),
      JSON.stringify({ version: "0.0.0" }, null, 2),
    );
  } else if (status === "unavailable") {
    await writeFile(
      path.join(runtimeDir, "package.json"),
      JSON.stringify({ version: PLUGIN_VERSION }, null, 2),
    );
  }
}

export function cliPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload.result as Record<string, unknown>) || payload;
}
