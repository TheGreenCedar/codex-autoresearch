import path from "node:path";

import { resolvePackageRoot } from "../../lib/runtime-paths.js";
import { withAutoresearchTempDir } from "./cli-session.js";
import { createCliRunner, createSetupFixture, createSpawnedCliRunner, runGit } from "./process.js";

export const pluginRoot = resolvePackageRoot(import.meta.url);
export const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
export const runCli = createCliRunner(cli, pluginRoot);
export const setupFixture = createSetupFixture();
export const runSpawnedCli = createSpawnedCliRunner(cli, pluginRoot);
export const withTempDir = withAutoresearchTempDir;

export const git = async (cwd: string, args: string[]) => {
  return await runGit(cwd, args);
};
