import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { cli, finalizer, git, run, testWithTempRoot, writeFile } from "./helpers.js";

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

    const preview = await run(
      process.execPath,
      [cli, "finalize-preview", "--cwd", repo, "--json-full"],
      repo,
    );
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.finalTreeCoverage.covered, false);
    assert.equal(payload.excludedCommits.length, 1);
    assert.match(payload.warnings.join("\n"), /Excluded 1 unkept non-session commit/);
    assert.deepEqual(payload.excludedCommits[0].files, ["src/guardrails.txt"]);
    assert.equal(payload.evidenceReceipt.kind, "accepted-change-evidence");
    assert.equal(payload.evidenceReceipt.previewReady, payload.ready);
    assert.deepEqual(payload.evidenceReceipt.commits, [kept]);
    assert.deepEqual(payload.evidenceReceipt.files, ["src/value.txt"]);
    assert.equal(payload.evidenceReceipt.observations[0].metric, 1);
    assert.equal(payload.evidenceReceipt.observations[0].checksPassed, null);
    assert.equal(payload.evidenceReceipt.observations[0].contractDigest, null);
    assert.equal(payload.evidenceReceipt.truncated, false);
    assert.equal(payload.evidenceReceipt.limitations.length > 0, true);
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

    const preview = await run(
      process.execPath,
      [cli, "finalize-preview", "--cwd", repo, "--json-full"],
      repo,
    );
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

    const preview = await run(
      process.execPath,
      [cli, "finalize-preview", "--cwd", repo, "--json-full"],
      repo,
    );
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.semanticSafety.ok, false);
    assert.ok(payload.semanticSafety.blockers.some((blocker) => blocker.code === "reverted_keep"));
    assert.match(payload.warnings.join("\n"), /reverted/i);
    assert.deepEqual(payload.evidenceReceipt.commits, []);
    assert.deepEqual(payload.evidenceReceipt.observations, []);
    assert.deepEqual(payload.evidenceReceipt.files, []);
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

    const preview = await run(
      process.execPath,
      [cli, "finalize-preview", "--cwd", repo, "--json-full"],
      repo,
    );
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
  "finalization preserves both hostile paths in a rename",
  "autoresearch-finalize-hostile-rename-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(path.join(repo, "src"), { recursive: true });
    const original =
      process.platform === "win32" ? "src/old 雪.txt" : 'src/ old " -> 雪\\line\n.txt ';
    const current =
      process.platform === "win32" ? "src/new 雪.txt" : 'src/ new " -> 雪\\line\n.txt ';

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, original), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-hostile-rename"], repo);
    await fsp.rename(path.join(repo, original), path.join(repo, current));
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "rename hostile path"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "hostile rename",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "rename hostile path",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log kept rename"], repo);

    const preview = await run(
      process.execPath,
      [cli, "finalize-preview", "--cwd", repo, "--json-full"],
      repo,
    );
    const payload = JSON.parse(preview.stdout);
    assert.deepEqual(payload.groups[0].files, [current, original].sort());
    assert.equal(payload.finalTreeCoverage.covered, true);

    const planPath = path.join(repo, "groups.json");
    const planned = await run(
      process.execPath,
      [finalizer, "plan", "--cwd", repo, "--output", planPath],
      repo,
    );
    assert.equal(planned.code, 0, planned.stderr);
    const plan = JSON.parse(await fsp.readFile(planPath, "utf8"));
    assert.deepEqual(plan.groups[0].files, [current, original].sort());
  },
);
