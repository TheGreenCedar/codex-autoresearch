import { createHash } from "node:crypto";
import { createWriteStream, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const DOWNLOAD_TIMEOUT_MS = 120_000;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_RETRY_MS = 250;
const PACKAGE_NAME = "codex-autoresearch";
const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const DASHBOARD_BUILD_ASSETS = ["dashboard-app.js", "dashboard-app.css"];

export async function ensureRuntime(entrypoint, importerUrl, options = {}) {
  const { install = true } = options;
  const scriptDir = path.dirname(fileURLToPath(importerUrl));
  const pluginRoot = path.resolve(scriptDir, "..");
  const target = path.join(pluginRoot, "dist", "scripts", entrypoint);

  await rebuildStaleSourceRuntime(pluginRoot, target);
  if ((await fileExists(target)) && (await dashboardRuntimeReady(pluginRoot))) {
    return pathToFileURL(target).href;
  }
  if (!install) throw missingRuntimeError(pluginRoot, target);

  await withRuntimeInstallLock(pluginRoot, async () => {
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

async function dashboardRuntimeReady(pluginRoot) {
  if (await dashboardBuildReady(pluginRoot)) return true;
  return await isSourceDevelopmentCheckout(pluginRoot);
}

async function dashboardBuildReady(pluginRoot) {
  const buildDir = path.join(pluginRoot, "assets", "dashboard-build");
  return (
    await Promise.all(DASHBOARD_BUILD_ASSETS.map((asset) => fileExists(path.join(buildDir, asset))))
  ).every(Boolean);
}

async function isSourceDevelopmentCheckout(pluginRoot) {
  return (
    (await fileExists(path.join(pluginRoot, "scripts", "autoresearch.ts"))) &&
    (await fileExists(path.join(pluginRoot, "tsdown.config.ts")))
  );
}

async function rebuildStaleSourceRuntime(pluginRoot, target) {
  if (!(await fileExists(path.join(pluginRoot, "scripts", "autoresearch.ts")))) return;
  if (!(await fileExists(path.join(pluginRoot, "tsdown.config.ts")))) return;
  if (!(await fileExists(path.join(pluginRoot, "node_modules")))) return;

  const targetMtime = await fileMtime(target);
  if (await sourceRuntimeFreshByGit(pluginRoot, targetMtime)) return;
  if ((await newestSourceMtime(pluginRoot)) < targetMtime) return;

  const build = npmBuildInvocation();
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

    await fs.rm(path.join(pluginRoot, "dist"), { recursive: true, force: true });
    await fs.cp(extractedDist, path.join(pluginRoot, "dist"), { recursive: true });
    await fs.rm(path.join(pluginRoot, "assets", "dashboard-build"), {
      recursive: true,
      force: true,
    });
    await fs.mkdir(path.join(pluginRoot, "assets"), { recursive: true });
    await fs.cp(extractedDashboardBuild, path.join(pluginRoot, "assets", "dashboard-build"), {
      recursive: true,
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function runtimeReleaseArtifacts(versionInput, options = {}) {
  const version = normalizeReleaseVersion(versionInput);
  const tag = `v${version}`;
  const tarballName = `${PACKAGE_NAME}-${version}.tgz`;
  const checksumName = `${PACKAGE_NAME}-${version}.tgz.sha256`;
  const baseUrl = String(
    options.releaseBaseUrl ||
      `https://github.com/TheGreenCedar/codex-autoresearch/releases/download/${tag}`,
  ).replace(/\/+$/, "");
  return {
    version,
    tag,
    tarballName,
    checksumName,
    tarballUrl: `${baseUrl}/${tarballName}`,
    checksumUrl: `${baseUrl}/${checksumName}`,
  };
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

export function parseSha256Manifest(text, expectedFileName) {
  const entries = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let hash = "";
    let fileName = "";
    const coreutils = line.match(/^([a-fA-F0-9]{64})\s+(.+)$/);
    const openssl = line.match(/^SHA256\s*\(([^)]+)\)\s*=\s*([a-fA-F0-9]{64})$/i);
    if (coreutils) {
      hash = coreutils[1].toLowerCase();
      fileName = coreutils[2].trim();
      if (fileName.startsWith("*")) fileName = fileName.slice(1).trimStart();
    } else if (openssl) {
      fileName = openssl[1].trim();
      hash = openssl[2].toLowerCase();
    } else {
      throw new Error(
        `Checksum manifest for ${expectedFileName} must contain a SHA-256 entry generated by sha256sum.`,
      );
    }
    entries.push({ hash, fileName });
  }

  if (entries.length !== 1) {
    throw new Error(
      `Checksum manifest for ${expectedFileName} must contain exactly one asset entry; found ${entries.length}.`,
    );
  }

  const entry = entries[0];
  if (entry.fileName !== expectedFileName) {
    throw new Error(`Checksum manifest expected asset ${expectedFileName}, got ${entry.fileName}.`);
  }
  return entry.hash;
}

async function verifyReleasePackageManifest(packageDir, expectedVersion) {
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

async function withRuntimeInstallLock(pluginRoot, fn) {
  const lockPath = path.join(pluginRoot, ".codex-autoresearch-runtime.lock");
  const started = Date.now();
  let handle;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for runtime install lock at ${lockPath}.`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
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
  const [metadata, status] = await Promise.all([
    runCapture(
      "git",
      [
        "rev-parse",
        "--show-toplevel",
        "--path-format=absolute",
        "--git-path",
        "HEAD",
        "--git-path",
        "index",
      ],
      {
        cwd: pluginRoot,
      },
    ).catch(() => null),
    runCapture(
      "git",
      ["status", "--porcelain=v1", "-uall", "--", "package.json", "lib", "scripts"],
      {
        cwd: pluginRoot,
      },
    ).catch(() => null),
  ]);
  if (!metadata || metadata.code !== 0 || !status || status.code !== 0) return false;

  const [repoRootText, headPathText, indexPathText] = metadata.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!repoRootText || !headPathText || !indexPathText) return false;

  const dirty = dirtyRuntimeSourcePaths({
    pluginRoot,
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

function dirtyRuntimeSourcePaths({ pluginRoot, repoRoot, stdout }) {
  const paths = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const status = rawLine.slice(0, 2);
    const parsed = parsePorcelainPath(rawLine.slice(3));
    if (!parsed) continue;
    if (
      status.includes("D") ||
      status.includes("R") ||
      status.includes("C") ||
      status.includes("T")
    ) {
      return { fullScanRequired: true, paths };
    }
    const absolutePath = path.resolve(repoRoot, parsed.replace(/\//g, path.sep));
    const relativePath = slashPath(path.relative(pluginRoot, absolutePath));
    if (!isRuntimeSourcePath(relativePath)) continue;
    paths.push(absolutePath);
  }
  return { fullScanRequired: false, paths };
}

function parsePorcelainPath(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  const renamed = value.lastIndexOf(" -> ");
  const pathText = renamed >= 0 ? value.slice(renamed + 4) : value;
  if (!pathText.startsWith('"')) return pathText;
  try {
    return JSON.parse(pathText);
  } catch {
    return pathText.slice(1, -1);
  }
}

function isRuntimeSourcePath(relativePath) {
  return (
    relativePath === "package.json" ||
    ((relativePath.startsWith("lib/") || relativePath.startsWith("scripts/")) &&
      relativePath.endsWith(".ts"))
  );
}

function slashPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

async function newestSourceMtime(pluginRoot) {
  const files = ["package.json"];
  for (const dir of ["lib", "scripts"]) {
    const entries = await fs
      .readdir(path.join(pluginRoot, dir), { recursive: true })
      .catch(() => []);
    files.push(
      ...entries
        .filter((entry) => String(entry).endsWith(".ts"))
        .map((entry) => path.join(dir, entry)),
    );
  }
  return Math.max(
    0,
    ...(await Promise.all(files.map((file) => fileMtime(path.join(pluginRoot, file))))),
  );
}

function npmBuildInvocation() {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm run build:node"] };
  }
  return { command: "npm", args: ["run", "build:node"] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
