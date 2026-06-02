import assert from "node:assert/strict";
import test from "node:test";

import { resolveActionCommand } from "../lib/action-metadata.js";
import { buildCompactRecommendNextResponse } from "../lib/commands/recommend-next.js";
import { acceptedCurrentTreeFinalizationIssue } from "../lib/finalization-acceptance.js";
import { buildGoalFrame } from "../lib/goal-frame.js";
import { buildLaneLifecycle } from "../lib/lane-lifecycle.js";
import { buildLoopContractStatus, canonicalNextActionForLoop } from "../lib/loop-governance.js";
import { buildOperatorChecklist } from "../lib/operator-checklist.js";
import {
  buildSessionDecisionCapsule,
  matchDecisionRules,
} from "../lib/session-decision-capsule.js";

test("context distillation outranks next packet", () => {
  const action = canonicalNextActionForLoop({
    contextDistillation: {
      required: true,
      reason: "Compactions reached 89; refresh a context capsule before more packets.",
      command: "node scripts/autoresearch.mjs session-forensics --cwd . --dry-run",
    },
  });

  assert.equal(action.kind, "context-distillation");
  assert.match(action.reason, /Compactions reached 89/);
  assert.match(action.command, /session-forensics/);
});

test("stale lanes and runtime drift block before finalization pressure", () => {
  const action = canonicalNextActionForLoop({
    laneLifecycle: {
      staleLanes: [{ id: "scout-retrieval", status: "stale" }],
      recommendation: "Close or refresh stale lane scout-retrieval before another packet.",
    },
    runtimeProvenance: {
      drifted: true,
      reason: "Source version 2.0.1 differs from installed version 1.5.1.",
    },
    finalizationReadiness: { ready: true, nextAction: "Finalize reviewable kept work." },
  });

  assert.equal(action.kind, "lane-cleanup");
  assert.match(action.reason, /scout-retrieval/);
});

test("numeric loop priorities choose strongest action independent of append order", () => {
  const status = buildLoopContractStatus({
    laneLifecycle: { staleLanes: [{ id: "scout" }] },
    scaffoldHealth: { blockers: ["Wrapper recursion must be fixed."] },
  });

  assert.deepEqual(
    status.blockers.map((blocker) => blocker.kind),
    ["safety-blocker", "lane-cleanup"],
  );
  assert.equal(status.strongestAction?.kind, "safety-blocker");
});

test("partial salvage outranks fresh packet logging within packet brakes", () => {
  const status = buildLoopContractStatus({
    salvageCandidates: [
      {
        id: "artifact-1",
        status: "scored",
        score: 1,
        command: "node scripts/autoresearch.mjs partial-results --cwd . --record artifact-1",
      },
    ],
    latestPacketFreshness: {
      fresh: true,
      reason: "Record the fresh last-run packet before starting another packet.",
      command: "node scripts/autoresearch.mjs log --cwd . --from-last --status measure",
    },
  });

  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["partial-salvage", "log-decision"],
  );
  assert.equal(status.strongestAction?.kind, "partial-salvage");
});

test("fresh packet logging outranks generic preflight repair", () => {
  const status = buildLoopContractStatus({
    latestPacketFreshness: {
      fresh: true,
      reason: "Record the fresh last-run packet before starting another packet.",
      command: "node scripts/autoresearch.mjs log --cwd . --from-last --status measure",
    },
    preflight: {
      status: "blocked",
      blockers: ["Configured checks command is malformed."],
      nextCommand: "node scripts/autoresearch.mjs doctor --cwd . --explain",
    },
  });

  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["log-decision", "preflight"],
  );
  assert.equal(status.strongestAction?.kind, "log-decision");
});

test("probe-failed runtime provenance remains non-blocking", () => {
  const status = buildLoopContractStatus({
    runtimeProvenance: {
      status: "probe-failed",
      drifted: false,
      reason: "Runtime drift probe failed before source/runtime comparison.",
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.canRunNextPacket, true);
  assert.equal(status.blockers.length, 0);
});

test("hard decision capsules block generic packets and finalization pressure", () => {
  const status = buildLoopContractStatus({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "hard-block",
        canRunNextPacket: false,
        commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd .",
        triggeredBy: ["sessionDecisionCapsule", "benchmarkContract"],
      },
      nextExperiment: "Repair benchmark-lint until the primary METRIC is emitted.",
    },
    finalizationReadiness: { ready: true, nextAction: "Finalize reviewable kept work." },
  });

  assert.equal(status.ok, false);
  assert.equal(status.canRunNextPacket, false);
  assert.equal(status.blockers[0].kind, "decision-capsule");
  assert.match(status.blockers[0].reason, /benchmark-lint/);

  const action = canonicalNextActionForLoop({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "hard-block",
        canRunNextPacket: false,
        commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd .",
      },
      nextExperiment: "Repair benchmark-lint until the primary METRIC is emitted.",
    },
  });
  assert.equal(action.kind, "decision-capsule");
});

test("bounded-next decision capsules warn before generic next packets", () => {
  const status = buildLoopContractStatus({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "bounded-next",
        canRunNextPacket: false,
        allowBoundedNext: true,
        commandHint: "node scripts/autoresearch.mjs next --cwd . --timeout-seconds 30",
      },
      nextExperiment: "Measure initial search latency with a bounded packet.",
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.canRunNextPacket, false);
  assert.equal(status.warnings[0].kind, "decision-capsule");
  assert.match(status.warnings[0].command, /timeout-seconds/);
});

test("bounded-next decision capsules preserve independent gate and preflight blockers", () => {
  const status = buildLoopContractStatus({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "bounded-next",
        canRunNextPacket: false,
        allowBoundedNext: true,
        commandHint: "node scripts/autoresearch.mjs next --cwd . --timeout-seconds 30",
      },
      nextExperiment: "Measure initial search latency with a bounded packet.",
    },
    gateQuality: {
      posture: "missing",
      blockers: ["No independent checks gate is configured."],
    },
    preflight: {
      status: "blocked",
      blockers: ["No benchmark command is available for future packets."],
      nextCommand: "node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain",
    },
  });

  assert.equal(status.ok, false);
  assert.equal(status.canRunNextPacket, false);
  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["gate-quality", "preflight"],
  );
  assert.equal(status.warnings[0].kind, "decision-capsule");
});

test("hard decision capsules only suppress blockers with the same root cause", () => {
  const independentStatus = buildLoopContractStatus({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "hard-block",
        canRunNextPacket: false,
        commandHint: "node scripts/autoresearch.mjs promotion-gate --cwd . --dry-run",
        triggeredBy: ["promotionGate"],
      },
      nextExperiment: "Repair the promotion gate before finalizing.",
    },
    gateQuality: {
      posture: "blocked",
      blockers: ["No benchmark command is available for future packets."],
    },
  });

  assert.deepEqual(
    independentStatus.blockers.map((item) => item.kind),
    ["gate-quality", "decision-capsule"],
  );

  const duplicateStatus = buildLoopContractStatus({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "hard-block",
        canRunNextPacket: false,
        commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd .",
        triggeredBy: ["benchmarkContract"],
      },
      nextExperiment: "Repair benchmark-lint until the primary METRIC is emitted.",
    },
    preflight: {
      status: "blocked",
      blockers: ["No benchmark command is available for future packets."],
      nextCommand: "node scripts/autoresearch.mjs doctor --cwd . --check-benchmark --explain",
    },
  });

  assert.deepEqual(
    duplicateStatus.blockers.map((item) => item.kind),
    ["decision-capsule"],
  );
});

test("portfolio trust blockers do not outrank hard decision capsules", () => {
  const status = buildLoopContractStatus({
    portfolioRecommendation: {
      kind: "trust-blocker",
      reason: "Installed cache is stale.",
      nextActionHint: "Inspect installed cache.",
    },
    sessionDecisionCapsule: {
      enforcement: {
        mode: "hard-block",
        canRunNextPacket: false,
        commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd .",
        triggeredBy: ["benchmarkContract"],
      },
      nextExperiment: "Repair benchmark-lint until the primary METRIC is emitted.",
    },
  });

  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["decision-capsule"],
  );
  assert.equal(status.strongestAction?.kind, "decision-capsule");
});

test("hard decision capsules preserve independent gate-quality blocker categories", () => {
  const status = buildLoopContractStatus({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "hard-block",
        canRunNextPacket: false,
        commandHint: "node scripts/autoresearch.mjs promote-gate --cwd . --dry-run",
        triggeredBy: ["promotionGate"],
      },
      nextExperiment: "Repair the promotion gate before finalizing.",
    },
    gateQuality: {
      posture: "blocked",
      blockers: [
        "No independent checks gate is configured.",
        "Holdout gate has not passed.",
        "No benchmark command is available for future packets.",
        "Promotion gate has not passed.",
      ],
    },
  });

  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["gate-quality", "gate-quality", "gate-quality", "decision-capsule"],
  );
  assert.match(status.blockers[0].reason, /independent checks gate/);
  assert.match(status.blockers[1].reason, /Holdout gate/);
  assert.match(status.blockers[2].reason, /benchmark command/);

  for (const blocker of [
    "No independent checks gate is configured.",
    "Holdout gate has not passed.",
    "No benchmark command is available for future packets.",
  ]) {
    const independentStatus = buildLoopContractStatus({
      sessionDecisionCapsule: {
        enforcement: {
          mode: "hard-block",
          canRunNextPacket: false,
          commandHint: "node scripts/autoresearch.mjs promote-gate --cwd . --dry-run",
          triggeredBy: ["promotionGate"],
        },
        nextExperiment: "Repair the promotion gate before finalizing.",
      },
      gateQuality: {
        posture: "blocked",
        blockers: [blocker],
      },
    });

    assert.deepEqual(
      independentStatus.blockers.map((item) => item.kind),
      ["gate-quality", "decision-capsule"],
      blocker,
    );
  }
});

test("hard decision capsules suppress only exact structured trigger causes", () => {
  const status = buildLoopContractStatus({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "hard-block",
        canRunNextPacket: false,
        commandHint: "node scripts/autoresearch.mjs checks-gate --cwd . --dry-run",
        triggeredBy: ["checksGate"],
      },
      nextExperiment: "Repair the independent checks gate before another packet.",
    },
    gateQuality: {
      posture: "blocked",
      blockers: [
        "No independent checks gate is configured.",
        "Holdout gate has not passed.",
        "Promotion gate has not passed.",
        "No benchmark command is available for future packets.",
      ],
    },
  });

  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["gate-quality", "gate-quality", "gate-quality", "decision-capsule"],
  );
  assert.deepEqual(
    status.blockers.map((item) => item.reason),
    [
      "Holdout gate has not passed.",
      "Promotion gate has not passed.",
      "No benchmark command is available for future packets.",
      "Repair the independent checks gate before another packet.",
    ],
  );
});

test("hard decision capsules suppress only the matching structured gate cause", () => {
  const promotionDuplicate = buildLoopContractStatus({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "hard-block",
        canRunNextPacket: false,
        commandHint: "node scripts/autoresearch.mjs promote-gate --cwd . --dry-run",
        triggeredBy: ["promotionGate"],
      },
      nextExperiment: "Repair the promotion gate before finalizing.",
    },
    gateQuality: {
      posture: "blocked",
      blockers: ["Promotion gate has not passed."],
    },
  });

  assert.deepEqual(
    promotionDuplicate.blockers.map((item) => item.kind),
    ["decision-capsule"],
  );

  const holdoutStatus = buildLoopContractStatus({
    sessionDecisionCapsule: {
      enforcement: {
        mode: "hard-block",
        canRunNextPacket: false,
        commandHint: "node scripts/autoresearch.mjs holdout-gate --cwd . --dry-run",
        triggeredBy: ["holdoutGate"],
      },
      nextExperiment: "Repair the holdout gate before another packet.",
    },
    gateQuality: {
      posture: "blocked",
      blockers: ["Holdout gate has not passed."],
    },
  });

  assert.deepEqual(
    holdoutStatus.blockers.map((item) => item.kind),
    ["decision-capsule"],
  );
});

test("checked runtime provenance without drift remains non-blocking", () => {
  const status = buildLoopContractStatus({
    runtimeProvenance: {
      status: "checked",
      drifted: false,
      driftConfidence: "checked",
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.canRunNextPacket, true);
  assert.equal(status.blockers.length, 0);
});

test("stale installed runtime alone stays advisory for source checkout work", () => {
  const status = buildLoopContractStatus({
    runtimeProvenance: {
      status: "checked",
      installedRuntime: "stale",
      builtRuntime: "available",
      reason: "Installed cache is older than the local source checkout.",
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.canRunNextPacket, true);
  assert.equal(status.blockers.length, 0);
});

test("source or built runtime failures remain loop blockers", () => {
  const status = buildLoopContractStatus({
    runtimeProvenance: {
      status: "source-build-failed",
      builtRuntime: "missing",
      reason: "Built source runtime is missing; run the build before trusting this checkout.",
    },
  });

  assert.equal(status.ok, false);
  assert.equal(status.canRunNextPacket, false);
  assert.equal(status.blockers[0].kind, "runtime-provenance");
  assert.match(status.blockers[0].reason, /Built source runtime is missing/);
});

test("gate quality and preflight blockers prevent next packets", () => {
  const status = buildLoopContractStatus({
    gateQuality: {
      posture: "missing",
      blockers: ["No independent checks gate is configured."],
    },
    preflight: {
      status: "blocked",
      blockers: ["Configured checks command is malformed."],
      nextCommand: "node scripts/autoresearch.mjs doctor --cwd . --explain",
    },
  });

  assert.equal(status.ok, false);
  assert.equal(status.canRunNextPacket, false);
  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["gate-quality", "preflight"],
  );
  assert.match(status.strongestAction?.reason || "", /checks gate/);

  const action = canonicalNextActionForLoop({
    preflight: {
      status: "blocked",
      blockers: ["No benchmark command is available for the first packet."],
      nextCommand: "node scripts/autoresearch.mjs benchmark-lint --cwd .",
    },
  });
  assert.equal(action.kind, "preflight");
  assert.match(action.command, /benchmark-lint/);
});

test("last-run freshness does not suppress independent gate or preflight blockers", () => {
  const status = buildLoopContractStatus({
    latestPacketFreshness: {
      fresh: false,
      reason: "Last-run packet is stale.",
    },
    preflight: {
      status: "blocked",
      blockers: ["Configured checks command is malformed."],
      nextCommand: "node scripts/autoresearch.mjs doctor --cwd . --explain",
    },
  });

  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["preflight", "stale-packet"],
  );
  assert.equal(status.strongestAction?.kind, "preflight");
});

test("packet-brake blocker actions get non-next fallback commands", () => {
  const commands = {
    doctorExplain: "node scripts/autoresearch.mjs doctor --cwd C:/repo --check-benchmark --explain",
    doctor: "node scripts/autoresearch.mjs doctor --cwd C:/repo --explain",
    benchmarkLint: "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo",
    state: "node scripts/autoresearch.mjs state --cwd C:/repo --compact --report",
    finalizePreview: "node scripts/autoresearch.mjs finalize-preview --cwd C:/repo",
    finalizeCurrentTree:
      "node scripts/autoresearch.mjs finalize-current-tree --cwd C:/repo --exclude-session-artifacts",
  };
  const actions = [
    canonicalNextActionForLoop({
      gateQuality: {
        posture: "blocked",
        blockers: ["No independent checks gate is configured."],
      },
    }),
    canonicalNextActionForLoop({
      preflight: {
        status: "blocked",
        blockers: ["No benchmark command is available for the first packet."],
      },
    }),
    canonicalNextActionForLoop({
      portfolioRecommendation: {
        kind: "trust-blocker",
        reason: "Portfolio evidence is not trustworthy enough to continue.",
      },
    }),
    canonicalNextActionForLoop({
      workflowFriction: [
        {
          kind: "metric_saturated_not_promotable",
          severity: "blocker",
          reason: "Current metric family is saturated without promotion evidence.",
        },
      ],
    }),
    canonicalNextActionForLoop({
      finalizationReadiness: {
        actionCode: "current-tree-finalization",
        warnings: ["Current branch tree is not covered by selected kept groups."],
      },
    }),
  ];

  assert.deepEqual(
    actions.map((action) => action.kind),
    [
      "gate-quality",
      "preflight",
      "portfolio-trust-blocker",
      "metric-saturation",
      "current-tree-finalization",
    ],
  );
  for (const action of actions) {
    const command = resolveActionCommand(action.kind, commands, {
      explicitCommand: action.command,
    });
    assert.notEqual(command, "", action.kind);
    assert.doesNotMatch(command, /\bnext\b/, action.kind);
    assert.doesNotMatch(command, /\bfinalize-current-tree\b/, action.kind);
    assert.equal(typeof action.label, "string", action.kind);
    assert.notEqual(action.label, "", action.kind);
  }
});

test("current-tree finalization acceptance requires only one issue and a finalization command", () => {
  const payload = {
    issues: ["Finalization preview exposed a structured current-tree blocker."],
    finalizationReadiness: {
      actionCode: "current-tree-finalization",
    },
    loopContract: {
      canRunNextPacket: false,
      strongestAction: {
        kind: "current-tree-finalization",
        command: "node scripts/autoresearch.mjs finalize-preview --cwd C:/repo",
      },
      blockers: [{ kind: "current-tree-finalization" }],
    },
  };

  assert.equal(acceptedCurrentTreeFinalizationIssue(payload), payload.issues[0]);
  assert.equal(
    acceptedCurrentTreeFinalizationIssue({
      ...payload,
      finalizationReadiness: {},
      issues: ["An unrelated issue should not be accepted by structure alone."],
    }),
    null,
  );
  assert.equal(
    acceptedCurrentTreeFinalizationIssue({
      ...payload,
      issues: [...payload.issues, "Configured commitPaths are stale."],
    }),
    null,
  );
  assert.equal(
    acceptedCurrentTreeFinalizationIssue({
      ...payload,
      loopContract: {
        ...payload.loopContract,
        strongestAction: {
          kind: "current-tree-finalization",
          command: "node scripts/autoresearch.mjs state --cwd C:/repo",
        },
      },
    }),
    null,
  );
  assert.equal(
    acceptedCurrentTreeFinalizationIssue({
      ...payload,
      loopContract: {
        ...payload.loopContract,
        strongestAction: {
          kind: "current-tree-finalization",
          command: "node scripts/autoresearch.mjs next --cwd C:/repo",
        },
      },
    }),
    null,
  );
});

test("loop contract summarizes blockers and warnings", () => {
  const status = buildLoopContractStatus({
    contextDistillation: { required: true, reason: "Session is too large." },
    laneLifecycle: { staleLanes: [{ id: "a" }] },
    finalizationReadiness: { ready: true },
  });

  assert.equal(status.ok, false);
  assert.equal(status.canRunNextPacket, false);
  assert.deepEqual(
    status.blockers.map((item) => item.kind),
    ["context-distillation", "lane-cleanup"],
  );
  assert.equal(status.warnings[0].kind, "finalization");
});

test("operator checklist returns exactly the compact handoff keys", () => {
  const checklist = buildOperatorChecklist(
    { kind: "packet-diagnostic", reason: "Inspect diagnostics.", command: "" },
    {
      workDir: "C:/repo",
      pluginRoot: "C:/repo/plugins/codex-autoresearch",
      loopContract: {
        blockers: [{ kind: "packet-diagnostic", reason: "Citation carry failed." }],
      },
    },
  );

  assert.deepEqual(Object.keys(checklist), [
    "command",
    "safetyReason",
    "blocker",
    "evidenceRole",
    "source",
  ]);
  assert.match(checklist.command, /partial-results/);
  assert.equal(checklist.blocker, "Citation carry failed.");
  assert.equal(checklist.evidenceRole, "diagnostic-measure");
});

test("compact recommend-next uses compact state without dashboard-only fields", () => {
  const compactState = {
    ok: true,
    workDir: "C:/repo",
    nextAction: "Compact says continue from state.",
    commands: {
      state: "node scripts/autoresearch.mjs state --cwd C:/repo --compact",
      next: "node scripts/autoresearch.mjs next --cwd C:/repo --compact",
    },
    canonicalNextAction: {
      kind: "decision-capsule",
      reason: "Run the compact benchmark lint handoff.",
      command: "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo",
    },
    resumeAudit: {
      canonicalNextAction: {
        kind: "decision-capsule",
      },
      finalizationReadiness: {
        available: false,
        ready: null,
        nextAction: "Run finalize-preview when review readiness is needed.",
      },
    },
    decisionEnvelope: {
      canonicalNextAction: {
        kind: "decision-capsule",
      },
      loopContract: {
        ok: false,
      },
      finalizationReadiness: {
        available: false,
        ready: null,
        nextAction: "Run finalize-preview when review readiness is needed.",
      },
    },
    runtimeProvenance: { status: "checked" },
    loopContract: { ok: false },
    laneLifecycle: { staleLanes: [] },
    packetDiagnostics: { latest: "ok" },
    portfolioRecommendation: { kind: "read-only-scout", confidence: "medium" },
    sessionDecisionCapsule: { status: "active" },
  };

  const response = buildCompactRecommendNextResponse({
    workDir: "C:/repo",
    compactState,
  });
  const action = response.action as { kind?: string };
  const decisionEnvelope = response.decisionEnvelope as {
    finalizationReadiness?: { available?: boolean };
  };

  assert.equal(action.kind, "decision-capsule");
  assert.equal(
    response.commands.primary,
    "node scripts/autoresearch.mjs benchmark-lint --cwd C:/repo",
  );
  assert.match(response.whySafe, /compact state/);
  assert.match(response.whySafe, /without dashboard-grade rendering/);
  assert.equal(response.compactState, compactState);
  assert.equal(response.decisionEnvelope, compactState.decisionEnvelope);
  assert.equal(response.resumeAudit, compactState.resumeAudit);
  assert.deepEqual(response.runtimeProvenance, compactState.runtimeProvenance);
  assert.deepEqual(response.loopContract, compactState.loopContract);
  assert.deepEqual(response.laneLifecycle, compactState.laneLifecycle);
  assert.deepEqual(response.packetDiagnostics, compactState.packetDiagnostics);
  assert.deepEqual(response.portfolioRecommendation, compactState.portfolioRecommendation);
  assert.deepEqual(response.sessionDecisionCapsule, compactState.sessionDecisionCapsule);
  assert.equal(decisionEnvelope.finalizationReadiness?.available, false);
});

test("compact recommend-next uses blocker metadata fallback instead of next", () => {
  const response = buildCompactRecommendNextResponse({
    workDir: "C:/repo",
    compactState: {
      ok: false,
      commands: {
        state: "node scripts/autoresearch.mjs state --cwd C:/repo --compact",
        next: "node scripts/autoresearch.mjs next --cwd C:/repo --compact",
        doctor: "node scripts/autoresearch.mjs doctor --cwd C:/repo --explain",
      },
      canonicalNextAction: {
        kind: "preflight",
        reason: "Resolve preflight blockers before another packet.",
        command: "",
      },
    },
  });

  assert.equal((response.action as { kind?: string }).kind, "preflight");
  assert.equal(
    response.commands.primary,
    "node scripts/autoresearch.mjs doctor --cwd C:/repo --explain",
  );
  assert.doesNotMatch(String(response.commands.primary), /\bnext\b/);
});

test("goal frame keeps the durable Autoresearch goal authoritative", () => {
  const frame = buildGoalFrame({
    autoresearchGoal:
      "Use a cheap local agent-value gap to steer CodeStory grounding improvements before spending live A/B or broad-suite budget.",
    codexGoalObjective:
      "Please continue with the autoresearch. Start by stating and starting the goal of the research.",
  });

  assert.equal(
    frame.authoritativeGoal,
    "Use a cheap local agent-value gap to steer CodeStory grounding improvements before spending live A/B or broad-suite budget.",
  );
  assert.equal(frame.codexObjectiveRole, "operator_instruction");
  assert.equal(frame.mismatch, true);
  assert.match(frame.warning, /Codex prompt is not the research goal/);
});

test("goal frame stays quiet when Codex and Autoresearch goals match", () => {
  const frame = buildGoalFrame({
    autoresearchGoal: "Reduce packet latency while preserving quality.",
    codexGoalObjective: "Reduce packet latency while preserving quality.",
  });

  assert.equal(frame.authoritativeGoal, "Reduce packet latency while preserving quality.");
  assert.equal(frame.codexObjectiveRole, "matching_research_goal");
  assert.equal(frame.mismatch, false);
  assert.equal(frame.warning, "");
});

test("session decision rules capture Codex prompt versus research goal corrections", () => {
  const text =
    "That's not the goal of the autoresearch, that's my prompt. The research goal is still the cheap local agent-value gap.";
  const matches = matchDecisionRules(text, "message");

  assert.equal(
    matches.some((match) => match.kind === "goal_frame_mismatch"),
    true,
  );

  const capsule = buildSessionDecisionCapsule({
    compactions: 0,
    first: "2026-06-01T13:00:00.000Z",
    last: "2026-06-01T13:05:00.000Z",
    productSignals: matches,
    workflowWaste: [],
    blockers: [],
    userCorrections: [],
    toolCounts: {},
    commandClasses: {},
    thresholds: {
      functionCalls: 30,
      outputSegmentTokenBudget: 20_000,
      repeatedCommandHeadCount: 3,
      shellPolls: 12,
    },
  });

  assert.equal(capsule.enforcement.mode, "bounded-next");
  assert.equal(capsule.enforcement.canRunNextPacket, false);
  assert.equal(capsule.enforcement.allowBoundedNext, true);
  assert.match(capsule.bottleneck, /goal-frame drift/i);
  assert.match(capsule.nextExperiment, /durable Autoresearch goal/i);
  assert.match(capsule.evidence.join("\n"), /Codex prompt was mistaken/);
});

test("lane lifecycle marks stale planned lanes and records latest results", () => {
  const createdAt = "2026-05-31T00:00:00.000Z";
  const lifecycle = buildLaneLifecycle({
    fanoutPlan: {
      createdAt,
      lanes: [
        { id: "scout", status: "planned" },
        { id: "benchmark", status: "planned" },
      ],
    },
    laneResults: [
      {
        type: "lane_result",
        timestamp: Date.parse("2026-05-31T00:30:00.000Z"),
        lane: { id: "benchmark" },
        result: { status: "completed" },
      },
    ],
    nowMs: Date.parse("2026-05-31T03:00:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
    workDir: "C:/repo",
  });

  assert.deepEqual(
    lifecycle.staleLanes.map((lane) => lane.id),
    ["scout"],
  );
  assert.deepEqual(
    lifecycle.resultLanes.map((lane) => lane.id),
    ["benchmark"],
  );
  assert.match(lifecycle.recommendation, /scout/);
  assert.match(lifecycle.command, /lane-runner/);
});

test("lane lifecycle summarizes result-only records from current state", () => {
  const lifecycle = buildLaneLifecycle({
    state: {
      current: [
        {
          type: "lane_result",
          timestamp: Date.parse("2026-05-31T01:00:00.000Z"),
          lane: { id: "only-result", title: "Only result" },
          result: { status: "completed" },
        },
      ],
    },
    nowMs: Date.parse("2026-05-31T01:30:00.000Z"),
  });

  assert.deepEqual(
    lifecycle.resultLanes.map((lane) => lane.id),
    ["only-result"],
  );
  assert.equal(lifecycle.staleLanes.length, 0);
});

test("lane lifecycle ignores completed lane results from older segments", () => {
  const lifecycle = buildLaneLifecycle({
    state: { segment: 1 },
    fanoutPlan: {
      segment: 1,
      lanes: [{ id: "benchmark-contract", status: "planned" }],
    },
    records: [
      {
        type: "lane_result",
        segment: 0,
        timestamp: Date.parse("2026-05-31T01:00:00.000Z"),
        lane: { id: "benchmark-contract" },
        result: { status: "completed", recommendation: "Old segment result." },
      },
    ],
    nowMs: Date.parse("2026-05-31T01:30:00.000Z"),
  });

  assert.deepEqual(
    lifecycle.plannedLanes.map((lane) => lane.id),
    ["benchmark-contract"],
  );
  assert.equal(lifecycle.resultLanes.length, 0);
  assert.equal(lifecycle.latestResults.length, 0);
});

test("lane lifecycle ignores direct laneResults from older segments", () => {
  const lifecycle = buildLaneLifecycle({
    state: { segment: 1 },
    fanoutPlan: {
      segment: 1,
      lanes: [{ id: "benchmark-contract", status: "planned" }],
    },
    laneResults: [
      {
        type: "lane_result",
        segment: 0,
        timestamp: Date.parse("2026-05-31T01:00:00.000Z"),
        lane: { id: "benchmark-contract" },
        result: { status: "completed", recommendation: "Old direct lane result." },
      },
    ],
    nowMs: Date.parse("2026-05-31T01:30:00.000Z"),
  });

  assert.deepEqual(
    lifecycle.plannedLanes.map((lane) => lane.id),
    ["benchmark-contract"],
  );
  assert.equal(lifecycle.resultLanes.length, 0);
  assert.equal(lifecycle.latestResults.length, 0);
});
