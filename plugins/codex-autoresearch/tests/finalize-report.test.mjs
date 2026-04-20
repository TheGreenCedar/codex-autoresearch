import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const finalizer = path.join(pluginRoot, "scripts", "finalize-autoresearch.mjs");

async function run(command, args, cwd, allowFailure = false) {
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error.message || error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (!allowFailure && result.code !== 0) {
    const commandLine = command + " " + args.join(" ");
    throw new Error(commandLine + " failed:\n" + result.stdout + result.stderr);
  }
  return result;
}

async function git(args, cwd) {
  return await run("git", args, cwd);
}

async function writeFile(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents, "utf8");
}

test("finalizer writes an ignored review summary and preserves verification", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-finalize-"));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo, { recursive: true });

  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);

  await writeFile(path.join(repo, "src", "value.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);
  const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await git(["switch", "-c", "codex/autoresearch-test"], repo);
  await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
  await writeFile(path.join(repo, "scripts", "autoresearch.mjs"), "console.log('legitimate source change');\n");
  await writeFile(path.join(repo, "autoresearch.md"), "# session\n");
  await writeFile(path.join(repo, "autoresearch.research", "study", "quality-gaps.md"), "- [ ] session scratchpad\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "keep value change"], repo);
  const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  const groupsPath = path.join(root, "groups.json");
  await fsp.writeFile(groupsPath, JSON.stringify({
    base,
    trunk: "main",
    final_tree: finalTree,
    goal: "ux-test",
    groups: [
      {
        title: "Keep value change",
        body: "Exercise finalization report generation.",
        last_commit: finalTree,
        slug: "value-change",
      },
    ],
  }, null, 2), "utf8");

  const result = await run(process.execPath, [finalizer, groupsPath], repo);
  assert.match(result.stdout, /Review summary: .+autoresearch-finalize.+\.md/);
  assert.match(result.stdout, /Created review branches:/);

  const summaryLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("Review summary: "));
  const summaryPath = summaryLine.slice("Review summary: ".length).trim();
  const summary = await fsp.readFile(summaryPath, "utf8");

  assert.match(summary, /Status: verified/);
  assert.match(summary, /autoresearch-review\/ux-test\/01-value-change/);
  assert.match(summary, /src\/value\.txt/);
  assert.match(summary, /scripts\/autoresearch\.mjs/);
  assert.match(summary, /Suggested PR/);
  assert.match(summary, /git show --stat/);

  const branchFiles = (await git(["show", "--name-only", "--format=", "autoresearch-review/ux-test/01-value-change"], repo)).stdout;
  assert.doesNotMatch(branchFiles, /autoresearch\.research/);

  const status = (await git(["status", "--porcelain"], repo)).stdout.trim();
  assert.equal(status, "");
});

test("finalizer plan writes draft groups from autoresearch history", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-plan-"));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo, { recursive: true });

  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);

  await writeFile(path.join(repo, "src", "value.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);

  await git(["switch", "-c", "codex/autoresearch-test"], repo);
  await writeFile(path.join(repo, "autoresearch.jsonl"), [
    JSON.stringify({ type: "config", name: "speed loop", metricName: "seconds", bestDirection: "lower" }),
    JSON.stringify({ run: 1, status: "keep", metric: 10, description: "Baseline", commit: "HEAD", asi: { hypothesis: "baseline" } }),
  ].join("\n") + "\n");
  await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "keep value change"], repo);

  const output = path.join(root, "groups.json");
  const result = await run(process.execPath, [finalizer, "plan", "--output", output, "--goal", "speed-loop"], repo);
  assert.match(result.stdout, /Wrote draft groups/);

  const plan = JSON.parse(await fsp.readFile(output, "utf8"));
  assert.equal(plan.goal, "speed-loop");
  assert.equal(plan.groups.length, 1);
  assert.match(plan.groups[0].title, /keep value change/i);
  assert.ok(plan.groups[0].last_commit);
});

test("finalizer plan can create nested output paths and collapse overlapping groups", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-plan-collapse-"));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo, { recursive: true });

  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);

  await writeFile(path.join(repo, "src", "value.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);

  await git(["switch", "-c", "codex/autoresearch-overlap"], repo);
  await writeFile(path.join(repo, "src", "value.txt"), "first\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "first value change"], repo);

  await writeFile(path.join(repo, "src", "value.txt"), "second\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "second value change"], repo);

  const output = path.join(root, "plans", "nested", "groups.json");
  const result = await run(process.execPath, [
    finalizer,
    "plan",
    "--output", output,
    "--goal", "overlap-loop",
    "--collapse-overlap",
  ], repo);
  assert.match(result.stdout, /Groups: 1/);

  const plan = JSON.parse(await fsp.readFile(output, "utf8"));
  assert.equal(plan.groups.length, 1);
  assert.match(plan.groups[0].title, /Consolidated overlap-loop changes/);
  assert.match(plan.groups[0].body, /src\/value\.txt/);
});

test("finalizer removes empty skipped branches and sanitizes branch names", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-empty-"));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo, { recursive: true });

  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);

  await writeFile(path.join(repo, "src", "value.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);
  const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await git(["switch", "-c", "codex/autoresearch-test"], repo);
  await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "keep value change"], repo);
  const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  const groupsPath = path.join(root, "groups.json");
  await fsp.writeFile(groupsPath, JSON.stringify({
    base,
    trunk: "main",
    final_tree: finalTree,
    goal: "UX Test With Spaces",
    groups: [
      {
        title: "Empty group",
        body: "No diff from base.",
        last_commit: base,
        slug: "Empty Group",
      },
      {
        title: "Keep value change",
        body: "Real diff.",
        last_commit: finalTree,
        slug: "Value Change",
      },
    ],
  }, null, 2), "utf8");

  const result = await run(process.execPath, [finalizer, groupsPath], repo);
  assert.match(result.stdout, /autoresearch-review\/ux-test-with-spaces\/02-value-change/);

  const branches = (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout;
  assert.doesNotMatch(branches, /01-empty-group/);
  assert.match(branches, /02-value-change/);

  const current = (await git(["branch", "--show-current"], repo)).stdout.trim();
  assert.equal(current, "codex/autoresearch-test");
});
