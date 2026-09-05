import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolveSessionPaths } from "../../lib/session-paths.js";
import { isAutoresearchSessionArtifact } from "../../lib/session-artifacts.js";
import { runCli, withTempDir } from "./helpers.js";

test("new session documents share a directory and retain existing execution paths", async () => {
  await withTempDir("session-documents", async (cwd) => {
    const setup = await runCli([
      "setup",
      "--cwd",
      cwd,
      "--name",
      "Compact documents",
      "--metric-name",
      "seconds",
    ]);
    assert.equal(setup.code, 0, setup.stderr);
    const paths = resolveSessionPaths({ workDir: cwd });
    assert.equal(path.dirname(paths.notesPath), path.join(cwd, ".autoresearch"));
    assert.equal(path.dirname(paths.ideasPath), path.join(cwd, ".autoresearch"));
    assert.match(await readFile(paths.notesPath, "utf8"), /Compact documents/);
    assert.equal(paths.ledgerPath, path.join(cwd, "autoresearch.jsonl"));
    assert.ok(paths.clearTargets.includes(paths.notesPath));
    assert.equal(
      isAutoresearchSessionArtifact(".autoresearch/autoresearch.md", "finalization"),
      true,
    );
  });
});

test("legacy documents remain authoritative and conflicting copies block", async () => {
  await withTempDir("legacy-documents", async (cwd) => {
    const legacy = path.join(cwd, "autoresearch.md");
    await writeFile(legacy, "Existing session notes");
    assert.equal(resolveSessionPaths({ workDir: cwd }).notesPath, legacy);
    await mkdir(path.join(cwd, ".autoresearch"));
    await writeFile(path.join(cwd, ".autoresearch", "autoresearch.md"), "Conflicting notes");
    assert.throws(() => resolveSessionPaths({ workDir: cwd }), /Conflicting session documents/);
    assert.equal(await readFile(legacy, "utf8"), "Existing session notes");
  });
});
