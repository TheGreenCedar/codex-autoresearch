import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  errorMessage,
  indent,
  node,
  optionValue,
  ROOT,
  runCommand,
  type ResolvedSpawnCommand,
} from "./check-common.js";
import { dashboardExportAssetIssues, type DashboardExportAssets } from "./demo-trust.js";
import { resolveNpmCommand } from "./npm-command.js";
import { fileSha256, parseStrictSha256Manifest, releaseChecksumIssue } from "./package-checksum.js";

export { releaseChecksumIssue };

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

const ALLOWED_PACKAGED_SOURCE_SCRIPTS = new Set([
  "scripts/autoresearch.mjs",
  "scripts/bootstrap-runtime.mjs",
  "scripts/check.mjs",
  "scripts/directory-swap.mjs",
  "scripts/finalize-autoresearch.mjs",
  "scripts/release-integrity.mjs",
]);

const ALLOWED_PACKAGED_DIST_SCRIPTS = new Set([
  "dist/scripts/autoresearch.mjs",
  "dist/scripts/check.mjs",
  "dist/scripts/check-runner.mjs",
  "dist/scripts/finalize-autoresearch.mjs",
]);

export async function runPackageArtifactCheck() {
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
      "dist/scripts/check.mjs",
      "dist/scripts/check-runner.mjs",
      "dist/scripts/finalize-autoresearch.mjs",
      "dist/lib/checks/check-common.mjs",
      "dist/lib/checks/demo-trust.mjs",
      "dist/lib/checks/npm-command.mjs",
      "dist/lib/checks/package-smoke.mjs",
      "dist/lib/checks/product-phase.mjs",
      "dist/lib/checks/source-checkout-launcher.mjs",
      "dist/lib/checks/source-hygiene.mjs",
      "scripts/bootstrap-runtime.mjs",
      "scripts/autoresearch.mjs",
      "scripts/check.mjs",
      "scripts/directory-swap.mjs",
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
    ];

    const missing = requiredPaths.filter((file) => !packedPaths.has(file));
    const unexpected = [...forbiddenPaths, ...forbiddenPackagePaths].filter((file) =>
      packedPaths.has(file),
    );
    const leakedExamples = Array.from(packedPaths).filter((file) => file.startsWith("examples/"));
    const leakedTestPaths = Array.from(packedPaths).filter(
      (file) => file.startsWith("tests/") || file.startsWith("dist/tests/"),
    );
    const leakedAuthoredSourcePaths = Array.from(packedPaths).filter(
      (file) =>
        file.startsWith("dashboard/src/") ||
        (/^(?:lib|scripts)\/.+\.ts$/.test(file) && !file.endsWith(".d.ts")),
    );
    const leakedScriptPaths = packageScriptLeaks(packedPaths);
    const wrapperProblems = await packageWrapperProblems(packedEntries);

    if (
      missing.length ||
      unexpected.length ||
      leakedExamples.length ||
      leakedTestPaths.length ||
      leakedAuthoredSourcePaths.length ||
      leakedScriptPaths.length ||
      wrapperProblems.length
    ) {
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
      if (leakedTestPaths.length) {
        console.log(indent(`Leaked test files in package:\n${leakedTestPaths.join("\n")}`));
      }
      if (leakedAuthoredSourcePaths.length) {
        console.log(
          indent(
            `Leaked authored source files in package:\n${leakedAuthoredSourcePaths.join("\n")}`,
          ),
        );
      }
      if (leakedScriptPaths.length) {
        console.log(
          indent(`Leaked non-runtime scripts in package:\n${leakedScriptPaths.join("\n")}`),
        );
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

export async function runReleasePackageSmokePhase(args: string[]): Promise<boolean> {
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

export async function runReleaseProvenanceSmokePhase(args: string[]): Promise<boolean> {
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

function packageScriptLeaks(packedPaths: Set<string>) {
  return Array.from(packedPaths)
    .filter((file) => {
      if (file.startsWith("scripts/") && file.endsWith(".mjs")) {
        return !ALLOWED_PACKAGED_SOURCE_SCRIPTS.has(file);
      }
      if (file.startsWith("dist/scripts/") && file.endsWith(".mjs")) {
        return !ALLOWED_PACKAGED_DIST_SCRIPTS.has(file);
      }
      return false;
    })
    .sort();
}

function normalizedPackagePath(entry: PackageEntry) {
  return String(entry.path || "").replace(/\\/g, "/");
}

async function packageWrapperProblems(packedEntries: Map<string, PackageEntry>) {
  const wrappers = [
    ["scripts/autoresearch.mjs", 'ensureRuntime("autoresearch.mjs"'],
    ["scripts/check.mjs", 'ensureRuntime("check.mjs"'],
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
  const expectedSignerWorkflowPath = signerWorkflow.slice(`${repo}/`.length);
  const expectedBuilderUri = `https://github.com/${signerWorkflow}@refs/heads/main`;
  for (const entry of matching) {
    const expectedWorkflowPath =
      workflowPathFromBuildConfigUri(entry.certificate.buildConfigURI, repo) ||
      expectedSignerWorkflowPath;
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
      buildConfigURI: stringField(certificate, "buildConfigURI"),
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
        buildConfigURI: stringField(certificate, "buildConfigURI"),
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

function workflowPathFromBuildConfigUri(buildConfigUri: string, repo: string): string {
  const prefix = `https://github.com/${repo}/`;
  const suffix = "@refs/heads/main";
  if (!buildConfigUri.startsWith(prefix) || !buildConfigUri.endsWith(suffix)) return "";
  return buildConfigUri.slice(prefix.length, -suffix.length);
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
    {
      label: "check-source-hygiene",
      script: "check.mjs",
      args: ["--phase", "source-hygiene"],
      // Exit 0 proves the packaged wrapper can load the dist check runner chain; output
      // differs by whether the host temp layout looks like a Git checkout.
      expected: [],
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
