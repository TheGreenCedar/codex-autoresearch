import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolvePackageRoot } from "../lib/runtime-paths.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const benchmarkSource = path.join(pluginRoot, "scripts", "perfection-benchmark.ts");
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("perfection benchmark reports zero quality gaps for the local plugin", async () => {
  assert.ok(benchmarkSource.endsWith("perfection-benchmark.ts"));
  const result = await runBenchmark(["--fail-on-gap"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /METRIC quality_gap=0/);
  const checks = result.stdout.match(/METRIC quality_checks=(\d+)/)?.[1];
  const passed = result.stdout.match(/METRIC quality_passed=(\d+)/)?.[1];
  assert.ok(checks, result.stdout);
  assert.equal(passed, checks);
});

test("compact read command paths use loadSessionState cache-aware loading", async () => {
  const source = await readFile(path.join(pluginRoot, "scripts", "autoresearch.ts"), "utf8");
  const cliHandlers = await readFile(path.join(pluginRoot, "lib", "cli-handlers.ts"), "utf8");
  for (const functionName of [
    "setupPlan",
    "guidedSetup",
    "onboardingPacket",
    "recommendNext",
    "publicState",
  ]) {
    const body = extractFunctionBody(source, functionName);
    const directStateLoads = (body.match(/\bcurrentState\(/g) || []).length;
    const cachedStateLoads = (body.match(/\bloadSessionState\(/g) || []).length;
    assert.equal(directStateLoads, 0, `${functionName} should use loadSessionState cache helper`);
    assert.ok(
      cachedStateLoads <= 1,
      `${functionName} should call loadSessionState at most once per command path`,
    );
  }
  assert.match(cliHandlers, /createSessionReadCache/);
  assert.match(`${source}\n${cliHandlers}`, /\breadCache\b/);
});

test("dashboard orchestration reuses already-loaded ledger records", async () => {
  const source = await readFile(path.join(pluginRoot, "scripts", "autoresearch.ts"), "utf8");
  const dashboardBody = extractFunctionBody(source, "dashboardViewModel");
  const orchestrationBody = extractFunctionBody(source, "buildParallelOrchestrationContext");

  assert.match(dashboardBody, /\brecords\s*=\s*loadSessionRecords\(workDir,\s*readCache\)/);
  assert.match(dashboardBody, /buildParallelOrchestrationContext\(\{[\s\S]*\brecords,/);
  assert.doesNotMatch(orchestrationBody, /\breadJsonl\(/);
  assert.match(orchestrationBody, /latestLaneResults\(workDir,\s*state\.segment,\s*records\)/);
  assert.match(orchestrationBody, /resolveFanoutForSegment\([\s\S]*records[\s\S]*\)/);
});

function extractFunctionBody(source, functionName) {
  const signature = new RegExp(`(?:async\\s+)?function ${functionName}\\b`);
  const match = signature.exec(source);
  assert.ok(match, `Missing function ${functionName}`);
  const openBrace = findFunctionBodyOpenBrace(source, match.index);
  assert.notEqual(openBrace, -1, `Missing body for ${functionName}`);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  assert.fail(`Unclosed body for ${functionName}`);
}

function findFunctionBodyOpenBrace(source, startIndex) {
  let parenDepth = 0;
  let enteredParameters = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") {
      enteredParameters = true;
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth -= 1;
    } else if (char === "{" && enteredParameters && parenDepth === 0) {
      return index;
    }
  }
  return -1;
}
