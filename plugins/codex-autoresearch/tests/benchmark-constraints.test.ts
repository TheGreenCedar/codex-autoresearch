import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { evaluateSecondaryMetricConstraints } from "../lib/benchmark/multi-metric-constraints.js";
import { buildDashboardViewModel } from "../lib/dashboard-view-model.js";
import { appendJsonl } from "../lib/session-core.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import { createCliRunner, withTempDir } from "./helpers/process.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const runCli = createCliRunner(cli, pluginRoot);

test("secondary metric constraints compare packet metrics against baseline metrics", async () => {
  await withTempDir("autoresearch", "secondary-constraints-direct", async (dir) => {
    appendJsonl(dir, { type: "config", name: "constraints", metricName: "seconds" });
    appendJsonl(dir, {
      run: 1,
      metric: 1,
      status: "keep",
      description: "Baseline",
      metrics: { memory_mb: 100, coverage: 0.9 },
    });

    const evaluation = evaluateSecondaryMetricConstraints({
      config: {
        secondaryMetricConstraintMode: "blocking",
        secondaryMetricConstraints: ["memory_mb <= baseline * 1.05", "coverage >= baseline"],
      },
      state: {
        config: { metricName: "seconds" },
        current: [
          {
            run: 1,
            metric: 1,
            status: "keep",
            metrics: { memory_mb: 100, coverage: 0.9 },
          },
        ],
      },
      runMetrics: { seconds: 0.8, memory_mb: 110, coverage: 0.91 },
    });

    assert.equal(evaluation.configured, true);
    assert.equal(evaluation.status, "failed");
    assert.equal(evaluation.blockPromotion, true);
    assert.deepEqual(
      evaluation.results.map((result) => [result.metric, result.status]),
      [
        ["memory_mb", "failed"],
        ["coverage", "passed"],
      ],
    );
    assert.match(evaluation.messages.join("\n"), /memory_mb=110/);
  });
});

test("blocking secondary metric constraint keeps primary evidence but blocks promotion", async () => {
  await withTempDir("autoresearch", "secondary-constraints-cli", async (dir) => {
    await initConstraintLoop(dir, "constraint loop");

    await configureSecondaryConstraint(dir, "blocking", true);

    await writeMemoryMetrics(dir, "baseline-metrics.json", 100);
    const baseline = await logConstraintKeep(dir, {
      metric: "1",
      metricsFile: "baseline-metrics.json",
      description: "Baseline",
    });
    const baselinePayload = JSON.parse(baseline.stdout);
    assert.equal(baselinePayload.experiment.evidenceStatus, "accepted");
    assert.equal(baselinePayload.experiment.secondaryMetricConstraints.status, "passed");

    await writeMemoryMetrics(dir, "candidate-metrics.json", 110);
    const candidate = await logConstraintKeep(dir, {
      metric: "0.8",
      metricsFile: "candidate-metrics.json",
      description: "Primary improved but memory regressed",
    });
    const candidatePayload = JSON.parse(candidate.stdout);
    assert.equal(candidatePayload.experiment.metric, 0.8);
    assert.equal(candidatePayload.experiment.evidenceStatus, "provisional");
    assert.equal(candidatePayload.experiment.promotion.label, "blocked");
    assert.equal(candidatePayload.experiment.secondaryMetricConstraints.status, "failed");

    const stateResult = await runCli(["state", "--cwd", dir]);
    assert.equal(stateResult.code, 0, stateResult.stderr);
    const statePayload = JSON.parse(stateResult.stdout);
    assert.equal(statePayload.best, 1);
    assert.match(
      statePayload.researchIntegrity.blockers.join("\n"),
      /Secondary metric constraint failed/,
    );

    const viewModel = buildDashboardViewModel({
      state: {
        config: {
          name: "constraint loop",
          metricName: "seconds",
          metricUnit: "",
          bestDirection: "lower",
        },
        segment: 0,
        current: [baselinePayload.experiment, candidatePayload.experiment],
        baseline: 1,
        best: 1,
        confidence: null,
      },
      warnings: statePayload.warnings || [],
    });
    assert.equal(viewModel.trustState.status, "needs-attention");
    assert.match(viewModel.trustState.reasons.join("\n"), /memory_mb=110/);
  });
});

test("secondary metric constraint mode changes reclassify existing constraints", async () => {
  await withTempDir("autoresearch", "secondary-constraints-mode-transition", async (dir) => {
    await initConstraintLoop(dir, "constraint mode loop");

    await configureSecondaryConstraint(dir, "advisory", true);

    await writeMemoryMetrics(dir, "baseline-metrics.json", 100);
    await logConstraintKeep(dir, {
      metric: "1",
      metricsFile: "baseline-metrics.json",
      description: "Baseline",
    });

    await configureSecondaryConstraint(dir, "blocking", false);

    await writeMemoryMetrics(dir, "candidate-metrics.json", 110);
    const candidate = await logConstraintKeep(dir, {
      metric: "0.8",
      metricsFile: "candidate-metrics.json",
      description: "Primary improved after mode transition",
    });
    const candidatePayload = JSON.parse(candidate.stdout);
    assert.equal(candidatePayload.experiment.evidenceStatus, "provisional");
    assert.equal(candidatePayload.experiment.promotion.label, "blocked");
    assert.equal(candidatePayload.experiment.secondaryMetricConstraints.mode, "blocking");
    assert.equal(candidatePayload.experiment.secondaryMetricConstraints.blockPromotion, true);

    const stateResult = await runCli(["state", "--cwd", dir]);
    assert.equal(stateResult.code, 0, stateResult.stderr);
    const statePayload = JSON.parse(stateResult.stdout);
    assert.equal(statePayload.best, 1);
  });
});

async function initConstraintLoop(dir, name) {
  const init = await runCli(["init", "--cwd", dir, "--name", name, "--metric-name", "seconds"]);
  assert.equal(init.code, 0, init.stderr);
}

async function configureSecondaryConstraint(dir, mode, includeConstraint) {
  const args = ["config", "--cwd", dir];
  if (includeConstraint) {
    args.push("--secondary-metric-constraints", "memory_mb <= baseline * 1.05");
  }
  args.push("--secondary-metric-constraint-mode", mode);
  const config = await runCli(args);
  assert.equal(config.code, 0, config.stderr);
}

async function writeMemoryMetrics(dir, fileName, memoryMb) {
  await writeFile(path.join(dir, fileName), JSON.stringify({ memory_mb: memoryMb }));
}

async function logConstraintKeep(dir, { metric, metricsFile, description }) {
  const result = await runCli([
    "log",
    "--cwd",
    dir,
    "--metric",
    metric,
    "--metrics-file",
    metricsFile,
    "--status",
    "keep",
    "--description",
    description,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result;
}
