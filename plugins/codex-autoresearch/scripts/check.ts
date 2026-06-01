#!/usr/bin/env node
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePackageRoot, resolveRepoRoot } from "../lib/runtime-paths.js";
import {
  runCommand as runCheckCommand,
  type CommandResult,
  type CommandSpec,
} from "./check-runner.js";

const ROOT = resolvePackageRoot(import.meta.url);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
const node = process.execPath;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const BENCHMARK_SOURCE = path.join(ROOT, "scripts", "perfection-benchmark.ts");

const syntaxChecks: CommandSpec[] = [
  ["syntax:autoresearch", node, ["--check", "scripts/autoresearch.mjs"]],
  ["syntax:finalize", node, ["--check", "scripts/finalize-autoresearch.mjs"]],
  ["syntax:benchmark", node, ["--check", "scripts/perfection-benchmark.mjs"]],
  ["syntax:check", node, ["--check", "scripts/check.mjs"]],
];

const productChecks: CommandSpec[] = [
  ["quality-gap", node, ["scripts/perfection-benchmark.mjs", "--fail-on-gap"]],
  ["command-surface-map", node, ["dist/scripts/command-surface-map.mjs"]],
  ["help:autoresearch", node, ["scripts/autoresearch.mjs", "--help"]],
  ["help:finalize", node, ["scripts/finalize-autoresearch.mjs", "--help"]],
  ["tests", npm, ["run", "test:compiled"]],
];

const dashboardBuildChecks: CommandSpec[] = [
  [
    "build:dashboard",
    node,
    [
      "node_modules/vite/bin/vite.js",
      "build",
      "--config",
      "vite.dashboard.config.ts",
      "--logLevel",
      "warn",
    ],
  ],
];

const dashboardAssets = [
  "assets/dashboard-build/dashboard-app.js",
  "assets/dashboard-build/dashboard-app.css",
];

const sourceCheckoutLauncherPaths = [
  "plugins/codex-autoresearch/scripts/bootstrap-runtime.mjs",
  "plugins/codex-autoresearch/scripts/autoresearch.mjs",
];

interface PackageEntry {
  path?: string;
  size?: number;
}

interface PackageManifest {
  files?: PackageEntry[];
}

type PackageManifestParse =
  | { ok: true; manifest: PackageManifest | undefined }
  | { error: string; ok: false };

const ok =
  (await runPhase("syntax", syntaxChecks)) &&
  (await runDashboardBuildWithParity()) &&
  (await runDemoTrustCheck()) &&
  (await runSourceCheckoutLauncherCheck()) &&
  (await runPackageArtifactCheck()) &&
  (await runDogfoodHealthCheck()) &&
  (await runPhase("product", productChecks, { streamOutput: true, timeoutSeconds: 900 }));

process.exit(ok ? 0 : 1);

async function runPhase(
  name: string,
  commands: CommandSpec[],
  options: { streamOutput?: boolean; timeoutSeconds?: number } = {},
): Promise<boolean> {
  console.log(`\n== ${name} ==`);
  const results = await Promise.all(commands.map((command) => runCommand(command, options)));
  for (const result of results) {
    const marker = result.code === 0 ? "ok" : "fail";
    console.log(`${marker} ${result.label}`);
    if (
      !options.streamOutput &&
      (result.code !== 0 || process.env.CODEX_AUTORESEARCH_CHECK_VERBOSE === "1")
    ) {
      const output = `${result.stdout}${result.stderr}`.trim();
      if (output) console.log(indent(output));
    }
    if (result.label === "quality-gap" && process.env.CODEX_AUTORESEARCH_CHECK_VERBOSE === "1") {
      console.log(indent(`Benchmark source: ${BENCHMARK_SOURCE}`));
    }
  }
  return results.every((result) => result.code === 0);
}

async function runDashboardBuildWithParity(): Promise<boolean> {
  const before = await dashboardAssetHashes();
  const buildOk = await runPhase("dashboard", dashboardBuildChecks);
  if (!buildOk) return false;
  const after = await dashboardAssetHashes();
  const changed = dashboardAssets.filter((file) => before[file] !== after[file]);
  console.log("\n== dashboard parity ==");
  if (changed.length) {
    console.log("fail dashboard-asset-parity");
    console.log(
      indent(
        `Dashboard build changed generated assets:\n${changed.join("\n")}\nRun npm run build:dashboard and include the rebuilt assets.`,
      ),
    );
    return false;
  }
  console.log("ok dashboard-asset-parity");
  return true;
}

async function dashboardAssetHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of dashboardAssets) {
    const bytes = await fsp.readFile(path.join(ROOT, file));
    hashes[file] = createHash("sha256").update(bytes).digest("hex");
  }
  return hashes;
}

async function runPackageArtifactCheck() {
  console.log("\n== package ==");

  const packDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-autoresearch-pack-"));
  const npmExecPath = await resolveNpmExecPath();
  const npmCommand = npmExecPath ? node : npm;
  const npmArgs = npmExecPath
    ? [npmExecPath, "pack", "--json", "--pack-destination", packDir]
    : ["pack", "--json", "--pack-destination", packDir];

  try {
    const result = await runCommand(["package-artifact", npmCommand, npmArgs]);
    if (result.code !== 0) {
      console.log("fail package-artifact");
      const output = `${result.stdout}${result.stderr}`.trim();
      if (output) console.log(indent(output));
      return false;
    }

    const parsedPack = parseNpmPackManifest(`${result.stdout}${result.stderr}`);
    if (parsedPack.ok === false) {
      console.log("fail package-artifact");
      console.log(indent(parsedPack.error));
      return false;
    }

    const packInfo = parsedPack.manifest;

    const packedPaths = packagePathSet(packInfo);
    const packedEntries = packageEntryMap(packInfo);
    const requiredPaths = [
      ".codex-plugin/plugin.json",
      "assets/dashboard-build/dashboard-app.js",
      "docs/index.md",
      "dist/lib/runtime-paths.mjs",
      "dist/lib/tool-schemas.mjs",
      "dist/scripts/autoresearch.mjs",
      "scripts/bootstrap-runtime.mjs",
      "scripts/autoresearch.mjs",
      "skills/codex-autoresearch/SKILL.md",
    ];
    const forbiddenPackagePaths = [
      ".mcp.json",
      "dist/scripts/autoresearch-mcp.mjs",
      "scripts/autoresearch-mcp.mjs",
      "dist/lib/mcp-cli-adapter.mjs",
      "dist/lib/mcp-interface.mjs",
      "dist/lib/mcp-protocol.mjs",
      "dist/lib/mcp-stdio-server.mjs",
    ];
    const forbiddenPaths = [
      "dashboard/src/Dashboard.tsx",
      "lib/session-core.ts",
      "scripts/autoresearch.ts",
      "tests/autoresearch-cli.test.ts",
    ];

    const missing = requiredPaths.filter((file) => !packedPaths.has(file));
    const unexpected = [...forbiddenPaths, ...forbiddenPackagePaths].filter((file) =>
      packedPaths.has(file),
    );
    const leakedExamples = Array.from(packedPaths).filter((file) => file.startsWith("examples/"));
    const wrapperProblems = await packageWrapperProblems(packedEntries);

    if (missing.length || unexpected.length || leakedExamples.length || wrapperProblems.length) {
      console.log("fail package-artifact");
      if (missing.length) {
        console.log(indent(`Missing packaged files:\n${missing.join("\n")}`));
      }
      if (unexpected.length) {
        console.log(indent(`Unexpected source files in package:\n${unexpected.join("\n")}`));
      }
      if (leakedExamples.length) {
        console.log(indent(`Leaked examples files in package:\n${leakedExamples.join("\n")}`));
      }
      if (wrapperProblems.length) {
        console.log(indent(`Broken package launchers:\n${wrapperProblems.join("\n")}`));
      }
      return false;
    }

    console.log("ok package-artifact");
    return await runPackedRuntimeSmokeCheck(packInfo, packDir);
  } finally {
    await fsp.rm(packDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runDemoTrustCheck() {
  console.log("\n== demo trust ==");
  const doctor = await runCommand([
    "demo:doctor",
    node,
    [
      "scripts/autoresearch.mjs",
      "doctor",
      "--cwd",
      "examples/demo-session",
      "--check-benchmark",
      "--explain",
    ],
  ]);
  if (doctor.code !== 0) {
    console.log("fail demo:doctor");
    const output = `${doctor.stdout}${doctor.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }
  let doctorPayload: any;
  try {
    doctorPayload = JSON.parse(doctor.stdout);
  } catch (error) {
    console.log("fail demo:doctor");
    console.log(indent(`Could not parse demo doctor JSON: ${String(error)}`));
    return false;
  }
  if (doctorPayload.ok !== true || (doctorPayload.issues || []).length) {
    console.log("fail demo:doctor");
    console.log(indent(JSON.stringify({ ok: doctorPayload.ok, issues: doctorPayload.issues })));
    return false;
  }
  console.log("ok demo:doctor");

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  const html = await fsp.readFile(
    path.join(ROOT, "examples", "demo-session", "autoresearch-dashboard.html"),
    "utf8",
  );
  const forbidden = [
    { label: "Windows user path", pattern: /C:(?:\\+|\/)Users(?:\\+|\/)/ },
    {
      label: "Windows Program Files path",
      pattern: /C:(?:\\+|\/)Program Files(?:\\+|\/)/,
    },
    { label: "POSIX user path", pattern: /\/(?:Users|home)\/[^/"'<>\s]+/ },
    { label: "actionNonce", pattern: /actionNonce/ },
    { label: "action nonce header", pattern: /X-Autoresearch-Action-Nonce/ },
    { label: "dashboard action route", pattern: /\/actions\// },
    { label: "live actions panel", pattern: /live-actions-panel/ },
    { label: "action receipt", pattern: /action-receipt/ },
  ].filter((entry) => entry.pattern.test(html));
  if (!html.includes(`"pluginVersion":"${pkg.version}"`) || forbidden.length) {
    console.log("fail demo:export");
    if (!html.includes(`"pluginVersion":"${pkg.version}"`)) {
      console.log(indent(`Demo export does not embed current pluginVersion ${pkg.version}.`));
    }
    if (forbidden.length) {
      console.log(
        indent(
          `Demo export includes forbidden readout content:\n${forbidden
            .map((entry) => entry.label)
            .join("\n")}`,
        ),
      );
    }
    return false;
  }
  console.log("ok demo:export");
  return true;
}

function parseNpmPackManifest(output: string): PackageManifestParse {
  // Strip ANSI escape codes that tsdown adds to its output.
  // eslint-disable-next-line no-control-regex
  const cleanOutput = output.replace(/\u001b\[[0-9;]*m/g, "");
  const start = cleanOutput.indexOf("[");
  if (start === -1) {
    return {
      ok: false,
      error: "Could not parse npm pack --json output: no JSON array found.",
    };
  }
  const end = cleanOutput.lastIndexOf("]");
  if (end === -1 || end <= start) {
    return {
      ok: false,
      error: "Could not parse npm pack --json output: incomplete JSON array.",
    };
  }
  try {
    const [manifest] = JSON.parse(cleanOutput.slice(start, end + 1));
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, error: `Could not parse npm pack manifest: ${String(error)}` };
  }
}

function packagePathSet(packInfo: PackageManifest | undefined) {
  return new Set((packInfo?.files || []).map((entry) => normalizedPackagePath(entry)));
}

function packageEntryMap(packInfo: PackageManifest | undefined) {
  return new Map((packInfo?.files || []).map((entry) => [normalizedPackagePath(entry), entry]));
}

function normalizedPackagePath(entry: PackageEntry) {
  return String(entry.path || "").replace(/\\/g, "/");
}

async function packageWrapperProblems(packedEntries: Map<string, PackageEntry>) {
  const wrappers = [["scripts/autoresearch.mjs", 'ensureRuntime("autoresearch.mjs"']];
  const problems: string[] = [];

  for (const [file, target] of wrappers) {
    let content = "";
    try {
      content = await fsp.readFile(path.join(ROOT, file), "utf8");
    } catch (error) {
      problems.push(`${file} could not be read: ${String(error)}`);
      continue;
    }

    const byteLength = Buffer.byteLength(content, "utf8");
    const packedSize = packedEntries.get(file)?.size;
    if (!content.includes("./bootstrap-runtime.mjs") || !content.includes(target)) {
      problems.push(`${file} should call ${target} through bootstrap-runtime.mjs`);
    }
    if (byteLength > 512) {
      problems.push(`${file} should stay a tiny launcher, but is ${byteLength} bytes`);
    }
    if (typeof packedSize === "number" && packedSize !== byteLength) {
      problems.push(`${file} packs at ${packedSize} bytes, expected ${byteLength}`);
    }
  }

  let bootstrap = "";
  try {
    bootstrap = await fsp.readFile(path.join(ROOT, "scripts", "bootstrap-runtime.mjs"), "utf8");
  } catch (error) {
    problems.push(`scripts/bootstrap-runtime.mjs could not be read: ${String(error)}`);
    return problems;
  }

  if (!packedEntries.has("scripts/bootstrap-runtime.mjs")) {
    problems.push("scripts/bootstrap-runtime.mjs is missing from the package");
  }
  for (const expected of [
    "github.com/TheGreenCedar/codex-autoresearch/releases/download",
    'codex-autoresearch-${version.replace(/^v/, "")}.tgz',
    "tar",
    "dist",
    "Run `node scripts/autoresearch.mjs --help`",
  ]) {
    if (!bootstrap.includes(expected)) {
      problems.push(`scripts/bootstrap-runtime.mjs should contain ${expected}`);
    }
  }

  return problems;
}

async function resolveNpmExecPath() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  if (process.platform !== "win32") return "";

  const candidate = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  try {
    await fsp.access(candidate);
    return candidate;
  } catch {
    return "";
  }
}

async function runPackedRuntimeSmokeCheck(packInfo: PackageManifest | undefined, packDir: string) {
  const filename = String((packInfo as any)?.filename || "");
  const tarball = path.join(packDir, path.basename(filename));
  try {
    await fsp.access(tarball);
  } catch {
    console.log("fail package-runtime-smoke");
    console.log(indent(`Packed tarball was not created at ${tarball}`));
    return false;
  }

  const extractDir = path.join(packDir, "extract");
  await fsp.mkdir(extractDir, { recursive: true });
  const extract = await runCommand(["package-extract", "tar", ["-xzf", tarball, "-C", extractDir]]);
  if (extract.code !== 0) {
    console.log("fail package-runtime-smoke");
    const output = `${extract.stdout}${extract.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }

  const smoke = await runCommand([
    "package-runtime-smoke",
    node,
    [path.join(extractDir, "package", "scripts", "autoresearch.mjs"), "--help"],
  ]);
  if (smoke.code !== 0) {
    console.log("fail package-runtime-smoke");
    const output = `${smoke.stdout}${smoke.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }

  if (smoke.stdout.includes("Codex Autoresearch") && smoke.stdout.includes("Usage:")) {
    console.log("ok package-runtime-smoke");
    return true;
  }

  console.log("fail package-runtime-smoke");
  console.log(indent(smoke.stdout.trim() || "Package smoke output did not include CLI help."));
  return false;
}

async function runDogfoodHealthCheck() {
  console.log("\n== dogfood ==");
  const qualityOk = await runTrackedDogfoodQualityCheck();
  const selfOk = await runLocalDogfoodSessionCheck();
  return qualityOk && selfOk;
}

async function runTrackedDogfoodQualityCheck() {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-autoresearch-dogfood-"));
  try {
    await fsp.writeFile(
      path.join(tempDir, "autoresearch.jsonl"),
      `${JSON.stringify({
        type: "config",
        name: "codex autoresearch product gate",
        metricName: "quality_gap",
        metricUnit: "gaps",
        bestDirection: "lower",
      })}\n`,
      "utf8",
    );
    const benchmarkCommand = `${shellQuote(node)} ${shellQuote(
      path.join(ROOT, "scripts", "perfection-benchmark.mjs"),
    )} --fail-on-gap`;
    const result = await runCommand([
      "dogfood:quality-gate",
      node,
      [
        "scripts/autoresearch.mjs",
        "doctor",
        "--cwd",
        tempDir,
        "--check-benchmark",
        "--explain",
        "--command",
        benchmarkCommand,
      ],
    ]);
    return reportDogfoodDoctorResult("dogfood:quality-gate", result);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runLocalDogfoodSessionCheck() {
  const localSessionFiles = [
    "autoresearch.jsonl",
    "autoresearch.config.json",
    "autoresearch.ps1",
    "autoresearch.sh",
  ];
  const hasLocalSession = (
    await Promise.all(
      localSessionFiles.map(async (file) => {
        try {
          await fsp.access(path.join(ROOT, file));
          return true;
        } catch {
          return false;
        }
      }),
    )
  ).some(Boolean);
  if (!hasLocalSession) {
    console.log("skip dogfood:self-session (no local session artifacts)");
    return true;
  }

  const result = await runCommand([
    "dogfood:self-session",
    node,
    ["scripts/autoresearch.mjs", "doctor", "--cwd", ".", "--check-benchmark", "--explain"],
  ]);
  return reportDogfoodDoctorResult("dogfood:self-session", result);
}

function reportDogfoodDoctorResult(label: string, result: CommandResult) {
  if (result.code !== 0) {
    console.log(`fail ${label}`);
    const output = `${result.stdout}${result.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }

  let payload: any;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    console.log(`fail ${label}`);
    console.log(indent(`Could not parse dogfood doctor JSON: ${String(error)}`));
    return false;
  }

  const warningDetails = [
    ...(Array.isArray(payload.warningDetails) ? payload.warningDetails : []),
    ...(Array.isArray(payload.state?.warningDetails) ? payload.state.warningDetails : []),
  ];
  const warnings = [
    ...(Array.isArray(payload.warnings) ? payload.warnings.map(String) : []),
    ...(Array.isArray(payload.state?.warnings) ? payload.state.warnings.map(String) : []),
  ];
  const issues = Array.isArray(payload.issues) ? payload.issues.map(String) : [];
  const failures = [
    ...issues,
    ...warningDetails
      .filter((warning) => warning?.code === "missing_commit_paths")
      .map((warning) => warning.message || "Configured commitPaths are stale."),
    ...warnings.filter((warning) => /Benchmark drift/i.test(warning)),
  ];
  if (payload.state?.limit?.limitReached) {
    failures.push("Current dogfood session has reached its active iteration limit.");
  }

  if (failures.length) {
    console.log(`fail ${label}`);
    console.log(indent(failures.join("\n")));
    return false;
  }

  console.log(`ok ${label}`);
  return true;
}

async function runSourceCheckoutLauncherCheck() {
  console.log("\n== source checkout ==");
  const missing = [];
  for (const file of sourceCheckoutLauncherPaths) {
    try {
      await fsp.access(path.join(REPO_ROOT, file));
    } catch {
      missing.push(file);
    }
  }

  if (missing.length) {
    console.log("fail source-launcher-files");
    console.log(indent(`Missing source checkout launcher files:\n${missing.join("\n")}`));
    return false;
  }

  const gitProbe = await runCommand([
    "git-probe",
    "git",
    ["-C", REPO_ROOT, "rev-parse", "--is-inside-work-tree"],
  ]);
  if (gitProbe.code !== 0) {
    console.log("ok source-launcher-files");
    console.log("skip source-launcher-committable (not a Git checkout)");
    return true;
  }

  const committable = await runCommand([
    "source-launcher-committable",
    "git",
    [
      "-C",
      REPO_ROOT,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...sourceCheckoutLauncherPaths,
    ],
  ]);
  if (committable.code !== 0) {
    console.log("ok source-launcher-files");
    console.log("fail source-launcher-committable");
    const output = `${committable.stdout}${committable.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }
  const committablePaths = new Set(committable.stdout.split(/\r?\n/).filter(Boolean));
  const ignoredOrInvisible = sourceCheckoutLauncherPaths.filter(
    (file) => !committablePaths.has(file),
  );
  if (ignoredOrInvisible.length) {
    console.log("ok source-launcher-files");
    console.log("fail source-launcher-committable");
    console.log(
      indent(
        `Launcher files are present but ignored or invisible to Git:\n${ignoredOrInvisible.join("\n")}`,
      ),
    );
    return false;
  }

  const trackedDist = await runCommand([
    "source-dist-untracked",
    "git",
    ["-C", REPO_ROOT, "ls-files", "--", "plugins/codex-autoresearch/dist"],
  ]);
  if (trackedDist.code !== 0) {
    console.log("ok source-launcher-files");
    console.log("ok source-launcher-committable");
    console.log("fail source-dist-untracked");
    const output = `${trackedDist.stdout}${trackedDist.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }
  if (trackedDist.stdout.trim()) {
    console.log("ok source-launcher-files");
    console.log("ok source-launcher-committable");
    console.log("fail source-dist-untracked");
    console.log(indent(`Generated dist files are still tracked:\n${trackedDist.stdout.trim()}`));
    return false;
  }

  const ignoredDist = await runCommand([
    "source-dist-ignored",
    "git",
    ["-C", REPO_ROOT, "check-ignore", "-q", "plugins/codex-autoresearch/dist/__codex_check__.mjs"],
  ]);
  if (ignoredDist.code !== 0) {
    console.log("ok source-launcher-files");
    console.log("ok source-launcher-committable");
    console.log("ok source-dist-untracked");
    console.log("fail source-dist-ignored");
    console.log(indent("plugins/codex-autoresearch/dist/ is not ignored."));
    return false;
  }

  console.log("ok source-launcher-files");
  console.log("ok source-launcher-committable");
  console.log("ok source-dist-untracked");
  console.log("ok source-dist-ignored");
  return true;
}

function runCommand(
  command: CommandSpec,
  options: { streamOutput?: boolean; timeoutSeconds?: number } = {},
): Promise<CommandResult> {
  return runCheckCommand(command, { cwd: ROOT, ...options });
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function shellQuote(value: string) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}
