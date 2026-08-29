import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { evaluateSecondaryMetricConstraints } from "../lib/benchmark/multi-metric-constraints.js";
import { buildDashboardViewModel } from "../lib/dashboard-view-model.js";
import { evaluateGateQuality } from "../lib/gate-quality.js";
import { appendJsonl } from "../lib/session-core.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import {
  createCliRunner,
  withTempDir,
  createSetupFixture,
  quoteForAcceptedShell,
} from "./helpers/process.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const runCli = createCliRunner(cli, pluginRoot);
const setupFixture = createSetupFixture();

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
    await logConstraintMeasurement(dir, {
      metric: "2",
      metricsFile: "baseline-metrics.json",
      description: "Reference measurement",
    });
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
    await logConstraintMeasurement(dir, {
      metric: "2",
      metricsFile: "baseline-metrics.json",
      description: "Reference measurement",
    });
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

test("per-constraint blocking mode overrides advisory global mode", () => {
  const evaluation = evaluateSecondaryMetricConstraints({
    config: {
      secondaryMetricConstraintMode: "advisory",
      secondaryMetricConstraints: [
        {
          metric: "memory_mb",
          operator: "<=",
          threshold: { kind: "literal", value: 100 },
          mode: "blocking",
        },
      ],
    },
    state: {
      config: { metricName: "seconds" },
      current: [{ run: 1, metric: 1, status: "keep", metrics: { memory_mb: 90 } }],
    },
    runMetrics: { seconds: 0.8, memory_mb: 110 },
  });

  assert.equal(evaluation.mode, "advisory");
  assert.equal(evaluation.results[0].mode, "blocking");
  assert.equal(evaluation.results[0].status, "failed");
  assert.equal(evaluation.blockPromotion, true);
});

test("blank secondary metric values are unavailable instead of numeric zero", () => {
  const evaluation = evaluateSecondaryMetricConstraints({
    config: {
      secondaryMetricConstraintMode: "blocking",
      secondaryMetricConstraints: ["memory_mb <= baseline * 1.05"],
    },
    state: {
      config: { metricName: "seconds" },
      current: [{ run: 1, metric: 1, status: "keep", metrics: { memory_mb: 100 } }],
    },
    runMetrics: { seconds: 0.8, memory_mb: " " },
  });

  assert.equal(evaluation.status, "unavailable");
  assert.equal(evaluation.results[0].actual, null);
  assert.equal(evaluation.results[0].status, "unavailable");
  assert.equal(evaluation.blockPromotion, true);
});

test("retrieval performance goals warn when no quality gate is configured", () => {
  const summary = evaluateGateQuality({
    benchmarkCommand: "node scripts/retrieval-speed-benchmark.mjs",
    checksCommand: "",
    qualityConstraints: [
      {
        domain: "retrieval_quality",
        requiredBeforePromotion: true,
        guidance:
          "Add or identify recall/MRR/hit@k/ranking checks before treating speed wins as product-grade.",
      },
    ],
  });

  assert.equal(summary.posture, "missing");
  assert.ok(
    summary.warningDetails.some((warning) => warning.code === "missing_quality_constraint"),
  );
  assert.match(summary.warnings.join("\n"), /recall|ranking|quality/i);
});

async function initConstraintLoop(dir, name) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "contract"), { recursive: true });
  await writeFile(path.join(dir, "src", "primary-metric.txt"), "2\n");
  await writeFile(path.join(dir, "src", "candidate-revision.txt"), "baseline\n");
  await writeFile(path.join(dir, "contract", "checks.mjs"), "process.exit(0);\n");
  const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "const fs=require('node:fs');console.log('METRIC seconds='+fs.readFileSync('src/primary-metric.txt','utf8').trim())"`;
  const init = await setupFixture(dir, {
    name: name,
    acceptedContract: true,
    benchmarkCommand,
    checksCommand: `${quoteForAcceptedShell(process.execPath)} contract/checks.mjs`,
  });
  assert.equal(init.code, 0, init.stderr);
  const configPath = path.join(dir, "autoresearch.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.checkImplementationPaths = ["contract/checks.mjs"];
  config.checksAuthoritative = true;
  config.noiseModel = { kind: "deterministic" };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const segment = await runCli([
    "new-segment",
    "--cwd",
    dir,
    "--reason",
    "Accept authoritative constraint fixture",
    "--yes",
  ]);
  assert.equal(segment.code, 0, segment.stderr);
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
  await writeFile(path.join(dir, "src", "primary-metric.txt"), `${metric}\n`);
  await writeFile(path.join(dir, "src", "candidate-revision.txt"), `${description}\n`);
  const packet = await runCli(["next", "--cwd", dir]);
  assert.equal(packet.code, 0, packet.stderr);
  const packetPayload = JSON.parse(packet.stdout);
  assert.equal(
    packetPayload.decision.allowedStatuses.includes("keep"),
    true,
    JSON.stringify(packetPayload.run.contractKeepEligibility),
  );
  const result = await runCli([
    "log",
    "--cwd",
    dir,
    "--from-last",
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

async function logConstraintMeasurement(dir, { metric, metricsFile, description }) {
  await writeFile(path.join(dir, "src", "primary-metric.txt"), `${metric}\n`);
  const packet = await runCli(["next", "--cwd", dir]);
  assert.equal(packet.code, 0, packet.stderr);
  const result = await runCli([
    "log",
    "--cwd",
    dir,
    "--from-last",
    "--metrics-file",
    metricsFile,
    "--status",
    "measure",
    "--description",
    description,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result;
}
