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

export async function ensureRuntime(entrypoint, importerUrl, options = {}) {
  const { install = true } = options;
  const scriptDir = path.dirname(fileURLToPath(importerUrl));
  const pluginRoot = path.resolve(scriptDir, "..");
  const target = path.join(pluginRoot, "dist", "scripts", entrypoint);

  if (await fileExists(target)) return pathToFileURL(target).href;
  if (!install) throw missingRuntimeError(pluginRoot, target);

  await withRuntimeInstallLock(pluginRoot, async () => {
    if (await fileExists(target)) return;
    await installRuntimeFromRelease(pluginRoot, options);
    if (!(await fileExists(target))) {
      throw new Error(`Release runtime did not provide ${path.relative(pluginRoot, target)}.`);
    }
  });

  return pathToFileURL(target).href;
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

    const extractedDist = path.join(extractDir, "package", "dist");
    if (!(await fileExists(extractedDist))) {
      throw new Error(`Release tarball ${artifacts.tarballName} does not contain dist/.`);
    }
    await verifyReleasePackageManifest(path.join(extractDir, "package"), version);

    await fs.rm(path.join(pluginRoot, "dist"), { recursive: true, force: true });
    await fs.cp(extractedDist, path.join(pluginRoot, "dist"), { recursive: true });
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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
