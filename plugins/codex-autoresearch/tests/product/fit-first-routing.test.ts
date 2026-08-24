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

async function writeAcceptedSession(dir: string) {
  await mkdir(path.join(dir, "src", "checkout"), { recursive: true });
  await writeFile(path.join(dir, "evaluator.mjs"), 'console.log("METRIC seconds=1");\n', "utf8");
  await writeFile(path.join(dir, "checks.mjs"), "process.exit(0);\n", "utf8");
  const setup = await runCli([
    "setup",
    "--cwd",
    dir,
    "--name",
    completeLegacySession.name,
    "--goal",
    completeLegacySession.goal,
    "--metric-name",
    completeLegacySession.metricName,
    "--metric-unit",
    completeLegacySession.metricUnit,
    "--direction",
    "lower",
    "--benchmark-command",
    "node evaluator.mjs",
    "--checks-command",
    "node checks.mjs",
    "--scope",
    "src/checkout",
    "--commit-paths",
    "src/checkout",
    "--protected-benchmark-paths",
    "evaluator.mjs,checks.mjs",
    "--max-iterations",
    "5",
    "--packet-budget",
    "5",
  ]);
  assert.equal(setup.code, 0, setup.stderr);
  const configPath = path.join(dir, "autoresearch.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.checksAuthoritative = true;
  config.checkImplementationPaths = ["checks.mjs"];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const accepted = await runCli([
    "new-segment",
    "--cwd",
    dir,
    "--reason",
    "Accept the fit-routing fixture contract",
    "--yes",
  ]);
  assert.equal(accepted.code, 0, accepted.stderr);
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

test("prompt-plan keeps benchmark-label bugs direct", async () => {
  await withTempDir("fit-first-benchmark-label-bug", async (dir) => {
    const payload = await promptPlan(dir, "Fix the bug where benchmark runs omit the label.");

    assertAssistOnly(payload);
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

test("prompt-plan treats an uncounted repeated measured loop as incomplete", async () => {
  await withTempDir("fit-first-uncounted-loop", async (dir) => {
    const payload = await promptPlan(
      dir,
      "Run a repeated measured optimization loop for checkout latency.",
    );

    const fit = payload.fit as Record<string, unknown>;
    assert.equal(fit.disposition, "needs-user");
    assert.equal(fit.mode, null);
    assert.equal(fit.sessionRelation, "none");
    assert.deepEqual(fit.missing, [
      "benchmark_command",
      "metric_name",
      "direction",
      "checks_command",
      "scope",
      "max_iterations",
    ]);
  });
});

test("prompt-plan reuses only a verified accepted session as an in-memory loop candidate", async () => {
  await withTempDir("fit-first-matching", async (dir) => {
    await writeAcceptedSession(dir);
    const before = await directorySnapshot(dir);

    const payload = await promptPlan(
      dir,
      'Continue the active "Checkout performance" session for 5 repeated measured iterations.',
    );

    const fit = payload.fit as Record<string, unknown>;
    assert.equal(fit.disposition, "run-loop", JSON.stringify(fit));
    assert.equal(fit.mode, "full-loop");
    assert.equal(fit.sessionRelation, "matching");
    assert.deepEqual(fit.contract, {
      goal: completeLegacySession.goal,
      benchmarkCommand: "bash ./autoresearch.sh",
      metricName: completeLegacySession.metricName,
      metricUnit: completeLegacySession.metricUnit,
      direction: "lower",
      checksCommand: "bash ./autoresearch.checks.sh",
      filesInScope: completeLegacySession.filesInScope,
      commitPaths: completeLegacySession.filesInScope,
      maxIterations: 5,
    });
    assert.equal("setup" in payload, false);
    assert.deepEqual(await directorySnapshot(dir), before);
  });
});

test("prompt-plan matches named sessions only when the explicit metric unit agrees", async () => {
  await withTempDir("fit-first-metric-unit", async (dir) => {
    await writeAcceptedSession(dir);
    const before = await directorySnapshot(dir);
    const continuation = (metricUnit: string) =>
      [
        'Continue the active "Checkout performance" session for 5 repeated measured iterations.',
        `Goal: ${completeLegacySession.goal}`,
        "Benchmark: bash ./autoresearch.sh",
        `Metric: ${completeLegacySession.metricName} (${metricUnit}), lower is better`,
        "Checks: bash ./autoresearch.checks.sh",
        `Scope: ${completeLegacySession.filesInScope.join(",")}`,
      ].join("\n");

    const conflicting = await promptPlan(dir, continuation("ms"));
    const conflictFit = conflicting.fit as Record<string, unknown>;
    assert.equal(conflictFit.disposition, "needs-user", JSON.stringify(conflictFit));
    assert.equal(conflictFit.sessionRelation, "unrelated");
    assert.deepEqual(conflictFit.missing, []);
    assert.deepEqual(conflictFit.conflicts, [
      { field: "metric_unit", existing: "s", requested: "ms" },
    ]);
    assert.deepEqual(await directorySnapshot(dir), before);

    const matching = await promptPlan(dir, continuation("s"));
    const matchingFit = matching.fit as Record<string, unknown>;
    assert.equal(matchingFit.disposition, "run-loop", JSON.stringify(matchingFit));
    assert.equal(matchingFit.sessionRelation, "matching");
    assert.deepEqual(await directorySnapshot(dir), before);
  });
});

test("prompt-plan refuses named sessions when goal or checkout authority is unproven", async () => {
  await withTempDir("fit-first-hostile-match", async (dir) => {
    await writeAcceptedSession(dir);
    const before = await directorySnapshot(dir);
    const incompatibleGoal = await promptPlan(
      dir,
      'Continue the active "Checkout performance" session for 5 repeated measured iterations to optimize API throughput.',
    );
    const goalFit = incompatibleGoal.fit as Record<string, unknown>;
    assert.equal(goalFit.disposition, "needs-user");
    assert.equal(goalFit.sessionRelation, "unrelated");
    assert.equal(
      (goalFit.conflicts as Array<Record<string, unknown>>).some(
        (conflict) => conflict.field === "goal",
      ),
      true,
      JSON.stringify(goalFit),
    );
    assert.deepEqual(await directorySnapshot(dir), before);

    await writeFile(path.join(dir, "evaluator.mjs"), 'console.log("METRIC seconds=9");\n');
    const drifted = await promptPlan(
      dir,
      'Continue the active "Checkout performance" session for 5 repeated measured iterations.',
    );
    const driftFit = drifted.fit as Record<string, unknown>;
    assert.equal(driftFit.disposition, "needs-user");
    assert.equal(
      (driftFit.conflicts as Array<Record<string, unknown>>).some((conflict) =>
        String(conflict.field).includes("protected"),
      ),
      true,
      JSON.stringify(driftFit),
    );
  });
});

test("prompt-plan cannot match a copied accepted session in another checkout", async () => {
  await withTempDir("fit-first-origin", async (origin) => {
    await writeAcceptedSession(origin);
    await withTempDir("fit-first-copy", async (copy) => {
      await mkdir(path.join(copy, "src", "checkout"), { recursive: true });
      for (const file of [
        "autoresearch.config.json",
        "autoresearch.jsonl",
        "evaluator.mjs",
        "checks.mjs",
      ]) {
        await writeFile(path.join(copy, file), await readFile(path.join(origin, file)));
      }
      const before = await directorySnapshot(copy);
      const payload = await promptPlan(
        copy,
        'Continue the active "Checkout performance" session for 5 repeated measured iterations.',
      );
      const fit = payload.fit as Record<string, unknown>;
      assert.equal(fit.disposition, "needs-user");
      assert.equal(fit.sessionRelation, "unrelated");
      assert.equal((fit.conflicts as unknown[]).length > 0, true, JSON.stringify(fit));
      assert.deepEqual(await directorySnapshot(copy), before);
    });
  });
});

test("prompt-plan treats complete legacy metadata without accepted identity as unproven", async () => {
  await withTempDir("fit-first-unverified-legacy", async (dir) => {
    await writeLegacySession(dir);
    const before = await directorySnapshot(dir);
    const payload = await promptPlan(
      dir,
      'Continue the active "Checkout performance" session for 5 repeated measured iterations.',
    );
    const fit = payload.fit as Record<string, unknown>;
    assert.equal(fit.disposition, "needs-user");
    assert.equal(fit.sessionRelation, "unrelated");
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

test("prompt-plan does not treat a code replacement as session replacement", async () => {
  await withTempDir("fit-first-code-replacement", async (dir) => {
    await writeLegacySession(dir);
    const before = await directorySnapshot(dir);
    const payload = await promptPlan(
      dir,
      [
        "Replace the API parser while running 3 repeated measured optimization iterations.",
        "Benchmark: node scripts/api-benchmark.mjs",
        "Metric: requests_per_second, higher is better",
        "Checks: node --test tests/api.test.mjs",
        "Scope: src/api",
      ].join("\n"),
    );

    const fit = payload.fit as Record<string, unknown>;
    assert.equal(fit.disposition, "needs-user");
    assert.equal(fit.sessionRelation, "unrelated");
    assert.notEqual(fit.sessionRelation, "replacement-requested");
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
    assert.equal(fit.sessionRelation, "none");
  });
});
