import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isRuntimeSourcePath,
  runtimeRecoveryLockPath,
  runtimeAttestationArgs,
  validateRuntimeArchiveEntries,
  verifyRuntimeArchive,
  verifyRuntimeAttestation,
  verifyReleasePackageManifest,
  withRuntimeInstallLock,
} from "../scripts/bootstrap-runtime.mjs";

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
