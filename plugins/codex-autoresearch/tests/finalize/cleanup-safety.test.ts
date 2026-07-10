import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { finalizer, git, run, testWithTempRoot, withTempRoot, writeFile } from "./helpers.js";

testWithTempRoot(
  "finalizer rejects wildcard Git pathspecs in plan files",
  "autoresearch-finalize-pathspec-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "a.txt"), "base\n");
    await writeFile(path.join(repo, "b.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/pathspec-plan"], repo);
    await writeFile(path.join(repo, "a.txt"), "kept\n");
    await git(["commit", "-am", "keep a"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "pathspec-plan",
          groups: [
            {
              title: "Pathspec plan",
              body: "Should reject wildcard expansion.",
              last_commit: finalTree,
              slug: "pathspec-plan",
              files: ["*.txt"],
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
    assert.match(result.stderr + result.stdout, /literal.*wildcard|wildcard.*pathspec/i);
    const branches = (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout.trim();
    assert.equal(branches, "");
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
