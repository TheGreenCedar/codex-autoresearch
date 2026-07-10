import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import {
  createRuntimeReleaseAsset,
  escapeRegExp,
  writeFakeSourcePlugin,
} from "../helpers/runtime-release-fixtures.js";
import { withReleaseServer } from "../helpers/server.js";

import { pluginRoot, cli, withTempDir } from "../helpers/cli-test-context.js";

test("runShell configures a POSIX process group for timeout cleanup", async () => {
  const [cliShim, bootstrap, releaseIntegrity, runner] = await Promise.all([
    readFile(cli, "utf8"),
    readFile(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs"), "utf8"),
    readFile(path.join(pluginRoot, "scripts", "release-integrity.mjs"), "utf8"),
    readFile(path.join(pluginRoot, "lib", "runner.ts"), "utf8"),
  ]);
  assert.match(
    cliShim,
    /import \{ ensureRuntime, isDirectScript \} from "\.\/bootstrap-runtime\.mjs"/,
  );
  assert.match(cliShim, /isDirectScript\(import\.meta\.url\)/);
  assert.match(
    cliShim,
    /await import\(await ensureRuntime\("autoresearch\.mjs", import\.meta\.url\)\)/,
  );
  const checkShim = await readFile(path.join(pluginRoot, "scripts", "check.mjs"), "utf8");
  assert.match(checkShim, /import \{ ensureRuntime \} from "\.\/bootstrap-runtime\.mjs"/);
  assert.match(checkShim, /await import\(await ensureRuntime\("check\.mjs", import\.meta\.url\)\)/);
  assert.match(bootstrap, /path\.join\(pluginRoot, "dist", "scripts", entrypoint\)/);
  assert.match(bootstrap, /verifyRuntimeTarballIntegrity/);
  assert.match(bootstrap, /\.tgz\.sha256/);
  assert.match(releaseIntegrity, /Checksum manifest expected asset/);
  assert.match(bootstrap, /Release tarball package version mismatch/);
  assert.match(bootstrap, /node scripts\/autoresearch\.mjs --help/);
  assert.match(runner, /detached:\s*process\.platform !== "win32"/);
});

test("source launcher direct-script detection survives normalized paths", async () => {
  await withTempDir("launcher-direct", async (dir) => {
    const script = path.join(dir, "autoresearch.mjs");
    const other = path.join(dir, "other.mjs");
    await writeFile(script, "");
    await writeFile(other, "");

    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );
    assert.equal(typeof bootstrap.isDirectScript, "function");
    assert.equal(bootstrap.isDirectScript(pathToFileURL(script).href, script), true);
    assert.equal(bootstrap.isDirectScript(pathToFileURL(script).href, other), false);

    const link = path.join(dir, "autoresearch-link.mjs");
    try {
      await symlink(script, link);
      assert.equal(bootstrap.isDirectScript(pathToFileURL(script).href, link), true);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  });
});

test("source launcher rebuilds local source runtime before use", async () => {
  await withTempDir("runtime-stale-source-build", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    await writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "codex-autoresearch",
          version: PLUGIN_VERSION,
          scripts: {
            build: "node scripts/write-runtime.mjs --dashboard",
            "build:node": "node scripts/write-runtime.mjs",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await mkdir(path.join(pluginDir, "node_modules"), { recursive: true });
    await mkdir(path.join(pluginDir, "dist", "scripts"), { recursive: true });
    const target = path.join(pluginDir, "dist", "scripts", "autoresearch.mjs");
    await writeFile(target, "export const staleRuntime = true;\n", "utf8");
    await writeFile(path.join(pluginDir, "tsdown.config.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(pluginDir, "scripts", "autoresearch.ts"), "export {};\n", "utf8");
    await writeFile(
      path.join(pluginDir, "scripts", "write-runtime.mjs"),
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        'const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
        'const includeDashboard = process.argv.includes("--dashboard");',
        'await mkdir(path.join(root, "dist", "scripts"), { recursive: true });',
        'await writeFile(path.join(root, "dist", "scripts", "autoresearch.mjs"), "export const rebuiltRuntime = true;\\n", "utf8");',
        "if (includeDashboard) {",
        '  await mkdir(path.join(root, "assets", "dashboard-build"), { recursive: true });',
        '  await writeFile(path.join(root, "assets", "dashboard-build", "dashboard-app.js"), "window.__rebuiltDashboard = true;\\n", "utf8");',
        '  await writeFile(path.join(root, "assets", "dashboard-build", "dashboard-app.css"), "#dashboard-root { color: rgb(1, 2, 3); }\\n", "utf8");',
        "}",
      ].join("\n"),
      "utf8",
    );

    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );
    const runtimeHref = await bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, {
      releaseBaseUrl: "http://127.0.0.1:1",
    });

    assert.equal(
      await readFile(new URL(runtimeHref), "utf8"),
      "export const rebuiltRuntime = true;\n",
    );
    assert.match(
      await readFile(path.join(pluginDir, "assets", "dashboard-build", "dashboard-app.js"), "utf8"),
      /rebuiltDashboard/,
    );
  });
});

test("runtime release artifacts trim trailing slashes without regex matching", async () => {
  const bootstrap = await import(
    pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
  );
  const artifacts = bootstrap.runtimeReleaseArtifacts("1.2.3", {
    releaseBaseUrl: "https://example.invalid/releases////",
  });

  assert.equal(
    artifacts.tarballUrl,
    "https://example.invalid/releases/codex-autoresearch-1.2.3.tgz",
  );
});

test("source launcher fails closed when release checksum metadata is missing", async () => {
  await withTempDir("runtime-hydration-missing-checksum", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, { writeChecksum: false });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        /\.tgz\.sha256: HTTP 404/,
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});

test("source launcher fails closed when release checksum mismatches", async () => {
  await withTempDir("runtime-hydration-bad-checksum", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, { checksumHash: "0".repeat(64) });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        /Release tarball integrity mismatch/,
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});

test("source launcher rejects multi-entry checksum manifests", async () => {
  await withTempDir("runtime-hydration-multi-checksum", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, {
      checksumText: ({ actualHash, tarballName }) =>
        `${actualHash}  ${tarballName}\n${"0".repeat(64)}  other.tgz\n`,
    });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        /must contain exactly one asset entry; found 2/,
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});

test("source launcher rejects unnamed checksum manifests", async () => {
  await withTempDir("runtime-hydration-unnamed-checksum", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, {
      checksumText: ({ actualHash }) => `${actualHash}\n`,
    });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        /must contain a SHA-256 entry generated by sha256sum/,
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});

test("source launcher rejects checksum manifests for the wrong release asset", async () => {
  await withTempDir("runtime-hydration-wrong-asset", async (dir) => {
    const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
    const release = await createRuntimeReleaseAsset(dir, {
      checksumFileName: "codex-autoresearch-0.0.0.tgz",
    });
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs")).href
    );

    await withReleaseServer(release.releaseDir, PLUGIN_VERSION, async (releaseBaseUrl) => {
      await assert.rejects(
        () => bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl }),
        new RegExp(
          `Checksum manifest expected asset codex-autoresearch-${escapeRegExp(PLUGIN_VERSION)}\\.tgz, got codex-autoresearch-0\\.0\\.0\\.tgz`,
        ),
      );
    });
    await assert.rejects(access(path.join(pluginDir, "dist", "scripts", "autoresearch.mjs")));
  });
});
