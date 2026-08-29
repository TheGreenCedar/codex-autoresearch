import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderExportedDashboard } from "../helpers/dashboard-export.js";
import { cliPayload } from "../helpers/cli-session.js";
import { quoteForAcceptedShell, quoteForRunShell } from "../helpers/process.js";

import { runCli, withTempDir, git, setupFixture } from "../helpers/cli-test-context.js";

const contractChecksCommand = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
const contractEvaluatorCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC metric=1')"`;

async function writeCompleteContractConfig(dir: string, overrides: Record<string, unknown> = {}) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "autoresearch.config.json"),
    `${JSON.stringify(
      {
        benchmarkCommand: contractEvaluatorCommand,
        checksCommand: contractChecksCommand,
        commitPaths: ["src"],
        editableScope: ["src"],
        maxIterations: 5,
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function appendLegacyLedgerRows(dir: string, rows: Record<string, unknown>[]) {
  const ledgerPath = path.join(dir, "autoresearch.jsonl");
  const ledger = await readFile(ledgerPath, "utf8");
  await writeFile(
    ledgerPath,
    `${ledger}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

test("state and doctor surface scaffold health and evidence labels", async () => {
  await withTempDir("truth-layer-state", async (dir) => {
    await setupFixture(dir, {
      name: "truth layer",
      metricName: "score",
      direction: "higher",
    });
    await writeCompleteContractConfig(dir, {
      benchmarkCommand: `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC score=1')"`,
      commitPaths: ["src/missing.ts"],
      editableScope: ["src/missing.ts"],
    });
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept the scaffold-health fixture contract",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);
    await writeFile(
      path.join(dir, "autoresearch.ps1"),
      "& powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1\n",
      "utf8",
    );
    await writeFile(path.join(dir, "autoresearch.sh"), "bash ./autoresearch.sh\n", "utf8");

    await appendLegacyLedgerRows(dir, [
      {
        run: 1,
        metric: 1,
        metrics: { repeatRequired: 1 },
        status: "keep",
        description: "perfect dev slice pending repeat",
      },
    ]);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.scaffoldHealth.ok, false);
    assert.ok(
      payload.scaffoldHealth.checks.some((check) => check.code === "self_recursive_wrapper"),
    );
    assert.ok(payload.scaffoldHealth.checks.some((check) => check.code === "missing_commit_path"));
    assert.ok(payload.researchIntegrity.evidenceLabels.includes("dev_best"));
    assert.ok(payload.researchIntegrity.evidenceLabels.includes("pending_repeat"));
    assert.doesNotMatch(payload.researchIntegrity.warnings.join("\n"), /perfect/i);
    assert.match(payload.researchIntegrity.warnings.join("\n"), /pending repeat/i);

    const doctor = await runCli(["doctor", "--cwd", dir, "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.scaffoldHealth.ok, false);
    assert.match(doctorPayload.warnings.join("\n"), /self-recursive|commitPaths/i);

    const compact = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    const plan = compactPayload.decisionPlanProjection;
    assert.equal(plan.action.kind, "repair-contract-conflict");
    assert.equal(plan.primaryBlockerCode, "legacy-contract-conflict");
    assert.equal(plan.capabilities["run-packet"], "blocked");
    assert.equal(plan.capabilities["authorize-keep"], "blocked");
    assert.equal(plan.loopDisposition.kind, "blocked");
    assert.ok(plan.requiredEvidence.diagnosticCodes.includes("scaffold-invalid"));
    assert.ok(plan.requiredEvidence.diagnosticCodes.includes("legacy-contract-conflict"));
  });
});

test("scaffold health catches direct PowerShell wrapper self-recursion", async () => {
  await withTempDir("powershell-direct-self-recursion", async (dir) => {
    await setupFixture(dir, { name: "powershell recursion", metricName: "score" });
    await writeFile(path.join(dir, "autoresearch.ps1"), "& .\\autoresearch.ps1\n", "utf8");

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.scaffoldHealth.ok, false);
    assert.ok(
      payload.scaffoldHealth.checks.some((check) => check.code === "self_recursive_wrapper"),
    );
  });
});

test("benchmark-lint separates metric parsing from research integrity", async () => {
  await withTempDir("benchmark-lint-integrity", async (dir) => {
    await setupFixture(dir, { name: "lint integrity", metricName: "score", direction: "higher" });

    const result = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--metric-name",
      "score",
      "--sample",
      "METRIC score=1\nMETRIC hit_at_10=1\n",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metricParsing.ok, true);
    assert.equal(payload.researchIntegrity.ok, false);
    assert.match(payload.researchIntegrity.warnings.join("\n"), /perfect|holdout|repeat/i);
  });
});

test("benchmark-lint uses config benchmark command without wrapper fallback", async () => {
  await withTempDir("benchmark-lint-config-command", async (dir) => {
    await setupFixture(dir, {
      name: "lint config command",
      metricName: "score",
      direction: "higher",
    });
    const benchmarkCommand = `${quoteForRunShell(process.execPath)} -e "console.log('METRIC score=7')"`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ benchmarkCommand }, null, 2),
      "utf8",
    );

    const result = await runCli(["benchmark-lint", "--cwd", dir, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.parsedMetrics.score, 7);
    assert.equal(payload.checkedCommand, benchmarkCommand);
  });
});

test("benchmark-lint sample respects configured holdout guard", async () => {
  await withTempDir("benchmark-lint-configured-holdout", async (dir) => {
    await setupFixture(dir, {
      name: "configured holdout",
      metricName: "agent_value_gap",
      direction: "lower",
    });
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ holdoutCommand: "node holdout-benchmark.mjs" }, null, 2),
      "utf8",
    );

    const result = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--sample",
      "METRIC agent_value_gap=0",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.researchIntegrity.hasIntegrityGuard, true);
    assert.doesNotMatch(
      payload.researchIntegrity.warnings.join("\n"),
      /no holdout, repeat, contamination, or promotion guard is configured/i,
    );
  });
});

test("doctor does not treat routine rollback wording as evidence invalidation", async () => {
  await withTempDir("doctor-routine-rollback", async (dir) => {
    await setupFixture(dir, { name: "routine rollback", metricName: "score", direction: "higher" });
    if (process.platform === "win32") {
      await writeFile(path.join(dir, "autoresearch.ps1"), "Write-Output 'METRIC score=1'\n");
    } else {
      await writeFile(path.join(dir, "autoresearch.sh"), "echo 'METRIC score=1'\n");
    }
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "kept candidate",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0.9",
      "--status",
      "discard",
      "--description",
      "ordinary rejected packet",
      "--asi",
      JSON.stringify({ rollback_reason: "reverted scoped experiment changes" }),
    ]);

    const doctor = await runCli(["doctor", "--cwd", dir, "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.researchIntegrity.blockers, []);
    assert.ok(!payload.researchIntegrity.evidenceLabels.includes("invalidated"));
  });
});

test("prompt-plan returns direct work before reading documented benchmark hints", async () => {
  await withTempDir("prompt-plan-doc-hints", async (dir) => {
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(
      path.join(dir, "Cargo.toml"),
      [
        "[package]",
        'name = "prompt-plan-doc-hints"',
        'version = "0.1.0"',
        'edition = "2021"',
        "",
        "[dev-dependencies]",
        'criterion = "0.5"',
        "",
        "[[bench]]",
        'name = "generic_bench"',
        "harness = false",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(dir, "scripts", "embedding-harness.mjs"),
      "console.log('repo-specific embedding harness');\n",
      "utf8",
    );
    await writeFile(
      path.join(dir, "docs", "autoresearch-benchmark.md"),
      [
        "# Autoresearch benchmark",
        "",
        "Use `node scripts/embedding-harness.mjs --holdout fresh` for the measured loop.",
        "The harness prints `METRIC embedding_score=<number>` from the fresh embedding holdout.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Optimize the embedding pipeline runtime using the project benchmark.",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.fit.disposition, "continue-direct");
    assert.equal("intent" in payload, false);
  });
});

test("prompt-plan does not invent a retrieval constraint for direct speed work", async () => {
  await withTempDir("prompt-plan-retrieval-quality", async (dir) => {
    const result = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Speed up large-codebase semantic retrieval with lazy search",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const serialized = JSON.stringify(payload);

    assert.equal(payload.fit.disposition, "continue-direct");
    assert.doesNotMatch(serialized, /retrieval_constraint/i);
  });
});

test("run notes append inside the managed ledger block", async () => {
  await withTempDir("managed-ledger", async (dir) => {
    await setupFixture(dir, { name: "ledger" });
    await writeFile(
      path.join(dir, "autoresearch.md"),
      "# Session\n\n## Guardrails\nKeep this section stable.\n",
      "utf8",
    );
    for (const metric of ["3", "2"]) {
      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--metric",
        metric,
        "--status",
        "measure",
        "--description",
        `Run ${metric}`,
      ]);
      assert.equal(logged.code, 0, logged.stderr);
    }
    const note = await readFile(path.join(dir, "autoresearch.md"), "utf8");
    assert.match(note, /## Run Ledger/);
    assert.equal((note.match(/AUTORESEARCH_RUN_LEDGER:START/g) || []).length, 1);
    assert.match(note, /Run 1 measure: Run 3[\s\S]+Run 2 measure: Run 2/);
    assert.match(note, /## Guardrails\nKeep this section stable\.\n\n## Run Ledger/);
  });
});

test("benchmark contract changes block the next packet until a new segment", async () => {
  await withTempDir("contract-drift", async (dir) => {
    await setupFixture(dir, { name: "contract", metricName: "score", direction: "higher" });
    await writeFile(
      path.join(dir, "packet.cmd"),
      "node -e \"console.log('METRIC score=1')\"",
      "utf8",
    );
    const benchmarkCommand = await readFile(path.join(dir, "packet.cmd"), "utf8");
    await writeCompleteContractConfig(dir, {
      benchmarkCommand,
      protectedBenchmarkPaths: ["packet.cmd"],
    });
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      benchmarkCommand,
      "--reason",
      "Accept the command-file benchmark contract",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);

    const packet = await runCli(["next", "--cwd", dir, "--command-file", "packet.cmd"]);
    assert.equal(packet.code, 0, packet.stderr);
    assert.ok(JSON.parse(packet.stdout).run, packet.stdout);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Baseline contract",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    await writeCompleteContractConfig(dir, {
      benchmarkCommand,
      maxIterations: 8,
      protectedBenchmarkPaths: ["packet.cmd"],
    });
    const blocked = await runCli(["next", "--cwd", dir, "--command-file", "packet.cmd"]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /accepted.*packet|new segment/i);
  });
});

test("new segment rebaselines benchmark contract drift for changed benchmark surface", async () => {
  await withTempDir("segment-contract-rebaseline", async (dir) => {
    const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} benchmark.mjs`;
    await setupFixture(dir, {
      name: "contract rebaseline",
      metricName: "score",
      direction: "higher",
    });
    await writeFile(path.join(dir, "bench-a.txt"), "protected A\n", "utf8");
    await writeFile(
      path.join(dir, "benchmark.mjs"),
      "import { readFileSync } from 'node:fs';\nconsole.log(`METRIC score=${readFileSync('score.txt', 'utf8').trim()}`);\n",
      "utf8",
    );
    await writeFile(path.join(dir, "score.txt"), "1\n", "utf8");
    await writeCompleteContractConfig(dir, {
      benchmarkCommand,
      protectedBenchmarkPaths: ["bench-a.txt"],
    });
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      benchmarkCommand,
      "--reason",
      "Accept the initial benchmark surface",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);

    const packet = await runCli(["next", "--cwd", dir, "--command", benchmarkCommand]);
    assert.equal(packet.code, 0, packet.stderr);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Baseline contract",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    await writeFile(path.join(dir, "bench-b.txt"), "protected B\n", "utf8");
    await writeFile(path.join(dir, "score.txt"), "2\n", "utf8");
    await writeCompleteContractConfig(dir, {
      benchmarkCommand,
      protectedBenchmarkPaths: ["bench-b.txt"],
    });
    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--benchmark-command",
      benchmarkCommand,
      "--reason",
      "new benchmark surface",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark", "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.benchmarkContract.ok, true);
    assert.equal(
      payload.warningDetails.some((warning: any) => warning?.code === "benchmark_contract_changed"),
      false,
    );
    assert.doesNotMatch(payload.issues.join("\n"), /benchmark.*drift/i);
  });
});

test("new segment warns when metric semantics change across segments", async () => {
  await withTempDir("segment-metric-semantics", async (dir) => {
    await setupFixture(dir, { name: "metric semantics", metricUnit: "s", direction: "lower" });
    await writeCompleteContractConfig(dir);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "measure",
      "--description",
      "Seconds baseline",
    ]);

    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--metric-name",
      "embedded_docs",
      "--metric-unit",
      "docs",
      "--direction",
      "higher",
      "--reason",
      "new semantic metric",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);
    const segmentPayload = cliPayload(JSON.parse(segment.stdout));
    assert.equal(segmentPayload.metricSemanticsWarning?.code, "metric_semantics_changed");

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = cliPayload(JSON.parse(state.stdout));
    assert.equal(statePayload.metricSemanticsWarning?.code, "metric_semantics_changed");

    const report = await runCli(["state", "--cwd", dir, "--report", "--compact"]);
    assert.equal(report.code, 0, report.stderr);
    const reportPayload = cliPayload(JSON.parse(report.stdout));
    const reportCompact = (reportPayload.compactState as Record<string, unknown>) || reportPayload;
    assert.equal(reportCompact.metricSemanticsWarning?.code, "metric_semantics_changed");
  });
});

test("new segment honors explicit lower direction after a higher segment", async () => {
  await withTempDir("segment-direction-lower", async (dir) => {
    await setupFixture(dir, { name: "direction flip", metricName: "score", direction: "higher" });
    await writeCompleteContractConfig(dir);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "measure",
      "--description",
      "Higher baseline",
    ]);

    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--metric-name",
      "latency",
      "--direction",
      "lower",
      "--reason",
      "switch to latency",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);
    const payload = cliPayload(JSON.parse(segment.stdout));
    assert.equal(payload.entry.bestDirection, "lower");
    assert.equal(payload.metricSemanticsWarning?.code, "metric_semantics_changed");
  });
});

test("new segment does not treat its own ledger append as dirty source drift", async () => {
  await withTempDir("segment-self-dirty", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await setupFixture(dir, { name: "segment" });
    await writeCompleteContractConfig(dir, {
      commitPaths: ["src", "tracked.txt"],
      editableScope: ["src", "tracked.txt"],
    });
    const measurement = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "measure",
      "--description",
      "Initial segment measurement",
    ]);
    assert.equal(measurement.code, 0, measurement.stderr);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial session"]);

    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "fresh metric phase",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.segment, 1, segment.stdout);
    assert.equal(payload.sourceCleanliness.sourceDirty, false);
    assert.equal(payload.sourceCleanliness.status, "session-artifacts-dirty");
    assert.equal(payload.sourceCleanliness.sourceDirty, false);
    assert.equal(payload.sourceCleanliness.sessionArtifactDirty, true);
    assert.equal(payload.sourceCleanliness.cleanupCommand, "");
    assert.ok(
      payload.warningDetails.every((warning) => warning.code !== "git_dirty"),
      "session-only dirtiness should not be reported as source drift",
    );
    const report = await runCli(["state", "--cwd", dir, "--report"]);
    assert.equal(report.code, 0, report.stderr);
    const reportPayload = JSON.parse(report.stdout);
    assert.equal(reportPayload.report.json.cleanliness.status, "session-artifacts-dirty");
    assert.equal(reportPayload.report.json.cleanliness.cleanupCommand, "");
    assert.match(reportPayload.report.text, /Only Autoresearch session artifacts are dirty/);
    assert.doesNotMatch(reportPayload.report.text, /git stash push --include-untracked/);
    const doctor = await runCli(["doctor", "--cwd", dir, "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.doesNotMatch(doctorPayload.warnings.join("\n"), /Git worktree is dirty/);
    assert.ok(
      doctorPayload.warningDetails.every((warning) => warning.code !== "git_dirty"),
      "doctor should use the same session-only dirtiness filter as state",
    );

    await writeFile(path.join(dir, "tracked.txt"), "changed\n", "utf8");
    const dirty = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(dirty.code, 0, dirty.stderr);
    const dirtyPayload = JSON.parse(dirty.stdout);
    assert.equal(dirtyPayload.sourceCleanliness.sourceDirty, true);
    assert.ok(dirtyPayload.warningDetails.some((warning) => warning.code === "git_dirty"));

    const dirtyCompact = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(dirtyCompact.code, 0, dirtyCompact.stderr);
    const dirtyCompactPayload = JSON.parse(dirtyCompact.stdout);
    assert.equal(dirtyCompactPayload.sourceCleanliness.status, "source-dirty");
    assert.equal(dirtyCompactPayload.sourceCleanliness.cleanupCommand, "");
    const plan = dirtyCompactPayload.decisionPlanProjection;
    assert.equal(plan.action.kind, "review-dirty-source");
    assert.equal(plan.primaryBlockerCode, "dirty-source");
    assert.equal(plan.capabilities["run-packet"], "allowed");
    assert.equal(plan.capabilities["authorize-keep"], "blocked");
    assert.equal(plan.loopDisposition.kind, "continue");
    assert.ok(plan.requiredEvidence.diagnosticCodes.includes("dirty-source"));
    const dirtyDoctor = await runCli(["doctor", "--cwd", dir, "--json-full"]);
    assert.equal(dirtyDoctor.code, 0, dirtyDoctor.stderr);
    assert.equal(JSON.parse(dirtyDoctor.stdout).git.clean, false);
  });
});

test("state and recommend-next share watchdog canonical next-action parity", async () => {
  await withTempDir("watchdog-cli-parity", async (dir) => {
    await setupFixture(dir, { name: "watchdog parity", acceptedContract: true });
    await appendLegacyLedgerRows(dir, [
      { run: 1, metric: 10, status: "keep", description: "Baseline" },
      { run: 2, metric: 10, status: "discard", description: "No movement" },
    ]);

    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const oldMs = Date.now() - 10 * 60 * 60 * 1000;
    const lines = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const entry of lines) {
      if (entry.run != null) entry.timestamp = oldMs;
    }
    await writeFile(
      ledgerPath,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.watchdogSummary?.stale, true);
    assert.equal(statePayload.limitReached, false);
    const statePlan = statePayload.decisionPlanProjection;
    assert.notEqual(statePlan.action.kind, "watchdog");
    assert.equal(statePlan.capabilities["run-packet"], "allowed");

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    const recommendPlan = recommendPayload.decisionPlanProjection;
    assert.equal(recommendPlan.decisionId, statePlan.decisionId);
    assert.equal(recommendPlan.action.kind, statePlan.action.kind);
    assert.equal(recommendPlan.primaryBlockerCode, statePlan.primaryBlockerCode);
    assert.deepEqual(recommendPlan.capabilities, statePlan.capabilities);
    assert.deepEqual(recommendPlan.loopDisposition, statePlan.loopDisposition);
    assert.deepEqual(recommendPlan.parentDisposition, statePlan.parentDisposition);
    assert.deepEqual(
      recommendPlan.requiredEvidence.diagnosticCodes,
      statePlan.requiredEvidence.diagnosticCodes,
    );
  });
});

test("dashboard includes segment controls and visual-aid layout", async () => {
  await withTempDir("dashboard-cockpit", async (dir) => {
    await setupFixture(dir, { name: "first segment" });
    await appendLegacyLedgerRows(dir, [
      { run: 1, metric: 4, status: "keep", description: "Baseline" },
    ]);
    await setupFixture(dir, { name: "second segment" });
    await appendLegacyLedgerRows(dir, [
      { run: 2, metric: 3, status: "keep", description: "Second baseline" },
    ]);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const doc = dom.window.document;
    const rendered = doc.body.innerHTML;

    assert.ok(doc.getElementById("segment-navigator"));
    const segmentSelect = doc.getElementById("segment-select") as HTMLSelectElement | null;
    assert.ok(segmentSelect);
    assert.equal(segmentSelect.options.length, 2);
    assert.match(segmentSelect.options[0].textContent || "", /S1 - first segment/);
    assert.match(segmentSelect.options[1].textContent || "", /S2 - second segment/);
    assert.ok(doc.getElementById("live-toggle"));
    assert.doesNotMatch(dashboard, /id="command-grid"/);
    assert.match(doc.body.textContent, /Run log/);
    assert.ok(doc.getElementById("ledger-scroll"));
    assert.match(doc.body.textContent, /Codex brief/);
    assert.ok(doc.getElementById("ai-summary-title"));
    assert.equal(doc.getElementById("mission-control-grid") === null, true);
    assert.equal(doc.getElementById("run-log-decision") === null, true);
    assert.equal(doc.getElementById("research-truth-meter") === null, true);
    assert.equal(doc.getElementById("strategy-memory") === null, true);
    assert.equal(doc.getElementById("trust-strip") === null, true);
    assert.match(dashboard, /__AUTORESEARCH_META__/);
    assert.doesNotMatch(dashboard, /clipboard\?\.writeText/);
    assert.doesNotMatch(dashboard, /autoresearch\.mjs/);
    assert.match(doc.body.textContent, /Finalize/);
    assert.ok(rendered.indexOf('id="decision-rail"') < rendered.indexOf('id="trend-panel"'));
    assert.ok(rendered.indexOf('id="decision-rail"') < rendered.indexOf('id="codex-brief"'));
    assert.ok(rendered.indexOf('id="decision-rail"') < rendered.indexOf('id="ledger"'));
    assert.ok(rendered.indexOf('id="trend-panel"') < rendered.indexOf('id="ledger"'));
    dom.window.close();
  });
});
