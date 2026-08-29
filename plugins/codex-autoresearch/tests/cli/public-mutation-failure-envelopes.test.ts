import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { quoteForAcceptedShell } from "../helpers/process.js";
import { runCli, withTempDir } from "../helpers/cli-test-context.js";
import {
  createEvidencePlanFixture,
  finalizer,
  pluginRoot,
  run as runFinalizer,
} from "../finalize/helpers.js";

test("autoresearch CLI serializes the failed mutation protocol envelope", async () => {
  await withTempDir("autoresearch-public-mutation-failure", async (dir) => {
    await mkdir(path.join(dir, "src"));
    const benchmark = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
    const result = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "public mutation failure",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--checks-command",
      checks,
      "--scope",
      "src",
      "--commit-paths",
      "src",
      "--max-iterations",
      "0",
    ]);

    assert.equal(result.code, 1, result.stderr);
    await access(path.join(dir, "autoresearch.md"));
    const failure = parseFailureEnvelope(result.stderr, "autoresearch CLI");
    assertProtocolFailure(failure, "setup");
  });
});

test("autoresearch CLI serializes malformed routing config as a typed source failure", async () => {
  await withTempDir("autoresearch-malformed-routing-config", async (dir) => {
    await writeFile(path.join(dir, "autoresearch.config.json"), "{", "utf8");

    const result = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "malformed routing config",
      "--metric-name",
      "seconds",
    ]);

    assert.equal(result.code, 1, result.stderr);
    const failure = parseFailureEnvelope(result.stderr, "autoresearch CLI malformed source");
    assert.equal(failure.code, "coherent-snapshot-source-invalid");
    assert.match(String(failure.message), /routing config|JSON|parse/i);
    assert.equal(failure.preconditionDecision, undefined);
    assert.equal(failure.mutation, undefined);
    assert.equal(failure.resultingDecision, undefined);
  });
});

test("standalone finalizer CLI serializes the failed mutation protocol envelope", async () => {
  await withTempDir("finalizer-public-mutation-failure", async (dir) => {
    const fixture = await createEvidencePlanFixture(dir, "public-finalizer-failure");
    const outputDirectory = path.join(dir, "groups-output-is-a-directory");
    await mkdir(outputDirectory);

    const result = await runFinalizer(
      process.execPath,
      [
        finalizer,
        "plan",
        "--cwd",
        fixture.repo,
        "--output",
        outputDirectory,
        "--goal",
        "public-finalizer-failure",
      ],
      pluginRoot,
      true,
    );

    assert.equal(result.code, 1, result.stderr);
    const failure = parseFailureEnvelope(result.stderr, "standalone finalizer CLI");
    assertProtocolFailure(failure, "finalize-autoresearch:plan");
  });
});

test("standalone finalizer CLI serializes malformed routing config as a typed source failure", async () => {
  await withTempDir("finalizer-malformed-routing-config", async (dir) => {
    await writeFile(path.join(dir, "autoresearch.config.json"), "{", "utf8");
    const output = path.join(dir, "groups.json");

    const result = await runFinalizer(
      process.execPath,
      [finalizer, "plan", "--cwd", dir, "--output", output, "--goal", "malformed-routing-config"],
      pluginRoot,
      true,
    );

    assert.equal(result.code, 1, result.stderr);
    const failure = parseFailureEnvelope(result.stderr, "standalone finalizer malformed source");
    assert.equal(failure.code, "coherent-snapshot-source-invalid");
    assert.match(String(failure.message), /routing config|JSON|parse/i);
    assert.equal(failure.preconditionDecision, undefined);
    assert.equal(failure.mutation, undefined);
    assert.equal(failure.resultingDecision, undefined);
  });
});

function parseFailureEnvelope(serialized: string, boundary: string): Record<string, any> {
  const output = serialized.trim();
  assert.match(
    output,
    /^\{[\s\S]*\}$/,
    `${boundary} must write one structured JSON failure envelope; received ${JSON.stringify(output)}`,
  );
  return JSON.parse(output);
}

function assertProtocolFailure(failure: Record<string, any>, command: string): void {
  assert.equal(failure.code, "mutation-failed");
  assert.equal(typeof failure.message, "string");
  assert.ok(failure.message.length > 0);
  assert.equal(failure.preconditionDecision?.kind, "decision-plan");
  assert.equal(failure.mutation?.kind, "command-mutation-receipt");
  assert.equal(failure.mutation?.command, command);
  assert.equal(failure.mutation?.status, "failed");
  assert.equal(failure.resultingDecision?.kind, "decision-plan");
  assert.equal(
    failure.mutation?.preconditionGenerationId,
    failure.preconditionDecision?.generationId,
  );
  assert.equal(failure.mutation?.resultingGenerationId, failure.resultingDecision?.generationId);
}
