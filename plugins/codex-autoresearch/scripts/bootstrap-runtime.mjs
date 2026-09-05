import { createHash } from "node:crypto";
import { createWriteStream, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import {
  hasDirectorySwapArtifacts,
  recoverDirectorySwapArtifacts,
  replaceDirectoriesRollbackSafe,
} from "./directory-swap.mjs";
import { parseSha256Manifest } from "./release-integrity.mjs";

export { hasDirectorySwapArtifacts, replaceDirectoriesRollbackSafe };

const DOWNLOAD_TIMEOUT_MS = 120_000;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_RETRY_MS = 250;
const MAX_LOCK_RECOVERY_DEPTH = 16;
const PACKAGE_NAME = "codex-autoresearch";
const RELEASE_REPOSITORY = "TheGreenCedar/codex-autoresearch";
const RELEASE_WORKFLOW = `${RELEASE_REPOSITORY}/.github/workflows/release.yml`;
const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const DASHBOARD_BUILD_ASSETS = ["dashboard-app.js", "dashboard-app.css"];

export async function ensureRuntime(entrypoint, importerUrl, options = {}) {
  const { install = true } = options;
  const scriptDir = path.dirname(fileURLToPath(importerUrl));
  const pluginRoot = path.resolve(scriptDir, "..");
  const target = path.join(pluginRoot, "dist", "scripts", entrypoint);

  await rebuildStaleSourceRuntime(pluginRoot, target);
  const replacementTargets = runtimeReplacementTargets(pluginRoot);
  const ready = (await fileExists(target)) && (await dashboardRuntimeReady(pluginRoot));
  const recoveryPending = await hasDirectorySwapArtifacts(replacementTargets);
  if (ready && !recoveryPending) return pathToFileURL(target).href;
  if (!install) {
    if (!ready) throw missingRuntimeError(pluginRoot, target);
    throw new Error(
      "Codex Autoresearch runtime has unfinished replacement artifacts. Run the launcher once with hydration enabled to recover or inspect them safely.",
    );
  }

  await withRuntimeInstallLock(pluginRoot, async () => {
    await recoverDirectorySwapArtifacts(pluginRoot, replacementTargets);
    if ((await fileExists(target)) && (await dashboardRuntimeReady(pluginRoot))) return;
    await installRuntimeFromRelease(pluginRoot, options);
    if (!(await fileExists(target))) {
      throw new Error(`Release runtime did not provide ${path.relative(pluginRoot, target)}.`);
    }
    if (!(await dashboardBuildReady(pluginRoot))) {
      throw new Error("Release runtime did not provide assets/dashboard-build/.");
    }
  });

  return pathToFileURL(target).href;
}

function runtimeReplacementTargets(pluginRoot) {
  return [path.join(pluginRoot, "dist"), path.join(pluginRoot, "assets", "dashboard-build")];
}

async function dashboardRuntimeReady(pluginRoot) {
  return await dashboardBuildReady(pluginRoot);
}

async function dashboardBuildReady(pluginRoot) {
  const buildDir = path.join(pluginRoot, "assets", "dashboard-build");
  return (
    await Promise.all(DASHBOARD_BUILD_ASSETS.map((asset) => fileExists(path.join(buildDir, asset))))
  ).every(Boolean);
}

async function rebuildStaleSourceRuntime(pluginRoot, target) {
  if (!(await fileExists(path.join(pluginRoot, "scripts", "autoresearch.ts")))) return;
  if (!(await fileExists(path.join(pluginRoot, "tsdown.config.ts")))) return;
  if (!(await fileExists(path.join(pluginRoot, "node_modules")))) return;

  const dashboardMissing = !(await dashboardBuildReady(pluginRoot));
  const outputMtime = Math.min(
    await fileMtime(target),
    ...(await Promise.all(
      DASHBOARD_BUILD_ASSETS.map((asset) =>
        fileMtime(path.join(pluginRoot, "assets", "dashboard-build", asset)),
      ),
    )),
  );
  if (!dashboardMissing && (await sourceRuntimeFreshByGit(pluginRoot, outputMtime))) return;
  if (!dashboardMissing && (await newestSourceMtime(pluginRoot)) < outputMtime) return;

  const build = npmBuildInvocation("build");
  await run(build.command, build.args, { cwd: pluginRoot });
}

export function isDirectScript(importerUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  const scriptPath = fileURLToPath(importerUrl);
  const resolvedArgv = path.resolve(argvPath);
  const resolvedScript = path.resolve(scriptPath);
  if (samePath(resolvedArgv, resolvedScript)) return true;

  try {
    return samePath(realpathSync.native(resolvedArgv), realpathSync.native(resolvedScript));
  } catch {
    return false;
  }
}

function samePath(left, right) {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function missingRuntimeError(pluginRoot, target) {
  const relativeTarget = path.relative(pluginRoot, target).replace(/\\/g, "/");
  return new Error(
    [
      `Codex Autoresearch runtime is missing (${relativeTarget}).`,
      "Run `node scripts/autoresearch.mjs --help` from the plugin directory once to hydrate the matching release runtime.",
    ].join(" "),
  );
}

async function installRuntimeFromRelease(pluginRoot, options = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, "package.json"), "utf8"));
  if (String(pkg.name || "").trim() !== PACKAGE_NAME) {
    throw new Error(`package.json name must be ${PACKAGE_NAME} to hydrate release runtime.`);
  }
  const version = normalizeReleaseVersion(pkg.version);

  const artifacts = runtimeReleaseArtifacts(version, options);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-autoresearch-runtime-"));
  const tarballPath = path.join(tmpDir, artifacts.tarballName);
  const checksumPath = path.join(tmpDir, artifacts.checksumName);
  const extractDir = path.join(tmpDir, "extract");

  try {
    await downloadFile(artifacts.tarballUrl, tarballPath);
    await downloadFile(artifacts.checksumUrl, checksumPath);
    await verifyRuntimeTarballIntegrity({
      tarballPath,
      checksumPath,
      tarballName: artifacts.tarballName,
    });
    await verifyRuntimeAttestation(tarballPath);
    await verifyRuntimeArchive(tarballPath);
    await fs.mkdir(extractDir, { recursive: true });
    await run("tar", ["-xzf", tarballPath, "-C", extractDir]);

    const extractedPackage = path.join(extractDir, "package");
    const extractedDist = path.join(extractedPackage, "dist");
    if (!(await fileExists(extractedDist))) {
      throw new Error(`Release tarball ${artifacts.tarballName} does not contain dist/.`);
    }
    const extractedDashboardBuild = path.join(extractedPackage, "assets", "dashboard-build");
    if (!(await dashboardBuildReady(extractedPackage))) {
      throw new Error(
        `Release tarball ${artifacts.tarballName} does not contain assets/dashboard-build/.`,
      );
    }
    await verifyReleasePackageManifest(extractedPackage, version);

    await fs.mkdir(path.join(pluginRoot, "assets"), { recursive: true });
    await replaceDirectoriesRollbackSafe(
      pluginRoot,
      [
        {
          target: path.join(pluginRoot, "dist"),
          source: extractedDist,
          verify: verifyHydratedDist,
        },
        {
          target: path.join(pluginRoot, "assets", "dashboard-build"),
          source: extractedDashboardBuild,
          verify: verifyHydratedDashboardBuild,
        },
      ],
      options.directorySwap,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function verifyHydratedDist(distDir) {
  const required = [
    "lib/runtime-paths.mjs",
    "scripts/autoresearch.mjs",
    "scripts/check.mjs",
    "scripts/finalize-autoresearch.mjs",
  ];
  const missing = [];
  for (const relative of required) {
    if (!(await fileExists(path.join(distDir, relative)))) missing.push(relative);
  }
  if (missing.length) {
    throw new Error(`Release runtime is missing required built files: ${missing.join(", ")}.`);
  }
}

async function verifyHydratedDashboardBuild(buildDir) {
  const missing = [];
  for (const asset of DASHBOARD_BUILD_ASSETS) {
    if (!(await fileExists(path.join(buildDir, asset)))) missing.push(asset);
  }
  if (missing.length) {
    throw new Error(`Release dashboard build is missing required assets: ${missing.join(", ")}.`);
  }
}

export function runtimeReleaseArtifacts(versionInput, options = {}) {
  const version = normalizeReleaseVersion(versionInput);
  const tag = `v${version}`;
  const tarballName = `${PACKAGE_NAME}-${version}.tgz`;
  const checksumName = `${PACKAGE_NAME}-${version}.tgz.sha256`;
  const baseUrl = stripTrailingSlashes(
    options.releaseBaseUrl ||
      `https://github.com/TheGreenCedar/codex-autoresearch/releases/download/${tag}`,
  );
  return {
    version,
    tag,
    tarballName,
    checksumName,
    tarballUrl: `${baseUrl}/${tarballName}`,
    checksumUrl: `${baseUrl}/${checksumName}`,
  };
}

function stripTrailingSlashes(value) {
  let text = String(value);
  while (text.endsWith("/")) text = text.slice(0, -1);
  return text;
}

function normalizeReleaseVersion(versionInput) {
  const version = String(versionInput || "").trim();
  if (!version) throw new Error("package.json does not declare a version.");
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(
      `package.json version ${JSON.stringify(version)} is not a plain release version like 2.1.5.`,
    );
  }
  return version;
}

export async function verifyRuntimeTarballIntegrity({ tarballPath, checksumPath, tarballName }) {
  const manifestText = await fs.readFile(checksumPath, "utf8");
  const expectedHash = parseSha256Manifest(manifestText, tarballName);
  const bytes = await fs.readFile(tarballPath);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      `Release tarball integrity mismatch for ${tarballName}: expected ${expectedHash}, got ${actualHash}.`,
    );
  }
  return { tarballName, sha256: actualHash };
}

export function runtimeAttestationArgs(tarballPath) {
  return [
    "attestation",
    "verify",
    tarballPath,
    "--repo",
    RELEASE_REPOSITORY,
    "--signer-workflow",
    RELEASE_WORKFLOW,
  ];
}

export async function verifyRuntimeAttestation(tarballPath, commandRunner = runCapture) {
  let result;
  try {
    result = await commandRunner("gh", runtimeAttestationArgs(tarballPath));
  } catch (error) {
    throw new Error(
      `Release runtime hydration requires GitHub CLI and network access: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `Release runtime attestation verification failed for ${path.basename(tarballPath)}: ${result.stderr.trim() || result.stdout.trim() || `gh exited with code ${result.code}`}`,
    );
  }
}

export async function verifyRuntimeArchive(tarballPath) {
  const [namesResult, verboseResult] = await Promise.all([
    runCapture("tar", ["-tzf", tarballPath]),
    runCapture("tar", ["-tvzf", tarballPath]),
  ]);
  if (namesResult.code !== 0 || verboseResult.code !== 0) {
    throw new Error(
      `Release tarball manifest could not be read: ${namesResult.stderr.trim() || verboseResult.stderr.trim() || "tar failed"}`,
    );
  }
  const names = nonEmptyLines(namesResult.stdout);
  const verbose = nonEmptyLines(verboseResult.stdout);
  if (!names.length || names.length !== verbose.length) {
    throw new Error("Release tarball manifest is empty or inconsistent.");
  }
  validateRuntimeArchiveEntries(
    names.map((name, index) => ({ name, type: verbose[index].trimStart()[0] || "" })),
  );
}

export function validateRuntimeArchiveEntries(entries) {
  for (const entry of entries) {
    const name = String(entry?.name || "");
    const type = String(entry?.type || "");
    if (type !== "-" && type !== "d") {
      throw new Error(
        `Release tarball contains unsupported entry type ${JSON.stringify(type)}: ${name}`,
      );
    }
    if (
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.startsWith("/") ||
      /^[A-Za-z]:/.test(name)
    ) {
      throw new Error(`Release tarball contains an unsafe path: ${JSON.stringify(name)}.`);
    }
    const segments = name.split("/").filter(Boolean);
    if (
      segments[0] !== "package" ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(`Release tarball entry must stay under package/: ${JSON.stringify(name)}.`);
    }
    const relativeName = segments.slice(1).join("/");
    if (type === "-" && !isExpectedRuntimeArchiveFile(relativeName)) {
      throw new Error(`Release tarball contains an unexpected file: ${JSON.stringify(name)}.`);
    }
    if (type === "d" && !isExpectedRuntimeArchiveDirectory(relativeName)) {
      throw new Error(`Release tarball contains an unexpected directory: ${JSON.stringify(name)}.`);
    }
  }
}

function isExpectedRuntimeArchiveFile(name) {
  if ([".codex-plugin/plugin.json", "LICENSE", "package.json"].includes(name)) return true;
  if (/^assets\/[^/]+\.template$/.test(name)) return true;
  if (/^assets\/dashboard-build\/dashboard-app\.(?:css|js)$/.test(name)) return true;
  if (/^assets\/(?:icon|logo)\.svg$/.test(name)) return true;
  if (/^assets\/showcase\/(?:dashboard-demo\.png|showcase\.md)$/.test(name)) return true;
  if (name === "assets/template.html") return true;
  if (/^dist\/lib\/.+\.mjs$/.test(name)) return true;
  if (
    /^dist\/scripts\/(?:autoresearch|check|check-runner|outcome-worker|finalize-autoresearch|operator-task-benchmark)\.mjs$/.test(
      name,
    )
  ) {
    return true;
  }
  if (/^docs\/.+\.md$/.test(name)) return true;
  if (
    /^scripts\/(?:autoresearch|bootstrap-runtime|check|directory-swap|finalize-autoresearch|operator-task-benchmark|release-integrity)\.mjs$/.test(
      name,
    )
  ) {
    return true;
  }
  return /^skills\/codex-autoresearch\/(?:SKILL\.md|agents\/openai\.yaml|references\/.+\.md)$/.test(
    name,
  );
}

function isExpectedRuntimeArchiveDirectory(name) {
  if (!name) return true;
  return [".codex-plugin", "assets", "dist", "docs", "scripts", "skills"].some(
    (root) => name === root || name.startsWith(`${root}/`),
  );
}

function nonEmptyLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

export async function verifyReleasePackageManifest(packageDir, expectedVersion) {
  const manifestPath = path.join(packageDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Release tarball package.json could not be read: ${String(error)}`);
  }

  if (String(pkg.name || "").trim() !== PACKAGE_NAME) {
    throw new Error(
      `Release tarball package name mismatch: expected ${PACKAGE_NAME}, got ${String(pkg.name || "")}.`,
    );
  }

  const version = normalizeReleaseVersion(pkg.version);
  if (version !== expectedVersion) {
    throw new Error(
      `Release tarball package version mismatch: expected ${expectedVersion}, got ${version}.`,
    );
  }
}

export async function withRuntimeInstallLock(pluginRoot, fn) {
  const lockPath = path.join(pluginRoot, ".codex-autoresearch-runtime.lock");
  const started = Date.now();
  let handle;
  const owner = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };

  while (!handle) {
    try {
      handle = await createRuntimeLock(lockPath, owner);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const currentOwner = await readRuntimeInstallLock(lockPath);
      if (currentOwner && !isPidAlive(currentOwner.pid)) {
        const recoveryOwner = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          token: `${owner.token}-recovery-${Math.random().toString(16).slice(2)}`,
        };
        const claims = await acquireRuntimeRecoveryAuthority(lockPath, currentOwner, recoveryOwner);
        if (claims) {
          try {
            const confirmedOwner = await readRuntimeInstallLock(lockPath);
            if (confirmedOwner?.token === currentOwner.token && !isPidAlive(confirmedOwner.pid)) {
              await fs.rm(lockPath);
              handle = await createRuntimeLock(lockPath, owner);
            }
          } finally {
            await releaseRuntimeRecoveryClaims(claims);
          }
        }
      }
    }
    if (handle) break;
    if (Date.now() - started > LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for runtime install lock at ${lockPath}.`);
    }
    await sleep(LOCK_RETRY_MS);
  }

  try {
    await fn();
  } finally {
    await handle.close().catch(() => {});
    await releaseRuntimeLock(lockPath, owner.token);
  }
}

export function runtimeRecoveryLockPath(lockPath, ownerToken, parentToken = "") {
  const identity = createHash("sha256")
    .update(`${ownerToken}:${parentToken}`)
    .digest("hex")
    .slice(0, 20);
  return `${lockPath}.recovery-${identity}`;
}

async function acquireRuntimeRecoveryAuthority(lockPath, deadOwner, owner) {
  const claims = [];
  let parentToken = "";
  for (let depth = 0; depth < MAX_LOCK_RECOVERY_DEPTH; depth += 1) {
    const recoveryPath = runtimeRecoveryLockPath(lockPath, deadOwner.token, parentToken);
    try {
      const handle = await createRuntimeLock(recoveryPath, owner);
      await handle.close();
      claims.push({ path: recoveryPath, token: owner.token });
      return claims;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const currentOwner = await readRuntimeInstallLock(recoveryPath);
    if (!currentOwner || isPidAlive(currentOwner.pid)) return null;
    claims.push({ path: recoveryPath, token: currentOwner.token });
    parentToken = currentOwner.token;
  }
  throw new Error("Runtime install lock recovery exceeded the dead-owner depth limit.");
}

async function releaseRuntimeRecoveryClaims(claims) {
  for (const claim of [...claims].reverse()) {
    await releaseRuntimeLock(claim.path, claim.token);
  }
}

async function createRuntimeLock(lockPath, owner) {
  const handle = await fs.open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function releaseRuntimeLock(lockPath, token) {
  const currentOwner = await readRuntimeInstallLock(lockPath);
  if (currentOwner?.token === token) {
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function readRuntimeInstallLock(lockPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
    if (!Number.isSafeInteger(parsed?.pid) || parsed.pid < 1 || typeof parsed?.token !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function downloadFile(url, destination) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "codex-autoresearch-runtime-bootstrap" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    }
    await pipeline(response.body, createWriteStream(destination));
  } finally {
    clearTimeout(timeout);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr.trim()}`));
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ code, stdout, stderr });
    });
  });
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function fileMtime(file) {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function sourceRuntimeFreshByGit(pluginRoot, targetMtime) {
  if (!(targetMtime > 0)) return false;
  let parsePorcelainV1Z;
  try {
    ({ parsePorcelainV1Z } = await import(
      pathToFileURL(path.join(pluginRoot, "dist", "lib", "git-paths.mjs")).href
    ));
  } catch {
    return false;
  }
  const [repoRootResult, headPathResult, indexPathResult, status] = await Promise.all([
    runCapture("git", ["rev-parse", "--show-toplevel"], { cwd: pluginRoot }).catch(() => null),
    runCapture("git", ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"], {
      cwd: pluginRoot,
    }).catch(() => null),
    runCapture("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      cwd: pluginRoot,
    }).catch(() => null),
    runCapture(
      "git",
      [
        "status",
        "--porcelain=v1",
        "-z",
        "-uall",
        "--",
        "package.json",
        "lib",
        "scripts",
        "dashboard/src",
        "vite.dashboard.config.ts",
        "assets/template.html",
      ],
      {
        cwd: pluginRoot,
      },
    ).catch(() => null),
  ]);
  if (
    !repoRootResult ||
    repoRootResult.code !== 0 ||
    !headPathResult ||
    headPathResult.code !== 0 ||
    !indexPathResult ||
    indexPathResult.code !== 0 ||
    !status ||
    status.code !== 0
  )
    return false;

  const repoRootText = gitScalar(repoRootResult.stdout);
  const headPathText = gitScalar(headPathResult.stdout);
  const indexPathText = gitScalar(indexPathResult.stdout);
  if (!repoRootText || !headPathText || !indexPathText) return false;

  const dirty = dirtyRuntimeSourcePaths({
    pluginRoot,
    parsePorcelainV1Z,
    repoRoot: repoRootText,
    stdout: status.stdout,
  });
  if (dirty.fullScanRequired) return false;

  const markerMtimes = await Promise.all([
    fileMtime(headPathText),
    fileMtime(indexPathText),
    ...dirty.paths.map((file) => fileMtime(file)),
  ]);
  return Math.max(0, ...markerMtimes) < targetMtime;
}

function dirtyRuntimeSourcePaths({ parsePorcelainV1Z, pluginRoot, repoRoot, stdout }) {
  const paths = [];
  for (const entry of parsePorcelainV1Z(stdout)) {
    const { status } = entry;
    if (
      status.includes("D") ||
      status.includes("R") ||
      status.includes("C") ||
      status.includes("T")
    ) {
      return { fullScanRequired: true, paths };
    }
    for (const gitPath of entry.paths) {
      const absolutePath = path.resolve(repoRoot, gitPath.replace(/\//g, path.sep));
      const relativePath = slashPath(path.relative(pluginRoot, absolutePath));
      if (!isRuntimeSourcePath(relativePath)) continue;
      paths.push(absolutePath);
    }
  }
  return { fullScanRequired: false, paths };
}

function gitScalar(stdout) {
  const text = String(stdout || "");
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

export function isRuntimeSourcePath(relativePath) {
  return (
    relativePath === "package.json" ||
    relativePath === "vite.dashboard.config.ts" ||
    relativePath === "assets/template.html" ||
    relativePath.startsWith("dashboard/src/") ||
    ((relativePath.startsWith("lib/") || relativePath.startsWith("scripts/")) &&
      relativePath.endsWith(".ts"))
  );
}

function slashPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

async function newestSourceMtime(pluginRoot) {
  const files = ["package.json", "vite.dashboard.config.ts", "assets/template.html"];
  for (const dir of ["lib", "scripts", "dashboard/src"]) {
    const entries = await fs
      .readdir(path.join(pluginRoot, dir), { recursive: true })
      .catch(() => []);
    files.push(...entries.map((entry) => path.join(dir, entry)));
  }
  return Math.max(
    0,
    ...(await Promise.all(files.map((file) => fileMtime(path.join(pluginRoot, file))))),
  );
}

function npmBuildInvocation(scriptName = "build:node") {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `npm run ${scriptName}`] };
  }
  return { command: "npm", args: ["run", scriptName] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
