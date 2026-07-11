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
import { quoteShellArg, renderShellCommand } from "../lib/command-rendering.js";
import { buildContinuationCommands } from "../lib/commands/continuation.js";
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
import { buildProcessLifecycleRecord, buildResourcePreflight } from "../lib/process-governor.js";
import { resolveSafeResearchPath } from "../lib/research-path-guard.js";
import {
  COMPACT_STATE_MAX_BYTES,
  COMPACT_STATE_MAX_LINES,
  COMPACT_STATE_MAX_TOKENS,
  DEFAULT_DOCTOR_MAX_BYTES,
  DEFAULT_DOCTOR_MAX_LINES,
  DEFAULT_DOCTOR_MAX_TOKENS,
  DEFAULT_STATE_MAX_BYTES,
  DEFAULT_STATE_MAX_LINES,
  DEFAULT_STATE_MAX_TOKENS,
  projectDashboardDecision,
  projectDoctorReadModel,
  projectFinalizationDecision,
  projectionBudget,
  projectStateReadModel,
  resolveSessionDecision,
  resolveFinalizationDecision,
} from "../lib/session-read-model.js";
import { appendJsonl, jsonlPath, ledgerRecordIssue, readJsonl } from "../lib/session-records.js";
import { parseSessionForensics } from "../lib/session-forensics.js";
import { resolveSessionPaths } from "../lib/session-paths.js";
import { buildTerminalReport } from "../lib/terminal-report.js";
import { parseDashboardContext } from "../lib/types/dashboard-wire.js";
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

test("resource preflight catches typed active processes, repeated commands, and output budgets", () => {
  const preflight = buildResourcePreflight({
    command: "rg -n needle src tests",
    entries: [
      { command: "rg -n needle src tests" },
      { command: "rg -n needle src tests" },
      { command: "rg -n needle src tests" },
      { command: "rg -n needle src tests" },
      { command: "rg -n needle src tests" },
      buildProcessLifecycleRecord({
        packetId: "packet-6-active",
        processId: "benchmark",
        event: "observed-live",
        at: "2026-06-13T12:00:00.000Z",
      }),
      { packetEvidence: { outputTokens: 30000, outputLines: 1500 } },
    ],
    budgets: {
      maxRepeatedCommandHeads: 5,
      maxCommandOutputTokens: 24000,
      maxCommandOutputLines: 1200,
    },
  });

  assert.equal(preflight.canStart, false);
  assert.match(preflight.blockers.join(" "), /Typed process lifecycle/);
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

test("historical process prose is warning-only and never creates trust state", () => {
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

  assert.equal(preflight.canStart, true);
  assert.equal(preflight.status, "warning");
  assert.deepEqual(preflight.residue, []);
  assert.match(preflight.warnings.join(" "), /warning-only.*typed process_lifecycle/i);
  assert.doesNotMatch(JSON.stringify(preflight), /SECRET_TOKEN|private\.env|abc123/);
});

test("typed process lifecycle blocks unclosed state and redacts identity metadata", () => {
  const preflight = buildResourcePreflight({
    entries: [
      {
        type: "process_lifecycle",
        identity: {
          packetId: "SECRET_TOKEN=abc123",
          processId: "C:/Users/alber/private.env",
        },
        event: "started",
        at: "2026-06-13T12:00:00.000Z",
      },
    ],
  });

  assert.equal(preflight.canStart, false);
  assert.equal(preflight.residue.length, 1);
  assert.equal(preflight.residue[0].type, "process_lifecycle");
  assert.equal(preflight.residue[0].status, "invalid-lifecycle");
  assert.match(preflight.residue[0].identity, /^process-[a-f0-9]{12}$/);
  assert.doesNotMatch(
    JSON.stringify(preflight.residue),
    /SECRET_TOKEN|abc123|C:\/Users\/alber\/private\.env/,
  );
  assert.throws(
    () =>
      buildProcessLifecycleRecord({
        packetId: "SECRET_TOKEN=abc123",
        processId: "C:/Users/alber/private.env",
        event: "started",
      }),
    /identity is invalid/,
  );
});

test("latest terminal event clears active and termination-failed state in ledger order", () => {
  const preflight = buildResourcePreflight({
    entries: [
      buildProcessLifecycleRecord({
        packetId: "packet-1",
        processId: "benchmark",
        event: "started",
      }),
      buildProcessLifecycleRecord({
        packetId: "packet-1",
        processId: "benchmark",
        event: "observed-live",
      }),
      buildProcessLifecycleRecord({
        packetId: "packet-1",
        processId: "benchmark",
        event: "termination-failed",
        termination: { proven: false, reason: "remaining_processes_alive" },
      }),
      buildProcessLifecycleRecord({
        packetId: "packet-1",
        processId: "benchmark",
        event: "terminated",
      }),
    ],
  });

  assert.equal(preflight.canStart, true);
  assert.deepEqual(preflight.residue, []);
});

test("lifecycle fold keeps only latest state per duplicate identity", () => {
  const preflight = buildResourcePreflight({
    entries: [
      buildProcessLifecycleRecord({
        packetId: "packet-a",
        processId: "benchmark",
        event: "started",
      }),
      buildProcessLifecycleRecord({
        packetId: "packet-a",
        processId: "benchmark",
        event: "started",
      }),
      buildProcessLifecycleRecord({
        packetId: "packet-b",
        processId: "checks",
        event: "termination-failed",
      }),
      buildProcessLifecycleRecord({
        packetId: "packet-a",
        processId: "benchmark",
        event: "terminated",
      }),
    ],
  });

  assert.equal(preflight.canStart, false);
  assert.equal(preflight.residue.length, 1);
  assert.equal(preflight.residue[0].status, "termination-failed");
});

test("structured #292 progress outcomes feed the same lifecycle fold", () => {
  const baseProgress = {
    packetId: "packet-7-active",
    commandClass: "node script",
    startedAt: "2026-06-13T12:00:00.000Z",
  };
  const failedEntry = {
    packetEvidence: {
      progressSnapshot: {
        ...baseProgress,
        exitState: "termination_failed",
        terminationFailed: true,
        termination: { proven: false, reason: "remaining_processes_alive" },
      },
    },
  };
  const failed = buildResourcePreflight({
    entries: [failedEntry],
  });
  const cleared = buildResourcePreflight({
    entries: [
      failedEntry,
      {
        packetEvidence: {
          progressSnapshot: {
            ...baseProgress,
            exitState: "timed_out",
            terminationFailed: false,
            termination: { proven: true, reason: "terminated" },
          },
        },
      },
    ],
  });

  assert.equal(failed.canStart, false);
  assert.equal(failed.residue[0].status, "termination-failed");
  assert.equal(cleared.canStart, true);
  assert.deepEqual(cleared.residue, []);
});

test("next-command orchestration progress is not mistaken for a child process", () => {
  const preflight = buildResourcePreflight({
    entries: [
      {
        packetEvidence: {
          progressSnapshot: {
            packetId: "packet-1-active",
            commandClass: "autoresearch preflight",
            startedAt: "2026-07-10T12:00:00.000Z",
            exitState: "running",
          },
        },
      },
    ],
  });

  assert.equal(preflight.canStart, true);
  assert.deepEqual(preflight.residue, []);
});

test("lifecycle writer drops sensitive termination metadata", () => {
  const record = buildProcessLifecycleRecord({
    packetId: "packet-safe",
    processId: "benchmark",
    event: "termination-failed",
    termination: {
      proven: false,
      reason: "C:/Users/alber/private.env SECRET_TOKEN=abc123",
      command: "node secret.js --token abc123",
      trackedPids: [1234],
    },
  });

  assert.deepEqual(record.termination, { proven: false, reason: "" });
  assert.doesNotMatch(JSON.stringify(record), /private\.env|SECRET_TOKEN|secret\.js|abc123|1234/);
});

test("malformed typed lifecycle rows block instead of bypassing process trust", () => {
  for (const entry of [
    {
      type: "process_lifecycle",
      identity: { packetId: "packet-malformed", processId: "benchmark" },
      event: "started",
      at: "not-a-timestamp",
    },
    {
      type: "process_lifecycle",
      identity: { packetId: "packet-malformed", processId: "benchmark" },
      event: "started",
      at: "2026-07-10T12:00:00.000Z",
      termination: { proven: false, reason: "remaining_processes_alive" },
    },
    {
      type: "process_lifecycle",
      identity: { packetId: "packet-malformed", processId: "benchmark" },
      event: "termination-failed",
      at: "2026-07-10T12:00:00.000Z",
      termination: { proven: true, reason: "terminated" },
    },
  ]) {
    const preflight = buildResourcePreflight({ entries: [entry] });
    assert.equal(preflight.canStart, false);
    assert.equal(preflight.residue[0].status, "invalid-lifecycle");
    assert.doesNotMatch(JSON.stringify(preflight.residue), /packet-malformed|not-a-timestamp/);
  }
});

test("unproven terminated event cannot clear an active lifecycle identity", () => {
  const preflight = buildResourcePreflight({
    entries: [
      buildProcessLifecycleRecord({
        packetId: "packet-unproven",
        processId: "benchmark",
        event: "started",
      }),
      {
        type: "process_lifecycle",
        identity: { packetId: "packet-unproven", processId: "benchmark" },
        event: "terminated",
        at: "2026-07-10T12:00:00.000Z",
        termination: { proven: false, reason: "remaining_processes_alive" },
      },
    ],
  });

  assert.equal(preflight.canStart, false);
  assert.deepEqual(
    new Set(preflight.residue.map((record) => record.status)),
    new Set(["process-active", "invalid-lifecycle"]),
  );
  assert.throws(
    () =>
      buildProcessLifecycleRecord({
        packetId: "packet-unproven",
        processId: "benchmark",
        event: "terminated",
        termination: { proven: false, reason: "remaining_processes_alive" },
      }),
    /cannot carry unproven termination evidence/,
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

test("resolved decision fails closed when a ready action contradicts a stronger blocker", () => {
  const runtimeProvenance = { source: "source-checkout", version: "2.7.0" };
  const finalizationPressure = { available: true, ready: false, nextAction: "Repair first." };
  const resolved = resolveSessionDecision({
    state: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "next-packet",
          reason: "Run the next packet.",
          command: "node scripts/autoresearch.mjs next --cwd .",
        },
        loopContract: {
          canRunNextPacket: true,
          blockers: ["Ledger order is invalid."],
          strongestAction: {
            kind: "ledger-integrity",
            reason: "Repair ledger order before packet work.",
          },
        },
        runtimeProvenance,
        finalizationReadiness: finalizationPressure,
      },
    },
    commands: { ledgerDoctor: "node scripts/autoresearch.mjs ledger-doctor --cwd . --json" },
  });

  assert.equal(resolved.status, "blocked");
  assert.equal(resolved.strongestBlocker, "Ledger order is invalid.");
  assert.equal(resolved.canonicalNextAction?.kind, "ledger-integrity");
  assert.equal(resolved.nextAction, "Repair ledger order before packet work.");
  assert.match(resolved.command, /ledger-doctor/);
  assert.deepEqual(resolved.runtimeProvenance, runtimeProvenance);
  assert.deepEqual(resolved.finalizationPressure, finalizationPressure);
});

test("resolved decision rejects unsafe commands and legacy aliases cannot override authority", () => {
  const resolved = resolveSessionDecision({
    state: {
      resolvedDecision: {
        version: 1,
        status: "complete",
        strongestBlocker: null,
        nextAction: "Review the completed evidence.",
        command: "node -e \"require('child_process').execSync('whoami')\"",
        canonicalNextAction: {
          kind: "complete",
          reason: "Review the completed evidence.",
          command: "<unsafe-placeholder>",
        },
        loopContract: { complete: true, blockers: [] },
        runtimeProvenance: null,
        runtimeAuthority: null,
        finalizationPressure: null,
      },
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "next-packet",
          reason: "Legacy alias says run another packet.",
          command: "node scripts/autoresearch.mjs next --cwd .",
        },
        loopContract: { canRunNextPacket: true, blockers: [] },
      },
    },
  });
  assert.equal(resolved.status, "complete");
  assert.equal(resolved.canonicalNextAction?.kind, "complete");
  assert.equal(resolved.command, "");
});

test("blocked decisions without a repair action never retain a ready packet command", () => {
  const resolved = resolveSessionDecision({
    state: {
      blockers: ["The ledger is inconsistent and must be repaired before any packet can run."],
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "next-packet",
          reason: "Run the next packet.",
          command: "node scripts/autoresearch.mjs next --cwd .",
        },
        loopContract: { canRunNextPacket: false, blockers: [] },
      },
    },
  });
  assert.equal(resolved.status, "blocked");
  assert.equal(resolved.canonicalNextAction?.kind, "blocked");
  assert.equal(resolved.command, "");
});

test("resolved operational commands reject nested shell operators", () => {
  for (const command of [
    "node scripts/autoresearch.mjs next --cwd . && node payload.mjs",
    "node scripts/autoresearch.mjs next --cwd .; node payload.mjs",
    "node scripts/autoresearch.mjs next --cwd . | node payload.mjs",
    "node scripts/autoresearch.mjs next --cwd .\nnode payload.mjs",
  ]) {
    const resolved = resolveSessionDecision({
      state: {
        decisionEnvelope: {
          canonicalNextAction: { kind: "next-packet", reason: "Run a packet.", command },
          loopContract: { canRunNextPacket: true, blockers: [] },
        },
      },
    });
    assert.equal(resolved.command, "", command);
    assert.equal(resolved.canonicalNextAction?.command, "", command);
  }
});

test("resolved operational commands reject interpreter evaluation modes", () => {
  for (const command of [
    'node -e "process.exit(1)"',
    'node --eval="process.exit(1)"',
    'node -p "process.version"',
    'node --print "process.version"',
    'node --no-warnings -pe "process.version"',
    'node --require ./hook.mjs -e "process.exit(1)"',
    'node "-e" "process.exit(1)"',
    "python3 -c \"print('payload')\"",
    "python -I -c \"print('payload')\"",
    "python -W ignore -c \"print('payload')\"",
    'powershell -Command "Get-Process"',
    "pwsh -EncodedCommand ZQB4AGkAdAA=",
    "pwsh -NoProfile -EncodedCommand ZQB4AGkAdAA=",
    "pwsh -ExecutionPolicy Bypass -EncodedCommand ZQB4AGkAdAA=",
    "cmd /k whoami",
    "cmd /d /c whoami",
    "bash -lc whoami",
    "bash --noprofile -lc whoami",
  ]) {
    const resolved = resolveSessionDecision({
      state: {
        decisionEnvelope: {
          canonicalNextAction: { kind: "decision-capsule", reason: "Run repair.", command },
          loopContract: { canRunNextPacket: false, blockers: ["Run repair."] },
        },
      },
    });
    assert.equal(resolved.command, "", command);
    assert.equal(resolved.canonicalNextAction?.command, "", command);
  }
});

test("resolved operational commands allow evaluator text as a trusted CLI argument", () => {
  const command =
    "node scripts/autoresearch.mjs next --cwd . --command 'node -e \"console.log(1)\"'";
  const resolved = resolveSessionDecision({
    state: {
      decisionEnvelope: {
        canonicalNextAction: { kind: "next-packet", reason: "Run a packet.", command },
        loopContract: { canRunNextPacket: true, blockers: [] },
      },
    },
  });
  assert.equal(resolved.command, command);
});

test("resolved operational commands accept only the trusted generated PowerShell wrapper", () => {
  const command = renderShellCommand(
    ["C:\\Program Files\\nodejs\\node.exe", "scripts\\autoresearch.mjs", "next", "--cwd", "."],
    "powershell",
  );
  const resolved = resolveSessionDecision({
    state: {
      decisionEnvelope: {
        canonicalNextAction: { kind: "next-packet", reason: "Run a packet.", command },
        loopContract: { canRunNextPacket: true, blockers: [] },
      },
    },
  });
  assert.equal(resolved.command, command);

  for (const unsafeBody of [
    "node scripts/autoresearch.mjs next --cwd .; node payload.mjs",
    "'C:\\Program Files\\nodejs\\node.exe' -e 'process.exit(1)'",
    "'C:\\Program Files\\nodejs\\node.exe' --print 'process.version'",
    "pwsh.exe -EncodedCommand ZQB4AGkAdAA=",
  ]) {
    const unsafe = `& { $PSNativeCommandArgumentPassing = 'Legacy'; ${unsafeBody} }`;
    assert.equal(
      resolveSessionDecision({
        state: {
          decisionEnvelope: {
            canonicalNextAction: { kind: "next-packet", reason: "Run a packet.", command: unsafe },
            loopContract: { canRunNextPacket: true, blockers: [] },
          },
        },
      }).command,
      "",
    );
  }
});

test("resolved watchdog authority stays canonical over a generic preflight blocker", () => {
  const resolved = resolveSessionDecision({
    state: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "watchdog",
          reason: "Intervene after the stale progress window.",
        },
        loopContract: {
          canRunNextPacket: false,
          blockers: ["No benchmark command is configured."],
          strongestAction: {
            kind: "preflight",
            reason: "No benchmark command is configured.",
          },
        },
      },
    },
  });

  assert.equal(resolved.canonicalNextAction?.kind, "watchdog");
  assert.match(resolved.nextAction, /Intervene/);
  assert.equal(resolved.status, "blocked");
});

test("decision capsules replace placeholder hints with a safe canonical fallback command", () => {
  const commands = buildContinuationCommands({
    scriptPath: path.join(process.cwd(), "scripts", "autoresearch.mjs"),
    shellQuote: (value) => quoteShellArg(value, "powershell"),
    workDir: "C:\\work",
  });
  const resolved = resolveSessionDecision({
    state: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "decision-capsule",
          reason: "Repair the benchmark contract.",
          command: "node scripts/autoresearch.mjs benchmark-lint --cwd <project>",
        },
        loopContract: {
          canRunNextPacket: false,
          blockers: ["Repair the benchmark contract."],
          strongestAction: {
            kind: "decision-capsule",
            reason: "Repair the benchmark contract.",
            command: "node scripts/autoresearch.mjs benchmark-lint --cwd <project>",
          },
        },
      },
    },
    commands,
  });

  assert.equal(resolved.command, commands.recommendNext);
  assert.equal(resolved.canonicalNextAction?.command, commands.recommendNext);

  const reread = resolveSessionDecision({
    state: {
      resolvedDecision: resolved,
      decisionEnvelope: {
        canonicalNextAction: resolved.canonicalNextAction,
        loopContract: {
          ...resolved.loopContract,
          strongestAction: {
            kind: "decision-capsule",
            reason: "Repair the benchmark contract.",
            command: "node scripts/autoresearch.mjs benchmark-lint --cwd <project>",
          },
        },
      },
    },
    commands: { primary: resolved.command },
  });
  assert.equal(reread.command, commands.recommendNext);
  assert.equal(reread.canonicalNextAction?.command, commands.recommendNext);
});

test("bounded projection preserves enough blocker provenance to re-resolve watchdog authority", () => {
  const source = readModelFixture(2);
  source.decisionEnvelope = {
    canonicalNextAction: {
      kind: "watchdog",
      reason: "Intervene after the stale progress window.",
    },
    loopContract: {
      canRunNextPacket: false,
      blockers: ["No benchmark command is configured."],
      strongestAction: {
        kind: "preflight",
        reason: "No benchmark command is configured.",
      },
    },
  };

  const compact = projectStateReadModel(source, "compact");
  const reread = resolveSessionDecision({ state: compact });
  assert.equal(reread.canonicalNextAction?.kind, "watchdog");
  assert.equal(reread.nextAction, "Intervene after the stale progress window.");
});

test("finalization results resolve blocked and ready status explicitly", () => {
  const blocked = resolveFinalizationDecision({
    ready: false,
    warnings: ["Working directory is not a Git repository."],
    nextAction: "Run finalization preview from a Git-backed branch.",
  });
  const ready = resolveFinalizationDecision({
    ready: true,
    nextAction: "Review the finalization preview.",
  });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.strongestBlocker || "", /Git-backed branch/);
  assert.equal(ready.status, "ready");
});

test("state, doctor, report, dashboard, and finalization share one resolved authority", () => {
  const source = readModelFixture(12);
  const defaultState = projectStateReadModel(source, "default");
  const compactState = projectStateReadModel(source, "compact");
  const doctor = projectDoctorReadModel({
    ok: false,
    workDir: source.workDir,
    state: source,
    decisionEnvelope: source.decisionEnvelope,
    issues: ["Ledger order is invalid."],
  });
  const dashboard = projectDashboardDecision(source);
  const finalization = projectFinalizationDecision(source);
  const report = buildTerminalReport(defaultState).json;
  const authorities = [
    defaultState.resolvedDecision,
    compactState.resolvedDecision,
    doctor.resolvedDecision,
    dashboard,
  ] as Array<Record<string, unknown>>;

  for (const authority of authorities) {
    assert.equal(authority.status, "blocked");
    assert.match(String(authority.strongestBlocker), /Ledger order is invalid/);
    assert.equal(authority.nextAction, "Repair ledger order before packet work.");
    assert.match(String(authority.command), /ledger-doctor/);
    assert.deepEqual(authority.runtimeProvenance, source.runtimeProvenance);
    assert.deepEqual(authority.finalizationPressure, source.finalizationPressure);
  }
  assert.equal(report.status, "blocked");
  assert.match(report.blocker, /Ledger order is invalid/);
  assert.equal(report.nextAction, "Repair ledger order before packet work.");
  assert.match(report.nextCommand, /ledger-doctor/);
  assert.equal(finalization.status, "blocked");
  assert.match(String(finalization.strongestBlocker), /Ledger order is invalid/);
  assert.deepEqual(finalization.runtimeProvenance, source.runtimeProvenance);
  assert.deepEqual(finalization.finalizationPressure, source.finalizationPressure);
});

test("100-run state and doctor projections enforce reviewed byte and line budgets", () => {
  const source = readModelFixture(100);
  const defaultState = projectStateReadModel(source, "default");
  const compactState = projectStateReadModel(source, "compact");
  const doctor = projectDoctorReadModel({
    ok: false,
    workDir: source.workDir,
    state: source,
    decisionEnvelope: source.decisionEnvelope,
    issues: Array.from({ length: 40 }, (_, index) => `Issue ${index}: ${"x".repeat(200)}`),
    warnings: Array.from({ length: 40 }, (_, index) => `Warning ${index}: ${"y".repeat(200)}`),
  });
  const defaultBudget = projectionBudget(defaultState);
  const compactBudget = projectionBudget(compactState);
  const doctorBudget = projectionBudget(doctor);

  assert.ok(defaultBudget.bytes <= DEFAULT_STATE_MAX_BYTES, JSON.stringify(defaultBudget));
  assert.ok(defaultBudget.lines <= DEFAULT_STATE_MAX_LINES, JSON.stringify(defaultBudget));
  assert.ok(defaultBudget.tokens <= DEFAULT_STATE_MAX_TOKENS, JSON.stringify(defaultBudget));
  assert.ok(compactBudget.bytes <= COMPACT_STATE_MAX_BYTES, JSON.stringify(compactBudget));
  assert.ok(compactBudget.lines <= COMPACT_STATE_MAX_LINES, JSON.stringify(compactBudget));
  assert.ok(compactBudget.tokens <= COMPACT_STATE_MAX_TOKENS, JSON.stringify(compactBudget));
  assert.ok(compactBudget.bytes < defaultBudget.bytes, "compact must be smaller than default");
  assert.ok(doctorBudget.bytes <= DEFAULT_DOCTOR_MAX_BYTES, JSON.stringify(doctorBudget));
  assert.ok(doctorBudget.lines <= DEFAULT_DOCTOR_MAX_LINES, JSON.stringify(doctorBudget));
  assert.ok(doctorBudget.tokens <= DEFAULT_DOCTOR_MAX_TOKENS, JSON.stringify(doctorBudget));
  assert.deepEqual(exactDuplicateSubtrees(compactState), []);
  assert.equal(Object.hasOwn(compactState, "resumeAudit"), false);
  assert.equal(Object.hasOwn(compactState, "decisionEnvelope"), false);
});

test("bounded continuation keeps only operator authority within its own byte and line budget", () => {
  const source = readModelFixture(100);
  source.continuation = {
    mode: "owner-autonomous",
    stage: "needs-log-decision",
    activeBudget: true,
    shouldContinue: true,
    forbidFinalAnswer: true,
    requiresLogDecision: true,
    stopReason: "s".repeat(4_000),
    finalAnswerPolicy: "p".repeat(4_000),
    plateau: { history: Array.from({ length: 100 }, (_, index) => ({ index })) },
    commands: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`command${index}`, "x".repeat(500)]),
    ),
  };

  const compact = projectStateReadModel(source, "compact");
  const continuation = compact.continuation as Record<string, unknown>;
  const budget = projectionBudget(continuation);
  assert.ok(budget.bytes <= 1_200, JSON.stringify(budget));
  assert.ok(budget.lines <= 20, JSON.stringify(budget));
  assert.equal(Object.hasOwn(continuation, "commands"), false);
  assert.equal(Object.hasOwn(continuation, "plateau"), false);
});

test("mandatory Unicode state fields truncate deterministically within every reviewed budget", () => {
  const source = readModelFixture(100);
  source.workDir = `C:/${"😀".repeat(12_000)}`;
  source.config.goal = `Improve ${"界".repeat(20_000)}`;
  source.commands = {
    state: `node scripts/autoresearch.mjs state --cwd "${"😀".repeat(10_000)}"`,
  };
  const compact = projectStateReadModel(source, "compact");
  const normal = projectStateReadModel(source, "default");
  const compactBudget = projectionBudget(compact);
  const normalBudget = projectionBudget(normal);
  assert.ok(compactBudget.bytes <= COMPACT_STATE_MAX_BYTES, JSON.stringify(compactBudget));
  assert.ok(compactBudget.lines <= COMPACT_STATE_MAX_LINES, JSON.stringify(compactBudget));
  assert.ok(compactBudget.tokens <= COMPACT_STATE_MAX_TOKENS, JSON.stringify(compactBudget));
  assert.ok(normalBudget.bytes <= DEFAULT_STATE_MAX_BYTES, JSON.stringify(normalBudget));
  assert.match(String(compact.goal), /truncated/);
  assert.match(String(compact.workDir), /truncated/);
});

test("dashboard wire context validates backend input outside the React source tree", () => {
  assert.throws(() => parseDashboardContext([]), /must be an object/);
  assert.throws(
    () => parseDashboardContext({ state: { config: {}, current: "not-an-array" } }),
    /state\.current must be an array/,
  );
  assert.throws(() => parseDashboardContext({ state: {} }), /state\.config must be an object/);
  assert.throws(
    () => parseDashboardContext({ state: { config: {}, current: [{ run: "one" }] } }),
    /current\[0\]\.run must be a finite number/,
  );
  const parsed = parseDashboardContext({
    state: { config: { metricName: "latency" }, current: [{ run: 1, status: "keep" }] },
    warnings: [],
  });
  assert.equal(parsed.state.config.metricName, "latency");
  assert.equal(parsed.state.current?.[0].run, 1);
});

function readModelFixture(runCount: number): Record<string, any> {
  const runtimeProvenance = { source: "source-checkout", version: "2.7.0" };
  const finalizationPressure = { available: true, ready: false, nextAction: "Repair first." };
  const decisionEnvelope = {
    canonicalNextAction: { kind: "next-packet", reason: "Run the next packet." },
    loopContract: {
      canRunNextPacket: false,
      blockers: [
        "Ledger order is invalid because a duplicate physical run number breaks the accepted evidence sequence and must be repaired before another packet.",
      ],
      strongestAction: {
        kind: "ledger-integrity",
        reason: "Repair ledger order before packet work.",
      },
    },
    runtimeProvenance,
    finalizationReadiness: finalizationPressure,
  };
  return {
    ok: false,
    workDir: "C:/fixture",
    config: {
      name: "Budget fixture",
      goal: "Keep latency low",
      metricName: "latency_ms",
      bestDirection: "lower",
    },
    segment: 1,
    runs: runCount,
    kept: Math.floor(runCount / 2),
    discarded: Math.ceil(runCount / 2),
    measured: 0,
    current: Array.from({ length: runCount }, (_, index) => ({
      run: index + 1,
      metric: runCount - index,
      status: index % 2 ? "discard" : "keep",
      description: `Run ${index + 1}`,
    })),
    decisionEnvelope,
    runtimeProvenance,
    finalizationPressure,
    blockers: [
      "Ledger order is invalid because a duplicate physical run number breaks the accepted evidence sequence and must be repaired before another packet.",
    ],
    commands: {
      ledgerDoctor: "node scripts/autoresearch.mjs ledger-doctor --cwd C:/fixture --json",
      state: "node scripts/autoresearch.mjs state --cwd C:/fixture",
    },
    researchIntegrity: {
      notPromotableBecause: ["Missing repeat evidence."],
      warnings: ["Missing repeat evidence."],
    },
    preflight: { status: "blocked", blockers: ["Ledger order is invalid."] },
  };
}

function exactDuplicateSubtrees(value: unknown): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const serialized = JSON.stringify(item);
    if (serialized.length >= 64) {
      if (seen.has(serialized)) duplicates.push(serialized);
      else seen.add(serialized);
    }
    if (Array.isArray(item)) item.forEach(visit);
    else Object.values(item as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return duplicates;
}
