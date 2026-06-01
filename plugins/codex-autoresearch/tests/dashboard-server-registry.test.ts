import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import {
  readServeRegistry,
  registryPathForWorkDir,
  summarizeServeRegistry,
  writeServeRegistry,
} from "../lib/dashboard-server-registry.js";
import { withTempDir } from "./helpers/process.js";

test("serve registry writes pid port cwd and version in git repos", async () => {
  await withTempDir("autoresearch", "serve-registry-git", async (dir) => {
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const registryPath = registryPathForWorkDir(dir);

    await writeServeRegistry(dir, {
      pid: process.pid,
      port: 60123,
      cwd: dir,
      startedAt: "2026-05-31T00:00:00.000Z",
      version: PLUGIN_VERSION,
      healthUrl: "http://127.0.0.1:60123/health",
    });

    const parsed = JSON.parse(await readFile(registryPath, "utf8"));
    assert.equal(registryPath, path.join(dir, ".git", "autoresearch", "serve-registry.json"));
    assert.equal(parsed.pid, process.pid);
    assert.equal(parsed.port, 60123);
    assert.equal(parsed.cwd, path.resolve(dir));
    assert.equal(parsed.version, PLUGIN_VERSION);
    assert.equal(parsed.healthUrl, "http://127.0.0.1:60123/health");
  });
});

test("serve registry falls back to runtime directory outside git", async () => {
  await withTempDir("autoresearch", "serve-registry-non-git", async (dir) => {
    const registryPath = registryPathForWorkDir(dir);

    await writeServeRegistry(dir, {
      pid: process.pid,
      port: 60124,
      cwd: dir,
      startedAt: "2026-05-31T00:00:00.000Z",
      version: PLUGIN_VERSION,
      healthUrl: "http://127.0.0.1:60124/health",
    });

    const record = await readServeRegistry(dir);
    assert.equal(
      registryPath,
      path.join(dir, "autoresearch.research", ".runtime", "serve-registry.json"),
    );
    assert.equal(record?.port, 60124);
  });
});

test("serve registry summary distinguishes same and different cwd", () => {
  const record = {
    pid: process.pid,
    port: 60125,
    cwd: "C:/work/current",
    startedAt: "2026-05-31T00:00:00.000Z",
    version: PLUGIN_VERSION,
    healthUrl: "http://127.0.0.1:60125/health",
  };

  const same = summarizeServeRegistry(record, {
    currentPid: process.pid,
    currentCwd: "C:/work/current",
  });
  const different = summarizeServeRegistry(record, {
    currentPid: process.pid,
    currentCwd: "C:/work/other",
  });

  assert.equal(same.stale, false);
  assert.equal(same.cwdRelation, "same-cwd");
  assert.equal(same.currentProcess, true);
  assert.equal(different.stale, true);
  assert.equal(different.cwdRelation, "different-cwd");
});
