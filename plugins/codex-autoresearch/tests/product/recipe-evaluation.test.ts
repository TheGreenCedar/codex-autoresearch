import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getBuiltInRecipe } from "../../lib/recipes.js";

test("bundle recipe measures freshly built output and rejects missing, empty, or failed builds", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "autoresearch-bundle-"));
  try {
    const command = getBuiltInRecipe("bundle-size")!.benchmarkCommand;
    const run = () => spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: 30_000 });
    const build = async (source: string) => {
      await writeFile(path.join(cwd, "build.cjs"), source);
      await writeFile(
        path.join(cwd, "package.json"),
        JSON.stringify({ scripts: { build: "node build.cjs" } }),
      );
    };
    await build("process.exit(0)");
    let result = run();
    assert.notEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /METRIC bytes=/);
    await mkdir(path.join(cwd, "dist"));
    result = run();
    assert.notEqual(result.status, 0, result.stdout);
    await writeFile(path.join(cwd, "dist", "old.js"), "old");
    await build(
      "const fs=require('node:fs'); fs.rmSync('dist',{recursive:true}); fs.mkdirSync('dist'); fs.writeFileSync('dist/app.js','1234567')",
    );
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /METRIC bytes=7\b/);
    await build("process.exit(3)");
    result = run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /METRIC bytes=/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workload placeholders cannot report a successful measurement", () => {
  for (const id of ["memory-usage", "command-latency", "lighthouse-score", "custom"]) {
    const result = spawnSync(getBuiltInRecipe(id)!.benchmarkCommand, {
      shell: true,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, id);
    assert.doesNotMatch(result.stdout, /METRIC /, id);
  }
});

test("runtime recipes require independently supplied checks", () => {
  for (const id of [
    "node-test-runtime",
    "vitest-runtime",
    "cargo-test-runtime",
    "go-test-runtime",
    "pytest-runtime",
    "dotnet-test-runtime",
    "bundle-size",
    "typescript-compile-time",
  ]) {
    const recipe = getBuiltInRecipe(id)!;
    assert.equal(recipe.checksCommand, "", id);
    assert.equal(recipe.scope.includes("tests"), false, id);
  }
});
