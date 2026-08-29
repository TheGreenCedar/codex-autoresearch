import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit, createSetupFixture, quoteForAcceptedShell } from "./process.js";

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
  const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "const fs=require('node:fs');console.log('METRIC seconds='+(fs.existsSync('src/kept.txt')?0:1))"`;
  const checksPath = path.join(dir, "contract", "checks.mjs");
  const checksCommand = `${quoteForAcceptedShell(process.execPath)} contract/checks.mjs`;
  await runGit(dir, ["init"]);
  await writeFile(path.join(dir, "base.txt"), "base\n", "utf8");
  await runGit(dir, ["add", "base.txt"]);
  await runGit(dir, ["commit", "-m", "base"]);
  await runGit(dir, ["branch", "-M", "main"]);
  await runGit(dir, ["checkout", "-b", "feature"]);
  await mkdir(path.dirname(checksPath), { recursive: true });
  await writeFile(checksPath, "process.exit(0);\n", "utf8");
  await setupFixture(dir, {
    name: "current tree finalization",
    acceptedContract: true,
    benchmarkCommand,
    checksCommand,
    scope: "src",
  });
  const configPath = path.join(dir, "autoresearch.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.checkImplementationPaths = ["contract/checks.mjs"];
  config.checksAuthoritative = true;
  config.noiseModel = { kind: "deterministic" };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-m", "init autoresearch"]);

  const acceptedSegment = await runCli([
    "new-segment",
    "--cwd",
    dir,
    "--reason",
    "Accept committed fixture preconditions",
    "--yes",
  ]);
  assert.equal(acceptedSegment.code, 0, acceptedSegment.stderr);

  const baseline = await runCli(["next", "--cwd", dir]);
  assert.equal(baseline.code, 0, baseline.stderr);
  const baselineLog = await runCli([
    "log",
    "--cwd",
    dir,
    "--from-last",
    "--status",
    "measure",
    "--description",
    "Accepted baseline",
  ]);
  assert.equal(baselineLog.code, 0, baselineLog.stderr);

  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "kept.txt"), "kept\n", "utf8");
  const candidate = await runCli(["next", "--cwd", dir]);
  assert.equal(candidate.code, 0, candidate.stderr);
  const candidatePayload = JSON.parse(candidate.stdout);
  assert.equal(
    typeof candidatePayload.lastRunPath,
    "string",
    `accepted candidate did not produce a packet: ${candidate.stdout}`,
  );
  const capturedCandidate = JSON.parse(
    await readFile(String(candidatePayload.lastRunPath), "utf8"),
  );
  assert.equal(
    capturedCandidate.decision.allowedStatuses.includes("keep"),
    true,
    "accepted candidate should satisfy authoritative checks and deterministic noise",
  );
  const keep = await runCli([
    "log",
    "--cwd",
    dir,
    "--from-last",
    "--status",
    "keep",
    "--description",
    "Keep accepted candidate",
  ]);
  assert.equal(keep.code, 0, keep.stderr);

  await writeFile(path.join(dir, "src", "unlogged.txt"), "support\n", "utf8");
  await runGit(dir, ["add", "src/unlogged.txt"]);
  await runGit(dir, ["commit", "-m", "unlogged support change"]);
  const currentTreeContract = await runCli([
    "new-segment",
    "--cwd",
    dir,
    "--reason",
    "Accept evaluator authority at the unlogged current tree",
    "--yes",
  ]);
  assert.equal(currentTreeContract.code, 0, currentTreeContract.stderr);
}
