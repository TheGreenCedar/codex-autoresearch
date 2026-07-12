import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCli, withTempDir, git, setupFixture } from "../helpers/cli-test-context.js";

test("keep commits can be scoped to experiment paths", async () => {
  await withTempDir("scoped-commit", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "scoped commit" });
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, "scratch.txt"), "do not commit\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Scope the keep commit",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const committed = await git(dir, ["show", "--name-only", "--format=", "HEAD"]);
    assert.match(committed, /tracked\.txt/);
    assert.doesNotMatch(committed, /scratch\.txt/);

    const status = await git(dir, ["status", "--short"]);
    assert.match(status, /\?\? scratch\.txt/);
  });
});

test("keep logs require scoped commit paths or explicit add-all in git repos", async () => {
  await withTempDir("keep-add-all-gate", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "add all gate" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked keep",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /commitPaths is empty/);
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);

    const allowed = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Allow broad keep",
      "--allow-add-all",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(JSON.parse(allowed.stdout).git, /explicit add-all/);
  });
});

test("keep logs preflight missing commit paths before git add mutates the index", async () => {
  await withTempDir("missing-commit-path-preflight", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "missing path" });
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: ["docs/testing/research-data-catalog.md"] }, null, 2),
      "utf8",
    );
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked missing path",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /Configured commitPaths do not exist before git add/);
    assert.doesNotMatch(blocked.stderr, /pathspec/);
    assert.equal(await git(dir, ["diff", "--cached", "--name-only"]), "");
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);
  });
});

test("keep logs reject Git pathspec magic in commit paths", async () => {
  await withTempDir("commit-path-pathspec-magic", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "a.txt"), "before\n", "utf8");
    await writeFile(path.join(dir, "b.txt"), "before\n", "utf8");
    await git(dir, ["add", "a.txt", "b.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "pathspec commit" });
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: [":(top)"] }, null, 2),
      "utf8",
    );
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "a.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, "b.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked pathspec keep",
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /pathspec magic/);
    assert.equal(await git(dir, ["diff", "--cached", "--name-only"]), "");
    assert.match(await git(dir, ["status", "--short"]), /M a\.txt/);
    assert.match(await git(dir, ["status", "--short"]), /M b\.txt/);
  });
});

test("discard cleanup rejects Git pathspec magic in revert paths", async () => {
  await withTempDir("revert-path-pathspec-magic", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "a.txt"), "before\n", "utf8");
    await writeFile(path.join(dir, "b.txt"), "before\n", "utf8");
    await git(dir, ["add", "a.txt", "b.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "pathspec revert" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "a.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, "b.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "discard",
      "--description",
      "Blocked pathspec discard",
      "--revert-paths",
      ":(top)",
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /pathspec magic/);
    assert.match(await git(dir, ["status", "--short"]), /M a\.txt/);
    assert.match(await git(dir, ["status", "--short"]), /M b\.txt/);
  });
});

test("discard preservation rejects linked Autoresearch-owned directories", async (t) => {
  await withTempDir("discard-linked-owned-dir", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    await setupFixture(dir, { name: "linked preserve" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "victim.txt"), "outside\n");
    try {
      await symlink(
        outside,
        path.join(dir, "autoresearch.research"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      t.skip(`directory links are unavailable: ${String(error)}`);
      await rm(outside, { recursive: true, force: true });
      return;
    }
    try {
      await writeFile(path.join(dir, "tracked.txt"), "after\n");
      const result = await runCli([
        "log",
        "--cwd",
        dir,
        "--metric",
        "1",
        "--status",
        "discard",
        "--description",
        "Reject linked preservation",
        "--allow-dirty-revert",
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /symlink|junction/);
      assert.equal(await readFile(path.join(outside, "victim.txt"), "utf8"), "outside\n");
    } finally {
      await unlink(path.join(dir, "autoresearch.research")).catch(() => {});
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("keep logs allow tracked deletions in commit paths", async () => {
  await withTempDir("tracked-deletion-commit-path", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "delete tracked" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await rm(path.join(dir, "tracked.txt"));

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Delete tracked file",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const latestCommit = JSON.parse(logged.stdout).experiment.commit;
    assert.match(latestCommit, /^[0-9a-f]{7,12}$/);
    assert.match(
      await git(dir, ["show", "--name-status", "--format=", "HEAD"]),
      /D\s+tracked\.txt/,
    );
  });
});

test("scoped keep commits preserve unrelated staged files", async () => {
  await withTempDir("scoped-keep-preserves-index", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "scoped.txt"), "before\n");
    await writeFile(path.join(dir, "unrelated.txt"), "before\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);
    const initialized = await setupFixture(dir, { name: "scoped keep" });
    assert.equal(initialized.code, 0, initialized.stderr);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    await writeFile(path.join(dir, "scoped.txt"), "after\n");
    await writeFile(path.join(dir, "unrelated.txt"), "staged elsewhere\n");
    await git(dir, ["add", "unrelated.txt"]);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Commit only the scoped file",
      "--commit-paths",
      "scoped.txt",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    assert.equal(await git(dir, ["show", "--format=", "--name-only", "HEAD"]), "scoped.txt");
    assert.equal(await git(dir, ["diff", "--cached", "--name-only"]), "unrelated.txt");
  });
});

test("Git scope options reject wildcard pathspec characters", async () => {
  await withTempDir("wildcard-pathspec-rejection", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "file.txt"), "before\n");
    await git(dir, ["add", "file.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    await setupFixture(dir, { name: "wildcards" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "file.txt"), "after\n");
    for (const [option, value] of [
      ["--commit-paths", "*.txt"],
      ["--commit-paths", "file?.txt"],
      ["--revert-paths", "src/[ab].txt"],
    ]) {
      const result = await runCli([
        "log",
        "--cwd",
        dir,
        "--metric",
        "1",
        "--status",
        option === "--revert-paths" ? "discard" : "keep",
        "--description",
        "Reject wildcard pathspec",
        option,
        value,
      ]);
      assert.notEqual(result.code, 0, `${option} ${value}`);
      assert.match(result.stderr, /literal project-relative paths|wildcard/i);
    }
  });
});

test("keep logs report structured git index lock recovery", async () => {
  await withTempDir("git-index-lock", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "lock" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, ".git", "index.lock"), "stale lock\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked lock",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /Git index lock blocked git add/);
    assert.match(blocked.stderr, /Live git process check/);
    assert.match(blocked.stderr, /has not staged or committed anything/);
  });
});

test("logged packets do not leave .git autoresearch runtime dirs as stale artifacts", async () => {
  await withTempDir("git-runtime-dir-not-stale", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "runtime dir" });
    await writeFile(
      path.join(dir, "packet.command"),
      "node -e \"console.log('METRIC seconds=1')\"\n",
      "utf8",
    );
    await git(dir, ["add", "autoresearch.jsonl", "packet.command"]);
    await git(dir, ["commit", "-m", "session"]);

    const packet = await runCli(["next", "--cwd", dir, "--command-file", "packet.command"]);
    assert.equal(packet.code, 0, packet.stderr);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Record clean packet",
      "--allow-add-all",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    await access(path.join(dir, ".git", "autoresearch"));
    const worktreeStatus = await git(dir, ["status", "--porcelain=v1", "-uall"]);
    const committedPaths = await git(dir, ["show", "--name-only", "--format=", "HEAD"]);
    assert.doesNotMatch(worktreeStatus, /autoresearch-mutation\.lock|\.recovery-/);
    assert.doesNotMatch(committedPaths, /autoresearch-mutation\.lock|\.recovery-/);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const warningCodes = JSON.parse(state.stdout).warningDetails.map((warning) => warning.code);
    assert.ok(!warningCodes.includes("stale_benchmark_artifacts"));
  });
});

test("Git-private state accepts a repository reached through a canonicalized ancestor", async (t) => {
  await withTempDir("git-private-aliased-root", async (dir) => {
    const realParent = path.join(dir, "real");
    const realRepo = path.join(realParent, "repo");
    const aliasParent = path.join(dir, "alias");
    await mkdir(realRepo, { recursive: true });
    try {
      await symlink(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`directory links are unavailable: ${String(error)}`);
      return;
    }
    const aliasedRepo = path.join(aliasParent, "repo");
    await git(aliasedRepo, ["init"]);
    await writeFile(path.join(aliasedRepo, "tracked.txt"), "base\n", "utf8");
    await git(aliasedRepo, ["add", "tracked.txt"]);
    await git(aliasedRepo, ["commit", "-m", "initial"]);

    const initialized = await setupFixture(aliasedRepo, { name: "aliased Git-private state" });
    assert.equal(initialized.code, 0, initialized.stderr);
    await writeFile(
      path.join(aliasedRepo, "packet.command"),
      "node -e \"console.log('METRIC seconds=1')\"\n",
      "utf8",
    );
    const packet = await runCli(["next", "--cwd", aliasedRepo, "--command-file", "packet.command"]);
    assert.equal(packet.code, 0, packet.stderr);
    await access(path.join(realRepo, ".git", "autoresearch", "last-run.json"));
    const logged = await runCli([
      "log",
      "--cwd",
      aliasedRepo,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Record packet through aliased repository path",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    assert.match(
      await readFile(path.join(realRepo, "autoresearch.jsonl"), "utf8"),
      /Record packet through aliased repository path/,
    );
  });
});

test("keep logs can record an existing commit without staging dirty work", async () => {
  await withTempDir("keep-existing-commit", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "existing commit" });
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "manual experiment"]);
    const manualCommit = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(path.join(dir, "scratch.txt"), "leave dirty\n", "utf8");

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Record existing commit",
      "--commit",
      manualCommit,
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const payload = JSON.parse(logged.stdout);
    assert.equal(payload.experiment.commit, manualCommit.slice(0, 12));
    assert.match(payload.git, /recorded existing commit/);
    assert.match(await git(dir, ["status", "--short"]), /\?\? autoresearch\.jsonl/);
    assert.match(await git(dir, ["status", "--short"]), /\?\? scratch\.txt/);
  });
});

test("doctor and dashboard stay quiet about empty commit paths until keep logging needs them", async () => {
  await withTempDir("empty-commit-path-warning", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "warning" });
    const doctor = await runCli(["doctor", "--cwd", dir, "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.ok(
      !doctorPayload.warningDetails.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.ok(
      !statePayload.warningDetails.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    assert.ok(
      !exportPayload.viewModel.warnings.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );
  });
});

test("dashboard export decision envelope carries dirty source drift", async () => {
  await withTempDir("dashboard-dirty-envelope", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "dirty dashboard" });
    await writeFile(path.join(dir, "tracked.txt"), "changed\n", "utf8");

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const payload = JSON.parse(exported.stdout);
    assert.equal(payload.viewModel.decisionEnvelope.dirtySourceDrift.dirty, true);
    assert.ok(
      payload.viewModel.decisionEnvelope.dirtySourceDrift.warnings.some(
        (warning) => warning.code === "git_dirty",
      ),
    );
  });
});

test("export treats missing keep commits as finalization backlog instead of trust warnings", async () => {
  await withTempDir("missing-keep-commit-preview", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "preview quiet" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await git(dir, ["branch", "-M", "main"]);
    await git(dir, ["checkout", "-b", "experiment"]);

    const sessionLog = [
      JSON.stringify({
        type: "config",
        name: "preview quiet",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        metric: 10,
        status: "keep",
        description: "Keep baseline without commit metadata",
        timestamp: Date.now(),
        segment: 0,
        confidence: 1,
        asi: {
          evidence: "seconds=10",
          next_action_hint: "Confirm correctness before review packaging.",
        },
      }),
      "",
    ].join("\n");
    await writeFile(path.join(dir, "autoresearch.jsonl"), sessionLog, "utf8");
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "keep without commit metadata"]);

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    const trustReasons = exportPayload.viewModel.trustState.reasons.join("\n");
    assert.doesNotMatch(trustReasons, /has no commit/i);
    const previewPacket = exportPayload.viewModel.finalizationChecklist.find(
      (item) => item.label === "Preview packet",
    );
    assert.equal(previewPacket.state, "idle");
    assert.match(previewPacket.detail, /commit-backed keep logs/i);
  });
});

test("keep logs fail instead of recording success when git add fails", async () => {
  await withTempDir("keep-add-failure", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "git add failure" });
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Should not be logged",
      "--commit-paths",
      "missing.txt",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Configured commitPaths do not exist before git add/);

    const log = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(log, /Should not be logged/);
  });
});

test("keep logs fail instead of recording success when git commit fails", async () => {
  await withTempDir("keep-commit-failure", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["config", "core.hooksPath", ".git/hooks"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(hookPath, 0o755);

    await setupFixture(dir, { name: "commit failure" });
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Should not commit",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Git commit failed/);

    const log = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(log, /Should not commit/);
  });
});

test("discard reverts scoped experiment paths without deleting unrelated dirty work", async () => {
  await withTempDir("safe-discard", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "value.txt"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "safe discard" });
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: ["src"] }, null, 2),
    );
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);

    await writeFile(path.join(dir, "src", "value.txt"), "experiment\n", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "unrelated dirty work\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "discard",
      "--description",
      "Discard scoped experiment",
    ]);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await readFile(path.join(dir, "src", "value.txt"), "utf8"), "base\n");
    assert.equal(await readFile(path.join(dir, "notes.txt"), "utf8"), "unrelated dirty work\n");
  });
});

test("crash and checks_failed logs clean configured experiment paths only", async () => {
  for (const status of ["crash", "checks_failed"] as const) {
    await withTempDir(`safe-${status}-cleanup`, async (dir) => {
      await git(dir, ["init"]);
      await git(dir, ["config", "user.email", "codex@example.test"]);
      await git(dir, ["config", "user.name", "Codex Test"]);
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "value.txt"), "base\n", "utf8");
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-m", "initial"]);

      await setupFixture(dir, { name: `${status} cleanup` });
      await writeFile(
        path.join(dir, "autoresearch.config.json"),
        JSON.stringify({ commitPaths: ["src"] }, null, 2),
      );
      await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
      await git(dir, ["commit", "-m", "session"]);

      await writeFile(path.join(dir, "src", "value.txt"), "experiment\n", "utf8");
      await writeFile(path.join(dir, "notes.txt"), "unrelated dirty work\n", "utf8");

      const args = [
        "log",
        "--cwd",
        dir,
        "--status",
        status,
        "--description",
        `Clean ${status} experiment`,
      ];
      if (status === "checks_failed") args.push("--metric", "2");
      const result = await runCli(args);
      assert.equal(result.code, 0, result.stderr);

      assert.equal(await readFile(path.join(dir, "src", "value.txt"), "utf8"), "base\n");
      assert.equal(await readFile(path.join(dir, "notes.txt"), "utf8"), "unrelated dirty work\n");
    });
  }
});

test("discard without scoped paths refuses to clean a dirty git tree", async () => {
  await withTempDir("unsafe-discard", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "unsafe discard" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "scratch.txt"), "unrelated\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "discard",
      "--description",
      "Unsafe discard",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Refusing broad discard cleanup/);
    assert.equal(await readFile(path.join(dir, "scratch.txt"), "utf8"), "unrelated\n");
  });
});
