import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  approvalRecordsFromLedger,
  buildApprovalLedgerStatus,
  buildApprovalRecord,
  resolveApproval,
} from "../lib/approval-ledger.js";
import { classifyEvidenceMaturity } from "../lib/evidence-maturity.js";
import { classifyFinalizationRunwayFromFacts } from "../lib/finalization-runway.js";
import { buildGoalContract } from "../lib/goal-frame.js";
import { planFailureRecoveryLanes } from "../lib/lane-orchestration-controller.js";
import { buildLoopContractStatus } from "../lib/loop-governance.js";
import { buildOperatorReadout } from "../lib/operator-readout.js";
import { buildResourcePreflight } from "../lib/process-governor.js";
import { parseSessionForensics } from "../lib/session-forensics.js";
import {
  fixtureJsonl,
  session019eb85aControlPlaneFixtureEntries,
} from "./helpers/session-forensics-fixtures.js";
import { withTempDir as withNamedTempDir } from "./helpers/process.js";

const withTempDir = (name: string, fn: (dir: string) => Promise<void>) =>
  withNamedTempDir("autoresearch-control-plane", name, fn);

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
