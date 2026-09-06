import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { captureOutcomeInputs, pathInsideScope } from "./outcome-inputs.js";
import {
  createOwnedCandidatePatch,
  readOutcomeObject,
  storeOutcomeObject,
} from "./outcome-artifacts.js";
import { buildOutcomeEvidenceRegistry, readOutcomeDependencyManifest } from "./outcome-evidence.js";
import { verifiedOutcomeConfirmations } from "./github-confirmation.js";
import { githubTransport, type GitHubTransport } from "./github-artifact.js";
import { readOutcome, withOutcomeMutation } from "./outcome-store.js";
import { requiredExecution, settleElapsed, terminalExecution } from "./investigation-workflow.js";
import { classifyResult } from "./result-semantics.js";
import {
  hashOutcomeValue,
  outcomeDigest,
  outcomeEnum,
  outcomeId,
  outcomeObject,
  outcomeString,
  outcomeStrings,
  outcomeTimestamp,
  type OutcomeState,
  type DeliveryEndpoint,
} from "./outcome-contract.js";
import type { InputFingerprint } from "./investigation-records.js";

export interface OutcomeDeliveryTarget {
  repository: string;
  ref: string;
  environment: string | null;
}
export interface OutcomeDeliveryRecord {
  id: string;
  specificationDigest: string;
  executionId: string;
  authorizationDigest: string;
  endpoint: DeliveryEndpoint;
  inputDigest: string;
  candidateExecutionId: string | null;
  paths: string[];
  criterionEvidenceIds: string[];
  artifactDigest: string;
  externalProofDigest: string | null;
  deliveredAt: string;
}
export function parseOutcomeDeliveryTarget(value: unknown): OutcomeDeliveryTarget | null {
  if (value == null) return null;
  const input = outcomeObject(value, "delivery target");
  const repository = outcomeString(input.repository, "delivery repository");
  const ref = outcomeString(input.ref, "delivery ref");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[A-Za-z0-9_./-]+$/.test(ref) ||
    ref.includes("..")
  )
    throw new Error("Delivery needs an explicit GitHub repository and ref.");
  return {
    repository,
    ref,
    environment:
      input.environment == null ? null : outcomeString(input.environment, "delivery environment"),
  };
}
export function parseOutcomeDeliveryRecord(value: unknown): OutcomeDeliveryRecord {
  const input = outcomeObject(value, "delivery receipt");
  return {
    id: outcomeId(input.id, "delivery ID"),
    specificationDigest: outcomeDigest(input.specificationDigest),
    executionId: outcomeId(input.executionId, "delivery execution"),
    authorizationDigest: outcomeDigest(input.authorizationDigest),
    endpoint: outcomeEnum(
      input.endpoint,
      ["answer", "patch", "integrated", "deployed"],
      "delivery endpoint",
    ),
    inputDigest: outcomeDigest(input.inputDigest),
    candidateExecutionId:
      input.candidateExecutionId == null
        ? null
        : outcomeId(input.candidateExecutionId, "candidate execution"),
    paths: outcomeStrings(input.paths, "delivered paths", true),
    criterionEvidenceIds: outcomeStrings(input.criterionEvidenceIds, "delivery evidence"),
    artifactDigest: outcomeDigest(input.artifactDigest),
    externalProofDigest:
      input.externalProofDigest == null ? null : outcomeDigest(input.externalProofDigest),
    deliveredAt: outcomeTimestamp(input.deliveredAt, "delivery time"),
  };
}

/** CLI-owned, idempotent delivery transaction. This never publishes or edits candidate code. */
export async function logOutcomeDelivery(
  cwd: string,
  value: unknown,
  transport?: GitHubTransport,
): Promise<OutcomeDeliveryRecord> {
  cwd = await fsp.realpath(cwd);
  const input = outcomeObject(value, "delivery record");
  const request = outcomeObject(input.delivery, "delivery request");
  const id = outcomeId(input.id, "delivery ID");
  const executionId = outcomeId(input.executionId, "delivery execution ID");
  const prior = await readOutcome(cwd);
  if (!prior) throw new Error("No outcome exists.");
  const existing = prior.deliveries.find((item) => item.id === id);
  if (existing) {
    if (existing.specificationDigest !== hashOutcomeValue(input))
      throw new Error("Delivery identity belongs to different content.");
    return existing;
  }
  const receiptBefore = requiredExecution(prior, executionId);
  if (receiptBefore.worktree !== cwd)
    throw new Error("Delivery must run in its authorized worktree.");
  const fingerprint = await captureOutcomeInputs(cwd, receiptBefore.action.environment);
  const confirmations = await verifiedOutcomeConfirmations(cwd, prior);
  const manifest = await readOutcomeDependencyManifest(prior, cwd);
  try {
    return await withOutcomeMutation(cwd, async (state) => {
      const receipt = requiredExecution(state, executionId);
      const saved = state.deliveries.find((item) => item.id === id);
      if (saved) {
        if (saved.specificationDigest !== hashOutcomeValue(input))
          throw new Error("Delivery identity belongs to different content.");
        return saved;
      }
      if (
        receipt.action.purpose !== "delivery" ||
        receipt.authorizationDigest !== state.contract.digest ||
        !receipt.input ||
        receipt.status.kind !== "ticket" ||
        receipt.action.mode !== "managed"
      )
        throw new Error("Delivery requires a current authorized delivery action.");
      if (state.executions.some((entry) => entry.id !== receipt.id && !terminalExecution(entry)))
        throw new Error("Reconcile outstanding execution before delivery.");
      if (receipt.input.digest !== fingerprint.digest)
        throw new Error("Delivery input differs from its authorized action.");
      const coverage = buildOutcomeEvidenceRegistry({
        state,
        input: fingerprint,
        manifest,
        verifiedConfirmations: confirmations.verified,
        independentConfirmations: confirmations.independent,
      });
      if (coverage.criteria.some((criterion) => criterion.status !== "satisfied"))
        throw new Error("Delivery requires current evidence for every accepted criterion.");
      const reservation = state.reservations.find((entry) => entry.id === receipt.id)!;
      const remaining = () =>
        Math.min(
          receipt.action.seconds - (Date.now() - Date.parse(reservation.reservedAt)) / 1000,
          state.contract.budget.deadline
            ? (Date.parse(state.contract.budget.deadline) - Date.now()) / 1000
            : Infinity,
        );
      if (!(remaining() > 0)) throw new Error("Delivery action allowance has expired.");
      const endpoint = state.contract.authorization.delivery;
      let candidateExecutionId: string | null = null;
      let paths: string[] = [];
      let artifact: { digest: string; path: string };
      if (endpoint === "answer")
        artifact = await storeOutcomeObject(
          cwd,
          Buffer.from(outcomeString(request.answer, "delivered answer")),
        );
      else {
        candidateExecutionId = outcomeId(request.candidateExecutionId, "candidate execution");
        const candidate = requiredExecution(state, candidateExecutionId);
        if (
          candidate.worktree !== cwd ||
          candidate.status.kind !== "completed" ||
          candidate.completedInput?.digest !== fingerprint.digest ||
          !candidate.action.effects.includes("edit")
        )
          throw new Error(
            "Candidate changes lack an owning completed edit action for these exact inputs.",
          );
        const checks = state.executions.some(
          (entry) =>
            entry.action.mode === "process" &&
            entry.status.kind === "completed" &&
            entry.status.exitCode === 0 &&
            entry.checksPassed === true &&
            Boolean(entry.action.evaluator?.checkArgv.length) &&
            entry.result?.validity === "valid" &&
            entry.completedInput?.digest === fingerprint.digest,
        );
        if (!checks)
          throw new Error("Code acceptance requires actual current worker correctness checks.");
        paths = outcomeStrings(request.paths, "delivery paths");
        if (paths.some((file) => !pathInsideScope(file, candidate.action.paths)))
          throw new Error("Delivery paths exceed the owning edit action.");
        artifact = await createOwnedCandidatePatch(
          cwd,
          state,
          fingerprint,
          paths,
          remaining(),
          candidateExecutionId,
        );
        const complete = await createOwnedCandidatePatch(
          cwd,
          state,
          fingerprint,
          candidate.action.paths,
          remaining(),
          candidateExecutionId,
        );
        if (artifact.digest !== complete.digest)
          throw new Error(
            "Delivery must include the complete owned delta of the assessed candidate. Preserve subsets as retained patches and assess their application separately.",
          );
        if (!(await readOutcomeObject(cwd, artifact.digest)).length)
          throw new Error("Selected candidate has no owned patch to deliver.");
      }
      let externalProofDigest: string | null = null;
      if (endpoint === "integrated" || endpoint === "deployed") {
        const effect = endpoint === "integrated" ? "git" : "publish";
        if (!receipt.action.effects.includes(effect))
          throw new Error(`Delivery endpoint requires accepted ${effect} authority.`);
        const proof = await verifyExternalDelivery(
          cwd,
          state,
          fingerprint,
          request,
          transport ?? (await githubTransport()),
        );
        externalProofDigest = (await storeOutcomeObject(cwd, Buffer.from(JSON.stringify(proof))))
          .digest;
      }
      if (
        (await captureOutcomeInputs(cwd, receipt.action.environment)).digest !==
          fingerprint.digest ||
        !(remaining() > 0)
      )
        throw new Error("Delivery allowance or input provenance changed before commit.");
      const delivery: OutcomeDeliveryRecord = {
        id,
        specificationDigest: hashOutcomeValue(input),
        executionId,
        authorizationDigest: state.contract.digest,
        endpoint,
        inputDigest: fingerprint.digest,
        candidateExecutionId,
        paths,
        criterionEvidenceIds: [
          ...new Set(coverage.criteria.flatMap((criterion) => criterion.evidenceIds)),
        ],
        artifactDigest: artifact.digest,
        externalProofDigest,
        deliveredAt: new Date().toISOString(),
      };
      const deliveryManifest = await storeOutcomeObject(cwd, Buffer.from(JSON.stringify(delivery)));
      const externalOutput = externalProofDigest
        ? await storeOutcomeObject(cwd, await readOutcomeObject(cwd, externalProofDigest))
        : null;
      if (!(remaining() > 0))
        throw new Error("Delivery allowance expired during artifact recording.");
      receipt.status = {
        kind: "completed",
        completedAt: delivery.deliveredAt,
        exitCode: 0,
        failureId: null,
        failureStage: null,
      };
      settleElapsed(state, receipt);
      receipt.consumptionSource = "ticket-wall-clock";
      receipt.completedInput = fingerprint;
      receipt.result = classifyResult(
        { kind: "predicate", observed: "satisfied" },
        endpoint === "answer" ? "unassessed" : "accepted",
      );
      receipt.outputs.push({ path: artifact.path, digest: artifact.digest }, deliveryManifest);
      if (externalOutput) receipt.outputs.push(externalOutput);
      state.deliveries.push(delivery);
      return delivery;
    });
  } catch (error) {
    await withOutcomeMutation(
      cwd,
      async (state) => {
        const receipt = requiredExecution(state, executionId);
        const reservation = state.reservations.find((entry) => entry.id === receipt.id)!;
        const deadline = Math.min(
          Date.parse(reservation.reservedAt) + receipt.action.seconds * 1000,
          state.contract.budget.deadline ? Date.parse(state.contract.budget.deadline) : Infinity,
        );
        if (!terminalExecution(receipt) && Date.now() >= deadline) {
          receipt.status = {
            kind: "failed",
            completedAt: new Date().toISOString(),
            exitCode: null,
            failureStage: "execution",
            failureId: hashOutcomeValue({
              action: receipt.action.digest,
              reason: "delivery-allowance-expired",
            }),
          };
          receipt.result = classifyResult({ kind: "invalid", execution: "failed" });
          receipt.consumptionSource = "ticket-wall-clock";
          settleElapsed(state, receipt);
        }
      },
      [],
      true,
    );
    throw error;
  }
}

async function verifyExternalDelivery(
  cwd: string,
  state: OutcomeState,
  input: InputFingerprint,
  request: Record<string, unknown>,
  api: GitHubTransport,
) {
  const target = state.contract.deliveryTarget;
  if (!target) throw new Error("External delivery requires an accepted repository and target ref.");
  const commit = outcomeObject(
    await api.json(`/repos/${target.repository}/commits/${encodeURIComponent(target.ref)}`),
    "delivery target commit",
  );
  const sha = outcomeString(commit.sha, "target commit SHA");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Target commit is not immutable.");
  const treeSha = outcomeString(
    outcomeObject(outcomeObject(commit.commit, "commit object").tree, "commit tree").sha,
    "commit tree SHA",
  );
  if (!/^[a-f0-9]{40}$/.test(treeSha)) throw new Error("Target tree is not immutable.");
  const tree = outcomeObject(
    await api.json(`/repos/${target.repository}/git/trees/${treeSha}?recursive=1`),
    "delivery tree",
  );
  if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree))
    throw new Error("Complete delivered Git tree is unavailable.");
  const remoteFiles = tree.tree
    .map((item: unknown) => outcomeObject(item, "Git tree entry"))
    .filter((entry) => entry.type !== "tree");
  const expected = await assessedGitFiles(cwd, input);
  if (
    remoteFiles.length !== Object.keys(expected).length ||
    remoteFiles.some(
      (entry) =>
        typeof entry.path !== "string" ||
        !expected[entry.path] ||
        expected[entry.path].sha !== entry.sha ||
        expected[entry.path].mode !== entry.mode,
    )
  )
    throw new Error(
      "Delivered repository tree differs from the assessed complete input; untracked or ignored inputs also need explicit assessment.",
    );
  let deployment: unknown = null,
    statuses: unknown = null;
  if (state.contract.authorization.delivery === "deployed") {
    if (!target.environment) throw new Error("Deployment requires an accepted environment.");
    const id = Number(request.deploymentId);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error("Deployment requires an existing GitHub deployment ID.");
    deployment = await api.json(`/repos/${target.repository}/deployments/${id}`);
    const deployed = outcomeObject(deployment, "deployment");
    if (deployed.sha !== sha || deployed.environment !== target.environment)
      throw new Error("Deployment does not bind the accepted environment and candidate commit.");
    statuses = await api.json(`/repos/${target.repository}/deployments/${id}/statuses?per_page=1`);
    if (!Array.isArray(statuses)) throw new Error("Deployment has no current provider status.");
    const latest = outcomeObject(statuses[0], "deployment status");
    if (
      deployed.id !== id ||
      latest.state !== "success" ||
      latest.environment !== target.environment ||
      latest.deployment_url !==
        `https://api.github.com/repos/${target.repository}/deployments/${id}`
    )
      throw new Error(
        "Deployment status does not prove the accepted environment and deployment identity.",
      );
  }
  return {
    schemaVersion: 1,
    endpoint: state.contract.authorization.delivery,
    target,
    inputDigest: input.digest,
    commit,
    tree,
    expected,
    deployment,
    statuses,
  };
}

/** Revalidate immutable delivery artifacts; current criterion applicability is compiled separately. */
export async function verifiedOutcomeDeliveries(
  cwd: string,
  state: OutcomeState,
): Promise<Set<string>> {
  const verified = new Set<string>();
  for (const delivery of state.deliveries) {
    try {
      const execution = requiredExecution(state, delivery.executionId);
      if (
        delivery.authorizationDigest !== state.contract.digest ||
        delivery.endpoint !== state.contract.authorization.delivery ||
        execution.action.purpose !== "delivery" ||
        execution.status.kind !== "completed" ||
        execution.completedInput?.digest !== delivery.inputDigest
      )
        continue;
      const manifestDigest = createHash("sha256").update(JSON.stringify(delivery)).digest("hex");
      if (
        !execution.outputs.some((output) => output.digest === manifestDigest) ||
        !execution.outputs.some((output) => output.digest === delivery.artifactDigest)
      )
        continue;
      if (
        hashOutcomeValue(JSON.parse((await readOutcomeObject(cwd, manifestDigest)).toString())) !==
        hashOutcomeValue(delivery)
      )
        continue;
      await readOutcomeObject(cwd, delivery.artifactDigest);
      if (delivery.endpoint !== "answer") {
        const candidate = requiredExecution(state, delivery.candidateExecutionId!);
        if (
          candidate.completedInput?.digest !== delivery.inputDigest ||
          !candidate.action.effects.includes("edit")
        )
          continue;
      }
      if (["integrated", "deployed"].includes(delivery.endpoint)) {
        if (
          !delivery.externalProofDigest ||
          !execution.outputs.some((output) => output.digest === delivery.externalProofDigest)
        )
          continue;
        const proof = outcomeObject(
          JSON.parse((await readOutcomeObject(cwd, delivery.externalProofDigest)).toString()),
          "delivery proof",
        );
        if (
          proof.inputDigest !== delivery.inputDigest ||
          proof.endpoint !== delivery.endpoint ||
          hashOutcomeValue(proof.target) !== hashOutcomeValue(state.contract.deliveryTarget)
        )
          continue;
        const current = await captureOutcomeInputs(cwd, execution.action.environment);
        if (
          current.digest !== delivery.inputDigest ||
          hashOutcomeValue(await assessedGitFiles(cwd, current)) !==
            hashOutcomeValue(proof.expected)
        )
          continue;
        validateStoredExternalProof(proof, state);
      }
      verified.add(delivery.id);
    } catch {
      /* Substituted or missing artifacts cannot establish delivery. */
    }
  }
  return verified;
}

async function assessedGitFiles(
  cwd: string,
  input: InputFingerprint,
): Promise<Record<string, { sha: string; mode: string }>> {
  const expected: Record<string, { sha: string; mode: string }> = Object.create(null);
  for (const file of Object.keys(input.files)) {
    const absolute = path.join(cwd, file),
      stat = await fsp.lstat(absolute);
    if (stat.isDirectory()) continue;
    const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
    if (stat.isSymbolicLink()) {
      const target = await fsp.readlink(absolute),
        bytes = Buffer.from(target);
      if (hashOutcomeValue({ kind: "symlink", target }) !== input.files[file])
        throw new Error("Delivery link differs from its assessed input.");
      expected[file] = {
        sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
        mode,
      };
    } else {
      if (!stat.isFile()) throw new Error("Delivery input is not a regular file.");
      const fingerprint = createHash("sha256").update(
        mode === "100755" ? "executable\0" : "file\0",
      );
      const blob = createHash("sha1").update(`blob ${stat.size}\0`);
      let size = 0;
      for await (const chunk of createReadStream(absolute)) {
        size += chunk.length;
        fingerprint.update(chunk);
        blob.update(chunk);
      }
      if (size !== stat.size || fingerprint.digest("hex") !== input.files[file])
        throw new Error("Delivery bytes differ from the assessed input.");
      expected[file] = { sha: blob.digest("hex"), mode };
    }
  }
  return expected;
}

function validateStoredExternalProof(proof: Record<string, unknown>, state: OutcomeState): void {
  const target = state.contract.deliveryTarget!;
  const commit = outcomeObject(proof.commit, "commit proof"),
    tree = outcomeObject(proof.tree, "tree proof");
  const treeSha = outcomeObject(outcomeObject(commit.commit, "commit").tree, "commit tree").sha;
  const expected = outcomeObject(proof.expected, "assessed Git files");
  if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree))
    throw new Error("Delivered tree proof is incomplete or substituted.");
  const files = tree.tree
    .map((entry: unknown) => outcomeObject(entry, "tree entry"))
    .filter((entry) => entry.type !== "tree");
  if (
    files.length !== Object.keys(expected).length ||
    files.some((entry) => {
      const file = typeof entry.path === "string" ? expected[entry.path] : null;
      return (
        !file ||
        outcomeObject(file, "assessed file").sha !== entry.sha ||
        outcomeObject(file, "assessed file").mode !== entry.mode
      );
    })
  )
    throw new Error("Delivered Git tree differs from assessed input.");
  if (state.contract.authorization.delivery === "deployed") {
    const deployment = outcomeObject(proof.deployment, "deployment proof");
    if (!Array.isArray(proof.statuses)) throw new Error("Deployment status is missing.");
    const status = outcomeObject(proof.statuses[0], "deployment status proof");
    if (
      deployment.sha !== commit.sha ||
      deployment.environment !== target.environment ||
      status.state !== "success" ||
      status.environment !== target.environment ||
      status.deployment_url !==
        `https://api.github.com/repos/${target.repository}/deployments/${String(deployment.id)}`
    )
      throw new Error("Deployment status does not prove the accepted target.");
  }
}
