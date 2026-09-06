import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { hashOutcomeValue } from "../lib/outcome-contract.js";
import {
  parseComparisonProtocol,
  prepareComparison,
  collectComparison,
  validateComparisonSchedule,
  ACCOUNTED_PHASES,
  COMPARISON_ARMS,
} from "../lib/comparative-protocol.js";

const host = generateKeyPairSync("ed25519"),
  assessor = generateKeyPairSync("ed25519");
function protocol(stage = "pilot") {
  return {
    schemaVersion: 1,
    id: "fixture-study",
    stage,
    model: "fixed-fixture-model",
    environmentDigest: "a".repeat(64),
    authorization: {
      reference: "explicit separate fixture budget",
      maxRuns: 12,
      maxTotalSeconds: 60,
      maxTotalCostUsd: 6,
    },
    aggregatePerTaskArm: { seconds: 10, tokens: 100, costUsd: 1 },
    seeds: ["one", "two"],
    tasks: ["T1", "T2"].map((id) => ({
      id,
      kind: "uncertain",
      author: "independent-author",
      inputDigest: (id === "T1" ? "b" : "e").repeat(64),
      sealedAt: "2026-09-05T00:00:00Z",
    })),
    arms: Object.fromEntries(
      COMPARISON_ARMS.map((arm, index) => [
        arm,
        {
          version: index === 0 ? "fixed-host" : index === 1 ? "2.9.0" : "3.0.0-rc.1",
          runtimeDigest: String(index + 1).repeat(64),
        },
      ]),
    ),
    hostAuthority: {
      reference: "accepted-host",
      publicKey: host.publicKey.export({ type: "spki", format: "pem" }).toString(),
      enforcementReference: "fixture host enforced aggregate ceilings",
    },
    assessmentAuthority: {
      reference: "independent-assessor",
      publicKey: assessor.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
    preregistration:
      stage === "scoring"
        ? {
            reference: "fixture preregistration",
            analysisDigest: "c".repeat(64),
            simpleNoninferiorityMargin: 0.05,
          }
        : null,
  };
}
function signed(payload: Record<string, unknown>, key = host.privateKey) {
  return {
    payload,
    signature: sign(null, Buffer.from(hashOutcomeValue(payload)), key).toString("base64"),
  };
}
function fixture(stage = "pilot") {
  const accepted = parseComparisonProtocol(protocol(stage)),
    schedule = prepareComparison(accepted);
  const receipts = schedule.trials.map((trial) =>
    signed({
      trialId: trial.id,
      protocolDigest: accepted.digest,
      model: accepted.model,
      environmentDigest: accepted.environmentDigest,
      inputDigest: accepted.tasks.find((task) => task.id === trial.taskId)!.inputDigest,
      runtimeDigest: accepted.arms[trial.arm].runtimeDigest,
      seed: trial.seed,
      enforcementReference: accepted.hostAuthority.enforcementReference,
      artifactDigest: "d".repeat(64),
      phases: Object.fromEntries(
        ACCOUNTED_PHASES.map((phase) => [phase, { seconds: 0.1, tokens: 1, costUsd: 0.001 }]),
      ),
    }),
  );
  return { accepted, schedule, receipts };
}

test("comparison accepts the stable 3.0 artifact without changing its pinned identity", () => {
  const input = protocol();
  input.arms["candidate-3.0"].version = "3.0.0";
  const accepted = parseComparisonProtocol(input);
  assert.equal(accepted.arms["candidate-3.0"].version, "3.0.0");
  assert.equal(accepted.arms["candidate-3.0"].runtimeDigest, "3".repeat(64));
});

test("comparison requires a separate explicit budget and fixed sealed schedule", () => {
  assert.throws(
    () => parseComparisonProtocol({ ...protocol(), authorization: null }),
    /budget authorization/,
  );
  assert.throws(
    () => parseComparisonProtocol({ ...protocol(), seeds: ["one", "two", "unfunded"] }),
    /ceiling/,
  );
  const { accepted, schedule } = fixture();
  assert.equal(schedule.trials.length, 12);
  assert.throws(
    () =>
      validateComparisonSchedule(
        { ...schedule, trials: [...schedule.trials.slice(1), schedule.trials[1]] },
        accepted,
      ),
    /duplicates/,
  );
});

test("pilot remains non-scoring and repeated seeds share each task-arm allowance", () => {
  const { accepted, schedule, receipts } = fixture();
  assert.equal(collectComparison(accepted, schedule, receipts).conclusion, "non-scoring");
  assert.throws(() => collectComparison(accepted, schedule, receipts, [{}]), /non-scoring/);
  const overBudget = receipts.map(({ payload }) =>
    signed({
      ...payload,
      phases: Object.fromEntries(
        ACCOUNTED_PHASES.map((phase) => [
          phase,
          { seconds: phase === "execution" ? 8 : 0, tokens: 1, costUsd: 0.001 },
        ]),
      ),
    }),
  );
  assert.throws(() => collectComparison(accepted, schedule, overBudget), /aggregate task\/arm/);
});

test("untrusted receipts, mismatched actual conditions, and missing failure costs cannot score", () => {
  const { accepted, schedule, receipts } = fixture();
  assert.throws(
    () =>
      collectComparison(accepted, schedule, [
        { ...receipts[0], signature: "invalid" },
        ...receipts.slice(1),
      ]),
    /signature/,
  );
  assert.throws(
    () =>
      collectComparison(accepted, schedule, [
        signed({ ...receipts[0].payload, model: "different" }),
        ...receipts.slice(1),
      ]),
    /differs across arms/,
  );
  const phases = { ...(receipts[0].payload.phases as Record<string, unknown>) };
  delete phases["failed-attempts"];
  assert.throws(
    () =>
      collectComparison(accepted, schedule, [
        signed({ ...receipts[0].payload, phases }),
        ...receipts.slice(1),
      ]),
    /accounted/,
  );
  assert.throws(() => collectComparison(accepted, schedule, receipts.slice(1)), /incomplete/);
});

test("scoring exports blinded paired task units and leaves unresolved analysis inconclusive", () => {
  const { accepted, schedule, receipts } = fixture("scoring");
  const assessments = schedule.trials.map((trial) =>
    signed(
      {
        trialId: trial.id,
        protocolDigest: accepted.digest,
        artifactDigest: "d".repeat(64),
        verifiedOutcome: true,
        infeasibleHandled: false,
      },
      assessor.privateKey,
    ),
  );
  const result = collectComparison(accepted, schedule, receipts, assessments);
  assert.equal(result.independentTasks, 2);
  assert.equal(result.conclusion, "inconclusive");
  assert.equal(
    "repeatedSeedsAreIndependent" in result && result.repeatedSeedsAreIndependent,
    false,
  );
  assert.throws(
    () =>
      collectComparison(accepted, schedule, receipts, [
        signed({ ...assessments[0].payload, arm: "candidate-3.0" }, assessor.privateKey),
        ...assessments.slice(1),
      ]),
    /exposes/,
  );
});

test("key formatting and task labels cannot manufacture independent authorities or task units", () => {
  const input = protocol("scoring");
  assert.throws(
    () =>
      parseComparisonProtocol({
        ...input,
        assessmentAuthority: {
          ...input.assessmentAuthority,
          publicKey: input.hostAuthority.publicKey + "\n",
        },
      }),
    /separate ownership/,
  );
  assert.throws(
    () =>
      parseComparisonProtocol({
        ...input,
        tasks: input.tasks.map((task) => ({ ...task, inputDigest: input.tasks[0].inputDigest })),
      }),
    /independent tasks/,
  );
});
