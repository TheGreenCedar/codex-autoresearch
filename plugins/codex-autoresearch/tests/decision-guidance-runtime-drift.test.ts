import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectRuntimeDriftFromFacts,
  summarizeRuntimeAuthority,
} from "../lib/runtime-drift-doctor.js";

const DOCTOR_COMMAND = /node .*scripts[\\/]autoresearch\.mjs doctor .*--explain/;
const ABSOLUTE_DOCTOR_COMMAND =
  /node ".*codex autoresearch.*scripts[\\/]autoresearch\.mjs" doctor --cwd ".*codex autoresearch" --explain/;
const SOURCE_FINGERPRINT = "a".repeat(64);

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
