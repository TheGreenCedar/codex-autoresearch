import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { quoteForShell } from "../helpers/process.js";
import { readGoalBrief, runCli, withTempDir, setupFixture } from "./helpers.js";

const passingChecks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;

const scoreFileBenchmark = `${quoteForShell(process.execPath)} -e "const fs=require('node:fs'); const score=fs.readFileSync('src/score.txt','utf8').trim(); console.log('METRIC score='+score)"`;

async function acceptDeterministicContract(dir: string, reason: string) {
  const configPath = path.join(dir, "autoresearch.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        checksAuthoritative: true,
        noiseModel: { kind: "deterministic" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const accepted = await runCli(["new-segment", "--cwd", dir, "--reason", reason, "--yes"]);
  assert.equal(accepted.code, 0, accepted.stderr);
}

async function logScoreBaseline(
  dir: string,
  metric: number,
  description = "Reference measurement",
) {
  await writeFile(path.join(dir, "src", "score.txt"), `${metric}\n`, "utf8");
  const packet = await runCli(["next", "--cwd", dir]);
  assert.equal(packet.code, 0, packet.stderr);
  const baseline = await runCli([
    "log",
    "--cwd",
    dir,
    "--from-last",
    "--status",
    "measure",
    "--description",
    description,
  ]);
  assert.equal(baseline.code, 0, baseline.stderr);
}

async function logKeptScoreCandidate(
  dir: string,
  metric: number,
  description: string,
  extraArgs: string[] = [],
) {
  await writeFile(path.join(dir, "src", "score.txt"), `${metric}\n`, "utf8");
  const packet = await runCli(["next", "--cwd", dir]);
  assert.equal(packet.code, 0, packet.stderr);
  const packetPayload = JSON.parse(packet.stdout);
  assert.equal(
    packetPayload.decision.allowedStatuses.includes("keep"),
    true,
    JSON.stringify(packetPayload.run.contractKeepEligibility, null, 2),
  );
  const kept = await runCli([
    "log",
    "--cwd",
    dir,
    "--from-last",
    "--status",
    "keep",
    "--description",
    description,
    ...extraArgs,
  ]);
  assert.equal(kept.code, 0, kept.stderr);
}

test("delight commands provide compact state, onboarding, linting, hooks, and new segments", async () => {
  await withTempDir("delight-commands", async (dir) => {
    await setupFixture(dir, {
      name: "Delight loop",
      goal: "Improve score with evidence",
      metricName: "score",
      direction: "higher",
      completeContract: true,
      benchmarkCommand: scoreFileBenchmark,
      checksCommand: passingChecks,
    });
    await acceptDeterministicContract(dir, "Accept the delight fixture contract");
    await logScoreBaseline(dir, 4);
    await logKeptScoreCandidate(dir, 5, "Accepted score improvement", [
      "--asi",
      JSON.stringify({ hypothesis: "candidate", evidence: "score=5" }),
    ]);

    const compact = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    assert.equal(compactPayload.metric, "score");
    assert.equal(compactPayload.goal, "Improve score with evidence");
    assert.equal(compactPayload.runs, 2);
    assert.equal(compactPayload.measured, 1);
    assert.equal(compactPayload.kept, 1);
    const compactPlan = compactPayload.decisionPlanProjection;
    assert.equal(compactPlan.kind, "decision-plan-projection");
    assert.equal(compactPlan.action.kind, "direct-work");
    assert.equal(compactPlan.capabilities["run-packet"], "allowed");
    assert.equal(compactPlan.capabilities.finalize, "blocked");
    assert.equal(compactPlan.loopDisposition.kind, "continue");
    assert.equal(compactPlan.parentDisposition.kind, "hand-back");
    assert.ok(compactPlan.requiredEvidence.diagnosticCodes.includes("finalization-blocked"));

    const goalPayload = await readGoalBrief(dir, ["--codex-goal-status", "active"]);
    assert.equal(goalPayload.kind, "codex-autoresearch-goal-bridge");
    assert.match(goalPayload.objectiveDraft, /Improve score with evidence/);
    assert.match(goalPayload.objectiveDraft, /METRIC score=value/);
    assert.equal(goalPayload.importedCodexGoal.status, "active");
    assert.equal(goalPayload.completionAudit.canMarkCodexGoalComplete, false);
    assert.equal(goalPayload.canMarkCodexGoalComplete, false);
    assert.ok(goalPayload.completionBlocker);
    assert.match(goalPayload.commands.explicitGoalToolPrompt, /using the goal tool/);

    const devOnlyPayload = await readGoalBrief(dir, [
      "--codex-goal-status",
      "active",
      "--completion-confirmed",
      "--completion-evidence",
      "One kept dev metric",
    ]);
    assert.equal(devOnlyPayload.completionAudit.canMarkCodexGoalComplete, false);
    assert.equal(devOnlyPayload.completionAudit.status, "blocked");
    const devOnlyPlan = devOnlyPayload.decisionPlanProjection;
    assert.equal(devOnlyPlan.primaryBlockerCode, "finalization-claim-blocked");
    assert.equal(devOnlyPlan.capabilities["parent-final-answer"], "blocked");
    assert.equal(devOnlyPlan.parentDisposition.kind, "block-final-answer");
    assert.ok(devOnlyPlan.requiredEvidence.diagnosticCodes.includes("finalization-claim-blocked"));

    const noEvidenceDir = path.join(dir, "no-evidence");
    await mkdir(noEvidenceDir, { recursive: true });
    await setupFixture(noEvidenceDir, {
      name: "No evidence loop",
      goal: "Do not complete without evidence",
      metricName: "score",
      direction: "higher",
      acceptedContract: true,
      benchmarkCommand: scoreFileBenchmark,
      checksCommand: passingChecks,
    });
    const prematurePayload = await readGoalBrief(noEvidenceDir, [
      "--codex-goal-status",
      "active",
      "--completion-confirmed",
      "--completion-evidence",
      "Looks done",
    ]);
    assert.equal(prematurePayload.completionAudit.canMarkCodexGoalComplete, false);
    assert.notEqual(prematurePayload.completionAudit.status, "complete");
    const enforcedPremature = await runCli([
      "codex-goal-brief",
      "--cwd",
      noEvidenceDir,
      "--codex-goal-status",
      "active",
      "--completion-confirmed",
      "--completion-evidence",
      "Looks done",
      "--enforce-completion",
    ]);
    assert.notEqual(enforcedPremature.code, 0);
    assert.match(enforcedPremature.stderr, /codex_goal_completion_blocked/i);

    const promotionDir = path.join(dir, "promotion-evidence");
    await mkdir(promotionDir, { recursive: true });
    await setupFixture(promotionDir, {
      name: "Promotion evidence loop",
      goal: "Complete only against an imported Codex Goal",
      metricName: "score",
      direction: "higher",
      completeContract: true,
      benchmarkCommand: scoreFileBenchmark,
      checksCommand: passingChecks,
    });
    const promotionConfigPath = path.join(promotionDir, "autoresearch.config.json");
    const promotionConfig = JSON.parse(await readFile(promotionConfigPath, "utf8"));
    await writeFile(
      promotionConfigPath,
      `${JSON.stringify(
        {
          ...promotionConfig,
          checksAuthoritative: true,
          holdoutCommand: "echo holdout",
          noiseModel: { kind: "deterministic" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const acceptedPromotion = await runCli([
      "new-segment",
      "--cwd",
      promotionDir,
      "--reason",
      "Accept the promotion fixture contract",
      "--yes",
    ]);
    assert.equal(acceptedPromotion.code, 0, acceptedPromotion.stderr);
    await logScoreBaseline(promotionDir, 0.5);
    await logKeptScoreCandidate(promotionDir, 0.8, "Promotion-grade result", [
      "--metrics",
      JSON.stringify({ promotionGrade: true }),
    ]);
    const unimportedPayload = await readGoalBrief(promotionDir, [
      "--completion-confirmed",
      "--completion-evidence",
      "Promotion-grade result satisfies the objective",
    ]);
    assert.equal(unimportedPayload.completionAudit.status, "no_codex_goal_imported");
    assert.equal(unimportedPayload.completionAudit.canMarkCodexGoalComplete, false);

    const importedPayload = await readGoalBrief(promotionDir, [
      "--codex-goal-status",
      "active",
      "--completion-confirmed",
      "--completion-evidence",
      "Promotion-grade result satisfies the objective",
    ]);
    assert.equal(importedPayload.completionAudit.status, "blocked");
    assert.equal(importedPayload.completionAudit.canMarkCodexGoalComplete, false);
    assert.equal(importedPayload.canMarkCodexGoalComplete, false);
    const importedPlan = importedPayload.decisionPlanProjection;
    assert.equal(importedPlan.primaryBlockerCode, "finalization-claim-blocked");
    assert.equal(importedPlan.capabilities["parent-final-answer"], "blocked");
    assert.equal(importedPlan.parentDisposition.kind, "block-final-answer");
    assert.ok(importedPlan.requiredEvidence.diagnosticCodes.includes("finalization-claim-blocked"));

    const lint = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--metric-name",
      "score",
      "--sample",
      "METRIC score=4.2",
    ]);
    assert.equal(lint.code, 0, lint.stderr);
    const lintPayload = JSON.parse(lint.stdout);
    assert.equal(lintPayload.ok, true);
    assert.equal(lintPayload.parsedMetrics.score, 4.2);

    const inspect = await runCli(["benchmark-inspect", "--cwd", dir]);
    assert.equal(inspect.code, 0, inspect.stderr);
    const inspectPayload = JSON.parse(inspect.stdout);
    assert.equal(inspectPayload.ranCommand, false);
    assert.match(inspectPayload.hints.join("\n"), /METRIC score=<number>/);

    const checksInspect = await runCli([
      "checks-inspect",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} -e "process.exit(0)"`,
    ]);
    assert.equal(checksInspect.code, 0, checksInspect.stderr);
    const checksInspectPayload = JSON.parse(checksInspect.stdout);
    assert.equal(checksInspectPayload.ranCommand, true);
    assert.equal(checksInspectPayload.ok, true);
    assert.match(checksInspectPayload.hints.join("\n"), /Cargo/);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.ok, true);
    const recommendPlan = recommendPayload.decisionPlanProjection;
    assert.equal(recommendPlan.decisionId, compactPlan.decisionId);
    assert.equal(recommendPlan.action.kind, compactPlan.action.kind);
    assert.equal(recommendPlan.capabilities["run-packet"], "allowed");
    assert.ok(recommendPlan.requiredEvidence.diagnosticCodes.includes("finalization-blocked"));

    const onboarding = await runCli(["onboarding-packet", "--cwd", dir, "--compact"]);
    assert.equal(onboarding.code, 0, onboarding.stderr);
    const onboardingPayload = JSON.parse(onboarding.stdout);
    assert.equal(onboardingPayload.kind, "codex-autoresearch-onboarding-packet");
    assert.ok(onboardingPayload.templates.firstResponse);
    assert.equal(onboardingPayload.decisionPlanProjection.decisionId, compactPlan.decisionId);

    const promptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      [
        "Use $Codex Autoresearch to optimize my unit tests' speed.",
        "Benchmark: node -e \"console.log('METRIC seconds=1')\"",
        "Metric: seconds, lower is better",
        'Checks: node -e "process.exit(0)"',
        "Scope: test runner config and test helpers only",
      ].join("\n"),
    ]);
    assert.equal(promptPlan.code, 0, promptPlan.stderr);
    const promptPayload = JSON.parse(promptPlan.stdout);
    assert.equal(promptPayload.kind, "codex-autoresearch-prompt-plan");
    assert.equal(promptPayload.fit.disposition, "continue-direct");
    assert.equal("intent" in promptPayload, false);
    assert.equal("setup" in promptPayload, false);

    const compositePromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Optimize a composite score: 0.7 quality + 0.2 speed + 0.1 memory.",
    ]);
    assert.equal(compositePromptPlan.code, 0, compositePromptPlan.stderr);
    const compositePayload = JSON.parse(compositePromptPlan.stdout);
    assert.equal(compositePayload.fit.disposition, "continue-direct");

    await writeFile(
      path.join(dir, "Cargo.toml"),
      [
        "[package]",
        'name = "bench-target"',
        'version = "0.1.0"',
        "",
        "[[bench]]",
        'name = "criterion_score"',
        "harness = false",
        "",
      ].join("\n"),
    );
    const cargoPromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Optimize the Cargo criterion benchmark performance score.",
    ]);
    assert.equal(cargoPromptPlan.code, 0, cargoPromptPlan.stderr);
    const cargoPayload = JSON.parse(cargoPromptPlan.stdout);
    assert.equal(cargoPayload.fit.disposition, "continue-direct");
    await rm(path.join(dir, "Cargo.toml"), { force: true });

    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(
      path.join(dir, "scripts", "semantic-domain-benchmark.mjs"),
      "console.log('METRIC semantic_score=0.5')\n",
    );
    const domainPromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Start a new Autoresearch session for the semantic domain benchmark.",
    ]);
    assert.equal(domainPromptPlan.code, 0, domainPromptPlan.stderr);
    const domainPayload = JSON.parse(domainPromptPlan.stdout);
    assert.equal(domainPayload.fit.disposition, "continue-direct");

    await writeFile(
      path.join(dir, "scripts", "autoresearch-indexer-embedder-pipeline.mjs"),
      "console.log('METRIC pipeline_score=123')\nconsole.log('METRIC quality_component=1')\n",
    );
    const pipelinePromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Start a new Codex Autoresearch session to improve the performance of the parse + index + embed pipeline.",
    ]);
    assert.equal(pipelinePromptPlan.code, 0, pipelinePromptPlan.stderr);
    const pipelinePayload = JSON.parse(pipelinePromptPlan.stdout);
    assert.equal(pipelinePayload.fit.disposition, "continue-direct");

    await writeFile(
      path.join(dir, "scripts", "cross-repo-promotion-benchmark.mjs"),
      "console.log('METRIC cross_repo_score=0.9')\n",
    );
    const frictionPromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Eliminate user and AI friction in a skill-first manual E2E flow. Use quality_gap as the primary metric and a deterministic manual-test harness.",
    ]);
    assert.equal(frictionPromptPlan.code, 0, frictionPromptPlan.stderr);
    const frictionPayload = JSON.parse(frictionPromptPlan.stdout);
    assert.equal(frictionPayload.fit.disposition, "continue-direct");

    for (const qualitativePrompt of [
      "Deepen security evidence hygiene around redaction, token handling, and stack trace leaks.",
      "Study release readiness and the release path for version drift, CI guards, and tarball smoke confidence.",
      "Improve dashboard UX and operator UX so the readout makes the next safe action obvious without live mutation controls.",
    ]) {
      const qualitativePlan = await runCli([
        "prompt-plan",
        "--cwd",
        dir,
        "--prompt",
        qualitativePrompt,
      ]);
      assert.equal(qualitativePlan.code, 0, qualitativePlan.stderr);
      const qualitativePayload = JSON.parse(qualitativePlan.stdout);
      assert.equal(qualitativePayload.fit.disposition, "continue-direct");
    }

    const explicitMeasuredPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      [
        "Improve release smoke latency without changing release semantics.",
        "Benchmark: node -e \"console.log('METRIC seconds=2')\"",
        "Metric: seconds, lower is better",
        "Scope: .github/workflows/release.yml",
      ].join("\n"),
    ]);
    assert.equal(explicitMeasuredPlan.code, 0, explicitMeasuredPlan.stderr);
    const explicitMeasuredPayload = JSON.parse(explicitMeasuredPlan.stdout);
    assert.equal(explicitMeasuredPayload.fit.disposition, "continue-direct");

    const broadPromptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Use $Codex Autoresearch to keep reducing bugs in the codebase, starting with the most obvious low hanging fruits. Keep doing this 100 times.",
    ]);
    assert.equal(broadPromptPlan.code, 0, broadPromptPlan.stderr);
    const broadPayload = JSON.parse(broadPromptPlan.stdout);
    assert.equal(broadPayload.fit.disposition, "continue-direct");

    const hooks = await runCli(["doctor", "hooks", "--cwd", dir]);
    assert.equal(hooks.code, 0, hooks.stderr);
    const hooksPayload = JSON.parse(hooks.stdout);
    assert.equal(hooksPayload.defaultEnabled, false);
    assert.ok(Array.isArray(hooksPayload.limitations));

    const dryRun = await runCli(["new-segment", "--cwd", dir, "--dry-run"]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).dryRun, true);

    const segment = await runCli(["new-segment", "--cwd", dir, "--reason", "fresh phase", "--yes"]);
    assert.equal(segment.code, 0, segment.stderr);
    const segmentPayload = JSON.parse(segment.stdout);
    assert.equal(segmentPayload.nextSegment, 1);

    const promote = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "larger sample",
      "--query-count",
      "25",
      "--dry-run",
    ]);
    assert.equal(promote.code, 0, promote.stderr);
    const promotePayload = JSON.parse(promote.stdout);
    assert.equal(promotePayload.entry.measurementGate.queryCount, 25);

    const after = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(after.code, 0, after.stderr);
    const afterPayload = JSON.parse(after.stdout);
    assert.equal(afterPayload.segment, 1);
    assert.equal(afterPayload.runs, 0);
    const afterPlan = afterPayload.decisionPlanProjection;
    assert.equal(afterPlan.action.kind, "direct-work");
    assert.equal(afterPlan.capabilities["run-packet"], "allowed");
    assert.equal(afterPlan.loopDisposition.kind, "continue");
    assert.equal(afterPlan.parentDisposition.kind, "hand-back");
    assert.ok(afterPlan.requiredEvidence.diagnosticCodes.includes("finalization-blocked"));
  });
});

test("CLI exposes onboarding, prompt planning, benchmark probes, recommend-next, and segment tools", async () => {
  await withTempDir("cli-delight-tools", async (dir) => {
    await setupFixture(dir, {
      name: "cli delight",
      metricName: "score",
      acceptedContract: true,
      benchmarkCommand: scoreFileBenchmark,
      checksCommand: passingChecks,
    });
    await logScoreBaseline(dir, 3, "Baseline");

    const onboarding = await runCli(["onboarding-packet", "--cwd", dir, "--compact"]);
    assert.equal(onboarding.code, 0, onboarding.stderr);
    assert.match(onboarding.stdout, /codex-autoresearch-onboarding-packet/);

    const promptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Use $Codex Autoresearch to figure out why p99 latency is so much higher than p90. I suspect: DNS lookup, event loop throttling, memory spike, CPU spike. Use @experiments.md.",
    ]);
    assert.equal(promptPlan.code, 0, promptPlan.stderr);
    assert.match(promptPlan.stdout, /"disposition": "continue-direct"/);
    assert.doesNotMatch(promptPlan.stdout, /p99_p90_ratio/);

    const lint = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--metric-name",
      "score",
      "--sample",
      "METRIC score=2",
    ]);
    assert.equal(lint.code, 0, lint.stderr);
    assert.match(lint.stdout, /"emitsPrimary": true/);

    const inspect = await runCli(["benchmark-inspect", "--cwd", dir]);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.match(inspect.stdout, /benchmark-native list/);

    const checksInspect = await runCli(["checks-inspect", "--cwd", dir]);
    assert.equal(checksInspect.code, 0, checksInspect.stderr);
    assert.match(checksInspect.stdout, /correctness command/);

    const next = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    const nextPlan = nextPayload.decisionPlanProjection;
    assert.equal(nextPlan.kind, "decision-plan-projection");
    assert.equal(nextPlan.action.kind, "direct-work");
    assert.equal(nextPlan.capabilities["run-packet"], "allowed");
    assert.equal(nextPlan.capabilities.finalize, "blocked");
    assert.equal(nextPlan.loopDisposition.kind, "continue");
    assert.equal(nextPlan.parentDisposition.kind, "hand-back");
    assert.ok(nextPlan.requiredEvidence.diagnosticCodes.includes("finalization-blocked"));

    const dryRun = await runCli(["new-segment", "--cwd", dir, "--dry-run"]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /"dryRun": true/);

    const promote = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "larger gate",
      "--query-count",
      "20",
      "--dry-run",
    ]);
    assert.equal(promote.code, 0, promote.stderr);
    assert.match(promote.stdout, /"queryCount": 20/);
  });
});

test("quality-gap recipe benchmarks through the plugin CLI", async () => {
  await withTempDir("quality-gap-recipe", async (dir) => {
    const researchDir = path.join(dir, "autoresearch.research", "research");
    await mkdir(researchDir, { recursive: true });
    await writeFile(path.join(researchDir, "quality-gaps.md"), "- [ ] Existing gap\n");

    const setup = await runCli(["setup", "--cwd", dir, "--recipe", "quality-gap"]);
    assert.equal(setup.code, 0, setup.stderr);
    const setupPayload = JSON.parse(setup.stdout);
    assert.equal(setupPayload.init.config.metricName, "quality_gap");

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
  });
});

test("quality-gap auto-detects the active research slug for JSON output", async () => {
  await withTempDir("quality-gap-autodetect", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "Delight Study",
      "--goal",
      "Study project delight",
    ]);
    const gapsPath = path.join(dir, "autoresearch.research", "delight-study", "quality-gaps.md");
    await writeFile(gapsPath, "- [ ] Open delight gap\n- [x] Closed delight gap\n", "utf8");

    const result = await runCli(["quality-gap", "--cwd", dir, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.slug, "delight-study");
    assert.equal(payload.open, 2);
    assert.deepEqual(payload.openItems, ["Open delight gap", "Closed delight gap"]);
    assert.deepEqual(payload.legacyProvisionalClosed, ["Closed delight gap"]);
  });
});

test("gap-candidates extracts, dedupes, applies, and rejects malformed model output", async () => {
  await withTempDir("gap-candidates", async (dir) => {
    await runCli(["research-setup", "--cwd", dir, "--slug", "study", "--goal", "Study delight"]);
    const synthesisPath = path.join(dir, "autoresearch.research", "study", "synthesis.md");
    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Build a guided setup flow with recipe suggestions.",
        "- Build a guided setup flow with recipe suggestions.",
        "",
      ].join("\n"),
    );

    const preview = await runCli(["gap-candidates", "--cwd", dir, "--research-slug", "study"]);
    assert.equal(preview.code, 0, preview.stderr);
    const previewPayload = JSON.parse(preview.stdout);
    assert.equal(previewPayload.candidates.length, 1);
    assert.equal(previewPayload.applied, false);
    assert.equal(previewPayload.roundGuidance.unit, "research-round");
    assert.match(previewPayload.roundGuidance.metricScope, /raw checked boxes remain provisional/);
    assert.match(previewPayload.roundGuidance.requiredRefresh, /rerun the project-study prompt/);
    assert.ok(
      previewPayload.roundGuidance.hallucinationFilter.some((item) => /validation path/.test(item)),
    );
    assert.match(previewPayload.roundGuidance.stopRule, /fresh research round/);

    const applied = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--apply",
    ]);
    assert.equal(applied.code, 0, applied.stderr);
    const appliedPayload = JSON.parse(applied.stdout);
    assert.equal(appliedPayload.applied, true);
    assert.equal(appliedPayload.qualityGap.total, 1);
    assert.equal(appliedPayload.qualityGap.researchReadiness.total, 6);

    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Build a guided setup flow with recipe suggestions.",
        "- Add a resume cockpit that explains the exact next operator action.",
        "",
      ].join("\n"),
    );
    const reapplied = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--apply",
    ]);
    assert.equal(reapplied.code, 0, reapplied.stderr);
    const reappliedPayload = JSON.parse(reapplied.stdout);
    assert.equal(reappliedPayload.qualityGap.total, 2);
    const gaps = await readFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      "utf8",
    );
    assert.equal((gaps.match(/## Candidate Gaps/g) || []).length, 1);
    assert.equal((gaps.match(/<!-- codex-autoresearch:generated-candidates -->/g) || []).length, 1);
    assert.match(gaps, /resume cockpit/);
    assert.match(gaps, /guided setup flow/);

    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Add a resume cockpit that explains the exact next operator action.",
        "",
      ].join("\n"),
    );
    const refreshed = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--apply",
    ]);
    assert.equal(refreshed.code, 0, refreshed.stderr);
    const refreshedPayload = JSON.parse(refreshed.stdout);
    assert.equal(refreshedPayload.qualityGap.total, 1);
    const refreshedGaps = await readFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      "utf8",
    );
    assert.equal((refreshedGaps.match(/## Candidate Gaps/g) || []).length, 1);
    assert.match(refreshedGaps, /resume cockpit/);
    assert.doesNotMatch(refreshedGaps, /guided setup flow/);

    await writeFile(synthesisPath, "# Research Synthesis\n\n## High-Impact Findings\n\n");
    const cleared = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--apply",
    ]);
    assert.equal(cleared.code, 0, cleared.stderr);
    const clearedPayload = JSON.parse(cleared.stdout);
    assert.equal(clearedPayload.qualityGap.total, 0);
    assert.equal(clearedPayload.qualityGap.researchReadiness.total, 6);
    const clearedGaps = await readFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      "utf8",
    );
    assert.doesNotMatch(clearedGaps, /## Candidate Gaps/);

    await writeFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      [
        "# Quality Gaps",
        "",
        "- [x] Build a guided setup flow with recipe suggestions. Evidence: implemented in round 1.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Build a guided setup flow with recipe suggestions.",
        "",
      ].join("\n"),
    );
    const decisionTarget = await runCli([
      "quality-gap",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--list",
    ]);
    assert.equal(decisionTarget.code, 0, decisionTarget.stderr);
    const [closedGap] = JSON.parse(decisionTarget.stdout).gaps;
    const decision = await runCli([
      "gap-decide",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--gap-id",
      closedGap.id,
      "--decision",
      "implemented",
      "--evidence",
      "round-1 implementation commit",
      "--validation",
      "guided setup acceptance passed",
    ]);
    assert.equal(decision.code, 0, decision.stderr);
    const closedDuplicate = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
    ]);
    assert.equal(closedDuplicate.code, 0, closedDuplicate.stderr);
    const closedDuplicatePayload = JSON.parse(closedDuplicate.stdout);
    assert.equal(closedDuplicatePayload.candidates.length, 0);
    assert.equal(closedDuplicatePayload.stopRecommended, true);
    assert.equal(closedDuplicatePayload.stopStatus.researchExhausted, true);
    assert.equal(closedDuplicatePayload.stopStatus.requiresPassingChecks, true);

    await writeFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      ["# Quality Gaps", "", "- [x] Build an Evidence: ledger for accepted gaps.", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      synthesisPath,
      [
        "# Research Synthesis",
        "",
        "## High-Impact Findings",
        "- Build an Evidence: panel for candidate provenance.",
        "",
      ].join("\n"),
    );
    const evidenceTitle = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
    ]);
    assert.equal(evidenceTitle.code, 0, evidenceTitle.stderr);
    const evidenceTitlePayload = JSON.parse(evidenceTitle.stdout);
    assert.equal(evidenceTitlePayload.candidates.length, 1);
    assert.equal(evidenceTitlePayload.stopRecommended, false);

    const badModel = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--model-command",
      `${quoteForShell(process.execPath)} -e "console.log('not json')"`,
    ]);
    assert.notEqual(badModel.code, 0);
    assert.match(badModel.stderr, /model-command must print a JSON array/);

    const timedOutModel = await runCli([
      "gap-candidates",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--model-command",
      `${quoteForShell(process.execPath)} -e "setTimeout(() => {}, 2000)"`,
      "--model-timeout-seconds",
      "1",
    ]);
    assert.notEqual(timedOutModel.code, 0);
    assert.match(timedOutModel.stderr, /model-command failed \(timed out\)/);
  });
});
