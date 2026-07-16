import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { finalizer, git, run, testWithTempRoot, writeFile } from "./helpers.js";

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
    assert.match(result.stdout, /Review branches:/);
    assert.match(result.stdout, /autoresearch-review\/ux-test\/01-value-change \(created\)/);
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
    await git(["commit", "-m", "add literal route paths"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "Diagnostic cleanup.",
          groups: [
            {
              title: "Finalize literal paths",
              body: "Exercise valid repository filenames without pathspec expansion.",
              last_commit: finalTree,
              slug: "Final review.lock",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

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
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "stale-test",
          groups: [
            {
              title: "Planned value",
              body: "Exercise stale branch detection.",
              last_commit: finalTree,
              slug: "planned-value",
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
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/ownership-test"], repo);
    await writeFile(path.join(repo, "src", "a.txt"), "planned a\n");
    await git(["commit", "-am", "planned a"], repo);
    const first = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeFile(path.join(repo, "src", "b.txt"), "planned b\n");
    await git(["commit", "-am", "planned b"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const equivalent = "autoresearch-review/ownership-test/01-planned-a";
    await git(["switch", "--detach", base], repo);
    await git(["switch", "-c", equivalent], repo);
    await writeFile(path.join(repo, "src", "a.txt"), "planned a\n");
    await git(["commit", "-am", "existing equivalent review"], repo);
    const equivalentHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const divergent = "autoresearch-review/ownership-test/02-planned-b";
    await git(["switch", "--detach", base], repo);
    await git(["switch", "-c", divergent], repo);
    await writeFile(path.join(repo, "src", "b.txt"), "wrong b\n");
    await git(["commit", "-am", "existing divergent review"], repo);
    const divergentHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const verificationCollision = "autoresearch-review/ownership-test/verify-planned-a";
    await git(["branch", verificationCollision, base], repo);
    const verificationHead = (await git(["rev-parse", verificationCollision], repo)).stdout.trim();
    await git(["switch", "codex/ownership-test"], repo);

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "ownership-test",
          groups: [
            {
              title: "Planned a",
              body: "Reuse the equivalent branch.",
              last_commit: first,
              slug: "planned-a",
            },
            {
              title: "Planned b",
              body: "Reject the divergent branch.",
              last_commit: finalTree,
              slug: "planned-b",
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
    assert.match(result.stderr + result.stdout, /divergent/i);
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
