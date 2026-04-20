#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readText(file) {
  return await fsp.readFile(path.join(pluginRoot, file), "utf8");
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
    file: "package.json, .codex-plugin/plugin.json, scripts/autoresearch.mjs",
    description: "All public version surfaces expose the same plugin version.",
    run: async () => {
      const pkg = await readJson("package.json");
      const manifest = await readJson(".codex-plugin/plugin.json");
      const cli = await readText("scripts/autoresearch.mjs");
      const serverVersion = cli.match(/serverInfo:\s*\{\s*name:\s*"codex-autoresearch",\s*version:\s*"([^"]+)"/s)?.[1];
      if (pkg.version === manifest.version && pkg.version === serverVersion) return pass();
      return fail(`package=${pkg.version}, manifest=${manifest.version}, server=${serverVersion || "(missing)"}`);
    },
  },
  {
    id: "local-mcp-config",
    file: ".mcp.json",
    description: "The local MCP server starts from the plugin root and exposes the one-packet next flow.",
    run: async () => {
      const config = await readJson(".mcp.json");
      const server = config.mcpServers?.["codex-autoresearch"];
      if (!server) return fail("codex-autoresearch MCP server is missing");
      const args = Array.isArray(server.args) ? server.args.join(" ") : "";
      if (server.cwd === "." && args.includes("./scripts/autoresearch.mjs") && args.includes("--mcp") && String(server.note || "").includes("next_experiment")) {
        return pass();
      }
      return fail("MCP config should use cwd='.', the local script, --mcp, and mention next_experiment");
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
        "deep-research-orchestration",
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
        "Research-heavy prompts",
        "Study my project",
        "delightful",
        "qualitative gap",
      ])
        ? pass()
        : fail("Missing the qualitative prompt-to-metric loop.");
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
        "quality_gap",
      ])
        ? pass()
        : fail("Command docs do not explicitly prefer the local plugin and quality_gap loops.");
    },
  },
  {
    id: "create-skill-research-loop",
    file: "skills/autoresearch-create/SKILL.md",
    description: "Create skill explains Codex + GPT-5.4 qualitative research loops.",
    run: async () => {
      const skill = await readText("skills/autoresearch-create/SKILL.md");
      return includesAll(skill, [
        "Codex + GPT-5.4",
        "deep-research-orchestration",
        "quality_gap",
        "repo-local plugin",
      ])
        ? pass()
        : fail("Create skill does not cover qualitative research-loop setup.");
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
    description: "Marketplace default prompts include the deep-research delight workflow.",
    run: async () => {
      const manifest = await readJson(".codex-plugin/plugin.json");
      const prompts = (manifest.interface?.defaultPrompt || []).join("\n");
      return includesAll(prompts, [
        "deep-research-orchestration",
        "Study my project",
        "delightful",
      ])
        ? pass()
        : fail("Default prompts do not surface the deep-research delight workflow.");
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
      ])
        ? pass()
        : fail("Root session artifacts are not ignored.");
    },
  },
  {
    id: "quality-gate-in-checks",
    file: "package.json",
    description: "npm run check fails when the plugin's own quality_gap benchmark regresses.",
    run: async () => {
      const pkg = await readJson("package.json");
      return String(pkg.scripts?.check || "").includes("perfection-benchmark.mjs --fail-on-gap")
        ? pass()
        : fail("package check does not run perfection-benchmark with --fail-on-gap.");
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
