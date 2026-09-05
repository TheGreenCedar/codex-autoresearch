import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  captureConfirmationCandidate,
  validateConfirmationCandidate,
} from "../lib/confirmation-candidate.js";
import { githubTransport, readSingleFileArtifact, artifactDigest } from "../lib/github-artifact.js";
import {
  dispatchOutcomeConfirmation,
  reconcileOutcomeConfirmation,
  verifiedOutcomeConfirmations,
} from "../lib/github-confirmation.js";
import { startOutcome, readOutcome } from "../lib/outcome-store.js";
import {
  nominateOutcomeAction,
  logOutcomeObservation,
  terminalExecution,
} from "../lib/investigation-workflow.js";
import { hashOutcomeValue, outcomeObject, outcomeString } from "../lib/outcome-contract.js";

// Fixed public fixtures exercise transport and provenance; they cannot establish independence.
export const syntheticProtocol = hashOutcomeValue({
  version: 1,
  fixture: "compatible-boolean",
  dataset: "public-synthetic-v1",
});
function env(name: string) {
  return outcomeString(process.env[name], name);
}
const mode = process.argv[2];
const cwd = path.resolve(env("AUTORESEARCH_SYNTHETIC_CWD"));
const output = path.resolve(env("AUTORESEARCH_SYNTHETIC_OUTPUT"));
await fsp.mkdir(output, { recursive: true });
if (mode === "prepare") {
  await fsp.mkdir(path.join(cwd, "src"), { recursive: true });
  await fsp.writeFile(path.join(cwd, "src/input.json"), '{"compatible":true}\n');
  await fsp.writeFile(
    path.join(output, "candidate.json"),
    JSON.stringify(await captureConfirmationCandidate(cwd, "synthetic-github")),
  );
} else if (mode === "parent") {
  const repository = env("GITHUB_REPOSITORY");
  await startOutcome(cwd, {
    id: "synthetic",
    objective: "Verify the GitHub confirmation integration",
    criteria: [
      {
        id: "compatibility",
        description: "Fixed public fixture is compatible",
        authority: "internal",
        subject: "candidate",
      },
    ],
    authorization: {
      reference: "repository CI synthetic integration proof",
      worktrees: [cwd],
      editable: ["src"],
      protected: ["checks"],
      effects: ["inspect", "execute"],
      environments: ["synthetic-github"],
      delivery: "answer",
    },
    budget: {
      actions: 1,
      executionSeconds: 600,
      deadline: new Date(Date.now() + 600_000).toISOString(),
    },
    confirmation: {
      repository,
      workflow: ".github/workflows/ci.yml",
      workflowRevision: env("AUTORESEARCH_WORKFLOW_REVISION"),
      ref: env("AUTORESEARCH_WORKFLOW_REF"),
      protocolDigest: syntheticProtocol,
      datasetId: "public-synthetic-v1",
      custody: "internal",
      custodyReference: "Same-repository public synthetic fixture; no independence claim",
    },
  });
  await nominateOutcomeAction(cwd, {
    id: "A1",
    investigation: {
      id: "H1",
      question: "Can the adapter verify an actual Actions receipt?",
      intervention: "Dispatch the fixed compatibility fixture",
      distinguishingObservations: ["verified compatible fixture", "rejected or missing receipt"],
      evidenceRefs: [],
      retryAllowance: 0,
    },
    purpose: "confirmation",
    effects: ["execute"],
    paths: [],
    environment: "synthetic-github",
    seconds: 600,
    mode: "github-actions",
    argv: [],
    evidenceRefs: [],
    candidateArtifact: {
      repository,
      artifactId: Number(env("AUTORESEARCH_CANDIDATE_ARTIFACT_ID")),
      digest: env("AUTORESEARCH_CANDIDATE_ARTIFACT_DIGEST").replace(/^sha256:/, ""),
    },
    evaluator: {
      id: "public-fixture-v1",
      criterionIds: ["compatibility"],
      environment: "synthetic-github",
      method: { kind: "predicate" },
      repeats: 1,
      argv: [],
      checkArgv: [],
    },
  });
  let receipt = await dispatchOutcomeConfirmation(cwd, "A1");
  const until = Date.now() + 570_000;
  while (!terminalExecution(receipt) && Date.now() < until) {
    await delay(10_000);
    receipt = await reconcileOutcomeConfirmation(cwd, "A1");
  }
  if (!terminalExecution(receipt)) {
    await reconcileOutcomeConfirmation(cwd, "A1", undefined, true);
    throw new Error(
      "Synthetic CI confirmation exceeded its explicit allowance; cancellation requested.",
    );
  }
  assert.equal(
    receipt.status.kind,
    "completed",
    JSON.stringify((await readOutcome(cwd))!.confirmations),
  );
  assert.equal(receipt.result?.attainment, "satisfied");
  await logOutcomeObservation(cwd, {
    id: "E1",
    executionId: "A1",
    criterionId: "compatibility",
    text: "Actual public synthetic CI receipt verified",
  });
  const state = (await readOutcome(cwd))!;
  const proof = await verifiedOutcomeConfirmations(cwd, state);
  assert.equal(proof.verified.has("E1"), true);
  assert.equal(proof.independent.size, 0);
  await fsp.writeFile(
    path.join(output, "roundtrip.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        purpose: "integration-only",
        candidateArtifact: state.confirmations[0].candidate,
        confirmationRunId: state.confirmations[0].runId,
        protocolDigest: syntheticProtocol,
        provenanceVerified: true,
        independent: false,
        result: receipt.result,
        reservations: state.reservations,
      },
      null,
      2,
    ),
  );
  console.log(
    `Verified synthetic confirmation run ${state.confirmations[0].runId}; independence remains false.`,
  );
} else if (mode === "confirm") {
  const started = Date.now();
  const input = outcomeObject(
    JSON.parse(env("AUTORESEARCH_CONFIRMATION_INPUT")),
    "confirmation input",
  );
  assert.equal(input.protocol_digest, syntheticProtocol);
  assert.equal(input.dataset_id, "public-synthetic-v1");
  assert.equal(input.environment, "synthetic-github");
  assert.deepEqual(JSON.parse(String(input.criterion_ids)), ["compatibility"]);
  const deadline = Date.parse(String(input.expires_at));
  assert.ok(Number.isFinite(deadline) && Date.now() < deadline, "Confirmation allowance expired");
  const repository = outcomeString(input.candidate_repository, "candidate repository");
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const id = Number(input.candidate_artifact_id);
  assert.ok(Number.isSafeInteger(id) && id > 0);
  const api = await githubTransport();
  const metadata = await api.json(`/repos/${repository}/actions/artifacts/${id}`);
  assert.equal(artifactDigest(metadata), input.candidate_artifact_digest);
  const archive = await api.artifact(`/repos/${repository}/actions/artifacts/${id}/zip`);
  const candidate = validateConfirmationCandidate(
    readSingleFileArtifact(archive, "candidate.json", String(input.candidate_artifact_digest)),
    String(input.candidate_input_digest),
  );
  const file = candidate.files["src/input.json"];
  assert.equal(file?.kind, "file");
  const fixture = outcomeObject(
    JSON.parse(Buffer.from(file.bytesBase64, "base64").toString()),
    "synthetic fixture",
  );
  assert.equal(typeof fixture.compatible, "boolean");
  assert.ok(Date.now() < deadline, "Confirmation allowance expired");
  const receipt = {
    schemaVersion: 1,
    attemptId: input.attempt_id,
    runId: Number(env("GITHUB_RUN_ID")),
    runAttempt: Number(env("GITHUB_RUN_ATTEMPT")),
    repository: env("GITHUB_REPOSITORY"),
    workflow: ".github/workflows/ci.yml",
    workflowRevision: env("GITHUB_SHA"),
    candidateArtifactDigest: input.candidate_artifact_digest,
    candidateInputDigest: input.candidate_input_digest,
    protocolDigest: syntheticProtocol,
    datasetId: input.dataset_id,
    criterionIds: ["compatibility"],
    environment: input.environment,
    checksPassed: true,
    executionSeconds: (Date.now() - started) / 1000,
    observation: {
      kind: "predicate",
      observed: fixture.compatible ? "satisfied" : "counterexample",
    },
    feedback: ["Fixed public synthetic compatibility fixture assessed"],
  };
  await fsp.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt));
} else throw new Error("Use prepare, parent, or confirm.");
