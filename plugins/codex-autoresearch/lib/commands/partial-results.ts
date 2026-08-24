import { createHash } from "node:crypto";
import path from "node:path";
import { mergeEvidenceClaims } from "../evidence-index.js";
import {
  buildPartialResultEvidenceClaim,
  discoverPartialResultCandidates,
  type PartialResultCandidate,
} from "../partial-results.js";
import { boolOption } from "../cli/args.js";
import { resolveAuthorizedWorkDir } from "../cli/workdir-context.js";
import {
  computeConfidence,
  currentState,
  finiteMetric,
  researchSlugFromArgs,
} from "../session-core.js";
import { appendJsonl } from "../session-records.js";
import { assertFreshLastRunPacket, readLastRunPacket } from "../last-run-store.js";
import { deleteLastRunPacket } from "./log.js";
import type { UnknownRecord } from "../types/json.js";
import type { LastRunPacket } from "../types/packet.js";

type SessionState = ReturnType<typeof currentState>;

export async function partialResultsCommand(args: UnknownRecord) {
  const { workDir, config } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  const state = currentState(workDir);
  const artifact = args.artifact ? String(args.artifact) : "";
  const recordId = args.record ? String(args.record).trim() : "";
  const fromLast = boolOption(args.from_last ?? args.fromLast, !artifact || Boolean(recordId));
  const lastRun = fromLast || recordId ? await readLastRunPacket(workDir) : null;
  if (lastRun) await assertFreshLastRunPacket(workDir, lastRun, config);
  const lastRunPacket =
    lastRun ||
    partialResultPacketFromArtifact({
      artifact,
      commandHash: args.command_hash ?? args.commandHash,
      state,
      workDir,
    });
  const discovery = await discoverPartialResultCandidates({
    workDir,
    primaryMetricName: state.config?.metricName || "metric",
    lastRunPacket,
  });
  if (!recordId) {
    return {
      ok: true,
      workDir,
      source: lastRun ? "last-run" : "artifact",
      candidates: discovery.candidates,
      skippedArtifacts: discovery.skippedArtifacts,
      nextAction: discovery.candidates.length
        ? "Review a candidate, then record it as diagnostic measure evidence with --record <candidate-id>."
        : "No partial-result candidates were found.",
    };
  }
  if (!lastRun) {
    throw new Error(
      "--record requires a fresh last-run packet so salvaged evidence links to its source packet.",
    );
  }
  const candidate = discovery.candidates.find((item) => item.id === recordId);
  if (!candidate) throw new Error(`partial result candidate not found: ${recordId}`);
  return await recordPartialResultCandidate({ workDir, state, lastRun, candidate, args });
}

function partialResultPacketFromArtifact({
  artifact,
  commandHash,
  state,
  workDir,
}: {
  artifact: string;
  commandHash: unknown;
  state: SessionState;
  workDir: string;
}): LastRunPacket {
  if (!artifact) throw new Error("--artifact is required unless --from-last is used.");
  const artifactPath = path.isAbsolute(artifact) ? path.resolve(artifact) : artifact;
  return {
    ok: false,
    workDir,
    history: {
      segment: state.segment,
      config: lastRunConfigSnapshot(state.config),
      nextRun: state.results.length + 1,
    },
    packetEvidence: {
      packetId: `artifact-${createHash("sha256").update(String(artifactPath)).digest("hex").slice(0, 12)}`,
      metricName: state.config?.metricName || "metric",
      commandIdentity: {
        commandHash: commandHash ? String(commandHash) : "",
      },
      artifacts: [
        {
          name: path.basename(String(artifactPath)) || "partial-result",
          path: String(artifactPath),
          exists: true,
          quarantined: false,
        },
      ],
    },
  };
}

function lastRunConfigSnapshot(config: UnknownRecord = {}) {
  return {
    name: config.name || null,
    metricName: config.metricName || "metric",
    metricUnit: config.metricUnit ?? "",
    bestDirection: config.bestDirection === "higher" ? "higher" : "lower",
  };
}

async function recordPartialResultCandidate({
  workDir,
  state,
  lastRun,
  candidate,
  args,
}: {
  workDir: string;
  state: SessionState;
  lastRun: LastRunPacket;
  candidate: PartialResultCandidate;
  args: UnknownRecord;
}) {
  const metricName = candidate.metricName || state.config?.metricName || "metric";
  const metric = finiteMetric(candidate.metricValue);
  if (metric == null) {
    throw new Error(
      `partial result candidate ${candidate.id} has no finite metric and must stay manual-review only.`,
    );
  }
  const sourcePacketId = lastRun?.packetEvidence?.packetId || "";
  const researchSlug = researchSlugFromArgs({
    slug: args.research_slug ?? args.researchSlug ?? "partial-results",
  });
  const evidenceClaim = buildPartialResultEvidenceClaim(candidate);
  const evidenceIndex = await mergeEvidenceClaims(workDir, researchSlug, [evidenceClaim]);
  const experiment: UnknownRecord = {
    run: state.results.length + 1,
    commit: "",
    metric,
    metrics: {
      [metricName]: metric,
    },
    metricEligible: false,
    status: "measure",
    description:
      args.description ||
      `Diagnostic partial result from ${candidate.artifactName} row ${candidate.rowIndex}.`,
    timestamp: Date.now(),
    segment: state.segment,
    confidence: null,
    promotion: {
      label: "measurement",
      reasons: ["Recorded from a partial-result salvage candidate; diagnostic measure only."],
    },
    asi: {
      hypothesis: "Recover diagnostic evidence from a partial benchmark artifact.",
      evidence: `${metricName}=${metric} from ${candidate.artifactPath} row ${candidate.rowIndex}.`,
      rollback_reason:
        "Source packet crashed or timed out, so this evidence cannot be treated as promotion-grade.",
      next_action_hint:
        "Use this diagnostic row to choose the next packet; rerun fresh before promotion.",
      partial_result: {
        candidateId: candidate.id,
        status: candidate.status,
        reason: candidate.reason,
        sourcePacketId,
        artifactName: candidate.artifactName,
        artifactPath: candidate.artifactPath,
        rowIndex: candidate.rowIndex,
        provenance: candidate.provenance,
        evidenceClaimId: evidenceClaim.id,
        researchSlug,
      },
      promotionGrade: false,
    },
    artifacts: {
      [candidate.artifactName]: candidate.artifactPath,
    },
    partialResult: {
      candidateId: candidate.id,
      sourcePacketId,
      evidenceClaimId: evidenceClaim.id,
      researchSlug,
      validationStatus: candidate.status,
    },
  };
  experiment.confidence = computeConfidence(
    [...state.current, experiment],
    state.config?.bestDirection || "lower",
  );
  appendJsonl(workDir, experiment);
  await deleteLastRunPacket(workDir);
  const stateAfter = currentState(workDir);
  return {
    ok: true,
    workDir,
    experiment,
    evidenceClaim,
    evidenceIndex: {
      slug: researchSlug,
      claims: evidenceIndex.claims.length,
    },
    lastRunCleared: true,
    baseline: stateAfter.baseline,
    best: stateAfter.best,
    confidence: stateAfter.confidence,
  };
}
