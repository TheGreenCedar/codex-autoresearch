import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { redactCommandDisplay } from "../../lib/evidence-redaction.js";
import { quoteForShell } from "../helpers/process.js";

import { runCli, withTempDir, git, setupFixture } from "../helpers/cli-test-context.js";

test("config persists operator settings and extends iteration limits", async () => {
  await withTempDir("operator-config", async (dir) => {
    await setupFixture(dir, { name: "operator config" });
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);

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
    assert.equal(payload.config.maxIterations, 5);
    assert.deepEqual(payload.config.commitPaths, ["src", "tests"]);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.settings.autonomyMode, "owner-autonomous");
    assert.equal(statePayload.limit.remainingIterations, 4);
    assert.match(statePayload.commands[0].command, /autoresearch\.mjs/);
    assert.match(statePayload.commands[0].command, /--cwd/);
    const commandRail = statePayload.commands
      .map((command) => `${command.label}: ${command.command}`)
      .join("\n");
    const commandTexts = statePayload.commands.map((command) => command.command).join("\n");
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
    await setupFixture(dir, { name: "last run" });
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3'); console.log('METRIC cache_hits=8')"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
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
      redactCommandDisplay(command, { workDir: dir }),
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
    await setupFixture(dir, { name: "fresh last run" });
    const firstCommand = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const first = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      firstCommand,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(first.code, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout);
    const packetPath = firstPayload.lastRunPath;
    const before = JSON.parse(await readFile(packetPath, "utf8"));
    assert.equal(before.decision.metric, 3);

    const sideEffectFile = path.join(dir, "second-packet-ran.txt");
    const sideEffectScript = path.join(dir, "second-packet.mjs");
    await writeFile(
      sideEffectScript,
      [
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(sideEffectFile)}, "ran");`,
        `console.log("METRIC seconds=99");`,
        "",
      ].join("\n"),
      "utf8",
    );
    const secondCommand = `${quoteForShell(process.execPath)} ${quoteForShell(sideEffectScript)}`;
    const second = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      secondCommand,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(second.code, 0, second.stderr);
    const refused = JSON.parse(second.stdout);
    assert.equal(refused.ok, false);
    assert.equal(refused.refused, true);
    assert.equal(refused.code, "next_blocked_by_loop_contract");
    assert.equal(refused.blockingAction.kind, "log-decision");
    assert.equal(refused.loopContract.canRunNextPacket, false);
    assert.equal(refused.run, null);
    assert.equal(refused.decision, null);
    assert.match(refused.commandHint, /\blog\b/);

    const after = JSON.parse(await readFile(packetPath, "utf8"));
    assert.equal(after.decision.metric, 3);
    assert.equal(after.packetEvidence.metrics.seconds, 3);
    await assert.rejects(access(sideEffectFile));
  });
});

test("next parses metrics from the full benchmark output before display truncation", async () => {
  await withTempDir("full-output-metric", async (dir) => {
    await setupFixture(dir, { name: "full output" });
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

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, 7);
    assert.equal(packet.run.parsedPrimary, 7);
    assert.equal(packet.run.outputTruncated, true);
  });
});

test("successful last-run packets require explicit status and suggest discard for regressions", async () => {
  await withTempDir("last-run-suggest-discard", async (dir) => {
    await setupFixture(dir, { name: "suggest discard", direction: "lower" });
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=4')"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.suggestedStatus, "discard");
    assert.deepEqual(packet.decision.allowedStatuses, ["keep", "discard", "measure"]);

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
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    const directLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "keep",
      "--description",
      "Manual run",
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
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "git stale packet" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "tracked.txt"), "changed after next\n", "utf8");
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
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "dirty content packet" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "dirty before packet\n", "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "tracked.txt"), "dirty after packet\n", "utf8");
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
    assert.match(stale.stderr, /dirty file contents changed/);
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

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`,
      "--checks-policy",
      "manual",
    ]);
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
    assert.match(stale.stderr, /dirty file contents changed/);
  });
});

test("stale last-run packets are rejected when untracked directory contents change", async () => {
  await withTempDir("stale-last-run-untracked-dir", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await setupFixture(dir, { name: "untracked dir packet" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await mkdir(path.join(dir, "scratch"), { recursive: true });
    await writeFile(path.join(dir, "scratch", "thing.txt"), "before packet\n", "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "scratch", "thing.txt"), "after packet\n", "utf8");
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
    assert.match(stale.stderr, /dirty file contents changed|Git dirty state changed/);
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

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.ok, false);
    assert.equal(packet.refused, true);
    assert.equal(packet.code, "next_blocked_by_truncated_fingerprints");
    assert.match(
      JSON.stringify(packet.git.dirtyFileFingerprints),
      /dirty_file_entry_limit|directory_entry_limit/,
    );
    assert.match(packet.nextAction, /Clean or narrow the dirty tree/);
    await assert.rejects(access(path.join(dir, "autoresearch.last-run.json")));
    await assert.rejects(access(path.join(dir, ".git", "autoresearch", "last-run.json")));
  });
});

test("next allows clean repos with broad scoped commit paths", async () => {
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
    await git(dir, ["add", "autoresearch.config.json", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session config"]);
    const status = await git(dir, ["status", "--short"]);
    assert.equal(status, "");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.notEqual(packet.code, "next_blocked_by_truncated_fingerprints");
    assert.equal(packet.decision.metric, 3);
    const lastRun = JSON.parse(await readFile(packet.lastRunPath, "utf8"));
    assert.match(JSON.stringify(lastRun.history.git.fileFingerprints), /scoped_file_entry_limit/);
    assert.equal(
      JSON.stringify(lastRun.history.git.dirtyFileFingerprints).includes("truncated"),
      false,
    );

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Large clean scoped path measurement",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
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
    const initialized = await setupFixture(dir, { name: "oversized fingerprint" });
    assert.equal(initialized.code, 0, initialized.stderr);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "oversized.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.code, "next_blocked_by_truncated_fingerprints");
    assert.match(JSON.stringify(payload.git), /fingerprint_byte_budget/);
  });
});

test("last-run packets are rejected when config changes before logging", async () => {
  await withTempDir("config-stale-last-run", async (dir) => {
    await setupFixture(dir, { name: "first config" });
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
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
    assert.match(stale.stderr, /session config changed/);
  });
});

test("last-run freshness hashes execution policy and commit scope", async () => {
  await withTempDir("trust-config-stale-last-run", async (dir) => {
    await setupFixture(dir, { name: "trust config" });
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.match(packet.history.trustConfig.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      packet.history.trustConfig.fields,
      [...packet.history.trustConfig.fields].sort(),
    );
    assert.equal(JSON.stringify(packet.history.trustConfig).includes(command), false);

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
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const first = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(first.code, 0, first.stderr);
    const packet = JSON.parse(first.stdout);
    packet.run.command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=999')"`;
    await writeFile(packet.lastRunPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    const dashboard = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(dashboard.code, 0, dashboard.stderr);
    const dashboardPayload = JSON.parse(dashboard.stdout);
    assert.equal(dashboardPayload.viewModel.lastRun.freshness.fresh, false);
    assert.match(dashboardPayload.viewModel.lastRun.freshness.reason, /execution, checks, scope/);
    assert.equal(dashboardPayload.viewModel.nextBestAction.kind, "stale-packet");

    const replacement = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(replacement.code, 0, replacement.stderr);
    assert.equal(
      JSON.parse(replacement.stdout).run.command,
      redactCommandDisplay(command, { workDir: dir }),
    );
  });
});

test("oversized benchmark contract files block packet freshness", async () => {
  await withTempDir("oversized-contract-last-run", async (dir) => {
    await setupFixture(dir, { name: "contract budget" });
    await writeFile(path.join(dir, "Cargo.toml"), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
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
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");
    assert.equal(packet.continuation.requiresLogDecision, true);
    assert.equal(packet.continuation.shouldAskUser, false);
    assert.equal(packet.continuation.forbidFinalAnswer, true);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.continuation.stage, "logged");
    assert.equal(payload.continuation.shouldContinue, true);
    assert.equal(payload.continuation.shouldAskUser, false);
    assert.equal(payload.continuation.forbidFinalAnswer, true);
    assert.match(payload.continuation.nextAction, /without asking the user/);
    assert.match(payload.continuation.commands.next, / next /);
  });
});

test("guarded sessions with active budgets keep continuation non-final", async () => {
  await withTempDir("guarded-active-budget", async (dir) => {
    await setupFixture(dir, { name: "budget" });
    await runCli(["config", "--cwd", dir, "--checks-policy", "manual", "--max-iterations", "3"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");
    assert.equal(packet.continuation.activeBudget, true);
    assert.equal(packet.continuation.shouldContinue, true);
    assert.equal(packet.continuation.forbidFinalAnswer, true);
    assert.match(packet.report.tried, /seconds=3/);
    assert.equal(packet.doctor, undefined);
    assert.match(packet.fullPacket, /lastRunPath/);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.continuation.stage, "logged");
    assert.equal(payload.continuation.activeBudget, true);
    assert.equal(payload.continuation.shouldContinue, true);
    assert.equal(payload.continuation.forbidFinalAnswer, true);
    assert.match(payload.continuation.finalAnswerPolicy, /Do not stop/);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.activeBudget, true);
    assert.equal(statePayload.shouldContinue, true);
    assert.equal(statePayload.canRunNextPacket, false);
    assert.equal(statePayload.forbidFinalAnswer, true);
    assert.match(statePayload.commands.next, /--compact/);
    assert.equal(statePayload.resolvedDecision.canonicalNextAction.kind, "preflight");
    assert.match(statePayload.report.next, /benchmark command/i);
    assert.equal(
      statePayload.report.next,
      statePayload.resolvedDecision.canonicalNextAction.reason,
    );
  });
});

test("continuation stops cleanly at the configured iteration limit", async () => {
  await withTempDir("continuation-limit", async (dir) => {
    await setupFixture(dir, { name: "continuation limit" });
    await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "manual",
      "--max-iterations",
      "1",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Limit baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.limit.limitReached, true);
    assert.equal(payload.continuation.shouldContinue, false);
    assert.match(payload.continuation.stopReason, /maxIterations reached/);
    assert.match(payload.continuation.commands.extendLimit, /--extend 10/);
  });
});

test("log from last packet rejects keep after failed checks", async () => {
  await withTempDir("last-run-check-failure", async (dir) => {
    await setupFixture(dir, { name: "last run checks" });
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(1)"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-command",
      checks,
    ]);
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
    assert.match(log.stderr, /Cannot log status 'keep'/);

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
