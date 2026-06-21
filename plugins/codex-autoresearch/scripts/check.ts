#!/usr/bin/env node
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  findSourceHygieneOffenders,
  findLooseObjectCompatibilityOffenders,
  formatSourceHygieneOffenders,
  type SourceHygieneOffender,
  type SourceFileSnapshot,
} from "../lib/cli/source-hygiene.js";
import { acceptedCurrentTreeFinalizationIssue } from "../lib/finalization-acceptance.js";
import { resolvePackageRoot, resolveRepoRoot } from "../lib/runtime-paths.js";
import {
  runCommand as runCheckCommand,
  type CommandResult,
  type CommandSpec,
  type ResolvedSpawnCommand,
} from "./check-runner.js";

const ROOT = resolvePackageRoot(import.meta.url);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
const PACKAGE_ROOT_RELATIVE = normalizePathForGit(path.relative(REPO_ROOT, ROOT));
const node = process.execPath;
const BENCHMARK_SOURCE = path.join(ROOT, "scripts", "perfection-benchmark.ts");

const syntaxChecks: CommandSpec[] = [
  ["syntax:autoresearch", node, ["--check", "scripts/autoresearch.mjs"]],
  ["syntax:finalize", node, ["--check", "scripts/finalize-autoresearch.mjs"]],
  ["syntax:benchmark", node, ["--check", "scripts/perfection-benchmark.mjs"]],
  ["syntax:check", node, ["--check", "scripts/check.mjs"]],
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

const dashboardNormalizeChecks: CommandSpec[] = [
  ["normalize:dashboard-build", node, ["scripts/normalize-dashboard-build.mjs"]],
];

const dashboardAssets = [
  "assets/dashboard-build/dashboard-app.js",
  "assets/dashboard-build/dashboard-app.css",
];
const dashboardDemoExportOutput = "tmp/autoresearch-dashboard.check.html";
export const dashboardGeneratedDemoExport = `examples/demo-session/${dashboardDemoExportOutput}`;

const sourceCheckoutLauncherPaths = [
  "plugins/codex-autoresearch/scripts/bootstrap-runtime.mjs",
  "plugins/codex-autoresearch/scripts/autoresearch.mjs",
  "plugins/codex-autoresearch/scripts/release-integrity.mjs",
];

const requiredRootIgnoreSentinels = [
  [".cursor/", ".cursor/__codex_check__"],
  [".learnings/", ".learnings/__codex_check__"],
  ["docs/superpowers/plans/", "docs/superpowers/plans/__codex_check__"],
];

const dashboardBuildDependencies = ["react", "react-dom", "recharts"];

interface PackageEntry {
  path?: string;
  size?: number;
}

interface PackageManifest {
  files?: PackageEntry[];
}

interface DashboardExportAssets {
  app: string;
  css: string;
}

type PackageManifestParse =
  | { ok: true; manifest: PackageManifest | undefined }
  | { error: string; ok: false };

type PhaseSelection =
  | { kind: "all" }
  | { kind: "error"; message: string }
  | { args: string[]; kind: "phase"; phase: string };

export interface NpmCommandResolveOptions {
  access?: (candidate: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  platform?: NodeJS.Platform;
}

export interface CheckMainOptions {
  sourceHygieneSourceFiles?: Iterable<SourceFileSnapshot>;
  sourceHygieneTrackedPaths?: Iterable<string>;
}

export async function runCheckMain(
  args: string[] = process.argv.slice(2),
  options: CheckMainOptions = {},
): Promise<number> {
  const selectedPhase = parseSelectedPhase(args);
  if (selectedPhase.kind === "error") {
    reportPhaseUsageError(selectedPhase.message);
    return 1;
  }
  if (selectedPhase.kind === "phase") {
    if (selectedPhase.phase === "source-hygiene") {
      return (await runSourceHygieneCheck({
        sourceFiles: options.sourceHygieneSourceFiles,
        trackedPaths: options.sourceHygieneTrackedPaths,
      }))
        ? 0
        : 1;
    }
    if (selectedPhase.phase === "release-package-smoke") {
      return (await runReleasePackageSmokePhase(selectedPhase.args)) ? 0 : 1;
    }
    if (selectedPhase.phase === "release-provenance-smoke") {
      return (await runReleaseProvenanceSmokePhase(selectedPhase.args)) ? 0 : 1;
    }
    return reportUnknownPhase(selectedPhase.phase) ? 0 : 1;
  }

  const ok =
    (await runPhase("syntax", syntaxChecks)) &&
    (await runSourceHygieneCheck({
      sourceFiles: options.sourceHygieneSourceFiles,
      trackedPaths: options.sourceHygieneTrackedPaths,
    })) &&
    (await runDashboardBuildWithParity()) &&
    (await runDemoTrustCheck()) &&
    (await runSourceCheckoutLauncherCheck()) &&
    (await runDogfoodHealthCheck()) &&
    (await runProductPhase()) &&
    (await runPackageArtifactCheck());

  return ok ? 0 : 1;
}

const isMain = isCheckEntrypoint();

if (isMain) {
  process.exit(await runCheckMain());
}

function isCheckEntrypoint(argvPath: string | undefined = process.argv[1]): boolean {
  if (!argvPath) return false;
  const resolvedArgv = normalizeFsPath(path.resolve(argvPath));
  return [fileURLToPath(import.meta.url), path.join(ROOT, "scripts", "check.mjs")].some(
    (candidate) => normalizeFsPath(path.resolve(candidate)) === resolvedArgv,
  );
}

function parseSelectedPhase(args: string[]): PhaseSelection {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--phase") {
      const value = String(args[index + 1] || "").trim();
      if (!value || value.startsWith("-")) {
        return { kind: "error", message: "Missing value for --phase." };
      }
      return { args, kind: "phase", phase: value };
    }
    if (arg.startsWith("--phase=")) {
      const value = arg.slice("--phase=".length).trim();
      if (!value) return { kind: "error", message: "Missing value for --phase." };
      return { args, kind: "phase", phase: value };
    }
  }
  return { kind: "all" };
}

function reportPhaseUsageError(message: string): false {
  console.error(message);
  console.error(
    "Usage: node scripts/check.mjs [--phase source-hygiene|release-package-smoke|release-provenance-smoke --tarball <file> [--checksum <file>]]",
  );
  return false;
}

function reportUnknownPhase(phase: string): false {
  console.error(`Unknown check phase: ${phase}`);
  console.error(
    "Available phases: source-hygiene, release-package-smoke, release-provenance-smoke",
  );
  return false;
}

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
  const normalizeOk = await runPhase("dashboard normalization", dashboardNormalizeChecks);
  if (!normalizeOk) return false;
  const after = await dashboardAssetHashes();
  const missing = dashboardAssets.filter((file) => after[file] === null);
  const changed = dashboardAssets.filter(
    (file) => before[file] !== null && before[file] !== after[file],
  );
  console.log("\n== dashboard parity ==");
  if (missing.length) {
    console.log("fail dashboard-asset-parity");
    console.log(indent(`Dashboard build did not create generated assets:\n${missing.join("\n")}`));
    return false;
  }
  if (changed.length) {
    console.log("fail dashboard-asset-parity");
    console.log(
      indent(
        `Dashboard build changed existing generated assets:\n${changed.join("\n")}\nRun npm run build:dashboard before checking packaging.`,
      ),
    );
    return false;
  }
  console.log("ok dashboard-asset-parity");
  return true;
}

async function dashboardAssetHashes(): Promise<Record<string, string | null>> {
  const hashes: Record<string, string | null> = {};
  for (const file of dashboardAssets) {
    try {
      const bytes = await fsp.readFile(path.join(ROOT, file));
      hashes[file] = createHash("sha256").update(bytes).digest("hex");
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
        hashes[file] = null;
        continue;
      }
      throw error;
    }
  }
  return hashes;
}

async function runPackageArtifactCheck() {
  console.log("\n== package ==");

  const packDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-autoresearch-pack-"));
  let npmPack: ResolvedSpawnCommand;
  try {
    npmPack = await resolveNpmCommand([
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packDir,
    ]);
  } catch (error) {
    console.log("fail package-artifact");
    console.log(indent(errorMessage(error)));
    await fsp.rm(packDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }

  try {
    const result = await runCommand(["package-artifact", npmPack.command, npmPack.args]);
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
      "assets/dashboard-build/dashboard-app.css",
      "docs/index.md",
      "dist/lib/runtime-paths.mjs",
      "dist/lib/tool-schemas.mjs",
      "dist/scripts/autoresearch.mjs",
      "scripts/bootstrap-runtime.mjs",
      "scripts/autoresearch.mjs",
      "scripts/release-integrity.mjs",
      "scripts/finalize-autoresearch.mjs",
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

async function runReleasePackageSmokePhase(args: string[]): Promise<boolean> {
  console.log("\n== release package smoke ==");
  const tarballArg = optionValue(args, "--tarball");
  if (!tarballArg) {
    console.log("fail release-package-smoke");
    console.log(indent("Missing --tarball <file>."));
    return false;
  }

  const tarball = path.resolve(process.cwd(), tarballArg);
  try {
    await fsp.access(tarball);
  } catch {
    console.log("fail release-package-smoke");
    console.log(indent(`Release tarball was not found at ${tarball}`));
    return false;
  }

  const checksumArg = optionValue(args, "--checksum");
  if (checksumArg) {
    const checksumIssue = await releaseChecksumIssue(
      tarball,
      path.resolve(process.cwd(), checksumArg),
    );
    if (checksumIssue) {
      console.log("fail release-package-smoke");
      console.log(indent(checksumIssue));
      return false;
    }
  }

  const smokeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-autoresearch-release-smoke-"));
  try {
    const ok = await runPackageRuntimeSmokeFromTarball(tarball, path.join(smokeDir, "extract"));
    if (!ok) return false;
    console.log("ok release-package-smoke");
    return true;
  } finally {
    await fsp.rm(smokeDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runReleaseProvenanceSmokePhase(args: string[]): Promise<boolean> {
  console.log("\n== release provenance smoke ==");
  const tarballArg = optionValue(args, "--tarball");
  const checksumArg = optionValue(args, "--checksum");
  if (!tarballArg || !checksumArg) {
    console.log("fail release-provenance-smoke");
    console.log(indent("Missing --tarball <file> or --checksum <file>."));
    return false;
  }

  const repo = optionValue(args, "--repo") || "TheGreenCedar/codex-autoresearch";
  const signerWorkflow =
    optionValue(args, "--signer-workflow") ||
    "TheGreenCedar/codex-autoresearch/.github/workflows/release.yml";
  const tag = optionValue(args, "--tag");
  const tarball = path.resolve(process.cwd(), tarballArg);
  const checksumPath = path.resolve(process.cwd(), checksumArg);
  const releaseJsonPath = optionValue(args, "--release-json");
  const attestationJsonPath = optionValue(args, "--attestation-json");
  const targetCommit = optionValue(args, "--target-commit");

  let releaseJson = "";
  if (releaseJsonPath) {
    releaseJson = await fsp.readFile(path.resolve(process.cwd(), releaseJsonPath), "utf8");
  } else {
    if (!tag) {
      console.log("fail release-provenance-smoke");
      console.log(indent("Missing --tag <vX.Y.Z> when --release-json is not provided."));
      return false;
    }
    const release = await runCommand([
      "release-provenance:release-json",
      "gh",
      ["api", `repos/${repo}/releases/tags/${tag}`],
    ]);
    if (release.code !== 0) {
      console.log("fail release-provenance-smoke");
      const output = `${release.stdout}${release.stderr}`.trim();
      if (output) console.log(indent(output));
      return false;
    }
    releaseJson = release.stdout;
  }

  let attestationJson = "";
  if (attestationJsonPath) {
    attestationJson = await fsp.readFile(path.resolve(process.cwd(), attestationJsonPath), "utf8");
  } else {
    const attestation = await runCommand([
      "release-provenance:attestation",
      "gh",
      releaseProvenanceGhVerifyArgs(tarball, { repo, signerWorkflow }),
    ]);
    if (attestation.code !== 0) {
      console.log("fail release-provenance-smoke");
      const output = `${attestation.stdout}${attestation.stderr}`.trim();
      if (output) console.log(indent(output));
      return false;
    }
    attestationJson = attestation.stdout;
  }

  let issue = "";
  try {
    issue = await releaseProvenanceIssue({
      attestationJson,
      checksumPath,
      releaseJson,
      repo,
      signerWorkflow,
      targetCommit,
      tarball,
    });
  } catch (error) {
    issue = errorMessage(error);
  }
  if (issue) {
    console.log("fail release-provenance-smoke");
    console.log(indent(issue));
    return false;
  }
  console.log("ok release-provenance-smoke");
  return true;
}

async function runSourceHygieneCheck(
  options: {
    sourceFiles?: Iterable<SourceFileSnapshot>;
    trackedPaths?: Iterable<string>;
  } = {},
) {
  console.log("\n== source hygiene ==");

  if (options.trackedPaths) {
    return reportSourceHygieneResult(options.trackedPaths, {
      sourceFiles: options.sourceFiles,
    });
  }

  const gitProbe = await runCommand([
    "git-probe",
    "git",
    ["-C", REPO_ROOT, "rev-parse", "--is-inside-work-tree"],
  ]);
  if (gitProbe.code !== 0) {
    console.log("skip source-hygiene (not a Git checkout)");
    return true;
  }

  const tracked = await runCommand([
    "source-hygiene:tracked-files",
    "git",
    ["-C", REPO_ROOT, "ls-files"],
  ]);
  if (tracked.code !== 0) {
    console.log("fail source-hygiene");
    const output = `${tracked.stdout}${tracked.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }

  return reportSourceHygieneResult(tracked.stdout.split(/\r?\n/), {
    sourceFiles: options.sourceFiles,
  });
}

async function reportSourceHygieneResult(
  trackedPaths: Iterable<string>,
  options: { sourceFiles?: Iterable<SourceFileSnapshot> } = {},
) {
  const offenders = [
    ...findSourceHygieneOffenders(trackedPaths, {
      packageRoot: PACKAGE_ROOT_RELATIVE,
    }),
    ...(await sourceHygienePolicyOffenders({ sourceFiles: options.sourceFiles })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (offenders.length) {
    console.log("fail source-hygiene");
    console.log(indent(formatSourceHygieneOffenders(offenders)));
    return false;
  }

  console.log("ok source-hygiene");
  return true;
}

async function sourceHygienePolicyOffenders(
  options: { sourceFiles?: Iterable<SourceFileSnapshot> } = {},
): Promise<SourceHygieneOffender[]> {
  const offenders: SourceHygieneOffender[] = [];

  try {
    await fsp.access(path.join(ROOT, ".prettierrc"));
    offenders.push({
      path: `${PACKAGE_ROOT_RELATIVE}/.prettierrc`,
      reason: "stale formatter config: package scripts use oxfmt",
    });
  } catch {}

  for (const [ignoreRoot, sentinel] of requiredRootIgnoreSentinels) {
    const ignored = await runCommand([
      `source-hygiene:ignore:${ignoreRoot}`,
      "git",
      ["-C", REPO_ROOT, "check-ignore", "-q", sentinel],
    ]);
    if (ignored.code !== 0) {
      offenders.push({
        path: sentinel,
        reason: `root .gitignore should ignore ${ignoreRoot}`,
      });
    }
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  } catch (error) {
    offenders.push({
      path: `${PACKAGE_ROOT_RELATIVE}/package.json`,
      reason: `package metadata could not be read: ${String(error)}`,
    });
    return offenders;
  }

  const engines = recordValue(pkg.engines);
  const nodeEngine = stringValue(engines?.node);
  if (!/>=\s*24/.test(nodeEngine)) {
    offenders.push({
      path: `${PACKAGE_ROOT_RELATIVE}/package.json`,
      reason: 'package metadata should include "engines": { "node": ">=24" }',
    });
  }

  const dependencies = recordValue(pkg.dependencies);
  const runtimeDashboardDependencies = dashboardBuildDependencies.filter(
    (name) => dependencies && Object.hasOwn(dependencies, name),
  );
  for (const name of runtimeDashboardDependencies) {
    offenders.push({
      path: `${PACKAGE_ROOT_RELATIVE}/package.json`,
      reason: `${name} is a dashboard build dependency and should be in devDependencies`,
    });
  }

  const sourceFiles = options.sourceFiles ?? (await readSourceHygieneSourceFiles());
  offenders.push(...findLooseObjectCompatibilityOffenders(sourceFiles));

  return offenders;
}

async function readSourceHygieneSourceFiles(): Promise<SourceFileSnapshot[]> {
  const roots = ["lib", "scripts", "tests", "dashboard/src"];
  const snapshots: SourceFileSnapshot[] = [];
  for (const root of roots) {
    const absoluteRoot = path.join(ROOT, root);
    for (const filePath of await listSourceFiles(absoluteRoot)) {
      snapshots.push({
        content: await fsp.readFile(filePath, "utf8"),
        path: normalizePathForGit(path.relative(REPO_ROOT, filePath)),
      });
    }
  }
  return snapshots;
}

async function listSourceFiles(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const name of names) {
    const entryPath = path.join(root, name);
    const stat = await fsp.stat(entryPath);
    if (stat.isDirectory()) {
      if (name === "dist" || name === "node_modules") continue;
      files.push(...(await listSourceFiles(entryPath)));
    } else if (stat.isFile() && name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
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
    if (acceptedCurrentTreeFinalizationIssue(doctorPayload)) {
      console.log("ok demo:doctor (current-tree finalization blocker exposed)");
    } else {
      console.log("fail demo:doctor");
      console.log(indent(JSON.stringify({ ok: doctorPayload.ok, issues: doctorPayload.issues })));
      return false;
    }
  } else {
    console.log("ok demo:doctor");
  }

  await fsp.mkdir(path.dirname(path.join(ROOT, dashboardGeneratedDemoExport)), {
    recursive: true,
  });
  await fsp.rm(path.join(ROOT, dashboardGeneratedDemoExport), { force: true });
  const exportResult = await runCommand(demoDashboardExportCommand());
  if (exportResult.code !== 0) {
    console.log("fail demo:export");
    const output = `${exportResult.stdout}${exportResult.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  const html = await fsp.readFile(path.join(ROOT, dashboardGeneratedDemoExport), "utf8");
  const parityIssues = dashboardExportAssetIssues(html, await readDashboardExportAssets());
  const showcaseIssues = demoShowcaseIssues(html);
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
    {
      label: "branch-specific excluded commits",
      pattern: /Excluded \d+ unkept non-session commit/,
    },
    { label: "branch-specific final tree coverage", pattern: /Final tree coverage is missing/ },
  ].filter((entry) => entry.pattern.test(html));
  if (
    !html.includes(`"pluginVersion":"${pkg.version}"`) ||
    forbidden.length ||
    parityIssues.length ||
    showcaseIssues.length
  ) {
    console.log("fail demo:export");
    if (!html.includes(`"pluginVersion":"${pkg.version}"`)) {
      console.log(indent(`Demo export does not embed current pluginVersion ${pkg.version}.`));
    }
    if (showcaseIssues.length) {
      console.log(indent(`Demo export is not a valid showcase:\n${showcaseIssues.join("\n")}`));
    }
    if (parityIssues.length) {
      console.log(
        indent(
          `Demo export generated asset parity failed:\n${parityIssues.join(
            "\n",
          )}\nGenerated check path: ${dashboardGeneratedDemoExport}`,
        ),
      );
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

export function demoDashboardExportCommand(): CommandSpec {
  return [
    "demo:export",
    node,
    [
      "scripts/autoresearch.mjs",
      "export",
      "--cwd",
      "examples/demo-session",
      "--output",
      dashboardDemoExportOutput,
      "--showcase",
    ],
  ];
}

async function readDashboardExportAssets(): Promise<DashboardExportAssets> {
  const [app, css] = await Promise.all([
    fsp.readFile(path.join(ROOT, "assets/dashboard-build/dashboard-app.js"), "utf8"),
    fsp.readFile(path.join(ROOT, "assets/dashboard-build/dashboard-app.css"), "utf8"),
  ]);
  return { app, css };
}

export function dashboardExportAssetIssues(html: string, assets: DashboardExportAssets): string[] {
  const issues: string[] = [];
  const styleBlocks = extractHtmlBlocks(html, "style");
  const scriptBlocks = extractHtmlBlocks(html, "script");
  const inlineCss = styleBlocks[0];
  const inlineApp = scriptBlocks[1];

  if (styleBlocks.length !== 1 || inlineCss === undefined) {
    issues.push(`expected exactly one inline dashboard style block, found ${styleBlocks.length}`);
  } else if (inlineCss !== escapedDashboardCss(assets.css)) {
    issues.push(
      "inline dashboard CSS does not match assets/dashboard-build/dashboard-app.css after </style escaping",
    );
  }

  if (scriptBlocks.length < 2 || inlineApp === undefined) {
    issues.push(
      `expected dashboard app in the second inline script block, found ${scriptBlocks.length} script block(s)`,
    );
  } else if (inlineApp !== escapedDashboardApp(assets.app)) {
    issues.push(
      "inline dashboard script does not match assets/dashboard-build/dashboard-app.js after </script escaping",
    );
  }

  return issues;
}

function extractHtmlBlocks(html: string, tagName: "script" | "style"): string[] {
  const pattern = new RegExp(`<${tagName}>\\r?\\n([\\s\\S]*?)\\r?\\n</${tagName}>`, "g");
  return [...html.matchAll(pattern)].map((match) => match[1] || "");
}

function escapedDashboardApp(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function escapedDashboardCss(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

function parseDashboardMeta(html: string): any | null {
  const match = html.match(/window\.__AUTORESEARCH_META__ = ([\s\S]*?);\n<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function demoShowcaseIssues(html: string): string[] {
  const meta = parseDashboardMeta(html);
  if (!meta) return ["missing or invalid embedded dashboard metadata"];
  const issues: string[] = [];
  if (meta.publicExport !== true || meta.settings?.publicExport !== true) {
    issues.push("public export flags are missing");
  }
  if (meta.showcaseMode !== true || meta.settings?.showcaseMode !== true) {
    issues.push("showcase flags are missing");
  }
  if (meta.deliveryMode !== "showcase" || meta.settings?.deliveryMode !== "showcase") {
    issues.push("deliveryMode is not showcase");
  }
  if (
    meta.viewModel?.trustState?.mode === "static-export" ||
    meta.viewModel?.processHygiene?.mode === "static-export"
  ) {
    issues.push("view model still reports static-export mode");
  }
  if (
    /Static export/i.test(JSON.stringify(meta.viewModel?.trustState?.reasons ?? [])) ||
    /Static export/i.test(JSON.stringify(meta.viewModel?.processHygiene?.warnings ?? []))
  ) {
    issues.push("view model still embeds static-export warnings");
  }
  return issues;
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
  const wrappers = [
    ["scripts/autoresearch.mjs", 'ensureRuntime("autoresearch.mjs"'],
    ["scripts/finalize-autoresearch.mjs", 'ensureRuntime("finalize-autoresearch.mjs"'],
  ];
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
    if (!packedEntries.has(file)) {
      problems.push(`${file} is missing from the package`);
      continue;
    }
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
  let releaseIntegrity = "";
  try {
    releaseIntegrity = await fsp.readFile(
      path.join(ROOT, "scripts", "release-integrity.mjs"),
      "utf8",
    );
  } catch (error) {
    problems.push(`scripts/release-integrity.mjs could not be read: ${String(error)}`);
  }
  if (!packedEntries.has("scripts/release-integrity.mjs")) {
    problems.push("scripts/release-integrity.mjs is missing from the package");
  }
  const runtimeIntegritySource = `${bootstrap}\n${releaseIntegrity}`;
  for (const expected of [
    "github.com/TheGreenCedar/codex-autoresearch/releases/download",
    "${PACKAGE_NAME}-${version}.tgz",
    "verifyRuntimeTarballIntegrity",
    ".tgz.sha256",
    "Checksum manifest expected asset",
    "Release tarball package version mismatch",
    "tar",
    "dist",
    "Run `node scripts/autoresearch.mjs --help`",
  ]) {
    if (!runtimeIntegritySource.includes(expected)) {
      problems.push(`release runtime integrity scripts should contain ${expected}`);
    }
  }

  return problems;
}

async function runProductPhase(): Promise<boolean> {
  let productChecks: CommandSpec[];
  try {
    productChecks = await productCheckCommands();
  } catch (error) {
    console.log("\n== product ==");
    console.log("fail npm-resolution");
    console.log(indent(errorMessage(error)));
    return false;
  }
  return runPhase("product", productChecks, { streamOutput: true, timeoutSeconds: 900 });
}

async function productCheckCommands(): Promise<CommandSpec[]> {
  const npmTest = await resolveNpmCommand(["run", "test:compiled"]);
  return [
    ["quality-gap", node, ["scripts/perfection-benchmark.mjs", "--fail-on-gap"]],
    ["command-surface-map", node, ["dist/scripts/command-surface-map.mjs"]],
    ["help:autoresearch", node, ["scripts/autoresearch.mjs", "--help"]],
    ["help:finalize", node, ["scripts/finalize-autoresearch.mjs", "--help"]],
    ["tests", npmTest.command, npmTest.args],
  ];
}

export async function resolveNpmCommand(
  args: string[],
  options: NpmCommandResolveOptions = {},
): Promise<ResolvedSpawnCommand> {
  const nodeCommand = options.nodeExecPath || node;
  const platform = options.platform || process.platform;
  const npmExecPath = await resolveNpmExecPath({ ...options, nodeExecPath: nodeCommand, platform });
  if (npmExecPath) return { command: nodeCommand, args: [npmExecPath, ...args] };
  if (platform === "win32") {
    throw new Error(
      [
        "Could not locate npm-cli.js for shell-free npm execution on Windows.",
        "The check runner will not fall back to npm.cmd, npm.ps1, or bare npm because those require a shell wrapper.",
        "Run through npm so npm_execpath is set, or install npm next to Node.js/user npm so node can execute npm-cli.js directly.",
      ].join(" "),
    );
  }
  return { command: "npm", args };
}

async function resolveNpmExecPath(options: NpmCommandResolveOptions = {}) {
  const access = options.access || ((candidate: string) => fsp.access(candidate));
  for (const candidate of npmExecPathCandidates(options)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return "";
}

function npmExecPathCandidates({
  env = process.env,
  nodeExecPath = process.execPath,
  platform = process.platform,
}: NpmCommandResolveOptions = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const candidates = [
    env.npm_execpath,
    pathApi.join(pathApi.dirname(nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  if (platform === "win32") {
    candidates.push(
      env.APPDATA
        ? pathApi.join(env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js")
        : "",
      env.LOCALAPPDATA
        ? pathApi.join(
            env.LOCALAPPDATA,
            "Programs",
            "nodejs",
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          )
        : "",
      env.ProgramFiles
        ? pathApi.join(env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js")
        : "",
      env["ProgramFiles(x86)"]
        ? pathApi.join(
            env["ProgramFiles(x86)"],
            "nodejs",
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          )
        : "",
    );
  }

  for (const pathDir of splitPathEnv(env, platform)) {
    candidates.push(pathApi.join(pathDir, "node_modules", "npm", "bin", "npm-cli.js"));
  }

  return uniqueStrings(candidates.filter(isJavaScriptFilePath));
}

function splitPathEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const value = env.Path || env.PATH || "";
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter;
  return value.split(delimiter).filter(Boolean);
}

function isJavaScriptFilePath(value: unknown): value is string {
  return typeof value === "string" && /\.(?:m?js)$/i.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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

  return runPackageRuntimeSmokeFromTarball(tarball, path.join(packDir, "extract"));
}

async function runPackageRuntimeSmokeFromTarball(tarball: string, extractDir: string) {
  await fsp.mkdir(extractDir, { recursive: true });
  const extract = await runCommand(["package-extract", "tar", ["-xzf", tarball, "-C", extractDir]]);
  if (extract.code !== 0) {
    console.log("fail package-runtime-smoke");
    const output = `${extract.stdout}${extract.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }

  const smoke = await runPackageSmokeCommands(extractDir);
  if (!smoke.ok) {
    console.log("fail package-runtime-smoke");
    console.log(indent(smoke.error));
    return false;
  }

  console.log("ok package-runtime-smoke");
  return true;
}

function optionValue(args: string[], name: string): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return String(args[index + 1] || "").trim();
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1).trim();
  }
  return "";
}

export async function releaseChecksumIssue(tarball: string, checksumPath: string): Promise<string> {
  let checksumText = "";
  try {
    checksumText = await fsp.readFile(checksumPath, "utf8");
  } catch (error) {
    return `Checksum file could not be read at ${checksumPath}: ${String(error)}`;
  }

  const tarballName = path.basename(tarball);
  let expectedHash = "";
  try {
    expectedHash = await parseStrictSha256Manifest(checksumText, tarballName);
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }

  const bytes = await fsp.readFile(tarball);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    return `Checksum mismatch for ${tarballName}: expected ${expectedHash}, got ${actualHash}.`;
  }
  return "";
}

export interface ReleaseProvenanceOptions {
  attestationJson: string;
  checksumPath: string;
  releaseJson: string;
  repo?: string;
  signerWorkflow?: string;
  targetCommit?: string;
  tarball: string;
}

export function releaseProvenanceGhVerifyArgs(
  tarball: string,
  options: { repo?: string; signerWorkflow?: string } = {},
): string[] {
  return [
    "attestation",
    "verify",
    tarball,
    "--repo",
    options.repo || "TheGreenCedar/codex-autoresearch",
    "--signer-workflow",
    options.signerWorkflow || "TheGreenCedar/codex-autoresearch/.github/workflows/release.yml",
    "--format",
    "json",
  ];
}

export async function releaseProvenanceIssue(options: ReleaseProvenanceOptions): Promise<string> {
  const repo = options.repo || "TheGreenCedar/codex-autoresearch";
  const signerWorkflow =
    options.signerWorkflow || "TheGreenCedar/codex-autoresearch/.github/workflows/release.yml";
  const tarballName = path.basename(options.tarball);
  const checksumName = path.basename(options.checksumPath);
  const checksumText = await fsp.readFile(options.checksumPath, "utf8");
  const expectedHash = await parseStrictSha256Manifest(checksumText, tarballName);
  const tarballHash = await fileSha256(options.tarball);
  if (tarballHash !== expectedHash) {
    return `Checksum mismatch for ${tarballName}: expected ${expectedHash}, got ${tarballHash}.`;
  }

  const release = parseJsonObject(options.releaseJson, "release JSON");
  const targetCommit = options.targetCommit || stringField(release, "target_commitish");
  if (!/^[a-f0-9]{40}$/i.test(targetCommit)) {
    return `Release target commit must be a full 40-character SHA, got ${JSON.stringify(
      targetCommit,
    )}.`;
  }

  const tarballAsset = releaseAsset(release, tarballName);
  if (!tarballAsset) return `Release asset ${tarballName} was not found.`;
  const releaseDigest = assetSha256(tarballAsset);
  if (releaseDigest !== tarballHash) {
    return `Release asset digest for ${tarballName} expected ${tarballHash}, got ${releaseDigest || "missing"}.`;
  }

  const checksumAsset = releaseAsset(release, checksumName);
  if (!checksumAsset) return `Release checksum asset ${checksumName} was not found.`;
  const checksumAssetDigest = assetSha256(checksumAsset);
  const checksumFileHash = await fileSha256(options.checksumPath);
  if (checksumAssetDigest !== checksumFileHash) {
    return `Release asset digest for ${checksumName} expected ${checksumFileHash}, got ${
      checksumAssetDigest || "missing"
    }.`;
  }

  const attestations = parseJsonArray(options.attestationJson, "attestation JSON");
  const matching = attestations
    .map((entry) => attestationPolicyView(entry))
    .filter((entry) =>
      entry.subjects.some(
        (subject) => subject.name === tarballName && subject.sha256 === tarballHash,
      ),
    );
  if (!matching.length) {
    return `Attestation subject ${tarballName} with SHA-256 ${tarballHash} was not found.`;
  }

  const expectedSan = `https://github.com/${signerWorkflow}@refs/heads/main`;
  const expectedRepoUri = `https://github.com/${repo}`;
  const expectedWorkflowPath = signerWorkflow.slice(`${repo}/`.length);
  const expectedBuilderUri = `https://github.com/${signerWorkflow}@refs/heads/main`;
  for (const entry of matching) {
    const issues = [
      requireEqual(
        "certificate subjectAlternativeName",
        entry.certificate.subjectAlternativeName,
        expectedSan,
      ),
      requireEqual(
        "certificate githubWorkflowRepository",
        entry.certificate.githubWorkflowRepository,
        repo,
      ),
      requireEqual(
        "certificate sourceRepositoryURI",
        entry.certificate.sourceRepositoryURI,
        expectedRepoUri,
      ),
      requireEqual(
        "certificate sourceRepositoryRef",
        entry.certificate.sourceRepositoryRef,
        "refs/heads/main",
      ),
      requireEqual(
        "certificate runnerEnvironment",
        entry.certificate.runnerEnvironment,
        "github-hosted",
      ),
      requireEqual(
        "certificate sourceRepositoryDigest",
        entry.certificate.sourceRepositoryDigest,
        targetCommit,
      ),
      requireEqual(
        "certificate githubWorkflowSHA",
        entry.certificate.githubWorkflowSHA,
        targetCommit,
      ),
      requireEqual("workflow repository", entry.workflow.repository, expectedRepoUri),
      requireEqual("workflow ref", entry.workflow.ref, "refs/heads/main"),
      requireEqual("workflow path", entry.workflow.path, expectedWorkflowPath),
      requireEqual("predicate runner_environment", entry.runnerEnvironment, "github-hosted"),
      requireEqual("builder id", entry.builderId, expectedBuilderUri),
    ].filter(Boolean);
    const dependencyOk = entry.resolvedDependencies.some(
      (dependency) =>
        dependency.uri === `git+${expectedRepoUri}@refs/heads/main` &&
        dependency.gitCommit === targetCommit,
    );
    if (!dependencyOk) {
      issues.push(
        `resolvedDependencies must include git+${expectedRepoUri}@refs/heads/main at ${targetCommit}.`,
      );
    }
    if (!issues.length) return "";
  }

  return `No matching attestation satisfied release provenance policy:\n${matching
    .map((entry) => entry.summary)
    .join("\n")}`;
}

async function parseStrictSha256Manifest(text: string, expectedFileName: string): Promise<string> {
  const releaseIntegrity = (await import(
    pathToFileURL(path.join(ROOT, "scripts", "release-integrity.mjs")).href
  )) as {
    parseSha256Manifest: (text: string, expectedFileName: string) => string;
  };
  return releaseIntegrity.parseSha256Manifest(text, expectedFileName);
}

async function fileSha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await fsp.readFile(file))
    .digest("hex");
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseJsonArray(text: string, label: string): unknown[] {
  const value = JSON.parse(text) as unknown;
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array.`);
  return value;
}

function releaseAsset(
  release: Record<string, unknown>,
  name: string,
): Record<string, unknown> | null {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  for (const asset of assets) {
    if (asset && typeof asset === "object" && !Array.isArray(asset)) {
      const record = asset as Record<string, unknown>;
      if (record.name === name) return record;
    }
  }
  return null;
}

function assetSha256(asset: Record<string, unknown>): string {
  const digest = String(asset.digest || "");
  const match = digest.match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : "";
}

function attestationPolicyView(entry: unknown) {
  const root = record(entry);
  const result = record(root.verificationResult);
  const statement = record(result.statement);
  const predicate = record(statement.predicate);
  const buildDefinition = record(predicate.buildDefinition);
  const externalParameters = record(buildDefinition.externalParameters);
  const workflow = record(externalParameters.workflow);
  const internalParameters = record(buildDefinition.internalParameters);
  const github = record(internalParameters.github);
  const runDetails = record(predicate.runDetails);
  const builder = record(runDetails.builder);
  const signature = record(result.signature);
  const certificate = record(signature.certificate);
  const subjects = (Array.isArray(statement.subject) ? statement.subject : []).map((subject) => {
    const subjectRecord = record(subject);
    return {
      name: stringField(subjectRecord, "name"),
      sha256: stringField(record(subjectRecord.digest), "sha256").toLowerCase(),
    };
  });
  const resolvedDependencies = (
    Array.isArray(buildDefinition.resolvedDependencies) ? buildDefinition.resolvedDependencies : []
  ).map((dependency) => {
    const dependencyRecord = record(dependency);
    return {
      gitCommit: stringField(record(dependencyRecord.digest), "gitCommit"),
      uri: stringField(dependencyRecord, "uri"),
    };
  });
  return {
    builderId: stringField(builder, "id"),
    certificate: {
      githubWorkflowRepository: stringField(certificate, "githubWorkflowRepository"),
      githubWorkflowSHA: stringField(certificate, "githubWorkflowSHA"),
      runnerEnvironment: stringField(certificate, "runnerEnvironment"),
      sourceRepositoryDigest: stringField(certificate, "sourceRepositoryDigest"),
      sourceRepositoryRef: stringField(certificate, "sourceRepositoryRef"),
      sourceRepositoryURI: stringField(certificate, "sourceRepositoryURI"),
      subjectAlternativeName: stringField(certificate, "subjectAlternativeName"),
    },
    resolvedDependencies,
    runnerEnvironment: stringField(github, "runner_environment"),
    subjects,
    summary: JSON.stringify({
      certificate: {
        githubWorkflowRepository: stringField(certificate, "githubWorkflowRepository"),
        sourceRepositoryDigest: stringField(certificate, "sourceRepositoryDigest"),
        sourceRepositoryRef: stringField(certificate, "sourceRepositoryRef"),
        subjectAlternativeName: stringField(certificate, "subjectAlternativeName"),
      },
      subjects,
    }),
    workflow: {
      path: stringField(workflow, "path"),
      ref: stringField(workflow, "ref"),
      repository: stringField(workflow, "repository"),
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(recordValue: Record<string, unknown>, field: string): string {
  const value = recordValue[field];
  return typeof value === "string" ? value : "";
}

function requireEqual(label: string, actual: string, expected: string): string {
  return actual === expected
    ? ""
    : `${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`;
}

async function runPackageSmokeCommands(extractDir: string) {
  const packageDir = path.join(extractDir, "package");
  const commands = [
    {
      label: "autoresearch",
      script: "autoresearch.mjs",
      args: ["--help"],
      expected: ["Codex Autoresearch", "Usage:"],
    },
    {
      label: "finalize-autoresearch",
      script: "finalize-autoresearch.mjs",
      args: ["--help"],
      expected: ["Finalize an autoresearch branch", "Usage:"],
    },
  ];

  for (const command of commands) {
    const result = await runCommand([
      `package-runtime-smoke:${command.label}`,
      node,
      [path.join(packageDir, "scripts", command.script), ...command.args],
    ]);
    if (result.code !== 0) {
      const output = `${result.stdout}${result.stderr}`.trim();
      return { ok: false, error: output || `${command.label} smoke failed.` };
    }
    const missing = command.expected.filter((text) => !result.stdout.includes(text));
    if (missing.length) {
      return {
        ok: false,
        error: `${command.label} smoke output missed: ${missing.join(", ")}`,
      };
    }
  }

  const dashboardSmoke = await runExtractedPackageDashboardExportSmoke(packageDir, extractDir);
  if (!dashboardSmoke.ok) return dashboardSmoke;

  return { ok: true, error: "" };
}

async function runExtractedPackageDashboardExportSmoke(packageDir: string, extractDir: string) {
  const smokeDir = path.join(extractDir, "dashboard-smoke");
  const outputName = "dashboard-smoke.html";
  const outputPath = path.join(smokeDir, outputName);
  await fsp.mkdir(smokeDir, { recursive: true });
  await fsp.writeFile(
    path.join(smokeDir, "autoresearch.jsonl"),
    [
      JSON.stringify({
        type: "config",
        name: "package dashboard smoke",
        metricName: "quality_gap",
        metricUnit: "gaps",
        bestDirection: "lower",
      }),
      JSON.stringify({
        type: "run",
        run: 1,
        status: "measure",
        metric: 1,
        description: "Packaged dashboard export smoke.",
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await runCommand([
    "package-runtime-smoke:dashboard-export",
    node,
    [
      path.join(packageDir, "scripts", "autoresearch.mjs"),
      "export",
      "--cwd",
      smokeDir,
      "--output",
      outputName,
    ],
  ]);
  if (result.code !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    return { ok: false, error: output || "dashboard export smoke failed." };
  }

  let html = "";
  try {
    html = await fsp.readFile(outputPath, "utf8");
  } catch (error) {
    return { ok: false, error: `dashboard export smoke did not write ${outputPath}: ${error}` };
  }

  const assets = await readPackageDashboardExportAssets(packageDir);
  const assetIssues = dashboardExportAssetIssues(html, assets);
  const markerIssues = [
    html.includes("package dashboard smoke") ? "" : "dashboard export missed smoke session data",
    html.includes('id="dashboard-root"') ? "" : "dashboard export missed dashboard root",
  ].filter(Boolean);
  if (assetIssues.length || markerIssues.length) {
    return { ok: false, error: [...assetIssues, ...markerIssues].join("\n") };
  }

  return { ok: true, error: "" };
}

async function readPackageDashboardExportAssets(
  packageDir: string,
): Promise<DashboardExportAssets> {
  const [app, css] = await Promise.all([
    fsp.readFile(path.join(packageDir, "assets/dashboard-build/dashboard-app.js"), "utf8"),
    fsp.readFile(path.join(packageDir, "assets/dashboard-build/dashboard-app.css"), "utf8"),
  ]);
  return { app, css };
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
  const issues: string[] = Array.isArray(payload.issues) ? payload.issues.map(String) : [];
  const acceptedFinalizationIssue = acceptedCurrentTreeFinalizationIssue(payload);
  const failures = [
    ...issues.filter((issue) => issue !== acceptedFinalizationIssue),
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

  if (acceptedFinalizationIssue) {
    console.log(`ok ${label} (current-tree finalization blocker exposed)`);
  } else {
    console.log(`ok ${label}`);
  }
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

  const runtimeDocs = await sourceRuntimeDocsProblems();
  if (runtimeDocs.length) {
    console.log("ok source-launcher-files");
    console.log("ok source-launcher-committable");
    console.log("ok source-dist-untracked");
    console.log("ok source-dist-ignored");
    console.log("fail source-runtime-docs");
    console.log(indent(runtimeDocs.join("\n")));
    return false;
  }

  console.log("ok source-launcher-files");
  console.log("ok source-launcher-committable");
  console.log("ok source-dist-untracked");
  console.log("ok source-dist-ignored");
  console.log("ok source-runtime-docs");
  return true;
}

async function sourceRuntimeDocsProblems(): Promise<string[]> {
  const requiredDocs: Array<[string, string[]]> = [
    ["docs/maintainers.md", ["dist/", "bootstrap-runtime", "Installed cache drift"]],
    ["docs/troubleshooting.md", ["Source checkout missing `dist/`", "Installed runtime drift"]],
  ];
  const problems: string[] = [];
  for (const [file, expected] of requiredDocs) {
    let content = "";
    try {
      content = await fsp.readFile(path.join(ROOT, file), "utf8");
    } catch (error) {
      problems.push(`${file} could not be read: ${String(error)}`);
      continue;
    }
    for (const text of expected) {
      if (!content.includes(text)) problems.push(`${file} should mention ${text}`);
    }
  }
  return problems;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function normalizePathForGit(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
}

function normalizeFsPath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}
