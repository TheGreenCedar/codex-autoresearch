import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildCommandSurfaceMap } from "../../scripts/command-surface-map.js";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import { resolvePackageRoot, resolveRepoRoot } from "../../lib/runtime-paths.js";
import {
  CLEANUP_SESSION_PATHS,
  isAutoresearchSessionArtifact,
  type SessionArtifactMode,
} from "../../lib/session-artifacts.js";
import {
  AUTORESEARCH_DASHBOARD_FILE,
  AUTORESEARCH_RESEARCH_DIR,
  AUTORESEARCH_SESSION_FILES,
} from "../../lib/session-paths.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const repoRoot = resolveRepoRoot(import.meta.url);

test("version, manifest, package, and command surfaces remain internally consistent", async () => {
  const pkg = await readJson(path.join(pluginRoot, "package.json"));
  const manifest = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  assert.equal(pkg.version, PLUGIN_VERSION);
  assert.equal(manifest.version, PLUGIN_VERSION);
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.mcpServers, undefined);

  const files = new Set(Array.isArray(pkg.files) ? pkg.files.map(String) : []);
  for (const file of [
    "dist/lib/",
    "dist/scripts/autoresearch.mjs",
    "dist/scripts/operator-task-benchmark.mjs",
    "scripts/autoresearch.mjs",
    "scripts/bootstrap-runtime.mjs",
    "scripts/operator-task-benchmark.mjs",
    ".codex-plugin/",
  ]) {
    assert.ok(files.has(file), `${file} must be packaged`);
  }
  assert.equal(
    [...files].some((file) => /(?:^|\/)tests?\//.test(file)),
    false,
  );
  assert.equal(
    [...files].some((file) => file.endsWith(".ts")),
    false,
  );

  const commandMap = await buildCommandSurfaceMap();
  assert.equal(commandMap.ok, true, JSON.stringify(commandMap, null, 2));
});

test("documentation links resolve and session artifacts remain excluded from product commits", async () => {
  const markdown = [
    path.join(repoRoot, "README.md"),
    ...(await markdownFiles(path.join(pluginRoot, "docs"))),
    ...(await markdownFiles(path.join(pluginRoot, "skills"))),
  ];
  const problems: string[] = [];
  for (const file of markdown) {
    const content = await fsp.readFile(file, "utf8");
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().replace(/^<|>$/g, "");
      if (/^(?:https?:|mailto:)/i.test(raw)) continue;
      const [relative, rawAnchor = ""] = raw.split("#", 2);
      const target = relative ? path.resolve(path.dirname(file), relative) : file;
      if (!(await exists(target))) {
        problems.push(`${path.relative(repoRoot, file)} -> ${raw}`);
        continue;
      }
      if (rawAnchor && path.extname(target).toLowerCase() === ".md") {
        const anchors = markdownAnchors(await fsp.readFile(target, "utf8"));
        if (!anchors.has(decodeURIComponent(rawAnchor).toLowerCase())) {
          problems.push(`${path.relative(repoRoot, file)} -> ${raw}`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);

  const canonicalFiles = [...AUTORESEARCH_SESSION_FILES, AUTORESEARCH_DASHBOARD_FILE];
  const artifactPaths = [...canonicalFiles, `${AUTORESEARCH_RESEARCH_DIR}/study/quality-gaps.md`];
  const modes: SessionArtifactMode[] = ["finalization", "dirty-tree", "source-checkout"];
  for (const file of artifactPaths) {
    for (const mode of modes) {
      assert.equal(isAutoresearchSessionArtifact(file, mode), true, `${mode}: ${file}`);
    }
  }
  assert.deepEqual(
    new Set(CLEANUP_SESSION_PATHS),
    new Set([...canonicalFiles, AUTORESEARCH_RESEARCH_DIR]),
  );

  const gitignore = await fsp.readFile(path.join(pluginRoot, ".gitignore"), "utf8");
  const ignored = new Set(
    gitignore
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, "").replace(/\/$/, ""))
      .filter(Boolean),
  );
  for (const artifact of [...canonicalFiles, AUTORESEARCH_RESEARCH_DIR]) {
    assert.ok(ignored.has(artifact), `${artifact} must be ignored`);
  }
});

test("release workflows preserve executable package and browser safeguards", async () => {
  const workflowRoot = path.join(repoRoot, ".github", "workflows");
  const workflowNames = (await fsp.readdir(workflowRoot)).filter((name) => /\.ya?ml$/.test(name));
  const workflows = Object.fromEntries(
    await Promise.all(
      workflowNames.map(async (name) => [
        name,
        await fsp.readFile(path.join(workflowRoot, name), "utf8"),
      ]),
    ),
  );
  const ciTestJob = yamlMappingBlock(workflows["ci.yml"], "test", 2);
  const releaseTestJob = yamlMappingBlock(workflows["release.yml"], "test", 2);
  const releasePublishJob = yamlMappingBlock(workflows["release.yml"], "publish", 2);

  for (const [workflowName, job] of [
    ["ci", ciTestJob],
    ["release", releaseTestJob],
  ] as const) {
    const commands = workflowRunCommands(job);
    assert.ok(commands.includes("npm run check"));
    assert.ok(commands.includes("npm run test:dashboard:browser"));
    assert.ok(commands.includes("npx playwright install --with-deps chromium firefox webkit"));
    assert.ok(commands.includes("npm run test:dashboard:cross-browser"));
    assert.equal(yamlScalarValues(job, "runs-on").at(-1), "${{ matrix.os }}");
    assert.deepEqual(parseYamlInlineList(yamlScalarValues(job, "os")[0]), [
      "ubuntu-latest",
      "windows-latest",
      "macos-latest",
    ]);
    const steps = workflowRunSteps(job);
    assert.equal(steps.find((step) => step.command === "npm run check")?.condition, "");
    assert.equal(
      steps.find((step) => step.command === "npm run test:dashboard:browser")?.condition,
      "runner.os == 'Linux'",
    );
    for (const command of [
      "npx playwright install --with-deps chromium firefox webkit",
      "npm run test:dashboard:cross-browser",
    ]) {
      assert.equal(
        steps.find((step) => step.command === command)?.condition,
        "runner.os == 'Linux'",
      );
    }
    const uploadStep = yamlSequenceItemBlocks(job, "steps").find((step) =>
      workflowUses(step).some((action) => action.startsWith("actions/upload-artifact@")),
    );
    assert.ok(uploadStep, `${workflowName} cross-browser upload step is missing`);
    assert.equal(yamlScalarValues(uploadStep, "if")[0], "runner.os == 'Linux' && always()");
    assert.equal(
      yamlScalarValues(uploadStep, "path")[0],
      "plugins/codex-autoresearch/tmp/dashboard-cross-browser/",
    );
    assert.equal(yamlScalarValues(uploadStep, "if-no-files-found")[0], "warn");
  }
  const releaseScripts = yamlScalarValues(releasePublishJob, "run");
  const releaseCommands = releaseScripts.map((command) => command.replace(/\s+/g, " ").trim());
  const releaseLines = releaseScripts.flatMap((script) =>
    script.split("\n").map((line) => line.trim()),
  );
  assert.ok(yamlScalarValues(releasePublishJob, "needs").includes("test"));
  assert.ok(yamlScalarValues(releasePublishJob, "runs-on").includes("ubuntu-latest"));
  assert.ok(releaseLines.includes("npm pack"));
  assert.ok(
    releaseLines.includes(
      'node scripts/check.mjs --phase release-package-smoke --tarball "$tarball" --checksum "$tarball.sha256"',
    ),
  );
  assert.ok(
    releaseCommands.some((command) => command.includes("git ls-remote --exit-code --tags")),
  );
  assert.ok(releaseCommands.some((command) => command.includes("gh release view")));
  assert.ok(releaseCommands.some((command) => command.includes("gh release create")));
  assert.ok(releaseCommands.some((command) => command.includes('--target "$GITHUB_SHA"')));

  const autoRelease = workflows["auto-release.yml"];
  const autoReleasePush = yamlMappingBlock(yamlMappingBlock(autoRelease, "on", 0), "push", 2);
  assert.deepEqual(yamlSequenceValues(autoReleasePush, "branches"), ["main"]);
  assert.deepEqual(yamlSequenceValues(autoReleasePush, "paths"), [
    "plugins/codex-autoresearch/package.json",
    "plugins/codex-autoresearch/package-lock.json",
    "plugins/codex-autoresearch/.codex-plugin/plugin.json",
    "CHANGELOG.md",
  ]);
  assert.equal(
    yamlScalarValues(yamlMappingBlock(autoRelease, "permissions", 0), "contents")[0],
    "read",
  );
  const autoReleaseJob = yamlMappingBlock(autoRelease, "release", 2);
  assert.ok(workflowUses(autoReleaseJob).includes("./.github/workflows/release.yml"));
  assert.equal(
    yamlScalarValues(autoReleaseJob, "if")[0],
    "needs.detect-version.outputs.should_release == 'true'",
  );
  const detectVersionJob = yamlMappingBlock(autoRelease, "detect-version", 2);
  const versionGuardStep = yamlSequenceItemBlocks(detectVersionJob, "steps").find((step) =>
    yamlScalarValues(step, "run").some((script) =>
      script.includes("Version surfaces are not synchronized."),
    ),
  );
  assert.ok(versionGuardStep, "detect-version synchronization step is missing");
  const versionGuard = yamlScalarValues(versionGuardStep, "run")[0];
  const versionGuardLines = versionGuard.split("\n").map((line) => line.trim());
  const condition =
    'if [ "$new_version" != "$lock_version" ] || [ "$new_version" != "$lock_root_version" ] || [ "$new_version" != "$manifest_version" ]; then';
  const conditionIndex = versionGuardLines.indexOf(condition);
  assert.notEqual(conditionIndex, -1, "version synchronization condition is missing");
  assert.deepEqual(versionGuardLines.slice(conditionIndex, conditionIndex + 4), [
    condition,
    'echo "::error::Version surfaces are not synchronized. package.json=$new_version package-lock.json=$lock_version package-lock root=$lock_root_version plugin.json=$manifest_version."',
    "exit 1",
    "fi",
  ]);

  const codeqlPullRequest = yamlMappingBlock(
    yamlMappingBlock(workflows["codeql.yml"], "on", 0),
    "pull_request",
    2,
  );
  assert.deepEqual(yamlSequenceValues(codeqlPullRequest, "branches"), ["main", "dev"]);

  for (const content of Object.values(workflows)) {
    for (const action of workflowUses(content)) {
      if (action.startsWith("./")) continue;
      assert.match(action, /@[0-9a-f]{40}$/i, `${action} must use an immutable SHA`);
    }
  }

  assert.deepEqual(
    workflowRunCommands(
      "steps:\n - run: npm run check\n - run: >-\n     npm run test:dashboard:browser\n",
    ),
    ["npm run check", "npm run test:dashboard:browser"],
  );
});

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(file, "utf8")) as Record<string, unknown>;
}

async function markdownFiles(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const next = path.join(root, entry.name);
        return entry.isDirectory()
          ? markdownFiles(next)
          : entry.isFile() && entry.name.endsWith(".md")
            ? [next]
            : [];
      }),
    )
  ).flat();
}

function markdownAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (!heading) continue;
    const base = heading
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function workflowRunCommands(content: string): string[] {
  return yamlScalarValues(content, "run").map((command) => command.replace(/\s+/g, " ").trim());
}

function workflowUses(content: string): string[] {
  return yamlScalarValues(content, "uses");
}

function yamlMappingBlock(content: string, key: string, indent: number): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${" ".repeat(indent)}${key}:`);
  assert.notEqual(start, -1, `workflow mapping ${key} is missing`);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

function yamlSequenceValues(content: string, key: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*$`).test(line));
  assert.notEqual(start, -1, `workflow sequence ${key} is missing`);
  const indent = lines[start].match(/^\s*/)?.[0].length ?? 0;
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const nextIndent = line.match(/^\s*/)?.[0].length ?? 0;
    if (line.trim() && nextIndent <= indent) break;
    const item = line.match(/^\s*-\s+(.+)$/)?.[1];
    if (item) values.push(unquoteYaml(item));
  }
  return values;
}

function yamlSequenceItemBlocks(content: string, key: string): string[] {
  const lines = content.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*$`).test(line));
  assert.notEqual(keyIndex, -1, `workflow sequence ${key} is missing`);
  const keyIndent = lines[keyIndex].match(/^\s*/)?.[0].length ?? 0;
  const blocks: string[][] = [];
  let itemIndent = -1;
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (line.trim() && indent <= keyIndent) break;
    if (/^\s*-\s+/.test(line) && (itemIndent === -1 || indent === itemIndent)) {
      itemIndent = indent;
      blocks.push([line]);
    } else if (blocks.length > 0) {
      blocks.at(-1)?.push(line);
    }
  }
  return blocks.map((block) => block.join("\n"));
}

function parseYamlInlineList(value: string | undefined): string[] {
  assert.match(value || "", /^\[.*\]$/);
  return String(value)
    .slice(1, -1)
    .split(",")
    .map((item) => unquoteYaml(item.trim()));
}

function workflowRunSteps(content: string): Array<{ command: string; condition: string }> {
  const lines = content.split(/\r?\n/);
  const steps: Array<{ command: string; condition: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const run = lines[index].match(/^(\s*)run:\s*(.+)$/);
    if (!run || /^[>|][+-]?$/.test(run[2].trim())) continue;
    const runIndent = run[1].length;
    let start = index;
    while (start > 0) {
      const sequence = lines[start - 1].match(/^(\s*)-\s+\w/);
      if (sequence && sequence[1].length < runIndent) break;
      start -= 1;
    }
    const condition = lines
      .slice(start, index)
      .map((line) => line.match(/^\s*if:\s*(.+)$/)?.[1])
      .find(Boolean);
    steps.push({
      command: unquoteYaml(run[2].trim()).replace(/\s+/g, " ").trim(),
      condition: condition ? unquoteYaml(condition.trim()) : "",
    });
  }
  return steps;
}

function yamlScalarValues(content: string, key: string): string[] {
  const lines = content.split(/\r?\n/);
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^(\\s*)(?:-\\s*)?${key}:\\s*(.*)$`));
    if (!match) continue;
    const indent = match[1].length;
    const value = match[2].trim();
    if (!/^[>|][+-]?$/.test(value)) {
      values.push(unquoteYaml(value));
      continue;
    }
    const block: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (!next.trim()) {
        block.push("");
        index += 1;
        continue;
      }
      const nextIndent = next.match(/^\s*/)?.[0].length ?? 0;
      if (nextIndent <= indent) break;
      block.push(next.trim());
      index += 1;
    }
    values.push(block.join(value.startsWith(">") ? " " : "\n").trim());
  }
  return values;
}

function unquoteYaml(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  const quote = withoutComment[0];
  return quote && quote === withoutComment.at(-1) && (quote === '"' || quote === "'")
    ? withoutComment.slice(1, -1)
    : withoutComment;
}
