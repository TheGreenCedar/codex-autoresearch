#!/usr/bin/env node
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dashboardExportAssetIssues,
  dashboardGeneratedDemoExport,
  demoDashboardExportCommand,
  runDemoTrustCheck,
} from "../lib/checks/demo-trust.js";
import {
  indent,
  node,
  normalizeFsPath,
  ROOT,
  runCommand,
  runPhase,
  type CommandResult,
  type CommandSpec,
} from "../lib/checks/check-common.js";
import { acceptedCurrentTreeFinalizationIssue } from "../lib/finalization-acceptance.js";
import {
  releaseChecksumIssue,
  releaseProvenanceGhVerifyArgs,
  releaseProvenanceIssue,
  runPackageArtifactCheck,
  runReleasePackageSmokePhase,
  runReleaseProvenanceSmokePhase,
} from "../lib/checks/package-smoke.js";
import { resolveNpmCommand, type NpmCommandResolveOptions } from "../lib/checks/npm-command.js";
import { runProductPhase } from "../lib/checks/product-phase.js";
import { runSourceHygieneCheck, type SourceFileSnapshot } from "../lib/checks/source-hygiene.js";
import { runSourceCheckoutLauncherCheck } from "../lib/checks/source-checkout-launcher.js";

export {
  dashboardExportAssetIssues,
  dashboardGeneratedDemoExport,
  demoDashboardExportCommand,
  releaseChecksumIssue,
  releaseProvenanceGhVerifyArgs,
  releaseProvenanceIssue,
  resolveNpmCommand,
  type NpmCommandResolveOptions,
};

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

type PhaseSelection =
  | { kind: "all" }
  | { kind: "error"; message: string }
  | { args: string[]; kind: "phase"; phase: string };

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

function shellQuote(value: string) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}
