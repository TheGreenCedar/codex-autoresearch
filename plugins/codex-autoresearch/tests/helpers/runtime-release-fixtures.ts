import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";

async function runTar(args, cwd) {
  const result = await new Promise((resolve) => {
    const child = spawn("tar", args, {
      cwd,
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
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: String(error.message || error) }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, `tar ${args.join(" ")} failed\n${result.stderr}${result.stdout}`);
}

export async function writeFakeSourcePlugin(dir, version = PLUGIN_VERSION) {
  const pluginDir = path.join(dir, "source-plugin");
  const scriptsDir = path.join(pluginDir, "scripts");
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: "codex-autoresearch", version }, null, 2),
    "utf8",
  );
  return {
    pluginDir,
    importerUrl: pathToFileURL(path.join(scriptsDir, "autoresearch.mjs")).href,
  };
}

export async function createRuntimeReleaseAsset(
  dir,
  {
    sourceVersion = PLUGIN_VERSION,
    packageVersion = sourceVersion,
    packageName = "codex-autoresearch",
    checksumFileName,
    checksumHash,
    dashboardAppText = "window.__CODEX_AUTORESEARCH_DASHBOARD_APP__ = true;\n",
    dashboardCssText = "#dashboard-root { color: rgb(12, 34, 56); }\n",
    runtimeText = "export const hydratedRuntime = true;\n",
    writeChecksum = true,
  } = {},
) {
  const releaseDir = path.join(dir, `release-${Math.random().toString(16).slice(2)}`);
  const packageParent = path.join(dir, `package-parent-${Math.random().toString(16).slice(2)}`);
  const packageDir = path.join(packageParent, "package");
  const tarballName = `codex-autoresearch-${sourceVersion}.tgz`;
  const checksumName = `${tarballName}.sha256`;
  const tarballPath = path.join(releaseDir, tarballName);
  const checksumPath = path.join(releaseDir, checksumName);

  await mkdir(path.join(packageDir, "dist", "scripts"), { recursive: true });
  await mkdir(releaseDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version: packageVersion }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(packageDir, "dist", "scripts", "autoresearch.mjs"),
    runtimeText,
    "utf8",
  );
  await mkdir(path.join(packageDir, "assets", "dashboard-build"), { recursive: true });
  await writeFile(
    path.join(packageDir, "assets", "dashboard-build", "dashboard-app.js"),
    dashboardAppText,
    "utf8",
  );
  await writeFile(
    path.join(packageDir, "assets", "dashboard-build", "dashboard-app.css"),
    dashboardCssText,
    "utf8",
  );

  await runTar(["-czf", tarballPath, "-C", packageParent, "package"], dir);
  const actualHash = createHash("sha256")
    .update(await readFile(tarballPath))
    .digest("hex");
  if (writeChecksum) {
    await writeFile(
      checksumPath,
      `${checksumHash || actualHash}  ${checksumFileName || tarballName}\n`,
      "utf8",
    );
  }

  return { releaseDir, tarballName, checksumName, tarballPath, checksumPath, actualHash };
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
