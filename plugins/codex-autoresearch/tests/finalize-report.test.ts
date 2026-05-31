import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { finalizePreview } from "../lib/finalize-preview.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import { withTempDir as withNamedTempDir } from "./helpers/process.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const finalizer = path.join(pluginRoot, "scripts", "finalize-autoresearch.mjs");
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");

async function run(command, args, cwd, allowFailure = false) {
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: String(error.message || error) }),
    );
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

async function withTempRoot(prefix, body) {
  return await withNamedTempDir(prefix.replace(/-$/, ""), "root", body);
}

function testWithTempRoot(name, prefix, body) {
  test(name, async () => {
    await withTempRoot(prefix, body);
  });
}

testWithTempRoot(
  "finalizer writes an ignored review summary and preserves verification",
  "autoresearch-finalize-",
  async (root) => {
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
    await writeFile(
      path.join(repo, "scripts", "autoresearch.ts"),
      "console.log('legitimate source change');\n",
    );
    await writeFile(
      path.join(repo, "autoresearch-dashboard.html"),
      "<html>ignored export</html>\n",
    );
    await writeFile(path.join(repo, "autoresearch.md"), "# session\n");
    await writeFile(
      path.join(repo, "autoresearch.research", "study", "quality-gaps.md"),
      "- [ ] session scratchpad\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "keep value change"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo);
    assert.match(result.stdout, /Review summary: .+autoresearch-finalize.+\.md/);
    assert.match(result.stdout, /Created review branches:/);

    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("Review summary: "));
    const summaryPath = summaryLine.slice("Review summary: ".length).trim();
    const summary = await fsp.readFile(summaryPath, "utf8");

    assert.match(summary, /Status: verified/);
    assert.match(summary, /autoresearch-review\/ux-test\/01-value-change/);
    assert.match(summary, /git show --stat 'autoresearch-review\/ux-test\/01-value-change'/);
    assert.match(summary, /git diff [^\n]+ -- 'scripts\/autoresearch\.ts' 'src\/space path\.txt'/);
    assert.match(summary, /src\/space path\.txt/);
    assert.match(summary, /scripts\/autoresearch\.ts/);
    assert.match(summary, /Suggested PR/);
    assert.match(summary, /git show --stat/);
    assert.match(summary, /## Finalization Runway/);
    assert.match(
      summary,
      /Final file set: .*scripts\/autoresearch\.ts.*src\/space path\.txt|Final file set: .*src\/space path\.txt.*scripts\/autoresearch\.ts/,
    );
    assert.match(summary, /Cleanup commands are intentionally omitted/);
    assert.match(summary, /until the review branches have been merged into trunk/);
    assert.match(summary, /autoresearch\.last-run\.json/);
    assert.match(summary, /autoresearch-dashboard\.html/);
    assert.doesNotMatch(summary, /git branch -D/);
    assert.doesNotMatch(summary, /Remove-Item/);
    assert.doesNotMatch(summary, /rm -rf/);
    const runwayOrder = [
      "Preview groups and risks",
      "Approve the review branch plan",
      "Create review branches",
      "Verify union",
      "Merge the review branches",
      "Cleanup source branches",
    ].map((text) => summary.indexOf(text));
    assert.ok(
      runwayOrder.every((index) => index >= 0),
      runwayOrder.join(", "),
    );
    assert.deepEqual(
      runwayOrder,
      [...runwayOrder].sort((a, b) => a - b),
    );

    const branchFiles = (
      await git(
        ["show", "--name-only", "--format=", "autoresearch-review/ux-test/01-value-change"],
        repo,
      )
    ).stdout;
    assert.doesNotMatch(branchFiles, /autoresearch\.research/);
    assert.doesNotMatch(branchFiles, /autoresearch-dashboard\.html/);

    const status = (await git(["status", "--porcelain"], repo)).stdout.trim();
    assert.equal(status, "");
  },
);

testWithTempRoot(
  "finalize preview blocks unlogged non-session commits from the final tree",
  "autoresearch-finalize-preview-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-preview"], repo);
    await writeFile(path.join(repo, "src", "guardrails.txt"), "leakage guard\n");
    await git(["add", "src/guardrails.txt"], repo);
    await git(["commit", "-m", "add leakage guardrails"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "preview",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.finalTreeCoverage.covered, false);
    assert.equal(payload.excludedCommits.length, 1);
    assert.match(payload.warnings.join("\n"), /Excluded 1 unkept non-session commit/);
    assert.deepEqual(payload.excludedCommits[0].files, ["src/guardrails.txt"]);
  },
);

testWithTempRoot(
  "finalize preview blocks kept commits that were later explicitly invalidated",
  "autoresearch-finalize-discard-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-discard"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "discarded keep",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        JSON.stringify({
          run: 2,
          status: "discard",
          metric: 1,
          description: "invalidated evaluator contamination for kept metric improvement",
          commit: kept.slice(0, 12),
          asi: { rollback_reason: "Evaluator contamination invalidated the keep." },
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log invalidation"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.semanticSafety.ok, false);
    assert.ok(
      payload.semanticSafety.blockers.some((blocker) => blocker.code === "later_invalidated_keep"),
    );
    assert.match(payload.warnings.join("\n"), /discarded|invalidated/i);
  },
);

testWithTempRoot(
  "finalize preview allows ordinary same-commit discard rollback",
  "autoresearch-finalize-normal-discard-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-normal-discard"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "normal discard",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        JSON.stringify({
          run: 2,
          status: "discard",
          metric: 0.9,
          description: "discarded dirty experiment",
          commit: kept.slice(0, 12),
          asi: { rollback_reason: "reverted scoped experiment changes" },
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log ordinary discard"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.semanticSafety.ok, true);
    assert.deepEqual(payload.semanticSafety.blockers, []);
  },
);

testWithTempRoot(
  "finalize preview detects reverted kept commits",
  "autoresearch-finalize-revert-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-revert"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await git(["revert", "--no-edit", kept], repo);

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "reverted keep",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log reverted keep"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.semanticSafety.ok, false);
    assert.ok(payload.semanticSafety.blockers.some((blocker) => blocker.code === "reverted_keep"));
    assert.match(payload.warnings.join("\n"), /reverted/i);
  },
);

testWithTempRoot(
  "finalize preview blocks excluded commits that touch planned files",
  "autoresearch-finalize-overlap-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-overlap-excluded"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "value.txt"), "unkept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "unkept overlapping edit"], repo);

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "overlap excluded",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.finalTreeCoverage.covered, true);
    assert.equal(payload.finalTreeCoverage.excludedPlannedFileConflictCount, 1);
    assert.equal(payload.excludedPlannedFileConflicts.length, 1);
    assert.deepEqual(payload.excludedPlannedFileConflicts[0].files, ["src/value.txt"]);
    assert.match(payload.warnings.join("\n"), /excluded commits touch planned files/i);
  },
);

testWithTempRoot(
  "finalize-current-tree packages the current non-session diff",
  "autoresearch-finalize-current-tree-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-tree"], repo);
    await writeFile(path.join(repo, "src", "guardrails.txt"), "supporting safety change\n");
    await git(["add", "src/guardrails.txt"], repo);
    await git(["commit", "-m", "add supporting guardrails"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await writeFile(
      path.join(repo, "autoresearch-dashboard.html"),
      "<html>session export</html>\n",
    );
    await writeFile(path.join(repo, "autoresearch.jsonl"), "{}\n");
    await writeFile(
      path.join(repo, "autoresearch.research", "study", "quality-gaps.md"),
      "- [ ] gap\n",
    );
    await writeFile(path.join(repo, "autoresearch-finalize", "scratch.groups.json"), "{}\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.progress.stages[0].stage, "finalize-current-tree");
    assert.equal(payload.currentTreeCoverage.covered, true);
    assert.ok(payload.files.includes("src/guardrails.txt"));
    assert.ok(payload.files.includes("src/value.txt"));
    assert.ok(!payload.files.includes("autoresearch-dashboard.html"));
    assert.deepEqual(payload.includedFiles.sort(), ["src/guardrails.txt", "src/value.txt"]);
    assert.deepEqual(payload.excludedFiles.sort(), [
      "autoresearch-dashboard.html",
      "autoresearch-finalize/scratch.groups.json",
      "autoresearch.jsonl",
      "autoresearch.research/study/quality-gaps.md",
    ]);
    assert.match(payload.reviewUnit.message, /current branch tree, not older kept commits/);
    assert.ok(payload.planOutput);
    assert.ok(payload.planFingerprint);
    assert.ok(payload.currentTreeFingerprint);
    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    assert.equal(plan.mode, "current-final-tree");
    assert.ok(plan.plan_fingerprint);
    assert.equal(plan.current_tree_coverage.exclude_session_artifacts, true);
    assert.equal(plan.current_tree_coverage.review_unit, "current_tree");
    assert.deepEqual(plan.current_tree_coverage.excluded_session_artifacts.sort(), [
      "autoresearch-dashboard.html",
      "autoresearch-finalize/scratch.groups.json",
      "autoresearch.jsonl",
      "autoresearch.research/study/quality-gaps.md",
    ]);
    assert.deepEqual(plan.groups[0].files.sort(), ["src/guardrails.txt", "src/value.txt"]);

    const finalizeResult = await run(process.execPath, [finalizer, payload.planOutput], repo);
    assert.match(finalizeResult.stdout, /Created review branches:/);
  },
);

testWithTempRoot(
  "finalize-current-tree can explicitly include session artifacts",
  "autoresearch-finalize-current-include-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-include"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await writeFile(
      path.join(repo, "autoresearch-dashboard.html"),
      "<html>session export</html>\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);

    const result = await run(
      process.execPath,
      [cli, "finalize-current-tree", "--cwd", repo, "--include-session-artifacts"],
      repo,
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.currentTreeCoverage.excludeSessionArtifacts, false);
    assert.ok(payload.files.includes("autoresearch-dashboard.html"));
    assert.deepEqual(payload.excludedFiles, []);

    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    assert.equal(plan.current_tree_coverage.exclude_session_artifacts, false);
    assert.equal(plan.current_tree_coverage.include_session_artifacts, true);
    assert.ok(plan.groups[0].files.includes("autoresearch-dashboard.html"));
  },
);

testWithTempRoot(
  "finalize-current-tree refuses dirty source trees without writing a plan",
  "autoresearch-finalize-current-dirty-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-dirty"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);
    await writeFile(path.join(repo, "src", "dirty.txt"), "uncommitted\n");

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.planOutput, "");
    assert.match(payload.warnings.join("\n"), /dirty/i);
  },
);

testWithTempRoot(
  "finalizer rejects stale current-tree plans when coverage is tampered",
  "autoresearch-finalize-current-stale-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-stale"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    plan.current_tree_coverage.included_files = [];
    await fsp.writeFile(payload.planOutput, JSON.stringify(plan, null, 2) + "\n", "utf8");

    const stale = await run(process.execPath, [finalizer, payload.planOutput], repo, true);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /plan fingerprint does not match contents/i);
  },
);

testWithTempRoot(
  "finalizer rejects current-tree plans after the source branch advances",
  "autoresearch-finalize-current-head-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-head"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    await writeFile(path.join(repo, "src", "late.txt"), "late\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "advance source after plan"], repo);

    const stale = await run(process.execPath, [finalizer, payload.planOutput], repo, true);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /current HEAD differs from planned final_tree/i);
  },
);

testWithTempRoot(
  "finalizer rejects crafted plan paths before filesystem deletion",
  "autoresearch-finalize-path-",
  async (root) => {
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
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unsafe finalizer file path/);
    assert.equal(await fsp.readFile(sentinel, "utf8"), "outside repo\n");

    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
      "utf8",
    );

    const metadataResult = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(metadataResult.code, 0);
    assert.match(metadataResult.stderr, /Git metadata/);
    assert.equal(
      (await git(["config", "user.email"], repo)).stdout.trim(),
      "codex@example.invalid",
    );
  },
);

testWithTempRoot(
  "finalizer plan keeps only kept commits and flags excluded history",
  "autoresearch-plan-",
  async (root) => {
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
    await writeFile(
      path.join(repo, "autoresearch-dashboard.html"),
      "<html>ignored export</html>\n",
    );
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

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "speed loop",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 10,
          description: "Kept",
          commit: keptHash,
          asi: { hypothesis: "keep the source file" },
        }),
        JSON.stringify({
          run: 2,
          status: "discard",
          metric: 11,
          description: "Discarded",
          commit: discardHash,
          asi: { rollback_reason: "Regression" },
        }),
        JSON.stringify({
          run: 3,
          status: "crash",
          description: "Crash",
          commit: crashHash,
          asi: { evidence: "crashed" },
        }),
      ].join("\n") + "\n",
    );

    const output = path.join(root, "groups.json");
    const result = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "speed-loop"],
      repo,
    );
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
    assert.deepEqual(plan.excluded_commits.map((item) => item.status).sort(), [
      "crash",
      "discard",
      "unlogged",
    ]);
    assert.doesNotMatch(plan.groups[0].files.join("\n"), /autoresearch-dashboard\.html/);
    assert.match(plan.warnings.join("\n"), /Excluded 3 unkept commits/);
    assert.ok(unloggedHash);
  },
);

testWithTempRoot(
  "finalization ignores rejected keeps while preserving legacy accepted keeps",
  "autoresearch-finalize-evidence-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "base.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-evidence"], repo);
    await writeFile(path.join(repo, "src", "rejected.txt"), "rejected\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "rejected keep"], repo);
    const rejectedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "superseded.txt"), "superseded\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "superseded keep"], repo);
    const supersededHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "accepted.txt"), "accepted\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "legacy accepted keep"], repo);
    const acceptedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "evidence loop",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          evidenceStatus: "rejected",
          metric: 1,
          description: "Rejected keep",
          commit: rejectedHash,
        }),
        JSON.stringify({
          run: 2,
          status: "keep",
          evidenceStatus: "superseded",
          metric: 0.5,
          description: "Superseded keep",
          commit: supersededHash,
        }),
        JSON.stringify({
          run: 3,
          status: "keep",
          metric: 2,
          description: "Legacy accepted keep",
          commit: acceptedHash,
        }),
      ].join("\n") + "\n",
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "session log"], repo);

    const preview = await finalizePreview({ cwd: repo, trunk: "main" });
    assert.equal(preview.groups.length, 1);
    assert.equal(preview.groups[0].commit, acceptedHash);

    const output = path.join(root, "groups.json");
    const result = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "evidence-loop"],
      repo,
    );
    assert.match(result.stdout, /Selected kept commits: 1/);

    const plan = JSON.parse(await fsp.readFile(output, "utf8"));
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.kept_commits.length, 1);
    assert.equal(plan.groups[0].last_commit, acceptedHash);
    assert.deepEqual(plan.kept_commits, [acceptedHash]);
    assert.equal(
      plan.excluded_commits.some(
        (item) => item.commit === rejectedHash && item.status === "rejected",
      ),
      true,
    );
    assert.equal(
      plan.excluded_commits.some(
        (item) => item.commit === supersededHash && item.status === "superseded",
      ),
      true,
    );
  },
);

testWithTempRoot(
  "finalizer plan recommends collapsing overlap and can collapse on request",
  "autoresearch-plan-collapse-",
  async (root) => {
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

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "overlap loop",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 10,
          description: "First kept change",
          commit: firstHash,
          asi: { hypothesis: "first" },
        }),
        JSON.stringify({
          run: 2,
          status: "keep",
          metric: 9,
          description: "Second kept change",
          commit: secondHash,
          asi: { hypothesis: "second" },
        }),
      ].join("\n") + "\n",
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "session log"], repo);

    const output = path.join(root, "plans", "nested", "groups.json");
    const preview = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "overlap-loop"],
      repo,
    );
    assert.match(
      preview.stdout,
      /Hint: rerun with --collapse-overlap to consolidate overlapping kept commits\./,
    );

    const plan = JSON.parse(await fsp.readFile(output, "utf8"));
    assert.equal(plan.groups.length, 2);
    assert.equal(plan.collapse_overlap_recommended, true);
    assert.ok(plan.overlap_count > 0);

    const collapsedOutput = path.join(root, "plans", "nested", "collapsed.groups.json");
    const result = await run(
      process.execPath,
      [
        finalizer,
        "plan",
        "--output",
        collapsedOutput,
        "--goal",
        "overlap-loop",
        "--collapse-overlap",
      ],
      repo,
    );
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
    const summaryLine = finalizeResult.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("Review summary: "));
    const summary = await fsp.readFile(summaryLine.slice("Review summary: ".length).trim(), "utf8");
    assert.match(summary, /Status: verified/);

    const branchFiles = (
      await git(
        [
          "show",
          "--name-only",
          "--format=",
          "autoresearch-review/overlap-loop/01-overlap-loop-changes",
        ],
        repo,
      )
    ).stdout;
    assert.match(branchFiles, /src\/value\.txt/);
    assert.match(branchFiles, /src\/other\.txt/);
    assert.equal(
      (
        await git(
          ["show", "autoresearch-review/overlap-loop/01-overlap-loop-changes:src/value.txt"],
          repo,
        )
      ).stdout,
      "second\n",
    );
    assert.equal(
      (
        await git(
          ["show", "autoresearch-review/overlap-loop/01-overlap-loop-changes:src/other.txt"],
          repo,
        )
      ).stdout,
      "first other\n",
    );
  },
);

testWithTempRoot(
  "collapsed finalizer fails closed when excluded commits touch planned kept files",
  "autoresearch-collapse-conflict-",
  async (root) => {
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

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "collapse conflict",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 10,
          description: "First kept",
          commit: firstHash,
          asi: { hypothesis: "first" },
        }),
        JSON.stringify({
          run: 2,
          status: "discard",
          metric: 11,
          description: "Discarded a",
          commit: discardedHash,
          asi: { evidence: "bad" },
        }),
        JSON.stringify({
          run: 3,
          status: "keep",
          metric: 9,
          description: "Second kept",
          commit: secondHash,
          asi: { hypothesis: "second" },
        }),
      ].join("\n") + "\n",
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "session log"], repo);

    const output = path.join(root, "groups.json");
    const preview = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "collapse-conflict", "--collapse-overlap"],
      repo,
    );
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
    const reviewBranches = (
      await git(["branch", "--list", "autoresearch-review/*"], repo)
    ).stdout.trim();
    assert.equal(reviewBranches, "");
  },
);

testWithTempRoot(
  "finalizer surfaces corrupt autoresearch.jsonl with an actionable error",
  "autoresearch-bad-jsonl-",
  async (root) => {
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

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "speed loop",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        "{ not valid json",
      ].join("\n") + "\n",
    );

    const output = path.join(root, "groups.json");
    const result = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "speed-loop"],
      repo,
      true,
    );
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Corrupt autoresearch\.jsonl at line 2/);
    assert.match(`${result.stdout}\n${result.stderr}`, /Fix autoresearch\.jsonl/i);
  },
);

testWithTempRoot(
  "finalizer removes empty skipped branches and sanitizes branch names",
  "autoresearch-empty-",
  async (root) => {
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
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo);
    assert.match(result.stdout, /autoresearch-review\/ux-test-with-spaces\/02-value-change/);

    const branches = (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout;
    assert.doesNotMatch(branches, /01-empty-group/);
    assert.match(branches, /02-value-change/);

    const current = (await git(["branch", "--show-current"], repo)).stdout.trim();
    assert.equal(current, "codex/autoresearch-test");
  },
);
