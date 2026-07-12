import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolvePackageRoot } from "../../lib/runtime-paths.js";
import {
  configureTestGitRepo,
  runProcess,
  testGitArgs,
  withTempDir as withNamedTempDir,
} from "../helpers/process.js";

export const pluginRoot = resolvePackageRoot(import.meta.url);
export const finalizer = path.join(pluginRoot, "scripts", "finalize-autoresearch.mjs");
export const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");

export async function run(command, args, cwd, allowFailure = false) {
  const result = await runProcess(command, args, cwd);
  if (!allowFailure && result.code !== 0) {
    const commandLine = command + " " + args.join(" ");
    throw new Error(commandLine + " failed:\n" + result.stdout + result.stderr);
  }
  return result;
}

export async function git(args, cwd) {
  const result = await run("git", testGitArgs(args), cwd);
  if (args[0] === "init") await configureTestGitRepo(cwd);
  return result;
}

export async function writeFile(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents, "utf8");
}

export async function withTempRoot(prefix, body) {
  return await withNamedTempDir(prefix.replace(/-$/, ""), "root", body);
}

export function testWithTempRoot(name, prefix, body) {
  test(name, async () => {
    await withTempRoot(prefix, body);
  });
}

export async function createEvidencePlanFixture(root, name, options = {}) {
  const repo = path.join(root, name);
  await fsp.mkdir(repo, { recursive: true });
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);
  await writeFile(path.join(repo, ".gitignore"), "autoresearch.jsonl\n");
  await writeFile(path.join(repo, "src", "value.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);
  await git(["switch", "-c", `codex/${name}`], repo);
  await writeFile(path.join(repo, "src", "value.txt"), "accepted\n");
  await git(["add", "src/value.txt"], repo);
  await git(["commit", "-m", "accepted change"], repo);
  const commit = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
  await writeFile(
    path.join(repo, "autoresearch.jsonl"),
    [
      JSON.stringify({
        type: "config",
        goal: "Deliver a shippable correctness improvement.",
      }),
      JSON.stringify({
        run: 1,
        status: "keep",
        evidenceStatus: "accepted",
        metric: 1,
        commit: options.commitRef ? options.commitRef(commit) : commit,
        description: "Accepted change",
        evidence: "correctness checks passed",
      }),
      "",
    ].join("\n"),
  );
  const output = path.join(root, `${name}.groups.json`);
  await run(process.execPath, [finalizer, "plan", "--output", output, "--goal", name], repo);
  const plan = JSON.parse(await fsp.readFile(output, "utf8"));
  assert.ok(plan.accepted_evidence_fingerprint?.fingerprint);
  return { commit, output, plan, repo };
}
