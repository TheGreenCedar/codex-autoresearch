#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const node = process.execPath;

const syntaxChecks = [
  ["syntax:autoresearch", node, ["--check", "scripts/autoresearch.mjs"]],
  ["syntax:mcp", node, ["--check", "scripts/autoresearch-mcp.mjs"]],
  ["syntax:finalize", node, ["--check", "scripts/finalize-autoresearch.mjs"]],
  ["syntax:benchmark", node, ["--check", "scripts/perfection-benchmark.mjs"]],
  ["syntax:check", node, ["--check", "scripts/check.mjs"]],
];

const productChecks = [
  ["quality-gap", node, ["scripts/perfection-benchmark.mjs", "--fail-on-gap"]],
  ["help:autoresearch", node, ["scripts/autoresearch.mjs", "--help"]],
  ["help:finalize", node, ["scripts/finalize-autoresearch.mjs", "--help"]],
  ["tests", node, ["--test", "tests/*.test.mjs"]],
];

const dashboardBuildChecks = [
  ["build:dashboard", node, ["node_modules/vite/bin/vite.js", "build", "--config", "vite.dashboard.config.mjs", "--logLevel", "warn"]],
];

const dashboardAssets = [
  "assets/dashboard-build/dashboard-app.js",
  "assets/dashboard-build/dashboard-app.css",
];

const ok = await runPhase("syntax", syntaxChecks)
  && await runDashboardBuildWithParity()
  && await runPhase("product", productChecks);

process.exit(ok ? 0 : 1);

async function runPhase(name, commands) {
  console.log(`\n== ${name} ==`);
  const results = await Promise.all(commands.map(runCommand));
  for (const result of results) {
    const marker = result.code === 0 ? "ok" : "fail";
    console.log(`${marker} ${result.label}`);
    if (result.code !== 0 || process.env.CODEX_AUTORESEARCH_CHECK_VERBOSE === "1") {
      const output = `${result.stdout}${result.stderr}`.trim();
      if (output) console.log(indent(output));
    }
  }
  return results.every((result) => result.code === 0);
}

async function runDashboardBuildWithParity() {
  const before = await dashboardAssetHashes();
  const buildOk = await runPhase("dashboard", dashboardBuildChecks);
  if (!buildOk) return false;
  const after = await dashboardAssetHashes();
  const changed = dashboardAssets.filter((file) => before[file] !== after[file]);
  console.log("\n== dashboard parity ==");
  if (changed.length) {
    console.log("fail dashboard-asset-parity");
    console.log(indent(`Dashboard build changed generated assets:\n${changed.join("\n")}\nRun npm run build:dashboard and include the rebuilt assets.`));
    return false;
  }
  console.log("ok dashboard-asset-parity");
  return true;
}

async function dashboardAssetHashes() {
  const hashes = {};
  for (const file of dashboardAssets) {
    const bytes = await fsp.readFile(path.join(ROOT, file));
    hashes[file] = createHash("sha256").update(bytes).digest("hex");
  }
  return hashes;
}

function runCommand([label, command, args]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
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
    child.on("error", (error) => {
      resolve({ label, code: -1, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on("close", (code) => {
      resolve({ label, code, stdout, stderr });
    });
  });
}

function indent(text) {
  return text.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}
