import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit, createSetupFixture } from "./process.js";

export async function writeDecisionCapsule(dir, slug, overrides = {}) {
  const capsuleDir = path.join(dir, "autoresearch.research", slug);
  await mkdir(capsuleDir, { recursive: true });
  const base = {
    schemaVersion: 1,
    kind: "session-decision-capsule",
    status: "active",
    enforcement: {
      mode: "hard-block",
      canRunNextPacket: false,
      allowBoundedNext: false,
      blocksFinalization: true,
      clearingCondition: "Run benchmark-lint successfully, then acknowledge the capsule.",
      commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd <project>",
      triggeredBy: ["sessionDecisionCapsule", "benchmarkContract"],
    },
    bottleneck: "Benchmark wrapper cannot prove the primary METRIC contract.",
    evidence: ["benchmark-lint timed out and parsed zero primary METRIC lines."],
    nextExperiment: "Repair benchmark-lint until the primary METRIC is emitted.",
    wrongNextActions: ["Do not run next or finalize while benchmark-lint is broken."],
    doNotRepeat: [],
    commandBudgetWarnings: [],
    generatedFrom: {
      compactions: 0,
      first: "2026-06-01T13:00:00.000Z",
      last: "2026-06-01T13:10:00.000Z",
      toolCounts: {},
      topCommandHeads: [],
    },
    importedAt: "2026-06-01T13:10:00.000Z",
  };
  await writeFile(
    path.join(capsuleDir, "decision-capsule.json"),
    JSON.stringify({ ...base, ...overrides }, null, 2),
  );
}

export async function prepareCurrentTreeFinalizationBlocker(dir, runCli) {
  const setupFixture = createSetupFixture();
  await runGit(dir, ["init"]);
  await writeFile(path.join(dir, "base.txt"), "base\n", "utf8");
  await runGit(dir, ["add", "base.txt"]);
  await runGit(dir, ["commit", "-m", "base"]);
  await runGit(dir, ["branch", "-M", "main"]);
  await runGit(dir, ["checkout", "-b", "feature"]);
  await writeFile(path.join(dir, "autoresearch.ps1"), "Write-Output 'METRIC seconds=1'\n", "utf8");
  await writeFile(path.join(dir, "autoresearch.checks.ps1"), "Write-Output 'test ok'\n", "utf8");
  await setupFixture(dir, { name: "current tree finalization" });
  await runGit(dir, ["add", "autoresearch.jsonl", "autoresearch.ps1", "autoresearch.checks.ps1"]);
  await runGit(dir, ["commit", "-m", "init autoresearch"]);

  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "kept.txt"), "kept\n", "utf8");
  await runGit(dir, ["add", "src/kept.txt"]);
  await runGit(dir, ["commit", "-m", "kept change"]);
  const keptCommit = (await runGit(dir, ["rev-parse", "HEAD"])).trim();
  const keep = await runCli([
    "log",
    "--cwd",
    dir,
    "--metric",
    "1",
    "--status",
    "keep",
    "--description",
    "Keep committed change",
    "--commit",
    keptCommit,
  ]);
  assert.equal(keep.code, 0, keep.stderr);
  await runGit(dir, ["add", "autoresearch.jsonl"]);
  await runGit(dir, ["commit", "-m", "log kept run"]);

  await writeFile(path.join(dir, "src", "unlogged.txt"), "support\n", "utf8");
  await runGit(dir, ["add", "src/unlogged.txt"]);
  await runGit(dir, ["commit", "-m", "unlogged support change"]);
}
