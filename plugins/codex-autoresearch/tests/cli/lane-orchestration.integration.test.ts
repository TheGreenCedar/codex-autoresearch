import assert from "node:assert/strict";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { quoteForShell } from "../helpers/process.js";

import { runCli, withTempDir, git, setupFixture } from "../helpers/cli-test-context.js";

test("research-fanout records generic parallel lanes without creating a bespoke metric", async () => {
  await withTempDir("research-fanout", async (dir) => {
    await setupFixture(dir, { name: "fanout", metricName: "quality_gap" });
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "measure",
      "--description",
      "Baseline measurement",
      "--asi",
      JSON.stringify({
        hypothesis: "Measure current research gaps",
        lane: "benchmark-contract",
        next_action_hint: "Scout benchmark validity before editing.",
      }),
    ]);

    const fanout = await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);
    assert.equal(fanout.code, 0, fanout.stderr);
    const plan = JSON.parse(fanout.stdout);
    assert.equal(plan.ok, true);
    assert.equal(plan.dryRun, false);
    assert.ok(plan.parallelLanes.length >= 4);
    assert.ok(plan.parallelLanes.length <= 6);
    assert.match(plan.fanoutPlan.metric.contract, /configured benchmark METRIC output/);
    assert.equal(plan.parallelLanes[0].evidenceStatus, "provisional");
    assert.equal(typeof plan.parallelLanes[0].brief.objective, "string");
    assert.ok(Array.isArray(plan.parallelLanes[0].brief.boundaries));
    assert.equal(typeof plan.parallelLanes[0].brief.expectedDecisionOutput, "string");

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.ok(payload.parallelLanes.length > 0);
    assert.equal(typeof payload.parallelLanes[0].brief.objective, "string");
    assert.equal(payload.fanoutPlan.status, "planned");
    assert.equal(payload.config.metricName, "quality_gap");

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const exportPayload = JSON.parse(exportResult.stdout);
    assert.ok(exportPayload.viewModel.parallelLanes.length > 0);
    assert.equal(exportPayload.viewModel.fanoutPlan.status, "planned");
    assert.equal(exportPayload.viewModel.evidenceLedger.counts.provisional, 1);
  });
});

test("lane-runner records scout advice without claiming worktree containment", async () => {
  await withTempDir("lane-runner-read-only", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--summary",
      "Scout found one benchmark-contract hypothesis.",
      "--recommendation",
      "Run one benchmark-contract packet next.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.lane.mode, "read_only_scout");
    assert.equal(payload.result.status, "completed");
    assert.equal(payload.result.evidenceAccepted, true);
    assert.equal(payload.result.executionBoundary.worktree, "");
    assert.deepEqual(payload.result.executionBoundary.writeScope, []);
    assert.equal(payload.result.executionBoundary.containment, "none");
    assert.equal(typeof payload.lane.brief.objective, "string");

    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.match(ledger, /"type":"lane_result"/);
    const laneEntry = ledger
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((entry) => entry.type === "lane_result");
    assert.equal(typeof laneEntry.lane.brief.objective, "string");

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const lane = statePayload.parallelLanes.find((item) => item.id === "read-only-scout");
    assert.equal(lane.status, "completed");
    assert.equal(lane.evidenceStatus, "accepted");
    assert.equal(typeof lane.brief.objective, "string");
  });
});

test("lane-runner records big-idea lanes as approval-gated advice only", async () => {
  await withTempDir("lane-runner-big-idea", async (dir) => {
    await setupFixture(dir, { name: "big idea", metricName: "quality_gap" });

    const blockedCommand = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--mode",
      "big_idea",
      "--command",
      "node -e \"console.log('METRIC quality_gap=0')\"",
    ]);
    assert.notEqual(blockedCommand.code, 0);
    assert.match(blockedCommand.stderr, /cannot run commands/i);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "architecture-scout",
      "--mode",
      "big_idea",
      "--summary",
      "Explore a distant architecture split for benchmark isolation.",
      "--recommendation",
      "Ask the operator before creating an implementation lane.",
      "--evidence",
      "Current loop has repeated local tweaks; benchmark trust is the bottleneck.",
      "--risks",
      "Architecture work can invalidate current metric history.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.lane.mode, "big_idea");
    assert.equal(payload.result.command, "");
    assert.equal(payload.result.approvalRequired, true);
    assert.equal(payload.result.approvalGate.required, true);
    assert.deepEqual(payload.result.approvalGate.requiredBefore, [
      "implementation_lane",
      "measured_packet",
    ]);
    assert.match(payload.result.summary, /distant architecture/i);
    assert.match(payload.result.recommendation, /operator/i);
    assert.match(payload.result.evidence.join("\n"), /benchmark trust/i);
    assert.match(payload.result.risks.join("\n"), /invalidate/i);
    assert.equal(payload.coordinatorRecommendation.status, "awaiting_human_approval");
    assert.match(payload.coordinatorRecommendation.measuredPacket, /Blocked/i);
  });
});

test("empty lane-runner records are planned breadcrumbs, not watchdog progress", async () => {
  await withTempDir("lane-runner-empty-planned", async (dir) => {
    await setupFixture(dir, {
      name: "lane watchdog",
      metricName: "quality_gap",
    });
    const oldTimestamp = Date.now() - 10 * 60 * 60 * 1000;
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "lane watchdog",
          metricName: "quality_gap",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          metric: 4,
          status: "measure",
          description: "Old baseline.",
          timestamp: oldTimestamp,
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const emptyResult = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--yes",
    ]);
    assert.equal(emptyResult.code, 0, emptyResult.stderr);
    const emptyPayload = JSON.parse(emptyResult.stdout);
    assert.equal(emptyPayload.result.status, "planned");
    assert.equal(emptyPayload.result.evidenceAccepted, false);

    const staleState = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(staleState.code, 0, staleState.stderr);
    const stalePayload = JSON.parse(staleState.stdout);
    const plannedLane = stalePayload.parallelLanes.find((item) => item.id === "read-only-scout");
    assert.equal(plannedLane.status, "planned");
    assert.equal(plannedLane.evidenceStatus, "provisional");
    assert.equal(stalePayload.watchdogSummary.stale, true);

    const commandResult = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--command",
      "git version",
      "--yes",
    ]);
    assert.equal(commandResult.code, 0, commandResult.stderr);
    const commandPayload = JSON.parse(commandResult.stdout);
    assert.equal(commandPayload.result.status, "completed");
    assert.equal(commandPayload.result.evidenceAccepted, true);

    const freshState = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(freshState.code, 0, freshState.stderr);
    const freshPayload = JSON.parse(freshState.stdout);
    const completedLane = freshPayload.parallelLanes.find((item) => item.id === "read-only-scout");
    assert.equal(completedLane.status, "completed");
    assert.equal(completedLane.evidenceStatus, "accepted");
    assert.equal(freshPayload.watchdogSummary.stale, false);
  });
});

test("lane-runner blocks implementation lanes without a declared write boundary", async () => {
  await withTempDir("lane-runner-isolation", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--summary",
      "Try an implementation candidate.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Implementation lanes require an explicit write boundary/);
  });
});

test("lane-runner rejects missing and foreign implementation worktrees", async () => {
  await withTempDir("lane-runner-worktree-edges", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "README.md"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const missing = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      "missing-worktree-path",
      "--command",
      "git status --short",
      "--summary",
      "Missing worktree.",
      "--yes",
    ]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /existing Git worktree/i);

    const foreignRepo = path.join(dir, "foreign-repo");
    await mkdir(foreignRepo, { recursive: true });
    await git(foreignRepo, ["init"]);
    await git(foreignRepo, ["config", "user.email", "codex@example.test"]);
    await git(foreignRepo, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(foreignRepo, "README.md"), "foreign\n", "utf8");
    await git(foreignRepo, ["add", "-A"]);
    await git(foreignRepo, ["commit", "-m", "foreign"]);

    const foreign = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      foreignRepo,
      "--command",
      "git status --short",
      "--summary",
      "Foreign worktree.",
      "--yes",
    ]);
    assert.notEqual(foreign.code, 0);
    assert.match(foreign.stderr, /same Git repository/i);
  });
});

test("lane-runner allows a sibling implementation worktree", async () => {
  await withTempDir("lane-runner-worktree-pass", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "README.md"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const worktreePath = path.join(dir, "lane-worktree");
    await git(dir, ["worktree", "add", worktreePath, "-b", "lane-impl"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      worktreePath,
      "--command",
      "git status --short",
      "--summary",
      "Sibling worktree command.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.commandResult.code, 0);
  });
});

test("lane-runner rejects the main checkout as an implementation worktree", async () => {
  await withTempDir("lane-runner-main-worktree", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      ".",
      "--summary",
      "Unsafe main checkout.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /separate Git worktree/);
  });
});

test("lane-runner blocks implementation commands that escape write scope", async () => {
  await withTempDir("lane-runner-write-scope", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('outside.txt','escape')\"",
      "--summary",
      "Unsafe write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outside --write-scope/);
  });
});

test("lane-runner blocks write-scope commands that hide changes in commits", async () => {
  await withTempDir("lane-runner-write-scope-commit", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('outside.txt','escape')\" && git add outside.txt && git commit -m escape",
      "--summary",
      "Hidden unsafe write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cannot run git cleanup|cannot move HEAD/);
  });
});

test("lane-runner blocks write-scope mutators before execution", async () => {
  const blockedCommands = [
    ["git stash push -m blocked", /cannot run git cleanup|look mutating/i],
    ["git cherry-pick HEAD", /cannot run git cleanup|look mutating/i],
    ["git revert --no-edit HEAD", /cannot run git cleanup|look mutating/i],
    ["npm ci", /cannot run git cleanup|dependency|look mutating/i],
  ];
  for (const [command, pattern] of blockedCommands) {
    await withTempDir("lane-runner-write-scope-mutator", async (dir) => {
      await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
      await git(dir, ["init"]);
      await git(dir, ["config", "user.email", "codex@example.test"]);
      await git(dir, ["config", "user.name", "Codex Test"]);
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-m", "initial"]);
      const marker = path.join(dir, "lane-ran.marker");
      const guardedCommand = `${command} && node -e "require('fs').writeFileSync('lane-ran.marker','ran')"`;

      const result = await runCli([
        "lane-runner",
        "--cwd",
        dir,
        "--lane-id",
        "implementation-candidate",
        "--mode",
        "implementation",
        "--write-scope",
        "src",
        "--command",
        guardedCommand,
        "--summary",
        "Unsafe mutator.",
        "--yes",
      ]);
      assert.notEqual(result.code, 0, command);
      assert.match(result.stderr, pattern, command);
      await assert.rejects(() => access(marker));
    });
  }
});

test("lane-runner blocks write-scope cleanup commands in the main checkout", async () => {
  await withTempDir("lane-runner-write-scope-cleanup", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "git -C . reset --hard",
      "--summary",
      "Unsafe cleanup.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cannot run git cleanup/);
  });
});

test("lane-runner refuses write-scope when unrelated dirty files already exist", async () => {
  await withTempDir("lane-runner-write-scope-pre-dirty", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await writeFile(path.join(dir, "outside.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);
    await writeFile(path.join(dir, "outside.txt"), "user edit\n", "utf8");

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('src/owned.txt','after')\"",
      "--summary",
      "Owned write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /dirty files outside scope/);
  });
});

test("lane-runner treats the source of a hostile rename as dirty outside write scope", async () => {
  await withTempDir("lane-runner-write-scope-hostile-rename", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    const original = process.platform === "win32" ? "outside 雪.txt" : "outside -> 雪.txt";
    const current = process.platform === "win32" ? "src/inside 雪.txt" : "src/inside -> 雪.txt";
    await writeFile(path.join(dir, original), "move me\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);
    await rename(path.join(dir, original), path.join(dir, current));

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('src/owned.txt','after')\"",
      "--summary",
      "Owned write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /dirty files outside scope/);
    assert.match(result.stderr, /outside(?: ->)? 雪\.txt/);
  });
});

test("lane-runner ignores completed lane results from older segments", async () => {
  await withTempDir("lane-runner-segment-results", async (dir) => {
    await setupFixture(dir, { name: "first segment", metricName: "quality_gap" });
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "7",
      "--status",
      "measure",
      "--description",
      "First segment measurement.",
    ]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);
    const first = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "benchmark-contract",
      "--summary",
      "Old segment result.",
      "--recommendation",
      "Do not reuse this after a segment change.",
      "--yes",
    ]);
    assert.equal(first.code, 0, first.stderr);

    await runCli(["new-segment", "--cwd", dir, "--reason", "New lane decision round.", "--yes"]);
    const second = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "benchmark-contract",
      "--dry-run",
    ]);
    assert.equal(second.code, 0, second.stderr);
    const payload = JSON.parse(second.stdout);
    assert.equal(payload.coordinatorRecommendation.status, "needs_lane_result");
    assert.notEqual(
      payload.coordinatorRecommendation.nextAction,
      "Do not reuse this after a segment change.",
    );
  });
});

test("lane-runner synthesizes completed lane results into one next action", async () => {
  await withTempDir("lane-runner-synthesis", async (dir) => {
    await setupFixture(dir, { name: "lane runner", metricName: "quality_gap" });
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "benchmark-contract",
      "--summary",
      "Benchmark contract is the riskiest assumption.",
      "--recommendation",
      "Run one measured packet that validates benchmark contract parsing.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.coordinatorRecommendation.status, "ready");
    assert.equal(
      payload.coordinatorRecommendation.nextAction,
      "Run one measured packet that validates benchmark contract parsing.",
    );
    assert.equal(typeof payload.coordinatorRecommendation.nextAction, "string");
    assert.ok(payload.coordinatorRecommendation.lessonsToAvoid.length >= 1);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.ok(statePayload.laneLifecycle.lessonsToAvoid.length >= 1);
  });
});

test("fanout plans are scoped to the active segment", async () => {
  await withTempDir("fanout-segment-scope", async (dir) => {
    await setupFixture(dir, { name: "fanout scope", metricName: "quality_gap" });
    const fanout = await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);
    assert.equal(fanout.code, 0, fanout.stderr);
    const plan = JSON.parse(fanout.stdout).fanoutPlan;
    assert.ok(plan.id);

    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "measure",
      "--description",
      "Segment zero measurement",
    ]);
    await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "fresh segment for fanout scope",
      "--yes",
    ]);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.segment, 1);
    assert.equal(payload.fanoutProvenance?.matchedSegment, false);
    assert.equal(payload.fanoutProvenance?.source, "memory_or_defaults");
    assert.notEqual(payload.fanoutPlan?.id, plan.id);
    assert.equal(payload.fanoutPlan, null);
  });
});

test("read-only lane-runner refuses non-Git commands before execution", async () => {
  await withTempDir("lane-runner-non-git", async (dir) => {
    await setupFixture(dir, { name: "non git lane", metricName: "quality_gap" });
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "2", "--yes"]);

    const blocked = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--command",
      `${quoteForShell(process.execPath)} -e "console.log('scout')"`,
      "--yes",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /refused before execution/i);
  });
});

test("completed lane results count as watchdog progress signals", async () => {
  await withTempDir("watchdog-lane-result", async (dir) => {
    await setupFixture(dir, { name: "lane watchdog" });
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "2", "--yes"]);
    const oldMs = Date.now() - 10 * 60 * 60 * 1000;
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "keep",
      "--description",
      "Old baseline",
    ]);
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const lines = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const entry of lines) {
      if (entry.run != null) entry.timestamp = oldMs;
    }
    await writeFile(
      ledgerPath,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const before = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(JSON.parse(before.stdout).watchdogSummary?.stale, true);

    await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--summary",
      "Scout completed.",
      "--recommendation",
      "Run one measured packet next.",
      "--yes",
    ]);

    const after = await runCli(["state", "--cwd", dir, "--json-full"]);
    const afterPayload = JSON.parse(after.stdout);
    assert.equal(afterPayload.watchdogSummary?.stale, false);
    assert.ok(
      afterPayload.parallelLanes.some(
        (lane) => lane.id === "read-only-scout" && lane.status === "completed",
      ),
    );
  });
});
