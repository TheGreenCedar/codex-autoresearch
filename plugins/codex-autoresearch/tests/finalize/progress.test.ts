import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { cli, git, run, testWithTempRoot, writeFile } from "./helpers.js";

testWithTempRoot(
  "finalize-preview progress writes heartbeat lines to stderr without corrupting JSON stdout",
  "autoresearch-finalize-preview-progress-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/progress-preview"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept update"], repo);

    const result = await run(
      process.execPath,
      [cli, "finalize-preview", "--cwd", repo, "--progress"],
      repo,
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.match(result.stderr, /\[autoresearch:finalize-preview]/);
  },
);
