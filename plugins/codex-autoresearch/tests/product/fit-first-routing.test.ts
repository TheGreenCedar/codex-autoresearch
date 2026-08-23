import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCli, withTempDir } from "./helpers.js";

const completeLegacySession = {
  name: "Checkout performance",
  goal: "Reduce checkout latency without changing payment behavior.",
  metricName: "seconds",
  metricUnit: "s",
  bestDirection: "lower",
  benchmarkCommand: "node scripts/checkout-benchmark.mjs",
  checksCommand: "node --test tests/checkout.test.mjs",
  filesInScope: ["src/checkout"],
  commitPaths: ["src/checkout"],
};

async function promptPlan(dir: string, prompt: string) {
  const result = await runCli(["prompt-plan", "--cwd", dir, "--prompt", prompt]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function writeLegacySession(dir: string) {
  await writeFile(
    path.join(dir, "autoresearch.config.json"),
    `${JSON.stringify(completeLegacySession, null, 2)}\n`,
    "utf8",
  );
}

async function directorySnapshot(dir: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};

  async function visit(absolute: string) {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const target = path.join(absolute, entry.name);
      const relative = path.relative(dir, target).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        entries[`${relative}/`] = "directory";
        await visit(target);
      } else if (entry.isFile()) {
        entries[relative] = createHash("sha256")
          .update(await readFile(target))
          .digest("hex");
      }
    }
  }

  await visit(dir);
  return entries;
}

function assertAssistOnly(payload: Record<string, unknown>) {
  const fit = payload.fit as Record<string, unknown>;
  assert.equal(fit.disposition, "continue-direct");
  assert.equal(fit.mode, "assist-only");
  assert.ok(["none", "matching", "unrelated"].includes(String(fit.sessionRelation)));
  assert.equal("intent" in payload, false);
  assert.equal("setup" in payload, false);

  const capsule = payload.directEvidence as Record<string, unknown>;
  assert.deepEqual(Object.keys(capsule).sort(), [
    "cheapestDiscriminatingEvidence",
    "claimBoundary",
    "directAction",
    "mainUncertainty",
    "outcome",
    "verification",
  ]);
  assert.equal("benchmarkCommand" in capsule, false);
  assert.equal("metricName" in capsule, false);
  assert.equal("filesInScope" in capsule, false);
  assert.equal("sessionName" in capsule, false);
  assert.equal("retrievalConstraint" in capsule, false);
}

test("prompt-plan returns architecture and product reviews directly without discovery or setup", async () => {
  await withTempDir("fit-first-direct", async (dir) => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), "{ this is deliberately invalid JSON", "utf8");
    await writeFile(
      path.join(dir, "docs", "autoresearch-benchmark.md"),
      "Benchmark hints that direct planning must not read.\n",
      "utf8",
    );
    const before = await directorySnapshot(dir);

    const architecture = await promptPlan(
      dir,
      "Review this architecture for failure modes and recommend the highest-leverage change.",
    );
    assertAssistOnly(architecture);

    const product = await promptPlan(
      dir,
      "Review this product flow for confusing steps and give me the smallest useful product recommendation.",
    );
    assertAssistOnly(product);

    assert.deepEqual(await directorySnapshot(dir), before);
  });
});

test("prompt-plan keeps one-off bugs and research outside a loop without inventing retrieval", async () => {
  await withTempDir("fit-first-direct-language", async (dir) => {
    const bug = await promptPlan(
      dir,
      "Fix the one-off bug where checkout totals round incorrectly.",
    );
    assertAssistOnly(bug);

    const research = await promptPlan(
      dir,
      "Research the documentation information architecture and summarize the strongest evidence.",
    );
    assertAssistOnly(research);
    assert.doesNotMatch(JSON.stringify(research), /retrieval_constraint/i);
  });
});

test("prompt-plan asks for the exact missing fields of an explicit incomplete repeated loop", async () => {
  await withTempDir("fit-first-incomplete", async (dir) => {
    const payload = await promptPlan(
      dir,
      [
        "Run 5 repeated measured optimization iterations for checkout latency.",
        "Benchmark: node scripts/checkout-benchmark.mjs",
        "Metric: seconds",
      ].join("\n"),
    );

    const fit = payload.fit as Record<string, unknown>;
    assert.equal(fit.disposition, "needs-user");
    assert.equal(fit.mode, null);
    assert.equal(fit.sessionRelation, "none");
    assert.deepEqual(fit.missing, ["direction", "checks_command", "scope"]);
    assert.deepEqual(fit.conflicts, []);
  });
});

test("prompt-plan reuses only a complete matching legacy session as an in-memory loop candidate", async () => {
  await withTempDir("fit-first-matching", async (dir) => {
    await writeLegacySession(dir);
    const before = await directorySnapshot(dir);

    const payload = await promptPlan(
      dir,
      'Continue the active "Checkout performance" session for 5 repeated measured iterations.',
    );

    const fit = payload.fit as Record<string, unknown>;
    assert.equal(fit.disposition, "run-loop");
    assert.equal(fit.mode, "full-loop");
    assert.equal(fit.sessionRelation, "matching");
    assert.deepEqual(fit.contract, {
      goal: completeLegacySession.goal,
      benchmarkCommand: completeLegacySession.benchmarkCommand,
      metricName: completeLegacySession.metricName,
      metricUnit: completeLegacySession.metricUnit,
      direction: "lower",
      checksCommand: completeLegacySession.checksCommand,
      filesInScope: completeLegacySession.filesInScope,
      commitPaths: completeLegacySession.commitPaths,
      maxIterations: 5,
    });
    assert.equal("setup" in payload, false);
    assert.deepEqual(await directorySnapshot(dir), before);
  });
});

test("prompt-plan preserves an unrelated active session until replacement is explicit", async () => {
  await withTempDir("fit-first-unrelated", async (dir) => {
    await writeLegacySession(dir);
    const before = await directorySnapshot(dir);
    const completeDifferentLoop = [
      "Run 3 repeated measured optimization iterations for API throughput.",
      "Benchmark: node scripts/api-benchmark.mjs",
      "Metric: requests_per_second, higher is better",
      "Checks: node --test tests/api.test.mjs",
      "Scope: src/api",
    ].join("\n");

    const unrelated = await promptPlan(dir, completeDifferentLoop);
    const unrelatedFit = unrelated.fit as Record<string, unknown>;
    assert.equal(unrelatedFit.disposition, "needs-user");
    assert.equal(unrelatedFit.sessionRelation, "unrelated");
    assert.deepEqual(await directorySnapshot(dir), before);

    const unaddressedMatch = await promptPlan(
      dir,
      [
        "Run 3 repeated measured optimization iterations for checkout latency.",
        `Benchmark: ${completeLegacySession.benchmarkCommand}`,
        "Metric: seconds, lower is better",
        `Checks: ${completeLegacySession.checksCommand}`,
        "Scope: src/checkout",
      ].join("\n"),
    );
    const unaddressedFit = unaddressedMatch.fit as Record<string, unknown>;
    assert.equal(unaddressedFit.disposition, "needs-user");
    assert.equal(unaddressedFit.sessionRelation, "unrelated");

    const namedConflict = await promptPlan(
      dir,
      `Continue the active "Checkout performance" session.\n${completeDifferentLoop}`,
    );
    const namedConflictFit = namedConflict.fit as Record<string, unknown>;
    assert.equal(namedConflictFit.disposition, "needs-user");
    assert.equal(namedConflictFit.sessionRelation, "unrelated");

    const replacement = await promptPlan(
      dir,
      `Replace the active session and start a new session.\n${completeDifferentLoop}`,
    );
    const replacementFit = replacement.fit as Record<string, unknown>;
    assert.equal(replacementFit.disposition, "run-loop");
    assert.equal(replacementFit.mode, "full-loop");
    assert.equal(replacementFit.sessionRelation, "replacement-requested");
    assert.equal(
      (replacementFit.contract as Record<string, unknown>).metricName,
      "requests_per_second",
    );
    assert.deepEqual(await directorySnapshot(dir), before);
  });
});

test("prompt-plan never treats incomplete session metadata as matching", async () => {
  await withTempDir("fit-first-unknown-session", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ name: "Checkout performance" }),
      "utf8",
    );

    const payload = await promptPlan(
      dir,
      'Continue the "Checkout performance" session by reviewing its architecture.',
    );
    const fit = payload.fit as Record<string, unknown>;
    assert.equal(fit.disposition, "continue-direct");
    assert.equal(fit.sessionRelation, "unrelated");
  });
});
