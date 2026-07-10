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
    CODEX_HOME: path.join(homeDir, ".codex"),
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
    "TheGreenCedar",
    "codex-autoresearch",
  );
  await mkdir(cacheRoot, { recursive: true });
  if (status === "missing") return;
  const version = status === "stale" ? "0.0.0" : PLUGIN_VERSION;
  await writeRuntimePackage(path.join(cacheRoot, version), version, {
    sourceShaped: status === "unavailable",
  });
}

export async function writeRuntimePackage(
  runtimeDir: string,
  version: string,
  options: { sourceShaped?: boolean; runtimeContent?: string } = {},
) {
  await mkdir(path.join(runtimeDir, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(runtimeDir, "scripts"), { recursive: true });
  await writeFile(
    path.join(runtimeDir, "package.json"),
    JSON.stringify({
      name: "codex-autoresearch",
      version,
      repository: {
        type: "git",
        url: "git+https://github.com/TheGreenCedar/codex-autoresearch.git",
      },
    }),
  );
  await writeFile(
    path.join(runtimeDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "codex-autoresearch",
      version,
      repository: "https://github.com/TheGreenCedar/codex-autoresearch",
    }),
  );
  await writeFile(path.join(runtimeDir, "scripts", "autoresearch.mjs"), "export {};\n");
  if (options.sourceShaped) {
    await writeFile(path.join(runtimeDir, "scripts", "autoresearch.ts"), "export {};\n");
  }
  if (options.runtimeContent !== undefined) {
    await mkdir(path.join(runtimeDir, "dist", "scripts"), { recursive: true });
    await writeFile(
      path.join(runtimeDir, "dist", "scripts", "autoresearch.mjs"),
      options.runtimeContent,
    );
  }
}

export function cliPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload.result as Record<string, unknown>) || payload;
}
