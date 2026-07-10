import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolvePackageRoot } from "../../lib/runtime-paths.js";
import { createCliRunner, runGit, runProcess, withTempDir } from "../helpers/process.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const runCli = createCliRunner(cli, pluginRoot);

const longText = (label: string, length: number) =>
  `${label} ${"detail ".repeat(Math.ceil(length / 7))}`.slice(0, length);

const delimitedItems = (label: string, count: number, length: number) =>
  Array.from({ length: count }, (_, index) => longText(`${label}-${index + 1}`, length)).join("; ");

test("lane-runner big_idea mode is read-only, approval-gated, and bounded", async () => {
  await withTempDir("autoresearch", "lane-runner-big-idea", async (dir) => {
    const init = await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "big idea lane",
      "--metric-name",
      "quality_gap",
    ]);
    assert.equal(init.code, 0, init.stderr);

    const blockedCommand = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--mode",
      "big_idea",
      "--command",
      'node -e "process.exit(99)"',
      "--yes",
    ]);
    assert.notEqual(blockedCommand.code, 0);
    assert.match(blockedCommand.stderr, /read-only advice lanes and cannot run commands/i);

    const blockedWriteScope = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--mode",
      "big_idea",
      "--write-scope",
      "src/index.ts",
      "--yes",
    ]);
    assert.notEqual(blockedWriteScope.code, 0);
    assert.match(blockedWriteScope.stderr, /cannot declare worktrees or write scopes/i);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "architecture-scout",
      "--mode",
      "big_idea",
      "--summary",
      longText("Explore a distant architecture split for benchmark isolation.", 900),
      "--recommendation",
      longText("Ask the operator before creating an implementation lane.", 900),
      "--evidence",
      delimitedItems("benchmark-trust-evidence", 7, 260),
      "--risks",
      delimitedItems("metric-history-risk", 7, 260),
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.lane.id, "architecture-scout");
    assert.equal(payload.lane.mode, "big_idea");
    assert.equal(payload.result.command, "");
    assert.equal(payload.result.commandResult, null);
    assert.equal(payload.result.executionBoundary.mode, "big_idea");
    assert.equal(payload.result.executionBoundary.commandPolicy, "no_command_execution");
    assert.equal(payload.result.executionBoundary.containment, "none");

    assert.equal(payload.result.approvalRequired, true);
    assert.equal(payload.result.humanApproval, false);
    assert.deepEqual(payload.result.approvalGate.requiredBefore, [
      "implementation_lane",
      "measured_packet",
    ]);
    assert.equal(payload.coordinatorRecommendation.status, "awaiting_human_approval");
    assert.match(payload.coordinatorRecommendation.measuredPacket, /Blocked/i);

    assert.ok(payload.result.summary.length <= 700);
    assert.match(payload.result.summary, /\.\.\.$/);
    assert.ok(payload.result.recommendation.length <= 700);
    assert.match(payload.result.recommendation, /\.\.\.$/);
    assert.equal(payload.result.evidence.length, 5);
    assert.equal(payload.result.risks.length, 5);
    assert.ok(payload.result.evidence.every((item: string) => item.length <= 220));
    assert.ok(payload.result.risks.every((item: string) => item.length <= 220));

    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    const laneEntries = ledger
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "lane_result");
    assert.equal(laneEntries.length, 1);
    assert.equal(laneEntries[0].lane.mode, "big_idea");
    assert.equal(laneEntries[0].result.approvalGate.required, true);

    const stateAfterUnapproved = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(stateAfterUnapproved.code, 0, stateAfterUnapproved.stderr);
    const unapprovedStatePayload = JSON.parse(stateAfterUnapproved.stdout);
    assert.equal(unapprovedStatePayload.approvalLedger.status, "blocked");
    assert.equal(unapprovedStatePayload.canonicalNextAction.kind, "approval-gate");
    assert.match(unapprovedStatePayload.approvalLedger.blockers.join(" "), /architecture-scout/);

    const recommendAfterUnapproved = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommendAfterUnapproved.code, 0, recommendAfterUnapproved.stderr);
    const unapprovedRecommendPayload = JSON.parse(recommendAfterUnapproved.stdout);
    assert.equal(
      unapprovedRecommendPayload.decisionEnvelope.canonicalNextAction.kind,
      "approval-gate",
    );

    const approved = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "architecture-scout",
      "--mode",
      "big_idea",
      "--summary",
      "Approved architecture direction.",
      "--recommendation",
      "Run one isolated implementation lane.",
      "--approved",
      "--yes",
    ]);
    assert.equal(approved.code, 0, approved.stderr);
    const approvedPayload = JSON.parse(approved.stdout);
    assert.equal(approvedPayload.result.status, "approved");
    assert.equal(approvedPayload.result.evidenceAccepted, true);
    assert.equal(approvedPayload.result.approvalRequired, false);
    assert.equal(approvedPayload.coordinatorRecommendation.status, "ready");
    assert.equal(
      approvedPayload.coordinatorRecommendation.nextAction,
      "Run one isolated implementation lane.",
    );

    const approvalLedger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    const approvalEntries = approvalLedger
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "approval");
    assert.equal(approvalEntries.length, 1);
    assert.equal(approvalEntries[0].gate, "big_idea_architecture");
    assert.equal(approvalEntries[0].scope, "architecture-scout");

    const replayedApproval = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "architecture-scout",
      "--mode",
      "big_idea",
      "--summary",
      "Replay approval without passing approved flag.",
      "--recommendation",
      "Approval is already durable.",
      "--yes",
    ]);
    assert.equal(replayedApproval.code, 0, replayedApproval.stderr);
    const replayedPayload = JSON.parse(replayedApproval.stdout);
    assert.equal(replayedPayload.result.approvalRequired, false);
    assert.equal(replayedPayload.result.approvalGate.matchedApproval.scope, "architecture-scout");

    const stateAfterApproval = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(stateAfterApproval.code, 0, stateAfterApproval.stderr);
    const approvedStatePayload = JSON.parse(stateAfterApproval.stdout);
    assert.equal(approvedStatePayload.approvalLedger.status, "approved");
    assert.notEqual(approvedStatePayload.canonicalNextAction.kind, "approval-gate");
  });
});

test("lane-runner refuses non-allowlisted scout side effects before execution", async () => {
  await withTempDir("autoresearch", "lane-runner-scout-argv", async (dir) => {
    await runGit(dir, ["init"]);
    await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(dir, "README.md"), "tracked\n");
    await runGit(dir, ["add", ".gitignore", "README.md"]);
    await runGit(dir, ["commit", "-m", "base"]);
    await runGit(dir, ["config", "lane.test", "original"]);
    const externalDiffMarker = path.join(dir, "external-diff-ran.txt");
    const externalDiff = path.join(dir, "external-diff.mjs");
    await writeFile(
      externalDiff,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(externalDiffMarker)}, "ran");`,
    );
    await runGit(dir, ["config", "diff.external", `"${process.execPath}" "${externalDiff}"`]);
    const init = await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "strict scout argv",
      "--metric-name",
      "quality_gap",
    ]);
    assert.equal(init.code, 0, init.stderr);

    const outsidePath = path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`);
    const attempts = [
      ["ignored output", "git diff --output=ignored.txt"],
      ["outside-root output", `git diff --output=${outsidePath}`],
      ["interpreter write", `node -e "require('node:fs').writeFileSync('ignored.txt','x')"`],
      ["POSIX shell", 'sh -c "echo x > ignored.txt"'],
      ["Windows shell", 'cmd /c "echo x > ignored.txt"'],
      ["Git config mutation", "git config lane.test changed"],
      ["Git ref mutation", "git update-ref refs/heads/scout-side-effect HEAD"],
      ["network command", "git fetch https://example.invalid/repo"],
      ["process-spawning command", "git difftool --extcmd=echo"],
      ["process-spawning option", "git grep --open-files-in-pager=cat tracked"],
      ["configured diff option", "git status --verbose"],
      ["shell chaining", "git status && git config lane.test changed"],
    ];
    for (const [label, command] of attempts) {
      const refused = await runCli([
        "lane-runner",
        "--cwd",
        dir,
        "--mode",
        "read_only_scout",
        "--command",
        command,
        "--yes",
      ]);
      assert.notEqual(refused.code, 0, label);
      assert.match(refused.stderr, /refused before execution/i, label);
    }

    await assert.rejects(access(path.join(dir, "ignored.txt")));
    await assert.rejects(access(outsidePath));
    assert.equal(await runGit(dir, ["config", "--get", "lane.test"]), "original");
    const ref = await runProcess(
      "git",
      ["show-ref", "--verify", "--quiet", "refs/heads/scout-side-effect"],
      dir,
    );
    assert.notEqual(ref.code, 0);
    await writeFile(path.join(dir, "README.md"), "changed\n");

    const allowed = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--mode",
      "read_only_scout",
      "--command",
      "git diff",
      "--yes",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    const payload = JSON.parse(allowed.stdout);
    assert.equal(payload.result.commandResult.code, 0);
    assert.equal(
      payload.result.executionBoundary.commandPolicy,
      "strict_git_read_only_argv_allowlist",
    );
    assert.equal(payload.result.executionBoundary.postRunDetection, "git_porcelain_best_effort");
    assert.equal(payload.result.executionBoundary.containment, "none");
    await assert.rejects(access(externalDiffMarker));
  });
});
