import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
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
