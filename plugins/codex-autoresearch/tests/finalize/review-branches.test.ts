import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { cli, finalizer, git, run, testWithTempRoot, writeFile } from "./helpers.js";

testWithTempRoot(
  "finalizer writes an ignored review summary and preserves verification",
  "autoresearch-finalize-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    if (process.platform === "win32") await git(["config", "core.autocrlf", "true"], repo);

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
    await writeFile(
      path.join(repo, "autoresearch.research", "study", "quality-gaps.md"),
      "- [ ] session scratchpad\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "Value change"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const groupsPath = path.join(root, "groups.json");
    await authorizeFinalizerApply(repo, finalTree, "verified summary", {
      scope: ["src", "scripts"],
    });
    const { plan } = await generateFinalizerPlan(repo, groupsPath, "ux-test");
    assert.equal(plan.base, base);
    assert.equal(plan.final_tree, finalTree);
    assert.equal(plan.groups.length, 1);
    const reviewBranch = `autoresearch-review/${plan.goal}/01-${plan.groups[0].slug}`;

    const result = await run(process.execPath, [finalizer, groupsPath], repo);
    assert.match(result.stdout, /Review summary: .+autoresearch-finalize.+\.md/);
    assert.match(result.stdout, /Review branches:/);
    assert.match(result.stdout, new RegExp(`${reviewBranch.replaceAll("/", "\\/")} \\(created\\)`));
    assert.match(result.stdout, /Cleanup after verified merge/);
    assert.doesNotMatch(result.stdout, /git branch -D/);
    assert.doesNotMatch(result.stdout, /Remove-Item/);
    assert.doesNotMatch(result.stdout, /rm -rf/);

    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("Review summary: "));
    const summaryPath = summaryLine.slice("Review summary: ".length).trim();
    const summary = await fsp.readFile(summaryPath, "utf8");

    assert.match(summary, /Status: verified/);
    assert.match(summary, /\| # \| Branch \| Provenance \| Title \| Files \|/);
    assert.match(summary, /\| 1 \| `autoresearch-review\/ux-test\/01-value-change` \| created \|/);
    assert.match(summary, /autoresearch-review\/ux-test\/01-value-change/);
    assert.match(summary, /git show --stat 'autoresearch-review\/ux-test\/01-value-change'/);
    assert.match(
      summary,
      /git --literal-pathspecs diff [^\n]+ -- 'scripts\/autoresearch\.ts' 'src\/space path\.txt'/,
    );
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

    const reusedResult = await run(process.execPath, [finalizer, groupsPath], repo);
    assert.match(reusedResult.stdout, /autoresearch-review\/ux-test\/01-value-change \(reused\)/);
    const reusedSummaryLine = reusedResult.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("Review summary: "));
    const reusedSummary = await fsp.readFile(
      reusedSummaryLine.slice("Review summary: ".length).trim(),
      "utf8",
    );
    assert.match(
      reusedSummary,
      /\| 1 \| `autoresearch-review\/ux-test\/01-value-change` \| reused \|/,
    );

    const status = (await run("git", ["status", "--porcelain"], repo)).stdout.trim();
    assert.equal(status, "");
  },
);

testWithTempRoot(
  "finalizer preserves literal App Router, space, and Unicode filenames",
  "autoresearch-finalize-literal-paths-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await writeFile(path.join(repo, "README.md"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const sourceBranch = "codex/literal-finalization";
    await git(["switch", "-c", sourceBranch], repo);
    const expectedFiles = [
      "src/app/(frontend)/[...slug]/page.tsx",
      "src/app/(frontend)/[[...segments]]/page.tsx",
      "src/content/résumé notes.txt",
    ];
    for (const file of expectedFiles) {
      await writeFile(path.join(repo, file), `${file}\n`);
    }
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "Final review.lock"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const groupsPath = path.join(root, "groups.json");
    await authorizeFinalizerApply(repo, finalTree, "literal path finalization", {
      scope: ["src/app", "src/content"],
    });
    const { plan } = await generateFinalizerPlan(repo, groupsPath, "Diagnostic cleanup.");
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].slug, "final-review-lock");
    const result = await run(process.execPath, [finalizer, groupsPath], repo);
    const branch = "autoresearch-review/diagnostic-cleanup/01-final-review-lock";
    assert.match(result.stdout, new RegExp(branch.replaceAll("/", "\\/")));
    const refCheck = await run("git", ["check-ref-format", "--branch", branch], repo, true);
    assert.equal(refCheck.code, 0, refCheck.stderr);
    const branchFiles = (await git(["diff", "--name-only", "-z", base, branch], repo)).stdout
      .split("\0")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(
      branchFiles,
      [...expectedFiles].sort((left, right) => left.localeCompare(right)),
    );
    assert.equal((await git(["branch", "--show-current"], repo)).stdout.trim(), sourceBranch);
  },
);

testWithTempRoot(
  "finalizer refuses existing review branch with same files but stale content",
  "finalize-stale-review-branch-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init"], repo);
    await git(["config", "user.email", "codex@example.test"], repo);
    await git(["config", "user.name", "Codex"], repo);
    await fsp.mkdir(path.join(repo, "src"), { recursive: true });
    await fsp.writeFile(path.join(repo, "src", "value.txt"), "base\n", "utf8");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "base"], repo);
    await git(["branch", "-M", "main"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/session"], repo);
    await fsp.writeFile(path.join(repo, "src", "value.txt"), "planned\n", "utf8");
    await git(["commit", "-am", "planned value"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "--detach", base], repo);
    await git(["switch", "-c", "autoresearch-review/stale-test/01-planned-value"], repo);
    await fsp.writeFile(path.join(repo, "src", "value.txt"), "stale\n", "utf8");
    await git(["commit", "-am", "stale review value"], repo);
    await git(["switch", "codex/session"], repo);

    const groupsPath = path.join(root, "groups.json");
    await authorizeFinalizerApply(repo, finalTree, "stale review branch");
    const { plan } = await generateFinalizerPlan(repo, groupsPath, "stale-test");
    assert.equal(plan.groups[0].slug, "planned-value");
    const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr + result.stdout,
      /divergent|differs from the planned review content/i,
    );
  },
);

testWithTempRoot(
  "finalizer rollback preserves pre-existing equivalent, divergent, and verification branches",
  "finalize-owned-branches-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await writeFile(path.join(repo, "src", "a.txt"), "base a\n");
    await writeFile(path.join(repo, "src", "b.txt"), "base b\n");
    await writeFile(path.join(repo, "src", "c.txt"), "base c\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/ownership-test"], repo);
    await prepareAcceptedContract(repo, "owned review branches", {
      baseline: 4,
      evaluatorSource: [
        'import { readFileSync } from "node:fs";',
        'const files = ["src/a.txt", "src/b.txt", "src/c.txt"];',
        'const planned = files.filter((file) => readFileSync(file, "utf8").startsWith("planned")).length;',
        "console.log(`METRIC score=${4 - planned}`);",
        "",
      ].join("\n"),
    });
    await writeFile(path.join(repo, "src", "a.txt"), "planned a\n");
    const first = await logAcceptedCandidate(repo, "Planned a");
    await writeFile(path.join(repo, "src", "b.txt"), "planned b\n");
    const second = await logAcceptedCandidate(repo, "Planned b");
    await writeFile(path.join(repo, "src", "c.txt"), "planned c\n");
    const finalTree = await logAcceptedCandidate(repo, "Planned c");

    const groupsPath = path.join(root, "groups.json");
    const { plan } = await generateFinalizerPlan(repo, groupsPath, "ownership-test");
    assert.deepEqual(
      plan.groups.map((group) => group.slug),
      ["planned-a", "planned-b", "planned-c"],
    );
    assert.deepEqual(
      plan.groups.map((group) => group.last_commit),
      [first, second, finalTree],
    );

    const createdThenRolledBack = "autoresearch-review/ownership-test/01-planned-a";
    const equivalent = "autoresearch-review/ownership-test/02-planned-b";
    await git(["switch", "--detach", base], repo);
    await git(["switch", "-c", equivalent], repo);
    await writeFile(path.join(repo, "src", "b.txt"), "planned b\n");
    await git(["commit", "-am", "existing equivalent review"], repo);
    const equivalentHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const divergent = "autoresearch-review/ownership-test/03-planned-c";
    await git(["switch", "--detach", base], repo);
    await git(["switch", "-c", divergent], repo);
    await writeFile(path.join(repo, "src", "c.txt"), "wrong c\n");
    await git(["commit", "-am", "existing divergent review"], repo);
    const divergentHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const verificationCollision = "autoresearch-review/ownership-test/verify-planned-a";
    await git(["branch", verificationCollision, base], repo);
    const verificationHead = (await git(["rev-parse", verificationCollision], repo)).stdout.trim();
    await git(["switch", "codex/ownership-test"], repo);
    const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /divergent/i);
    assert.equal(
      (await git(["branch", "--list", createdThenRolledBack], repo)).stdout.trim(),
      "",
      "a branch created earlier in the failed apply must be rolled back",
    );
    assert.equal((await git(["rev-parse", equivalent], repo)).stdout.trim(), equivalentHead);
    assert.equal((await git(["rev-parse", divergent], repo)).stdout.trim(), divergentHead);
    assert.equal(
      (await git(["rev-parse", verificationCollision], repo)).stdout.trim(),
      verificationHead,
    );
    const verificationBranches = (
      await git(["branch", "--list", "autoresearch-review/ownership-test/verify-*"], repo)
    ).stdout
      .trim()
      .replace(/^\*?\s*/, "");
    assert.equal(verificationBranches, verificationCollision);
    assert.equal(
      (await git(["branch", "--show-current"], repo)).stdout.trim(),
      "codex/ownership-test",
    );
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
    await git(["commit", "--allow-empty", "-m", "Empty Group"], repo);
    const emptyCommit = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await prepareAcceptedContract(repo, "empty review group", {
      baseline: 3,
      evaluatorSource: [
        'import { readFileSync } from "node:fs";',
        'const kept = readFileSync("src/value.txt", "utf8").startsWith("kept");',
        "console.log(`METRIC score=${kept ? 1 : 2}`);",
        "",
      ].join("\n"),
    });
    await logAcceptedCandidate(repo, "Empty group", emptyCommit);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    const finalTree = await logAcceptedCandidate(repo, "Value Change");

    const groupsPath = path.join(root, "groups.json");
    const { plan } = await generateFinalizerPlan(repo, groupsPath, "UX Test With Spaces");
    assert.equal(plan.base, base);
    assert.equal(plan.final_tree, finalTree);
    assert.deepEqual(
      plan.groups.map((group) => ({
        commit: group.last_commit,
        files: group.files,
        slug: group.slug,
      })),
      [
        { commit: emptyCommit, files: [], slug: "empty-group" },
        { commit: finalTree, files: ["src/value.txt"], slug: "value-change" },
      ],
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

testWithTempRoot(
  "current-tree recovery rejects legacy groups and applies the public preview plan",
  "autoresearch-current-tree-public-plan-",
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

    await git(["switch", "-c", "codex/current-tree-public-plan"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "accepted\n");
    await git(["commit", "-am", "accepted value"], repo);
    const acceptedHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await authorizeFinalizerApply(repo, acceptedHead, "current tree accepted value");

    await writeFile(path.join(repo, "src", "support.txt"), "unlogged support\n");
    await git(["add", "src/support.txt"], repo);
    await git(["commit", "-m", "unlogged support"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await run(
      process.execPath,
      [
        cli,
        "new-segment",
        "--cwd",
        repo,
        "--reason",
        "Accept evaluator authority at the unlogged current tree",
        "--yes",
      ],
      repo,
    );
    const readiness = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const readinessPayload = JSON.parse(readiness.stdout);
    assert.equal(readinessPayload.actionCode, "current-tree-finalization");
    assert.equal(readinessPayload.ready, false);

    const legacyPlanPath = path.join(root, "legacy-groups.json");
    await fsp.writeFile(
      legacyPlanPath,
      `${JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "legacy-current-tree",
          groups: [
            {
              title: "Legacy current tree",
              body: "Unsigned legacy groups must not gain recovery authority.",
              last_commit: finalTree,
              slug: "legacy-current-tree",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const rejected = await run(process.execPath, [finalizer, legacyPlanPath], repo, true);
    assert.notEqual(rejected.code, 0);
    assert.match(
      rejected.stderr + rejected.stdout,
      /current-final-tree|current-tree.*plan|canonical.*plan|accepted-evidence/i,
    );
    assert.equal(
      (
        await git(["branch", "--list", "autoresearch-review/legacy-current-tree/*"], repo)
      ).stdout.trim(),
      "",
    );

    const preview = await run(
      process.execPath,
      [cli, "finalize-current-tree", "--cwd", repo, "--exclude-session-artifacts"],
      repo,
    );
    const previewPayload = JSON.parse(preview.stdout);
    assert.equal(previewPayload.ready, true);
    assert.equal(previewPayload.finalTree, finalTree);
    assert.ok(previewPayload.planOutput);
    const publicPlan = JSON.parse(await fsp.readFile(previewPayload.planOutput, "utf8"));
    assert.equal(publicPlan.mode, "current-final-tree");
    assert.equal(publicPlan.final_tree, finalTree);
    assert.match(String(publicPlan.plan_fingerprint), /^[0-9a-f]{64}$/);
    assert.match(String(publicPlan.accepted_evidence_fingerprint?.fingerprint), /^[0-9a-f]{64}$/);

    const applied = await run(process.execPath, [finalizer, previewPayload.planOutput], repo);
    assert.match(applied.stdout, /Review branches:/);
    assert.match(applied.stdout, /01-current-final-tree \(created\)/);
    assert.equal(
      (await git(["branch", "--show-current"], repo)).stdout.trim(),
      "codex/current-tree-public-plan",
    );
  },
);

testWithTempRoot(
  "standalone finalizer apply persists completion evidence accepted by Codex goal audit",
  "autoresearch-completion-audit-",
  async (root) => {
    const fixture = await createCompletedAuditFixture(root, "completion-authority");
    assert.match(fixture.applied.stdout, /Review branches:/);
    const completion = fixture.completion;
    assert.equal(completion.schemaVersion, 1);
    assert.equal(completion.sourceHead, fixture.sourceHead);
    assert.equal(completion.contractDigest, fixture.contractDigest);
    assert.equal(completion.preconditionEpoch, fixture.preconditionEpoch);
    assert.equal(typeof completion.acceptedEvidenceBase, "string");
    assert.ok(completion.acceptedEvidenceBase.length > 0);
    assert.ok(Array.isArray(completion.acceptedEvidenceCommitDomain));
    assert.equal(completion.acceptedEvidenceFingerprint?.schema_version, 1);
    assert.match(String(completion.acceptedEvidenceFingerprint?.fingerprint), /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(completion.acceptedEvidenceFingerprint?.components || {}).sort(), [
      "accepted_commit_membership",
      "accepted_ledger_order",
      "evidence_statuses",
      "excluded_commit_statuses",
      "product_claim_coverage_inputs",
    ]);
    assert.match(String(completion.eventId), /^finalization-completed:[0-9a-f]{64}$/);
    assert.match(String(completion.reviewSummary), /^[^/\\]+\.md$/);
    assert.ok(Array.isArray(completion.evidence));
    assert.ok(
      completion.evidence.some((item) => /^review-summary-sha256:[0-9a-f]{64}$/.test(item)),
    );
    assert.ok(completion.evidence.includes(`verified-final-tree:${fixture.sourceHead}`));
    assert.ok(
      completion.evidence.some((item) =>
        /^review-branch:[^@\s]+@[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(item),
      ),
    );

    const audit = await run(
      process.execPath,
      [
        cli,
        "codex-goal-brief",
        "--cwd",
        fixture.repo,
        "--codex-goal-status",
        "active",
        "--completion-confirmed",
        "--completion-evidence",
        "Standalone finalizer apply created and verified the review branch set.",
      ],
      fixture.repo,
    );
    const payload = JSON.parse(audit.stdout);
    assert.equal(payload.canMarkCodexGoalComplete, true);
    assert.equal(payload.completionAudit.status, "complete");
    assert.equal(payload.completionAudit.canMarkCodexGoalComplete, true);
    assert.equal(payload.decisionPlanProjection.phase, "complete");
    assert.equal(payload.decisionPlanProjection.action.kind, "complete");
    assert.equal(payload.decisionPlanProjection.parentDisposition.kind, "complete");
    assert.equal(payload.decisionPlanProjection.parentDisposition.mayClaimCompletion, true);
    assert.ok(
      payload.decisionPlanProjection.requiredEvidence.diagnosticCodes.includes("completion-ready"),
    );
  },
);

testWithTempRoot(
  "experimental finalizer apply does not turn missing product proof into completion authority",
  "autoresearch-experimental-completion-audit-",
  async (root) => {
    const fixture = await createCompletionAuditFixture(
      root,
      "experimental-completion-authority",
      "Deliver a shippable lazy semantic retrieval performance improvement.",
    );
    const groupsPath = path.join(root, "experimental-completion-authority.groups.json");
    const planned = await run(
      process.execPath,
      [
        finalizer,
        "plan",
        "--cwd",
        fixture.repo,
        "--output",
        groupsPath,
        "--goal",
        "experimental-completion-authority",
      ],
      fixture.repo,
    );
    assert.match(planned.stdout, /Experimental review branch only/);

    const applied = await run(process.execPath, [finalizer, groupsPath], fixture.repo);
    assert.match(applied.stdout, /Experimental review branch only/);
    const records = await readLedger(fixture.repo);
    assert.equal(
      records.some((record) => record.type === "finalization-completed"),
      false,
    );

    const audit = await run(
      process.execPath,
      [
        cli,
        "codex-goal-brief",
        "--cwd",
        fixture.repo,
        "--codex-goal-status",
        "active",
        "--completion-confirmed",
        "--completion-evidence",
        "Experimental review branches exist, but required product proof is still missing.",
      ],
      fixture.repo,
    );
    const payload = JSON.parse(audit.stdout);
    assert.equal(payload.canMarkCodexGoalComplete, false);
    assert.equal(payload.completionAudit.canMarkCodexGoalComplete, false);
    assert.equal(payload.decisionPlanProjection.parentDisposition.mayClaimCompletion, false);
    assert.equal(
      payload.decisionPlanProjection.requiredEvidence.diagnosticCodes.includes("completion-ready"),
      false,
    );
  },
);

testWithTempRoot(
  "Codex goal audit rejects forged or stale finalization completion evidence",
  "autoresearch-stale-completion-audit-",
  async (root) => {
    const cases = [
      {
        name: "source",
        mutate(completion: Record<string, any>) {
          const sourceHead = alternateHex(String(completion.sourceHead), 40);
          return completionWithRecomputedEventId(completion, {
            sourceHead,
            evidence: replaceEvidence(
              completion.evidence,
              "verified-final-tree:",
              `verified-final-tree:${sourceHead}`,
            ),
          });
        },
      },
      {
        name: "contract",
        mutate(completion: Record<string, any>) {
          return completionWithRecomputedEventId(completion, {
            contractDigest: alternateHex(String(completion.contractDigest), 64),
          });
        },
      },
      {
        name: "epoch",
        mutate(completion: Record<string, any>) {
          return completionWithRecomputedEventId(completion, {
            preconditionEpoch: `experiment-contract-accepted:${alternateHex(
              String(completion.preconditionEpoch),
              64,
            )}`,
          });
        },
      },
      {
        name: "branch-oid",
        mutate(completion: Record<string, any>) {
          const item = requiredEvidence(completion.evidence, "review-branch:");
          const match = item.match(/^(review-branch:.+@)([0-9a-f]{40}(?:[0-9a-f]{24})?)$/);
          assert.ok(match);
          return completionWithRecomputedEventId(completion, {
            evidence: replaceEvidence(
              completion.evidence,
              "review-branch:",
              `${match[1]}${alternateHex(match[2], match[2].length)}`,
            ),
          });
        },
      },
      {
        name: "branch-nonexistent",
        mutate(completion: Record<string, any>) {
          const item = requiredEvidence(completion.evidence, "review-branch:");
          const match = item.match(/^review-branch:(.+)@([0-9a-f]{40}(?:[0-9a-f]{24})?)$/);
          assert.ok(match);
          return completionWithRecomputedEventId(completion, {
            evidence: replaceEvidence(
              completion.evidence,
              "review-branch:",
              `review-branch:autoresearch-review/nonexistent/01-branch@${match[2]}`,
            ),
          });
        },
      },
      {
        name: "summary-hash",
        mutate(completion: Record<string, any>) {
          const item = requiredEvidence(completion.evidence, "review-summary-sha256:");
          const hash = item.slice("review-summary-sha256:".length);
          return completionWithRecomputedEventId(completion, {
            evidence: replaceEvidence(
              completion.evidence,
              "review-summary-sha256:",
              `review-summary-sha256:${alternateHex(hash, 64)}`,
            ),
          });
        },
      },
    ];

    for (const hostileCase of cases) {
      const fixture = await createCompletedAuditFixture(root, `hostile-${hostileCase.name}`);
      await appendCompletion(fixture.repo, hostileCase.mutate(fixture.completion));
      await assertCompletionRejected(fixture.repo, hostileCase.name);
    }

    const missingSummary = await createCompletedAuditFixture(root, "hostile-summary-absence");
    await fsp.unlink(missingSummary.summaryPath);
    await assertCompletionRejected(missingSummary.repo, "summary-absence");
  },
);

async function readLedger(repo: string): Promise<Array<Record<string, any>>> {
  return (await fsp.readFile(path.join(repo, "autoresearch.jsonl"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function authorizeFinalizerApply(
  repo: string,
  sourceHead: string,
  name: string,
  options: { goal?: string; scope?: string[] } = {},
) {
  const authority = await prepareAcceptedContract(repo, name, options);
  await logAcceptedCandidate(repo, `Accepted evaluation for ${name}`, sourceHead);
  return authority;
}

async function prepareAcceptedContract(
  repo: string,
  name: string,
  options: {
    baseline?: number;
    evaluatorSource?: string;
    goal?: string;
    scope?: string[];
  } = {},
) {
  const contractDir = ".autoresearch-test-contract";
  const evaluatorPath = `${contractDir}/evaluator.mjs`;
  const checksPath = `${contractDir}/checks.mjs`;
  await fsp.appendFile(
    path.join(repo, ".git", "info", "exclude"),
    `\nautoresearch*\n${contractDir}/\n`,
    "utf8",
  );
  await writeFile(
    path.join(repo, evaluatorPath),
    options.evaluatorSource || "console.log('METRIC score=1');\n",
  );
  await writeFile(path.join(repo, checksPath), "process.exit(0);\n");
  const benchmark = `${JSON.stringify(process.execPath)} ${evaluatorPath}`;
  const checks = `${JSON.stringify(process.execPath)} ${checksPath}`;
  const scope = options.scope?.length ? options.scope : ["src"];
  await run(
    process.execPath,
    [
      cli,
      "setup",
      "--cwd",
      repo,
      "--name",
      name,
      ...(options.goal ? ["--goal", options.goal] : []),
      "--metric-name",
      "score",
      "--direction",
      "lower",
      "--benchmark-command",
      benchmark,
      "--checks-command",
      checks,
      "--scope",
      scope.join(","),
      "--commit-paths",
      scope.join(","),
      "--packet-budget",
      "4",
      "--max-iterations",
      "4",
    ],
    repo,
  );
  const configPath = path.join(repo, "autoresearch.config.json");
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  await fsp.writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        checkImplementationPaths: [checksPath],
        checksAuthoritative: true,
        noiseModel: { kind: "deterministic" },
        protectedBenchmarkPaths: [evaluatorPath, checksPath],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await run(
    process.execPath,
    [
      cli,
      "new-segment",
      "--cwd",
      repo,
      "--reason",
      "Accept the finalizer fixture contract",
      "--yes",
    ],
    repo,
  );
  await run(
    process.execPath,
    [
      cli,
      "log",
      "--cwd",
      repo,
      "--metric",
      String(options.baseline ?? 2),
      "--status",
      "measure",
      "--description",
      "Reference measurement for accepted candidates",
    ],
    repo,
  );
  const acceptance = [...(await readLedger(repo))]
    .reverse()
    .find((record) => record.type === "experiment-contract-accepted");
  assert.ok(acceptance?.contract?.contractDigest);
  assert.ok(acceptance.eventId);
  return {
    contractDigest: String(acceptance.contract.contractDigest),
    preconditionEpoch: String(acceptance.eventId),
  };
}

async function logAcceptedCandidate(repo: string, description: string, sourceHead?: string) {
  const packet = await run(process.execPath, [cli, "next", "--cwd", repo], repo);
  const packetPayload = JSON.parse(packet.stdout);
  assert.equal(packetPayload.run.executionAuthority, "accepted-contract");
  assert.equal(packetPayload.run.checks?.passed, true);
  assert.equal(packetPayload.decision.allowedStatuses.includes("keep"), true);
  const logged = await run(
    process.execPath,
    [
      cli,
      "log",
      "--cwd",
      repo,
      "--from-last",
      "--status",
      "keep",
      "--description",
      description,
      "--learning",
      JSON.stringify({
        kind: "discriminating",
        changedBelief: `The accepted evaluator distinguishes ${description} from the prior accepted score.`,
        evidence: [
          `accepted-contract packet passed authoritative checks at metric ${packetPayload.run.metric}`,
        ],
      }),
      ...(sourceHead ? ["--commit", sourceHead] : []),
    ],
    repo,
  );
  const loggedPayload = JSON.parse(logged.stdout);
  assert.equal(loggedPayload.experiment.evaluationAuthority, "accepted-contract");
  assert.equal(loggedPayload.experiment.contractEvaluationEvidence.acceptedEvaluation, true);
  assert.equal(loggedPayload.experiment.contractEvaluationEvidence.checksPassed, true);
  const committedHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
  const recordedCommit = String(loggedPayload.experiment.commit);
  const recordedFullCommit = (await git(["rev-parse", recordedCommit], repo)).stdout.trim();
  assert.equal(recordedFullCommit, sourceHead || committedHead);
  return recordedFullCommit;
}

async function generateFinalizerPlan(repo: string, output: string, goal: string) {
  const planned = await run(
    process.execPath,
    [finalizer, "plan", "--cwd", repo, "--output", output, "--goal", goal],
    repo,
  );
  return { planned, plan: JSON.parse(await fsp.readFile(output, "utf8")) };
}

async function createCompletionAuditFixture(root: string, name: string, goal = "") {
  const repo = path.join(root, name);
  await fsp.mkdir(repo, { recursive: true });
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);
  await writeFile(path.join(repo, ".gitignore"), "autoresearch*\n");
  await writeFile(path.join(repo, "src", "score.txt"), "10\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "baseline source"], repo);
  await git(["switch", "-c", `codex/${name}`], repo);
  await writeFile(path.join(repo, "src", "score.txt"), "9\n");
  await git(["add", "src/score.txt"], repo);
  await git(["commit", "-m", "improve accepted score"], repo);
  const sourceHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
  const authority = await authorizeFinalizerApply(repo, sourceHead, name, {
    ...(goal ? { goal } : {}),
    scope: ["src"],
  });
  return { repo, sourceHead, ...authority };
}

async function createCompletedAuditFixture(root: string, name: string) {
  const fixture = await createCompletionAuditFixture(root, name);
  const groupsPath = path.join(root, `${name}.groups.json`);
  await generateFinalizerPlan(fixture.repo, groupsPath, name);
  const applied = await run(process.execPath, [finalizer, groupsPath], fixture.repo);
  const records = await readLedger(fixture.repo);
  const completion = [...records]
    .reverse()
    .find((record) => record.type === "finalization-completed");
  assert.ok(completion);
  const summaryLine = applied.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("Review summary: "));
  assert.ok(summaryLine);
  return {
    ...fixture,
    applied,
    completion,
    summaryPath: summaryLine.slice("Review summary: ".length).trim(),
  };
}

function completionWithRecomputedEventId(
  completion: Record<string, any>,
  overrides: Record<string, unknown>,
) {
  const changed = { ...completion, ...overrides };
  const identity = {
    sourceHead: changed.sourceHead,
    sourceIndexTree: changed.sourceIndexTree,
    sourceStatusHash: changed.sourceStatusHash,
    contractDigest: changed.contractDigest,
    preconditionEpoch: changed.preconditionEpoch,
    acceptedEvidenceBase: changed.acceptedEvidenceBase,
    acceptedEvidenceCommitDomain: changed.acceptedEvidenceCommitDomain,
    acceptedEvidenceFingerprint: changed.acceptedEvidenceFingerprint,
    productClaimCoverageHash: changed.productClaimCoverageHash,
    productGradeReady: changed.productGradeReady,
    reviewSummary: changed.reviewSummary,
    evidence: changed.evidence,
  };
  return {
    ...changed,
    eventId: `finalization-completed:${createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex")}`,
  };
}

function requiredEvidence(evidence: unknown, prefix: string): string {
  assert.ok(Array.isArray(evidence));
  const item = evidence.find((value) => typeof value === "string" && value.startsWith(prefix));
  assert.equal(typeof item, "string");
  return item;
}

function replaceEvidence(evidence: unknown, prefix: string, replacement: string): string[] {
  const current = requiredEvidence(evidence, prefix);
  return (evidence as string[]).map((item) => (item === current ? replacement : item));
}

function alternateHex(current: string, length: number): string {
  return (current.startsWith("a") ? "b" : "a").repeat(length);
}

async function appendCompletion(repo: string, completion: Record<string, unknown>) {
  await fsp.appendFile(
    path.join(repo, "autoresearch.jsonl"),
    `${JSON.stringify(completion)}\n`,
    "utf8",
  );
}

async function assertCompletionRejected(repo: string, label: string) {
  const audit = await run(
    process.execPath,
    [
      cli,
      "codex-goal-brief",
      "--cwd",
      repo,
      "--codex-goal-status",
      "active",
      "--completion-confirmed",
      "--completion-evidence",
      label,
    ],
    repo,
  );
  const payload = JSON.parse(audit.stdout);
  assert.equal(payload.canMarkCodexGoalComplete, false, label);
  assert.equal(payload.completionAudit.canMarkCodexGoalComplete, false, label);
  assert.equal(payload.decisionPlanProjection.parentDisposition.mayClaimCompletion, false, label);
  assert.equal(
    payload.decisionPlanProjection.requiredEvidence.diagnosticCodes.includes("completion-ready"),
    false,
    label,
  );
}
