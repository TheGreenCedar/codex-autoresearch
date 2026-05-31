import assert from "node:assert/strict";
import test from "node:test";

import { classifyPacketDiagnostics } from "../lib/packet-diagnostics.js";

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
