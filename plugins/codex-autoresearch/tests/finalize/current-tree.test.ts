import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  cli,
  finalizer,
  git,
  run,
  testWithTempRoot,
  writeCompleteFinalizationEvidenceFixture,
  writeFile,
} from "./helpers.js";

async function commitSupportingCurrentTreeChange(repo: string, name: string) {
  const relativePath = `src/${name}.txt`;
  await writeFile(path.join(repo, relativePath), "supporting current-tree change\n");
  await git(["add", relativePath], repo);
  await git(["commit", "-m", `add ${name} current-tree support`], repo);
}

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
    await git(["add", "src/guardrails.txt", "src/value.txt"], repo);
    await git(["commit", "-m", "final tree update"], repo);
    const acceptedTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: acceptedTree });
    await git(
      [
        "add",
        "-f",
        "autoresearch-dashboard.html",
        "autoresearch-finalize/scratch.groups.json",
        "autoresearch.jsonl",
        "autoresearch.research/study/quality-gaps.md",
      ],
      repo,
    );
    await git(["commit", "-m", "accept finalization fixture"], repo);

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
    assert.ok(plan.accepted_evidence_fingerprint?.fingerprint);
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
    assert.match(finalizeResult.stdout, /Review branches:/);
  },
);

testWithTempRoot(
  "current-tree finalization plan carries product claim coverage and experimental wording",
  "autoresearch-finalize-current-tree-claim-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "retrieval.ts"), "export const value = 'base';\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/retrieval-current-tree"], repo);
    await writeFile(
      path.join(repo, "src", "retrieval.ts"),
      "export const value = 'bounded foreground embedding';\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "bound foreground embedding work"], repo);

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "semantic retrieval",
          productProofRequirements: [
            {
              id: "independent_product_review",
              label: "Independent review of the product claim",
              requiredForProductGrade: true,
            },
          ],
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
        }),
        "",
      ].join("\n"),
    );
    await writeCompleteFinalizationEvidenceFixture(repo);
    await commitSupportingCurrentTreeChange(repo, "retrieval-proof-support");
    await git(["add", "-f", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, true);
    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    assert.equal(plan.product_grade_ready, false);
    assert.match(plan.product_grade_summary, /Experimental review branch only/i);
    assert.ok(Array.isArray(plan.product_claim_coverage?.missingRequiredProof));
    assert.ok(plan.product_claim_coverage.missingRequiredProof.length > 0);

    const finalizeResult = await run(process.execPath, [finalizer, payload.planOutput], repo);
    assert.match(
      finalizeResult.stdout,
      /Experimental review branch only: product-grade proof is missing\./,
    );
    assert.doesNotMatch(finalizeResult.stdout, /Cleanup After Merge/);
    assert.match(finalizeResult.stdout, /Cleanup after accepted review/i);
  },
);

testWithTempRoot(
  "finalizer rejects current-tree plans when product claim coverage is tampered",
  "autoresearch-finalize-current-tree-claim-tamper-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-tree-tamper"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          productProofRequirements: [
            {
              id: "independent_product_review",
              label: "Independent review of the product claim",
              requiredForProductGrade: true,
            },
          ],
          goal: "Deliver a shippable lazy semantic retrieval performance improvement.",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "speed only",
          evidence: "faster",
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);
    const acceptedTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: acceptedTree });
    await commitSupportingCurrentTreeChange(repo, "claim-tamper-support");
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "accept finalization fixture"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    plan.product_claim_coverage.productGradeReady = true;
    plan.product_grade_ready = true;
    plan.product_claim_coverage.missingRequiredProof = [];
    await fsp.writeFile(payload.planOutput, JSON.stringify(plan, null, 2) + "\n", "utf8");

    const stale = await run(process.execPath, [finalizer, payload.planOutput], repo, true);
    assert.notEqual(stale.code, 0);
    assert.match(
      stale.stderr,
      /plan fingerprint does not match contents|product claim coverage does not match/i,
    );
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
    const acceptedTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: acceptedTree });
    await commitSupportingCurrentTreeChange(repo, "included-session-support");

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
    const acceptedTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: acceptedTree });
    await writeFile(path.join(repo, "src", "dirty.txt"), "uncommitted\n");

    const result = await run(
      process.execPath,
      [cli, "finalize-current-tree", "--cwd", repo],
      repo,
      true,
    );
    assert.notEqual(result.code, 0);
    const refusal = JSON.parse(result.stderr);
    assert.equal(refusal.code, "mutation-precondition-blocked");
    assert.equal(refusal.preconditionDecision.capabilities.finalize, "blocked");
    assert.ok(
      refusal.preconditionDecision.requiredEvidence.diagnosticCodes.includes("dirty-source"),
    );
    await assert.rejects(fsp.access(path.join(repo, "autoresearch-finalize")));
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
    const acceptedTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: acceptedTree });
    await commitSupportingCurrentTreeChange(repo, "coverage-tamper-support");

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
    const acceptedTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: acceptedTree });
    await commitSupportingCurrentTreeChange(repo, "head-staleness-support");

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    await writeFile(path.join(repo, "autoresearch-dashboard.html"), "late session export\n");
    await git(["add", "-f", "autoresearch-dashboard.html"], repo);
    await git(["commit", "-m", "advance source after plan"], repo);

    const stale = await run(process.execPath, [finalizer, payload.planOutput], repo, true);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /current HEAD differs from planned final_tree/i);
  },
);
