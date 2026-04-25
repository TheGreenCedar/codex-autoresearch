import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const DOWNLOAD_TIMEOUT_MS = 120_000;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_RETRY_MS = 250;

export async function ensureRuntime(entrypoint, importerUrl) {
  const scriptDir = path.dirname(fileURLToPath(importerUrl));
  const pluginRoot = path.resolve(scriptDir, "..");
  const target = path.join(pluginRoot, "dist", "scripts", entrypoint);

  if (await fileExists(target)) return pathToFileURL(target).href;

  await withRuntimeInstallLock(pluginRoot, async () => {
    if (await fileExists(target)) return;
    await installRuntimeFromRelease(pluginRoot);
    if (!(await fileExists(target))) {
      throw new Error(`Release runtime did not provide ${path.relative(pluginRoot, target)}.`);
    }
  });

  return pathToFileURL(target).href;
}

async function installRuntimeFromRelease(pluginRoot) {
  const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, "package.json"), "utf8"));
  const version = String(pkg.version || "").trim();
  if (!version) throw new Error("package.json does not declare a version.");

  const tag = version.startsWith("v") ? version : `v${version}`;
  const tarballName = `codex-autoresearch-${version.replace(/^v/, "")}.tgz`;
  const url = `https://github.com/TheGreenCedar/codex-autoresearch/releases/download/${tag}/${tarballName}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-autoresearch-runtime-"));
  const tarballPath = path.join(tmpDir, tarballName);
  const extractDir = path.join(tmpDir, "extract");

  try {
    await downloadFile(url, tarballPath);
    await fs.mkdir(extractDir, { recursive: true });
    await run("tar", ["-xzf", tarballPath, "-C", extractDir]);

    const extractedDist = path.join(extractDir, "package", "dist");
    if (!(await fileExists(extractedDist))) {
      throw new Error(`Release tarball ${tarballName} does not contain dist/.`);
    }

    await fs.rm(path.join(pluginRoot, "dist"), { recursive: true, force: true });
    await fs.cp(extractedDist, path.join(pluginRoot, "dist"), { recursive: true });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
