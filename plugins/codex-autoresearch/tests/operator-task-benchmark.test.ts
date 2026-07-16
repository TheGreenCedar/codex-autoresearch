import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATOR_TASK_CASES,
  OPERATOR_TASK_FAILURE_CODES,
  OPERATOR_TASK_SUITE,
  parseOperatorTaskEvidence,
  validateOperatorTaskRunOutput,
  validateOperatorTaskEvidence,
  type OperatorTaskCase,
} from "../scripts/operator-task-benchmark.js";

const action = {
  kind: "next-packet",
  reason: "Run the next bounded packet.",
  command: "node scripts/autoresearch.mjs next --cwd <project>",
  safeAction: "next",
  toolName: "next",
  priority: 10,
  triggeredBy: ["continuation"],
};
const repoSnapshot = {
  head: "abc123\n",
  refs: "abc123 refs/heads/codex/operator-evidence\n",
  porcelain: "?? groups.json\0",
  indexTree: "tree123\n",
  stagedDiff: "",
  unstagedDiff: "",
  files: [{ path: "src/new space 雪.txt", type: "file", bytes: 5, sha256: "a".repeat(64) }],
};

const validObservations: Record<OperatorTaskCase, Record<string, unknown>> = {
  "decision-consistency": {
    terminalActions: Array.from({ length: 3 }, () => ({ ...action })),
    dashboardAction: Object.fromEntries(
      Object.entries(action).filter(([key]) => key !== "command"),
    ),
    dashboardCommandOmitted: true,
    resolvedCommands: Array.from({ length: 3 }, () => action.command),
    resolvedNextActions: Array.from({ length: 4 }, () => action.reason),
  },
  "invalid-cli": {
    exitCode: 1,
    stdoutBytes: 0,
    stderrBytes: 240,
    diagnostic: "Unknown command: not-a-real-command\n\nUsage: ...",
  },
  "installed-cache-discovery": {
    selectedInstalledRuntime: "fresh",
    selectedProvenanceStatus: "selected",
    ambiguousInstalledRuntime: "unavailable",
    ambiguousProvenanceStatus: "ambiguous",
    candidateCount: 2,
  },
  "hostile-finalization": {
    expectedPaths: ["src/app/(frontend)/[...slug]/page.tsx", "src/app/(frontend)/old space 雪.txt"],
    plannedPaths: ["src/app/(frontend)/[...slug]/page.tsx", "src/app/(frontend)/old space 雪.txt"],
    generatedBranches: ["autoresearch-review/finalize/01-literal-paths"],
    invalidBranches: [],
    staleExitCode: 1,
    staleDiagnostic: "Stale finalization plan: plan fingerprint does not match contents.",
    before: repoSnapshot,
    after: repoSnapshot,
  },
  "session-friction-journey": {
    runs: 0,
    zeroRunActionKinds: ["next-packet", "next-packet", "next-packet"],
    zeroRunActionCommands: [action.command, action.command, action.command],
    canMarkCodexGoalComplete: false,
    rawChecklistAccepted: false,
    generatedGitAttributes: false,
  },
  "output-budgets": {
    outputs: {
      compact: { bytes: 8000, lines: 120 },
      state: { bytes: 16000, lines: 220 },
      doctor: { bytes: 7000, lines: 80 },
      onboarding: { bytes: 9000, lines: 120 },
      researchStart: { bytes: 12000, lines: 160 },
      log: { bytes: 10000, lines: 140 },
      finalizePreview: { bytes: 11000, lines: 150 },
      finalizeCurrentTree: { bytes: 11000, lines: 150 },
    },
  },
  "long-history": {
    totalEntries: 5001,
    retainedEntries: 5000,
    governingConfig: { type: "config", metricName: "seconds" },
    retainedAnchors: [
      { type: "run", run: 2, status: "measure", metric: 4998 },
      { type: "run", run: 4999, status: "keep", metric: 1 },
      { type: "run", run: 5000, status: "checks_failed" },
    ],
    responseKeys: ["ok", "output", "summary"],
    responseBytes: 3000,
  },
};

test("every portable case rejects realistic faulty public-output facts with a stable code", () => {
  const faulty: Record<OperatorTaskCase, Record<string, unknown>> = {
    "decision-consistency": {
      ...validObservations["decision-consistency"],
      terminalActions: [{ ...action }, { ...action }, { ...action, safeAction: "setup-plan" }],
    },
    "invalid-cli": {
      exitCode: 1,
      stdoutBytes: 0,
      stderrBytes: 240,
      diagnostic: "Error: startup failed\n    at load (internal.mjs:1:1)",
    },
    "installed-cache-discovery": {
      selectedInstalledRuntime: "fresh",
      selectedProvenanceStatus: "selected",
      ambiguousInstalledRuntime: "fresh",
      ambiguousProvenanceStatus: "selected",
      candidateCount: 1,
    },
    "hostile-finalization": {
      ...validObservations["hostile-finalization"],
      after: { ...repoSnapshot, head: "mutated\n" },
    },
    "session-friction-journey": {
      ...validObservations["session-friction-journey"],
      zeroRunActionKinds: ["metric-saturation", "finalization", "finalization"],
      zeroRunActionCommands: [
        "node scripts/autoresearch.mjs finalize-preview --cwd <project>",
        "node scripts/autoresearch.mjs finalize-preview --cwd <project>",
        "node scripts/autoresearch.mjs finalize-preview --cwd <project>",
      ],
      rawChecklistAccepted: true,
    },
    "output-budgets": {
      outputs: {
        compact: { bytes: 10_241, lines: 120 },
        state: { bytes: 16000, lines: 220 },
        doctor: { bytes: 7000, lines: 80 },
        onboarding: { bytes: 9000, lines: 120 },
        researchStart: { bytes: 12000, lines: 160 },
        log: { bytes: 10000, lines: 140 },
        finalizePreview: { bytes: 11000, lines: 150 },
        finalizeCurrentTree: { bytes: 11000, lines: 150 },
      },
    },
    "long-history": {
      ...validObservations["long-history"],
      retainedAnchors: [
        { type: "run", run: 3, status: "keep", metric: 4997 },
        { type: "run", run: 4999, status: "keep", metric: 1 },
        { type: "run", run: 5000, status: "checks_failed" },
      ],
    },
  };

  for (const caseName of OPERATOR_TASK_CASES) {
    assert.throws(
      () => validateOperatorTaskEvidence(evidence(caseName, faulty[caseName])),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === OPERATOR_TASK_FAILURE_CODES[caseName],
      caseName,
    );
  }
});

test("the deterministic seven-case output fixture parses with exact case and summary reconciliation", () => {
  const records = OPERATOR_TASK_CASES.map((caseName) =>
    evidence(caseName, validObservations[caseName]),
  );
  const output = [
    ...records.map((record) => `EVIDENCE ${JSON.stringify(record)}`),
    `EVIDENCE_SUMMARY ${JSON.stringify({
      schemaVersion: 1,
      suite: OPERATOR_TASK_SUITE,
      status: "pass",
      tasks: 7,
      passed: 7,
      failed: 0,
    })}`,
  ].join("\n");
  const parsed = parseOperatorTaskEvidence(output);
  assert.deepEqual(
    parsed.evidence.map((record) => record.case),
    OPERATOR_TASK_CASES,
  );
  assert.equal(parsed.summary.status, "pass");

  const liveOutput = `${output}\nMETRIC operator_task_failures=0\nMETRIC operator_tasks=7\nMETRIC operator_tasks_passed=7`;
  assert.equal(validateOperatorTaskRunOutput(liveOutput).summary.status, "pass");
  assert.throws(() => validateOperatorTaskRunOutput(""), /exactly one EVIDENCE_SUMMARY/);
  assert.throws(
    () => validateOperatorTaskRunOutput(liveOutput.replace("operator_tasks=7", "operator_tasks=6")),
    /metrics do not reconcile/,
  );

  assert.throws(
    () => parseOperatorTaskEvidence(output.replace('"tasks":7', '"tasks":6')),
    /summary is inconsistent/,
  );
  assert.throws(
    () =>
      parseOperatorTaskEvidence(
        output.replace(
          `EVIDENCE ${JSON.stringify(records[1])}`,
          `EVIDENCE ${JSON.stringify(evidence("decision-consistency", validObservations["decision-consistency"]))}`,
        ),
      ),
    /summary is inconsistent/,
  );
  assert.throws(
    () => parseOperatorTaskEvidence(`${output}\n${output.match(/^EVIDENCE_SUMMARY .*$/m)?.[0]}`),
    /exactly one EVIDENCE_SUMMARY/,
  );
});

function evidence(caseName: OperatorTaskCase, observations: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    suite: OPERATOR_TASK_SUITE,
    case: caseName,
    status: "pass",
    observations,
  };
}
