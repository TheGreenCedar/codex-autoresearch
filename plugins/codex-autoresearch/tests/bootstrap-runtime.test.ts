import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { PLUGIN_VERSION } from "../lib/plugin-version.js";

import {
  ensureRuntime,
  hasDirectorySwapArtifacts,
  isRuntimeSourcePath,
  replaceDirectoriesRollbackSafe,
  runtimeRecoveryLockPath,
  runtimeAttestationArgs,
  validateRuntimeArchiveEntries,
  verifyRuntimeArchive,
  verifyRuntimeAttestation,
  verifyReleasePackageManifest,
  withRuntimeInstallLock,
} from "../scripts/bootstrap-runtime.mjs";

const SWAP_ARTIFACT = /\.codex-autoresearch-(?:stage|rollback)-/;

async function seedDirectory(directory: string, value: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "value.txt"), value, "utf8");
}

async function directoryValue(directory: string): Promise<string> {
  return await readFile(path.join(directory, "value.txt"), "utf8");
}

async function swapArtifacts(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).filter((entry) => SWAP_ARTIFACT.test(entry));
}

test("runtime directory transaction stages both surfaces and swaps them together", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-swap-"));
  try {
    const dist = path.join(root, "dist");
    const dashboard = path.join(root, "assets", "dashboard-build");
    const newDist = path.join(root, "sources", "dist");
    const newDashboard = path.join(root, "sources", "dashboard");
    await Promise.all([
      seedDirectory(dist, "old-dist"),
      seedDirectory(dashboard, "old-dashboard"),
      seedDirectory(newDist, "new-dist"),
      seedDirectory(newDashboard, "new-dashboard"),
    ]);

    const verified: string[] = [];
    await replaceDirectoriesRollbackSafe(root, [
      {
        source: newDist,
        target: dist,
        verify: async (directory: string) => verified.push(await directoryValue(directory)),
      },
      {
        source: newDashboard,
        target: dashboard,
        verify: async (directory: string) => verified.push(await directoryValue(directory)),
      },
    ]);

    assert.equal(await directoryValue(dist), "new-dist");
    assert.equal(await directoryValue(dashboard), "new-dashboard");
    assert.deepEqual(verified, ["new-dist", "new-dashboard", "new-dist", "new-dashboard"]);
    assert.deepEqual(await swapArtifacts(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("faults after each transaction phase restore every original runtime surface", async () => {
  for (const phase of ["after-stage", "after-all-backups", "after-install", "after-all-installs"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `autoresearch-runtime-${phase}-`));
    try {
      const first = path.join(root, "dist");
      const second = path.join(root, "assets", "dashboard-build");
      const firstSource = path.join(root, "sources", "dist");
      const secondSource = path.join(root, "sources", "dashboard");
      await Promise.all([
        seedDirectory(first, "old-first"),
        seedDirectory(second, "old-second"),
        seedDirectory(firstSource, "new-first"),
        seedDirectory(secondSource, "new-second"),
      ]);
      let injected = false;
      await assert.rejects(
        replaceDirectoriesRollbackSafe(
          root,
          [
            { source: firstSource, target: first },
            { source: secondSource, target: second },
          ],
          {
            onPhase: async (currentPhase: string) => {
              if (currentPhase === phase && !injected) {
                injected = true;
                throw new Error(`injected ${phase}`);
              }
            },
          },
        ),
        new RegExp(`injected ${phase}`),
      );
      assert.equal(await directoryValue(first), "old-first", phase);
      assert.equal(await directoryValue(second), "old-second", phase);
      assert.deepEqual(await swapArtifacts(root), [], phase);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("copy and destination-lock failures never expose a partial target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-operation-failure-"));
  try {
    const target = path.join(root, "dist");
    const source = path.join(root, "source");
    await seedDirectory(target, "old");
    await seedDirectory(source, "new");
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }], {
        operations: {
          copy: async (_source: string, destination: string) => {
            await seedDirectory(destination, "partial");
            throw Object.assign(new Error("injected copy failure"), { code: "ENOSPC" });
          },
        },
      }),
      /injected copy failure/,
    );
    assert.equal(await directoryValue(target), "old");
    assert.deepEqual(await swapArtifacts(root), []);

    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }], {
        operations: {
          rename: async (from: string, to: string) => {
            if (to.includes(".codex-autoresearch-rollback-")) {
              throw Object.assign(new Error("active target locked"), { code: "EPERM" });
            }
            await rename(from, to);
          },
        },
      }),
      /active target locked/,
    );
    assert.equal(await directoryValue(target), "old");
    assert.deepEqual(await swapArtifacts(root), []);

    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }], {
        operations: {
          rename: async (from: string, to: string) => {
            if (path.basename(from) === "payload") {
              throw Object.assign(new Error("destination locked"), { code: "EPERM" });
            }
            await rename(from, to);
          },
        },
      }),
      /destination locked/,
    );
    assert.equal(await directoryValue(target), "old");
    assert.deepEqual(await swapArtifacts(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful install with locked cleanup retains an actionable rollback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-cleanup-failure-"));
  try {
    const target = path.join(root, "dist");
    const source = path.join(root, "source");
    await seedDirectory(target, "old");
    await seedDirectory(source, "new");
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }], {
        operations: {
          remove: async (artifact: string, options: { recursive?: boolean; force?: boolean }) => {
            if (artifact.includes(".codex-autoresearch-rollback-")) {
              throw Object.assign(new Error("rollback cleanup locked"), { code: "EPERM" });
            }
            await rm(artifact, options);
          },
        },
      }),
      /installed and verified.*rollback cleanup locked.*retained rollback path/i,
    );
    assert.equal(await directoryValue(target), "new");
    const rollback = (await readdir(root)).find((entry) => entry.includes("-rollback-"));
    assert.ok(rollback);
    assert.equal(await directoryValue(path.join(root, rollback)), "old");
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }]),
      /Stale owned rollback directory.*Inspect both paths.*remove only the obsolete owned copy/i,
    );
    assert.equal(await directoryValue(path.join(root, rollback)), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marker-removal failure reports the restored active target and retry removes the residue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-marker-failure-"));
  try {
    const target = path.join(root, "dist");
    const source = path.join(root, "source");
    await seedDirectory(target, "old");
    await seedDirectory(source, "new");
    const canonicalTarget = await realpath(target);
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(target, "scripts"), { recursive: true });
    await mkdir(path.join(source, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "codex-autoresearch", version: PLUGIN_VERSION })}\n`,
    );
    await writeFile(
      path.join(target, "scripts", "autoresearch.mjs"),
      "export const original = true;\n",
    );
    await writeFile(
      path.join(source, "scripts", "autoresearch.mjs"),
      "export const replacement = true;\n",
    );
    for (const asset of ["dashboard-app.js", "dashboard-app.css"]) {
      const assetPath = path.join(root, "assets", "dashboard-build", asset);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, `${asset}\n`);
    }
    let markerFailureInjected = false;
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }], {
        onPhase: async (phase: string) => {
          if (phase === "after-all-backups") throw new Error("stop after backup");
        },
        operations: {
          remove: async (artifact: string, options: { recursive?: boolean; force?: boolean }) => {
            if (path.basename(artifact) === ".codex-autoresearch-swap-owner.json") {
              markerFailureInjected = true;
              throw Object.assign(new Error("marker locked"), { code: "EPERM" });
            }
            await rm(artifact, options);
          },
        },
      }),
      new RegExp(
        `original directory is active at ${escapeRegExp(canonicalTarget)}.*marker locked.*Recovery evidence was retained at: ${escapeRegExp(canonicalTarget)}`,
        "i",
      ),
    );
    assert.equal(markerFailureInjected, true);
    assert.equal(await directoryValue(target), "old");
    assert.equal(await hasDirectorySwapArtifacts([target]), true);
    assert.deepEqual(
      (await readdir(root)).filter((entry) => entry.includes("-rollback-")),
      [],
    );

    const runtimeHref = await ensureRuntime(
      "autoresearch.mjs",
      pathToFileURL(path.join(root, "scripts", "autoresearch.mjs")).href,
      { releaseBaseUrl: "http://127.0.0.1:1" },
    );
    assert.equal(await directoryValue(target), "old");
    assert.match(await readFile(new URL(runtimeHref), "utf8"), /original/);
    assert.equal(await hasDirectorySwapArtifacts([target]), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale recovery restores rollback before cleaning a stage in reversed enumeration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-recovery-order-"));
  try {
    const target = path.join(root, "dist");
    const source = path.join(root, "source");
    await seedDirectory(target, "old");
    await seedDirectory(source, "new");
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }], {
        onPhase: async (phase: string) => {
          if (phase === "after-all-backups") throw new Error("stop after backup");
        },
        operations: {
          remove: async (artifact: string, options: { recursive?: boolean; force?: boolean }) => {
            if (artifact.includes(".codex-autoresearch-stage-")) {
              throw Object.assign(new Error("stage cleanup locked"), { code: "EPERM" });
            }
            await rm(artifact, options);
          },
          rename: async (from: string, to: string) => {
            if (from.includes(".codex-autoresearch-rollback-")) {
              throw Object.assign(new Error("restore locked"), { code: "EPERM" });
            }
            await rename(from, to);
          },
        },
      }),
      /Directory restoration needs attention.*stage cleanup locked.*Recovery evidence was retained/i,
    );
    await assert.rejects(access(target));
    assert.equal((await readdir(root)).filter((entry) => SWAP_ARTIFACT.test(entry)).length, 2);

    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }], {
        onPhase: async (phase: string) => {
          if (phase === "before-copy") throw new Error("stop after ordered recovery");
        },
        operations: {
          readDirectory: async (directory: string) =>
            (await readdir(directory, { withFileTypes: true })).reverse(),
        },
      }),
      /stop after ordered recovery/,
    );
    assert.equal(await directoryValue(target), "old");
    assert.deepEqual(await swapArtifacts(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime readiness does not bypass stale rollback evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-ready-rollback-"));
  try {
    const pluginDir = path.join(root, "plugin");
    const dist = path.join(pluginDir, "dist");
    const source = path.join(root, "new-dist");
    const importerUrl = pathToFileURL(path.join(pluginDir, "scripts", "autoresearch.mjs")).href;
    await mkdir(path.join(pluginDir, "scripts"), { recursive: true });
    await writeFile(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify({ name: "codex-autoresearch", version: PLUGIN_VERSION })}\n`,
    );
    await mkdir(path.join(dist, "scripts"), { recursive: true });
    await mkdir(path.join(source, "scripts"), { recursive: true });
    await writeFile(path.join(dist, "scripts", "autoresearch.mjs"), "export const old = true;\n");
    await writeFile(
      path.join(source, "scripts", "autoresearch.mjs"),
      "export const next = true;\n",
    );
    for (const asset of ["dashboard-app.js", "dashboard-app.css"]) {
      const assetPath = path.join(pluginDir, "assets", "dashboard-build", asset);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, `${asset}\n`);
    }
    await assert.rejects(
      replaceDirectoriesRollbackSafe(pluginDir, [{ source, target: dist }], {
        operations: {
          remove: async (artifact: string, options: { recursive?: boolean; force?: boolean }) => {
            if (artifact.includes(".codex-autoresearch-rollback-")) {
              throw new Error("retain rollback for launcher probe");
            }
            await rm(artifact, options);
          },
        },
      }),
      /retain rollback for launcher probe/,
    );

    await assert.rejects(
      ensureRuntime("autoresearch.mjs", importerUrl, { releaseBaseUrl: "http://127.0.0.1:1" }),
      /Stale owned rollback directory.*Inspect both paths/i,
    );
    assert.match(await readFile(path.join(dist, "scripts", "autoresearch.mjs"), "utf8"), /next/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore failure is actionable and a later retry recovers marked rollback evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-restore-failure-"));
  try {
    const target = path.join(root, "dist");
    const source = path.join(root, "source");
    await seedDirectory(target, "old");
    await seedDirectory(source, "new");
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }], {
        onPhase: async (phase: string) => {
          if (phase === "after-all-backups") throw new Error("stop after backup");
        },
        operations: {
          rename: async (from: string, to: string) => {
            if (from.includes(".codex-autoresearch-rollback-")) {
              throw Object.assign(new Error("restore locked"), { code: "EPERM" });
            }
            await rename(from, to);
          },
        },
      }),
      /Directory restoration needs attention.*Recovery evidence was retained.*Inspect the named paths/i,
    );
    await assert.rejects(access(target));
    const rollback = (await readdir(root)).find((entry) => entry.includes("-rollback-"));
    assert.ok(rollback);
    assert.equal(await directoryValue(path.join(root, rollback)), "old");

    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }], {
        onPhase: async (phase: string) => {
          if (phase === "after-stale-rollback-recovery") {
            throw new Error("stop after stale recovery");
          }
        },
      }),
      /stop after stale recovery/,
    );
    assert.equal(await directoryValue(target), "old");
    assert.deepEqual(await swapArtifacts(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("swap cleanup refuses unowned, out-of-root, and linked artifacts without deleting them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-containment-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-outside-"));
  try {
    const target = path.join(root, "dist");
    const source = path.join(root, "source");
    await seedDirectory(target, "old");
    await seedDirectory(source, "new");
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target: path.join(outside, "dist") }]),
      /outside the trusted root/,
    );
    assert.equal(await directoryValue(target), "old");

    const unowned = path.join(
      root,
      ".dist.codex-autoresearch-rollback-11111111-1111-4111-8111-111111111111",
    );
    await seedDirectory(unowned, "do-not-delete");
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }]),
      /missing a regular ownership marker/,
    );
    assert.equal(await directoryValue(unowned), "do-not-delete");

    await rm(unowned, { recursive: true });
    const invalidName = path.join(root, ".dist.codex-autoresearch-rollback-not-owned");
    await seedDirectory(invalidName, "still-do-not-delete");
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source, target }]),
      /does not use the expected owned name.*not deleted/,
    );
    assert.equal(await directoryValue(invalidName), "still-do-not-delete");

    const linkedSource = path.join(root, "linked-source");
    try {
      await symlink(source, linkedSource, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.diagnostic(`directory links unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(
      replaceDirectoriesRollbackSafe(root, [{ source: linkedSource, target }]),
      /symlink, junction, or file/,
    );
    assert.equal(await directoryValue(invalidName), "still-do-not-delete");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("runtime hydration pins attestation to the release repository and workflow", () => {
  assert.deepEqual(runtimeAttestationArgs("release.tgz"), [
    "attestation",
    "verify",
    "release.tgz",
    "--repo",
    "TheGreenCedar/codex-autoresearch",
    "--signer-workflow",
    "TheGreenCedar/codex-autoresearch/.github/workflows/release.yml",
  ]);
});

test("runtime hydration fails closed when gh is unavailable or attestation mismatches", async () => {
  await assert.rejects(
    verifyRuntimeAttestation("release.tgz", async () => {
      throw new Error("spawn gh ENOENT");
    }),
    /requires GitHub CLI and network access.*ENOENT/,
  );
  await assert.rejects(
    verifyRuntimeAttestation("release.tgz", async () => ({
      code: 1,
      stderr: "no matching attestations",
      stdout: "",
    })),
    /attestation verification failed.*no matching attestations/,
  );
});

test("runtime archive validation accepts only regular package files and directories", () => {
  assert.doesNotThrow(() =>
    validateRuntimeArchiveEntries([
      { name: "package/dist/", type: "d" },
      { name: "package/dist/scripts/autoresearch.mjs", type: "-" },
      { name: "package/assets/dashboard-build/dashboard-app.js", type: "-" },
      { name: "package/package.json", type: "-" },
    ]),
  );

  for (const entry of [
    { name: "/etc/passwd", type: "-" },
    { name: "package/../outside", type: "-" },
    { name: "other/package.json", type: "-" },
    { name: "package/dist/link", type: "l" },
    { name: "package/dist/hardlink", type: "h" },
    { name: "package/dist/device", type: "b" },
    { name: "package/unexpected.exe", type: "-" },
  ]) {
    assert.throws(() => validateRuntimeArchiveEntries([entry]), /tarball/);
  }
});

test("runtime archive validation accepts every explicitly packaged launcher", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as {
    files?: unknown;
  };
  const packagedLaunchers = Array.isArray(packageJson.files)
    ? packageJson.files.filter(
        (entry): entry is string =>
          typeof entry === "string" && /^(?:dist\/)?scripts\/[^/*]+\.mjs$/.test(entry),
      )
    : [];

  assert.ok(packagedLaunchers.includes("dist/scripts/operator-task-benchmark.mjs"));
  assert.ok(packagedLaunchers.includes("scripts/operator-task-benchmark.mjs"));
  assert.doesNotThrow(() =>
    validateRuntimeArchiveEntries(
      packagedLaunchers.map((name) => ({ name: `package/${name}`, type: "-" })),
    ),
  );
});

test("runtime archive preflight rejects malicious tar fixtures before extraction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-tar-"));
  try {
    for (const [name, type] of [
      ["package/../outside", "0"],
      ["package/dist/link", "2"],
      ["package/unexpected.exe", "0"],
    ] as const) {
      const archive = path.join(root, `${type}-${path.basename(name)}.tgz`);
      await writeFile(archive, gzipSync(tarFixture(name, type)));
      await assert.rejects(verifyRuntimeArchive(archive), /tarball/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime hydration rejects a release package with the wrong version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-manifest-"));
  const packageDir = path.join(root, "package");
  try {
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: "codex-autoresearch", version: "0.0.0" })}\n`,
      "utf8",
    );
    await assert.rejects(
      verifyReleasePackageManifest(packageDir, "1.2.3"),
      /package version mismatch: expected 1\.2\.3, got 0\.0\.0/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard inputs participate in source runtime freshness", () => {
  assert.equal(isRuntimeSourcePath("dashboard/src/main.tsx"), true);
  assert.equal(isRuntimeSourcePath("dashboard/src/styles.css"), true);
  assert.equal(isRuntimeSourcePath("vite.dashboard.config.ts"), true);
  assert.equal(isRuntimeSourcePath("assets/template.html"), true);
  assert.equal(isRuntimeSourcePath("dashboard/dist/generated.js"), false);
});

test("runtime install lock records ownership and reclaims a dead owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-lock-"));
  const lockPath = path.join(root, ".codex-autoresearch-runtime.lock");
  try {
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: "2020-01-01T00:00:00.000Z", token: "dead" })}\n`,
      "utf8",
    );
    let owner: { createdAt?: string; pid?: number; token?: string } = {};
    await withRuntimeInstallLock(root, async () => {
      owner = JSON.parse(await readFile(lockPath, "utf8"));
    });
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.createdAt, "string");
    assert.notEqual(owner.token, "dead");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel runtime dead-owner recovery remains exclusive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-runtime-lock-race-"));
  const lockPath = path.join(root, ".codex-autoresearch-runtime.lock");
  const recoveryPath = runtimeRecoveryLockPath(lockPath, "dead");
  try {
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: "2020-01-01T00:00:00.000Z", token: "dead" })}\n`,
      "utf8",
    );
    await writeFile(
      recoveryPath,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: "2020-01-01T00:00:00.000Z", token: "dead-recovery" })}\n`,
      "utf8",
    );
    let active = 0;
    let maxActive = 0;
    let actions = 0;
    await Promise.all(
      ["first", "second"].map(
        async () =>
          await withRuntimeInstallLock(root, async () => {
            actions += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 30));
            active -= 1;
          }),
      ),
    );
    assert.equal(actions, 2);
    assert.equal(maxActive, 1);
    await assert.rejects(access(lockPath));
    await assert.rejects(access(recoveryPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function tarFixture(name: string, type: "0" | "2"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, 0);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  if (type === "2") header.write("target", 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeTarOctal(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0),
  );
  return Buffer.concat([header, Buffer.alloc(1024)]);
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 2, "0");
  buffer.write(`${encoded}\0 `, offset, length, "ascii");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
