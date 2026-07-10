#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePackageRoot, resolveRepoRoot } from "../lib/runtime-paths.js";
import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import { parseJsonlRecords } from "../lib/session-records.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const repoRoot = resolveRepoRoot(import.meta.url);

type LooseObject = Record<string, any>;
type CheckResult = { ok: boolean; message: string };

async function readText(file: string): Promise<string> {
  return await fsp.readFile(path.join(pluginRoot, file), "utf8");
}

async function readRootText(file: string): Promise<string> {
  return await fsp.readFile(path.join(repoRoot, file), "utf8");
}

async function readJson(file: string): Promise<LooseObject> {
  return JSON.parse(await readText(file));
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fsp.access(path.join(pluginRoot, file));
    return true;
  } catch {
    return false;
  }
}

async function readPngDimensions(file: string): Promise<{ width: number; height: number } | null> {
  const buffer = await fsp.readFile(path.join(pluginRoot, file));
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function markdownFilesUnder(dir: string): Promise<string[]> {
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

async function skillFiles(): Promise<string[]> {
  const skillsRoot = path.join(pluginRoot, "skills");
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
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

async function markdownFilesRecursively(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const next = path.join(root, entry.name);
      if (entry.isDirectory()) return await markdownFilesRecursively(next);
      return entry.isFile() && entry.name.endsWith(".md") ? [next] : [];
    }),
  );
  return nested.flat().sort();
}

function markdownAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = stripHtmlTags(match[1])
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const duplicate = seen.get(base) || 0;
    seen.set(base, duplicate + 1);
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }
  return anchors;
}

function stripHtmlTags(value: string): string {
  let output = "";
  let insideTag = false;
  for (const character of value) {
    if (character === "<") {
      insideTag = true;
    } else if (character === ">") {
      insideTag = false;
    } else if (!insideTag) {
      output += character;
    }
  }
  return output;
}

async function markdownLinkProblems(): Promise<string[]> {
  const files = [
    path.join(repoRoot, "README.md"),
    ...(await markdownFilesRecursively(path.join(pluginRoot, "docs"))),
    ...(await markdownFilesRecursively(path.join(pluginRoot, "skills"))),
  ];
  const problems: string[] = [];
  const contentCache = new Map<string, string>();
  const anchorCache = new Map<string, Set<string>>();
  for (const file of files) {
    const content = await fsp.readFile(file, "utf8");
    contentCache.set(file, content);
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, "");
      if (/^(?:https?:|mailto:)/i.test(rawTarget)) continue;
      const hashIndex = rawTarget.indexOf("#");
      const rawPath = hashIndex >= 0 ? rawTarget.slice(0, hashIndex) : rawTarget;
      const rawAnchor = hashIndex >= 0 ? rawTarget.slice(hashIndex + 1) : "";
      const targetFile = rawPath ? path.resolve(path.dirname(file), rawPath) : file;
      try {
        await fsp.access(targetFile);
      } catch {
        problems.push(`${path.relative(repoRoot, file)} -> ${rawTarget}`);
        continue;
      }
      if (!rawAnchor || path.extname(targetFile).toLowerCase() !== ".md") continue;
      let anchors = anchorCache.get(targetFile);
      if (!anchors) {
        const targetContent =
          contentCache.get(targetFile) || (await fsp.readFile(targetFile, "utf8"));
        anchors = markdownAnchors(targetContent);
        anchorCache.set(targetFile, anchors);
      }
      let anchor = rawAnchor.toLowerCase();
      try {
        anchor = decodeURIComponent(anchor);
      } catch {
        // Keep the raw anchor so the invalid link is reported below.
      }
      if (!anchors.has(anchor)) {
        problems.push(`${path.relative(repoRoot, file)} -> ${rawTarget}`);
      }
    }
  }
  return problems;
}

function includesAll(text: string, values: string[]): boolean {
  return values.every((value) => text.includes(value));
}

function fail(message: string): CheckResult {
  return { ok: false, message };
}

function pass(message = ""): CheckResult {
  return { ok: true, message };
}

const checks = [
  {
    id: "version-sync",
    file: "package.json, .codex-plugin/plugin.json, scripts/autoresearch.mjs, scripts/autoresearch.ts",
    description: "All public version surfaces expose the same plugin version.",
    run: async () => {
      const pkg = await readJson("package.json");
      const manifest = await readJson(".codex-plugin/plugin.json");
      const cli = await readText("scripts/autoresearch.ts");
      const cliVersionBound =
        cli.includes('from "../lib/plugin-version.js"') &&
        /pluginVersion:\s*PLUGIN_VERSION/.test(cli);
      if (pkg.version === manifest.version && pkg.version === PLUGIN_VERSION && cliVersionBound)
        return pass();
      return fail(
        `package=${pkg.version}, manifest=${manifest.version}, CLI version-bound=${cliVersionBound}, shared=${PLUGIN_VERSION}`,
      );
    },
  },
  {
    id: "no-mcp-surface",
    file: ".codex-plugin/plugin.json, package.json, scripts/autoresearch.ts",
    description: "The plugin is CLI/skill-only and does not declare an MCP server.",
    run: async () => {
      const manifest = await readJson(".codex-plugin/plugin.json");
      const pkg = await readJson("package.json");
      const cli = await readText("scripts/autoresearch.ts");
      const noConfig = !(await fileExists(".mcp.json"));
      const packageFiles = (pkg.files || []).join("\n");
      return noConfig &&
        !manifest.mcpServers &&
        !packageFiles.includes(".mcp.json") &&
        !cli.includes("mcp-smoke") &&
        !cli.includes("--mcp")
        ? pass()
        : fail("MCP declaration, package entry, or CLI server command is still present.");
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
      const requiredSkillFiles = [
        "skills/codex-autoresearch/agents/openai.yaml",
        "skills/codex-autoresearch/references/loop-operations.md",
        "skills/codex-autoresearch/references/dashboard-trust.md",
        "skills/codex-autoresearch/references/research-finalize.md",
      ];
      const requiredSkillFilesExist = (
        await Promise.all(requiredSkillFiles.map((file) => fileExists(file)))
      ).every(Boolean);
      if (
        files.length === 1 &&
        files[0] === "skills/codex-autoresearch/SKILL.md" &&
        commandMarkdown.length === 0 &&
        requiredSkillFilesExist &&
        /^---\r?\nname: codex-autoresearch\r?\ndescription: .+\r?\n---\r?\n/m.test(skill)
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
      const rootReadme = await readRootText("README.md");
      const pluginReadmeExists = await fileExists("README.md");
      const demoReadmeExists = await fileExists("examples/demo-session/README.md");
      return rootReadme.trim().length > 0 &&
        !pluginReadmeExists &&
        !demoReadmeExists &&
        (await fileExists("docs/index.md"))
        ? pass()
        : fail(
            pluginReadmeExists || demoReadmeExists
              ? "A non-root README still exists."
              : "The root README or docs index is missing.",
          );
    },
  },
  {
    id: "root-changelog-maintained",
    file: "../../CHANGELOG.md, package.json",
    description: "The root changelog has an Unreleased section and the current release heading.",
    run: async () => {
      const changelog = await readRootText("CHANGELOG.md");
      const packageJson = await readJson("package.json");
      const versionHeading = new RegExp(
        `^## ${String(packageJson.version).replaceAll(".", "\\.")} - `,
        "m",
      );
      return /^## Unreleased$/m.test(changelog) && versionHeading.test(changelog)
        ? pass()
        : fail("The root changelog is missing Unreleased or the current package version heading.");
    },
  },
  {
    id: "docs-split-and-showcase",
    file: "../../README.md, docs/*.md, examples/demo-session/autoresearch.jsonl, assets/showcase/",
    description: "The public docs, examples, and showcase assets exist and local links resolve.",
    run: async () => {
      const requiredFiles = [
        "docs/index.md",
        "docs/concepts.md",
        "docs/start.md",
        "docs/walkthrough.md",
        "docs/operate.md",
        "docs/trust.md",
        "docs/finish.md",
        "docs/troubleshooting.md",
        "docs/architecture.md",
        "docs/maintainers.md",
        "examples/index.md",
        "examples/demo-session/demo.md",
        "assets/showcase/showcase.md",
      ];
      const requiredFilesExist = (
        await Promise.all(requiredFiles.map((file) => fileExists(file)))
      ).every(Boolean);
      const screenshotExists = await fileExists("assets/showcase/dashboard-demo.png");
      const screenshotDimensions = screenshotExists
        ? await readPngDimensions("assets/showcase/dashboard-demo.png")
        : null;
      const screenshotIsCompact =
        !!screenshotDimensions &&
        screenshotDimensions.width >= 900 &&
        screenshotDimensions.height / screenshotDimensions.width <= 0.8;
      const demoJsonl = await readText("examples/demo-session/autoresearch.jsonl");
      const demoEntries = parseJsonlRecords(
        demoJsonl,
        path.join(pluginRoot, "examples/demo-session/autoresearch.jsonl"),
      ).filter((entry) => entry.run != null) as Array<{
        run?: number;
        status?: string;
        metric?: number;
        metrics?: { memory_mb?: number };
      }>;
      const demoDashboardSource = await readText("dashboard/src/demoData.ts");
      const demoTour = await readText("examples/demo-session/demo.md");
      const demoBaseline = demoEntries[0];
      const demoFinal = demoEntries.at(-1);
      const baselineSeconds = demoBaseline?.metric;
      const baselineMemory = demoBaseline?.metrics?.memory_mb;
      const finalSeconds = demoFinal?.metric;
      const finalMemory = demoFinal?.metrics?.memory_mb;
      const demoMathValid =
        typeof baselineSeconds === "number" &&
        typeof baselineMemory === "number" &&
        typeof finalSeconds === "number" &&
        typeof finalMemory === "number" &&
        demoFinal?.run === 100 &&
        demoFinal?.status === "keep" &&
        Number(((1 - finalSeconds / baselineSeconds) * 100).toFixed(1)) === 43.8 &&
        Number(
          (
            (1 - (0.7 * finalSeconds) / baselineSeconds - (0.3 * finalMemory) / baselineMemory) *
            100
          ).toFixed(1),
        ) === 24.3;
      const start = await readText("docs/start.md");
      const operate = await readText("docs/operate.md");
      const trust = await readText("docs/trust.md");
      const finish = await readText("docs/finish.md");
      const skill = await readText("skills/codex-autoresearch/SKILL.md");
      const docsContractsValid =
        includesAll(start, [
          "--benchmark-prints-metric false",
          "research-start",
          "status measure",
        ]) &&
        includesAll(operate, [
          "ledger-doctor --cwd <project>",
          'checks-inspect --cwd <project> --command "<checks>"',
          "session-forensics --cwd <project> --session-jsonl <path>",
        ]) &&
        includesAll(trust, [
          "fixedControl",
          "review_required=1",
          "quality_gap=0",
          "--commit <hash>",
        ]) &&
        includesAll(finish, [
          "finalize-preview",
          "finalize-current-tree",
          "current-tree-finalization",
        ]) &&
        includesAll(skill, [
          "continuation.forbidFinalAnswer",
          "quality_gap=0",
          "finalize-current-tree",
          "../../docs/start.md",
          "completionAudit",
          "--commit <hash>",
        ]);
      const linkProblems = await markdownLinkProblems();
      return requiredFilesExist &&
        screenshotExists &&
        screenshotIsCompact &&
        demoEntries.length === 100 &&
        demoBaseline?.run === 1 &&
        demoBaseline?.status === "measure" &&
        demoBaseline?.metric === 10 &&
        demoBaseline?.metrics?.memory_mb === 178 &&
        demoMathValid &&
        includesAll(demoDashboardSource, [
          "BASELINE_SECONDS = 10",
          "BASELINE_MEMORY_MB = 178",
          "FINAL_MEMORY_MB = 216",
          "metricWeights: { time: 0.7, memory: 0.3 }",
        ]) &&
        includesAll(demoTour, ["43.8%", "24.3%"]) &&
        docsContractsValid &&
        linkProblems.length === 0
        ? pass()
        : fail(`Docs structure or links are invalid: ${linkProblems.slice(0, 3).join("; ")}`);
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
    description: "Marketplace prompts point to the plugin by mention without forcing Goal mode.",
    run: async () => {
      const manifest = await readJson(".codex-plugin/plugin.json");
      const prompts = (manifest.interface?.defaultPrompt || []) as string[];
      const promptText = prompts.join("\n");
      return prompts.length <= 3 &&
        prompts.every((prompt) => prompt.length < 128) &&
        includesAll(promptText, [
          "@Codex Autoresearch improve this repo.",
          "@Codex Autoresearch plan a measured loop from this prompt.",
          "@Codex Autoresearch serve the live dashboard when useful.",
        ]) &&
        manifest.interface?.longDescription?.includes("one guided workflow")
        ? pass()
        : fail("Default prompts should be concise plugin-level starters.");
    },
  },
  {
    id: "release-tarball-runtime",
    file: ".gitignore, package.json, scripts/autoresearch.mjs, scripts/bootstrap-runtime.mjs, scripts/directory-swap.mjs, scripts/release-integrity.mjs, .github/workflows/release.yml",
    description:
      "Source checkouts keep generated dist out of Git while release tarballs include the built runtime used by public launchers.",
    run: async () => {
      const gitignore = await readText(".gitignore");
      const ignoresDist = gitignore
        .split(/\r?\n/)
        .map((line) => line.trim())
        .some((line) => line === "dist/" || line === "/dist/" || line === "dist");
      const pkg = await readJson("package.json");
      const packageFileEntries = (pkg.files || []).map(String);
      const packageFiles = packageFileEntries.join("\n");
      const autoresearchLauncher = await readText("scripts/autoresearch.mjs");
      const bootstrap = await readText("scripts/bootstrap-runtime.mjs");
      const releaseIntegrity = await readText("scripts/release-integrity.mjs");
      const runtimeIntegritySource = `${bootstrap}\n${releaseIntegrity}`;
      const release = await readRootText(".github/workflows/release.yml");
      const tagPushTrigger = /push:\s*\n\s*tags:/m.test(release);
      return ignoresDist &&
        !tagPushTrigger &&
        includesAll(packageFiles, [
          "dist/lib/",
          "dist/scripts/autoresearch.mjs",
          "dist/scripts/check.mjs",
          "dist/scripts/check-runner.mjs",
          "dist/scripts/finalize-autoresearch.mjs",
          "scripts/autoresearch.mjs",
          "scripts/bootstrap-runtime.mjs",
          "scripts/check.mjs",
          "scripts/directory-swap.mjs",
          "scripts/finalize-autoresearch.mjs",
          "scripts/release-integrity.mjs",
          ".codex-plugin/",
        ]) &&
        !packageFileEntries.includes("dist/scripts/") &&
        !packageFileEntries.includes("scripts/*.mjs") &&
        autoresearchLauncher.includes("./bootstrap-runtime.mjs") &&
        autoresearchLauncher.includes('ensureRuntime("autoresearch.mjs"') &&
        !packageFiles.includes(".mcp.json") &&
        !packageFiles.includes("autoresearch-mcp") &&
        includesAll(runtimeIntegritySource, [
          "github.com/TheGreenCedar/codex-autoresearch/releases/download",
          "${PACKAGE_NAME}-${version}.tgz",
          "verifyRuntimeTarballIntegrity",
          ".tgz.sha256",
          "Checksum manifest expected asset",
          "Release tarball package version mismatch",
          "package.json",
          "tar",
          "dist",
          "Run `node scripts/autoresearch.mjs --help`",
        ]) &&
        includesAll(release, [
          "workflow_dispatch:",
          "gh release create",
          '--target "$GITHUB_SHA"',
          "npm pack",
          "--help",
          "codex-autoresearch-${VERSION}.tgz",
          "$tarball.sha256",
          "sha256sum -c",
        ])
        ? pass()
        : fail(
            "Release tarball runtime contract is incomplete: dist should be ignored in Git, package files should include built dist, the CLI launcher should verify the matching GitHub release tarball checksum before hydrating missing dist, no MCP launcher/config should ship, and release CI should checksum plus smoke the tarball before creating the release tag.",
          );
    },
  },
  {
    id: "release-workflow-safeguards",
    file: "../../.github/workflows/auto-release.yml, ../../.github/workflows/release.yml, ../../.github/workflows/codeql.yml, scripts/check.ts, lib/checks/package-smoke.ts",
    description:
      "Release automation keeps version sync, branch, CodeQL, package, tarball, and duplicate-release safeguards.",
    run: async () => {
      const autoRelease = await readRootText(".github/workflows/auto-release.yml");
      const release = await readRootText(".github/workflows/release.yml");
      const codeql = await readRootText(".github/workflows/codeql.yml");
      return includesAll(autoRelease, [
        "branches:",
        "- main",
        "plugins/codex-autoresearch/package.json",
        "plugins/codex-autoresearch/package-lock.json",
        "plugins/codex-autoresearch/.codex-plugin/plugin.json",
        "CHANGELOG.md",
        "contents: read",
        "Version surfaces are not synchronized",
        "uses: ./.github/workflows/release.yml",
      ]) &&
        !/push:\s*\n\s*tags:/m.test(release) &&
        includesAll(release, [
          "os: [ubuntu-latest, windows-latest, macos-latest]",
          "npm run check",
          "node scripts/autoresearch.mjs --help",
          "Refuse existing tag or release",
          "npm pack",
          "--phase release-package-smoke",
          "gh release create",
          '--target "$GITHUB_SHA"',
        ]) &&
        includesAll(await readText("lib/checks/package-smoke.ts"), [
          '"dist/scripts/check.mjs"',
          '"dist/scripts/check-runner.mjs"',
          '"dist/lib/checks/package-smoke.mjs"',
          '"scripts/check.mjs"',
          "ALLOWED_PACKAGED_SOURCE_SCRIPTS",
          "ALLOWED_PACKAGED_DIST_SCRIPTS",
          "runReleasePackageSmokePhase",
          "runPackageRuntimeSmokeFromTarball",
          "runExtractedPackageDashboardExportSmoke",
          "check-source-hygiene",
          '"--phase", "source-hygiene"',
        ]) &&
        /pull_request:\s*\n[\s\S]*branches:\s*\n\s*-\s*main\s*\n\s*-\s*dev/m.test(codeql)
        ? pass()
        : fail("Release workflows are missing a required release, package, or CodeQL safeguard.");
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
    file: "scripts/finalize-autoresearch.mjs, scripts/finalize-autoresearch.ts, lib/session-artifacts.ts",
    description: "Finalization excludes deep research scratchpads from review branches.",
    run: async () => {
      const finalizer = await readText("scripts/finalize-autoresearch.ts");
      const artifacts = await readText("lib/session-artifacts.ts");
      return includesAll(finalizer, [
        "isAutoresearchSessionArtifact",
        "session artifact verification",
      ]) &&
        includesAll(artifacts, ["autoresearch.research", 'startsWith("autoresearch.research/")'])
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
    id: "full-product-cli-surface",
    file: "scripts/autoresearch.mjs, lib/cli-handlers.mjs, lib/tool-schemas.ts",
    description:
      "CLI exposes guided setup, recipes, gap candidates, finalization preview, live mode, and integrations.",
    run: async () => {
      const cli = await readText("scripts/autoresearch.ts");
      const help = await readText("lib/cli/help.ts");
      const cliHandlers = await readText("lib/cli-handlers.ts");
      const contracts = await readText("lib/tool-schemas.ts");
      return includesAll(cli + help + cliHandlers + contracts, [
        "setup-plan --cwd <project>",
        "prompt-plan --cwd <project>",
        "onboarding-packet --cwd <project>",
        "recommend-next --cwd <project>",
        "codex-goal-brief --cwd <project>",
        "recipes list|show|recommend",
        "benchmark-lint --cwd <project>",
        "checks-inspect --cwd <project>",
        "new-segment --cwd <project>",
        "gap-candidates --cwd <project>",
        "finalize-preview --cwd <project>",
        "state --cwd <project> [--compact] [--report]",
        "serve --cwd <project>",
        "integrations list|doctor|sync-recipes",
        "setup_plan",
        "prompt_plan",
        "onboarding_packet",
        "recommend_next",
        "codex_goal_bridge",
        "serve_dashboard",
        "benchmark_lint",
        "checks_inspect",
        "new_segment",
        "gap_candidates",
        "finalize_preview",
        'report: { type: "boolean" }',
      ])
        ? pass()
        : fail("Missing one or more full-product CLI surfaces.");
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
        "lib/tool-schemas.ts",
        "lib/recipes.ts",
        "lib/dashboard-view-model.ts",
        "lib/research-gaps.ts",
        "lib/finalize-preview.ts",
        "lib/live-server.ts",
        "lib/integrations.ts",
        "lib/session-decision-capsule.ts",
        "lib/gate-quality.ts",
        "lib/preflight-audit.ts",
        "lib/runtime-drift-doctor.ts",
        "lib/dashboard-health.ts",
        "lib/lane-briefs.ts",
        "lib/portfolio-advisor.ts",
        "lib/task-artifact-indexer.ts",
        "lib/terminal-report.ts",
        "lib/source-cleanliness.ts",
      ];
      for (const file of files) await readText(file);
      return pass();
    },
  },
];

const results = [];
for (const check of checks) {
  try {
    const outcome = await check.run();
    results.push({ ...check, ...outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ ...check, ok: false, message });
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
