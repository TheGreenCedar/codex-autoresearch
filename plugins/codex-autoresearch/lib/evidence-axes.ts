import type { UnknownRecord } from "./types/json.js";

export type RunPurpose = "baseline" | "candidate" | "holdout" | "diagnostic";
export type EvaluationAuthority = "accepted-contract" | "manual" | "external";
export type CandidateOrigin =
  | { kind: "working-tree" }
  | { kind: "commit"; oid: string }
  | { kind: "none" };

export type EvidenceAxesParseResult =
  | {
      valid: true;
      runPurpose: RunPurpose;
      evaluationAuthority: EvaluationAuthority;
      candidateOrigin: CandidateOrigin;
    }
  | { valid: false; reasons: string[] };

const RUN_PURPOSES = new Set<RunPurpose>(["baseline", "candidate", "holdout", "diagnostic"]);
const EVALUATION_AUTHORITIES = new Set<EvaluationAuthority>([
  "accepted-contract",
  "manual",
  "external",
]);

export function parseEvidenceAxes(value: unknown): EvidenceAxesParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reasons: ["evidence axes require an object record"] };
  }
  const row = value as UnknownRecord;
  const reasons: string[] = [];
  const runPurpose = RUN_PURPOSES.has(row.runPurpose as RunPurpose)
    ? (row.runPurpose as RunPurpose)
    : null;
  if (!runPurpose) reasons.push("runPurpose is missing or invalid");
  const evaluationAuthority = EVALUATION_AUTHORITIES.has(
    row.evaluationAuthority as EvaluationAuthority,
  )
    ? (row.evaluationAuthority as EvaluationAuthority)
    : null;
  if (!evaluationAuthority) reasons.push("evaluationAuthority is missing or invalid");
  const candidateOrigin = parseCandidateOrigin(row.candidateOrigin);
  if (!candidateOrigin) reasons.push("candidateOrigin is missing or invalid");
  if (Object.hasOwn(row, "executionAuthority")) {
    if (!EVALUATION_AUTHORITIES.has(row.executionAuthority as EvaluationAuthority)) {
      reasons.push("executionAuthority is invalid");
    } else if (evaluationAuthority && row.executionAuthority !== evaluationAuthority) {
      reasons.push("executionAuthority conflicts with evaluationAuthority");
    }
  }
  return reasons.length > 0
    ? { valid: false, reasons }
    : {
        valid: true,
        runPurpose: runPurpose as RunPurpose,
        evaluationAuthority: evaluationAuthority as EvaluationAuthority,
        candidateOrigin: candidateOrigin as CandidateOrigin,
      };
}

function parseCandidateOrigin(value: unknown): CandidateOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const origin = value as UnknownRecord;
  if (origin.kind === "working-tree") return { kind: "working-tree" };
  if (origin.kind === "none") return { kind: "none" };
  if (
    origin.kind === "commit" &&
    typeof origin.oid === "string" &&
    /^[0-9a-f]{40,64}$/i.test(origin.oid)
  ) {
    return { kind: "commit", oid: origin.oid };
  }
  return null;
}
