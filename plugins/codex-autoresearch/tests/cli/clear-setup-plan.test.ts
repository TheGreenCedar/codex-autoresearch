import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { quoteForAcceptedShell } from "../helpers/process.js";

import { runCli, withTempDir, git, setupFixture } from "../helpers/cli-test-context.js";

test("clear removes deep research scratchpads", async () => {
  await withTempDir("clear-research", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "cleanup",
      "--goal",
      "Cleanup research",
    ]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const result = await runCli(["clear", "--cwd", dir, "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(researchRoot));
  });
});

test("clear dry-run previews deletion targets without removing files", async () => {
  await withTempDir("clear-dry-run", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "preview",
      "--goal",
      "Preview cleanup",
    ]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const result = await runCli(["clear", "--cwd", dir, "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.deleted.length, 0);
    assert.ok(payload.targets.includes(researchRoot));
    assert.ok(payload.wouldDelete.includes(researchRoot));
    await access(researchRoot);
  });
});

test("clear removes active progress snapshots in fallback and Git-private modes", async () => {
  await withTempDir("clear-progress-snapshots", async (dir) => {
    const fallbackProgress = path.join(dir, "autoresearch.progress.json");
    const fallbackLastRun = path.join(dir, "autoresearch.last-run.json");
    await writeFile(fallbackProgress, JSON.stringify({ exitState: "running" }), "utf8");
    await writeFile(fallbackLastRun, JSON.stringify({ run: 1 }), "utf8");

    const fallbackPreview = await runCli(["clear", "--cwd", dir, "--dry-run"]);
    assert.equal(fallbackPreview.code, 0, fallbackPreview.stderr);
    const fallbackPayload = JSON.parse(fallbackPreview.stdout);
    assert.ok(fallbackPayload.wouldDelete.includes(fallbackProgress));
    assert.ok(fallbackPayload.wouldDelete.includes(fallbackLastRun));
    await access(fallbackProgress);

    const fallbackClear = await runCli(["clear", "--cwd", dir, "--yes"]);
    assert.equal(fallbackClear.code, 0, fallbackClear.stderr);
    await assert.rejects(access(fallbackProgress));
    await assert.rejects(access(fallbackLastRun));
  });

  await withTempDir("clear-git-progress-snapshots", async (dir) => {
    await git(dir, ["init", "-b", "main"]);
    const gitPrivateDir = path.join(dir, ".git", "autoresearch");
    const gitProgress = path.join(gitPrivateDir, "progress.json");
    const gitLastRun = path.join(gitPrivateDir, "last-run.json");
    await mkdir(gitPrivateDir, { recursive: true });
    await writeFile(gitProgress, JSON.stringify({ exitState: "running" }), "utf8");
    await writeFile(gitLastRun, JSON.stringify({ run: 1 }), "utf8");

    const gitPreview = await runCli(["clear", "--cwd", dir, "--dry-run"]);
    assert.equal(gitPreview.code, 0, gitPreview.stderr);
    const gitPayload = JSON.parse(gitPreview.stdout);
    assert.ok(gitPayload.wouldDelete.includes(gitProgress));
    assert.ok(gitPayload.wouldDelete.includes(gitLastRun));
    await access(gitProgress);

    const gitClear = await runCli(["clear", "--cwd", dir, "--yes"]);
    assert.equal(gitClear.code, 0, gitClear.stderr);
    await assert.rejects(access(gitProgress));
    await assert.rejects(access(gitLastRun));
  });
});

test("setup-plan preserves explicit command, state inputs, and baseline measure guidance", async () => {
  await withTempDir("setup-plan-inputs", async (dir) => {
    const benchmark = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "explicit setup",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--checks-command",
      checks,
      "--commit-paths",
      "src,tests",
      "--max-iterations",
      "7",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.nextCommand, /--benchmark-command/);
    assert.match(payload.nextCommand, /METRIC seconds=1/);
    assert.match(payload.nextCommand, /--checks-command/);
    assert.match(payload.nextCommand, /process\.exit\(0\)/);
    assert.match(payload.nextCommand, /--commit-paths ['"]?src,tests['"]?/);
    assert.match(payload.nextCommand, /--max-iterations ['"]?7['"]?/);
    assert.equal(payload.benchmarkMode.printsMetric, true);
    assert.match(payload.benchmarkLintCommand, /benchmark-lint/);
    assert.equal(payload.missingEssentials.length, 0);
    assert.equal(payload.nextStep.stage, "setup-repair");
    assert.equal(payload.nextStep.nextAction.title, "Create session setup");
    assert.equal(payload.nextStep.nextAction.safety, "state_mutation");
    assert.match(payload.nextStep.nextAction.command, / setup /);
    assert.equal(payload.nextStep.nextAction.toolName, "setup_session");
    assert.deepEqual(
      payload.firstRunChecklist.map((step) => step.step),
      ["setup", "benchmark-lint", "doctor", "checkpoint", "baseline", "log"],
    );
    const logStep = payload.firstRunChecklist.find((step) => step.step === "log");
    assert.match(logStep.command, /--status measure --description ['"]Baseline measurement['"]/);

    await setupFixture(dir, {
      name: "guide setup",
      benchmarkCommand: benchmark,
      acceptedContract: true,
    });
    const guide = await runCli(["guide", "--cwd", dir, "--benchmark-command", benchmark]);
    assert.equal(guide.code, 0, guide.stderr);
    const guidePayload = JSON.parse(guide.stdout);
    assert.equal(guidePayload.nextStep.stage, "run-baseline");
    assert.equal(guidePayload.nextStep.nextAction.title, "Run the accepted baseline");
    const plan = guidePayload.state.decisionPlan;
    assert.equal(plan.action.kind, "run-baseline");
    assert.equal(plan.capabilities["run-packet"], "allowed");
    assert.equal(plan.loopDisposition.kind, "continue");
    assert.ok(plan.requiredEvidence.diagnosticCodes.includes("needs-baseline"));
  });
});

test("setup-plan on configured session recommends doctor instead of setup repair", async () => {
  await withTempDir("setup-plan-configured-session", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      `${JSON.stringify({
        type: "config",
        name: "demo",
        metricName: "seconds",
        bestDirection: "lower",
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxIterations: 5 }),
      "utf8",
    );
    await writeFile(
      path.join(dir, "autoresearch.ps1"),
      "Write-Output 'METRIC seconds=1'\n",
      "utf8",
    );

    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "demo",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      "powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.configured, true);
    assert.deepEqual(payload.missingEssentials, []);
    assert.match(payload.nextCommand, /doctor|state/);
    assert.doesNotMatch(payload.nextCommand, /\ssetup\s/);
    assert.equal(payload.nextStep.stage, "configured-session");
    assert.match(payload.nextStep.nextAction.command, /doctor|state/);
    assert.doesNotMatch(payload.nextStep.nextAction.command, /\ssetup\s/);
  });
});

test("setup-plan renders benchmark command arguments for the requested shell", async () => {
  await withTempDir("setup-plan-shell-quoting", async (dir) => {
    const benchmark =
      "node -e \"console.log('METRIC seconds=1 $HOME $(whoami) `whoami` C:\\bench path')\"";

    const powershellResult = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "shell quoting",
      "--metric-name",
      "seconds",
      "--shell",
      "powershell",
      "--benchmark-command",
      benchmark,
    ]);
    assert.equal(powershellResult.code, 0, powershellResult.stderr);
    const powershellPayload = JSON.parse(powershellResult.stdout);
    assert.match(
      powershellPayload.nextCommand,
      /^& \{ \$PSNativeCommandArgumentPassing = 'Legacy'; /,
    );
    assert.match(
      powershellPayload.nextCommand,
      /--benchmark-command 'node -e \\"console\.log\(''METRIC seconds=1 \$HOME \$\(whoami\) `whoami` C:\\bench path''\)\\"/,
    );
    assert.doesNotMatch(powershellPayload.nextCommand, /--benchmark-command "/);
    assert.match(
      powershellPayload.benchmarkLintCommand,
      /--command 'node -e \\"console\.log\(''METRIC seconds=1 \$HOME \$\(whoami\) `whoami` C:\\bench path''\)\\"/,
    );

    const bashResult = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "shell quoting",
      "--metric-name",
      "seconds",
      "--shell",
      "bash",
      "--benchmark-command",
      benchmark,
    ]);
    assert.equal(bashResult.code, 0, bashResult.stderr);
    const bashPayload = JSON.parse(bashResult.stdout);
    assert.match(bashPayload.nextCommand, /--benchmark-command 'node -e "console\.log\('/);
    assert.match(
      bashPayload.nextCommand,
      /'"'"'METRIC seconds=1 \$HOME \$\(whoami\) `whoami` C:\\bench path'"'"'/,
    );
    assert.doesNotMatch(bashPayload.nextCommand, /--benchmark-command "/);
  });
});

test("setup-plan treats recommended recipe benchmark as configured", async () => {
  await withTempDir("setup-plan-recipe-defaults", async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      '{"scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
      "utf8",
    );

    const result = await runCli(["setup-plan", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.recommendedRecipe.id, "node-test-runtime");
    assert.deepEqual(payload.missing, []);
    assert.deepEqual(payload.missingEssentials, []);
    assert.doesNotMatch(payload.nextStep.nextAction.reason, /benchmark_command/);
    assert.match(
      payload.nextCommand,
      /--recipe (?:'node-test-runtime'|"node-test-runtime"|node-test-runtime)\b/,
    );
  });
});

test("setup-plan warns when files in scope and commit paths diverge", async () => {
  await withTempDir("setup-plan-scope-warning", async (dir) => {
    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "scope warning",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
      "--files-in-scope",
      "src",
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.scopeWarnings.join("\n"), /tests/);
    assert.match(payload.notes.join("\n"), /Scope warning/);
  });
});
