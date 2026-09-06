import { metricReference, readOutcomeDependencyManifest } from "./outcome-evidence.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  githubTransport,
  artifactDigest,
  readSingleFileArtifact,
  type GitHubTransport,
} from "./github-artifact.js";
import { validateConfirmationCandidate } from "./confirmation-candidate.js";
import { positiveId, type ConfirmationAttempt } from "./github-confirmation-records.js";
import {
  outcomeObject,
  outcomeString,
  outcomeNumber,
  outcomeTimestamp,
  hashOutcomeValue,
  type OutcomeState,
  type ConfirmationAuthority,
} from "./outcome-contract.js";
import { readOutcome, withOutcomeMutation, settleInOutcome } from "./outcome-store.js";
import { requiredExecution, terminalExecution } from "./investigation-workflow.js";
import { type ExecutionReceipt } from "./investigation-records.js";
import { storeOutcomeObject, readOutcomeObject } from "./outcome-artifacts.js";
import { classifyResult } from "./result-semantics.js";
import { captureOutcomeInputs } from "./outcome-inputs.js";
import type { UnknownRecord } from "./types/json.js";

class ConfirmationUsageExceeded extends Error {
  constructor(readonly seconds: number) {
    super("Verified provider usage exceeded the accepted action allowance.");
  }
}
interface ConfirmationProof {
  run: UnknownRecord;
  artifact: UnknownRecord;
  receiptArchiveDigest: string;
  candidateMetadata: UnknownRecord;
  candidateArchiveDigest: string;
}
export interface VerifiedConfirmation {
  attemptId: string;
  runId: number;
  observation: NonNullable<ExecutionReceipt["observation"]>;
  checksPassed: boolean;
  seconds: number;
  feedback: unknown;
}

function authorityFor(state: OutcomeState, attempt: ConfirmationAttempt): ConfirmationAuthority {
  const execution = requiredExecution(state, attempt.executionId);
  const authority = state.history.find(
    (entry) => entry.contract.digest === execution.authorizationDigest,
  )?.contract.confirmation;
  if (!authority || hashOutcomeValue(authority) !== attempt.authorityDigest)
    throw new Error("Confirmation evaluator authority is missing or substituted.");
  return authority;
}
function attemptFor(state: OutcomeState, executionId: string) {
  const attempt = state.confirmations.find((entry) => entry.executionId === executionId);
  if (!attempt) throw new Error("Confirmation nomination is missing.");
  return attempt;
}
function workflowEndpoint(authority: ConfirmationAuthority) {
  return `/repos/${authority.repository}/actions/workflows/${encodeURIComponent(path.posix.basename(authority.workflow))}`;
}
function runTitle(id: string) {
  return `autoresearch-confirmation:${id}`;
}

export async function dispatchOutcomeConfirmation(
  cwd: string,
  executionId: string,
  transport?: GitHubTransport,
): Promise<ExecutionReceipt> {
  const nominated = await withOutcomeMutation(cwd, async (state) => {
    const receipt = requiredExecution(state, executionId);
    if (terminalExecution(receipt)) return { terminal: receipt };
    if (
      receipt.action.mode !== "github-actions" ||
      !state.contract.confirmation ||
      !receipt.action.candidateArtifact ||
      !receipt.input ||
      !receipt.action.evaluator
    )
      throw new Error("Confirmation has no accepted evaluator, candidate, or input identity.");
    const existing = state.confirmations.find((item) => item.executionId === executionId);
    if (existing) return { attempt: existing, prepare: existing.status === "preparing" };
    const attempt: ConfirmationAttempt = {
      id: randomUUID(),
      executionId,
      authorityDigest: hashOutcomeValue(state.contract.confirmation),
      candidate: receipt.action.candidateArtifact,
      inputDigest: receipt.input.digest,
      criterionIds: receipt.action.evaluator.criterionIds,
      datasetId: state.contract.confirmation.datasetId,
      protocolDigest: state.contract.confirmation.protocolDigest,
      nominatedAt: new Date().toISOString(),
      dispatchStartedAt: null,
      runId: null,
      status: "preparing",
      proofDigest: null,
      feedbackDigest: null,
      fresh: !state.confirmationExposures.some(
        (entry) => entry.datasetId === state.contract.confirmation!.datasetId,
      ),
      reason: null,
    };
    state.confirmations.push(attempt);
    return { attempt, prepare: true };
  });
  if (nominated.terminal) return nominated.terminal;
  const api = transport ?? (await githubTransport());
  if (!nominated.prepare) return await reconcileOutcomeConfirmation(cwd, executionId, api);
  const state = (await readOutcome(cwd))!;
  const authority = authorityFor(state, nominated.attempt);
  const receipt = requiredExecution(state, executionId);
  try {
    const candidateMetadata = outcomeObject(
      await api.json(
        `/repos/${nominated.attempt.candidate.repository}/actions/artifacts/${nominated.attempt.candidate.artifactId}`,
      ),
      "candidate artifact metadata",
    );
    if (
      positiveId(candidateMetadata.id) !== nominated.attempt.candidate.artifactId ||
      artifactDigest(candidateMetadata) !== nominated.attempt.candidate.digest
    )
      throw new Error("Candidate artifact identity differs from its nomination.");
    const candidateArchive = await api.artifact(
      `/repos/${nominated.attempt.candidate.repository}/actions/artifacts/${nominated.attempt.candidate.artifactId}/zip`,
    );
    validateConfirmationCandidate(
      readSingleFileArtifact(
        candidateArchive,
        "candidate.json",
        nominated.attempt.candidate.digest,
      ),
      nominated.attempt.inputDigest,
    );
    await storeOutcomeObject(cwd, candidateArchive);
    const workflow = outcomeObject(
      await api.json(workflowEndpoint(authority)),
      "accepted workflow",
    );
    if (workflow.path !== authority.workflow || workflow.state !== "active")
      throw new Error("Accepted workflow identity is unavailable.");
    const revision = outcomeObject(
      await api.json(`/repos/${authority.repository}/commits/${encodeURIComponent(authority.ref)}`),
      "workflow revision",
    );
    if (revision.sha !== authority.workflowRevision)
      throw new Error("Workflow ref no longer names the accepted immutable revision.");
    const input = await captureOutcomeInputs(cwd, receipt.action.environment);
    if (input.digest !== receipt.input!.digest)
      throw new Error("Candidate inputs changed during confirmation preparation.");
    const canDispatch = await withOutcomeMutation(cwd, async (current) => {
      const attempt = attemptFor(current, executionId);
      if (attempt.status !== "preparing") return false;
      const reservation = current.reservations.find((item) => item.id === executionId)!;
      if (Date.now() >= Date.parse(reservation.reservedAt) + receipt.action.seconds * 1000)
        throw new Error("Confirmation reservation expired before dispatch.");
      attempt.status = "dispatching";
      attempt.dispatchStartedAt = new Date().toISOString();
      return true;
    });
    if (!canDispatch) return await reconcileOutcomeConfirmation(cwd, executionId, api);
    // No retry around this call: failure to observe a response is not a failed dispatch.
    const response = outcomeObject(
      await api.json(`${workflowEndpoint(authority)}/dispatches`, {
        method: "POST",
        body: {
          ref: authority.ref,
          inputs: {
            autoresearch_confirmation: "true",
            confirmation: JSON.stringify({
              attempt_id: nominated.attempt.id,
              candidate_repository: nominated.attempt.candidate.repository,
              candidate_artifact_id: String(nominated.attempt.candidate.artifactId),
              candidate_artifact_digest: nominated.attempt.candidate.digest,
              candidate_input_digest: nominated.attempt.inputDigest,
              protocol_digest: nominated.attempt.protocolDigest,
              dataset_id: nominated.attempt.datasetId,
              criterion_ids: JSON.stringify(nominated.attempt.criterionIds),
              environment: receipt.action.environment,
              expires_at: new Date(
                Math.min(
                  Date.parse(
                    state.reservations.find((item) => item.id === executionId)!.reservedAt,
                  ) +
                    receipt.action.seconds * 1000,
                  state.contract.budget.deadline
                    ? Date.parse(state.contract.budget.deadline)
                    : Infinity,
                ),
              ).toISOString(),
            }),
          },
        },
      }),
      "workflow dispatch response",
    );
    const runId = positiveId(response.workflow_run_id);
    return await withOutcomeMutation(
      cwd,
      async (current) => {
        const attempt = attemptFor(current, executionId);
        if (attempt.runId !== null && attempt.runId !== runId)
          throw new Error("Dispatch returned conflicting run identities.");
        attempt.runId = runId;
        attempt.status = "running";
        return requiredExecution(current, executionId);
      },
      [],
      true,
    );
  } catch (error) {
    return await withOutcomeMutation(
      cwd,
      async (current) => {
        const attempt = attemptFor(current, executionId),
          execution = requiredExecution(current, executionId);
        if (terminalExecution(execution)) return execution;
        if (attempt.status === "preparing") {
          attempt.status = "rejected";
          attempt.reason = String(error);
          execution.status = {
            kind: "failed",
            failureStage: "preparation",
            failureId: hashOutcomeValue({
              stage: "confirmation-preparation",
              reason: String(error),
            }),
            completedAt: new Date().toISOString(),
            exitCode: null,
          };
          execution.result = classifyResult({ kind: "invalid", execution: "failed" });
          settleInOutcome(current, executionId, {
            kind: "measured",
            seconds: elapsed(current, executionId),
          });
        } else {
          attempt.status = "unknown";
          attempt.reason = String(error);
          execution.status = {
            kind: "unknown",
            reason:
              "GitHub dispatch response is uncertain; reconcile the nominated run without dispatching again.",
            lastKnownPid: null,
          };
          settleInOutcome(current, executionId, {
            kind: "unknown",
            reason: execution.status.reason,
          });
        }
        return execution;
      },
      [],
      true,
    );
  }
}

export async function reconcileOutcomeConfirmation(
  cwd: string,
  executionId: string,
  transport?: GitHubTransport,
  cancel = false,
): Promise<ExecutionReceipt> {
  const state = (await readOutcome(cwd))!;
  const receipt = requiredExecution(state, executionId);
  if (terminalExecution(receipt)) return receipt;
  let attempt = state.confirmations.find((entry) => entry.executionId === executionId);
  if (!attempt || attempt.status === "preparing") {
    if (!cancel) return await dispatchOutcomeConfirmation(cwd, executionId, transport);
    return await withOutcomeMutation(
      cwd,
      async (current) => {
        const execution = requiredExecution(current, executionId);
        const nomination = current.confirmations.find((entry) => entry.executionId === executionId);
        if (terminalExecution(execution)) return execution;
        if (nomination && nomination.status !== "preparing")
          throw new Error(
            "Confirmation dispatch started concurrently; resume cancellation for its existing identity.",
          );
        if (nomination) {
          nomination.status = "rejected";
          nomination.reason = "Cancelled before dispatch.";
        }
        execution.status = {
          kind: "cancelled",
          completedAt: new Date().toISOString(),
          exitCode: null,
          failureId: null,
          failureStage: null,
        };
        execution.result = classifyResult({ kind: "invalid", execution: "failed" });
        execution.consumptionSource = "ticket-wall-clock";
        settleInOutcome(current, executionId, {
          kind: "measured",
          seconds: elapsed(current, executionId),
        });
        return execution;
      },
      [],
      true,
    );
  }
  const api = transport ?? (await githubTransport());
  const authority = authorityFor(state, attempt);
  if (attempt.runId === null) {
    const response = outcomeObject(
      await api.json(
        `${workflowEndpoint(authority)}/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${attempt.nominatedAt}`)}&per_page=100`,
      ),
      "workflow runs",
    );
    if (!Array.isArray(response.workflow_runs) || Number(response.total_count) > 100)
      throw new Error("Workflow run reconciliation is incomplete.");
    const matches = response.workflow_runs
      .map((value: unknown) => outcomeObject(value, "workflow run"))
      .filter((run) => run.display_title === runTitle(attempt!.id));
    if (matches.length !== 1) return receipt;
    const matched = matches[0];
    if (
      matched.head_sha !== authority.workflowRevision ||
      matched.path !== authority.workflow ||
      matched.event !== "workflow_dispatch"
    )
      throw new Error("Matching title belongs to a different workflow revision.");
    const runId = positiveId(matched.id);
    await withOutcomeMutation(
      cwd,
      async (current) => {
        const saved = attemptFor(current, executionId);
        saved.runId = runId;
        saved.status = "running";
      },
      [],
      true,
    );
    attempt = { ...attempt, runId };
  }
  const runPath = `/repos/${authority.repository}/actions/runs/${attempt.runId}`;
  if (cancel) {
    try {
      await api.json(`${runPath}/cancel`, { method: "POST" });
    } catch (error) {
      if (!String(error).includes("409")) throw error;
    }
  }
  const run = outcomeObject(await api.json(runPath), "confirmation run");
  assertRunIdentity(authority, attempt, run);
  if (run.status !== "completed") return requiredExecution((await readOutcome(cwd))!, executionId);
  let proof: ConfirmationProof | null = null;
  let verified: VerifiedConfirmation | null = null;
  let rejection: string | null = null;
  let providerSeconds: number | null = null;
  let disclosedDigest = hashOutcomeValue({ runId: attempt.runId, conclusion: run.conclusion });
  try {
    if (run.conclusion !== "success")
      throw new Error(`Confirmation execution concluded ${String(run.conclusion)}.`);
    const artifacts = outcomeObject(
      await api.json(`${runPath}/artifacts?per_page=100`),
      "confirmation artifacts",
    );
    if (!Array.isArray(artifacts.artifacts) || Number(artifacts.total_count) > 100)
      throw new Error("Confirmation artifact inventory is unavailable.");
    const matches = artifacts.artifacts
      .map((value: unknown) => outcomeObject(value, "artifact"))
      .filter((artifact) => artifact.name === `autoresearch-confirmation-${attempt.id}`);
    if (matches.length !== 1)
      throw new Error("Expected exactly one named confirmation receipt artifact.");
    const artifact = matches[0];
    const archive = await api.artifact(
      `/repos/${authority.repository}/actions/artifacts/${positiveId(artifact.id)}/zip`,
    );
    const stored = await storeOutcomeObject(cwd, archive);
    disclosedDigest = stored.digest;
    const candidateMetadata = outcomeObject(
      await api.json(
        `/repos/${attempt.candidate.repository}/actions/artifacts/${attempt.candidate.artifactId}`,
      ),
      "candidate artifact metadata",
    );
    proof = {
      run,
      artifact,
      receiptArchiveDigest: stored.digest,
      candidateMetadata,
      candidateArchiveDigest: attempt.candidate.digest,
    };
    verified = await verifyConfirmationProof(cwd, state, attempt, proof);
  } catch (error) {
    if (error instanceof ConfirmationUsageExceeded) providerSeconds = error.seconds;
    if (!proof && run.conclusion === "success") {
      return await withOutcomeMutation(
        cwd,
        async (current) => {
          const saved = attemptFor(current, executionId),
            execution = requiredExecution(current, executionId);
          saved.status = "unknown";
          saved.reason = String(error);
          execution.status = {
            kind: "unknown",
            reason:
              "Completed provider run has unavailable proof; resume retrieval without dispatching again.",
            lastKnownPid: null,
          };
          execution.consumptionSource = "unknown";
          settleInOutcome(current, executionId, {
            kind: "unknown",
            reason: execution.status.reason,
          });
          return execution;
        },
        [],
        true,
      );
    }
    rejection = String(error);
  }
  const proofObject = proof
    ? await storeOutcomeObject(cwd, Buffer.from(JSON.stringify(proof)))
    : null;
  return await withOutcomeMutation(
    cwd,
    async (current) => {
      const saved = attemptFor(current, executionId),
        execution = requiredExecution(current, executionId);
      if (terminalExecution(execution)) return execution;
      if (!current.confirmationExposures.some((entry) => entry.attemptId === saved.id))
        current.confirmationExposures.push({
          attemptId: saved.id,
          datasetId: saved.datasetId,
          disclosedAt: new Date().toISOString(),
          feedbackDigest: disclosedDigest,
        });
      saved.feedbackDigest = disclosedDigest;
      saved.proofDigest = proofObject?.digest ?? null;
      saved.status = verified ? "verified" : "rejected";
      saved.reason = rejection;
      execution.status = verified
        ? {
            kind: "completed",
            completedAt: new Date().toISOString(),
            exitCode: 0,
            failureId: null,
            failureStage: null,
          }
        : {
            kind: "failed",
            failureStage: "execution",
            completedAt: new Date().toISOString(),
            exitCode: null,
            failureId: hashOutcomeValue({ run: saved.runId, reason: rejection }),
          };
      execution.observation = verified?.observation ?? null;
      execution.checksPassed = verified?.checksPassed ?? false;
      execution.result =
        !verified || !verified.checksPassed
          ? classifyResult({ kind: "invalid", execution: verified ? "completed" : "failed" })
          : verified.observation.kind === "predicate"
            ? classifyResult(verified.observation)
            : metricResult(
                execution,
                verified.observation.value,
                metricReference(
                  current,
                  execution,
                  await readOutcomeDependencyManifest(current, cwd),
                ),
              );
      execution.completedInput = execution.input;
      execution.consumptionSource = verified || providerSeconds !== null ? "provider" : "estimated";
      if (proofObject)
        execution.outputs.push({ path: proofObject.path, digest: proofObject.digest });
      if (verified || providerSeconds !== null)
        settleInOutcome(current, executionId, {
          kind: "measured",
          seconds: Math.max(elapsed(current, executionId), verified?.seconds ?? providerSeconds!),
        });
      else
        settleInOutcome(current, executionId, {
          kind: "estimated",
          seconds: Math.max(
            current.reservations.find((entry) => entry.id === executionId)!.seconds,
            elapsed(current, executionId),
          ),
          reason:
            "Provider execution ended without valid duration telemetry; charge the larger of reserved exposure and observed elapsed time.",
        });
      return execution;
    },
    [],
    true,
  );
}

function assertRunIdentity(
  authority: ConfirmationAuthority,
  attempt: ConfirmationAttempt,
  run: UnknownRecord,
) {
  const repository = outcomeObject(run.repository, "run repository");
  if (
    run.id !== attempt.runId ||
    run.run_attempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    run.path !== authority.workflow ||
    run.head_sha !== authority.workflowRevision ||
    String(repository.full_name).toLowerCase() !== authority.repository.toLowerCase() ||
    run.display_title !== runTitle(attempt.id) ||
    Date.parse(outcomeTimestamp(run.created_at, "run creation time")) <
      Date.parse(attempt.nominatedAt) - 1000
  )
    throw new Error(
      "Confirmation run, attempt, workflow, revision, repository, title, or nomination time differs from accepted authority.",
    );
}

export async function verifyConfirmationProof(
  cwd: string,
  state: OutcomeState,
  attempt: ConfirmationAttempt,
  proof: ConfirmationProof,
): Promise<VerifiedConfirmation> {
  const authority = authorityFor(state, attempt),
    execution = requiredExecution(state, attempt.executionId);
  assertRunIdentity(authority, attempt, proof.run);
  if (proof.run.status !== "completed" || proof.run.conclusion !== "success")
    throw new Error("Confirmation run did not complete successfully.");
  const artifactRun = outcomeObject(proof.artifact.workflow_run, "artifact producing run");
  if (
    artifactRun.id !== attempt.runId ||
    proof.artifact.name !== `autoresearch-confirmation-${attempt.id}` ||
    artifactDigest(proof.artifact) !== proof.receiptArchiveDigest ||
    proof.candidateMetadata.id !== attempt.candidate.artifactId ||
    artifactDigest(proof.candidateMetadata) !== attempt.candidate.digest ||
    proof.candidateArchiveDigest !== attempt.candidate.digest
  )
    throw new Error(
      "Confirmation or candidate artifact provenance does not match the nominated run.",
    );
  validateConfirmationCandidate(
    readSingleFileArtifact(
      await readOutcomeObject(cwd, attempt.candidate.digest),
      "candidate.json",
      attempt.candidate.digest,
    ),
    attempt.inputDigest,
  );
  const receipt = outcomeObject(
    readSingleFileArtifact(
      await readOutcomeObject(cwd, proof.receiptArchiveDigest),
      "receipt.json",
      proof.receiptArchiveDigest,
    ),
    "confirmation receipt",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.attemptId !== attempt.id ||
    receipt.runId !== attempt.runId ||
    receipt.runAttempt !== 1 ||
    receipt.repository !== authority.repository ||
    receipt.workflow !== authority.workflow ||
    receipt.workflowRevision !== authority.workflowRevision ||
    receipt.candidateArtifactDigest !== attempt.candidate.digest ||
    receipt.candidateInputDigest !== attempt.inputDigest ||
    receipt.protocolDigest !== attempt.protocolDigest ||
    receipt.datasetId !== attempt.datasetId ||
    hashOutcomeValue(receipt.criterionIds) !== hashOutcomeValue(attempt.criterionIds) ||
    receipt.environment !== execution.action.environment ||
    typeof receipt.checksPassed !== "boolean"
  )
    throw new Error(
      "Receipt candidate, workflow, protocol, population, environment, or criterion binding is invalid.",
    );
  const seconds = outcomeNumber(receipt.executionSeconds, "provider execution seconds");
  const reservation = state.reservations.find((entry) => entry.id === execution.id)!;
  const expires = Math.min(
    Date.parse(reservation.reservedAt) + execution.action.seconds * 1000,
    state.contract.budget.deadline ? Date.parse(state.contract.budget.deadline) : Infinity,
  );
  if (
    seconds > execution.action.seconds ||
    (typeof proof.run.updated_at === "string" && Date.parse(proof.run.updated_at) > expires)
  )
    throw new ConfirmationUsageExceeded(seconds);
  const observation = outcomeObject(receipt.observation, "confirmed observation");
  const method = execution.action.evaluator?.method;
  if (
    observation.kind === "predicate" &&
    method?.kind === "predicate" &&
    typeof observation.observed === "string" &&
    ["satisfied", "counterexample", "inconclusive"].includes(observation.observed)
  )
    return {
      attemptId: attempt.id,
      runId: attempt.runId!,
      observation: {
        kind: "predicate",
        observed: observation.observed as "satisfied" | "counterexample" | "inconclusive",
      },
      checksPassed: receipt.checksPassed,
      seconds,
      feedback: receipt.feedback,
    };
  if (
    observation.kind === "metric" &&
    method?.kind === "metric" &&
    typeof observation.value === "number" &&
    Number.isFinite(observation.value)
  )
    return {
      attemptId: attempt.id,
      runId: attempt.runId!,
      observation: { kind: "metric", value: observation.value },
      checksPassed: receipt.checksPassed,
      seconds,
      feedback: receipt.feedback,
    };
  throw new Error("Confirmation observation does not match its accepted evaluator method.");
}

export async function verifiedOutcomeConfirmations(
  cwd: string,
  state: OutcomeState,
): Promise<{ verified: Set<string>; independent: Set<string> }> {
  const verified = new Set<string>(),
    independent = new Set<string>();
  for (const attempt of state.confirmations) {
    if (
      attempt.status !== "verified" ||
      !attempt.proofDigest ||
      attempt.authorityDigest !== hashOutcomeValue(state.contract.confirmation)
    )
      continue;
    try {
      const raw = outcomeObject(
        JSON.parse((await readOutcomeObject(cwd, attempt.proofDigest)).toString()),
        "confirmation proof",
      );
      const proof: ConfirmationProof = {
        run: outcomeObject(raw.run, "run"),
        artifact: outcomeObject(raw.artifact, "artifact"),
        receiptArchiveDigest: outcomeString(raw.receiptArchiveDigest, "receipt archive"),
        candidateMetadata: outcomeObject(raw.candidateMetadata, "candidate metadata"),
        candidateArchiveDigest: outcomeString(raw.candidateArchiveDigest, "candidate archive"),
      };
      const result = await verifyConfirmationProof(cwd, state, attempt, proof);
      const execution = requiredExecution(state, attempt.executionId);
      if (
        hashOutcomeValue(result.observation) !== hashOutcomeValue(execution.observation) ||
        result.checksPassed !== execution.checksPassed
      )
        continue;
      for (const evidence of state.evidence.filter(
        (item) => item.executionId === attempt.executionId,
      )) {
        verified.add(evidence.id);
        const firstExposure = state.confirmationExposures.find(
          (entry) => entry.datasetId === attempt.datasetId,
        );
        if (
          authorityFor(state, attempt).custody === "external" &&
          attempt.fresh &&
          firstExposure?.attemptId === attempt.id
        )
          independent.add(evidence.id);
      }
    } catch {
      /* Missing or substituted proof stays unknown, never independent. */
    }
  }
  return { verified, independent };
}

function metricResult(execution: ExecutionReceipt, value: number, reference: number | null) {
  const method = execution.action.evaluator?.method;
  if (method?.kind !== "metric") return classifyResult({ kind: "invalid", execution: "completed" });
  return classifyResult({
    kind: "metric",
    value,
    reference,
    direction: method.direction,
    minimumImprovement: method.minimumImprovement,
    tolerance: method.tolerance,
    target: method.target,
  });
}
function elapsed(state: OutcomeState, id: string) {
  return Math.max(
    0,
    (Date.now() - Date.parse(state.reservations.find((entry) => entry.id === id)!.reservedAt)) /
      1000,
  );
}
