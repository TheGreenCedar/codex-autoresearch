#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readText(file) {
  return await fsp.readFile(path.join(pluginRoot, file), "utf8");
}

async function readRootText(file) {
  return await fsp.readFile(path.resolve(pluginRoot, "..", "..", file), "utf8");
}

async function readJson(file) {
  return JSON.parse(await readText(file));
}

function includesAll(text, values) {
  return values.every((value) => text.includes(value));
}

function hasRegex(text, pattern) {
  return pattern.test(text);
}

function fail(message) {
  return { ok: false, message };
}

function pass(message = "") {
  return { ok: true, message };
}

const checks = [
  {
    id: "version-sync",
    file: "package.json, .codex-plugin/plugin.json, scripts/autoresearch.mjs, scripts/autoresearch-mcp.mjs",
    description: "All public version surfaces expose the same plugin version.",
    run: async () => {
      const pkg = await readJson("package.json");
      const manifest = await readJson(".codex-plugin/plugin.json");
      const cli = await readText("scripts/autoresearch.mjs");
      const mcp = await readText("scripts/autoresearch-mcp.mjs");
      const serverVersion = cli.match(/serverInfo:\s*\{\s*name:\s*"codex-autoresearch",\s*version:\s*"([^"]+)"/s)?.[1];
      const mcpVersion = mcp.match(/const VERSION = "([^"]+)"/)?.[1];
      if (pkg.version === manifest.version && pkg.version === serverVersion && pkg.version === mcpVersion) return pass();
      return fail(`package=${pkg.version}, manifest=${manifest.version}, server=${serverVersion || "(missing)"}, mcp=${mcpVersion || "(missing)"}`);
    },
  },
  {
    id: "local-mcp-config",
    file: ".mcp.json",
    description: "The local MCP server starts through the lightweight entrypoint and exposes the one-packet next flow.",
    run: async () => {
      const config = await readJson(".mcp.json");
      const server = config.mcpServers?.["codex-autoresearch"];
      if (!server) return fail("codex-autoresearch MCP server is missing");
      const args = Array.isArray(server.args) ? server.args.join(" ") : "";
      const note = String(server.note || "");
      if (
        server.cwd === "."
        && args.includes("./scripts/autoresearch-mcp.mjs")
        && Number(server.startup_timeout_sec) >= 30
        && note.includes("next_experiment")
        && note.includes("setup_research_session")
        && note.includes("measure_quality_gap")
      ) {
        return pass();
      }
      return fail("MCP config should use cwd='.', the lightweight startup script, startup_timeout_sec, and mention next_experiment plus research tools");
    },
  },
  {
    id: "local-plugin-readme",
    file: "README.md",
    description: "README explains how to force the repo-local plugin over a globally installed/cache copy.",
    run: async () => {
      const readme = await readText("README.md");
      return includesAll(readme, [
        "## Local Plugin Iteration",
        "repo-local plugin",
        "globally installed",
        "node scripts/autoresearch.mjs",
      ])
        ? pass()
        : fail("Missing local-over-global workflow guidance.");
    },
  },
  {
    id: "gpt54-operating-profile",
    file: "README.md",
    description: "README gives Codex + GPT-5.4 a bounded, measurable operating profile.",
    run: async () => {
      const readme = await readText("README.md");
      return includesAll(readme, [
        "## Codex + GPT-5.4 Operating Profile",
        "quality_gap",
        "autoresearch-deep-research",
        "1.05M context",
      ])
        ? pass()
        : fail("Missing GPT-5.4-specific operating profile and quality_gap stop rule.");
    },
  },
  {
    id: "research-prompt-loop",
    file: "README.md",
    description: "README documents how qualitative deep-research prompts become measurable autoresearch loops.",
    run: async () => {
      const readme = await readText("README.md");
      return includesAll(readme, [
        "## Deep Research Autoresearch",
        "Research-heavy prompts",
        "Study my project",
        "delightful",
        "autoresearch.research/<slug>/",
        "METRIC quality_total",
        "one research round",
        "filter hallucinations",
        "quality_gap=0 closes the accepted checklist",
      ])
        ? pass()
        : fail("Missing the qualitative prompt-to-metric loop.");
    },
  },
  {
    id: "root-readme-research-loop",
    file: "../../README.md",
    description: "The repository README mirrors the public deep-research quality_gap workflow.",
    run: async () => {
      const readme = await readRootText("README.md");
      return includesAll(readme, [
        "## Deep Research Autoresearch",
        "autoresearch-deep-research",
        "plugins/codex-autoresearch/scripts/autoresearch.mjs research-setup",
        "autoresearch.research/<slug>/",
        "METRIC quality_closed",
        "setup_research_session",
        "measure_quality_gap",
        "one research round",
        "filter hallucinations",
      ])
        ? pass()
        : fail("Root README is missing the deep-research quality_gap workflow.");
    },
  },
  {
    id: "command-local-routing",
    file: "commands/autoresearch.md",
    description: "Slash-command docs protect local-plugin routing and quality-gap usage.",
    run: async () => {
      const command = await readText("commands/autoresearch.md");
      return includesAll(command, [
        "local plugin over any globally installed copy",
        "plugins/codex-autoresearch",
        "autoresearch-deep-research",
        "quality_gap",
        "one research round",
        "filter hallucinations",
      ])
        ? pass()
        : fail("Command docs do not explicitly prefer the local plugin and quality_gap loops.");
    },
  },
  {
    id: "create-skill-research-loop",
    file: "skills/autoresearch-create/SKILL.md",
    description: "Create skill routes broad qualitative work to the dedicated research skill.",
    run: async () => {
      const skill = await readText("skills/autoresearch-create/SKILL.md");
      return includesAll(skill, [
        "## Broad Research Loops",
        "autoresearch-deep-research",
        "quality_gap",
        "repo-local plugin",
      ])
        ? pass()
        : fail("Create skill does not route qualitative work to autoresearch-deep-research.");
    },
  },
  {
    id: "create-skill-dashboard-link",
    file: "skills/autoresearch-create/SKILL.md, commands/autoresearch.md",
    description: "Start and resume workflow guidance requires a direct dashboard file link.",
    run: async () => {
      const skill = await readText("skills/autoresearch-create/SKILL.md");
      const command = await readText("commands/autoresearch.md");
      return includesAll(`${skill}\n${command}`, [
        "directly provide the dashboard file link",
        "session start and resume",
        "autoresearch-dashboard.html",
      ])
        ? pass()
        : fail("Create and command docs must require a direct dashboard link at start and resume.");
    },
  },
  {
    id: "active-loop-continuation-contract",
    file: "README.md, ../../README.md, skills/autoresearch-create/SKILL.md, commands/autoresearch.md, scripts/autoresearch.mjs, lib/mcp-interface.mjs",
    description: "Owner-autonomous loops expose and document a machine-readable continuation contract after each packet.",
    run: async () => {
      const readme = await readText("README.md");
      const rootReadme = await readRootText("README.md");
      const skill = await readText("skills/autoresearch-create/SKILL.md");
      const command = await readText("commands/autoresearch.md");
      const cli = await readText("scripts/autoresearch.mjs");
      const mcp = await readText("lib/mcp-interface.mjs");
      return includesAll(`${readme}\n${rootReadme}\n${skill}\n${command}\n${cli}\n${mcp}`, [
        "Active Loop Contract",
        "continuation.shouldContinue",
        "continuation.forbidFinalAnswer",
        "loopContinuation",
        "active-loop continuation contract",
      ])
        ? pass()
        : fail("Missing active-loop continuation docs or CLI/MCP continuation output.");
    },
  },
  {
    id: "deep-research-skill",
    file: "skills/autoresearch-deep-research/SKILL.md",
    description: "Plugin-local deep research skill preserves orchestration ideas and converts them into quality_gap loops.",
    run: async () => {
      const skill = await readText("skills/autoresearch-deep-research/SKILL.md");
      return includesAll(skill, [
        "autoresearch.research/<slug>/",
        "sources.md",
        "synthesis.md",
        "ASI",
        "quality_gap",
        "confidence",
        "Round Protocol",
        "filter hallucinations",
        "quality_gap=0 only means",
      ])
        ? pass()
        : fail("Deep research skill is missing scratchpad, source, synthesis, ASI, confidence, or quality_gap guidance.");
    },
  },
  {
    id: "research-cli-and-mcp",
    file: "scripts/autoresearch.mjs, lib/mcp-interface.mjs",
    description: "CLI help and MCP schema expose research setup and quality-gap measurement.",
    run: async () => {
      const cli = await readText("scripts/autoresearch.mjs");
      const mcp = await readText("lib/mcp-interface.mjs");
      return includesAll(`${cli}\n${mcp}`, [
        "research-setup --cwd <project>",
        "quality-gap --cwd <project>",
        "setup_research_session",
        "measure_quality_gap",
        "METRIC quality_closed",
      ])
        ? pass()
        : fail("CLI/MCP research commands are not fully exposed.");
    },
  },
  {
    id: "session-template-decision-rules",
    file: "assets/autoresearch.md.template",
    description: "The session template captures stop conditions, research notes, and decision rules.",
    run: async () => {
      const template = await readText("assets/autoresearch.md.template");
      return includesAll(template, [
        "## Decision Rules",
        "## Stop Conditions",
        "## Research Notes",
      ])
        ? pass()
        : fail("Session template lacks durable decision and stop-condition sections.");
    },
  },
  {
    id: "manifest-research-prompts",
    file: ".codex-plugin/plugin.json",
    description: "Marketplace default prompts stay concise and include the deep-research quality_gap workflow.",
    run: async () => {
      const manifest = await readJson(".codex-plugin/plugin.json");
      const prompts = manifest.interface?.defaultPrompt || [];
      const promptText = prompts.join("\n");
      return prompts.length <= 3
        && prompts.every((prompt) => prompt.length < 128)
        && includesAll(promptText, [
          "Start autoresearch for this project.",
          "Create a deep-research quality_gap loop.",
          "Finalize kept experiments into review branches.",
        ])
        ? pass()
        : fail("Default prompts must be three concise starters including the deep-research quality_gap workflow.");
    },
  },
  {
    id: "session-artifacts-ignored",
    file: ".gitignore",
    description: "Repo-local autoresearch session artifacts stay out of product commits by default.",
    run: async () => {
      const gitignore = await readText(".gitignore");
      return includesAll(gitignore, [
        "/autoresearch.md",
        "/autoresearch.jsonl",
        "/autoresearch.config.json",
        "/autoresearch.ideas.md",
        "/autoresearch.research/",
      ])
        ? pass()
        : fail("Root session artifacts are not ignored.");
    },
  },
  {
    id: "finalizer-excludes-research-artifacts",
    file: "scripts/finalize-autoresearch.mjs",
    description: "Finalization excludes deep research scratchpads from review branches.",
    run: async () => {
      const finalizer = await readText("scripts/finalize-autoresearch.mjs");
      return includesAll(finalizer, [
        "autoresearch.research",
        "startsWith(`${RESEARCH_DIR}/`)",
        "session artifact verification",
      ])
        ? pass()
        : fail("Finalizer does not exclude autoresearch.research scratchpads.");
    },
  },
  {
    id: "quality-gate-in-checks",
    file: "package.json, scripts/check.mjs",
    description: "npm run check fails when the plugin's own quality_gap benchmark regresses.",
    run: async () => {
      const pkg = await readJson("package.json");
      const checkScript = await readText("scripts/check.mjs");
      return String(pkg.scripts?.check || "").includes("scripts/check.mjs")
        && checkScript.includes("perfection-benchmark.mjs")
        && checkScript.includes("--fail-on-gap")
        ? pass()
        : fail("package check does not run scripts/check.mjs with perfection-benchmark --fail-on-gap.");
    },
  },
  {
    id: "quality-gate-tested",
    file: "tests/perfection-benchmark.test.mjs",
    description: "The self-benchmark is covered by the Node test suite.",
    run: async () => {
      try {
        const test = await readText("tests/perfection-benchmark.test.mjs");
        return hasRegex(test, /quality_gap\s*=\s*0/) && test.includes("perfection-benchmark.mjs")
          ? pass()
          : fail("Test exists but does not assert the zero-gap metric.");
      } catch {
        return fail("Missing perfection benchmark test.");
      }
    },
  },
  {
    id: "dashboard-semantic-labels",
    file: "assets/template.html",
    description: "The dashboard uses real labels only for form controls, not decorative microcopy.",
    run: async () => {
      const template = await readText("assets/template.html");
      const labelCount = (template.match(/<label\b/g) || []).length;
      if (
        labelCount === 1
        && template.includes('<label for="segment-select">')
        && template.includes("score-label")
        && template.includes("readout-label")
        && !template.includes("<label>Best kept change</label>")
      ) {
        return pass();
      }
      return fail(`Expected one real form label; found ${labelCount}.`);
    },
  },
  {
    id: "dashboard-embedded-favicon",
    file: "assets/template.html",
    description: "The static dashboard embeds a favicon to avoid a noisy local-server 404.",
    run: async () => {
      const template = await readText("assets/template.html");
      return template.includes('<link rel="icon" href="data:image/svg+xml,')
        ? pass()
        : fail("Missing embedded data-URL favicon.");
    },
  },
  {
    id: "dashboard-next-action-and-portfolio",
    file: "assets/template.html, lib/dashboard-view-model.mjs",
    description: "The dashboard exposes a next-best-action rail and experiment portfolio guidance.",
    run: async () => {
      const template = await readText("assets/template.html");
      const viewModel = await readText("lib/dashboard-view-model.mjs");
      return includesAll(`${template}\n${viewModel}`, [
        "Next best action",
        "nextBestAction",
        "Experiment portfolio",
        "lanePortfolio",
        "plateau",
      ])
        ? pass()
        : fail("Dashboard is missing next-best-action or portfolio/plateau surfaces.");
    },
  },
  {
    id: "last-run-packet-safety",
    file: "scripts/autoresearch.mjs, tests/autoresearch-cli.test.mjs",
    description: "Last-run packets are cleared after logging and stale packets are rejected.",
    run: async () => {
      const cli = await readText("scripts/autoresearch.mjs");
      const tests = await readText("tests/autoresearch-cli.test.mjs");
      return includesAll(`${cli}\n${tests}`, [
        "deleteLastRunPacket",
        "assertFreshLastRunPacket",
        "status is required; choose keep or discard explicitly",
        "stale last-run packets are rejected",
      ])
        ? pass()
        : fail("Last-run packet safety behavior is not implemented and tested.");
    },
  },
  {
    id: "full-product-cli-surface",
    file: "scripts/autoresearch.mjs",
    description: "CLI and MCP expose guided setup, recipes, gap candidates, finalization preview, live mode, and integrations.",
    run: async () => {
      const cli = await readText("scripts/autoresearch.mjs");
      const cliHandlers = await readText("lib/cli-handlers.mjs");
      const mcpInterface = await readText("lib/mcp-interface.mjs");
      return includesAll(cli + cliHandlers + mcpInterface, [
        "setup-plan --cwd <project>",
        "recipes list|show",
        "gap-candidates --cwd <project>",
        "finalize-preview --cwd <project>",
        "serve --cwd <project>",
        "integrations list|doctor|sync-recipes",
        "setup_plan",
        "gap_candidates",
        "finalize_preview",
      ])
        ? pass()
        : fail("Missing one or more full-product CLI/MCP surfaces.");
    },
  },
  {
    id: "full-product-lib-boundaries",
    file: "lib/*.mjs",
    description: "New product tracks live behind explicit lib module boundaries.",
    run: async () => {
      const files = [
        "lib/session-core.mjs",
        "lib/runner.mjs",
        "lib/cli-handlers.mjs",
        "lib/mcp-interface.mjs",
        "lib/recipes.mjs",
        "lib/dashboard-view-model.mjs",
        "lib/research-gaps.mjs",
        "lib/finalize-preview.mjs",
        "lib/live-server.mjs",
        "lib/integrations.mjs",
      ];
      for (const file of files) await readText(file);
      return pass();
    },
  },
  {
    id: "full-product-docs",
    file: "README.md, commands/autoresearch.md, skills/*.md",
    description: "Public docs describe recipes, setup-plan, gap candidates, finalization preview, live actions, and integrations.",
    run: async () => {
      const readme = await readText("README.md");
      const command = await readText("commands/autoresearch.md");
      const dashboard = await readText("skills/autoresearch-dashboard/SKILL.md");
      return includesAll(readme + command + dashboard, [
        "setup-plan",
        "gap-candidates",
        "finalize-preview",
        "safe live actions",
        "confirmed log decisions",
        "Recipes and integrations",
      ])
        ? pass()
        : fail("Docs are missing full-product workflow terms.");
    },
  },
  {
    id: "full-product-tests",
    file: "tests/full-product.test.mjs",
    description: "Regression tests cover the full product tracks.",
    run: async () => {
      const test = await readText("tests/full-product.test.mjs");
      return includesAll(test, [
        "session core",
        "runner parses metrics",
        "catalog recipes can drive setup-plan",
        "setup-plan",
        "gap-candidates",
        "finalize-preview",
        "integrations",
        "live server",
      ])
        ? pass()
        : fail("Missing focused full-product regression tests.");
    },
  },
];

const results = [];
for (const check of checks) {
  try {
    const outcome = await check.run();
    results.push({ ...check, ...outcome });
  } catch (error) {
    results.push({ ...check, ok: false, message: error.message || String(error) });
  }
}

const failed = results.filter((result) => !result.ok);
const passed = results.length - failed.length;

console.log("Codex Autoresearch perfection benchmark");
console.log(`Root: ${pluginRoot}`);
console.log(`Passed: ${passed}/${results.length}`);
if (failed.length > 0) {
  console.log("Gaps:");
  for (const result of failed) {
    console.log(`- ${result.id}: ${result.description}`);
    console.log(`  file: ${result.file}`);
    console.log(`  detail: ${result.message}`);
  }
} else {
  console.log("No gaps found.");
}
console.log(`METRIC quality_gap=${failed.length}`);
console.log(`METRIC quality_checks=${results.length}`);
console.log(`METRIC quality_passed=${passed}`);

if (process.argv.includes("--fail-on-gap") && failed.length > 0) {
  process.exitCode = 1;
}
