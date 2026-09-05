import {
  outcomeDigest,
  outcomeEnum,
  outcomeId,
  outcomeNumber,
  outcomeObject,
  outcomeString,
  outcomeStrings,
  outcomeTimestamp,
} from "./outcome-contract.js";
import { parseInputFingerprint, type InputFingerprint } from "./investigation-records.js";

export interface CandidateArtifactReference {
  repository: string;
  artifactId: number;
  digest: string;
}
export interface ConfirmationAttempt {
  id: string;
  executionId: string;
  authorityDigest: string;
  candidate: CandidateArtifactReference;
  inputDigest: string;
  criterionIds: string[];
  datasetId: string;
  protocolDigest: string;
  nominatedAt: string;
  dispatchStartedAt: string | null;
  runId: number | null;
  status: "preparing" | "dispatching" | "running" | "unknown" | "verified" | "rejected";
  proofDigest: string | null;
  feedbackDigest: string | null;
  fresh: boolean;
  reason: string | null;
}
export interface ConfirmationExposure {
  attemptId: string;
  datasetId: string;
  disclosedAt: string;
  feedbackDigest: string;
}
export interface ConfirmationCandidate {
  schemaVersion: 1;
  input: InputFingerprint;
  files: Record<string, { kind: "file" | "symlink"; executable: boolean; bytesBase64: string }>;
}

export function githubRepository(value: unknown): string {
  const repository = outcomeString(value, "GitHub repository");
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository))
    throw new Error("GitHub repository must be owner/name.");
  return repository;
}
export function positiveId(value: unknown): number {
  const id = outcomeNumber(value, "provider identity", 1);
  if (!Number.isSafeInteger(id)) throw new Error("Provider identity must be an integer.");
  return id;
}
export function parseCandidateArtifactReference(value: unknown): CandidateArtifactReference {
  const input = outcomeObject(value, "confirmation candidate artifact");
  return {
    repository: githubRepository(input.repository),
    artifactId: positiveId(input.artifactId),
    digest: outcomeDigest(input.digest, "candidate artifact digest"),
  };
}
export function parseConfirmationAttempt(value: unknown): ConfirmationAttempt {
  const input = outcomeObject(value, "confirmation attempt");
  if (typeof input.fresh !== "boolean")
    throw new Error("Confirmation exposure status must be explicit.");
  return {
    id: outcomeId(input.id),
    executionId: outcomeId(input.executionId),
    authorityDigest: outcomeDigest(input.authorityDigest),
    candidate: parseCandidateArtifactReference(input.candidate),
    inputDigest: outcomeDigest(input.inputDigest),
    criterionIds: outcomeStrings(input.criterionIds, "confirmation criteria"),
    datasetId: outcomeString(input.datasetId, "dataset identity"),
    protocolDigest: outcomeDigest(input.protocolDigest),
    nominatedAt: outcomeTimestamp(input.nominatedAt, "nomination time"),
    dispatchStartedAt:
      input.dispatchStartedAt == null
        ? null
        : outcomeTimestamp(input.dispatchStartedAt, "dispatch time"),
    runId: input.runId == null ? null : positiveId(input.runId),
    status: outcomeEnum(
      input.status,
      ["preparing", "dispatching", "running", "unknown", "verified", "rejected"],
      "confirmation status",
    ),
    proofDigest: input.proofDigest == null ? null : outcomeDigest(input.proofDigest),
    feedbackDigest: input.feedbackDigest == null ? null : outcomeDigest(input.feedbackDigest),
    fresh: input.fresh,
    reason: input.reason == null ? null : outcomeString(input.reason, "confirmation reason"),
  };
}
export function parseConfirmationExposure(value: unknown): ConfirmationExposure {
  const input = outcomeObject(value, "confirmation exposure");
  return {
    attemptId: outcomeId(input.attemptId),
    datasetId: outcomeString(input.datasetId, "dataset identity"),
    disclosedAt: outcomeTimestamp(input.disclosedAt, "disclosure time"),
    feedbackDigest: outcomeDigest(input.feedbackDigest),
  };
}
export function parseConfirmationCandidate(value: unknown): ConfirmationCandidate {
  const input = outcomeObject(value, "confirmation candidate");
  if (input.schemaVersion !== 1) throw new Error("Unsupported confirmation candidate schema.");
  const files = outcomeObject(input.files, "candidate contents");
  return {
    schemaVersion: 1,
    input: parseInputFingerprint(input.input),
    files: Object.fromEntries(
      Object.entries(files).map(([file, value]) => {
        const entry = outcomeObject(value, "candidate file");
        if (typeof entry.executable !== "boolean" || typeof entry.bytesBase64 !== "string")
          throw new Error("Candidate file content and mode must be explicit.");
        return [
          file,
          {
            kind: outcomeEnum(entry.kind, ["file", "symlink"], "candidate entry kind"),
            executable: entry.executable,
            bytesBase64: entry.bytesBase64,
          },
        ];
      }),
    ),
  };
}
