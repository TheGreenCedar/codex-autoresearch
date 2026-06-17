import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  benchmarkContractDiagnostics,
  classifyPacketDiagnostics,
} from "../lib/packet-diagnostics.js";
import { parseSessionForensics } from "../lib/session-forensics.js";

test("classifies retrieval evidence that was not cited", () => {
  const result = classifyPacketDiagnostics({
    metrics: {
      retrieval_hits: 7,
      citation_recall: 0.1,
      claim_recall: 0.2,
      quality: 0.4,
    },
  });

  assert.equal(result.primaryStage, "retrieved_but_not_cited");
  assert.equal(result.unresolved, true);
  assert.match(result.recommendation, /retrieved_but_not_cited/);
});

test("classifies synthesis or citation loss after high symbol recall", () => {
  const result = classifyPacketDiagnostics({
    metrics: {
      symbol_recall: 0.92,
      file_recall: 0.25,
      claim_recall: 0.3,
      quality: 0.5,
    },
  });

  assert.equal(result.primaryStage, "lost_in_synthesis_or_citation");
  assert.equal(result.stages.includes("retrieved_but_not_cited"), true);
});

test("classifies missing quality score for quality loops", () => {
  const result = classifyPacketDiagnostics({
    metricName: "quality_gap",
    packetEvidence: { exitStatus: 0, metrics: { seconds: 4 } },
  });

  assert.equal(result.primaryStage, "missing_quality_score");
  assert.match(result.reasons.join("\n"), /quality score/);
});

test("does not invent missing quality diagnostics without packet evidence", () => {
  const result = classifyPacketDiagnostics({
    metricName: "quality_gap",
    packetEvidence: {},
  });

  assert.equal(result.primaryStage, "none");
  assert.equal(result.unresolved, false);
});

test("treats the configured primary metric as satisfying score-like loops", () => {
  const qualityGap = classifyPacketDiagnostics({
    metricName: "quality_gap",
    packetEvidence: { exitStatus: 0, metrics: { quality_gap: 0 } },
  });
  const pipelineScore = classifyPacketDiagnostics({
    metricName: "pipeline_score",
    packetEvidence: { exitStatus: 0 },
    run: { parsedMetrics: { pipeline_score: 0.82 } },
  });

  assert.equal(qualityGap.primaryStage, "none");
  assert.equal(pipelineScore.primaryStage, "none");
});

test("classifies sufficient packets that still fail quality", () => {
  const result = classifyPacketDiagnostics({
    metrics: {
      quality_gap: 2,
      sufficient: true,
      citation_recall: 0.8,
    },
    packetEvidence: { exitStatus: 0 },
  });

  assert.equal(result.primaryStage, "marked_sufficient_but_failed");
});

test("review-required metrics mark packet diagnostics unresolved", () => {
  const diagnostics = classifyPacketDiagnostics({
    metrics: {
      quality_gap: 0,
      ideal_anchor_mismatch_count: 2,
      sufficient_quality_mismatch: 1,
      review_required: 1,
    },
  });

  assert.equal(diagnostics.primaryStage, "review_required");
  assert.equal(diagnostics.unresolved, true);
  assert.match(diagnostics.reasons.join("\n"), /ideal_anchor_mismatch_count=2/);
  assert.match(diagnostics.recommendation, /human review/i);
});

test("review-required string metrics ignore no-issue tokens", () => {
  for (const overfitSignal of ["none", "pass", "passed"]) {
    const diagnostics = classifyPacketDiagnostics({
      metrics: {
        overfit_signal: overfitSignal,
      },
    });

    assert.equal(diagnostics.primaryStage, "none", overfitSignal);
    assert.equal(diagnostics.unresolved, false, overfitSignal);
  }
});

test("review-required string metrics accept positive signal tokens", () => {
  const diagnostics = classifyPacketDiagnostics({
    metrics: {
      overfit_signal: "detected",
    },
  });

  assert.equal(diagnostics.primaryStage, "review_required");
  assert.match(diagnostics.reasons.join("\n"), /overfit_signal=detected/);
});

test("carries optional task artifact diagnostics without changing metric classification", () => {
  const taskArtifacts = {
    acceptedTasks: [{ id: "task-1", status: "done" }],
    quarantinedTasks: [],
    warnings: [],
  };
  const result = classifyPacketDiagnostics({
    metricName: "score",
    packetEvidence: { exitStatus: 0, metrics: { score: 1 }, taskArtifacts },
  });

  assert.equal(result.primaryStage, "none");
  assert.equal(result.taskArtifacts, taskArtifacts);
});

test("treats accepted new-segment benchmark contract as active authority", () => {
  const result = benchmarkContractDiagnostics({
    state: {
      segment: 1,
      current: [],
      results: [
        {
          run: 1,
          segment: 0,
          benchmarkContract: { surfaceHash: "old-contract", command: "node old.js" },
        },
      ],
      activeConfigEntry: {
        type: "config",
        segment: 1,
        benchmarkContractAccepted: true,
        benchmarkContractScope: "segment",
        benchmarkContract: { surfaceHash: "new-contract", command: "node new.js" },
      },
    },
  });

  assert.equal(result.activeContract?.surfaceHash, "new-contract");
  assert.equal(result.activeSource, "segment");
  assert.deepEqual(
    result.historicalContracts.map((contract) => contract.surfaceHash),
    ["old-contract"],
  );
});

test("session forensics detects product_bar_rejection and oversized_tool_output friction", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autoresearch-forensics-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const sessionPath = path.join(dir, "rollout.jsonl");
  const entries = [
    {
      timestamp: "2026-06-08T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Clearly, you did not test accuracy" }],
      },
    },
    {
      timestamp: "2026-06-08T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "I treated autoresearch loop completion as enough.",
          },
        ],
      },
    },
    {
      timestamp: "2026-06-08T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_oversized",
        output: [
          "Chunk ID: abc",
          "Process exited with code 0",
          "Original token count: 65601",
          "Output:",
          "stdin is closed",
        ].join("\n"),
      },
    },
  ];
  await writeFile(sessionPath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");

  const result = await parseSessionForensics({ sessionJsonl: sessionPath });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const signalKinds = new Set(
    [...result.productSignals, ...result.workflowWaste].map((signal) => signal.kind),
  );

  assert.deepEqual(
    [
      "product_bar_rejection",
      "false_done_admission",
      "oversized_tool_output",
      "closed_stdin_poll",
    ].map((kind) => signalKinds.has(kind)),
    [true, true, true, true],
  );
});
