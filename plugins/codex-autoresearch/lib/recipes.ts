import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { resolvePackageRoot } from "./runtime-paths.js";

const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const RECIPE_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const RECIPE_CATALOG_TIMEOUT_MS = 10_000;

const BUILT_IN_RECIPES = [
  {
    id: "node-test-runtime",
    title: "Node test runtime",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    benchmarkCommand:
      "node -e \"const {spawnSync}=require('node:child_process'); const c=process.platform==='win32'?'npm.cmd':'npm'; const r=spawnSync(c,['test'],{stdio:'inherit'}); process.exit(r.status ?? 1)\"",
    checksCommand:
      "node -e \"const {spawnSync}=require('node:child_process'); const c=process.platform==='win32'?'npm.cmd':'npm'; const r=spawnSync(c,['test'],{stdio:'inherit'}); process.exit(r.status ?? 1)\"",
    scope: ["package.json", "tests"],
    caveats: ["Requires an npm test script."],
    tags: ["runtime", "node", "test"],
  },
  {
    id: "vitest-runtime",
    title: "Vitest runtime",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    benchmarkCommand: "npx vitest run",
    checksCommand: "npx vitest run",
    scope: ["package.json", "src", "tests"],
    caveats: ["Requires Vitest to be available through npx or project dependencies."],
    tags: ["runtime", "frontend", "test"],
  },
  {
    id: "cargo-test-runtime",
    title: "Cargo test runtime",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    benchmarkCommand: "cargo test",
    checksCommand: "cargo test",
    scope: ["Cargo.toml", "src", "tests"],
    caveats: ["Requires Rust and Cargo."],
    tags: ["runtime", "rust", "test"],
  },
  {
    id: "pytest-runtime",
    title: "Pytest runtime",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    benchmarkCommand: "python -m pytest",
    checksCommand: "python -m pytest",
    scope: ["pyproject.toml", "pytest.ini", "tests"],
    caveats: ["Requires pytest in the active Python environment."],
    tags: ["runtime", "python", "test"],
  },
  {
    id: "lighthouse-score",
    title: "Lighthouse performance score",
    metricName: "score",
    metricUnit: "points",
    direction: "higher",
    benchmarkCommand:
      "node -e \"console.error('Replace with lighthouse CLI JSON parsing, then print METRIC score=<number>'); process.exit(1)\"",
    benchmarkPrintsMetric: true,
    checksCommand: "",
    scope: ["package.json", "src", "public"],
    caveats: ["Needs an app URL and Lighthouse CLI wiring before the first run."],
    tags: ["frontend", "performance", "web"],
  },
  {
    id: "bundle-size",
    title: "Bundle size",
    metricName: "bytes",
    metricUnit: "bytes",
    direction: "lower",
    benchmarkCommand:
      "node -e \"const fs=require('node:fs'); const p=process.env.AUTORESEARCH_BUNDLE_PATH||'dist'; let total=0; function walk(x){ if(!fs.existsSync(x)) return; const s=fs.statSync(x); if(s.isDirectory()) for(const f of fs.readdirSync(x)) walk(require('node:path').join(x,f)); else total+=s.size; } walk(p); console.log('METRIC bytes='+total);\"",
    benchmarkPrintsMetric: true,
    checksCommand: "npm run build",
    scope: ["package.json", "src", "dist"],
    caveats: ["Set AUTORESEARCH_BUNDLE_PATH when the bundle output is not dist."],
    tags: ["frontend", "build", "size"],
  },
  {
    id: "typescript-compile-time",
    title: "TypeScript compile time",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    benchmarkCommand: "npx tsc --noEmit",
    checksCommand: "npx tsc --noEmit",
    scope: ["tsconfig.json", "src"],
    caveats: ["Requires TypeScript in the project or through npx."],
    tags: ["build", "typescript"],
  },
  {
    id: "command-latency",
    title: "Command latency",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    benchmarkCommand:
      "node -e \"console.error('Replace this recipe command with the real workload'); process.exit(1)\"",
    checksCommand: "",
    scope: ["scripts", "src"],
    caveats: ["Replace the placeholder command before running doctor."],
    tags: ["runtime", "custom"],
  },
  {
    id: "memory-usage",
    title: "Memory usage",
    metricName: "rss_mb",
    metricUnit: "MB",
    direction: "lower",
    benchmarkCommand:
      "node -e \"console.log('METRIC rss_mb='+Math.round(process.memoryUsage().rss/1024/1024))\"",
    benchmarkPrintsMetric: true,
    checksCommand: "",
    scope: ["src", "scripts"],
    caveats: ["Replace with the workload process if Node process memory is not the target."],
    tags: ["memory", "runtime"],
  },
  {
    id: "quality-gap",
    title: "Deep research quality gap",
    metricName: "quality_gap",
    metricUnit: "gaps",
    direction: "lower",
    benchmarkCommand: `node ${quoteCommandArg(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} quality-gap --cwd . --research-slug research`,
    benchmarkPrintsMetric: true,
    checksCommand: "",
    scope: ["autoresearch.research"],
    caveats: ["Prefer research-setup so the slug-specific command is generated automatically."],
    tags: ["research", "quality-gap"],
  },
  {
    id: "custom",
    title: "Custom metric",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    benchmarkCommand:
      "node -e \"console.error('Replace with a command that prints METRIC seconds=<number>'); process.exit(1)\"",
    benchmarkPrintsMetric: true,
    checksCommand: "",
    scope: ["src", "tests"],
    caveats: ["Use this when no built-in recipe fits."],
    tags: ["custom", "safety"],
  },
];

function quoteCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function listBuiltInRecipes() {
  return BUILT_IN_RECIPES.map((recipe) => ({ ...recipe, source: "built-in" }));
}

export function getBuiltInRecipe(id) {
  return listBuiltInRecipes().find((recipe) => recipe.id === id) || null;
}

export function recipeDefaultsForSetup(id) {
  const recipe = getBuiltInRecipe(id);
  if (!recipe) throw new Error(`Unknown recipe: ${id}`);
  return recipeDefaultsFromRecipe(recipe);
}

export function recipeDefaultsFromRecipe(recipe) {
  return {
    recipe,
    name: recipe.title,
    metricName: recipe.metricName,
    metricUnit: recipe.metricUnit,
    direction: recipe.direction,
    benchmarkCommand: recipe.benchmarkCommand,
    benchmarkPrintsMetric: Boolean(recipe.benchmarkPrintsMetric),
    checksCommand: recipe.checksCommand,
    filesInScope: recipe.scope,
    constraints: recipe.caveats,
  };
}

export function applyRecipeDefaults(args, recipeId) {
  if (!recipeId) return args;
  const defaults = recipeDefaultsForSetup(recipeId);
  return applyRecipeObjectDefaults(args, defaults);
}

export function applyRecipeObjectDefaults(args, defaults) {
  return {
    ...args,
    recipeId: args.recipeId ?? args.recipe_id ?? args.recipe ?? defaults.recipe.id,
    name: args.name || defaults.name,
    metricName: args.metricName ?? args.metric_name ?? defaults.metricName,
    metric_name: args.metric_name ?? args.metricName ?? defaults.metricName,
    metricUnit: args.metricUnit ?? args.metric_unit ?? defaults.metricUnit,
    metric_unit: args.metric_unit ?? args.metricUnit ?? defaults.metricUnit,
    direction: args.direction || defaults.direction,
    benchmarkCommand: args.benchmarkCommand ?? args.benchmark_command ?? defaults.benchmarkCommand,
    benchmark_command: args.benchmark_command ?? args.benchmarkCommand ?? defaults.benchmarkCommand,
    benchmarkPrintsMetric:
      args.benchmarkPrintsMetric ?? args.benchmark_prints_metric ?? defaults.benchmarkPrintsMetric,
    benchmark_prints_metric:
      args.benchmark_prints_metric ?? args.benchmarkPrintsMetric ?? defaults.benchmarkPrintsMetric,
    checksCommand: args.checksCommand ?? args.checks_command ?? defaults.checksCommand,
    checks_command: args.checks_command ?? args.checksCommand ?? defaults.checksCommand,
    filesInScope: args.filesInScope ?? args.files_in_scope ?? defaults.filesInScope,
    files_in_scope: args.files_in_scope ?? args.filesInScope ?? defaults.filesInScope,
    constraints: args.constraints || defaults.constraints,
  };
}

export async function findRecipe(id, catalog = null) {
  const builtIn = getBuiltInRecipe(id);
  if (builtIn) return builtIn;
  const catalogRecipes = catalog ? await loadRecipeCatalog(catalog) : [];
  return catalogRecipes.find((recipe) => recipe.id === id) || null;
}

export async function applyResolvedRecipeDefaults(args, recipeId, catalog = null) {
  if (!recipeId) return args;
  const recipe = await findRecipe(recipeId, catalog);
  if (!recipe) throw new Error(`Unknown recipe: ${recipeId}`);
  return applyRecipeObjectDefaults(args, recipeDefaultsFromRecipe(recipe));
}

export async function recommendRecipe(workDir) {
  const exists = (file) => fs.existsSync(path.join(workDir, file));
  if (exists("package.json")) {
    const pkg = JSON.parse(await fsp.readFile(path.join(workDir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest) return getBuiltInRecipe("vitest-runtime");
    if (pkg.scripts?.test) return getBuiltInRecipe("node-test-runtime");
    if (deps.typescript || exists("tsconfig.json"))
      return getBuiltInRecipe("typescript-compile-time");
  }
  if (exists("Cargo.toml")) return getBuiltInRecipe("cargo-test-runtime");
  if (exists("pyproject.toml") || exists("pytest.ini")) return getBuiltInRecipe("pytest-runtime");
  return getBuiltInRecipe("custom");
}

export async function loadRecipeCatalog(catalog: string) {
  if (!catalog) return [];
  const text = (
    /^https?:\/\//i.test(catalog)
      ? await fetchText(catalog)
      : await readBoundedCatalogFile(path.resolve(catalog))
  ) as string;
  const parsed = JSON.parse(text);
  const recipes = Array.isArray(parsed) ? parsed : parsed.recipes;
  if (!Array.isArray(recipes))
    throw new Error("Recipe catalog must be an array or an object with recipes[].");
  return recipes.map(validateExternalRecipe);
}

async function readBoundedCatalogFile(filePath: string) {
  const stats = await fsp.stat(filePath);
  if (stats.size > RECIPE_CATALOG_MAX_BYTES) {
    throw new Error(`Recipe catalog is too large; limit is ${RECIPE_CATALOG_MAX_BYTES} bytes.`);
  }
  return await fsp.readFile(filePath, "utf8");
}

function validateExternalRecipe(recipe: Record<string, unknown>) {
  for (const field of ["id", "title", "metricName", "direction", "benchmarkCommand"]) {
    if (!recipe[field]) throw new Error(`Recipe is missing required field: ${field}`);
  }
  return {
    id: String(recipe.id),
    title: String(recipe.title),
    metricName: String(recipe.metricName),
    metricUnit: String(recipe.metricUnit || ""),
    direction: recipe.direction === "higher" ? "higher" : "lower",
    benchmarkCommand: String(recipe.benchmarkCommand),
    benchmarkPrintsMetric: Boolean(recipe.benchmarkPrintsMetric),
    checksCommand: String(recipe.checksCommand || ""),
    scope: Array.isArray(recipe.scope) ? recipe.scope.map(String) : [],
    caveats: Array.isArray(recipe.caveats) ? recipe.caveats.map(String) : [],
    tags: Array.isArray(recipe.tags) ? recipe.tags.map(String) : [],
    source: "catalog",
  };
}

async function fetchText(url) {
  const client = url.startsWith("https:") ? https : http;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = client
      .get(url, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          fail(new Error(`HTTP ${res.statusCode} while fetching recipe catalog`));
          res.resume();
          return;
        }
        const contentLength = Number(res.headers["content-length"] || 0);
        if (Number.isFinite(contentLength) && contentLength > RECIPE_CATALOG_MAX_BYTES) {
          fail(
            new Error(`Recipe catalog is too large; limit is ${RECIPE_CATALOG_MAX_BYTES} bytes.`),
          );
          res.destroy();
          return;
        }
        let body = "";
        let bytes = 0;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk, "utf8");
          if (bytes > RECIPE_CATALOG_MAX_BYTES) {
            fail(
              new Error(`Recipe catalog is too large; limit is ${RECIPE_CATALOG_MAX_BYTES} bytes.`),
            );
            res.destroy();
            return;
          }
          body += chunk;
        });
        res.on("end", () => succeed(body));
      })
      .on("error", fail);
    request.setTimeout(RECIPE_CATALOG_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`Timed out fetching recipe catalog after ${RECIPE_CATALOG_TIMEOUT_MS}ms.`),
      );
    });
  });
}
