import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  approvalRecordsFromLedger,
  buildApprovalLedgerStatus,
  buildApprovalRecord,
  resolveApproval,
} from "../lib/approval-ledger.js";
import { classifyEvidenceMaturity } from "../lib/evidence-maturity.js";
import { registryPathForWorkDir } from "../lib/dashboard-server-registry.js";
import {
  fixedControlStateSummary,
  fixedControlViolationForCommand,
  normalizeFixedControlConfig,
} from "../lib/fixed-control.js";
import { classifyFinalizationRunwayFromFacts } from "../lib/finalization-runway.js";
import { buildGoalContract } from "../lib/goal-frame.js";
import { planFailureRecoveryLanes } from "../lib/lane-orchestration-controller.js";
import { buildLoopContractStatus } from "../lib/loop-governance.js";
import { buildOperatorReadout } from "../lib/operator-readout.js";
import { buildResourcePreflight } from "../lib/process-governor.js";
import { resolveSafeResearchPath } from "../lib/research-path-guard.js";
import { appendJsonl, jsonlPath, ledgerRecordIssue, readJsonl } from "../lib/session-records.js";
import { parseSessionForensics } from "../lib/session-forensics.js";
import { resolveSessionPaths } from "../lib/session-paths.js";
import {
  codeStoryLanguageSupportFrictionFixtureEntries,
  fixtureJsonl,
  session019eb85aControlPlaneFixtureEntries,
} from "./helpers/session-forensics-fixtures.js";
import { withTempDir as withNamedTempDir } from "./helpers/process.js";

const withTempDir = (name: string, fn: (dir: string) => Promise<void>) =>
  withNamedTempDir("autoresearch-control-plane", name, fn);

test("session path resolver preserves repo-local defaults", async () => {
  await withTempDir("session-paths-repo-defaults", async (dir) => {
    const sessionCwd = path.join(dir, "session-cwd");
    const workDir = path.join(dir, "target");
    const paths = resolveSessionPaths({ sessionCwd, workDir });

    assert.equal(paths.mode, "repo");
    assert.equal(paths.targetCwd, path.resolve(workDir));
    assert.equal(paths.sessionCwd, path.resolve(sessionCwd));
    assert.equal(paths.sessionDir, path.resolve(workDir));
    assert.equal(paths.ledgerPath, path.join(workDir, "autoresearch.jsonl"));
    assert.equal(paths.configPath, path.join(sessionCwd, "autoresearch.config.json"));
    assert.equal(paths.notesPath, path.join(workDir, "autoresearch.md"));
    assert.equal(paths.ideasPath, path.join(workDir, "autoresearch.ideas.md"));
    assert.equal(paths.researchRoot, path.join(workDir, "autoresearch.research"));
    assert.equal(paths.dashboardExportPath, path.join(workDir, "autoresearch-dashboard.html"));
    assert.equal(paths.lastRunFallbackPath, path.join(workDir, "autoresearch.last-run.json"));
    assert.equal(paths.progressFallbackPath, path.join(workDir, "autoresearch.progress.json"));
    assert.equal(
      paths.pendingLogTransactionFallbackPath,
      path.join(workDir, "autoresearch.pending-transaction.json"),
    );
    assert.ok(paths.clearTargets.includes(path.join(workDir, "autoresearch.config.json")));
    assert.ok(paths.clearTargets.includes(path.join(workDir, "autoresearch.progress.json")));
    assert.ok(paths.clearTargets.includes(path.join(sessionCwd, "autoresearch.config.json")));
  });
});

test("session record ledger helpers use the repo-local resolver path", async () => {
  await withTempDir("session-paths-ledger", async (dir) => {
    const paths = resolveSessionPaths({ workDir: dir });

    assert.equal(jsonlPath(dir), paths.ledgerPath);
    appendJsonl(dir, { type: "config", metricName: "score", bestDirection: "higher" });

    assert.deepEqual(readJsonl(dir), [
      { type: "config", metricName: "score", bestDirection: "higher" },
    ]);
  });
});

test("session record boundary rejects every JSON primitive with physical line evidence", async () => {
  const invalidValues = [
    { value: "null", kind: "null", position: 0 },
    { value: "[]", kind: "array", position: 1 },
    { value: '"text"', kind: "string", position: 2 },
    { value: "42", kind: "number", position: 0 },
    { value: "true", kind: "boolean", position: 1 },
    { value: "false", kind: "boolean", position: 2 },
  ];
  await withTempDir("session-record-shapes", async (dir) => {
    const ledgerPath = jsonlPath(dir);
    const valid = JSON.stringify({ type: "config", metricName: "score" });
    for (const invalid of invalidValues) {
      const lines = [valid, valid, valid];
      lines[invalid.position] = invalid.value;
      if (invalid.kind === "string") lines.splice(2, 0, "");
      await writeFile(ledgerPath, `${lines.join("\n")}\n`);
      const expectedLine = invalid.position + 1 + (invalid.kind === "string" ? 1 : 0);
      assert.throws(
        () => readJsonl(dir),
        (error) => {
          const issue = ledgerRecordIssue(error);
          assert.ok(issue);
          assert.equal(issue.file, ledgerPath);
          assert.equal(issue.line, expectedLine);
          assert.equal(issue.kind, invalid.kind);
          assert.match(issue.message, /Expected a non-array JSON object ledger record/);
          assert.match(issue.command, /ledger-doctor --cwd <project> --json/);
          return true;
        },
      );
    }

    await writeFile(ledgerPath, `${valid}\n\n{malformed\n`);
    assert.throws(
      () => readJsonl(dir),
      (error) => {
        const issue = ledgerRecordIssue(error);
        assert.ok(issue);
        assert.equal(issue.file, ledgerPath);
        assert.equal(issue.line, 3);
        assert.equal(issue.kind, "invalid-json");
        assert.match(issue.message, /Invalid JSON syntax/);
        assert.equal(
          issue.command,
          "node scripts/autoresearch.mjs ledger-doctor --cwd <project> --json",
        );
        return true;
      },
    );
  });
});

test("session record boundary accepts legacy objects and validates declared schema versions", async () => {
  await withTempDir("session-record-schema", async (dir) => {
    await writeFile(
      jsonlPath(dir),
      [
        JSON.stringify({ type: "config", metricName: "score" }),
        JSON.stringify({ type: "run", run: 1, schemaVersion: 1 }),
        "",
      ].join("\n"),
    );
    assert.equal(readJsonl(dir).length, 2);

    await writeFile(jsonlPath(dir), `${JSON.stringify({ type: "run", schemaVersion: 2 })}\n`);
    assert.throws(
      () => readJsonl(dir),
      /Unsupported schemaVersion; expected 1.*Observed JSON kind: object.*ledger-doctor/,
    );
  });
});

test("research path guard roots scratchpads through the repo-local resolver", async () => {
  await withTempDir("session-paths-research", async (dir) => {
    const paths = resolveSessionPaths({ workDir: dir });
    const researchPath = await resolveSafeResearchPath(dir, "project-study");

    assert.equal(researchPath.root, paths.researchRoot);
    assert.equal(researchPath.outputDir, path.join(paths.researchRoot, "project-study"));
  });
});

test("dashboard serve registry keeps Git-private storage and uses repo-local fallback", async () => {
  await withTempDir("session-paths-dashboard-registry", async (dir) => {
    const nonGit = path.join(dir, "plain");
    const gitRepo = path.join(dir, "repo");
    await mkdir(nonGit, { recursive: true });
    await mkdir(path.join(gitRepo, ".git"), { recursive: true });

    assert.equal(
      registryPathForWorkDir(nonGit),
      path.join(
        resolveSessionPaths({ workDir: nonGit }).researchRoot,
        ".runtime",
        "serve-registry.json",
      ),
    );
    assert.equal(
      registryPathForWorkDir(gitRepo),
      path.join(gitRepo, ".git", "autoresearch", "serve-registry.json"),
    );
  });
});

test("fixed control config normalizes command patterns and invalidators", () => {
  const fixedControl = normalizeFixedControlConfig({
    artifact: "target/control/no-codestory.json",
    reason: "Reuse the no-CodeStory control from the first baseline.",
    validUntilChanged: ["benchmarks/language-support.mjs"],
    forbiddenCommandPatterns: ["--mode no-codestory", "NO_CODESTORY=1"],
    reuseCommandHint: "node scripts/score-existing-control.mjs target/control/no-codestory.json",
  });

  assert.deepEqual(fixedControl, {
    artifact: "target/control/no-codestory.json",
    reason: "Reuse the no-CodeStory control from the first baseline.",
    validUntilChanged: ["benchmarks/language-support.mjs"],
    forbiddenCommandPatterns: ["--mode no-codestory", "NO_CODESTORY=1"],
    reuseCommandHint: "node scripts/score-existing-control.mjs target/control/no-codestory.json",
  });
});

test("fixed control guard blocks forbidden rerun commands", () => {
  const violation = fixedControlViolationForCommand(
    "node bench.mjs --mode no-codestory",
    normalizeFixedControlConfig({
      artifact: "target/control/no-codestory.json",
      reason: "Reuse control",
      forbiddenCommandPatterns: ["--mode no-codestory"],
    }),
  );

  assert.equal(violation?.code, "fixed_control_rerun_blocked");
  assert.match(violation?.message || "", /target\/control\/no-codestory\.json/);
});

test("fixed control state summary bounds arrays strings and command hints", () => {
  const secret = "sk-fixed-control-secret-123";
  const summary = fixedControlStateSummary(
    normalizeFixedControlConfig({
      artifact: "target/control/no-codestory.json",
      reason: "r".repeat(500),
      validUntilChanged: Array.from({ length: 14 }, (_, index) => `benchmarks/${index}.mjs`),
      forbiddenCommandPatterns: Array.from(
        { length: 16 },
        (_, index) => `--mode no-codestory-${index} --token=${secret}`,
      ),
      reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs ${"x".repeat(500)}`,
    }),
  );

  assert.ok(summary);
  assert.equal(summary.reason.length <= 240, true);
  assert.equal(summary.validUntilChanged.length, 10);
  assert.equal(summary.forbiddenCommandPatterns.length, 10);
  assert.equal(summary.reuseCommandHint.length <= 240, true);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(secret));
  assert.equal(summary.truncated, true);
  assert.equal(summary.truncation.reasonChars, 260);
  assert.equal(summary.truncation.validUntilChanged, 4);
  assert.equal(summary.truncation.forbiddenCommandPatterns, 6);
  assert.equal(summary.truncation.reuseCommandHintChars > 0, true);
});

test("goal contract blocks mismatched broad work and guides missing Codex objective recovery", () => {
  const missing = buildGoalContract({
    autoresearchGoal: "Improve Autoresearch finalization safety.",
    benchmarkGoal: "Improve Autoresearch finalization safety.",
  });

  assert.equal(missing.status, "warning");
  assert.equal(missing.blocksPacket, false);
  assert.match(missing.warnings[0], /No live Codex goal objective/);
  assert.match(missing.recoveryCommand, /codex-goal-brief/);

  const mismatch = buildGoalContract({
    autoresearchGoal: "Improve Autoresearch finalization safety.",
    codexGoalObjective: "Please execute the spec to completion.",
    benchmarkGoal: "Improve Autoresearch finalization safety.",
    finalizationClaim: "Ship a better dashboard.",
  });

  assert.equal(mismatch.status, "blocked");
  assert.equal(mismatch.blocksPacket, true);
  assert.equal(mismatch.blocksFinalization, true);
  assert.match(mismatch.blockers.join(" "), /Codex prompt|Finalization claim/);
});

test("approval ledger requires exact unexpired scoped approvals", () => {
  const approved = buildApprovalRecord({
    gate: "big_idea_architecture",
    scope: "lane-a",
    source: "test",
    timestamp: "2026-06-12T10:00:00.000Z",
    expiresAt: "2026-06-13T10:00:00.000Z",
    evidence: ["user approved lane-a"],
  });
  const expired = buildApprovalRecord({
    gate: "big_idea_architecture",
    scope: "lane-b",
    timestamp: "2026-06-10T10:00:00.000Z",
    expiresAt: "2026-06-11T10:00:00.000Z",
  });
  const records = approvalRecordsFromLedger([approved, expired]);

  assert.equal(
    resolveApproval(
      records,
      { gate: "big_idea_architecture", scope: "lane-a" },
      {
        now: "2026-06-12T12:00:00.000Z",
      },
    ).approved,
    true,
  );
  assert.equal(
    resolveApproval(
      records,
      { gate: "big_idea_architecture", scope: "lane-b" },
      {
        now: "2026-06-12T12:00:00.000Z",
      },
    ).status,
    "expired",
  );
  assert.equal(
    resolveApproval(records, { gate: "big_idea_architecture", scope: "lane-c" }).status,
    "missing",
  );

  const status = buildApprovalLedgerStatus({
    entries: records,
    required: [{ gate: "big_idea_architecture", scope: "lane-c" }],
  });
  assert.equal(status.status, "blocked");
  assert.match(status.blockers[0], /lane-c/);
});

test("resource preflight catches stale process residue, repeated commands, and output budgets", () => {
  const preflight = buildResourcePreflight({
    command: "rg -n needle src tests",
    entries: [
      { command: "rg -n needle src tests" },
      { command: "rg -n needle src tests" },
      { command: "rg -n needle src tests" },
      { command: "rg -n needle src tests" },
      { command: "rg -n needle src tests" },
      { type: "process_manager", status: "stale", pid: 1234, reason: "reboot residue" },
      { packetEvidence: { outputTokens: 30000, outputLines: 1500 } },
    ],
    budgets: {
      maxRepeatedCommandHeads: 5,
      maxCommandOutputTokens: 24000,
      maxCommandOutputLines: 1200,
    },
  });

  assert.equal(preflight.canStart, false);
  assert.match(preflight.blockers.join(" "), /Command head repeated|Stale process-manager/);
  assert.match(preflight.warnings.join(" "), /bounded summaries|compact forensics/);
});

test("resource preflight treats repeated benchmark command heads as warnings", () => {
  const preflight = buildResourcePreflight({
    command: "node scripts/benchmark.mjs --suite smoke",
    entries: Array.from({ length: 5 }, () => ({
      command: "node scripts/benchmark.mjs --suite smoke",
    })),
    budgets: { maxRepeatedCommandHeads: 5 },
  });

  assert.equal(preflight.canStart, true);
  assert.equal(preflight.status, "warning");
  assert.equal(
    preflight.blockers.some((item) => /Command head repeated/.test(item)),
    false,
  );
  assert.match(preflight.warnings.join(" "), /Command head repeated 5 times/);
});

test("resource preflight residue does not echo raw ledger bodies", () => {
  const preflight = buildResourcePreflight({
    entries: [
      {
        type: "response_item",
        timestamp: "2026-06-13T12:00:00.000Z",
        payload: {
          output: "pid 1234 stale reboot residue SECRET_TOKEN=abc123 C:/Users/alber/private.env",
        },
      },
    ],
  });

  assert.equal(preflight.canStart, false);
  assert.equal(preflight.residue.length, 1);
  assert.deepEqual(preflight.residue[0], {
    type: "response_item",
    status: "stale-process-residue",
    timestamp: "2026-06-13T12:00:00.000Z",
    reason: "ledger entry matched process residue keywords",
  });
  assert.doesNotMatch(JSON.stringify(preflight.residue), /SECRET_TOKEN|private\.env|abc123/);
});

test("resource preflight residue redacts unsafe ledger metadata", () => {
  const preflight = buildResourcePreflight({
    entries: [
      {
        type: "response_item SECRET_TOKEN=abc123",
        timestamp: "C:/Users/alber/private.env",
        payload: {
          output: "pid 4321 stale reboot residue",
        },
      },
    ],
  });

  assert.equal(preflight.canStart, false);
  assert.deepEqual(preflight.residue, [
    {
      type: "ledger-entry",
      status: "stale-process-residue",
      timestamp: "",
      reason: "ledger entry matched process residue keywords",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(preflight.residue),
    /SECRET_TOKEN|abc123|C:\/Users\/alber\/private\.env/,
  );
});

test("resource preflight residue maps token-shaped ledger types to generic entries", () => {
  const preflight = buildResourcePreflight({
    entries: [
      {
        type: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        status: "stale-process-residue",
        timestamp: "2026-06-13T12:00:00Z",
        reason: "ledger entry matched process residue keywords",
        payload: {
          output: "process_manager stale reboot residue",
        },
      },
      {
        type: "AKIAIOSFODNN7EXAMPLE",
        status: "stale-process-residue",
        timestamp: "",
        reason: "ledger entry matched process residue keywords",
        payload: {
          output: "process_manager stale reboot residue",
        },
      },
    ],
  });

  const serializedResidue = JSON.stringify(preflight.residue);

  assert.equal(preflight.canStart, false);
  assert.deepEqual(
    preflight.residue.map((fact) => fact.type),
    ["ledger-entry", "ledger-entry"],
  );
  assert.doesNotMatch(
    serializedResidue,
    /ghp_abcdefghijklmnopqrstuvwxyz1234567890|AKIAIOSFODNN7EXAMPLE/,
  );
});

test("evidence maturity downgrades row-specific wins until broad proof exists", () => {
  const diagnostic = classifyEvidenceMaturity({
    requestedClaim: "broad product-grade superiority",
    runs: [
      {
        status: "keep",
        description: "Improved protected probe row with row-specific detector and static citation.",
      },
    ],
  });

  assert.equal(diagnostic.status, "diagnostic");
  assert.equal(diagnostic.blocksFinalization, true);
  assert.match(diagnostic.weakerClaim, /diagnostic or provisional/);

  const broad = classifyEvidenceMaturity({
    requestedClaim: "broad superiority",
    runs: [
      {
        status: "keep",
        description:
          "Holdout proof with repeated rerun, breadth across multiple tasks, and promotion-grade CI passed.",
      },
    ],
  });

  assert.equal(broad.status, "broad");
  assert.equal(broad.blocksFinalization, false);
});

test("lane orchestration splits broad failures into accountable lanes", () => {
  const plan = planFailureRecoveryLanes({
    signals: [{ kind: "false done", message: "broad failure from session" }],
    writeScope: ["plugins/codex-autoresearch/lib"],
  });

  assert.equal(plan.status, "planned");
  assert.deepEqual(
    plan.lanes.map((lane) => lane.type),
    ["scout", "implementation", "review", "finalization"],
  );
  assert.equal(plan.lanes.find((lane) => lane.type === "implementation")?.writeScopeRequired, true);

  const blocked = planFailureRecoveryLanes({
    signals: [{ kind: "local-only finalization" }],
  });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.blockers[0], /worktree|write scope/);
});

test("blocked lane orchestration becomes the canonical next action", () => {
  const laneOrchestration = planFailureRecoveryLanes({
    signals: [{ kind: "local-only finalization" }],
  });

  const loop = buildLoopContractStatus({ laneOrchestration });

  assert.equal(laneOrchestration.status, "blocked");
  assert.equal(loop.canRunNextPacket, false);
  assert.equal(loop.strongestAction?.kind, "lane-orchestration");
  assert.match(loop.strongestAction?.reason || "", /worktree|write scope/);
});

test("finalization runway distinguishes local-only, divergent, checked-out, and merged states", () => {
  assert.equal(
    classifyFinalizationRunwayFromFacts({
      branch: "autoresearch-review/goal/01-change",
      branchExists: true,
      equivalent: true,
      localOnly: true,
    }).status,
    "local-only",
  );
  assert.equal(
    classifyFinalizationRunwayFromFacts({
      branch: "autoresearch-review/goal/01-change",
      branchExists: true,
      equivalent: false,
      localOnly: true,
    }).status,
    "unverified",
  );
  assert.equal(
    classifyFinalizationRunwayFromFacts({
      branch: "autoresearch-review/goal/01-change",
      branchExists: true,
      equivalent: false,
      prUrl: "https://github.example/pr/1",
      ciStatus: "success",
    }).status,
    "unverified",
  );
  assert.equal(
    classifyFinalizationRunwayFromFacts({
      branch: "autoresearch-review/goal/01-change",
      branchExists: true,
      equivalent: false,
      prUrl: "https://github.example/pr/1",
      ciStatus: "success",
      merged: true,
    }).status,
    "unverified",
  );
  assert.equal(
    classifyFinalizationRunwayFromFacts({
      branch: "autoresearch-review/goal/01-change",
      branchExists: true,
      divergent: true,
    }).status,
    "divergent",
  );
  assert.equal(
    classifyFinalizationRunwayFromFacts({
      branch: "autoresearch-review/goal/01-change",
      branchExists: true,
      checkedOut: true,
    }).status,
    "checked-out",
  );
  assert.equal(
    classifyFinalizationRunwayFromFacts({
      branch: "autoresearch-review/goal/01-change",
      branchExists: true,
      equivalent: true,
      prUrl: "https://github.example/pr/1",
      ciStatus: "success",
    }).status,
    "pr-open",
  );
  assert.equal(
    classifyFinalizationRunwayFromFacts({
      branch: "autoresearch-review/goal/01-change",
      branchExists: true,
      equivalent: true,
      prUrl: "https://github.example/pr/1",
      ciStatus: "success",
      merged: true,
    }).stage,
    "cleanup",
  );
});

test("loop contract and operator readout expose the same canonical blocker", () => {
  const loop = buildLoopContractStatus({
    goalContract: buildGoalContract({
      autoresearchGoal: "A",
      codexGoalObjective: "B",
      benchmarkGoal: "A",
    }),
  });
  const readout = buildOperatorReadout({
    canonicalNextAction: loop.strongestAction,
    loopContract: loop,
    runtimeProvenance: { status: "source-only" },
  });

  assert.equal(loop.strongestAction?.kind, "goal-contract");
  assert.equal(readout.nextAction, loop.strongestAction?.reason);
  assert.equal(readout.dashboardMutationAllowed, false);
});

test("session 019eb85a derived fixture detects control-plane friction", async () => {
  await withTempDir("session-forensics", async (dir) => {
    const fixture = path.join(dir, "019eb85a.jsonl");
    await writeFile(fixture, fixtureJsonl(session019eb85aControlPlaneFixtureEntries()), "utf8");
    const parsed = await parseSessionForensics({ sessionJsonl: fixture });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const productKinds = parsed.productSignals.map((signal) => signal.kind);
    const wasteKinds = parsed.workflowWaste.map((signal) => signal.kind);

    assert.ok(productKinds.includes("early_false_done_correction"));
    assert.ok(productKinds.includes("approval_stall"));
    assert.ok(productKinds.includes("finalization_local_only"));
    assert.ok(productKinds.includes("goal_contract_gap"));
    assert.ok(productKinds.includes("benchmark_overfit_steering"));
    assert.ok(wasteKinds.includes("resource_interruption"));
    assert.ok(wasteKinds.includes("cleanup_afterthought"));
    assert.ok(wasteKinds.includes("output_budget_exceeded"));
  });
});

test("session forensics detects setup-only start, fixed-control corrections, stale segments, and goal churn", async () => {
  await withTempDir("session-forensics-start-control-goal-drift", async (dir) => {
    const fixture = path.join(dir, "language-support-friction.jsonl");
    await writeFile(
      fixture,
      fixtureJsonl(codeStoryLanguageSupportFrictionFixtureEntries()),
      "utf8",
    );

    const parsed = await parseSessionForensics({ sessionJsonl: fixture });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const signals = new Map(parsed.productSignals.map((signal) => [signal.kind, signal.severity]));

    assert.equal(signals.get("setup_not_started"), "blocker");
    assert.equal(signals.get("fixed_control_rerun_correction"), "blocker");
    assert.equal(signals.get("stale_segment_pickup"), "warning");
    assert.equal(signals.get("goal_churn_or_early_completion"), "warning");
    assert.equal(signals.get("overfit_correction"), "blocker");
    assert.equal(parsed.decisionCapsule.enforcement.mode, "hard-block");
    assert.equal(parsed.decisionCapsule.enforcement.canRunNextPacket, false);
    assert.equal(parsed.decisionCapsule.enforcement.blocksFinalization, true);
    assert.match(parsed.decisionCapsule.bottleneck, /loop has not started/i);
    assert.match(parsed.decisionCapsule.nextExperiment, /doctor/i);
    assert.match(parsed.decisionCapsule.wrongNextActions.join("\n"), /Do not mark setup/i);
    assert.match(parsed.decisionCapsule.evidence.join("\n"), /fixed control/i);
  });
});

test("session forensics ignores preventive Codex goal completion guidance", async () => {
  await withTempDir("session-forensics-preventive-goal-guidance", async (dir) => {
    const fixture = path.join(dir, "preventive-goal-guidance.jsonl");
    await writeFile(
      fixture,
      fixtureJsonl([
        {
          timestamp: "2026-06-16T15:00:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_codex_goal_brief",
            output: [
              "Do not mark the Codex goal complete while Autoresearch has unresolved quality gaps.",
              "You should not mark complete until review-required evidence is acknowledged.",
              "Before marking complete, cite checks and remaining risks.",
              "Do not complete this goal from budget exhaustion.",
            ].join("\n"),
          },
        },
      ]),
      "utf8",
    );

    const parsed = await parseSessionForensics({ sessionJsonl: fixture });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    assert.equal(
      parsed.productSignals.some((signal) => signal.kind === "goal_churn_or_early_completion"),
      false,
    );
  });
});

test("session forensics ignores imported goal status audit snapshots", async () => {
  await withTempDir("session-forensics-imported-goal-status", async (dir) => {
    const fixture = path.join(dir, "imported-goal-status.jsonl");
    await writeFile(
      fixture,
      fixtureJsonl([
        {
          timestamp: "2026-06-16T15:20:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_codex_goal_brief",
            output: JSON.stringify({
              completionAudit: {
                importedCodexStatus: "complete",
                recommendedCodexAction:
                  "The imported Codex Goal is already complete; do not call update_goal again from this audit.",
              },
            }),
          },
        },
      ]),
      "utf8",
    );

    const parsed = await parseSessionForensics({ sessionJsonl: fixture });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    assert.equal(
      parsed.productSignals.some((signal) => signal.kind === "goal_churn_or_early_completion"),
      false,
    );
  });
});

test("session forensics detects update_goal complete function calls", async () => {
  await withTempDir("session-forensics-update-goal-complete", async (dir) => {
    const fixture = path.join(dir, "update-goal-complete.jsonl");
    await writeFile(
      fixture,
      fixtureJsonl([
        {
          timestamp: "2026-06-16T15:30:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "update_goal",
            arguments: JSON.stringify({ status: "complete" }),
          },
        },
      ]),
      "utf8",
    );

    const parsed = await parseSessionForensics({ sessionJsonl: fixture });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    assert.equal(
      parsed.productSignals.some((signal) => signal.kind === "goal_churn_or_early_completion"),
      true,
    );
    assert.equal(parsed.goal.status, "complete");
  });
});
