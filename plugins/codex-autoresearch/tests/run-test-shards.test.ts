import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProcess } from "./helpers/process.js";

test("test shards retry only a timed-out range once and report the exact range", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoresearch-shard-retry-"));
  const fixture = path.join(process.cwd(), "tests", "fixtures", "shard-timeout-once.mjs");
  const marker = path.join(dir, "timed-out-once");
  try {
    const runner = path.join(process.cwd(), "dist", "scripts", "run-test-shards.mjs");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = await runProcess(process.execPath, [runner, "--jobs", "2", fixture, "2"], {
      cwd: process.cwd(),
      env: {
        ...env,
        CODEX_AUTORESEARCH_TEST_SHARD_TIMEOUT_SECONDS: "1",
        SHARD_RETRY_MARKER: marker,
      },
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stdout,
      /RETRY timed-out range .*shard-timeout-once\.mjs 0:1 \(1-1\) serially/,
    );
    assert.equal((result.stdout.match(/RETRY timed-out range/g) || []).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
