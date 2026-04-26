#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePackageRoot, resolveRepoRoot } from "../lib/runtime-paths.js";
import { PLUGIN_VERSION } from "../lib/plugin-version.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const repoRoot = resolveRepoRoot(import.meta.url);

async function readText(file) {
  return await fsp.readFile(path.join(pluginRoot, file), "utf8");
}

async function readOptionalText(file) {
  try {
    return await readText(file);
  } catch {
    return "";
  }
}

async function readDashboardSurface() {
  const files = [
    "assets/template.html",
    ...(await listDashboardSourceFiles()),
    "assets/dashboard-build/dashboard-app.js",
    "assets/dashboard-build/dashboard-app.css",
  ];
  const parts = await Promise.all(files.map(readOptionalText));
  return parts.join("\n");
}

async function listDashboardSourceFiles(dir = "dashboard/src") {
  const absoluteDir = path.join(pluginRoot, dir);
  const entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(dir, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) return listDashboardSourceFiles(child);
      if (/\.(css|js|jsx|ts|tsx)$/.test(entry.name)) return [child];
      return [];
    }),
  );
  return files.flat().sort();
}

async function readRootText(file) {
  return await fsp.readFile(path.join(repoRoot, file), "utf8");
}

async function readJson(file) {
  return JSON.parse(await readText(file));
}

async function fileExists(file) {
  try {
    await fsp.access(path.join(pluginRoot, file));
    return true;
  } catch {
    return false;
  }
}

async function markdownFilesUnder(dir) {
  const absolute = path.join(pluginRoot, dir);
  try {
    const entries = await fsp.readdir(absolute, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function skillFiles() {
  const skillsRoot = path.join(pluginRoot, "skills");
  const found = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.name === "SKILL.md")
        found.push(path.relative(pluginRoot, next).replaceAll(path.sep, "/"));
    }
  }
  await walk(skillsRoot);
  return found.sort();
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
    file: "package.json, .codex-plugin/plugin.json, scripts/autoresearch.mjs, scripts/autoresearch-mcp.mjs, scripts/autoresearch.ts, scripts/autoresearch-mcp.ts",
    description: "All public version surfaces expose the same plugin version.",
    run: async () => {
      const pkg = await readJson("package.json");
      const manifest = await readJson(".codex-plugin/plugin.json");
      const cli = await readText("scripts/autoresearch.ts");
      const mcp = await readText("scripts/autoresearch-mcp.ts");
      const cliVersionBound =
        cli.includes('from "../lib/plugin-version.js"') &&
        /pluginVersion:\s*PLUGIN_VERSION/.test(cli) &&
        /serverInfo:\s*\{\s*name:\s*"codex-autoresearch",\s*version:\s*PLUGIN_VERSION/.test(cli);
      const mcpVersionBound =
        mcp.includes('from "../lib/plugin-version.js"') &&
        /serverInfo:\s*\{\s*name:\s*"codex-autoresearch",\s*version:\s*PLUGIN_VERSION/.test(mcp);
      if (
        pkg.version === manifest.version &&
        pkg.version === PLUGIN_VERSION &&
        cliVersionBound &&
        mcpVersionBound
      )
        return pass();
      return fail(
        `package=${pkg.version}, manifest=${manifest.version}, CLI version-bound=${cliVersionBound}, MCP version-bound=${mcpVersionBound}, shared=${PLUGIN_VERSION}`,
      );
    },
  },
  {
    id: "local-mcp-config",
    file: ".mcp.json",
    description:
      "The local MCP server starts through the lightweight entrypoint and exposes the one-packet next flow.",
    run: async () => {
      const config = await readJson(".mcp.json");
      const server = config.mcpServers?.["codex-autoresearch"];
      if (!server) return fail("codex-autoresearch MCP server is missing");
      const args = Array.isArray(server.args) ? server.args.join(" ") : "";
      const note = String(server.note || "");
      if (
        server.cwd === "." &&
        args.includes("./scripts/autoresearch-mcp.mjs") &&
        Number(server.startup_timeout_sec) >= 30 &&
        note.includes("next_experiment") &&
        note.includes("setup_research_session") &&
        note.includes("measure_quality_gap")
      ) {
        return pass();
      }
      return fail(
        "MCP config should use cwd='.', the lightweight startup script, startup_timeout_sec, and mention next_experiment plus research tools.",
      );
    },
  },
  {
    id: "single-skill-surface",
    file: "skills/codex-autoresearch/SKILL.md, skills/codex-autoresearch/agents/openai.yaml",
    description: "The plugin exposes one Codex-facing skill and no duplicate command docs.",
    run: async () => {
      const files = await skillFiles();
      const commandMarkdown = await markdownFilesUnder("commands");
      const skill = await readText("skills/codex-autoresearch/SKILL.md");
      const agents = await readText("skills/codex-autoresearch/agents/openai.yaml");
      if (
        files.length === 1 &&
        files[0] === "skills/codex-autoresearch/SKILL.md" &&
        commandMarkdown.length === 0 &&
        skill.includes("name: codex-autoresearch") &&
        skill.includes("only Codex-facing skill") &&
        agents.includes('display_name: "Codex Autoresearch"')
      ) {
        return pass();
      }
      return fail(`skillFiles=${files.join(",")}; commandMarkdown=${commandMarkdown.join(",")}`);
    },
  },
  {
    id: "root-readme-only",
    file: "../../README.md, README.md",
    description: "The root README is the only README and acts as the public product front door.",
    run: async () => {
      const root = await readRootText("README.md");
      const pluginReadmeExists = await fileExists("README.md");
      const demoReadmeExists = await fileExists("examples/demo-session/README.md");
      return !pluginReadmeExists &&
        !demoReadmeExists &&
        includesAll(root, [
          "## Install",
          "## Try it",
          "Use $Codex Autoresearch",
          "## Dashboard",
          "## Docs",
          "![Codex Autoresearch live dashboard",
          "plugins/codex-autoresearch/assets/showcase/dashboard-demo.png",
          "plugins/codex-autoresearch/docs/index.md",
          "plugins/codex-autoresearch/docs/workflows.md",
          "plugins/codex-autoresearch/docs/architecture.md",
          "plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md",
        ]) &&
        !root.includes("static report screenshot") &&
        !root.includes("Static read-only export")
        ? pass()
        : fail(
            pluginReadmeExists || demoReadmeExists
              ? "A non-root README still exists."
              : "Root README is missing the public product workflow, live dashboard screenshot, demo, or docs links.",
          );
    },
  },
  {
    id: "root-changelog-maintained",
    file: "../../CHANGELOG.md, ../../README.md, AGENTS.md",
    description:
      "User-facing plugin changes are recorded in a root changelog with migration notes.",
    run: async () => {
      const changelog = await readRootText("CHANGELOG.md");
      const readme = await readRootText("README.md");
      const agents = await readRootText("AGENTS.md");
      const releasedNotesPresent = includesAll(changelog, [
        "## 1.0.1",
        "source downloads now include the compiled TypeScript runtime",
        "tracked `dist/` runtime",
        "## 1.0.0",
        "prompt-plan",
        "prompt_plan",
        "workflow and architecture diagram docs",
        "Bumped public package",
        "Static dashboard exports remain read-only snapshots",
      ]);
      const unreleasedNotesOk =
        !changelog.includes("## Unreleased") ||
        includesAll(changelog, ["Clarified licensing", "explicit Apache-2.0 terms"]);
      return releasedNotesPresent &&
        unreleasedNotesOk &&
        includesAll(readme, ["## Changelog", "CHANGELOG.md"]) &&
        includesAll(agents, [
          "root `CHANGELOG.md`",
          "Removed invocation surfaces need migration notes",
        ])
        ? pass()
        : fail(
            "Root changelog or changelog guidance is missing the current user-facing migration notes.",
          );
    },
  },
  {
    id: "docs-split-and-showcase",
    file: "../../README.md, docs/*.md, examples/, assets/showcase/",
    description:
      "Detailed guidance lives in focused docs while README surfaces the live dashboard demo.",
    run: async () => {
      const readme = await readRootText("README.md");
      const docs = await Promise.all([
        readText("docs/index.md"),
        readText("docs/concepts.md"),
        readText("docs/start.md"),
        readText("docs/walkthrough.md"),
        readText("docs/operate.md"),
        readText("docs/trust.md"),
        readText("docs/workflows.md"),
        readText("docs/architecture.md"),
        readText("docs/mcp-tools.md"),
        readText("docs/maintainers.md"),
        readText("examples/index.md"),
        readText("examples/demo-session/demo.md"),
        readText("assets/showcase/showcase.md"),
      ]);
      const joined = docs.join("\n");
      const screenshotExists = await fileExists("assets/showcase/dashboard-demo.png");
      const demoExport = await readText("examples/demo-session/autoresearch-dashboard.html");
      const demoJsonl = await readText("examples/demo-session/autoresearch.jsonl");
      const demoRuns = demoJsonl
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith('{"run":')).length;
      return screenshotExists &&
        demoRuns === 100 &&
        !demoExport.includes("C:\\Users\\alber") &&
        !demoExport.includes("C:\\Program Files") &&
        !readme.includes("```mermaid") &&
        includesAll(readme, ["Docs index", "dashboard-demo.png"]) &&
        includesAll(joined, [
          "Workflow Diagrams",
          "Architecture Diagrams",
          "METRIC name=value",
          "quality_gap",
          "prompt_plan",
          "serve_dashboard",
          "gap-candidates",
          "finalize-preview",
          "Use CLI or MCP for actions and logging",
          "Tool calls return structured content",
          "specification-delight-roadmap",
        ])
        ? pass()
        : fail("Docs split, visual docs, live demo, or scrubbed demo export is incomplete.");
    },
  },
  {
    id: "ax-ux-golden-path",
    file: "../../README.md, skills/codex-autoresearch/SKILL.md",
    description: "Docs make AX and UX first-class plugin paths.",
    run: async () => {
      const readme = await readRootText("README.md");
      const skill = await readText("skills/codex-autoresearch/SKILL.md");
      return includesAll(`${readme}\n${skill}`, [
        "AX",
        "AI experience",
        "UX",
        "user experience",
        "one skill surface",
        "live dashboard URL",
      ])
        ? pass()
        : fail("AX/UX golden path guidance is incomplete.");
    },
  },
  {
    id: "main-skill-start-resume",
    file: "skills/codex-autoresearch/SKILL.md",
    description:
      "The main skill owns start/resume setup, dashboard handoff, active loop, and Git safety.",
    run: async () => {
      const skill = await readText("skills/codex-autoresearch/SKILL.md");
      return includesAll(skill, [
        "## Start Or Resume",
        "setup_plan",
        "setup_session",
        "doctor_session",
        "directly provide the live dashboard URL",
        "session start and resume",
        "http://127.0.0.1:<port>/",
        "## Active Loop Contract",
        "continuation.shouldContinue",
        "continuation.forbidFinalAnswer",
        "commitPaths",
      ])
        ? pass()
        : fail("Main skill is missing setup, dashboard, continuation, or scoped Git guidance.");
    },
  },
  {
    id: "main-skill-research-dashboard-finalize",
    file: "skills/codex-autoresearch/SKILL.md",
    description: "The main skill includes deep research, dashboard, and finalization workflows.",
    run: async () => {
      const skill = await readText("skills/codex-autoresearch/SKILL.md");
      return includesAll(skill, [
        "## Deep Research Loops",
        "autoresearch.research/<slug>/",
        "sources.md",
        "synthesis.md",
        "quality_gap=0 only means",
        "filter hallucinations",
        "## Dashboard",
        "serve_dashboard",
        "Static exports are read-only",
        "## Finalize",
        "finalize_preview",
        "Runway order",
      ])
        ? pass()
        : fail("Main skill is missing research, dashboard, or finalization guidance.");
    },
  },
  {
    id: "active-loop-continuation-contract",
    file: "../../README.md, skills/codex-autoresearch/SKILL.md, scripts/autoresearch.mjs, lib/mcp-interface.mjs, lib/mcp-tool-schemas.ts",
    description:
      "Owner-autonomous loops expose and document a machine-readable continuation contract after each packet.",
    run: async () => {
      const readme = await readRootText("README.md");
      const skill = await readText("skills/codex-autoresearch/SKILL.md");
      const cli = await readText("scripts/autoresearch.ts");
      const mcp = `${await readText("lib/mcp-interface.ts")}\n${await readText("lib/mcp-tool-schemas.ts")}`;
      return includesAll(`${readme}\n${skill}\n${cli}\n${mcp}`, [
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
    id: "research-cli-and-mcp",
    file: "scripts/autoresearch.mjs, lib/mcp-interface.mjs, lib/mcp-tool-schemas.ts",
    description: "CLI help and MCP schema expose research setup and quality-gap measurement.",
    run: async () => {
      const cli = await readText("scripts/autoresearch.ts");
      const mcp = `${await readText("lib/mcp-interface.ts")}\n${await readText("lib/mcp-tool-schemas.ts")}`;
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
    description:
      "The session template captures stop conditions, research notes, and decision rules.",
    run: async () => {
      const template = await readText("assets/autoresearch.md.template");
      return includesAll(template, ["## Decision Rules", "## Stop Conditions", "## Research Notes"])
        ? pass()
        : fail("Session template lacks durable decision and stop-condition sections.");
    },
  },
  {
    id: "manifest-single-skill-prompts",
    file: ".codex-plugin/plugin.json",
    description: "Marketplace prompts point to the plugin, not subskills or slash commands.",
    run: async () => {
      const manifest = await readJson(".codex-plugin/plugin.json");
      const prompts = manifest.interface?.defaultPrompt || [];
      const promptText = prompts.join("\n");
      return prompts.length <= 3 &&
        prompts.every((prompt) => prompt.length < 128) &&
        includesAll(promptText, [
          "Use Codex Autoresearch to improve this repo.",
          "Plan an Autoresearch loop from this prompt.",
          "Open the live dashboard and continue.",
        ]) &&
        manifest.interface?.longDescription?.includes("one skill surface")
        ? pass()
        : fail("Default prompts should be concise plugin-level starters.");
    },
  },
  {
    id: "release-tarball-runtime",
    file: ".gitignore, package.json, scripts/*.mjs, .github/workflows/release.yml",
    description:
      "Source checkouts keep generated dist out of Git while release tarballs include the built runtime used by public launchers.",
    run: async () => {
      const gitignore = await readText(".gitignore");
      const ignoresDist = gitignore
        .split(/\r?\n/)
        .map((line) => line.trim())
        .some((line) => line === "dist/" || line === "/dist/" || line === "dist");
      const pkg = await readJson("package.json");
      const packageFiles = (pkg.files || []).join("\n");
      const autoresearchLauncher = await readText("scripts/autoresearch.mjs");
      const mcpLauncher = await readText("scripts/autoresearch-mcp.mjs");
      const bootstrap = await readText("scripts/bootstrap-runtime.mjs");
      const release = await readRootText(".github/workflows/release.yml");
      const tagPushTrigger = /push:\s*\n\s*tags:/m.test(release);
      return ignoresDist &&
        !tagPushTrigger &&
        includesAll(packageFiles, [
          "dist/lib/",
          "dist/scripts/",
          "scripts/*.mjs",
          ".codex-plugin/",
          ".mcp.json",
        ]) &&
        autoresearchLauncher.includes("./bootstrap-runtime.mjs") &&
        autoresearchLauncher.includes('ensureRuntime("autoresearch.mjs"') &&
        mcpLauncher.includes("./bootstrap-runtime.mjs") &&
        mcpLauncher.includes('ensureRuntime("autoresearch-mcp.mjs"') &&
        includesAll(bootstrap, [
          "github.com/TheGreenCedar/codex-autoresearch/releases/download",
          'codex-autoresearch-${version.replace(/^v/, "")}.tgz',
          "package.json",
          "tar",
          "dist",
        ]) &&
        includesAll(release, [
          "workflow_dispatch:",
          "gh release create",
          '--target "$GITHUB_SHA"',
          "npm pack",
          "mcp-smoke",
          "codex-autoresearch-${VERSION}.tgz",
        ])
        ? pass()
        : fail(
            "Release tarball runtime contract is incomplete: dist should be ignored in Git, package files should include built dist, launchers should bootstrap missing dist from the matching GitHub release tarball, and release CI should smoke the tarball before creating the release tag.",
          );
    },
  },
  {
    id: "session-artifacts-ignored",
    file: ".gitignore",
    description:
      "Repo-local autoresearch session artifacts stay out of product commits by default.",
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
    file: "scripts/finalize-autoresearch.mjs, scripts/finalize-autoresearch.ts",
    description: "Finalization excludes deep research scratchpads from review branches.",
    run: async () => {
      const finalizer = await readText("scripts/finalize-autoresearch.ts");
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
    file: "package.json, scripts/check.mjs, scripts/check.ts",
    description: "npm run check fails when the plugin's own quality_gap benchmark regresses.",
    run: async () => {
      const pkg = await readJson("package.json");
      const checkScript = await readText("scripts/check.ts");
      return String(pkg.scripts?.["check:product"] || "").includes("scripts/check.mjs") &&
        checkScript.includes("perfection-benchmark.mjs") &&
        checkScript.includes("--fail-on-gap")
        ? pass()
        : fail(
            "package check does not run scripts/check.mjs with perfection-benchmark --fail-on-gap.",
          );
    },
  },
  {
    id: "quality-gate-tested",
    file: "tests/perfection-benchmark.test.ts",
    description: "The self-benchmark is covered by the Node test suite.",
    run: async () => {
      try {
        const test = await readText("tests/perfection-benchmark.test.ts");
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
    file: "assets/template.html, dashboard/src/main.tsx",
    description:
      "The dashboard uses real labels for form controls and avoids decorative label tags.",
    run: async () => {
      const template = await readDashboardSurface();
      const labelCount = (template.match(/<label\b/g) || []).length;
      if (
        labelCount >= 4 &&
        (template.includes('<label for="segment-select">') ||
          template.includes('htmlFor="segment-select"') ||
          template.includes("htmlFor:`segment-select`")) &&
        template.includes('htmlFor="log-decision-status"') &&
        template.includes('htmlFor="log-decision-description"') &&
        template.includes('htmlFor="log-decision-asi"') &&
        template.includes("score-label") &&
        template.includes("readout-label") &&
        !template.includes("<label>Best kept change</label>")
      ) {
        return pass();
      }
      return fail(
        `Expected segment and log form labels without decorative label tags; found ${labelCount}.`,
      );
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
    id: "dashboard-practical-chart",
    file: "assets/template.html, dashboard/src/main.tsx",
    description:
      "The dashboard uses a library-backed practical run chart with status legend, baseline, best, latest, run ticks, tooltip, and accessible summary.",
    run: async () => {
      const template = await readDashboardSurface();
      return includesAll(template, [
        "chart-legend",
        "legend-swatch",
        "win-zone",
        "best-line",
        "latest-halo",
        "chartRunTicks",
        "ResponsiveContainer",
        "LineChart",
        "Tooltip",
        "ReferenceLine",
        "buildChart",
        "Baseline-normalized metric trend",
        "formatChartRunValue",
        "trend-chart-summary",
      ])
        ? pass()
        : fail("Dashboard chart is missing practical run-chart affordances.");
    },
  },
  {
    id: "dashboard-does-not-narrate-itself",
    file: "assets/template.html, dashboard/src/main.tsx, lib/dashboard-view-model.ts",
    description: "Dashboard copy is operational, not explanatory placeholder text.",
    run: async () => {
      const template = await readDashboardSurface();
      const viewModel = await readText("lib/dashboard-view-model.ts");
      const combined = `${template}\n${viewModel}`;
      const banned = [
        "Codex will summarize",
        "Generated from runs, ASI",
        "Generated summary",
        "what happened and what it plans",
      ];
      return banned.every((phrase) => !combined.includes(phrase)) &&
        includesAll(combined, ["Current readout", "Next move", "Ledger, ASI"])
        ? pass()
        : fail("Dashboard still contains placeholder or explanatory narration.");
    },
  },
  {
    id: "dashboard-next-action-and-portfolio",
    file: "assets/template.html, dashboard/src/main.tsx, lib/dashboard-view-model.ts",
    description:
      "The dashboard keeps the chart, operator readout, and experiment portfolio guidance visible.",
    run: async () => {
      const template = await readDashboardSurface();
      const viewModel = await readText("lib/dashboard-view-model.ts");
      return includesAll(`${template}\n${viewModel}`, [
        "Metric trajectory",
        "Run log",
        "ledger-scroll",
        "Codex brief",
        "aiSummary",
        "Next action",
        "nextBestAction",
        "Session memory",
        "lanePortfolio",
        "plateau",
      ])
        ? pass()
        : fail("Dashboard is missing chart, next-action, or portfolio/plateau surfaces.");
    },
  },
  {
    id: "last-run-packet-safety",
    file: "scripts/autoresearch.mjs, tests/autoresearch-cli.test.ts",
    description: "Last-run packets are cleared after logging and stale packets are rejected.",
    run: async () => {
      const cli = await readText("scripts/autoresearch.ts");
      const tests = await readText("tests/autoresearch-cli.test.ts");
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
    file: "scripts/autoresearch.mjs, lib/cli-handlers.mjs, lib/mcp-interface.mjs, lib/mcp-tool-schemas.ts",
    description:
      "CLI and MCP expose guided setup, recipes, gap candidates, finalization preview, live mode, and integrations.",
    run: async () => {
      const cli = await readText("scripts/autoresearch.ts");
      const cliHandlers = await readText("lib/cli-handlers.ts");
      const mcpInterface = `${await readText("lib/mcp-interface.ts")}\n${await readText("lib/mcp-tool-schemas.ts")}`;
      return includesAll(cli + cliHandlers + mcpInterface, [
        "setup-plan --cwd <project>",
        "prompt-plan --cwd <project>",
        "onboarding-packet --cwd <project>",
        "recommend-next --cwd <project>",
        "recipes list|show|recommend",
        "benchmark-lint --cwd <project>",
        "checks-inspect --cwd <project>",
        "new-segment --cwd <project>",
        "gap-candidates --cwd <project>",
        "finalize-preview --cwd <project>",
        "serve --cwd <project>",
        "integrations list|doctor|sync-recipes",
        "setup_plan",
        "prompt_plan",
        "onboarding_packet",
        "recommend_next",
        "serve_dashboard",
        "benchmark_lint",
        "checks_inspect",
        "new_segment",
        "gap_candidates",
        "finalize_preview",
      ])
        ? pass()
        : fail("Missing one or more full-product CLI/MCP surfaces.");
    },
  },
  {
    id: "full-product-lib-boundaries",
    file: "lib/*.ts",
    description: "Product tracks live behind explicit lib module boundaries.",
    run: async () => {
      const files = [
        "lib/session-core.ts",
        "lib/runner.ts",
        "lib/cli-handlers.ts",
        "lib/mcp-interface.ts",
        "lib/mcp-tool-schemas.ts",
        "lib/mcp-cli-adapter.ts",
        "lib/recipes.ts",
        "lib/dashboard-view-model.ts",
        "lib/research-gaps.ts",
        "lib/finalize-preview.ts",
        "lib/live-server.ts",
        "lib/integrations.ts",
      ];
      for (const file of files) await readText(file);
      return pass();
    },
  },
  {
    id: "full-product-docs",
    file: "../../README.md, skills/codex-autoresearch/SKILL.md",
    description:
      "Public docs describe recipes, setup-plan, gap candidates, finalization preview, visual dashboard use, and integrations through the single skill.",
    run: async () => {
      const readme = await readRootText("README.md");
      const skill = await readText("skills/codex-autoresearch/SKILL.md");
      return includesAll(readme + skill, [
        "setup-plan",
        "onboarding-packet",
        "recommend-next",
        "benchmark-lint",
        "checks-inspect",
        "new-segment",
        "gap-candidates",
        "finalize-preview",
        "visual aid",
        "Use CLI or MCP",
        "serve_dashboard",
        "recipes",
      ])
        ? pass()
        : fail("Docs are missing full-product workflow terms.");
    },
  },
  {
    id: "full-product-tests",
    file: "tests/full-product.test.ts",
    description: "Regression tests cover the full product tracks.",
    run: async () => {
      const test = await readText("tests/full-product.test.ts");
      return includesAll(test, [
        "session core",
        "runner parses metrics",
        "catalog recipes can drive setup-plan",
        "delight commands provide compact state",
        "MCP exposes onboarding",
        "setup-plan",
        "gap-candidates",
        "finalize-preview",
        "integrations",
        "live server",
        "serve_dashboard",
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
