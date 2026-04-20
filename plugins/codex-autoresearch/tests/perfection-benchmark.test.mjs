import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const benchmark = path.join(pluginRoot, "scripts", "perfection-benchmark.mjs");

function runBenchmark(args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [benchmark, ...args], {
      cwd: pluginRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("perfection benchmark reports zero quality gaps for the local plugin", async () => {
  const result = await runBenchmark(["--fail-on-gap"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /METRIC quality_gap=0/);
  const checks = result.stdout.match(/METRIC quality_checks=(\d+)/)?.[1];
  const passed = result.stdout.match(/METRIC quality_passed=(\d+)/)?.[1];
  assert.ok(checks, result.stdout);
  assert.equal(passed, checks);
});
