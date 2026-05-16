import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  appendJsonl,
  currentState,
  iterationLimitInfo,
  parseQualityGaps,
  shellQuote as sessionShellQuote,
} from "../lib/session-core.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import { parseMetricLines, runProcess, runShell, tailText } from "../lib/runner.js";
import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import {
  createCliRunner,
  createInteractiveCliRunner,
  runGit,
  withProcess,
  withTempDir as withNamedTempDir,
} from "./helpers/process.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const repoRoot = path.resolve(pluginRoot, "..", "..");
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const runCli = createCliRunner(cli, pluginRoot);
const runCliWithAnswers = createInteractiveCliRunner(cli, pluginRoot);

const git = async (cwd, args) => {
  return await runGit(cwd, args);
};

const withTempDir = (name, fn) => withNamedTempDir("autoresearch-full", name, fn);

const withLiveServer = (dir, fn) => {
  return withProcess(
    process.execPath,
    [cli, "serve", "--cwd", dir, "--port", "0"],
    pluginRoot,
    async (_child, stdout, stderr) => {
      const payload = await waitForServerPayload(stdout, stderr);
      return await fn(payload);
    },
  );
};

const assertNoSensitiveEvidence = (text) => {
  for (const needle of [
    "abcdefghijklmnop",
    "zyxwvutsrqponmlkjihgfedcba",
    "user:pass@example.com",
    "C:\\Users\\Alice",
    "/home/alice",
  ]) {
    assert.equal(text.includes(needle), false, `Dashboard payload leaked ${needle}`);
  }
};

test("session core handles finite metrics, segments, limits, and quality gaps", async () => {
  await withTempDir("session-core", async (dir) => {
    appendJsonl(dir, { type: "config", name: "core", metricName: "delta", bestDirection: "lower" });
    appendJsonl(dir, { run: 1, metric: 0, status: "keep", description: "Zero baseline" });
    appendJsonl(dir, { run: 2, metric: -2, status: "keep", description: "Negative improvement" });

    let state = currentState(dir);
    assert.equal(state.baseline, 0);
    assert.equal(state.best, -2);
    assert.equal(iterationLimitInfo(state, { maxIterations: 3 }).remainingIterations, 1);

    appendJsonl(dir, {
      type: "config",
      name: "second",
      metricName: "seconds",
      bestDirection: "higher",
    });
    appendJsonl(dir, { run: 3, metric: 5, status: "discard", description: "Segment reset" });
    state = currentState(dir);
    assert.equal(state.segment, 1);
    assert.equal(state.current.length, 1);
    assert.equal(iterationLimitInfo(state, { maxIterations: 1 }).limitReached, true);

    assert.deepEqual(parseQualityGaps("- [ ] Open\n- [x] Closed\n- [X] Rejected\n"), {
      open: 1,
      closed: 2,
      total: 3,
    });
  });
});

test("displayed command quoting preserves backslashes before quotes", async () => {
  const trickyArg = String.raw`C:\tmp"name`;
  const expectedDisplay = String.raw`"C:\\tmp\"name"`;

  assert.equal(sessionShellQuote(trickyArg), expectedDisplay);

  const result = await runProcess(process.execPath, ["-e", "", trickyArg], {
    cwd: pluginRoot,
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.commandDisplay.includes(expectedDisplay), result.commandDisplay);
});

test("runner parses metrics, truncates tails, and reports timeouts", async () => {
  const metrics = parseMetricLines(
    ["metric seconds=1.25", "METRIC delta=-2", "METRIC scaled=1.5e+2", "METRIC __proto__=99"].join(
      "\n",
    ),
  );
  assert.equal(metrics.seconds, 1.25);
  assert.equal(metrics.delta, -2);
  assert.equal(metrics.scaled, 150);
  assert.equal(Object.hasOwn(metrics, "__proto__"), false);

  const tail = tailText(
    Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"),
    5,
    2000,
  );
  assert.equal(tail.split(/\r?\n/).length, 5);
  assert.match(tail, /line 39/);

  const command = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{}, 2000)"`;
  const result = await runShell(command, pluginRoot, 1);
  assert.equal(result.timedOut, true);
});

test("setup-plan, recipes, and recipe-backed setup are wired through the CLI", async () => {
  await withTempDir("setup-recipes", async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          scripts: { test: "node -e \"console.log('ok')\"" },
        },
        null,
        2,
      ),
    );

    const plan = await runCli(["setup-plan", "--cwd", dir]);
    assert.equal(plan.code, 0, plan.stderr);
    const planPayload = JSON.parse(plan.stdout);
    assert.equal(planPayload.recommendedRecipe.id, "node-test-runtime");
    assert.match(planPayload.nextCommand, /setup/);
    assert.match(planPayload.guideCommand, / guide /);
    assert.deepEqual(
      planPayload.guidedFlow.map((step) => step.step),
      ["setup", "benchmark-lint", "doctor", "baseline", "log"],
    );

    const recipes = await runCli(["recipes", "list"]);
    assert.equal(recipes.code, 0, recipes.stderr);
    assert.match(recipes.stdout, /memory-usage/);
    const recipesPayload = JSON.parse(recipes.stdout);
    const memoryRecipe = recipesPayload.recipes.find((recipe) => recipe.id === "memory-usage");
    assert.ok(memoryRecipe.tags.includes("memory"));

    const firstGuide = await runCli(["guide", "--cwd", dir]);
    assert.equal(firstGuide.code, 0, firstGuide.stderr);
    const firstGuidePayload = JSON.parse(firstGuide.stdout);
    assert.equal(firstGuidePayload.stage, "needs-setup");
    assert.match(firstGuidePayload.commands.setup, / setup /);
    assert.match(firstGuidePayload.commands.dashboard, / serve /);

    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--recipe",
      "memory-usage",
      "--name",
      "Memory loop",
    ]);
    assert.equal(setup.code, 0, setup.stderr);
    const payload = JSON.parse(setup.stdout);
    assert.equal(payload.init.config.metricName, "rss_mb");

    const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
    assert.equal(config.recipeId, "memory-usage");
    assert.match(
      await readFile(path.join(dir, "autoresearch.md"), "utf8"),
      /## Resume This Session/,
    );

    const resumeGuide = await runCli(["guide", "--cwd", dir]);
    assert.equal(resumeGuide.code, 0, resumeGuide.stderr);
    const resumeGuidePayload = JSON.parse(resumeGuide.stdout);
    assert.equal(resumeGuidePayload.stage, "needs-baseline");
    assert.equal(resumeGuidePayload.setup.recommendedRecipe.id, "memory-usage");
    assert.equal(resumeGuidePayload.doctor.ok, true);

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, true);
    assert.equal(doctorPayload.drift.local.surfaces.packageJson, PLUGIN_VERSION);
    assert.equal(doctorPayload.drift.ok, true);
  });
});

test("delight commands provide compact state, onboarding, linting, hooks, and new segments", async () => {
  await withTempDir("delight-commands", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "Delight loop", "--metric-name", "score"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi",
      JSON.stringify({ hypothesis: "baseline", evidence: "score=5" }),
    ]);

    const compact = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    assert.equal(compactPayload.metric, "score");
    assert.equal(compactPayload.runs, 1);
    assert.equal(compactPayload.commands.newSegmentDryRun.includes("new-segment"), true);

    const lint = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--metric-name",
      "score",
      "--sample",
      "METRIC score=4.2",
    ]);
    assert.equal(lint.code, 0, lint.stderr);
    const lintPayload = JSON.parse(lint.stdout);
    assert.equal(lintPayload.ok, true);
    assert.equal(lintPayload.parsedMetrics.score, 4.2);

    const inspect = await runCli(["benchmark-inspect", "--cwd", dir]);
    assert.equal(inspect.code, 0, inspect.stderr);
    const inspectPayload = JSON.parse(inspect.stdout);
    assert.equal(inspectPayload.ranCommand, false);
    assert.match(inspectPayload.hints.join("\n"), /METRIC score=<number>/);

    const checksInspect = await runCli([
      "checks-inspect",
      "--cwd",
      dir,
      "--command",
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    ]);
    assert.equal(checksInspect.code, 0, checksInspect.stderr);
    const checksInspectPayload = JSON.parse(checksInspect.stdout);
    assert.equal(checksInspectPayload.ranCommand, true);
    assert.equal(checksInspectPayload.ok, true);
    assert.match(checksInspectPayload.hints.join("\n"), /Cargo/);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.ok, true);
    assert.ok(recommendPayload.nextAction);

    const onboarding = await runCli(["onboarding-packet", "--cwd", dir, "--compact"]);
    assert.equal(onboarding.code, 0, onboarding.stderr);
    const onboardingPayload = JSON.parse(onboarding.stdout);
    assert.equal(onboardingPayload.kind, "codex-autoresearch-onboarding-packet");
    assert.ok(onboardingPayload.templates.firstResponse);

    const promptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      [
        "Use $Codex Autoresearch to optimize my unit tests' speed.",
        "Benchmark: node -e \"console.log('METRIC seconds=1')\"",
        "Metric: seconds, lower is better",
        'Checks: node -e "process.exit(0)"',
        "Scope: test runner config and test helpers only",
      ].join("\n"),
    ]);
    assert.equal(promptPlan.code, 0, promptPlan.stderr);
    const promptPayload = JSON.parse(promptPlan.stdout);
    assert.equal(promptPayload.kind, "codex-autoresearch-prompt-plan");
    assert.equal(promptPayload.intent.metric.name, "seconds");
    assert.match(promptPayload.intent.safeInterpretation, /preserving test coverage/);
    assert.match(promptPayload.setup.nextCommand, /--files-in-scope/);

    const compositePromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Optimize a composite score: 0.7 quality + 0.2 speed + 0.1 memory.",
    ]);
    assert.equal(compositePromptPlan.code, 0, compositePromptPlan.stderr);
    const compositePayload = JSON.parse(compositePromptPlan.stdout);
    assert.equal(compositePayload.intent.metric.name, "score");
    assert.equal(compositePayload.intent.metric.direction, "higher");

    await writeFile(
      path.join(dir, "Cargo.toml"),
      [
        "[package]",
        'name = "bench-target"',
        'version = "0.1.0"',
        "",
        "[[bench]]",
        'name = "criterion_score"',
        "harness = false",
        "",
      ].join("\n"),
    );
    const cargoPromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Optimize the Cargo criterion benchmark performance score.",
    ]);
    assert.equal(cargoPromptPlan.code, 0, cargoPromptPlan.stderr);
    const cargoPayload = JSON.parse(cargoPromptPlan.stdout);
    assert.equal(cargoPayload.intent.inferredFrom.discoveredBenchmark.path, "Cargo.toml#bench");
    assert.equal(cargoPayload.intent.setupDefaults.benchmarkCommand, "");
    assert.ok(cargoPayload.intent.missing.includes("benchmark_command"));
    assert.match(cargoPayload.intent.setupDefaults.constraints.join("\n"), /wrapper/);
    await rm(path.join(dir, "Cargo.toml"), { force: true });

    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(
      path.join(dir, "scripts", "semantic-domain-benchmark.mjs"),
      "console.log('METRIC semantic_score=0.5')\n",
    );
    const domainPromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Start a new Autoresearch session for the semantic domain benchmark.",
    ]);
    assert.equal(domainPromptPlan.code, 0, domainPromptPlan.stderr);
    const domainPayload = JSON.parse(domainPromptPlan.stdout);
    assert.equal(domainPayload.intent.metric.name, "semantic_score");
    assert.match(
      domainPayload.intent.setupDefaults.benchmarkCommand,
      /scripts\/semantic-domain-benchmark\.mjs/,
    );

    await writeFile(
      path.join(dir, "scripts", "autoresearch-indexer-embedder-pipeline.mjs"),
      "console.log('METRIC pipeline_score=123')\nconsole.log('METRIC quality_component=1')\n",
    );
    const pipelinePromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Start a new Codex Autoresearch session to improve the performance of the parse + index + embed pipeline.",
    ]);
    assert.equal(pipelinePromptPlan.code, 0, pipelinePromptPlan.stderr);
    const pipelinePayload = JSON.parse(pipelinePromptPlan.stdout);
    assert.equal(pipelinePayload.intent.metric.name, "pipeline_score");
    assert.equal(pipelinePayload.intent.metric.direction, "higher");
    assert.match(
      pipelinePayload.intent.setupDefaults.benchmarkCommand,
      /scripts\/autoresearch-indexer-embedder-pipeline\.mjs/,
    );
    assert.match(pipelinePayload.intent.setupDefaults.constraints.join("\n"), /primary score/);

    await writeFile(
      path.join(dir, "scripts", "cross-repo-promotion-benchmark.mjs"),
      "console.log('METRIC cross_repo_score=0.9')\n",
    );
    const frictionPromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Eliminate user and AI friction in a skill-first manual E2E flow. Use quality_gap as the primary metric and a deterministic manual-test harness.",
    ]);
    assert.equal(frictionPromptPlan.code, 0, frictionPromptPlan.stderr);
    const frictionPayload = JSON.parse(frictionPromptPlan.stdout);
    assert.equal(frictionPayload.intent.loopKind, "quality-gap");
    assert.equal(frictionPayload.intent.metric.name, "quality_gap");
    assert.equal(frictionPayload.intent.inferredFrom.discoveredBenchmark, null);
    assert.equal(frictionPayload.intent.setupDefaults.benchmarkCommand, "");
    assert.equal(frictionPayload.intent.setupDefaults.recipe, "quality-gap");

    for (const qualitativePrompt of [
      "Deepen security evidence hygiene around redaction, token handling, and stack trace leaks.",
      "Study release readiness and the release path for version drift, CI guards, and tarball smoke confidence.",
      "Improve dashboard UX and operator UX so the readout makes the next safe action obvious without live mutation controls.",
    ]) {
      const qualitativePlan = await runCli([
        "prompt-plan",
        "--cwd",
        dir,
        "--prompt",
        qualitativePrompt,
      ]);
      assert.equal(qualitativePlan.code, 0, qualitativePlan.stderr);
      const qualitativePayload = JSON.parse(qualitativePlan.stdout);
      assert.equal(qualitativePayload.intent.loopKind, "quality-gap");
      assert.equal(qualitativePayload.intent.metric.name, "quality_gap");
      assert.equal(qualitativePayload.intent.inferredFrom.discoveredBenchmark, null);
      assert.equal(qualitativePayload.intent.setupDefaults.recipe, "quality-gap");
    }

    const explicitMeasuredPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      [
        "Improve release smoke latency without changing release semantics.",
        "Benchmark: node -e \"console.log('METRIC seconds=2')\"",
        "Metric: seconds, lower is better",
        "Scope: .github/workflows/release.yml",
      ].join("\n"),
    ]);
    assert.equal(explicitMeasuredPlan.code, 0, explicitMeasuredPlan.stderr);
    const explicitMeasuredPayload = JSON.parse(explicitMeasuredPlan.stdout);
    assert.equal(explicitMeasuredPayload.intent.loopKind, "measured-optimization");
    assert.equal(explicitMeasuredPayload.intent.metric.name, "seconds");
    assert.match(explicitMeasuredPayload.intent.setupDefaults.benchmarkCommand, /METRIC seconds=2/);

    const broadPromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Use $Codex Autoresearch to keep reducing bugs in the codebase, starting with the most obvious low hanging fruits. Keep doing this 100 times.",
    ]);
    assert.equal(broadPromptPlan.code, 0, broadPromptPlan.stderr);
    const broadPayload = JSON.parse(broadPromptPlan.stdout);
    assert.equal(broadPayload.intent.loopKind, "quality-gap");
    assert.equal(broadPayload.intent.setupDefaults.maxIterations, 100);

    const hooks = await runCli(["doctor", "hooks", "--cwd", dir]);
    assert.equal(hooks.code, 0, hooks.stderr);
    const hooksPayload = JSON.parse(hooks.stdout);
    assert.equal(hooksPayload.defaultEnabled, false);
    assert.ok(Array.isArray(hooksPayload.limitations));

    const dryRun = await runCli(["new-segment", "--cwd", dir, "--dry-run"]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).dryRun, true);

    const segment = await runCli(["new-segment", "--cwd", dir, "--reason", "fresh phase", "--yes"]);
    assert.equal(segment.code, 0, segment.stderr);
    const segmentPayload = JSON.parse(segment.stdout);
    assert.equal(segmentPayload.nextSegment, 1);

    const promote = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "larger sample",
      "--query-count",
      "25",
      "--dry-run",
    ]);
    assert.equal(promote.code, 0, promote.stderr);
    const promotePayload = JSON.parse(promote.stdout);
    assert.equal(promotePayload.entry.measurementGate.queryCount, 25);

    const after = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(after.code, 0, after.stderr);
    const afterPayload = JSON.parse(after.stdout);
    assert.equal(afterPayload.segment, 1);
    assert.equal(afterPayload.runs, 0);
  });
});

test("CLI setup can use recipe defaults without explicit name and metric", async () => {
  await withTempDir("cli-recipe-setup", async (dir) => {
    const setup = await runCli(["setup", "--cwd", dir, "--recipe", "memory-usage"]);
    assert.equal(setup.code, 0, setup.stderr);
    const payload = JSON.parse(setup.stdout);
    assert.equal(payload.init.config.metricName, "rss_mb");
  });
});

test("release workflows preserve synchronized auto-release and tarball safeguards", async () => {
  const autoRelease = await readFile(
    path.join(repoRoot, ".github", "workflows", "auto-release.yml"),
    "utf8",
  );
  const release = await readFile(
    path.join(repoRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const codeql = await readFile(path.join(repoRoot, ".github", "workflows", "codeql.yml"), "utf8");

  assert.match(autoRelease, /branches:\s*\n\s*-\s*main/);
  assert.match(autoRelease, /plugins\/codex-autoresearch\/package\.json/);
  assert.match(autoRelease, /plugins\/codex-autoresearch\/package-lock\.json/);
  assert.match(autoRelease, /plugins\/codex-autoresearch\/\.codex-plugin\/plugin\.json/);
  assert.match(autoRelease, /CHANGELOG\.md/);
  assert.match(autoRelease, /contents:\s*read/);
  assert.match(autoRelease, /Version surfaces are not synchronized/);
  assert.match(autoRelease, /uses:\s*\.\/\.github\/workflows\/release\.yml/);

  assert.doesNotMatch(release, /push:\s*\n\s*tags:/);
  assert.match(release, /os:\s*\[ubuntu-latest,\s*windows-latest,\s*macos-latest\]/);
  assert.match(release, /npm run check/);
  assert.match(release, /node scripts\/autoresearch\.mjs --help/);
  assert.match(release, /Refuse existing tag or release/);
  assert.match(release, /npm pack/);
  assert.match(release, /tar -xzf/);
  assert.match(release, /gh release create/);
  assert.match(release, /--target "\$GITHUB_SHA"/);

  assert.match(codeql, /pull_request:/);
  assert.match(codeql, /branches:\s*\n\s*-\s*main\s*\n\s*-\s*dev/);
});

test("CLI exposes onboarding, prompt planning, benchmark probes, recommend-next, and segment tools", async () => {
  await withTempDir("cli-delight-tools", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "cli delight", "--metric-name", "score"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi",
      JSON.stringify({ hypothesis: "baseline", evidence: "score=3" }),
    ]);

    const onboarding = await runCli(["onboarding-packet", "--cwd", dir, "--compact"]);
    assert.equal(onboarding.code, 0, onboarding.stderr);
    assert.match(onboarding.stdout, /codex-autoresearch-onboarding-packet/);

    const promptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Use $Codex Autoresearch to figure out why p99 latency is so much higher than p90. I suspect: DNS lookup, event loop throttling, memory spike, CPU spike. Use @experiments.md.",
    ]);
    assert.equal(promptPlan.code, 0, promptPlan.stderr);
    assert.match(promptPlan.stdout, /p99_p90_ratio/);
    assert.match(promptPlan.stdout, /DNS lookup/);
    assert.match(promptPlan.stdout, /experiments\.md/);

    const lint = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--metric-name",
      "score",
      "--sample",
      "METRIC score=2",
    ]);
    assert.equal(lint.code, 0, lint.stderr);
    assert.match(lint.stdout, /"emitsPrimary": true/);

    const inspect = await runCli(["benchmark-inspect", "--cwd", dir]);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.match(inspect.stdout, /benchmark-native list/);

    const checksInspect = await runCli(["checks-inspect", "--cwd", dir]);
    assert.equal(checksInspect.code, 0, checksInspect.stderr);
    assert.match(checksInspect.stdout, /correctness command/);

    const next = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    assert.match(next.stdout, /"whySafe"/);

    const dryRun = await runCli(["new-segment", "--cwd", dir, "--dry-run"]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /"dryRun": true/);

    const promote = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "larger gate",
      "--query-count",
      "20",
      "--dry-run",
    ]);
    assert.equal(promote.code, 0, promote.stderr);
    assert.match(promote.stdout, /"queryCount": 20/);
  });
});
test("catalog recipes can drive setup-plan and setup", async () => {
  await withTempDir("catalog-setup", async (dir) => {
    const catalog = path.join(dir, "recipes.json");
    await writeFile(
      catalog,
      JSON.stringify(
        {
          recipes: [
            {
              id: "catalog-demo",
              title: "Catalog Demo",
              metricName: "demo_score",
              metricUnit: "points",
              direction: "higher",
              benchmarkCommand: "node -e \"console.log('METRIC demo_score=42')\"",
              benchmarkPrintsMetric: true,
              checksCommand: 'node -e "process.exit(0)"',
              scope: ["src"],
            },
          ],
        },
        null,
        2,
      ),
    );

    const plan = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--recipe",
      "catalog-demo",
      "--catalog",
      catalog,
      "--trust-catalog",
    ]);
    assert.equal(plan.code, 0, plan.stderr);
    const planPayload = JSON.parse(plan.stdout);
    assert.equal(planPayload.recommendedRecipe.id, "catalog-demo");
    assert.match(planPayload.nextCommand, /--catalog/);
    assert.match(planPayload.nextCommand, /--trust-catalog/);

    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--recipe",
      "catalog-demo",
      "--catalog",
      catalog,
      "--trust-catalog",
    ]);
    assert.equal(setup.code, 0, setup.stderr);
    const setupPayload = JSON.parse(setup.stdout);
    assert.equal(setupPayload.init.config.metricName, "demo_score");

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
  });
});

test("interactive setup uses defaults from the recipe selected by the operator", async () => {
  await withTempDir("interactive-recipe", async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          scripts: { test: "node -e \"console.log('ok')\"" },
        },
        null,
        2,
      ),
    );

    const answers = ["memory-usage", "", "", "", "", "", "", "", "", ""];
    const interactive = await runCliWithAnswers(["setup", "--cwd", dir, "--interactive"], answers);
    assert.equal(interactive.code, 0, interactive.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).config.metricName, "rss_mb");
  });
});

test("quality-gap recipe benchmarks through the plugin CLI", async () => {
  await withTempDir("quality-gap-recipe", async (dir) => {
    const researchDir = path.join(dir, "autoresearch.research", "research");
    await mkdir(researchDir, { recursive: true });
    await writeFile(path.join(researchDir, "quality-gaps.md"), "- [ ] Existing gap\n");

    const setup = await runCli(["setup", "--cwd", dir, "--recipe", "quality-gap"]);
    assert.equal(setup.code, 0, setup.stderr);
    const setupPayload = JSON.parse(setup.stdout);
    assert.equal(setupPayload.init.config.metricName, "quality_gap");

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
  });
});

test("quality-gap auto-detects the active research slug for JSON output", async () => {
  await withTempDir("quality-gap-autodetect", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "Delight Study",
      "--goal",
      "Study project delight",
    ]);
    const gapsPath = path.join(dir, "autoresearch.research", "delight-study", "quality-gaps.md");
    await writeFile(gapsPath, "- [ ] Open delight gap\n- [x] Closed delight gap\n", "utf8");

    const result = await runCli(["quality-gap", "--cwd", dir, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.slug, "delight-study");
    assert.equal(payload.open, 1);
    assert.deepEqual(payload.openItems, ["Open delight gap"]);
  });
});

test("gap-candidates extracts, dedupes, applies, and rejects malformed model output", async () => {
  await withTempDir("gap-candidates", async (dir) => {
    await runCli(["research-setup", "--cwd", dir, "--slug", "study", "--goal", "Study delight"]);
    const synthesisPath = path.join(dir, "autoresearch.research", "study", "synthesis.md");
    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Build a guided setup flow with recipe suggestions.",
        "- Build a guided setup flow with recipe suggestions.",
        "",
      ].join("\n"),
    );

    const preview = await runCli(["gap-candidates", "--cwd", dir, "--research-slug", "study"]);
    assert.equal(preview.code, 0, preview.stderr);
    const previewPayload = JSON.parse(preview.stdout);
    assert.equal(previewPayload.candidates.length, 1);
    assert.equal(previewPayload.applied, false);
    assert.equal(previewPayload.roundGuidance.unit, "research-round");
    assert.match(
      previewPayload.roundGuidance.metricScope,
      /does not discover fresh recommendations/,
    );
    assert.match(previewPayload.roundGuidance.requiredRefresh, /rerun the project-study prompt/);
    assert.ok(
      previewPayload.roundGuidance.hallucinationFilter.some((item) => /validation path/.test(item)),
    );
    assert.match(previewPayload.roundGuidance.stopRule, /fresh research round/);

    const applied = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--apply",
    ]);
    assert.equal(applied.code, 0, applied.stderr);
    const appliedPayload = JSON.parse(applied.stdout);
    assert.equal(appliedPayload.applied, true);
    assert.equal(appliedPayload.qualityGap.total, 7);

    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Build a guided setup flow with recipe suggestions.",
        "- Add a resume cockpit that explains the exact next operator action.",
        "",
      ].join("\n"),
    );
    const reapplied = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--apply",
    ]);
    assert.equal(reapplied.code, 0, reapplied.stderr);
    const reappliedPayload = JSON.parse(reapplied.stdout);
    assert.equal(reappliedPayload.qualityGap.total, 8);
    const gaps = await readFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      "utf8",
    );
    assert.equal((gaps.match(/## Candidate Gaps/g) || []).length, 1);
    assert.equal((gaps.match(/<!-- codex-autoresearch:generated-candidates -->/g) || []).length, 1);
    assert.match(gaps, /resume cockpit/);
    assert.match(gaps, /guided setup flow/);

    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Add a resume cockpit that explains the exact next operator action.",
        "",
      ].join("\n"),
    );
    const refreshed = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--apply",
    ]);
    assert.equal(refreshed.code, 0, refreshed.stderr);
    const refreshedPayload = JSON.parse(refreshed.stdout);
    assert.equal(refreshedPayload.qualityGap.total, 7);
    const refreshedGaps = await readFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      "utf8",
    );
    assert.equal((refreshedGaps.match(/## Candidate Gaps/g) || []).length, 1);
    assert.match(refreshedGaps, /resume cockpit/);
    assert.doesNotMatch(refreshedGaps, /guided setup flow/);

    await writeFile(synthesisPath, "# Research Synthesis\n\n## High-Impact Findings\n\n");
    const cleared = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--apply",
    ]);
    assert.equal(cleared.code, 0, cleared.stderr);
    const clearedPayload = JSON.parse(cleared.stdout);
    assert.equal(clearedPayload.qualityGap.total, 6);
    const clearedGaps = await readFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      "utf8",
    );
    assert.doesNotMatch(clearedGaps, /## Candidate Gaps/);

    await writeFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      [
        "# Quality Gaps",
        "",
        "- [x] Build a guided setup flow with recipe suggestions. Evidence: implemented in round 1.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Build a guided setup flow with recipe suggestions.",
        "",
      ].join("\n"),
    );
    const closedDuplicate = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
    ]);
    assert.equal(closedDuplicate.code, 0, closedDuplicate.stderr);
    const closedDuplicatePayload = JSON.parse(closedDuplicate.stdout);
    assert.equal(closedDuplicatePayload.candidates.length, 0);
    assert.equal(closedDuplicatePayload.stopRecommended, true);
    assert.equal(closedDuplicatePayload.stopStatus.researchExhausted, true);
    assert.equal(closedDuplicatePayload.stopStatus.requiresPassingChecks, true);

    await writeFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      ["# Quality Gaps", "", "- [x] Build an Evidence: ledger for accepted gaps.", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Build an Evidence: panel for candidate provenance.",
        "",
      ].join("\n"),
    );
    const evidenceTitle = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
    ]);
    assert.equal(evidenceTitle.code, 0, evidenceTitle.stderr);
    const evidenceTitlePayload = JSON.parse(evidenceTitle.stdout);
    assert.equal(evidenceTitlePayload.candidates.length, 1);
    assert.equal(evidenceTitlePayload.stopRecommended, false);

    const badModel = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--model-command",
      `${JSON.stringify(process.execPath)} -e "console.log('not json')"`,
    ]);
    assert.notEqual(badModel.code, 0);
    assert.match(badModel.stderr, /model-command must print a JSON array/);

    const timedOutModel = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--model-command",
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 2000)"`,
      "--model-timeout-seconds",
      "1",
    ]);
    assert.notEqual(timedOutModel.code, 0);
    assert.match(timedOutModel.stderr, /model-command failed \(timed out\)/);
  });
});

test("finalize-preview summarizes kept commits without creating branches", async () => {
  await withTempDir("finalize-preview", async (dir) => {
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "value.txt"), "base\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "base"]);
    await git(dir, ["branch", "develop"]);

    await git(dir, ["switch", "-c", "codex/autoresearch-preview"]);
    await runCli(["init", "--cwd", dir, "--name", "preview", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "src", "value.txt"), "kept\n");
    const keep = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Keep value",
      "--commit-paths",
      "src",
    ]);
    assert.equal(keep.code, 0, keep.stderr);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "record run"]);

    const preview = await runCli(["finalize-preview", "--cwd", dir]);
    assert.equal(preview.code, 0, preview.stderr);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.progress.mode, "synchronous");
    assert.equal(payload.progress.status, "completed");
    assert.equal(payload.progress.stages[0].stage, "finalize-preview");
    assert.equal(payload.groups.length, 1);
    assert.deepEqual(payload.groups[0].files, ["src/value.txt"]);

    const developPreview = await runCli(["finalize-preview", "--cwd", dir, "--trunk", "develop"]);
    assert.equal(developPreview.code, 0, developPreview.stderr);
    assert.match(JSON.parse(developPreview.stdout).suggestedCommand, /--trunk "develop"/);

    const branches = await git(dir, ["branch", "--list", "autoresearch-review/*"]);
    assert.equal(branches, "");
  });
});

test("integrations can load local recipe catalogs", async () => {
  await withTempDir("integrations", async (dir) => {
    const catalog = path.join(dir, "recipes.json");
    await writeFile(
      catalog,
      JSON.stringify(
        {
          recipes: [
            {
              id: "demo-recipe",
              title: "Demo Recipe",
              metricName: "demo",
              direction: "higher",
              benchmarkCommand: "node -e \"console.log('METRIC demo=1')\"",
            },
          ],
        },
        null,
        2,
      ),
    );

    const synced = await runCli(["integrations", "sync-recipes", "--catalog", catalog]);
    assert.equal(synced.code, 0, synced.stderr);
    const payload = JSON.parse(synced.stdout);
    assert.equal(payload.synced, false);
    assert.ok(payload.recipes.some((recipe) => recipe.id === "demo-recipe"));

    const doctor = await runCli(["integrations", "doctor", "--catalog", catalog]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.match(doctor.stdout, /Configured recipe catalog/);
  });
});

test("live server exposes health and view-model endpoints", async () => {
  await withTempDir("live-server", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "live", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);

    await withLiveServer(dir, async (payload) => {
      assert.equal(payload.modeGuidance.deliveryMode, "live-server");
      assert.equal(payload.verified, true);
      assert.match(payload.healthUrl, /^http:\/\/127\.0\.0\.1:\d+\/health$/);
      assert.match(payload.modeGuidance.difference, /read-only snapshots|fallback snapshot/);
      const health = await fetch(`${payload.url}health`).then((res) => res.json());
      assert.equal(health.ok, true);
      const html = await fetch(payload.url).then((res) => res.text());
      assert.match(html, /"deliveryMode":"live-server"/);
      for (const forbidden of [
        "Live actions available",
        "live-actions-panel",
        "action-receipt",
        "actionNonce",
        "X-Autoresearch-Action-Nonce",
        "/actions/",
      ]) {
        assert.equal(html.includes(forbidden), false, `live dashboard exposed ${forbidden}`);
      }
      const viewModel = await fetch(`${payload.url}view-model.json`).then((res) => res.json());
      assert.equal(viewModel.summary.runs, 1);
    });
  });
});

test("dashboard export and live endpoints redact sensitive evidence", async () => {
  await withTempDir("dashboard-redaction", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "redacted live", "--metric-name", "seconds"]);
    const sensitiveEvidence = [
      "api_key=abcdefghijklmnop",
      "Bearer zyxwvutsrqponmlkjihgfedcba",
      "https://user:pass@example.com/path",
      "C:\\Users\\Alice\\.env.local",
      "/home/alice/.env",
      "Error: failed\n    at leak (C:\\Users\\Alice\\repo\\src\\secret.ts:1:2)",
    ].join(" ");
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      `Baseline ${sensitiveEvidence}`,
      "--asi",
      JSON.stringify({
        hypothesis: `Try the secret-bearing path ${sensitiveEvidence}`,
        evidence: sensitiveEvidence,
        next_action_hint: `Continue without leaking ${sensitiveEvidence}`,
      }),
    ]);

    const exported = await runCli(["export", "--cwd", dir]);
    assert.equal(exported.code, 0, exported.stderr);
    const html = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assertNoSensitiveEvidence(html);

    await withLiveServer(dir, async (payload) => {
      const html = await fetch(payload.url).then((res) => res.text());
      const jsonl = await fetch(`${payload.url}autoresearch.jsonl`).then((res) => res.text());
      const viewModel = await fetch(`${payload.url}view-model.json`).then((res) => res.json());
      const viewModelText = JSON.stringify(viewModel);

      assertNoSensitiveEvidence(html);
      assertNoSensitiveEvidence(jsonl);
      assertNoSensitiveEvidence(viewModelText);
      assert.match(jsonl, /api_key=<redacted>/);
      assert.match(jsonl, /Bearer <redacted>/);
      assert.match(jsonl, /https:\/\/<credentials>@example\.com/);
      assert.match(viewModelText, /<env-file>/);
      assert.match(`${html}\n${jsonl}\n${viewModelText}`, /<stack-frame>/);
      assert.doesNotMatch(`${html}\n${jsonl}\n${viewModelText}`, /secret\.ts/);
    });
  });
});

test("live server has no dashboard action routes because CLI owns mutations", async () => {
  await withTempDir("live-gap-action", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "Custom Study",
      "--goal",
      "Study live gaps",
    ]);

    await withLiveServer(dir, async (payload) => {
      const action = await fetch(`${payload.url}actions/gap-candidates`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: new URL(payload.url).origin },
        body: JSON.stringify({}),
      });
      assert.equal(action.status, 404);
      const body = await action.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "Not found");
    });
  });
});

test("live server log actions stay disabled and leave last-run packets untouched", async () => {
  await withTempDir("live-log-action", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "live log", "--metric-name", "seconds"]);
    const benchmarkFile = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
    const benchmarkBody =
      process.platform === "win32"
        ? 'Write-Output "METRIC seconds=2"\n'
        : "#!/bin/sh\nprintf 'METRIC seconds=2\\n'\n";
    await writeFile(path.join(dir, benchmarkFile), benchmarkBody, "utf8");
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");

    await withLiveServer(dir, async (payload) => {
      const viewModel = await fetch(`${payload.url}view-model.json`).then((res) => res.json());
      assert.equal(viewModel.missionControl.logDecision.available, true);

      const action = await fetch(`${payload.url}actions/log-keep`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: new URL(payload.url).origin },
        body: JSON.stringify({
          confirm: "log-keep",
          lastRunFingerprint: viewModel.missionControl.logDecision.lastRunFingerprint,
          description: "Live kept packet",
          asi: {
            hypothesis: "Live packet improved the metric.",
            evidence: "seconds=2",
            next_action_hint: "Review finalization.",
          },
        }),
      });
      assert.equal(action.status, 404);
      const actionBody = await action.json();
      assert.equal(actionBody.ok, false);
      assert.equal(actionBody.error, "Not found");

      const state = JSON.parse((await runCli(["state", "--cwd", dir])).stdout);
      assert.equal(state.runs, 0);
      assert.equal(state.kept, 0);
    });
  });
});

async function waitForServerPayload(stdoutFn, stderrFn) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const stdout = stdoutFn();
    if (stdout.trim().endsWith("}")) return JSON.parse(stdout);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`serve did not print startup JSON\n${stderrFn()}`);
}
