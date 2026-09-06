import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startOutcome, readOutcome } from "../lib/outcome-store.js";
import { nominateOutcomeAction, logOutcomeObservation } from "../lib/investigation-workflow.js";
import {
  dispatchOutcomeConfirmation,
  reconcileOutcomeConfirmation,
  verifiedOutcomeConfirmations,
} from "../lib/github-confirmation.js";
import { captureConfirmationCandidate } from "../lib/confirmation-candidate.js";
import { captureOutcomeInputs } from "../lib/outcome-inputs.js";
import { outcomeUsage } from "../lib/outcome-contract.js";
import { buildOutcomeEvidenceRegistry } from "../lib/evidence-registry.js";
import {
  artifactZip,
  FakeConfirmationTransport,
  confirmationRevision,
} from "./helpers/confirmation-fixtures.js";
import { governedFixture, actionFixture } from "./helpers/outcome-fixtures.js";
import { withTempDir } from "./helpers/process.js";

async function fixture(cwd: string, custody = "external") {
  await fsp.mkdir(path.join(cwd, "src"));
  await fsp.writeFile(path.join(cwd, "src", "input.json"), '{"compatible":true}\n');
  const contract = governedFixture(cwd);
  await startOutcome(cwd, {
    ...contract,
    criteria: contract.criteria.map((criterion) => ({ ...criterion, authority: "independent" })),
    confirmation: {
      repository: "fixture/evaluator",
      workflow: ".github/workflows/confirm.yml",
      workflowRevision: confirmationRevision,
      ref: "accepted",
      protocolDigest: "b".repeat(64),
      datasetId: "sealed-fixture",
      custody,
      custodyReference: "accepted external evaluator owner",
    },
  });
  const candidate = artifactZip("candidate.json", await captureConfirmationCandidate(cwd, "local"));
  const api = new FakeConfirmationTransport(candidate);
  const action = actionFixture("A1");
  return {
    api,
    action: {
      ...action,
      mode: "github-actions",
      purpose: "confirmation",
      effects: ["execute"],
      candidateArtifact: {
        repository: "fixture/subject",
        artifactId: 10,
        digest: candidate.digest,
      },
    },
  };
}
async function coverage(cwd: string) {
  const state = (await readOutcome(cwd))!;
  const proof = await verifiedOutcomeConfirmations(cwd, state);
  return buildOutcomeEvidenceRegistry({
    state,
    input: await captureOutcomeInputs(cwd, "local"),
    verifiedConfirmations: proof.verified,
    independentConfirmations: proof.independent,
  });
}
const observation = {
  id: "E1",
  executionId: "A1",
  criterionId: "compatibility",
  text: "Verified fixture result",
};

test("uncertain dispatch reconnects to its unique nominated run and never dispatches twice", async () => {
  await withTempDir("confirmation", "uncertain", async (cwd) => {
    const { api, action } = await fixture(cwd);
    await nominateOutcomeAction(cwd, action);
    api.uncertain = true;
    assert.equal((await dispatchOutcomeConfirmation(cwd, "A1", api)).status.kind, "unknown");
    assert.equal(outcomeUsage((await readOutcome(cwd))!).unknownExecutions, 1);
    const completed = await reconcileOutcomeConfirmation(cwd, "A1", api);
    assert.equal(completed.status.kind, "completed");
    assert.equal(api.calls, 1);
    await logOutcomeObservation(cwd, observation);
    assert.equal((await coverage(cwd)).criteria[0].status, "satisfied");
    assert.equal(outcomeUsage((await readOutcome(cwd))!).unknownExecutions, 0);
  });
});

test("verified execution provenance does not imply evaluator independence", async () => {
  await withTempDir("confirmation", "internal", async (cwd) => {
    const { api, action } = await fixture(cwd, "internal");
    await nominateOutcomeAction(cwd, action);
    await dispatchOutcomeConfirmation(cwd, "A1", api);
    await reconcileOutcomeConfirmation(cwd, "A1", api);
    await logOutcomeObservation(cwd, observation);
    const proof = await verifiedOutcomeConfirmations(cwd, (await readOutcome(cwd))!);
    assert.equal(proof.verified.size, 1);
    assert.equal(proof.independent.size, 0);
    assert.equal((await coverage(cwd)).criteria[0].status, "unknown");
  });
});

test("wrong candidate, workflow, protocol, population, environment, and criterion receipts are rejected", async () => {
  for (const delta of [
    { candidateArtifactDigest: "0".repeat(64) },
    { workflowRevision: "0".repeat(40) },
    { protocolDigest: "0".repeat(64) },
    { datasetId: "substituted" },
    { environment: "other" },
    { criterionIds: ["other"] },
    { runAttempt: 2 },
  ])
    await withTempDir("confirmation", "wrong-binding", async (cwd) => {
      const { api, action } = await fixture(cwd);
      api.receiptDelta = delta;
      await nominateOutcomeAction(cwd, action);
      await dispatchOutcomeConfirmation(cwd, "A1", api);
      assert.equal((await reconcileOutcomeConfirmation(cwd, "A1", api)).status.kind, "failed");
      assert.equal((await readOutcome(cwd))!.confirmationExposures.length, 1);
      assert.equal(
        (await verifiedOutcomeConfirmations(cwd, (await readOutcome(cwd))!)).verified.size,
        0,
      );
    });
});

test("exposed data stays exposed across new investigations and evaluator identities", async () => {
  await withTempDir("confirmation", "exposure", async (cwd) => {
    const { api, action } = await fixture(cwd);
    await nominateOutcomeAction(cwd, action);
    await dispatchOutcomeConfirmation(cwd, "A1", api);
    await reconcileOutcomeConfirmation(cwd, "A1", api);
    await logOutcomeObservation(cwd, observation);
    await nominateOutcomeAction(cwd, {
      ...action,
      id: "A2",
      investigation: { ...action.investigation, id: "H2" },
      evaluator: { ...action.evaluator, id: "confirm-v2" },
    });
    await dispatchOutcomeConfirmation(cwd, "A2", api);
    await reconcileOutcomeConfirmation(cwd, "A2", api);
    await logOutcomeObservation(cwd, { ...observation, id: "E2", executionId: "A2" });
    const state = (await readOutcome(cwd))!;
    assert.equal(state.confirmations[1].fresh, false);
    assert.equal(state.confirmationExposures.length, 2);
    const proof = await verifiedOutcomeConfirmations(cwd, state);
    assert.equal(proof.verified.has("E2"), true);
    assert.equal(proof.independent.has("E2"), false);
    assert.equal((await coverage(cwd)).criteria[0].status, "unknown");
  });
});

test("unavailable proof remains resumable and provider duration cannot be replaced by local observation time", async () => {
  await withTempDir("confirmation", "retrieve-retry", async (cwd) => {
    const { api, action } = await fixture(cwd);
    await nominateOutcomeAction(cwd, action);
    await dispatchOutcomeConfirmation(cwd, "A1", api);
    const original = api.artifact.bind(api);
    let unavailable = true;
    api.artifact = async (endpoint) => {
      if (unavailable && endpoint.endsWith("/artifacts/20/zip")) throw new Error("GitHub API 503");
      return await original(endpoint);
    };
    assert.equal((await reconcileOutcomeConfirmation(cwd, "A1", api)).status.kind, "unknown");
    unavailable = false;
    api.receiptDelta = { executionSeconds: 2 };
    assert.equal((await reconcileOutcomeConfirmation(cwd, "A1", api)).status.kind, "completed");
    assert.equal(api.calls, 1);
    assert.ok(outcomeUsage((await readOutcome(cwd))!).measuredSeconds >= 2);
  });
  await withTempDir("confirmation", "provider-overrun", async (cwd) => {
    const { api, action } = await fixture(cwd);
    api.receiptDelta = { executionSeconds: 60 };
    await nominateOutcomeAction(cwd, action);
    await dispatchOutcomeConfirmation(cwd, "A1", api);
    assert.equal((await reconcileOutcomeConfirmation(cwd, "A1", api)).status.kind, "failed");
    assert.ok(outcomeUsage((await readOutcome(cwd))!).measuredSeconds >= 60);
  });
});

test("resume performs a first confirmation dispatch but cancellation never starts unattempted work", async () => {
  for (const cancel of [false, true])
    await withTempDir("confirmation", "before-dispatch", async (cwd) => {
      const { api, action } = await fixture(cwd);
      await nominateOutcomeAction(cwd, action);
      const receipt = await reconcileOutcomeConfirmation(cwd, "A1", api, cancel);
      assert.equal(api.calls, cancel ? 0 : 1);
      assert.equal(receipt.status.kind, cancel ? "cancelled" : "launching");
      if (cancel) {
        assert.equal((await dispatchOutcomeConfirmation(cwd, "A1", api)).status.kind, "cancelled");
        assert.equal(api.calls, 0);
      }
    });
  await withTempDir("confirmation", "cancel-preparing", async (cwd) => {
    const { api, action } = await fixture(cwd);
    await nominateOutcomeAction(cwd, action);
    const original = api.artifact.bind(api);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.artifact = async (endpoint) => {
      if (endpoint.endsWith("/artifacts/10/zip")) {
        entered();
        await blocked;
      }
      return await original(endpoint);
    };
    const dispatch = dispatchOutcomeConfirmation(cwd, "A1", api);
    await ready;
    assert.equal(
      (await reconcileOutcomeConfirmation(cwd, "A1", api, true)).status.kind,
      "cancelled",
    );
    release();
    assert.equal((await dispatch).status.kind, "cancelled");
    assert.equal(api.calls, 0);
    assert.equal(outcomeUsage((await readOutcome(cwd))!).reservedSeconds, 0);
  });
});
