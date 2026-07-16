import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  inspectRuntimeDrift,
  inspectRuntimeDriftFromFacts,
  summarizeRuntimeAuthority,
} from "../lib/runtime-drift-doctor.js";
import { withAutoresearchTempDir, writeRuntimePackage } from "./helpers/cli-session.js";

const DOCTOR_COMMAND = /node .*scripts[\\/]autoresearch\.mjs doctor .*--explain/;
const ABSOLUTE_DOCTOR_COMMAND =
  /node ".*codex autoresearch.*scripts[\\/]autoresearch\.mjs" doctor --cwd ".*codex autoresearch" --explain/;
const SOURCE_FINGERPRINT = "a".repeat(64);

const FIXTURE_VERSION = "2.7.2";
const RUNTIME_CONTENT = "export const runtimeFixture = true;\n";
const runtimePath = (cacheRoot: string, version: string) =>
  path.join(cacheRoot, "TheGreenCedar", "codex-autoresearch", version);

async function writeSource(root: string, packageArtifact = false) {
  await writeRuntimePackage(root, FIXTURE_VERSION, {
    sourceShaped: !packageArtifact,
    runtimeContent: RUNTIME_CONTENT,
  });
}

test("canonical metadata finds the current cache and reports runtime surfaces", async () => {
  await withAutoresearchTempDir("runtime-canonical", async (dir) => {
    const sourceRoot = path.join(dir, "source");
    const cacheRoot = path.join(dir, "cache");
    const installedRoot = runtimePath(cacheRoot, FIXTURE_VERSION);
    await writeSource(sourceRoot);
    await writeRuntimePackage(installedRoot, FIXTURE_VERSION, {
      runtimeContent: RUNTIME_CONTENT,
    });

    const summary = await inspectRuntimeDrift({
      packageRoot: sourceRoot,
      sourceVersion: FIXTURE_VERSION,
      pluginCacheRoot: cacheRoot,
    });

    assert.equal(summary.installedRuntime, "fresh");
    assert.equal(summary.packageSurface, "source-checkout");
    assert.equal(summary.installedRuntimeShape, "hydrated-runtime");
    assert.equal(summary.installedRuntimePath, installedRoot);
    assert.equal(summary.installedRuntimeVersion, FIXTURE_VERSION);
    assert.equal(summary.installedRuntimeProvenance.source, "canonical-cache-layout");
    assert.equal(summary.installedRuntimeProvenance.status, "selected");
    assert.deepEqual(summary.installedRuntimeProvenance.candidates, [installedRoot]);
  });
});

test("production discovery honors CODEX_HOME without leaking environment state", async () => {
  await withAutoresearchTempDir("runtime-codex-home", async (dir) => {
    const sourceRoot = path.join(dir, "source");
    const codexHome = path.join(dir, "custom-codex-home");
    const installedRoot = runtimePath(path.join(codexHome, "plugins", "cache"), FIXTURE_VERSION);
    await writeSource(sourceRoot);
    await writeRuntimePackage(installedRoot, FIXTURE_VERSION, {
      runtimeContent: RUNTIME_CONTENT,
    });

    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = codexHome;
      const summary = await inspectRuntimeDrift({
        packageRoot: sourceRoot,
        sourceVersion: FIXTURE_VERSION,
      });
      assert.equal(summary.installedRuntime, "fresh");
      assert.equal(summary.installedRuntimePath, installedRoot);
      assert.equal(summary.installedRuntimeProvenance.source, "canonical-cache-layout");
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
    assert.equal(process.env.CODEX_HOME, originalCodexHome);
  });
});

test("multiple versions fail closed unless the running launcher selects one", async () => {
  await withAutoresearchTempDir("runtime-ambiguous", async (dir) => {
    const sourceRoot = path.join(dir, "source");
    const cacheRoot = path.join(dir, "cache");
    const activeRoot = runtimePath(cacheRoot, FIXTURE_VERSION);
    await writeSource(sourceRoot);
    await writeRuntimePackage(runtimePath(cacheRoot, "2.7.1"), "2.7.1", {
      runtimeContent: RUNTIME_CONTENT,
    });
    await writeRuntimePackage(activeRoot, FIXTURE_VERSION, {
      runtimeContent: RUNTIME_CONTENT,
    });

    const ambiguous = await inspectRuntimeDrift({
      packageRoot: sourceRoot,
      sourceVersion: FIXTURE_VERSION,
      pluginCacheRoot: cacheRoot,
    });
    assert.equal(ambiguous.installedRuntime, "unavailable");
    assert.equal(ambiguous.installedRuntimeProvenance.status, "ambiguous");
    assert.equal(ambiguous.installedRuntimeProvenance.candidates.length, 2);
    assert.match(ambiguous.nextActionHint, /ambiguous/i);

    const selected = await inspectRuntimeDrift({
      packageRoot: activeRoot,
      sourceVersion: FIXTURE_VERSION,
      pluginCacheRoot: cacheRoot,
    });
    assert.equal(selected.installedRuntime, "fresh");
    assert.equal(selected.packageSurface, "active-installed-cache");
    assert.equal(selected.installedRuntimeProvenance.source, "launcher-package-root");
  });
});

test("source-shaped, package, missing, and stale surfaces stay distinct", async () => {
  await withAutoresearchTempDir("runtime-shapes", async (dir) => {
    const sourceRoot = path.join(dir, "source");
    await writeSource(sourceRoot);

    const sourceCache = path.join(dir, "source-cache");
    await writeRuntimePackage(runtimePath(sourceCache, FIXTURE_VERSION), FIXTURE_VERSION, {
      sourceShaped: true,
    });
    const sourceShaped = await inspectRuntimeDrift({
      packageRoot: sourceRoot,
      sourceVersion: FIXTURE_VERSION,
      pluginCacheRoot: sourceCache,
    });
    assert.equal(sourceShaped.installedRuntime, "unavailable");
    assert.equal(sourceShaped.installedRuntimeShape, "source-shaped-package");

    const missing = await inspectRuntimeDrift({
      packageRoot: sourceRoot,
      sourceVersion: FIXTURE_VERSION,
      pluginCacheRoot: path.join(dir, "missing-cache"),
    });
    assert.equal(missing.installedRuntime, "missing");

    const staleCache = path.join(dir, "stale-cache");
    await writeRuntimePackage(runtimePath(staleCache, "2.7.1"), "2.7.1", {
      runtimeContent: RUNTIME_CONTENT,
    });
    const stale = await inspectRuntimeDrift({
      packageRoot: sourceRoot,
      sourceVersion: FIXTURE_VERSION,
      pluginCacheRoot: staleCache,
    });
    assert.equal(stale.installedRuntime, "stale");
    assert.equal(stale.installedRuntimeVersion, "2.7.1");

    const packageRoot = path.join(dir, "package");
    await writeSource(packageRoot, true);
    const artifact = await inspectRuntimeDrift({
      packageRoot,
      sourceVersion: FIXTURE_VERSION,
      pluginCacheRoot: path.join(dir, "artifact-cache"),
    });
    assert.equal(artifact.packageSurface, "package-artifact");
  });
});

test("legacy discovery is labelled and wrong canonical casing is rejected", async () => {
  await withAutoresearchTempDir("runtime-legacy-casing", async (dir) => {
    const sourceRoot = path.join(dir, "source");
    await writeSource(sourceRoot);

    const legacyCache = path.join(dir, "legacy-cache");
    const legacyRoot = path.join(
      legacyCache,
      "thegreencedar-autoresearch",
      "plugin-install-fixture",
      "codex-autoresearch",
      FIXTURE_VERSION,
    );
    await writeRuntimePackage(legacyRoot, FIXTURE_VERSION, {
      runtimeContent: RUNTIME_CONTENT,
    });
    const legacy = await inspectRuntimeDrift({
      packageRoot: sourceRoot,
      sourceVersion: FIXTURE_VERSION,
      pluginCacheRoot: legacyCache,
    });
    assert.equal(legacy.installedRuntime, "fresh");
    assert.equal(legacy.installedRuntimePath, legacyRoot);
    assert.equal(legacy.installedRuntimeProvenance.source, "legacy-cache-fallback");

    const wrongCaseCache = path.join(dir, "wrong-case-cache");
    await writeRuntimePackage(
      path.join(wrongCaseCache, "thegreencedar", "codex-autoresearch", FIXTURE_VERSION),
      FIXTURE_VERSION,
      { runtimeContent: RUNTIME_CONTENT },
    );
    const wrongCase = await inspectRuntimeDrift({
      packageRoot: sourceRoot,
      sourceVersion: FIXTURE_VERSION,
      pluginCacheRoot: wrongCaseCache,
    });
    assert.equal(wrongCase.installedRuntime, "unavailable");
    assert.equal(wrongCase.installedRuntimeProvenance.source, "canonical-cache-layout");
    assert.match(wrongCase.installedRuntimeProvenance.detail, /TheGreenCedar/);
  });
});

test("unavailable installed runtime asks the operator to inspect the runtime", () => {
  const summary = inspectRuntimeDriftFromFacts({
    sourceVersion: "2.0.2",
    packageRoot: "/tmp/codex-autoresearch",
    builtRuntimeExists: true,
    installedRuntimeVersion: null,
    installedRuntimePath: "",
  });

  assert.equal(summary.sourceVersion, "2.0.2");
  assert.equal(summary.packageRoot, "/tmp/codex-autoresearch");
  assert.equal(summary.installedRuntime, "unavailable");
  assert.equal(summary.builtRuntime, "available");
  assert.match(summary.nextActionHint, /inspect/i);
  assert.match(summary.nextActionHint, /runtime/i);
  assert.match(summary.nextActionHint, DOCTOR_COMMAND);
});

test("stale installed runtime asks the operator to refresh install cache", () => {
  const summary = inspectRuntimeDriftFromFacts({
    sourceVersion: "2.0.2",
    packageRoot: "/tmp/codex-autoresearch",
    builtRuntimeExists: true,
    installedRuntimeVersion: "2.0.1",
    installedRuntimePath: "/cache/codex-autoresearch/2.0.1",
  });

  assert.equal(summary.installedRuntime, "stale");
  assert.match(summary.nextActionHint, DOCTOR_COMMAND);
});

test("missing installed runtime path asks the operator to inspect with a command", () => {
  const summary = inspectRuntimeDriftFromFacts({
    sourceVersion: "2.0.2",
    packageRoot: "/tmp/codex-autoresearch",
    builtRuntimeExists: true,
    installedRuntimeVersion: null,
    installedRuntimePath: "/cache/codex-autoresearch/2.0.2",
  });

  assert.equal(summary.installedRuntime, "missing");
  assert.match(summary.nextActionHint, DOCTOR_COMMAND);
});

test("matching installed runtime version is fresh", () => {
  const summary = inspectRuntimeDriftFromFacts({
    sourceVersion: "2.0.2",
    packageRoot: "/tmp/codex-autoresearch",
    builtRuntimeExists: true,
    installedRuntimeVersion: "2.0.2",
    installedRuntimePath: "/cache/codex-autoresearch/2.0.2",
    sourceRuntimeFingerprint: SOURCE_FINGERPRINT,
    installedRuntimeFingerprint: SOURCE_FINGERPRINT,
  });

  assert.equal(summary.installedRuntime, "fresh");
  assert.equal(summary.runtimeFingerprint, "matched");
});

test("matching installed runtime version with different entrypoint fingerprint is stale", () => {
  const summary = inspectRuntimeDriftFromFacts({
    sourceVersion: "2.0.2",
    packageRoot: "/tmp/codex-autoresearch",
    builtRuntimeExists: true,
    installedRuntimeVersion: "2.0.2",
    installedRuntimePath: "/cache/codex-autoresearch/2.0.2",
    sourceRuntimeFingerprint: SOURCE_FINGERPRINT,
    installedRuntimeFingerprint: "b".repeat(64),
  });

  assert.equal(summary.installedRuntime, "stale");
  assert.equal(summary.runtimeFingerprint, "mismatched");
  assert.match(summary.nextActionHint, /fingerprint differs/i);
  assert.match(summary.nextActionHint, /refresh the plugin/i);
  assert.match(summary.nextActionHint, /--help/);
  assert.doesNotMatch(summary.nextActionHint, DOCTOR_COMMAND);
});

test("matching installed runtime version without fingerprint evidence is unavailable", () => {
  const summary = inspectRuntimeDriftFromFacts({
    sourceVersion: "2.0.2",
    packageRoot: "/tmp/codex-autoresearch",
    builtRuntimeExists: true,
    installedRuntimeVersion: "2.0.2",
    installedRuntimePath: "/cache/codex-autoresearch/2.0.2",
  });

  assert.equal(summary.installedRuntime, "unavailable");
  assert.equal(summary.runtimeFingerprint, "unavailable");
});

test("fresh runtime smoke check quotes package roots containing spaces", () => {
  const summary = inspectRuntimeDriftFromFacts({
    sourceVersion: "2.0.2",
    packageRoot: "/tmp/codex autoresearch",
    builtRuntimeExists: true,
    installedRuntimeVersion: "2.0.2",
    installedRuntimePath: "/cache/codex-autoresearch/2.0.2",
    sourceRuntimeFingerprint: SOURCE_FINGERPRINT,
    installedRuntimeFingerprint: SOURCE_FINGERPRINT,
  });

  const quotedSmokeCheck =
    /^node ".*codex autoresearch.*dist[\\/]scripts[\\/]autoresearch\.mjs" --help$/;
  assert.match(summary.smokeCheck, quotedSmokeCheck);
  assert.match(summary.nextActionHint, /smoke check/i);
  assert.ok(summary.nextActionHint.includes(summary.smokeCheck));
});

test("inspection command uses package-root script path for wrapper-root shells", () => {
  const summary = inspectRuntimeDriftFromFacts({
    sourceVersion: "2.0.2",
    packageRoot: "/tmp/codex autoresearch",
    builtRuntimeExists: true,
    installedRuntimeVersion: "2.0.1",
    installedRuntimePath: "/cache/codex-autoresearch/2.0.1",
  });

  assert.match(summary.nextActionHint, ABSOLUTE_DOCTOR_COMMAND);
});

test("missing built runtime is reported separately from installed runtime", () => {
  const summary = inspectRuntimeDriftFromFacts({
    sourceVersion: "2.0.2",
    packageRoot: "/tmp/codex-autoresearch",
    builtRuntimeExists: false,
    installedRuntimeVersion: "2.0.2",
    installedRuntimePath: "/cache/codex-autoresearch/2.0.2",
  });

  assert.equal(summary.builtRuntime, "missing");
});

test("source checkout work treats non-fresh installed runtime as advisory", () => {
  for (const status of ["stale", "missing", "unavailable"]) {
    const authority = summarizeRuntimeAuthority({
      sourceRuntime: { status: "fresh", version: "2.0.2" },
      installedRuntime: { status, ...(status === "stale" ? { version: "2.0.1" } : {}) },
    });

    assert.equal(authority.blocking, false, status);
    assert.equal(authority.trustScope, "source-checkout", status);
    assert.equal(authority.blocker, "", status);
    assert.match(authority.warning, new RegExp(`${status} installed plugin runtime`, "i"));
  }
});

test("installed plugin verification treats non-fresh installed runtime as blocking", () => {
  for (const status of ["stale", "missing", "unavailable"]) {
    const authority = summarizeRuntimeAuthority({
      sourceRuntime: { status: "fresh", version: "2.0.2" },
      installedRuntime: { status, ...(status === "stale" ? { version: "2.0.1" } : {}) },
      trustScope: "installed-plugin",
    });

    assert.equal(authority.blocking, true, status);
    assert.equal(authority.trustScope, "installed-plugin", status);
    assert.match(authority.blocker, new RegExp(`${status} installed plugin runtime`, "i"));
    assert.match(authority.blocker, /installed-runtime verification/i);
    assert.equal(authority.warning, "", status);
  }
});

test("installed plugin verification accepts fresh installed runtime", () => {
  const authority = summarizeRuntimeAuthority({
    sourceRuntime: { status: "fresh", version: "2.0.2" },
    installedRuntime: { status: "fresh", version: "2.0.2" },
    trustScope: "installed-plugin",
  });

  assert.equal(authority.blocking, false);
  assert.equal(authority.blocker, "");
  assert.equal(authority.warning, "");
});
