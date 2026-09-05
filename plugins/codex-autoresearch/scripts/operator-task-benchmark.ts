#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import { defaultCommandShell, renderShellCommand } from "../lib/command-rendering.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";

export const OPERATOR_TASK_SUITE = "v2.7-operator-tasks" as const;
export const OPERATOR_TASK_CASES = [
  "decision-consistency",
  "invalid-cli",
  "installed-cache-discovery",
  "hostile-finalization",
  "session-friction-journey",
  "output-budgets",
  "long-history",
] as const;

export type OperatorTaskCase = (typeof OPERATOR_TASK_CASES)[number];
export type OperatorTaskEvidence = {
  schemaVersion: 1;
  suite: typeof OPERATOR_TASK_SUITE;
  case: OperatorTaskCase;
  status: "pass" | "fail";
  observations: Record<string, unknown>;
};

export const OPERATOR_TASK_OUTPUT_CEILINGS = {
  compact: { bytes: 10_240, lines: 200 },
  state: { bytes: 20_480, lines: 260 },
  doctor: { bytes: 8_192, lines: 100 },
  onboarding: { bytes: 12_288, lines: 180 },
  researchStart: { bytes: 16_384, lines: 220 },
  log: { bytes: 16_384, lines: 220 },
  finalizePreview: { bytes: 16_384, lines: 260 },
  finalizeCurrentTree: { bytes: 16_384, lines: 260 },
} as const;

export const OPERATOR_TASK_FAILURE_CODES: Record<OperatorTaskCase, string> = {
  "decision-consistency": "V27_DECISION_DIVERGENCE",
  "invalid-cli": "V27_INVALID_CLI_ACCEPTED",
  "installed-cache-discovery": "V27_CACHE_DISCOVERY_UNSAFE",
  "hostile-finalization": "V27_FINALIZER_MUTATED_REPO",
  "session-friction-journey": "V27_SESSION_FRICTION_REGRESSION",
  "output-budgets": "V27_OUTPUT_BUDGET_EXCEEDED",
  "long-history": "V27_LONG_HISTORY_ANCHOR_MISSING",
};

type ProcessResult = { code: number; stdout: string; stderr: string };
type EvidenceSummary = {
  schemaVersion: 1;
  suite: typeof OPERATOR_TASK_SUITE;
  status: "pass" | "fail";
  tasks: number;
  passed: number;
  failed: number;
};

const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const finalizer = path.join(pluginRoot, "scripts", "finalize-autoresearch.mjs");

export function validateOperatorTaskEvidence(value: unknown): OperatorTaskEvidence {
  const record = asRecord(value, "evidence");
  if (record.schemaVersion !== 1 || record.suite !== OPERATOR_TASK_SUITE) {
    throw new Error("Operator-task evidence has an unsupported schema or suite.");
  }
  if (!OPERATOR_TASK_CASES.includes(record.case as OperatorTaskCase)) {
    throw new Error(`Unknown operator-task case: ${String(record.case)}`);
  }
  if (record.status !== "pass" && record.status !== "fail") {
    throw new Error("Operator-task evidence status must be pass or fail.");
  }
  const evidence = record as OperatorTaskEvidence;
  if (evidence.status === "fail") {
    const observations = asRecord(evidence.observations, `${evidence.case} observations`);
    requireString(observations, "error");
    if (observations.failureCode !== OPERATOR_TASK_FAILURE_CODES[evidence.case]) {
      throw new Error(`${evidence.case} failure evidence is missing its stable failure code.`);
    }
    return evidence;
  }
  try {
    const observations = asRecord(evidence.observations, `${evidence.case} observations`);
    observationValidators[evidence.case](observations);
  } catch (error) {
    if ((error as { code?: unknown })?.code === OPERATOR_TASK_FAILURE_CODES[evidence.case]) {
      throw error;
    }
    failCase(
      evidence.case,
      error instanceof Error ? error.message : `${evidence.case} observations are invalid.`,
    );
  }
  return evidence;
}

export function parseOperatorTaskEvidence(output: string): {
  evidence: OperatorTaskEvidence[];
  summary: EvidenceSummary;
} {
  const evidence = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("EVIDENCE "))
    .map((line) => validateOperatorTaskEvidence(JSON.parse(line.slice("EVIDENCE ".length))));
  const summaryLines = output.split(/\r?\n/).filter((line) => line.startsWith("EVIDENCE_SUMMARY "));
  if (summaryLines.length !== 1) {
    throw new Error("Operator-task output must contain exactly one EVIDENCE_SUMMARY.");
  }
  const summaryLine = summaryLines[0];
  const summary = asRecord(
    JSON.parse(summaryLine.slice("EVIDENCE_SUMMARY ".length)),
    "evidence summary",
  );
  const passed = evidence.filter((record) => record.status === "pass").length;
  const failed = evidence.length - passed;
  if (
    summary.schemaVersion !== 1 ||
    summary.suite !== OPERATOR_TASK_SUITE ||
    (summary.status !== "pass" && summary.status !== "fail") ||
    !Number.isInteger(summary.tasks) ||
    !Number.isInteger(summary.passed) ||
    !Number.isInteger(summary.failed) ||
    JSON.stringify(evidence.map((record) => record.case)) !== JSON.stringify(OPERATOR_TASK_CASES) ||
    Number(summary.tasks) !== evidence.length ||
    Number(summary.passed) !== passed ||
    Number(summary.failed) !== failed ||
    summary.status !== (failed === 0 ? "pass" : "fail")
  ) {
    throw new Error("Operator-task evidence summary is inconsistent.");
  }
  return { evidence, summary: summary as EvidenceSummary };
}

export function validateOperatorTaskRunOutput(
  output: string,
): ReturnType<typeof parseOperatorTaskEvidence> {
  const parsed = parseOperatorTaskEvidence(output);
  const metrics = output.split(/\r?\n/).filter((line) => line.startsWith("METRIC operator_task"));
  const expected = [
    "METRIC operator_task_failures=0",
    `METRIC operator_tasks=${OPERATOR_TASK_CASES.length}`,
    `METRIC operator_tasks_passed=${OPERATOR_TASK_CASES.length}`,
  ];
  if (JSON.stringify(metrics) !== JSON.stringify(expected) || parsed.summary.status !== "pass") {
    throw new Error("Operator-task metrics do not reconcile with the live evidence summary.");
  }
  return parsed;
}

const observationValidators: Record<
  OperatorTaskCase,
  (observations: Record<string, unknown>) => void
> = {
  "decision-consistency": (observations) => {
    const firstUse = asRecord(observations.firstUse, "first-use routing");
    if (
      firstUse.completeDisposition !== "run-loop" ||
      firstUse.completeSessionRelation !== "none" ||
      firstUse.incompleteDisposition !== "needs-user" ||
      firstUse.discoveryMode !== "read-only" ||
      firstUse.discoveryAccepted !== false ||
      JSON.stringify(firstUse.discoveryFields) !== JSON.stringify(["checks_command", "scope"]) ||
      firstUse.createdFiles !== false
    ) {
      failCase(
        "decision-consistency",
        "First-use routing did not produce an actionable unaccepted contract.",
      );
    }
    const terminalPlans = asRecordArray(observations.terminalPlans, "terminal decision plans");
    const dashboardPlan = asRecord(observations.dashboardPlan, "dashboard decision plan");
    const [terminalPlan] = terminalPlans;
    if (
      terminalPlans.length !== 3 ||
      terminalPlans.some(
        (plan) =>
          !string(plan.decisionId) ||
          !string(plan.generationId) ||
          !string(plan.phase) ||
          !string(plan.actionKind) ||
          !string(plan.commandDigest),
      ) ||
      new Set(terminalPlans.map((plan) => JSON.stringify(plan))).size !== 1 ||
      JSON.stringify(dashboardPlan) !== JSON.stringify(terminalPlan) ||
      observations.dashboardCommandOmitted !== true
    ) {
      failCase("decision-consistency", "Public decision surfaces diverged.");
    }
  },
  "invalid-cli": (observations) => {
    const diagnostic = String(observations.diagnostic || "");
    if (
      observations.exitCode !== 1 ||
      !/^Unknown command: not-a-real-command\b/.test(diagnostic) ||
      diagnostic.split("\n").some((line) => line.trimStart().startsWith("at "))
    ) {
      failCase("invalid-cli", "Invalid public CLI input was not rejected with a diagnostic.");
    }
  },
  "installed-cache-discovery": (observations) => {
    if (
      observations.selectedInstalledRuntime !== "fresh" ||
      observations.selectedProvenanceStatus !== "selected" ||
      observations.ambiguousInstalledRuntime !== "unavailable" ||
      observations.ambiguousProvenanceStatus !== "ambiguous" ||
      observations.candidateCount !== 2
    ) {
      failCase("installed-cache-discovery", "Installed-cache discovery did not fail closed.");
    }
  },
  "hostile-finalization": (observations) => {
    const expectedPaths = stringArray(observations.expectedPaths, "expected hostile paths");
    const plannedPaths = stringArray(observations.plannedPaths, "planned hostile paths");
    if (
      expectedPaths.length !== 2 ||
      expectedPaths.some((file) => !plannedPaths.includes(file)) ||
      stringArray(observations.generatedBranches, "generated finalization branches").some(
        (branch) => !branch || branch.endsWith(".") || branch.endsWith(".lock"),
      ) ||
      stringArray(observations.invalidBranches, "invalid finalization branches").length > 0 ||
      observations.staleExitCode === 0 ||
      !/stale finalization plan|fingerprint does not match/i.test(
        String(observations.staleDiagnostic || ""),
      ) ||
      JSON.stringify(observations.before) !== JSON.stringify(observations.after)
    ) {
      failCase("hostile-finalization", "Rejected finalization changed repository state.");
    }
  },
  "session-friction-journey": (observations) => {
    const actionKinds = stringArray(observations.zeroRunActionKinds, "zero-run action kinds");
    const decisionIds = stringArray(observations.zeroRunDecisionIds, "zero-run decision IDs");
    const incompleteMissing = stringArray(
      observations.incompleteLoopMissing,
      "incomplete loop missing fields",
    );
    const forbidden = /finaliz|saturat|segment-transition/i;
    if (
      observations.directFitDisposition !== "continue-direct" ||
      observations.incompleteFitDisposition !== "needs-user" ||
      JSON.stringify(incompleteMissing) !==
        JSON.stringify(["direction", "checks_command", "scope"]) ||
      observations.fitCallsCreatedFiles !== false ||
      observations.runs !== 0 ||
      actionKinds.length !== 3 ||
      actionKinds.some((kind) => !kind || forbidden.test(kind)) ||
      new Set(actionKinds).size !== 1 ||
      decisionIds.length !== 3 ||
      decisionIds.some((decisionId) => !decisionId) ||
      new Set(decisionIds).size !== 1 ||
      observations.canMarkCodexGoalComplete !== false ||
      observations.rawChecklistAccepted === true ||
      observations.generatedGitAttributes === true
    ) {
      failCase(
        "session-friction-journey",
        "Fit routing or the zero-run qualitative journey permits session leakage or premature completion.",
      );
    }
  },
  "output-budgets": (observations) => {
    const outputs = asRecord(observations.outputs, "output measurements");
    for (const [name, ceiling] of Object.entries(OPERATOR_TASK_OUTPUT_CEILINGS)) {
      const measured = asRecord(outputs[name], `${name} output measurement`);
      if (
        !nonNegativeInteger(measured.bytes) ||
        !nonNegativeInteger(measured.lines) ||
        Number(measured.bytes) > ceiling.bytes ||
        Number(measured.lines) > ceiling.lines
      ) {
        failCase("output-budgets", `${name} output exceeded its release ceiling.`);
      }
    }
  },
  "long-history": (observations) => {
    const anchors = asRecordArray(observations.retainedAnchors, "retained history anchors");
    const [baseline, best, failure] = anchors;
    if (
      observations.totalEntries !== 5001 ||
      observations.retainedEntries !== 5000 ||
      asRecord(observations.governingConfig, "retained governing config").type !== "config" ||
      baseline?.run !== 2 ||
      baseline?.status !== "measure" ||
      baseline?.metric !== 4998 ||
      best?.run !== 4999 ||
      best?.status !== "keep" ||
      best?.metric !== 1 ||
      failure?.run !== 5000 ||
      failure?.status !== "checks_failed" ||
      stringArray(observations.responseKeys, "export response keys").includes("viewModel") ||
      !nonNegativeInteger(observations.responseBytes) ||
      Number(observations.responseBytes) > 12_000
    ) {
      failCase("long-history", "Long-history anchors or bounded response were not retained.");
    }
  },
};

export async function runOperatorTaskSuite(): Promise<number> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-autoresearch-operator-tasks-"));
  const evidence: OperatorTaskEvidence[] = [];
  try {
    const cases: Array<[OperatorTaskCase, () => Promise<Record<string, unknown>>]> = [
      ["decision-consistency", () => decisionConsistency(tempRoot)],
      ["invalid-cli", invalidCli],
      ["installed-cache-discovery", () => installedCacheDiscovery(tempRoot)],
      ["hostile-finalization", () => hostileFinalization(tempRoot)],
      ["session-friction-journey", () => sessionFrictionJourney(tempRoot)],
      ["output-budgets", () => outputBudgets(tempRoot)],
      ["long-history", () => longHistory(tempRoot)],
    ];
    for (const [caseName, runCase] of cases) {
      let observations: Record<string, unknown> = {};
      try {
        observations = await runCase();
        const result: OperatorTaskEvidence = {
          schemaVersion: 1,
          suite: OPERATOR_TASK_SUITE,
          case: caseName,
          status: "pass",
          observations,
        };
        evidence.push(validateOperatorTaskEvidence(result));
      } catch (error) {
        evidence.push({
          schemaVersion: 1,
          suite: OPERATOR_TASK_SUITE,
          case: caseName,
          status: "fail",
          observations: {
            ...observations,
            failureCode: OPERATOR_TASK_FAILURE_CODES[caseName],
            error: sanitizeError(error, tempRoot),
          },
        });
      }
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  for (const record of evidence) console.log(`EVIDENCE ${JSON.stringify(record)}`);
  const failed = evidence.filter((record) => record.status === "fail").length;
  const summary: EvidenceSummary = {
    schemaVersion: 1,
    suite: OPERATOR_TASK_SUITE,
    status: failed === 0 ? "pass" : "fail",
    tasks: evidence.length,
    passed: evidence.length - failed,
    failed,
  };
  console.log(`EVIDENCE_SUMMARY ${JSON.stringify(summary)}`);
  console.log(`METRIC operator_task_failures=${failed}`);
  console.log(`METRIC operator_tasks=${evidence.length}`);
  console.log(`METRIC operator_tasks_passed=${evidence.length - failed}`);
  return process.argv.includes("--fail-on-failure") && failed > 0 ? 1 : 0;
}

async function decisionConsistency(root: string): Promise<Record<string, unknown>> {
  const cwd = path.join(root, "decision");
  const env = isolatedCodexHome(root, "decision-codex-home");
  await fsp.mkdir(cwd, { recursive: true });
  const startDoc = await fsp.readFile(path.join(pluginRoot, "docs", "start.md"), "utf8");
  const completePrompt = [...startDoc.matchAll(/```text\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .find((block) => block.includes("Benchmark:") && block.includes("Scope:"));
  if (!completePrompt) throw new Error("Start documentation has no complete first-use prompt.");
  const complete = expectJsonSuccess(
    await runNode(cli, ["prompt-plan", "--cwd", cwd, "--prompt", completePrompt], pluginRoot, env),
  );
  const incomplete = expectJsonSuccess(
    await runNode(
      cli,
      [
        "prompt-plan",
        "--cwd",
        cwd,
        "--prompt",
        "Run 5 measured iterations.\nBenchmark: npm test\nMetric: seconds, lower is better",
      ],
      pluginRoot,
      env,
    ),
  );
  const completeFit = asRecord(complete.fit, "complete first-use fit");
  const incompleteFit = asRecord(incomplete.fit, "incomplete first-use fit");
  const discovery = nestedRecord(incomplete, "nextAction", "discovery");
  const firstUse = {
    completeDisposition: completeFit.disposition,
    completeSessionRelation: completeFit.sessionRelation,
    incompleteDisposition: incompleteFit.disposition,
    discoveryMode: discovery.mode,
    discoveryAccepted: discovery.accepted,
    discoveryFields: discovery.fields,
    createdFiles: (await fsp.readdir(cwd)).length !== 0,
  };
  expectJsonSuccess(
    await runNode(
      cli,
      [
        "setup",
        "--cwd",
        cwd,
        "--name",
        "decision consistency",
        "--metric-name",
        "seconds",
        "--direction",
        "lower",
        "--benchmark-command",
        String(configRecord("decision consistency").benchmarkCommand),
        "--json",
      ],
      pluginRoot,
      env,
    ),
  );
  const compact = await runNode(cli, ["state", "--cwd", cwd, "--compact"], pluginRoot, env);
  const recommend = await runNode(
    cli,
    ["recommend-next", "--cwd", cwd, "--compact"],
    pluginRoot,
    env,
  );
  const doctor = await runNode(cli, ["doctor", "--cwd", cwd], pluginRoot, env);
  const dashboard = await runNode(cli, ["export", "--cwd", cwd, "--json-full"], pluginRoot, env);
  const payloads = [compact, recommend, doctor, dashboard].map(expectJsonSuccess);
  const plans = [
    asRecord(payloads[0].decisionPlanProjection, "state decision plan"),
    asRecord(payloads[1].decisionPlanProjection, "recommend decision plan"),
    asRecord(payloads[2].decisionPlanProjection, "doctor decision plan"),
    nestedRecord(payloads[3], "viewModel", "decisionPlanProjection"),
  ];
  const terminalPlans = plans.slice(0, 3).map(publicPlanFacts);
  const dashboardPlan = publicPlanFacts(plans[3]);
  return {
    terminalPlans,
    dashboardPlan,
    firstUse,
    dashboardCommandOmitted: !string(nestedRecord(plans[3], "action").command),
  };
}

function publicPlanFacts(plan: Record<string, unknown>): Record<string, unknown> {
  const action = asRecord(plan.action, "decision action");
  const parentDisposition = asRecord(plan.parentDisposition, "parent disposition");
  return {
    decisionId: plan.decisionId,
    generationId: plan.generationId,
    phase: plan.phase,
    actionKind: action.kind,
    primaryBlockerCode: plan.primaryBlockerCode ?? null,
    parentDisposition: parentDisposition.kind,
    contractDigest: plan.contractDigest,
    evaluatorIdentity: plan.evaluatorIdentity,
    commandDigest: action.commandDigest,
  };
}

async function invalidCli(): Promise<Record<string, unknown>> {
  const result = await runNode(cli, ["not-a-real-command"], pluginRoot);
  return {
    exitCode: result.code,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    diagnostic: normalizePublicText(`${result.stdout}${result.stderr}`, pluginRoot).slice(0, 1_000),
  };
}

async function installedCacheDiscovery(root: string): Promise<Record<string, unknown>> {
  const cwd = path.join(root, "runtime-session");
  const codexHome = path.join(root, "runtime-codex-home");
  await writeLedger(cwd, [configRecord("runtime discovery"), runRecord(1, 3, "measure")]);
  await writeRuntimeCandidate(codexHome, PLUGIN_VERSION);
  const selected = expectJsonSuccess(
    await runNode(cli, ["doctor", "--cwd", cwd, "--json-full"], pluginRoot, {
      ...process.env,
      CODEX_HOME: codexHome,
    }),
  );
  const selectedRuntime = asRecord(selected.runtimeDriftSummary, "selected runtime summary");

  const otherVersion = PLUGIN_VERSION === "2.5.9" ? "2.5.8" : "2.5.9";
  await writeRuntimeCandidate(codexHome, otherVersion);
  const ambiguous = expectJsonSuccess(
    await runNode(cli, ["doctor", "--cwd", cwd, "--json-full"], pluginRoot, {
      ...process.env,
      CODEX_HOME: codexHome,
    }),
  );
  const ambiguousRuntime = asRecord(ambiguous.runtimeDriftSummary, "ambiguous runtime summary");
  const provenance = asRecord(
    ambiguousRuntime.installedRuntimeProvenance,
    "installed runtime provenance",
  );
  return {
    selectedInstalledRuntime: selectedRuntime.installedRuntime,
    selectedProvenanceStatus: asRecord(
      selectedRuntime.installedRuntimeProvenance,
      "selected provenance",
    ).status,
    ambiguousInstalledRuntime: ambiguousRuntime.installedRuntime,
    ambiguousProvenanceStatus: provenance.status,
    candidateCount: Array.isArray(provenance.candidates) ? provenance.candidates.length : 0,
  };
}

async function hostileFinalization(root: string): Promise<Record<string, unknown>> {
  const repo = path.join(root, "finalization");
  const original = "src/app/(frontend)/old space 雪.txt";
  const current = "src/app/(frontend)/[...slug]/page.tsx";
  await fsp.mkdir(path.join(repo, path.dirname(original)), { recursive: true });
  await fsp.mkdir(path.join(repo, path.dirname(current)), { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "codex@example.invalid"]);
  await git(repo, ["config", "user.name", "Codex Test"]);
  await fsp.writeFile(path.join(repo, original), "base\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["switch", "-c", "codex/operator-evidence"]);
  await fsp.rename(path.join(repo, original), path.join(repo, current));
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "rename hostile path"]);
  const kept = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await writeLedger(repo, [
    configRecord("hostile finalization"),
    { ...runRecord(1, 1, "keep"), commit: kept.slice(0, 12) },
  ]);
  await git(repo, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
  await git(repo, ["commit", "-m", "log accepted evidence"]);

  const preview = expectJsonSuccess(
    await runNode(cli, ["finalize-preview", "--cwd", repo], pluginRoot),
  );
  const groups = asRecordArray(preview.groups, "finalization groups");
  const files = groups.flatMap((group) =>
    Array.isArray(group.files) ? group.files.map(String) : [],
  );
  const generatedBranches = groups.map((group) => String(group.branch || "")).filter(Boolean);
  const invalidBranches: string[] = [];
  for (const branch of generatedBranches) {
    const validation = await runProcess("git", ["check-ref-format", "--branch", branch], repo);
    if (validation.code !== 0) invalidBranches.push(branch);
  }
  const planPath = path.join(repo, ".git", "autoresearch", "operator-evidence-groups.json");
  await fsp.mkdir(path.dirname(planPath), { recursive: true });
  expectSuccess(
    await runNode(finalizer, ["plan", "--cwd", repo, "--output", planPath], pluginRoot),
  );
  const plan = JSON.parse(await fsp.readFile(planPath, "utf8")) as Record<string, unknown>;
  plan.goal = "tampered-after-plan";
  await fsp.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const before = await repoSnapshot(repo);
  const stale = await runNode(finalizer, ["--cwd", repo, planPath], pluginRoot);
  const after = await repoSnapshot(repo);
  return {
    expectedPaths: [original, current].sort(),
    plannedPaths: files.sort(),
    generatedBranches,
    invalidBranches,
    staleExitCode: stale.code,
    staleDiagnostic: normalizePublicText(stale.stderr, repo).slice(0, 1000),
    before,
    after,
  };
}

async function sessionFrictionJourney(root: string): Promise<Record<string, unknown>> {
  const cwd = path.join(root, "session-friction-journey");
  const env = isolatedCodexHome(root, "session-friction-codex-home");
  await fsp.mkdir(cwd, { recursive: true });
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "codex@example.invalid"]);
  await git(cwd, ["config", "user.name", "Codex Test"]);
  await fsp.writeFile(path.join(cwd, "README.md"), "# Fixture\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "base"]);

  const filesBeforeFit = (await fsp.readdir(cwd)).sort();
  const directFit = expectJsonSuccess(
    await runNode(
      cli,
      [
        "prompt-plan",
        "--cwd",
        cwd,
        "--prompt",
        "Review this product architecture and recommend the smallest direct correction.",
      ],
      pluginRoot,
      env,
    ),
  );
  const incompleteFit = expectJsonSuccess(
    await runNode(
      cli,
      [
        "prompt-plan",
        "--cwd",
        cwd,
        "--prompt",
        [
          "Run 5 repeated measured optimization iterations for checkout latency.",
          "Benchmark: node scripts/checkout-benchmark.mjs",
          "Metric: seconds",
        ].join("\n"),
      ],
      pluginRoot,
      env,
    ),
  );
  const filesAfterFit = (await fsp.readdir(cwd)).sort();

  expectJsonSuccess(
    await runNode(
      cli,
      [
        "research-start",
        "--cwd",
        cwd,
        "--slug",
        "lighthouse-diagnostics",
        "--goal",
        "Resolve site-owned Lighthouse diagnostics",
        "--no-baseline-log",
        "--json",
      ],
      pluginRoot,
      env,
    ),
  );
  const gapsPath = path.join(
    cwd,
    "autoresearch.research",
    "lighthouse-diagnostics",
    "quality-gaps.md",
  );
  const rawGaps = await fsp.readFile(gapsPath, "utf8");
  await fsp.writeFile(gapsPath, rawGaps.replaceAll("- [ ]", "- [x]"));

  const results = [
    await runNode(cli, ["state", "--cwd", cwd, "--json-full"], pluginRoot, env),
    await runNode(cli, ["recommend-next", "--cwd", cwd, "--compact"], pluginRoot, env),
    await runNode(cli, ["doctor", "--cwd", cwd, "--json-full"], pluginRoot, env),
  ];
  const payloads = results.map(expectJsonSuccess);
  const plans = payloads.map((payload) =>
    asRecord(payload.decisionPlanProjection || payload.decisionPlan, "decision plan"),
  );
  const goal = expectJsonSuccess(
    await runNode(
      cli,
      [
        "codex-goal-brief",
        "--cwd",
        cwd,
        "--codex-goal-status",
        "active",
        "--completion-confirmed",
        "--completion-evidence",
        "All visible Markdown boxes are checked",
      ],
      pluginRoot,
      env,
    ),
  );
  const state = payloads[0];
  const qualityRound = asRecord(state.qualityRound || {}, "quality round");
  const status = await git(cwd, ["status", "--porcelain=v1"]);
  const directFitDecision = asRecord(directFit.fit, "direct fit decision");
  const incompleteFitDecision = asRecord(incompleteFit.fit, "incomplete fit decision");
  return {
    directFitDisposition: String(directFitDecision.disposition || ""),
    incompleteFitDisposition: String(incompleteFitDecision.disposition || ""),
    incompleteLoopMissing: stringArray(incompleteFitDecision.missing, "missing contract fields"),
    fitCallsCreatedFiles: JSON.stringify(filesBeforeFit) !== JSON.stringify(filesAfterFit),
    runs: Number(state.runs || 0),
    zeroRunActionKinds: plans.map((plan) => String(nestedRecord(plan, "action").kind || "")),
    zeroRunDecisionIds: plans.map((plan) => String(plan.decisionId || "")),
    canMarkCodexGoalComplete: nestedRecord(goal, "completionAudit").canMarkCodexGoalComplete,
    rawChecklistAccepted:
      qualityRound.accepted === true || qualityRound.evidenceStatus === "accepted",
    generatedGitAttributes: status.stdout
      .split(/\r?\n/)
      .some((line) => line.trim().endsWith(".gitattributes")),
  };
}

async function outputBudgets(root: string): Promise<Record<string, unknown>> {
  const cwd = path.join(root, "output-budgets");
  const records: Record<string, unknown>[] = [configRecord("output budgets")];
  for (let run = 1; run <= 100; run += 1) {
    records.push({
      ...runRecord(run, 101 - run, run === 1 ? "measure" : "keep"),
      description: `Run ${run}: ${"bounded evidence ".repeat(80)}`,
    });
  }
  await writeLedger(cwd, records);
  const env = isolatedCodexHome(root, "budget-codex-home");
  const compact = await runNode(cli, ["state", "--cwd", cwd, "--compact"], pluginRoot, env);
  const state = await runNode(cli, ["state", "--cwd", cwd], pluginRoot, env);
  const doctor = await runNode(cli, ["doctor", "--cwd", cwd], pluginRoot, env);
  const onboarding = await runNode(
    cli,
    ["onboarding-packet", "--cwd", cwd, "--compact"],
    pluginRoot,
    env,
  );

  const mutationCwd = path.join(root, "mutation-output-budgets");
  await fsp.mkdir(mutationCwd, { recursive: true });
  const researchStart = await runNode(
    cli,
    [
      "research-start",
      "--cwd",
      mutationCwd,
      "--slug",
      "bounded-output",
      "--goal",
      "Keep mutation responses bounded",
      "--no-baseline-log",
      "--json",
    ],
    pluginRoot,
    env,
  );
  const log = await runNode(
    cli,
    [
      "log",
      "--cwd",
      mutationCwd,
      "--metric",
      "6",
      "--status",
      "measure",
      "--description",
      "Bounded manual baseline",
    ],
    pluginRoot,
    env,
  );

  const finalizeCwd = path.join(root, "finalize-output-budgets");
  await fsp.mkdir(finalizeCwd, { recursive: true });
  await git(finalizeCwd, ["init", "-b", "main"]);
  await git(finalizeCwd, ["config", "user.email", "codex@example.invalid"]);
  await git(finalizeCwd, ["config", "user.name", "Codex Test"]);
  await fsp.writeFile(path.join(finalizeCwd, "app.txt"), "base\n");
  await git(finalizeCwd, ["add", "app.txt"]);
  await git(finalizeCwd, ["commit", "-m", "base"]);
  await git(finalizeCwd, ["switch", "-c", "codex/output-budgets"]);
  await fsp.writeFile(path.join(finalizeCwd, "app.txt"), "improved\n");
  await git(finalizeCwd, ["add", "app.txt"]);
  await git(finalizeCwd, ["commit", "-m", "improve app"]);
  const acceptedCommit = (await git(finalizeCwd, ["rev-parse", "HEAD"])).stdout.trim();
  const evaluatorDirectory = ".operator-finalization";
  const evaluatorPath = path.join(evaluatorDirectory, "evaluator.mjs");
  const checksPath = path.join(evaluatorDirectory, "checks.mjs");
  await fsp.mkdir(path.join(finalizeCwd, evaluatorDirectory), { recursive: true });
  await fsp.writeFile(
    path.join(finalizeCwd, evaluatorPath),
    [
      'import { readFileSync } from "node:fs";',
      'const value = readFileSync("app.txt", "utf8").trim();',
      'console.log(`METRIC seconds=${value === "base" ? 2 : 1}`);',
      "",
    ].join("\n"),
  );
  await fsp.writeFile(path.join(finalizeCwd, checksPath), "process.exit(0);\n");
  await fsp.appendFile(
    path.join(finalizeCwd, ".git", "info", "exclude"),
    `\nautoresearch*\n${evaluatorDirectory}/\n`,
  );
  const commandShell = defaultCommandShell();
  const benchmarkCommand = renderShellCommand([process.execPath, evaluatorPath], commandShell);
  const checksCommand = renderShellCommand([process.execPath, checksPath], commandShell);
  expectJsonSuccess(
    await runNode(
      cli,
      [
        "setup",
        "--cwd",
        finalizeCwd,
        "--name",
        "finalization output budgets",
        "--goal",
        "Keep finalization responses bounded",
        "--metric-name",
        "seconds",
        "--direction",
        "lower",
        "--benchmark-command",
        benchmarkCommand,
        "--checks-command",
        checksCommand,
        "--shell",
        commandShell,
        "--scope",
        "app.txt",
        "--commit-paths",
        "app.txt",
        "--max-iterations",
        "4",
        "--packet-budget",
        "4",
      ],
      pluginRoot,
      env,
    ),
  );
  const acceptedConfigPath = path.join(finalizeCwd, "autoresearch.config.json");
  const acceptedConfig = JSON.parse(await fsp.readFile(acceptedConfigPath, "utf8"));
  await fsp.writeFile(
    acceptedConfigPath,
    `${JSON.stringify(
      {
        ...acceptedConfig,
        checkImplementationPaths: [checksPath],
        checksAuthoritative: true,
        noiseModel: { kind: "deterministic" },
        protectedBenchmarkPaths: [evaluatorPath, checksPath],
      },
      null,
      2,
    )}\n`,
  );
  expectJsonSuccess(
    await runNode(
      cli,
      [
        "new-segment",
        "--cwd",
        finalizeCwd,
        "--reason",
        "Accept the output-budget evaluator",
        "--yes",
      ],
      pluginRoot,
      env,
    ),
  );
  await fsp.writeFile(path.join(finalizeCwd, "app.txt"), "base\n");
  expectJsonSuccess(await runNode(cli, ["next", "--cwd", finalizeCwd], pluginRoot, env));
  expectJsonSuccess(
    await runNode(
      cli,
      [
        "log",
        "--cwd",
        finalizeCwd,
        "--from-last",
        "--status",
        "measure",
        "--description",
        "Accepted output-budget baseline",
      ],
      pluginRoot,
      env,
    ),
  );
  await fsp.writeFile(path.join(finalizeCwd, "app.txt"), "improved\n");
  expectJsonSuccess(await runNode(cli, ["next", "--cwd", finalizeCwd], pluginRoot, env));
  expectJsonSuccess(
    await runNode(
      cli,
      [
        "log",
        "--cwd",
        finalizeCwd,
        "--from-last",
        "--status",
        "keep",
        "--commit",
        acceptedCommit,
        "--description",
        "Accepted output-budget candidate",
      ],
      pluginRoot,
      env,
    ),
  );
  await fsp.writeFile(path.join(finalizeCwd, "app.txt"), "final current tree\n");
  await git(finalizeCwd, ["add", "app.txt"]);
  await git(finalizeCwd, ["commit", "-m", "advance current final tree"]);
  expectJsonSuccess(
    await runNode(
      cli,
      [
        "new-segment",
        "--cwd",
        finalizeCwd,
        "--reason",
        "Accept evaluator authority at the current final tree",
        "--yes",
      ],
      pluginRoot,
      env,
    ),
  );
  const finalizePreview = await runNode(
    cli,
    ["finalize-preview", "--cwd", finalizeCwd],
    pluginRoot,
    env,
  );
  const finalizeCurrentTree = await runNode(
    cli,
    ["finalize-current-tree", "--cwd", finalizeCwd, "--exclude-session-artifacts"],
    pluginRoot,
    env,
  );
  for (const result of [
    compact,
    state,
    doctor,
    onboarding,
    researchStart,
    log,
    finalizePreview,
    finalizeCurrentTree,
  ])
    expectJsonSuccess(result);
  const compactSize = outputSize(`${compact.stdout}${compact.stderr}`);
  const stateSize = outputSize(`${state.stdout}${state.stderr}`);
  const doctorSize = outputSize(`${doctor.stdout}${doctor.stderr}`);
  const onboardingSize = outputSize(`${onboarding.stdout}${onboarding.stderr}`);
  const researchStartSize = outputSize(`${researchStart.stdout}${researchStart.stderr}`);
  const logSize = outputSize(`${log.stdout}${log.stderr}`);
  const finalizePreviewSize = outputSize(`${finalizePreview.stdout}${finalizePreview.stderr}`);
  const finalizeCurrentTreeSize = outputSize(
    `${finalizeCurrentTree.stdout}${finalizeCurrentTree.stderr}`,
  );
  return {
    outputs: {
      compact: compactSize,
      state: stateSize,
      doctor: doctorSize,
      onboarding: onboardingSize,
      researchStart: researchStartSize,
      log: logSize,
      finalizePreview: finalizePreviewSize,
      finalizeCurrentTree: finalizeCurrentTreeSize,
    },
  };
}

async function longHistory(root: string): Promise<Record<string, unknown>> {
  const cwd = path.join(root, "long-history");
  const records: Record<string, unknown>[] = [configRecord("long history")];
  for (let run = 1; run <= 5000; run += 1) {
    records.push(
      run === 1
        ? { ...runRecord(run, null, "crash"), description: "Disposable early failure" }
        : run === 5000
          ? { ...runRecord(run, null, "checks_failed"), description: "Newest failed run" }
          : runRecord(run, 5000 - run, run === 2 ? "measure" : "keep"),
    );
  }
  await writeLedger(cwd, records);
  const output = path.join(cwd, "dashboard.html");
  const result = await runNode(
    cli,
    ["export", "--cwd", cwd, "--output", output],
    pluginRoot,
    isolatedCodexHome(root, "history-codex-home"),
  );
  const response = expectJsonSuccess(result);
  const html = await fsp.readFile(output, "utf8");
  const entries = embeddedJsonArray(html, "window.__AUTORESEARCH_DATA__ = ");
  const meta = embeddedJsonRecord(html, "window.__AUTORESEARCH_META__ = ");
  const bounds = asRecord(meta.ledgerBounds, "ledger bounds");
  const responseBytes = Buffer.byteLength(result.stdout, "utf8");
  const retainedAnchors = [2, 4999, 5000].map(
    (run) => entries.find((entry) => asRecord(entry, "retained entry").run === run) ?? null,
  );
  const governingConfig = asRecord(entries[0], "first retained entry");
  return {
    totalEntries: Number(bounds.totalEntries),
    retainedEntries: entries.length,
    governingConfig: { type: governingConfig.type, metricName: governingConfig.metricName },
    retainedAnchors,
    responseKeys: Object.keys(response).sort(),
    responseBytes,
  };
}

function configRecord(name: string): Record<string, unknown> {
  return {
    type: "config",
    name,
    goal: `Verify ${name}.`,
    metricName: "seconds",
    metricUnit: "s",
    bestDirection: "lower",
    benchmarkCommand: `${process.execPath} -e "console.log('METRIC seconds=1')"`,
  };
}

function runRecord(run: number, metric: number | null, status: string): Record<string, unknown> {
  return {
    type: "run",
    run,
    status,
    ...(metric == null ? {} : { metric }),
    description: `Operator evidence run ${run}`,
  };
}

async function writeLedger(cwd: string, records: Record<string, unknown>[]): Promise<void> {
  await fsp.mkdir(cwd, { recursive: true });
  const config = records.find((record) => record.type === "config");
  if (config) {
    const { type: _type, ...persistedConfig } = config;
    await fsp.writeFile(
      path.join(cwd, "autoresearch.config.json"),
      `${JSON.stringify(persistedConfig, null, 2)}\n`,
    );
  }
  await fsp.writeFile(
    path.join(cwd, "autoresearch.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

async function writeRuntimeCandidate(codexHome: string, version: string): Promise<void> {
  const candidate = path.join(
    codexHome,
    "plugins",
    "cache",
    "TheGreenCedar",
    "codex-autoresearch",
    version,
  );
  await fsp.mkdir(path.join(candidate, ".codex-plugin"), { recursive: true });
  await fsp.mkdir(path.join(candidate, "dist", "scripts"), { recursive: true });
  await fsp.writeFile(
    path.join(candidate, "package.json"),
    JSON.stringify({ name: "codex-autoresearch", version }),
  );
  await fsp.writeFile(
    path.join(candidate, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "codex-autoresearch",
      version,
      repository: "https://github.com/TheGreenCedar/codex-autoresearch",
    }),
  );
  await fsp.copyFile(
    path.join(pluginRoot, "dist", "scripts", "autoresearch.mjs"),
    path.join(candidate, "dist", "scripts", "autoresearch.mjs"),
  );
}

async function repoSnapshot(repo: string): Promise<Record<string, unknown>> {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const refs = await git(repo, ["show-ref"]);
  const porcelain = await git(repo, ["status", "--porcelain=v1", "-z"]);
  const indexTree = await git(repo, ["write-tree"]);
  const stagedDiff = await git(repo, ["diff", "--cached", "--binary"]);
  const unstagedDiff = await git(repo, ["diff", "--binary"]);
  return {
    head: head.stdout,
    refs: refs.stdout,
    porcelain: porcelain.stdout,
    indexTree: indexTree.stdout,
    stagedDiff: stagedDiff.stdout,
    unstagedDiff: unstagedDiff.stdout,
    files: await workingTreeSnapshot(repo),
  };
}

async function workingTreeSnapshot(
  root: string,
  directory = root,
): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (directory === root && entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    const stats = await fsp.lstat(absolute);
    if (entry.isDirectory()) {
      records.push({ path: relative, type: "directory", mode: stats.mode });
      records.push(...(await workingTreeSnapshot(root, absolute)));
    } else if (entry.isSymbolicLink()) {
      records.push({
        path: relative,
        type: "symlink",
        mode: stats.mode,
        target: await fsp.readlink(absolute),
      });
    } else {
      const content = await fsp.readFile(absolute);
      records.push({
        path: relative,
        type: "file",
        mode: stats.mode,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  return records;
}

function isolatedCodexHome(root: string, name: string): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: path.join(root, name) };
}

async function git(cwd: string, args: string[]): Promise<ProcessResult> {
  const result = await runProcess("git", args, cwd, {
    ...process.env,
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  });
  return expectSuccess(result);
}

function runNode(
  script: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return runProcess(process.execPath, [script, ...args], cwd, env);
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error.message) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function expectSuccess(result: ProcessResult): ProcessResult {
  if (result.code !== 0) {
    throw new Error(`Command failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function expectJsonSuccess(result: ProcessResult): Record<string, unknown> {
  expectSuccess(result);
  return asRecord(JSON.parse(result.stdout), "command JSON response");
}

function outputSize(output: string): { bytes: number; lines: number } {
  const trimmed = output.trimEnd();
  return {
    bytes: Buffer.byteLength(trimmed, "utf8"),
    lines: trimmed ? trimmed.split(/\r?\n/).length : 0,
  };
}

function normalizePublicText(value: unknown, cwd: string): string {
  return String(value || "")
    .replaceAll(cwd, "<project>")
    .replaceAll(pluginRoot, "<plugin>")
    .replaceAll(process.execPath, "node");
}

function embeddedJsonArray(html: string, marker: string): unknown[] {
  const value = embeddedJson(html, marker);
  if (!Array.isArray(value)) throw new Error(`${marker.trim()} must contain an array.`);
  return value;
}

function embeddedJsonRecord(html: string, marker: string): Record<string, unknown> {
  return asRecord(embeddedJson(html, marker), marker.trim());
}

function embeddedJson(html: string, marker: string): unknown {
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Dashboard export is missing ${marker.trim()}.`);
  const valueStart = start + marker.length;
  const end = html.indexOf(";\n", valueStart);
  if (end < 0) throw new Error(`Dashboard export has an unterminated ${marker.trim()}.`);
  return JSON.parse(html.slice(valueStart, end));
}

function nestedRecord(value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return keys.reduce((current, key) => asRecord(current[key], keys.join(".")), value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => asRecord(item, `${label}[${index}]`));
}

function requireString(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "string" || !record[key].trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function failCase(caseName: OperatorTaskCase, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = OPERATOR_TASK_FAILURE_CODES[caseName];
  throw error;
}

function sanitizeError(error: unknown, tempRoot: string): string {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll(tempRoot, "<temp>")
    .replaceAll(pluginRoot, "<plugin>")
    .slice(0, 1000);
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) process.exitCode = await runOperatorTaskSuite();
