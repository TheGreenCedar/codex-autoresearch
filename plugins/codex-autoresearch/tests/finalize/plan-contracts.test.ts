import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  commitReferencesMatch,
  finalizationPlanFingerprint,
  readAutoresearchLedger,
} from "../../lib/finalization-plan.js";
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
  "finalization plan helpers keep fingerprint and ledger contracts stable",
  "autoresearch-finalization-plan-",
  async (root) => {
    const fullHash = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(commitReferencesMatch(fullHash.slice(0, 12), fullHash), true);
    assert.equal(commitReferencesMatch(fullHash.slice(0, 12).toUpperCase(), fullHash), true);
    assert.equal(commitReferencesMatch(fullHash.slice(0, 6), fullHash), false);
    assert.equal(commitReferencesMatch(`${fullHash.slice(0, 12)}not-a-hash`, fullHash), false);
    assert.equal(commitReferencesMatch(`${fullHash}abcd`, fullHash), false);

    const plan = {
      source_branch: "codex/autoresearch",
      planned_at: "ignored",
      base: "base",
      trunk: "main",
      final_tree: "head",
      goal: "goal",
      kept_commits: ["abc"],
      kept_run_count: 1,
      excluded_commits: [{ commit: "def", status: "discard", subject: "Discarded" }],
      excluded_commit_count: 1,
      overlap_files: ["src/a.ts"],
      current_tree_coverage: {
        review_unit: "current_tree",
        file_count: 1,
        all_file_count: 2,
        exclude_session_artifacts: true,
        include_session_artifacts: false,
        included_files: ["src/a.ts"],
        excluded_session_artifacts: ["autoresearch.jsonl"],
        current_tree_fingerprint: "tree-fingerprint",
      },
      groups: [
        {
          title: "Change",
          body: "ignored",
          last_commit: "abc",
          slug: "change",
          files: ["src/a.ts"],
          source_groups: [
            {
              title: "ignored",
              last_commit: "abc",
              parent_commit: "base",
              files: ["src/a.ts"],
            },
          ],
        },
      ],
    };
    assert.equal(
      finalizationPlanFingerprint({ ...plan, warnings: ["ignored"] }),
      finalizationPlanFingerprint(plan),
    );
    assert.notEqual(
      finalizationPlanFingerprint({
        ...plan,
        groups: [{ ...plan.groups[0], files: ["src/a.ts", "src/b.ts"] }],
      }),
      finalizationPlanFingerprint(plan),
    );
    assert.notEqual(
      finalizationPlanFingerprint({
        ...plan,
        product_claim_coverage: {
          productGradeReady: true,
          maturity: "product_grade",
          missingRequiredProof: [],
          requirements: [],
        },
      }),
      finalizationPlanFingerprint({
        ...plan,
        product_claim_coverage: {
          productGradeReady: false,
          maturity: "experimental",
          missingRequiredProof: [
            { id: "retrieval_accuracy", label: "Retrieval accuracy validation" },
          ],
          requirements: [{ id: "retrieval_accuracy", label: "Retrieval accuracy validation" }],
        },
      }),
    );

    await writeFile(path.join(root, "autoresearch.jsonl"), "{ not json\n");
    await assert.rejects(
      () => readAutoresearchLedger(root, { mode: "silent-empty" }),
      /Corrupt autoresearch\.jsonl at line 1/,
    );
    await assert.rejects(
      () => readAutoresearchLedger(root, { mode: "strict" }),
      /Corrupt autoresearch\.jsonl at line 1/,
    );

    await writeFile(path.join(root, "autoresearch.jsonl"), '{}\n\n"wrong shape"\n');
    await assert.rejects(
      () => readAutoresearchLedger(root, { mode: "strict" }),
      /Corrupt autoresearch\.jsonl at line 3 .*Observed JSON kind: string.*ledger-doctor/,
    );
  },
);

testWithTempRoot(
  "finalize preview suggested plan command keeps the target cwd",
  "autoresearch-finalize-preview-cwd-",
  async (root) => {
    const repo = path.join(root, "repo");
    const otherCwd = path.join(root, "other-cwd");
    await fsp.mkdir(repo, { recursive: true });
    await fsp.mkdir(otherCwd, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-preview-cwd"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "preview cwd",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept,
        }),
        "",
      ].join("\n"),
    );

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    const command = payload.suggestedCommands.finalizerPlan.argv;
    assert.deepEqual(command.slice(0, 5), [process.execPath, finalizer, "plan", "--cwd", repo]);

    const result = await run(command[0], command.slice(1), otherCwd);
    assert.match(result.stdout, /Wrote draft groups/);

    const outputFlag = command.indexOf("--output");
    assert.ok(outputFlag > -1);
    const plan = JSON.parse(await fsp.readFile(command[outputFlag + 1], "utf8"));
    assert.equal(plan.source_branch, "codex/autoresearch-preview-cwd");
    assert.equal(plan.final_tree, kept);
    assert.equal(plan.groups[0].last_commit, kept);
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
  "finalizer fingerprints accepted ordering and product-claim inputs but ignores audit-only rows",
  "autoresearch-finalize-evidence-fingerprint-",
  async (root) => {
    const stale = await createEvidencePlanFixture(root, "claim-inputs");
    await fsp.appendFile(
      path.join(stale.repo, "autoresearch.jsonl"),
      `${JSON.stringify({
        run: 2,
        status: "keep",
        evidenceStatus: "accepted",
        commit: stale.commit,
        metric: 0.9,
        description: "Accepted with revised claim evidence",
        evidence: "correctness checks passed",
      })}\n`,
      "utf8",
    );
    const staleResult = await run(process.execPath, [finalizer, stale.output], stale.repo, true);
    assert.notEqual(staleResult.code, 0);
    assert.match(staleResult.stderr, /accepted ledger ordering/i);
    assert.match(staleResult.stderr, /product-claim coverage inputs/i);

    const audit = await createEvidencePlanFixture(root, "audit-only");
    const malformedCommit = `${audit.commit.slice(0, 12)}not-a-hash`;
    await fsp.appendFile(
      path.join(audit.repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "diagnostic",
          status: "discard",
          commit: audit.commit,
          note: "Audit context only",
        }),
        JSON.stringify({
          type: "context",
          status: "keep",
          evidenceStatus: "rejected",
          commit: audit.commit,
          note: "Context only",
        }),
        JSON.stringify({
          type: "run",
          run: 2,
          status: "measure",
          commit: audit.commit,
          metric: 1,
          description: "Audit probe",
        }),
        JSON.stringify({
          type: "run",
          run: 3,
          status: "keep",
          evidenceStatus: "rejected",
          commit: malformedCommit,
          description: "Malformed rejection reference",
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    const auditResult = await run(process.execPath, [finalizer, audit.output], audit.repo);
    assert.match(auditResult.stdout, /Review branches:/);

    const malformedKeep = await createEvidencePlanFixture(root, "malformed-keep", {
      commitRef: (commit) => `${commit.slice(0, 12)}not-a-hash`,
    });
    assert.deepEqual(malformedKeep.plan.kept_commits, []);
    assert.deepEqual(malformedKeep.plan.groups, []);
    assert.equal(malformedKeep.plan.excluded_commits[0]?.status, "unlogged");
  },
);
