import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertGeneratedPlanMetadata } from "../../lib/finalization-plan.js";
import { finalizePreview } from "../../lib/finalize-preview.js";
import {
  finalizer,
  git,
  run,
  testWithTempRoot,
  writeCompleteFinalizationEvidenceFixture,
  writeFile,
} from "./helpers.js";

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
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: secondHash });
    await git(["add", "-f", "autoresearch.jsonl"], repo);
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
    assert.match(finalizeResult.stdout, /Review branches/);
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
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: secondHash });
    await git(["add", "-f", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "session log"], repo);

    const readiness = await finalizePreview({ cwd: repo, trunk: "main" });
    assert.equal(readiness.ready, false);
    assert.ok(readiness.excludedPlannedFileConflicts.length > 0);
    assert.ok(
      readiness.excludedPlannedFileConflicts.some((commit) => commit.files.includes("src/a.txt")),
    );

    const output = path.join(root, "groups.json");
    const preview = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "collapse-conflict", "--collapse-overlap"],
      repo,
      true,
    );
    assert.notEqual(preview.code, 0);
    const refusal = JSON.parse(preview.stderr);
    assert.equal(refusal.code, "mutation-precondition-blocked");
    assert.equal(refusal.preconditionDecision.primaryBlockerCode, "legacy-contract-conflict");
    assert.equal(refusal.preconditionDecision.capabilities.finalize, "recovery-only");
    assert.equal(refusal.mutation, undefined);
    await assert.rejects(fsp.access(output));

    assert.throws(
      () =>
        assertGeneratedPlanMetadata({
          excluded_commit_count: 1,
          excluded_commits: [],
        }),
      /excluded_commit_count does not match excluded_commits/,
    );
    const reviewBranches = (
      await git(["branch", "--list", "autoresearch-review/*"], repo)
    ).stdout.trim();
    assert.equal(reviewBranches, "");
  },
);
