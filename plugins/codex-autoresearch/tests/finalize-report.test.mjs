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
  await writeFile(path.join(repo, "src", "other.txt"), "base other\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);
  const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await git(["switch", "-c", "codex/autoresearch-test"], repo);
  await writeFile(path.join(repo, "src", "space path.txt"), "kept\n");
  await writeFile(path.join(repo, "scripts", "autoresearch.mjs"), "console.log('legitimate source change');\n");
  await writeFile(path.join(repo, "autoresearch-dashboard.html"), "<html>ignored export</html>\n");
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
  assert.match(summary, /git show --stat 'autoresearch-review\/ux-test\/01-value-change'/);
  assert.match(summary, /git diff [^\n]+ -- 'scripts\/autoresearch\.mjs' 'src\/space path\.txt'/);
  assert.match(summary, /src\/space path\.txt/);
  assert.match(summary, /scripts\/autoresearch\.mjs/);
  assert.match(summary, /Suggested PR/);
  assert.match(summary, /git show --stat/);
  assert.match(summary, /## Finalization Runway/);
  assert.match(summary, /Final file set: .*scripts\/autoresearch\.mjs.*src\/space path\.txt|Final file set: .*src\/space path\.txt.*scripts\/autoresearch\.mjs/);
  assert.match(summary, /Do not run cleanup until the review branch merge has succeeded/);
  assert.match(summary, /autoresearch\.last-run\.json/);
  assert.match(summary, /autoresearch-dashboard\.html/);
  const runwayOrder = [
    "Preview groups and risks",
    "Approve the review branch plan",
    "Create review branches",
    "Verify union",
    "Merge the review branches",
    "Cleanup source branches",
  ].map((text) => summary.indexOf(text));
  assert.ok(runwayOrder.every((index) => index >= 0), runwayOrder.join(", "));
  assert.deepEqual(runwayOrder, [...runwayOrder].sort((a, b) => a - b));

  const branchFiles = (await git(["show", "--name-only", "--format=", "autoresearch-review/ux-test/01-value-change"], repo)).stdout;
  assert.doesNotMatch(branchFiles, /autoresearch\.research/);
  assert.doesNotMatch(branchFiles, /autoresearch-dashboard\.html/);

  const status = (await git(["status", "--porcelain"], repo)).stdout.trim();
  assert.equal(status, "");
});

test("finalizer rejects crafted plan paths before filesystem deletion", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-finalize-path-"));
  const repo = path.join(root, "repo");
  const sentinel = path.join(root, "sentinel.txt");
  await fsp.mkdir(repo, { recursive: true });
  await fsp.writeFile(sentinel, "outside repo\n", "utf8");

  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);
  await writeFile(path.join(repo, "src", "value.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);
  const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await git(["switch", "-c", "codex/autoresearch-path"], repo);
  await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "keep value"], repo);
  const head = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  const groupsPath = path.join(root, "groups.json");
  await fsp.writeFile(groupsPath, JSON.stringify({
    base,
    trunk: "main",
    final_tree: head,
    goal: "path-safety",
    groups: [
      {
        title: "Unsafe crafted path",
        last_commit: head,
        files: ["../sentinel.txt"],
        slug: "unsafe",
      },
    ],
  }, null, 2), "utf8");

  const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unsafe finalizer file path/);
  assert.equal(await fsp.readFile(sentinel, "utf8"), "outside repo\n");

  await fsp.writeFile(groupsPath, JSON.stringify({
    base,
    trunk: "main",
    final_tree: head,
    goal: "metadata-safety",
    groups: [
      {
        title: "Unsafe metadata path",
        last_commit: head,
        files: [".git/config"],
        slug: "unsafe-git",
      },
    ],
  }, null, 2), "utf8");

  const metadataResult = await run(process.execPath, [finalizer, groupsPath], repo, true);
  assert.notEqual(metadataResult.code, 0);
  assert.match(metadataResult.stderr, /Git metadata/);
  assert.equal((await git(["config", "user.email"], repo)).stdout.trim(), "codex@example.invalid");
});

test("finalizer plan keeps only kept commits and flags excluded history", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-plan-"));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo, { recursive: true });

  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);

  await writeFile(path.join(repo, "src", "base.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);

  await git(["switch", "-c", "codex/autoresearch-test"], repo);
  await writeFile(path.join(repo, "src", "kept.txt"), "kept\n");
  await writeFile(path.join(repo, "autoresearch-dashboard.html"), "<html>ignored export</html>\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "keep value change"], repo);
  const keptHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await writeFile(path.join(repo, "src", "discarded.txt"), "discarded\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "discard value change"], repo);
  const discardHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await writeFile(path.join(repo, "src", "crash.txt"), "crash\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "crash value change"], repo);
  const crashHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await writeFile(path.join(repo, "src", "unlogged.txt"), "unlogged\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "unlogged value change"], repo);
  const unloggedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await writeFile(path.join(repo, "autoresearch.jsonl"), [
    JSON.stringify({ type: "config", name: "speed loop", metricName: "seconds", bestDirection: "lower" }),
    JSON.stringify({ run: 1, status: "keep", metric: 10, description: "Kept", commit: keptHash, asi: { hypothesis: "keep the source file" } }),
    JSON.stringify({ run: 2, status: "discard", metric: 11, description: "Discarded", commit: discardHash, asi: { rollback_reason: "Regression" } }),
    JSON.stringify({ run: 3, status: "crash", description: "Crash", commit: crashHash, asi: { evidence: "crashed" } }),
  ].join("\n") + "\n");

  const output = path.join(root, "groups.json");
  const result = await run(process.execPath, [finalizer, "plan", "--output", output, "--goal", "speed-loop"], repo);
  assert.match(result.stdout, /Wrote draft groups/);
  assert.match(result.stdout, /Selected kept commits: 1/);
  assert.match(result.stdout, /Excluded commits: 3/);
  assert.match(result.stdout, /discard value change/);
  assert.match(result.stdout, /crash value change/);
  assert.match(result.stdout, /unlogged/);

  const plan = JSON.parse(await fsp.readFile(output, "utf8"));
  assert.equal(plan.goal, "speed-loop");
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.kept_commits.length, 1);
  assert.equal(plan.excluded_commit_count, 3);
  assert.equal(plan.groups[0].last_commit, keptHash);
  assert.match(plan.groups[0].files.join("\n"), /src\/kept\.txt/);
  assert.deepEqual(plan.excluded_commits.map((item) => item.status).sort(), ["crash", "discard", "unlogged"]);
  assert.doesNotMatch(plan.groups[0].files.join("\n"), /autoresearch-dashboard\.html/);
  assert.match(plan.warnings.join("\n"), /Excluded 3 unkept commits/);
  assert.ok(unloggedHash);
});

test("finalizer plan recommends collapsing overlap and can collapse on request", async () => {
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
  await writeFile(path.join(repo, "src", "other.txt"), "first other\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "first value change"], repo);
  const firstHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await writeFile(path.join(repo, "src", "value.txt"), "second\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "second value change"], repo);
  const secondHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await writeFile(path.join(repo, "autoresearch.jsonl"), [
    JSON.stringify({ type: "config", name: "overlap loop", metricName: "seconds", bestDirection: "lower" }),
    JSON.stringify({ run: 1, status: "keep", metric: 10, description: "First kept change", commit: firstHash, asi: { hypothesis: "first" } }),
    JSON.stringify({ run: 2, status: "keep", metric: 9, description: "Second kept change", commit: secondHash, asi: { hypothesis: "second" } }),
  ].join("\n") + "\n");
  await git(["add", "autoresearch.jsonl"], repo);
  await git(["commit", "-m", "session log"], repo);

  const output = path.join(root, "plans", "nested", "groups.json");
  const preview = await run(process.execPath, [
    finalizer,
    "plan",
    "--output", output,
    "--goal", "overlap-loop",
  ], repo);
  assert.match(preview.stdout, /Hint: rerun with --collapse-overlap to consolidate overlapping kept commits\./);

  const plan = JSON.parse(await fsp.readFile(output, "utf8"));
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.collapse_overlap_recommended, true);
  assert.ok(plan.overlap_count > 0);

  const collapsedOutput = path.join(root, "plans", "nested", "collapsed.groups.json");
  const result = await run(process.execPath, [
    finalizer,
    "plan",
    "--output", collapsedOutput,
    "--goal", "overlap-loop",
    "--collapse-overlap",
  ], repo);
  assert.match(result.stdout, /Groups: 1/);

  const collapsed = JSON.parse(await fsp.readFile(collapsedOutput, "utf8"));
  assert.equal(collapsed.groups.length, 1);
  assert.match(collapsed.groups[0].title, /Consolidated overlap-loop changes/);
  assert.match(collapsed.groups[0].body, /src\/value\.txt/);
  assert.match(collapsed.groups[0].files.join("\n"), /src\/value\.txt/);
  assert.match(collapsed.groups[0].files.join("\n"), /src\/other\.txt/);
  assert.equal(collapsed.groups[0].parent_commit, collapsed.base);

  const finalizeResult = await run(process.execPath, [finalizer, collapsedOutput], repo);
  assert.match(finalizeResult.stdout, /Created review branches/);
  const summaryLine = finalizeResult.stdout.split(/\r?\n/).find((line) => line.startsWith("Review summary: "));
  const summary = await fsp.readFile(summaryLine.slice("Review summary: ".length).trim(), "utf8");
  assert.match(summary, /Status: verified/);

  const branchFiles = (await git(["show", "--name-only", "--format=", "autoresearch-review/overlap-loop/01-overlap-loop-changes"], repo)).stdout;
  assert.match(branchFiles, /src\/value\.txt/);
  assert.match(branchFiles, /src\/other\.txt/);
  assert.equal((await git(["show", "autoresearch-review/overlap-loop/01-overlap-loop-changes:src/value.txt"], repo)).stdout, "second\n");
  assert.equal((await git(["show", "autoresearch-review/overlap-loop/01-overlap-loop-changes:src/other.txt"], repo)).stdout, "first other\n");
});

test("collapsed finalizer fails closed when excluded commits touch planned kept files", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-collapse-conflict-"));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo, { recursive: true });

  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);

  await writeFile(path.join(repo, "src", "a.txt"), "base a\n");
  await writeFile(path.join(repo, "src", "x.txt"), "base x\n");
  await writeFile(path.join(repo, "src", "c.txt"), "base c\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);

  await git(["switch", "-c", "codex/autoresearch-collapse-conflict"], repo);
  await writeFile(path.join(repo, "src", "a.txt"), "kept a\n");
  await writeFile(path.join(repo, "src", "x.txt"), "first x\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "first kept"], repo);
  const firstHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await writeFile(path.join(repo, "src", "a.txt"), "discarded a\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "discarded a"], repo);
  const discardedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await writeFile(path.join(repo, "src", "x.txt"), "second x\n");
  await writeFile(path.join(repo, "src", "c.txt"), "kept c\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "second kept"], repo);
  const secondHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

  await writeFile(path.join(repo, "autoresearch.jsonl"), [
    JSON.stringify({ type: "config", name: "collapse conflict", metricName: "seconds", bestDirection: "lower" }),
    JSON.stringify({ run: 1, status: "keep", metric: 10, description: "First kept", commit: firstHash, asi: { hypothesis: "first" } }),
    JSON.stringify({ run: 2, status: "discard", metric: 11, description: "Discarded a", commit: discardedHash, asi: { evidence: "bad" } }),
    JSON.stringify({ run: 3, status: "keep", metric: 9, description: "Second kept", commit: secondHash, asi: { hypothesis: "second" } }),
  ].join("\n") + "\n");
  await git(["add", "autoresearch.jsonl"], repo);
  await git(["commit", "-m", "session log"], repo);

  const output = path.join(root, "groups.json");
  const preview = await run(process.execPath, [
    finalizer,
    "plan",
    "--output", output,
    "--goal", "collapse-conflict",
    "--collapse-overlap",
  ], repo);
  assert.match(preview.stdout, /Groups: 1/);

  const tamperedOutput = path.join(root, "tampered-groups.json");
  const tamperedPlan = JSON.parse(await fsp.readFile(output, "utf8"));
  assert.ok(tamperedPlan.excluded_commit_count > 0);
  tamperedPlan.excluded_commits = [];
  await fsp.writeFile(tamperedOutput, JSON.stringify(tamperedPlan, null, 2) + "\n", "utf8");
  const tamperedResult = await run(process.execPath, [finalizer, tamperedOutput], repo, true);
  assert.notEqual(tamperedResult.code, 0);
  assert.match(tamperedResult.stderr, /excluded_commit_count does not match excluded_commits/);

  const result = await run(process.execPath, [finalizer, output], repo, true);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /excluded commits touch planned kept files/);
  const reviewBranches = (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout.trim();
  assert.equal(reviewBranches, "");
});

test("finalizer surfaces corrupt autoresearch.jsonl with an actionable error", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "autoresearch-bad-jsonl-"));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo, { recursive: true });

  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);

  await writeFile(path.join(repo, "src", "value.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);

  await git(["switch", "-c", "codex/autoresearch-test"], repo);
  await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "keep value change"], repo);

  await writeFile(path.join(repo, "autoresearch.jsonl"), [
    JSON.stringify({ type: "config", name: "speed loop", metricName: "seconds", bestDirection: "lower" }),
    "{ not valid json",
  ].join("\n") + "\n");

  const output = path.join(root, "groups.json");
  const result = await run(process.execPath, [finalizer, "plan", "--output", output, "--goal", "speed-loop"], repo, true);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Corrupt autoresearch\.jsonl at line 2/);
  assert.match(`${result.stdout}\n${result.stderr}`, /Fix autoresearch\.jsonl/i);
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
