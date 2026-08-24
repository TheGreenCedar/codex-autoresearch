import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  finalizer,
  git,
  run,
  testWithTempRoot,
  withTempRoot,
  writeCompleteFinalizationEvidenceFixture,
  writeFile,
} from "./helpers.js";

testWithTempRoot(
  "finalizer treats wildcard characters in filenames as literal paths",
  "autoresearch-finalize-pathspec-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "fixtures", "a.txt"), "base\n");
    await writeFile(path.join(repo, "fixtures", "b.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/pathspec-plan"], repo);
    await writeFile(path.join(repo, "fixtures", "[ab].txt"), "literal wildcard filename\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "keep literal wildcard filename"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: finalTree });

    const groupsPath = path.join(root, "groups.json");
    await run(
      process.execPath,
      [finalizer, "plan", "--cwd", repo, "--output", groupsPath, "--goal", "pathspec-plan"],
      repo,
    );
    const generatedPlan = JSON.parse(await fsp.readFile(groupsPath, "utf8"));
    assert.deepEqual(generatedPlan.groups[0].files, ["fixtures/[ab].txt"]);

    const result = await run(process.execPath, [finalizer, groupsPath], repo);
    const branch = `autoresearch-review/pathspec-plan/01-${generatedPlan.groups[0].slug}`;
    assert.ok(result.stdout.includes(branch));
    const files = (await git(["diff", "--name-only", "-z", base, branch], repo)).stdout
      .split("\0")
      .filter(Boolean);
    assert.deepEqual(files, ["fixtures/[ab].txt"]);
    assert.equal((await git(["show", `${branch}:fixtures/b.txt`], repo)).stdout, "base\n");
    assert.equal(
      (await git(["branch", "--show-current"], repo)).stdout.trim(),
      "codex/pathspec-plan",
    );
  },
);

test("finalizer refuses cleanup through linked directory parents", async (t) => {
  await withTempRoot("autoresearch-finalize-linked-parent-", async (root) => {
    const repo = path.join(root, "repo");
    const outside = path.join(root, "outside");
    const linkPath = path.join(repo, "linked-output");
    const outsideVictim = path.join(outside, "victim.txt");
    await fsp.mkdir(repo, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(outsideVictim, "outside data\n", "utf8");

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, ".gitignore"), "linked-output\n");
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/linked-parent-plan"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["commit", "-am", "keep value"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: finalTree });

    try {
      await fsp.symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`directory links are unavailable in this environment: ${String(error)}`);
      return;
    }

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "linked-parent-plan",
          groups: [
            {
              title: "Linked parent plan",
              body: "Should not delete outside the repo.",
              last_commit: finalTree,
              slug: "linked-parent-plan",
              files: ["linked-output/victim.txt"],
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
    assert.match(result.stderr + result.stdout, /outside the working directory/);
    assert.equal(await fsp.readFile(outsideVictim, "utf8"), "outside data\n");
    const branches = (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout.trim();
    assert.equal(branches, "");
    assert.equal(
      (await git(["branch", "--show-current"], repo)).stdout.trim(),
      "codex/linked-parent-plan",
    );
  });
});

testWithTempRoot(
  "finalizer makes source restoration and temporary cleanup failures blocking",
  "finalize-restore-failure-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const sourceBranch = "codex/restore-test";
    await git(["switch", "-c", sourceBranch], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "planned\n");
    await git(["commit", "-am", "planned value"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: finalTree });

    const hooks = path.join(root, "hooks");
    const postCommit = path.join(hooks, "post-commit");
    await writeFile(
      postCommit,
      `#!/bin/sh\ngit branch -D ${sourceBranch} >/dev/null 2>&1 || true\n`,
    );
    await fsp.chmod(postCommit, 0o755);
    await git(["config", "core.hooksPath", hooks.replace(/\\/g, "/")], repo);

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "restore-test",
          groups: [
            {
              title: "Planned value",
              body: "Force source restoration failure after branch creation.",
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
    const output = result.stderr + result.stdout;
    assert.notEqual(result.code, 0);
    assert.match(output, /Error code: FINALIZE_RECOVERY_FAILED/);
    assert.match(output, /Next step: Restore the source branch/);
    assert.match(output, /Source branch restoration failed|Verification state restoration failed/);
    assert.match(output, /git switch codex\/restore-test failed/);
    assert.match(output, /Temporary branch cleanup failed/);
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
    await writeCompleteFinalizationEvidenceFixture(repo, { targetCommit: head });

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
    assert.match(result.stderr, /Error code: FINALIZE_INVALID_LITERAL_PATH/);
    assert.match(result.stderr, /Next step: Fix the unsafe file path in groups\.json/);
    assert.match(result.stderr, /Unsafe finalizer file path/);
    assert.doesNotMatch(result.stderr, /overlapping groups|commit order/i);
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
    assert.match(metadataResult.stderr, /Error code: FINALIZE_INVALID_LITERAL_PATH/);
    assert.match(metadataResult.stderr, /Git metadata/);
    assert.equal(
      (await git(["config", "user.email"], repo)).stdout.trim(),
      "codex@example.invalid",
    );
    assert.equal(
      (await git(["branch", "--show-current"], repo)).stdout.trim(),
      "codex/autoresearch-path",
    );
  },
);
