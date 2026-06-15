import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolvePackageRoot } from "../lib/runtime-paths.js";
import {
  findLooseObjectCompatibilityOffenders,
  findSourceHygieneOffenders,
  formatSourceHygieneOffenders,
  type SourceFileSnapshot,
} from "../lib/cli/source-hygiene.js";
import { runCheckMain } from "../scripts/check.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const checkScript = path.join(pluginRoot, "scripts", "check.mjs");

test("source hygiene flags generated roots and package-local session artifacts precisely", () => {
  const offenders = findSourceHygieneOffenders(
    [
      ".agents/plugins/marketplace.json",
      ".codex/environments/environment.toml",
      ".codex-plugin/plugin.json",
      ".github/workflows/release.yml",
      "docs/superpowers/plans/2026-06-04-autoresearch-review-remediation.md",
      "plugins/codex-autoresearch/.codex-plugin/plugin.json",
      "plugins/codex-autoresearch/autoresearch.jsonl",
      "plugins/codex-autoresearch/autoresearch-dashboard.html",
      "plugins/codex-autoresearch/autoresearch.research/sprint/synthesis.md",
      "plugins/codex-autoresearch/docs/operate.md",
      "plugins/codex-autoresearch/examples/demo-session/autoresearch.last-run.json",
      "plugins/codex-autoresearch/examples/demo-session/autoresearch.jsonl",
      "plugins/codex-autoresearch/examples/demo-session/autoresearch.ps1",
      "plugins/codex-autoresearch/examples/demo-session/cache/packet.json",
      "plugins/codex-autoresearch/examples/demo-session/outputs/report.json",
      "plugins/codex-autoresearch/examples/demo-session/tmp/packet.json",
    ],
    { packageRoot: "plugins/codex-autoresearch" },
  );

  assert.deepEqual(
    offenders.map((offender) => offender.path),
    [
      "docs/superpowers/plans/2026-06-04-autoresearch-review-remediation.md",
      "plugins/codex-autoresearch/autoresearch-dashboard.html",
      "plugins/codex-autoresearch/autoresearch.jsonl",
      "plugins/codex-autoresearch/autoresearch.research/sprint/synthesis.md",
      "plugins/codex-autoresearch/examples/demo-session/autoresearch.last-run.json",
      "plugins/codex-autoresearch/examples/demo-session/cache/packet.json",
      "plugins/codex-autoresearch/examples/demo-session/outputs/report.json",
      "plugins/codex-autoresearch/examples/demo-session/tmp/packet.json",
    ],
  );
  assert.match(offenders[0].reason, /generated superpowers plan/i);
  assert.match(
    offenders.find((offender) => offender.path.includes("/tmp/"))?.reason || "",
    /temporary folder/i,
  );
});

test("source hygiene normalizes tracked paths and reports actionable output", () => {
  const offenders = findSourceHygieneOffenders(
    [
      "outputs\\debug.log",
      "plugins\\codex-autoresearch\\tmp\\packet.json",
      "plugins/codex-autoresearch/.codex-plugin/plugin.json",
    ],
    { packageRoot: "plugins/codex-autoresearch" },
  );

  assert.deepEqual(
    offenders.map((offender) => offender.path),
    ["outputs/debug.log", "plugins/codex-autoresearch/tmp/packet.json"],
  );

  const report = formatSourceHygieneOffenders(offenders);
  assert.match(report, /outputs\/debug\.log/);
  assert.match(report, /plugins\/codex-autoresearch\/tmp\/packet\.json/);
  assert.match(report, /git rm --cached|move it outside the tracked source/i);
});

test("source hygiene forbids new local LooseObject any aliases outside allowlist", () => {
  const forbiddenAlias = `type LooseObject = Record<string, ${"any"}>;\n`;
  const offenders = findLooseObjectCompatibilityOffenders([
    {
      path: "plugins/codex-autoresearch/lib/new-boundary.ts",
      content: forbiddenAlias,
    },
    {
      path: "plugins/codex-autoresearch/lib/session-core.ts",
      content: forbiddenAlias,
    },
    {
      path: "plugins/codex-autoresearch/lib/types/json.ts",
      content: "export type UnknownRecord = Record<string, unknown>;\n",
    },
  ]);

  assert.deepEqual(offenders, [
    {
      path: "plugins/codex-autoresearch/lib/new-boundary.ts",
      reason: "new local LooseObject compatibility alias; use UnknownRecord from lib/types/json.js",
    },
  ]);
});

test("public docs and plugin metadata keep customer-facing autoresearch wording", () => {
  const repoRoot = path.resolve(pluginRoot, "..", "..");
  const readRepoFile = (relativePath: string) =>
    readFileSync(path.join(repoRoot, relativePath), "utf8");
  const readme = readRepoFile("README.md");
  const changelog = readRepoFile("CHANGELOG.md");
  const packageJson = JSON.parse(readRepoFile("plugins/codex-autoresearch/package.json"));
  const pluginJson = JSON.parse(
    readRepoFile("plugins/codex-autoresearch/.codex-plugin/plugin.json"),
  );
  const currentChangelogEntry =
    changelog.match(/## 2\.3\.5 - 2026-06-15[\s\S]*?(?=\n## 2\.3\.4 - 2026-06-15)/)?.[0] ?? "";

  const publicCopy = [
    readme,
    packageJson.description,
    pluginJson.description,
    pluginJson.interface.shortDescription,
    pluginJson.interface.longDescription,
    currentChangelogEntry,
  ].join("\n");

  assert.match(readme, /bounded benchmark experiments/);
  assert.match(readme, /local evidence trail/);
  assert.match(readme, /context-resumable state/);
  assert.match(readme, /reviewable branch previews/);
  assert.match(readme, /marketplace remove` removes the source marketplace registration/);
  assert.match(readme, /Prefer the plugin UI for installed-plugin refresh\/uninstall actions/);
  assert.equal(
    packageJson.description,
    "Codex plugin for bounded, measured benchmark and optimization loops.",
  );
  assert.match(pluginJson.description, /Measured Codex loops/);
  assert.match(pluginJson.description, /local evidence/);
  assert.match(pluginJson.description, /reviewable branch previews/);
  assert.match(pluginJson.interface.longDescription, /benchmark output/);
  assert.match(pluginJson.interface.longDescription, /local evidence/);
  assert.match(pluginJson.interface.longDescription, /read-only live readout/);
  assert.match(pluginJson.interface.longDescription, /after user approval/);
  assert.match(currentChangelogEntry, /experiment outcomes|run outcomes/);

  assert.doesNotMatch(publicCopy, /logs keep, discard, measure, crash, and checks_failed/i);
  assert.doesNotMatch(publicCopy, /log decisions/i);
  assert.doesNotMatch(publicCopy, /keep\/discard\/measure\/crash\/checks_failed/i);
  assert.doesNotMatch(publicCopy, /\bASI\b/);
  assert.doesNotMatch(publicCopy, /promotion labels/i);
  assert.doesNotMatch(publicCopy, /one skill surface/i);
  assert.doesNotMatch(publicCopy, /packet outcomes/i);
  assert.doesNotMatch(
    publicCopy,
    /Run at most 5 packets|running one measured packet|fresh packet state|run one measured packet|A packet is one measured experiment cycle/i,
  );
});

test("check phase selection succeeds for clean injected source hygiene only", async () => {
  const result = await runCheckMainCaptured(
    ["--phase", "source-hygiene"],
    [
      ".agents/plugins/marketplace.json",
      ".codex/environments/environment.toml",
      ".github/workflows/release.yml",
      "plugins/codex-autoresearch/.codex-plugin/plugin.json",
      "plugins/codex-autoresearch/examples/demo-session/autoresearch.jsonl",
    ],
    [
      {
        path: "plugins/codex-autoresearch/lib/clean-boundary.ts",
        content: "import type { UnknownRecord } from './types/json.js';\n",
      },
    ],
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /== source hygiene ==/);
  assert.match(result.stdout, /ok source-hygiene/);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /== (syntax|dashboard|dashboard parity|demo trust|source checkout|dogfood|product|package) ==/,
  );
});

test("check --phase without a value fails usage before default phases", async () => {
  const result = await runCheck(["--phase"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.code, 0);
  assert.match(output, /Missing value for --phase/);
  assert.doesNotMatch(
    output,
    /== (syntax|source hygiene|dashboard|dashboard parity|demo trust|source checkout|dogfood|product|package) ==/,
  );
});

test("check unknown phase still fails usage before default phases", async () => {
  const result = await runCheck(["--phase", "not-a-phase"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.code, 0);
  assert.match(output, /Unknown check phase: not-a-phase/);
  assert.doesNotMatch(
    output,
    /== (syntax|source hygiene|dashboard|dashboard parity|demo trust|source checkout|dogfood|product|package) ==/,
  );
});

function runCheck(
  args: string[],
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [checkScript, ...args], {
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
    child.on("error", (error) => {
      stderr += String(error?.message || error);
      resolve({ code: -1, stdout, stderr });
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runCheckMainCaptured(
  args: string[],
  sourceHygieneTrackedPaths: string[],
  sourceHygieneSourceFiles: SourceFileSnapshot[] = [],
): Promise<{ code: number; stderr: string; stdout: string }> {
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (...values: unknown[]) => {
    stdout += `${formatConsoleValues(values)}\n`;
  };
  console.error = (...values: unknown[]) => {
    stderr += `${formatConsoleValues(values)}\n`;
  };

  try {
    const code = await runCheckMain(args, {
      sourceHygieneSourceFiles,
      sourceHygieneTrackedPaths,
    });
    return { code, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function formatConsoleValues(values: readonly unknown[]): string {
  return values.map((value) => String(value)).join(" ");
}
