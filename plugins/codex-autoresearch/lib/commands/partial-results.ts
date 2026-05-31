import { createHash } from "node:crypto";
import path from "node:path";
import { mergeEvidenceClaims } from "../evidence-index.js";
import {
  buildPartialResultEvidenceClaim,
  discoverPartialResultCandidates,
} from "../partial-results.js";

type LooseObject = Record<string, any>;

export interface PartialResultsCommandDeps {
  appendJsonl: (workDir: string, entry: LooseObject) => void;
  assertFreshLastRunPacket: (workDir: string, packet: LooseObject) => Promise<void>;
  boolOption: (value: unknown, fallback?: boolean) => boolean;
  computeConfidence: (runs: LooseObject[], direction: string) => number | null;
  currentState: (workDir: string) => LooseObject;
  deleteLastRunPacket: (workDir: string) => Promise<void>;
  finiteMetric: (value: unknown) => number | null;
  loopContinuation: (
    workDir: string,
    state: LooseObject,
    config: LooseObject,
    lastAction?: string,
  ) => LooseObject;
  readConfig: (workDir: string) => LooseObject;
  readLastRunPacket: (workDir: string) => Promise<LooseObject | null>;
  researchSlugFromArgs: (args: LooseObject) => string;
  resolveWorkDir: (value: string) => { workDir: string };
}

export function createPartialResultsCommand(deps: PartialResultsCommandDeps) {
  return async function partialResultsCommand(args: LooseObject) {
    const { workDir } = deps.resolveWorkDir(args.working_dir || args.cwd);
    const state = deps.currentState(workDir);
    const artifact = args.artifact ? String(args.artifact) : "";
    const recordId = args.record ? String(args.record).trim() : "";
    const fromLast = deps.boolOption(
      args.from_last ?? args.fromLast,
      !artifact || Boolean(recordId),
    );
    const lastRun = fromLast || recordId ? await deps.readLastRunPacket(workDir) : null;
    if (lastRun) await deps.assertFreshLastRunPacket(workDir, lastRun);
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
    const candidate = discovery.candidates.find((item: any) => item.id === recordId);
    if (!candidate) throw new Error(`partial result candidate not found: ${recordId}`);
    return await recordPartialResultCandidate({ workDir, state, lastRun, candidate, args }, deps);
  };
}

function partialResultPacketFromArtifact({
  artifact,
  commandHash,
  state,
  workDir,
}: LooseObject): LooseObject {
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

function lastRunConfigSnapshot(config: LooseObject = {}) {
  return {
    name: config.name || null,
    metricName: config.metricName || "metric",
    metricUnit: config.metricUnit ?? "",
    bestDirection: config.bestDirection === "higher" ? "higher" : "lower",
  };
}

async function recordPartialResultCandidate(
  { workDir, state, lastRun, candidate, args }: LooseObject,
  deps: PartialResultsCommandDeps,
) {
  const metricName = candidate.metricName || state.config?.metricName || "metric";
  const metric = deps.finiteMetric(candidate.metricValue);
  if (metric == null) {
    throw new Error(
      `partial result candidate ${candidate.id} has no finite metric and must stay manual-review only.`,
    );
  }
  const sourcePacketId = lastRun?.packetEvidence?.packetId || "";
  const researchSlug = deps.researchSlugFromArgs({
    slug: args.research_slug ?? args.researchSlug ?? "partial-results",
  });
  const evidenceClaim = buildPartialResultEvidenceClaim(candidate);
  const evidenceIndex = await mergeEvidenceClaims(workDir, researchSlug, [evidenceClaim]);
  const experiment: LooseObject = {
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
  experiment.confidence = deps.computeConfidence(
    [...state.current, experiment],
    state.config?.bestDirection || "lower",
  );
  deps.appendJsonl(workDir, experiment);
  await deps.deleteLastRunPacket(workDir);
  const stateAfter = deps.currentState(workDir);
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
    continuation: deps.loopContinuation(workDir, stateAfter, deps.readConfig(workDir), "logged"),
  };
}
