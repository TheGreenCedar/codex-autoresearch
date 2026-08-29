import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { redactCommandDisplay } from "../../lib/evidence-redaction.js";
import { quoteForAcceptedShell } from "../helpers/process.js";

import {
  runCli,
  withTempDir,
  git,
  setupFixture as setupSessionFixture,
} from "../helpers/cli-test-context.js";

async function setupFixture(dir: string, options: Parameters<typeof setupSessionFixture>[1] = {}) {
  const result = await setupSessionFixture(dir, {
    benchmarkCommand: `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=3')"`,
    acceptedContract: true,
    packetBudget: 100,
    ...options,
  });
  await mkdir(path.join(dir, "src"), { recursive: true });
  const configPath = path.join(dir, "autoresearch.config.json");
  const existingConfig = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...existingConfig,
        checksAuthoritative: true,
        commitPaths: [options.scope ?? "src"],
        maxIterations: options.packetBudget ?? 100,
        noiseModel: { kind: "deterministic" },
      },
      null,
      2,
    )}\n`,
  );
  return result;
}

test("config persists operator settings and extends iteration limits", async () => {
  await withTempDir("operator-config", async (dir) => {
    await setupSessionFixture(dir, { name: "operator config" });
    const baseline = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "measure",
      "--description",
      "Baseline",
    ]);
    assert.equal(baseline.code, 0, baseline.stderr);
    const baselineRecord = JSON.parse(baseline.stdout).experiment;
    assert.equal(baselineRecord.runPurpose, "baseline");
    assert.equal(baselineRecord.evaluationAuthority, "manual");
    assert.deepEqual(baselineRecord.candidateOrigin, { kind: "none" });

    const result = await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "on-improvement",
      "--keep-policy",
      "primary-or-risk-reduction",
      "--dashboard-refresh-seconds",
      "2",
      "--extend",
      "4",
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.config.autonomyMode, "owner-autonomous");
    assert.equal(payload.config.checksPolicy, "on-improvement");
    assert.equal(payload.config.keepPolicy, "primary-or-risk-reduction");
    assert.equal(payload.config.dashboardRefreshSeconds, 2);
    assert.equal(payload.config.maxIterations, 4);
    assert.deepEqual(payload.config.commitPaths, ["src", "tests"]);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.settings.autonomyMode, "owner-autonomous");
    assert.equal(statePayload.limit.remainingIterations, 4);
    const commandTexts = Object.values(statePayload.commands)
      .map((command: any) => command.command)
      .join("\n");
    assert.match(commandTexts, /autoresearch\.mjs/);
    assert.match(commandTexts, /--cwd/);
    const commandRail = commandTexts;
    assert.match(commandRail, /\bfinalize-preview\b/);
    assert.match(commandRail, /\bnew-segment\b.*--dry-run/);
    assert.doesNotMatch(commandTexts, /\bfinalize-current-tree\b/);
    assert.doesNotMatch(commandTexts, /\sconfig\s.*--extend/);
    assert.doesNotMatch(commandTexts, /\slog\s.*--from-last/);
    assert.doesNotMatch(commandTexts, /\snext\s.*--compact/);
  });
});

test("next writes a reusable last-run packet and log can consume it", async () => {
  await withTempDir("last-run", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=3'); console.log('METRIC cache_hits=8')"`;
    await setupFixture(dir, { name: "last run", benchmarkCommand: command });

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, 3);
    assert.equal(packet.decision.metrics.cache_hits, 8);
    assert.equal(packet.decision.rawSuggestedStatus, "measure");
    assert.equal(packet.decision.safeSuggestedStatus, "measure");
    assert.equal(packet.decision.promotion.label, "exploratory");
    assert.match(packet.decision.statusGuidance, /baseline or diagnostic packet/);
    assert.equal(packet.decision.diversityGuidance, null);
    assert.equal(packet.decision.asiTemplate.lane, "");
    assert.match(packet.packetEvidence.packetId, /^packet-/);
    assert.equal(
      packet.packetEvidence.commandIdentity.command,
      redactCommandDisplay(packet.run.command, { workDir: dir }),
    );
    assert.equal(packet.packetEvidence.exitStatus, 0);
    assert.equal(packet.packetEvidence.metrics.seconds, 3);
    assert.match(packet.packetEvidence.stdoutTail, /METRIC seconds=3/);
    assert.match(packet.packetEvidence.freshnessFingerprint, /^[a-f0-9]{64}$/);

    const lastRun = JSON.parse(await readFile(packet.lastRunPath, "utf8"));
    assert.equal(lastRun.decision.metric, 3);
    assert.equal(lastRun.decision.promotion.label, "exploratory");
    assert.equal(lastRun.packetEvidence.metrics.cache_hits, 8);
    assert.equal(lastRun.history.nextRun, 1);
    assert.equal(lastRun.history.config.metricName, "seconds");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard cached packet",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.metric, 3);
    assert.equal(payload.experiment.metrics.cache_hits, 8);
    assert.equal(payload.experiment.metricEligible, true);
    assert.equal(payload.experiment.promotion.label, "invalidated");
    assert.match(payload.experiment.packetFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(payload.lastRunCleared, true);
    await assert.rejects(access(packet.lastRunPath));

    const duplicate = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Duplicate cached packet",
    ]);
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.stderr, /No last-run packet/);
  });
});

test("next refuses to overwrite an unlogged fresh last-run packet", async () => {
  await withTempDir("fresh-last-run-next-refusal", async (dir) => {
    const sideEffectFile = path.join(dir, "packet-runs.txt");
    const sideEffectScript = path.join(dir, "packet.mjs");
    await writeFile(
      sideEffectScript,
      [
        `import { appendFileSync } from "node:fs";`,
        `appendFileSync(${JSON.stringify(sideEffectFile)}, "ran\\n");`,
        `console.log("METRIC seconds=3");`,
        "",
      ].join("\n"),
      "utf8",
    );
    const firstCommand = `${quoteForAcceptedShell(process.execPath)} ${quoteForAcceptedShell(sideEffectScript)}`;
    await setupFixture(dir, { name: "fresh last run", benchmarkCommand: firstCommand });
    const first = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(first.code, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout);
    const packetPath = firstPayload.lastRunPath;
    const before = JSON.parse(await readFile(packetPath, "utf8"));
    assert.equal(before.decision.metric, 3);
    assert.equal(await readFile(sideEffectFile, "utf8"), "ran\n");
    const second = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.notEqual(second.code, 0);
    const refused = JSON.parse(second.stderr);
    assert.equal(refused.code, "mutation-precondition-blocked");
    assert.equal(refused.preconditionDecision.action.kind, "log-decision");
    assert.equal(refused.preconditionDecision.capabilities["run-packet"], "blocked");
    assert.equal(refused.preconditionDecision.loopDisposition.canRunPacket, false);
    assert.ok(
      refused.preconditionDecision.requiredEvidence.diagnosticCodes.includes("pending-packet"),
    );
    assert.equal(refused.mutation, undefined);

    const after = JSON.parse(await readFile(packetPath, "utf8"));
    assert.equal(after.decision.metric, 3);
    assert.equal(after.packetEvidence.metrics.seconds, 3);
    assert.equal(await readFile(sideEffectFile, "utf8"), "ran\n");
  });
});

test("next parses metrics from the full benchmark output before display truncation", async () => {
  await withTempDir("full-output-metric", async (dir) => {
    const script = path.join(dir, "noisy-benchmark.mjs");
    await writeFile(
      script,
      [
        "console.log('METRIC seconds=7');",
        "for (let i = 0; i < 3000; i += 1) console.log(`noise ${i} ${'x'.repeat(80)}`);",
        "",
      ].join("\n"),
      "utf8",
    );
    const command = `${quoteForAcceptedShell(process.execPath)} ${quoteForAcceptedShell(script)}`;
    await setupFixture(dir, { name: "full output", benchmarkCommand: command });

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, 7);
    assert.equal(packet.run.parsedPrimary, 7);
    assert.equal(packet.run.outputTruncated, true);
  });
});

test("successful last-run packets require explicit status and suggest discard for regressions", async () => {
  await withTempDir("last-run-suggest-discard", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=4')"`;
    await setupFixture(dir, {
      name: "suggest discard",
      direction: "lower",
      benchmarkCommand: command,
    });
    const baseline = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "measure",
      "--description",
      "Baseline",
    ]);
    assert.equal(baseline.code, 0, baseline.stderr);
    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.suggestedStatus, "discard");
    assert.deepEqual(packet.decision.allowedStatuses, ["discard", "measure"]);

    const missingStatus = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--description",
      "No status",
    ]);
    assert.notEqual(missingStatus.code, 0);
    assert.match(missingStatus.stderr, /status is required/);

    const discard = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard slower run",
    ]);
    assert.equal(discard.code, 0, discard.stderr);
    assert.equal(JSON.parse(discard.stdout).experiment.status, "discard");
  });
});

test("stale last-run packets are rejected when history advances", async () => {
  await withTempDir("stale-last-run", async (dir) => {
    await setupFixture(dir, { name: "stale packet" });
    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);

    const directLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "measure",
      "--description",
      "Manual measurement",
    ]);
    assert.equal(directLog.code, 0, directLog.stderr);

    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Last-run packet is stale/);
    assert.match(stale.stderr, /next --cwd/);
    assert.match(stale.stderr, /--status measure/);
  });
});

test("stale last-run packets are rejected when scoped git evidence changes", async () => {
  await withTempDir("stale-last-run-git-evidence", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "src/tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "git stale packet" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await acceptCurrentContract(dir);

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "src", "tracked.txt"), "changed after next\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Old packet after file edit",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Git dirty state changed|scoped file fingerprints changed/);
  });
});

test("stale last-run packets are rejected when dirty file contents change without status shape changes", async () => {
  await withTempDir("stale-last-run-dirty-content", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "src/tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "dirty content packet" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await acceptCurrentContract(dir);
    await writeFile(path.join(dir, "src", "tracked.txt"), "dirty before packet\n", "utf8");

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "src", "tracked.txt"), "dirty after packet\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet after dirty content edit",
      "--allow-add-all",
    ]);
    assert.notEqual(stale.code, 0);
    assertStalePacketCapabilityRefusal(stale.stderr);
  });
});

test("dirty fingerprints preserve hostile Git filenames", async () => {
  await withTempDir("stale-last-run-hostile-dirty-path", async (dir) => {
    const file = process.platform === "win32" ? "tracked 雪.txt" : ' tracked " -> 雪\\line\n.txt ';
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, file), "base\n", "utf8");
    await git(dir, ["add", file]);
    await git(dir, ["commit", "-m", "initial"]);
    await setupFixture(dir, { name: "hostile dirty path" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, file), "dirty before packet\n", "utf8");
    await acceptCurrentContract(dir);

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    const lastRun = JSON.parse(await readFile(packet.lastRunPath, "utf8"));
    assert.ok(lastRun.history.git.dirtyFileFingerprints.some((entry) => entry.path === file));

    await writeFile(path.join(dir, file), "dirty after packet\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Hostile dirty path changed",
      "--allow-add-all",
    ]);
    assert.notEqual(stale.code, 0);
    assertStalePacketCapabilityRefusal(stale.stderr);
  });
});

test("stale last-run packets are rejected when untracked directory contents change", async () => {
  await withTempDir("stale-last-run-untracked-dir", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "src/tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "untracked dir packet" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await acceptCurrentContract(dir);
    await mkdir(path.join(dir, "src", "scratch"), { recursive: true });
    await writeFile(path.join(dir, "src", "scratch", "thing.txt"), "before packet\n", "utf8");

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "src", "scratch", "thing.txt"), "after packet\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet after untracked dir edit",
      "--allow-add-all",
    ]);
    assert.notEqual(stale.code, 0);
    assertStalePacketCapabilityRefusal(stale.stderr);
  });
});

test("next refuses runs when dirty fingerprints would be truncated", async () => {
  await withTempDir("stale-last-run-truncated-dirty", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "truncated dirty packet" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const scratch = path.join(dir, "scratch");
    await mkdir(scratch, { recursive: true });
    for (let index = 0; index < 505; index += 1) {
      await writeFile(path.join(scratch, `file-${String(index).padStart(3, "0")}.txt`), "x\n");
    }

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.notEqual(next.code, 0);
    assert.match(next.stderr, /repository\.treePolicy.*entry limit/i);
    await assert.rejects(access(path.join(dir, "autoresearch.last-run.json")));
    await assert.rejects(access(path.join(dir, ".git", "autoresearch", "last-run.json")));
  });
});

test("next rejects entry-limited authority when the candidate scope is clean", async () => {
  await withTempDir("large-clean-scoped-commit-path", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    const srcDir = path.join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    for (let index = 0; index < 501; index += 1) {
      await writeFile(path.join(srcDir, `file-${String(index).padStart(3, "0")}.txt`), "x\n");
    }
    await git(dir, ["add", "src"]);
    await git(dir, ["commit", "-m", "initial src"]);

    await setupFixture(dir, { name: "large clean scope" });
    const configured = await runCli(["config", "--cwd", dir, "--commit-paths", "src"]);
    assert.equal(configured.code, 0, configured.stderr);
    await git(dir, ["add", "--all"]);
    await git(dir, ["commit", "-m", "session config"]);
    await acceptCurrentContract(dir);
    const status = await git(dir, ["status", "--short", "--", "src"]);
    assert.equal(status, "");

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.notEqual(next.code, 0);
    assert.match(next.stderr, /candidate fingerprint.*entry limit/i);
    await assert.rejects(access(path.join(dir, "autoresearch.last-run.json")));
  });
});

test("next blocks when dirty fingerprint bytes exceed the total budget", async () => {
  await withTempDir("oversized-dirty-fingerprint", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const initialized = await setupFixture(dir, {
      name: "oversized fingerprint",
      benchmarkCommand: command,
    });
    assert.equal(initialized.code, 0, initialized.stderr);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await acceptCurrentContract(dir);
    await writeFile(path.join(dir, "src", "oversized.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));

    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.code, "next_blocked_by_truncated_fingerprints");
    assert.match(JSON.stringify(payload.git), /fingerprint_byte_budget/);
  });
});

test("last-run packets are rejected when config changes before logging", async () => {
  await withTempDir("config-stale-last-run", async (dir) => {
    await setupFixture(dir, { name: "first config" });
    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);

    const secondConfig = await setupFixture(dir, {
      name: "second config",
      metricName: "points",
      direction: "higher",
    });
    assert.equal(secondConfig.code, 0, secondConfig.stderr);

    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old metric packet",
    ]);
    assert.notEqual(stale.code, 0);
    assertStalePacketCapabilityRefusal(stale.stderr);
  });
});

test("last-run freshness hashes execution policy and commit scope", async () => {
  await withTempDir("trust-config-stale-last-run", async (dir) => {
    await setupFixture(dir, { name: "trust config" });
    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    const acceptedCommand = packet.run.command;
    assert.match(packet.history.trustConfig.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      packet.history.trustConfig.fields,
      [...packet.history.trustConfig.fields].sort(),
    );
    assert.equal(JSON.stringify(packet.history.trustConfig).includes(acceptedCommand), false);

    const configured = await runCli([
      "config",
      "--cwd",
      dir,
      "--checks-policy",
      "on-improvement",
      "--commit-paths",
      "src",
    ]);
    assert.equal(configured.code, 0, configured.stderr);
    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.decisionPlanProjection.primaryBlockerCode, "stale-packet");
    assert.equal(statePayload.decisionPlanProjection.action.kind, "replace-packet");
    assert.equal(statePayload.decisionPlanProjection.capabilities["run-packet"], "recovery-only");
    const dashboard = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(dashboard.code, 0, dashboard.stderr);
    const dashboardPayload = JSON.parse(dashboard.stdout);
    assert.equal(dashboardPayload.viewModel.lastRun.freshness.fresh, false);
    assert.match(
      dashboardPayload.viewModel.lastRun.freshness.reason,
      /execution, checks, scope, or recipe trust configuration changed/,
    );
    assert.notEqual(dashboardPayload.viewModel.nextBestAction.kind, "next");
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Stale trust config",
    ]);
    assert.notEqual(logged.code, 0);
    assert.match(logged.stderr, /execution, checks, scope, or recipe trust configuration changed/);
  });
});

test("packet command tampering is stale in dashboard and next preflight", async () => {
  await withTempDir("command-stale-last-run", async (dir) => {
    await setupFixture(dir, { name: "command trust" });
    const first = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(first.code, 0, first.stderr);
    const packet = JSON.parse(first.stdout);
    const acceptedCommand = packet.run.command;
    packet.run.command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=999')"`;
    await writeFile(packet.lastRunPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    const dashboard = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(dashboard.code, 0, dashboard.stderr);
    const dashboardPayload = JSON.parse(dashboard.stdout);
    assert.equal(dashboardPayload.viewModel.lastRun.freshness.fresh, false);
    assert.match(dashboardPayload.viewModel.lastRun.freshness.reason, /execution, checks, scope/);
    assert.equal(dashboardPayload.viewModel.decisionPlanProjection.action.kind, "replace-packet");
    assert.equal(dashboardPayload.viewModel.nextBestAction.kind, "replace-packet");

    const replacement = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(replacement.code, 0, replacement.stderr);
    const replacementPayload = JSON.parse(replacement.stdout);
    assert.equal(replacementPayload.ok, true);
    assert.equal(replacementPayload.run.command, acceptedCommand);
    assert.equal(replacementPayload.resultingDecision.action.kind, "log-decision");
    assert.equal(replacementPayload.resultingDecision.capabilities["run-packet"], "blocked");
    const replacementPacket = JSON.parse(await readFile(packet.lastRunPath, "utf8"));
    assert.equal(replacementPacket.run.command, acceptedCommand);
    assert.equal(acceptedCommand, packet.history.command);
  });
});

test("oversized benchmark contract files block packet freshness", async () => {
  await withTempDir("oversized-contract-last-run", async (dir) => {
    await setupFixture(dir, { name: "contract budget" });
    await writeFile(path.join(dir, "Cargo.toml"), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    const next = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.history.benchmarkContract.fingerprintByteBudgetExceeded, true);
    assert.match(JSON.stringify(packet.history.benchmarkContract.files), /fingerprint_byte_budget/);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Oversized contract",
    ]);
    assert.notEqual(logged.code, 0);
    assert.match(logged.stderr, /fingerprint byte budget/);
  });
});

test("owner-autonomous runs return continuation instead of handing control back", async () => {
  await withTempDir("continuation", async (dir) => {
    await setupFixture(dir, { name: "continuation" });
    await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "manual",
    ]);
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.resultingDecision.action.kind, "log-decision");
    assert.equal(packet.resultingDecision.capabilities["run-packet"], "blocked");
    assert.equal(packet.resultingDecision.loopDisposition.kind, "blocked");
    assert.equal(packet.resultingDecision.parentDisposition.kind, "hand-back");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Measure baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.resultingDecision.action.kind, "direct-work");
    assert.equal(payload.resultingDecision.capabilities["run-packet"], "allowed");
    assert.equal(payload.resultingDecision.capabilities.finalize, "blocked");
    assert.equal(payload.resultingDecision.loopDisposition.shouldContinue, true);
    assert.equal(payload.resultingDecision.parentDisposition.mayAnswer, true);
  });
});

test("guarded sessions with active budgets keep continuation non-final", async () => {
  await withTempDir("guarded-active-budget", async (dir) => {
    await setupFixture(dir, { name: "budget", packetBudget: 3 });
    await runCli(["config", "--cwd", dir, "--checks-policy", "manual"]);
    const next = await runCli(["next", "--cwd", dir, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.resultingDecision.action.kind, "log-decision");
    assert.equal(packet.resultingDecision.capabilities["run-packet"], "blocked");
    assert.equal(packet.resultingDecision.loopDisposition.shouldContinue, false);
    assert.match(packet.report.tried, /seconds=3/);
    assert.equal(packet.doctor, undefined);
    assert.match(packet.fullPacket, /lastRunPath/);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Measure baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.resultingDecision.capabilities["run-packet"], "allowed");
    assert.equal(payload.resultingDecision.loopDisposition.shouldContinue, true);
    assert.equal(payload.resultingDecision.parentDisposition.mayAnswer, true);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.activeBudget, true);
    assert.equal(statePayload.shouldContinue, true);
    assert.match(statePayload.commands.next, /--compact/);
    assert.equal(statePayload.decisionPlanProjection.action.kind, "direct-work");
    assert.equal(statePayload.decisionPlanProjection.capabilities["run-packet"], "allowed");
    assert.equal(statePayload.decisionPlanProjection.capabilities.finalize, "blocked");
    assert.equal(statePayload.decisionPlanProjection.loopDisposition.shouldContinue, true);
  });
});

test("continuation stops cleanly at the configured iteration limit", async () => {
  await withTempDir("continuation-limit", async (dir) => {
    await setupFixture(dir, { name: "continuation limit", packetBudget: 1 });
    await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "manual",
    ]);
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Measure limit baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.limit.limitReached, true);
    assert.equal(payload.resultingDecision.capabilities["run-packet"], "blocked");
    assert.equal(payload.resultingDecision.loopDisposition.shouldContinue, false);
    assert.ok(
      payload.resultingDecision.requiredEvidence.diagnosticCodes.includes(
        "packet-budget-exhausted",
      ),
    );
  });
});

test("log from last packet rejects keep after failed checks", async () => {
  await withTempDir("last-run-check-failure", async (dir) => {
    const checksCommand = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(1)"`;
    await setupFixture(dir, { name: "last run checks", checksCommand });
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.deepEqual(packet.decision.allowedStatuses, ["checks_failed"]);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Should not keep failed checks",
    ]);
    assert.notEqual(log.code, 0);
    const refusal = JSON.parse(log.stderr);
    assert.equal(refusal.code, "mutation-precondition-blocked");
    assert.equal(refusal.preconditionDecision.capabilities["authorize-keep"], "blocked");
    assert.ok(
      refusal.preconditionDecision.requiredEvidence.diagnosticCodes.includes(
        "packet-keep-not-authorized",
      ),
    );

    const jsonl = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(jsonl, /Should not keep failed checks/);
  });
});

test("metricless failure logs do not become baseline or best", async () => {
  await withTempDir("metricless-failures", async (dir) => {
    await setupFixture(dir, { name: "metricless failures" });

    const crash = await runCli([
      "log",
      "--cwd",
      dir,
      "--status",
      "crash",
      "--description",
      "Benchmark crashed before metric",
    ]);
    assert.equal(crash.code, 0, crash.stderr);
    const crashPayload = JSON.parse(crash.stdout);
    assert.equal(crashPayload.experiment.metric, null);
    assert.equal(crashPayload.experiment.metricEligible, false);
    assert.equal(crashPayload.experiment.promotion.label, "blocked");

    const checksFailed = await runCli([
      "log",
      "--cwd",
      dir,
      "--status",
      "checks_failed",
      "--description",
      "Checks failed before metric",
    ]);
    assert.equal(checksFailed.code, 0, checksFailed.stderr);
    const checksFailedPayload = JSON.parse(checksFailed.stdout);
    assert.equal(checksFailedPayload.experiment.metric, null);
    assert.equal(checksFailedPayload.experiment.metricEligible, false);
    assert.equal(checksFailedPayload.experiment.promotion.label, "blocked");

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, null);
    assert.equal(payload.best, null);
    assert.equal(payload.crashed, 1);
    assert.equal(payload.checksFailed, 1);
  });
});

test("measure logs metric evidence without keep/finalizer eligibility or git mutation", async () => {
  await withTempDir("measure-log-git-safe", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test User"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    const headBefore = await git(dir, ["rev-parse", "HEAD"]);

    await setupFixture(dir, { name: "measure" });
    await writeFile(path.join(dir, "tracked.txt"), "after\n");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1.23",
      "--status",
      "measure",
      "--description",
      "Record observation only",
      "--asi",
      JSON.stringify({ promotionGrade: true, evidence: "diagnostic measurement only" }),
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.status, "measure");
    assert.equal(payload.experiment.metricEligible, false);
    assert.equal(payload.experiment.promotion.label, "measurement");
    assert.equal(payload.experiment.commit, "");
    assert.equal(payload.git, "Git: no commit created.");
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), headBefore);
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.kept, 0);
    assert.equal(statePayload.measured, 1);
    assert.equal(statePayload.baseline, 1.23);
    assert.equal(statePayload.best, null);
    assert.equal(statePayload.promotion.count, 0);
    assert.equal(statePayload.promotion.baseline, null);
    assert.equal(statePayload.development.latest.status, "measure");
    assert.equal(statePayload.development.latest.metric, 1.23);

    const explicitCommit = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1.24",
      "--status",
      "measure",
      "--description",
      "Invalid commit provenance",
      "--commit",
      "HEAD",
    ]);
    assert.notEqual(explicitCommit.code, 0);
    assert.match(explicitCommit.stderr, /--commit is not allowed for measure logs/);
  });
});

test("from-last errors name next and manual measure recovery commands", async () => {
  await withTempDir("from-last-recovery", async (dir) => {
    await setupFixture(dir, { name: "recovery" });

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "No packet",
    ]);
    assert.notEqual(log.code, 0);
    assert.match(log.stderr, /No last-run packet found/);
    assert.match(log.stderr, /next --cwd/);
    assert.match(log.stderr, /--status measure/);
  });
});

function assertStalePacketCapabilityRefusal(stderr: string): void {
  const refusal = JSON.parse(stderr);
  assert.equal(refusal.code, "mutation-precondition-blocked");
  assert.equal(refusal.preconditionDecision.capabilities["authorize-keep"], "blocked");
  assert.ok(refusal.preconditionDecision.requiredEvidence.diagnosticCodes.includes("stale-packet"));
  assert.equal(refusal.mutation, undefined);
}

async function acceptCurrentContract(dir: string): Promise<void> {
  const accepted = await runCli([
    "new-segment",
    "--cwd",
    dir,
    "--reason",
    "Accept the current packet fixture repository state",
    "--yes",
  ]);
  assert.equal(accepted.code, 0, accepted.stderr);
}
