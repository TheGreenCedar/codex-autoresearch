import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import { quoteForShell } from "../helpers/process.js";
import { runCli, runCliWithAnswers, withTempDir } from "./helpers.js";

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
    const firstPlan = firstGuidePayload.state.decisionPlan;
    assert.equal(firstPlan.kind, "decision-plan");
    assert.equal(firstPlan.action.kind, "setup");
    assert.match(firstPlan.action.command, / setup-plan /);
    assert.equal(firstPlan.capabilities["run-packet"], "blocked");
    assert.equal(firstPlan.capabilities["authorize-keep"], "blocked");
    assert.equal(firstPlan.loopDisposition.kind, "blocked");
    assert.equal(firstPlan.parentDisposition.kind, "hand-back");
    assert.ok(firstPlan.requiredEvidence.diagnosticCodes.includes("setup-required"));

    await mkdir(path.join(dir, "src"), { recursive: true });
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--recipe",
      "memory-usage",
      "--name",
      "Memory loop",
      "--checks-command",
      `${quoteForShell(process.execPath)} -e "process.exit(0)"`,
      "--scope",
      "src",
      "--commit-paths",
      "src",
      "--packet-budget",
      "6",
      "--max-iterations",
      "6",
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
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept the recipe-backed contract",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);

    const resumeGuide = await runCli(["guide", "--cwd", dir]);
    assert.equal(resumeGuide.code, 0, resumeGuide.stderr);
    const resumeGuidePayload = JSON.parse(resumeGuide.stdout);
    assert.equal(resumeGuidePayload.setup.recommendedRecipe.id, "memory-usage");
    assert.equal(resumeGuidePayload.doctor.ok, true);
    const resumePlan = resumeGuidePayload.state.decisionPlan;
    assert.equal(resumePlan.kind, "decision-plan");
    assert.equal(resumePlan.action.kind, "run-baseline");
    assert.equal(resumePlan.capabilities["run-packet"], "allowed");
    assert.equal(resumePlan.capabilities.finalize, "blocked");
    assert.equal(resumePlan.loopDisposition.kind, "continue");
    assert.equal(resumePlan.parentDisposition.kind, "hand-back");
    assert.ok(resumePlan.requiredEvidence.diagnosticCodes.includes("needs-baseline"));

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark", "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, true);
    assert.equal(doctorPayload.drift.local.surfaces.packageJson, PLUGIN_VERSION);
    assert.equal(doctorPayload.drift.ok, true);
    assert.equal(doctorPayload.preconditionDecision.action.kind, "run-baseline");
    assert.equal(doctorPayload.preconditionDecision.capabilities["run-packet"], "allowed");
    assert.equal(doctorPayload.resultingDecision.action.kind, "run-baseline");
    assert.ok(
      doctorPayload.resultingDecision.requiredEvidence.diagnosticCodes.includes("needs-baseline"),
    );
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

    await mkdir(path.join(dir, "src"), { recursive: true });
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--recipe",
      "catalog-demo",
      "--catalog",
      catalog,
      "--trust-catalog",
      "--scope",
      "src",
      "--commit-paths",
      "src",
      "--packet-budget",
      "6",
      "--max-iterations",
      "6",
    ]);
    assert.equal(setup.code, 0, setup.stderr);
    const setupPayload = JSON.parse(setup.stdout);
    assert.equal(setupPayload.init.config.metricName, "demo_score");
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept the catalog-backed contract",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, true);
    assert.equal(doctorPayload.resultingDecision.action.kind, "run-baseline");
    assert.equal(doctorPayload.resultingDecision.capabilities["run-packet"], "allowed");
    assert.ok(
      doctorPayload.resultingDecision.requiredEvidence.diagnosticCodes.includes("needs-baseline"),
    );
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

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).config.metricName, "rss_mb");
  });
});

test("recipes can load local catalogs", async () => {
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

    const listed = await runCli(["recipes", "list", "--catalog", catalog]);
    assert.equal(listed.code, 0, listed.stderr);
    const payload = JSON.parse(listed.stdout);
    assert.ok(payload.recipes.some((recipe) => recipe.id === "demo-recipe"));

    const shown = await runCli(["recipes", "show", "demo-recipe", "--catalog", catalog]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /Demo Recipe/);
  });
});
