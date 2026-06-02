import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  indexTaskArtifactManifestObject,
  indexTaskArtifacts,
} from "../lib/task-artifact-indexer.js";

test("accepts well-formed task artifact manifest rows", () => {
  const result = indexTaskArtifactManifestObject({
    tasks: [
      {
        id: "case-1",
        label: "Case one",
        status: "passed",
        metrics: { score: 1 },
        diagnostic: "ok",
      },
    ],
  });

  assert.equal(result.acceptedTasks.length, 1);
  assert.equal(result.acceptedTasks[0]?.id, "case-1");
  assert.equal(result.acceptedTasks[0]?.label, "Case one");
  assert.equal(result.acceptedTasks[0]?.status, "passed");
  assert.deepEqual(result.acceptedTasks[0]?.metrics, { score: 1 });
  assert.equal(result.acceptedTasks[0]?.diagnostic, "ok");
  assert.equal(result.quarantinedTasks.length, 0);
  assert.deepEqual(result.warnings, []);
});

test("quarantines manifest rows missing an id", () => {
  const result = indexTaskArtifactManifestObject({
    tasks: [{ label: "Missing id", status: "passed" }],
  });

  assert.equal(result.acceptedTasks.length, 0);
  assert.equal(result.quarantinedTasks.length, 1);
  assert.match(result.warnings.join("\n"), /malformed|task/i);
});

test("handles non-object and taskless manifests without throwing", () => {
  assert.doesNotThrow(() => indexTaskArtifactManifestObject("not a manifest"));
  assert.doesNotThrow(() => indexTaskArtifactManifestObject({}));

  const nonObject = indexTaskArtifactManifestObject("not a manifest");
  assert.deepEqual(nonObject.acceptedTasks, []);
  assert.deepEqual(nonObject.quarantinedTasks, []);
  assert.match(nonObject.warnings.join("\n"), /manifest|task/i);

  const noTasks = indexTaskArtifactManifestObject({});
  assert.deepEqual(noTasks.acceptedTasks, []);
  assert.deepEqual(noTasks.quarantinedTasks, []);
});

test("does not throw when a task row contains invalid metrics", () => {
  const result = indexTaskArtifactManifestObject({
    tasks: [{ id: "case-2", metrics: "score=1" }],
  });

  assert.equal(result.acceptedTasks.length, 1);
  assert.equal(result.acceptedTasks[0]?.id, "case-2");
  assert.equal(result.acceptedTasks[0]?.metrics, "score=1");
  assert.equal(result.quarantinedTasks.length, 0);
});

test("indexes optional manifest-shaped input", async () => {
  const result = await indexTaskArtifacts({
    manifest: {
      tasks: [{ id: "case-3" }],
    },
  });

  assert.equal(result.acceptedTasks.length, 1);
  assert.equal(result.acceptedTasks[0]?.id, "case-3");
});

test("loads task artifact manifests from a path-bearing input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoresearch-task-artifacts-"));
  const manifestPath = join(directory, "manifest.json");

  try {
    await writeFile(
      manifestPath,
      JSON.stringify({
        tasks: [
          {
            id: "case-path",
            label: "Path case",
            status: "passed",
            metrics: { score: 1 },
            diagnostic: "ok",
          },
        ],
      }),
      "utf8",
    );

    const result = await indexTaskArtifacts({ path: manifestPath });

    assert.equal(result.acceptedTasks.length, 1);
    assert.equal(result.acceptedTasks[0]?.id, "case-path");
    assert.equal(result.acceptedTasks[0]?.label, "Path case");
    assert.equal(result.acceptedTasks[0]?.status, "passed");
    assert.deepEqual(result.acceptedTasks[0]?.metrics, { score: 1 });
    assert.equal(result.acceptedTasks[0]?.diagnostic, "ok");
    assert.equal(result.quarantinedTasks.length, 0);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads task artifact manifests from artifactPaths input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoresearch-task-artifacts-"));
  const manifestPath = join(directory, "manifest.json");

  try {
    await writeFile(
      manifestPath,
      JSON.stringify({
        tasks: [{ id: "case-artifact-paths" }],
      }),
      "utf8",
    );

    const result = await indexTaskArtifacts({ artifactPaths: [manifestPath] });

    assert.equal(result.acceptedTasks.length, 1);
    assert.equal(result.acceptedTasks[0]?.id, "case-artifact-paths");
    assert.equal(result.quarantinedTasks.length, 0);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("caps task artifact rows and reports truncation counts", () => {
  const result = indexTaskArtifactManifestObject({
    tasks: Array.from({ length: 55 }, (_, index) => ({ id: `case-${index}` })),
  });

  assert.equal(result.acceptedTasks.length, 50);
  assert.equal(result.totalTasks, 55);
  assert.equal(result.processedTasks, 50);
  assert.equal(result.acceptedTaskCount, 50);
  assert.equal(result.truncated, true);
  assert.match(result.warnings.join("\n"), /truncated after 50 of 55/);
});

test("bounds oversized task artifact rows before embedding", () => {
  const result = indexTaskArtifactManifestObject({
    tasks: [{ id: "large-row", diagnostic: "x".repeat(5000) }],
  });

  assert.equal(result.acceptedTasks.length, 1);
  assert.equal(result.acceptedTasks[0]?.id, "large-row");
  assert.equal(result.acceptedTasks[0]?.truncated, true);
  assert.equal(result.acceptedTasks[0]?.diagnostic, undefined);
  assert.match(result.warnings.join("\n"), /exceeded/);
});

test("quarantines oversized task artifact files before reading them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoresearch-task-artifacts-"));
  const manifestPath = join(directory, "large-manifest.json");

  try {
    await writeFile(manifestPath, `{"tasks":[{"id":"large","blob":"${"x".repeat(70 * 1024)}"}]}`);

    const result = await indexTaskArtifacts({ path: manifestPath });

    assert.equal(result.acceptedTasks.length, 0);
    assert.equal(result.quarantinedTasks.length, 1);
    assert.equal(result.quarantinedTasks[0]?.reason, "too_large");
    assert.equal(result.truncated, true);
    assert.match(result.warnings.join("\n"), /too_large/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads task artifact manifests from artifacts path references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoresearch-task-artifacts-"));
  const manifestPath = join(directory, "manifest.json");

  try {
    await writeFile(
      manifestPath,
      JSON.stringify({
        tasks: [{ id: "case-artifact-ref" }],
      }),
      "utf8",
    );

    const result = await indexTaskArtifacts({ artifacts: [{ path: manifestPath }] });

    assert.equal(result.acceptedTasks.length, 1);
    assert.equal(result.acceptedTasks[0]?.id, "case-artifact-ref");
    assert.equal(result.quarantinedTasks.length, 0);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores malformed artifacts entries without throwing", async () => {
  const result = await indexTaskArtifacts({
    artifacts: [null, 42, {}, { path: 42 }],
  } as unknown as Parameters<typeof indexTaskArtifacts>[0]);

  assert.deepEqual(result.acceptedTasks, []);
  assert.deepEqual(result.quarantinedTasks, []);
  assert.deepEqual(result.warnings, []);
});
