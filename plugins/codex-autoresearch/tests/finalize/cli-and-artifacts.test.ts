import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { finalizePreview } from "../../lib/finalize-preview.js";
import { isAutoresearchSessionArtifact } from "../../lib/session-artifacts.js";
import {
  AUTORESEARCH_DASHBOARD_FILE,
  AUTORESEARCH_SESSION_FILES,
} from "../../lib/session-paths.js";
import { cli, finalizer, git, pluginRoot, run, testWithTempRoot, writeFile } from "./helpers.js";

test("finalizer CLI validates aliases, booleans, unknown options, and debug stacks", async () => {
  const help = await run(process.execPath, [finalizer, "-h"], pluginRoot, true);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Finalize an autoresearch branch/);

  const aliases = await run(
    process.execPath,
    [finalizer, "plan", "--workingDir=repo path", "--collapseOverlap=false", "--help"],
    pluginRoot,
    true,
  );
  assert.equal(aliases.code, 0, aliases.stderr);

  for (const args of [
    ["--help", "plan"],
    ["--debug", "plan", "--help"],
  ]) {
    const leading = await run(process.execPath, [finalizer, ...args], pluginRoot, true);
    assert.equal(leading.code, 0, leading.stderr);
    assert.match(leading.stdout, /Finalize an autoresearch branch/);
  }

  for (const args of [
    ["plan", "--bogus"],
    ["plan", "--collapse-overlap=perhaps"],
    ["plan", "--collapse-overlap", "perhaps"],
    ["--collapse-overlap", "perhaps", "plan"],
  ]) {
    const result = await run(process.execPath, [finalizer, ...args], pluginRoot, true);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /\n\s+at\s/);
    assert.doesNotMatch(
      result.stderr,
      new RegExp(pluginRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    );
  }

  const debug = await run(
    process.execPath,
    [finalizer, "plan", "--bogus", "--debug"],
    pluginRoot,
    true,
  );
  assert.equal(debug.code, 1, debug.stderr);
  assert.match(debug.stderr, /\n\s+at\s/);

  const leadingDebug = await run(
    process.execPath,
    [finalizer, "--debug", "missing.groups.json"],
    pluginRoot,
    true,
  );
  assert.equal(leadingDebug.code, 1, leadingDebug.stderr);
  assert.match(leadingDebug.stderr, /\n\s+at\s/);

  for (const option of ["cwd", "output", "goal", "trunk"]) {
    const missingValue = await run(
      process.execPath,
      [finalizer, `--${option}`, "--debug", "plan"],
      pluginRoot,
      true,
    );
    assert.equal(missingValue.code, 1, missingValue.stderr);
    assert.match(missingValue.stderr, new RegExp(`${option}.*argument missing`, "i"));
    assert.match(missingValue.stderr, /\n\s+at\s/);
  }

  const debugThenMalformed = await run(
    process.execPath,
    [finalizer, "plan", "--bogus", "--debug=true", "--debug=perhaps"],
    pluginRoot,
    true,
  );
  assert.equal(debugThenMalformed.code, 1, debugThenMalformed.stderr);
  assert.match(debugThenMalformed.stderr, /\n\s+at\s/);
});

test("session artifact modes preserve finalization, dirty tree, and source checkout policy", () => {
  const cases: Array<[string, boolean, boolean, boolean]> = [
    ["autoresearch.jsonl", true, true, true],
    ["autoresearch-dashboard.html", true, true, true],
    ["autoresearch.research/study/quality-gaps.md", true, true, true],
    [".git/autoresearch-runtime/state.json", true, true, true],
    ["autoresearch-finalize/scratch.groups.json", true, true, true],
    [".gitattributes", false, false, false],
    ["src/autoresearch-dashboard.html", false, false, false],
    ["src/value.txt", false, false, false],
  ];
  for (const [file, finalization, dirtyTree, sourceCheckout] of cases) {
    assert.equal(
      isAutoresearchSessionArtifact(file, "finalization"),
      finalization,
      `${file} finalization`,
    );
    assert.equal(
      isAutoresearchSessionArtifact(file, "dirty-tree"),
      dirtyTree,
      `${file} dirty-tree`,
    );
    assert.equal(
      isAutoresearchSessionArtifact(file, "source-checkout"),
      sourceCheckout,
      `${file} source-checkout`,
    );
  }

  for (const file of [...AUTORESEARCH_SESSION_FILES, AUTORESEARCH_DASHBOARD_FILE]) {
    assert.equal(isAutoresearchSessionArtifact(file, "finalization"), true, `${file} constant`);
    assert.equal(isAutoresearchSessionArtifact(file, "dirty-tree"), true, `${file} dirty-tree`);
    assert.equal(
      isAutoresearchSessionArtifact(file, "source-checkout"),
      true,
      `${file} source-checkout`,
    );
  }
});

testWithTempRoot(
  "finalize-preview fails on corrupt autoresearch ledger",
  "autoresearch-finalize-preview-corrupt-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src.txt"), "initial\n");
    await git(["add", "src.txt"], repo);
    await git(["commit", "-m", "initial"], repo);
    await writeFile(path.join(repo, "autoresearch.jsonl"), "{ not json\n");

    await assert.rejects(
      () => finalizePreview({ cwd: repo, trunk: "main" }),
      /Corrupt autoresearch\.jsonl at line 1/,
    );

    const result = await run(
      process.execPath,
      [cli, "finalize-preview", "--cwd", repo, "--trunk", "main"],
      repo,
      true,
    );
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Corrupt autoresearch\.jsonl at line 1/);
  },
);

testWithTempRoot(
  "finalizer surfaces corrupt autoresearch.jsonl with an actionable error",
  "autoresearch-bad-jsonl-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "keep value change"], repo);

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "speed loop",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        "{ not valid json",
      ].join("\n") + "\n",
    );

    const output = path.join(root, "groups.json");
    const result = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "speed-loop"],
      repo,
      true,
    );
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Corrupt autoresearch\.jsonl at line 2/);
    assert.match(`${result.stdout}\n${result.stderr}`, /Fix autoresearch\.jsonl/i);
  },
);
