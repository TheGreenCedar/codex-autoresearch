import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { finalizePreview } from "../../lib/finalize-preview.js";
import {
  cli,
  createEvidencePlanFixture,
  finalizer,
  git,
  run,
  testWithTempRoot,
  writeFile,
} from "./helpers.js";

testWithTempRoot(
  "finalization treats review-required keeps as provisional until ASI acknowledgement",
  "autoresearch-finalize-review-required-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "base.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-review-required"], repo);
    await writeFile(path.join(repo, "src", "review-required.txt"), "review\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "review required keep"], repo);
    const reviewHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "acknowledged.txt"), "ack\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "acknowledged keep"], repo);
    const acknowledgedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "review required loop",
          metricName: "quality_gap",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          evidenceStatus: "accepted",
          metric: 0,
          metrics: { quality_gap: 0, review_required: 1 },
          description: "Review required keep",
          commit: reviewHash,
        }),
        JSON.stringify({
          run: 2,
          status: "keep",
          evidenceStatus: "accepted",
          metric: 0,
          metrics: { quality_gap: 0, review_required: 1 },
          asi: { review_acknowledged: true },
          description: "Acknowledged review keep",
          commit: acknowledgedHash,
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const preview = await finalizePreview({ cwd: repo, trunk: "main" });
    assert.equal(preview.groups.length, 1);
    assert.equal(preview.groups[0].commit, acknowledgedHash);
    assert.notEqual(preview.groups[0].commit, reviewHash);
  },
);

testWithTempRoot(
  "product-grade finalization preview blocks under-proven retrieval claims",
  "autoresearch-product-grade-preview-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "retrieval.ts"), "export const value = 'base';\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/retrieval-product-claim"], repo);
    await writeFile(
      path.join(repo, "src", "retrieval.ts"),
      "export const value = 'bounded foreground embedding';\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "bound foreground embedding work"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "semantic retrieval",
          goal: "Deliver a shippable lazy semantic retrieval performance improvement.",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "Bound foreground embedding work.",
          evidence: "foreground embedding work can be bounded",
          commit: kept,
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const preview = await finalizePreview({ cwd: repo, trunk: "main" });
    assert.equal(preview.productGradeReady, false);
    assert.match(preview.blockers.join("\n"), /retrieval accuracy/i);
    assert.match(preview.blockers.join("\n"), /lazy/i);
    assert.doesNotMatch(preview.summary, /ready to merge|shippable/i);

    const planPath = path.join(root, "groups.json");
    const planResult = await run(
      process.execPath,
      [finalizer, "plan", "--cwd", repo, "--output", planPath, "--goal", "retrieval-claim"],
      repo,
    );
    assert.match(
      planResult.stdout,
      /Experimental review branch only: product-grade proof is missing\./,
    );
    const plan = JSON.parse(await fsp.readFile(planPath, "utf8"));
    assert.equal(plan.product_grade_ready, false);
    assert.equal(
      plan.product_grade_summary,
      "Experimental review branch only: product-grade proof is missing.",
    );
  },
);

testWithTempRoot(
  "finalize preview refuses hard decision capsules",
  "autoresearch-finalize-capsule-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    await git(["switch", "-c", "codex/autoresearch-capsule"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          timestamp: "2026-06-01T13:00:00.000Z",
          name: "preview",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          timestamp: "2026-06-01T13:05:00.000Z",
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repo, "autoresearch.research", "benchmark-contract", "decision-capsule.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "session-decision-capsule",
        status: "active",
        enforcement: {
          mode: "hard-block",
          canRunNextPacket: false,
          allowBoundedNext: false,
          blocksFinalization: true,
          clearingCondition: "Run benchmark-lint successfully before finalization.",
          commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd <project>",
          triggeredBy: ["sessionDecisionCapsule", "benchmarkContract"],
        },
        bottleneck: "Benchmark wrapper cannot prove the primary METRIC.",
        evidence: ["benchmark-lint timed out and parsed zero primary METRIC lines."],
        nextExperiment: "Repair benchmark-lint until the primary METRIC is emitted.",
        wrongNextActions: ["Do not run next or finalize."],
        doNotRepeat: [],
        commandBudgetWarnings: [],
        generatedFrom: {
          compactions: 0,
          first: "2026-06-01T13:00:00.000Z",
          last: "2026-06-01T13:10:00.000Z",
          toolCounts: {},
          topCommandHeads: [],
        },
        importedAt: "2026-06-01T13:10:00.000Z",
      }),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const payload = await finalizePreview({ cwd: repo, trunk: "main" });
    assert.equal(payload.ready, false);
    assert.equal(payload.sessionDecisionCapsule.kind, "session-decision-capsule");
    assert.match(payload.nextAction, /Repair benchmark-lint/);
    assert.match(payload.warnings.join("\n"), /primary METRIC/);
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
  "finalizer rejects plans after hostile accepted-current evidence changes",
  "autoresearch-finalize-stale-evidence-",
  async (root) => {
    const variants = [
      {
        name: "rejected",
        entry: (commit) => ({
          run: 2,
          status: "keep",
          evidenceStatus: "rejected",
          commit,
          description: "Rejected after review",
        }),
      },
      {
        name: "superseded",
        entry: (commit) => ({
          run: 2,
          status: "keep",
          evidenceStatus: "superseded",
          commit,
          description: "Superseded by later evidence",
        }),
      },
      {
        name: "invalidated",
        entry: (commit) => ({
          run: 2,
          status: "discard",
          commit,
          description: "Invalidated after evaluator contamination",
          asi: { rollback_reason: "Evaluator contamination invalidated the keep." },
        }),
      },
      {
        name: "reverted",
        entry: (commit) => ({
          run: 2,
          status: "discard",
          commit,
          description: "Reverted after verification",
          asi: { rollback_reason: "Reverted the accepted change." },
        }),
      },
    ];

    for (const variant of variants) {
      const { commit, output, repo } = await createEvidencePlanFixture(root, variant.name);
      const plannedHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
      await fsp.appendFile(
        path.join(repo, "autoresearch.jsonl"),
        `${JSON.stringify(variant.entry(commit))}\n`,
        "utf8",
      );

      const result = await run(process.execPath, [finalizer, output], repo, true);
      assert.notEqual(result.code, 0, variant.name);
      assert.match(result.stderr, /accepted-current evidence changed/i, variant.name);
      assert.match(result.stderr, /accepted commit membership/i, variant.name);
      assert.match(result.stderr, /evidence status/i, variant.name);
      assert.match(result.stderr, /Regenerate the finalizer plan/i, variant.name);
      assert.equal((await git(["rev-parse", "HEAD"], repo)).stdout.trim(), plannedHead);
      assert.equal(
        (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout.trim(),
        "",
        variant.name,
      );
    }
  },
);
