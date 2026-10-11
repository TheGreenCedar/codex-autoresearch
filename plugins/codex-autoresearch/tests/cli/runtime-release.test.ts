import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { PLUGIN_VERSION } from "../../lib/plugin-version.js";
import {
  createRuntimeReleaseAsset,
  escapeRegExp,
  writeFakeSourcePlugin,
} from "../helpers/runtime-release-fixtures.js";
import { withReleaseServer } from "../helpers/server.js";

import { pluginRoot, cli, git, withTempDir } from "../helpers/cli-test-context.js";
import { runProcess } from "../helpers/process.js";

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

async function buildableSourceFixture(dir: string) {
  const { pluginDir, importerUrl } = await writeFakeSourcePlugin(dir);
  await writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "codex-autoresearch",
      version: PLUGIN_VERSION,
      scripts: { build: "node scripts/write-runtime.mjs" },
    }),
  );
  for (const directory of [
    "node_modules",
    "lib",
    "dashboard/src",
    "dist/lib",
    "dist/scripts",
    "assets/dashboard-build",
  ]) {
    await mkdir(path.join(pluginDir, directory), { recursive: true });
  }
  for (const name of [
    "autoresearch.mjs",
    "bootstrap-runtime.mjs",
    "directory-swap.mjs",
    "release-integrity.mjs",
  ]) {
    await copyFile(path.join(pluginRoot, "scripts", name), path.join(pluginDir, "scripts", name));
  }
  for (const file of [
    "tsdown.config.ts",
    "tsconfig.node.json",
    "tsconfig.dashboard.json",
    "tsconfig.json",
    "vite.dashboard.config.ts",
    "lib/policy.ts",
    "scripts/autoresearch.ts",
  ]) {
    await writeFile(path.join(pluginDir, file), file.endsWith(".json") ? "{}\n" : "export {};\n");
  }
  await writeFile(
    path.join(pluginDir, "dist/lib/git-paths.mjs"),
    `export { parsePorcelainV1Z } from ${JSON.stringify(pathToFileURL(path.join(pluginRoot, "lib/git-paths.ts")).href)};\n`,
  );
  await writeFile(
    path.join(pluginDir, "scripts/write-runtime.mjs"),
    `
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const active = await fs.open('build-active', 'wx');
try {
  await fs.appendFile('build-count', process.pid + '\\n');
  await fs.writeFile('build-started', '');
  const hold = await fs.access('build-hold').then(() => true, () => false);
  const deadline = Date.now() + 10000;
  while (hold && !(await fs.access('build-release').then(() => true, () => false))) {
    if (Date.now() > deadline) throw new Error('Build fixture gate timed out.');
    await delay(10);
  }
  await fs.writeFile('dist/scripts/autoresearch.mjs', 'export function runAutoresearchCli() { console.log("fixture-runtime-ready"); return 0; }');
  await fs.writeFile('assets/dashboard-build/dashboard-app.js', 'export {};');
  await fs.writeFile('assets/dashboard-build/dashboard-app.css', '');
} finally {
  await active.close();
  await fs.rm('build-active');
}
`,
  );
  const old = new Date(Date.now() - 2000);
  for (const file of await readdir(pluginDir, { recursive: true })) {
    await utimes(path.join(pluginDir, file), old, old);
  }
  const runtimePath = path.join(pluginDir, "dist/scripts/autoresearch.mjs");
  await writeFile(runtimePath, "export const stale = true;\n");
  await utimes(runtimePath, old, old);
  for (const asset of ["dashboard-app.js", "dashboard-app.css"]) {
    const file = path.join(pluginDir, "assets/dashboard-build", asset);
    await writeFile(file, "");
    await utimes(file, old, old);
  }
  const runLauncher = () =>
    runProcess(process.execPath, [path.join(pluginDir, "scripts/autoresearch.mjs")], pluginDir);
  const builds = async () =>
    (await readFile(path.join(pluginDir, "build-count"), "utf8")).trim().split("\n").length;
  return { pluginDir, importerUrl, runLauncher, builds };
}

test("source launcher rebuilds after build config changes", async () => {
  await withTempDir("runtime-build-configs", async (dir) => {
    const { pluginDir, runLauncher, builds } = await buildableSourceFixture(dir);
    assert.equal((await runLauncher()).code, 0);
    let expected = 1;
    for (const file of [
      "tsdown.config.ts",
      "tsconfig.node.json",
      "tsconfig.dashboard.json",
      "tsconfig.json",
      "vite.dashboard.config.ts",
    ]) {
      await delay(20);
      await writeFile(
        path.join(pluginDir, file),
        file.endsWith(".json") ? '{"changed":true}\n' : "export default {};\n",
      );
      const result = await runLauncher();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await builds(), ++expected, file);
    }
    assert.equal((await runLauncher()).code, 0);
    assert.equal(await builds(), expected);
  });
});

test("source launcher rebuilds once after source deletion or rename with and without Git", async () => {
  for (const useGit of [false, true]) {
    for (const mutation of ["delete", "rename", "delete-directory"]) {
      await withTempDir(`runtime-source-${mutation}-${useGit}`, async (dir) => {
        const { pluginDir, runLauncher, builds } = await buildableSourceFixture(dir);
        if (mutation === "delete-directory") {
          await mkdir(path.join(pluginDir, "lib/nested"));
          await writeFile(path.join(pluginDir, "lib/nested/policy.ts"), "export {};\n");
        }
        if (useGit) {
          await writeFile(
            path.join(pluginDir, ".gitignore"),
            "dist/\nassets/dashboard-build/\nnode_modules/\nbuild-*\n",
          );
          await git(pluginDir, ["init"]);
          await git(pluginDir, ["add", "."]);
          await git(pluginDir, ["commit", "-m", "Fixture source"]);
        }
        assert.equal((await runLauncher()).code, 0);
        await delay(20);
        const source = path.join(pluginDir, "lib/policy.ts");
        if (mutation === "delete-directory")
          await rm(path.join(pluginDir, "lib/nested"), { recursive: true });
        else if (mutation === "delete") await rm(source);
        else if (useGit) await git(pluginDir, ["mv", "lib/policy.ts", "lib/renamed.ts"]);
        else await rename(source, path.join(pluginDir, "lib/renamed.ts"));
        const result = await runLauncher();
        assert.equal(result.code, 0, result.stderr);
        assert.equal(await builds(), 2, `${mutation}, Git=${useGit}`);
        const repeated = await runLauncher();
        assert.equal(repeated.code, 0, repeated.stderr);
        assert.equal(
          await builds(),
          2,
          `A built ${mutation}, Git=${useGit} must not rebuild again. ${repeated.stderr}`,
        );
      });
    }
  }
});

test("source launcher rebuilds once after a source file type changes", async (t) => {
  await withTempDir("runtime-source-type-change", async (dir) => {
    const { pluginDir, runLauncher, builds } = await buildableSourceFixture(dir);
    await writeFile(
      path.join(pluginDir, ".gitignore"),
      "dist/\nassets/dashboard-build/\nnode_modules/\nbuild-*\n",
    );
    await git(pluginDir, ["init"]);
    await git(pluginDir, ["config", "core.symlinks", "true"]);
    await git(pluginDir, ["add", "."]);
    await git(pluginDir, ["commit", "-m", "Fixture source"]);
    assert.equal((await runLauncher()).code, 0);
    const replacement = path.join(pluginDir, "link-target.ts");
    await writeFile(replacement, "export {};\n");
    const old = new Date(Date.now() - 2000);
    await utimes(replacement, old, old);
    await delay(20);
    const source = path.join(pluginDir, "lib/policy.ts");
    await rm(source);
    try {
      await symlink(replacement, source);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      t.skip("Windows does not permit this test's file symlink.");
      return;
    }
    assert.equal(
      (await git(pluginDir, ["status", "--porcelain", "--", "lib/policy.ts"])).slice(0, 2).trim(),
      "T",
    );
    const result = await runLauncher();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await builds(), 2);
    assert.equal((await runLauncher()).code, 0);
    assert.equal(await builds(), 2);
  });
});

test("source launcher serializes concurrent source rebuilds and rechecks freshness", async () => {
  await withTempDir("runtime-concurrent-source-build", async (dir) => {
    const { pluginDir, builds } = await buildableSourceFixture(dir);
    await writeFile(path.join(pluginDir, "build-hold"), "");
    const observer = path.join(pluginDir, "observe-lock.mjs");
    await writeFile(
      observer,
      `
import fs from 'node:fs/promises';
import path from 'node:path';
const open = fs.open;
fs.open = async (...args) => {
  try { return await open(...args); }
  catch (error) {
    if (error.code === 'EEXIST' && path.basename(args[0]) === '.codex-autoresearch-runtime.lock') {
      await fs.writeFile('lock-contended', '');
    }
    throw error;
  }
};
`,
    );
    const args = [
      "--import",
      pathToFileURL(observer).href,
      path.join(pluginDir, "scripts/autoresearch.mjs"),
    ];
    const first = runProcess(process.execPath, args, pluginDir);
    const waitForFile = async (name: string) => {
      const deadline = Date.now() + 10000;
      while (
        !(await access(path.join(pluginDir, name)).then(
          () => true,
          () => false,
        ))
      ) {
        assert(Date.now() < deadline, `Timed out waiting for ${name}.`);
        await delay(10);
      }
    };
    await waitForFile("build-started");
    const second = runProcess(process.execPath, args, pluginDir);
    const completed = Promise.all([first, second]);
    try {
      await waitForFile("lock-contended");
    } finally {
      await writeFile(path.join(pluginDir, "build-release"), "");
      await completed;
    }
    for (const result of await completed) {
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /fixture-runtime-ready/);
    }
    assert.equal(await builds(), 1);
  });
});

test("install false blocks source rebuild while recovery evidence is pending", async () => {
  await withTempDir("runtime-source-no-install-recovery", async (dir) => {
    const { pluginDir, importerUrl } = await buildableSourceFixture(dir);
    const artifact = path.join(pluginDir, ".dist.codex-autoresearch-stage-unowned");
    await mkdir(artifact);
    const bootstrap = await import(
      pathToFileURL(path.join(pluginRoot, "scripts/bootstrap-runtime.mjs")).href
    );
    await assert.rejects(
      bootstrap.ensureRuntime("autoresearch.mjs", importerUrl, { install: false }),
      /unfinished replacement artifacts/,
    );
    await access(artifact);
    await assert.rejects(access(path.join(pluginDir, "build-count")));
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
