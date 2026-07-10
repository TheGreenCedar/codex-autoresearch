import assert from "node:assert/strict";
import path from "node:path";
import { resolvePackageRoot } from "../../lib/runtime-paths.js";
import {
  createCliRunner,
  createInteractiveCliRunner,
  runGit,
  withProcess,
  withTempDir as withNamedTempDir,
} from "../helpers/process.js";

export const pluginRoot = resolvePackageRoot(import.meta.url);
export const repoRoot = path.resolve(pluginRoot, "..", "..");
export const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
export const runCli = createCliRunner(cli, pluginRoot);
export const runCliWithAnswers = createInteractiveCliRunner(cli, pluginRoot);

export const git = async (cwd, args) => {
  return await runGit(cwd, args);
};

export const withTempDir = (name, fn) => withNamedTempDir("autoresearch-full", name, fn);

export const readGoalBrief = async (dir: string, args: string[] = []) => {
  const result = await runCli(["codex-goal-brief", "--cwd", dir, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};

export const withLiveServer = (dir, fn, extraArgs = []) => {
  return withProcess(
    process.execPath,
    [cli, "serve", "--cwd", dir, "--port", "0", ...extraArgs],
    pluginRoot,
    async (_child, stdout, stderr) => {
      const payload = await waitForServerPayload(stdout, stderr);
      return await fn(payload);
    },
  );
};

export const assertNoSensitiveEvidence = (text) => {
  for (const needle of [
    "abcdefghijklmnop",
    "zyxwvutsrqponmlkjihgfedcba",
    "user:pass@example.com",
    "C:\\Users\\Alice",
    "/home/alice",
  ]) {
    assert.equal(text.includes(needle), false, `Dashboard payload leaked ${needle}`);
  }
};

async function waitForServerPayload(stdoutFn, stderrFn) {
  const started = Date.now();
  while (Date.now() - started < 45000) {
    const stdout = stdoutFn();
    if (stdout.trim().endsWith("}")) return JSON.parse(stdout);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`serve did not print startup JSON\n${stderrFn()}`);
}
