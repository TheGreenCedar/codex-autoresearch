export interface FinalizationRunwayFacts {
  branch?: unknown;
  branchExists?: unknown;
  checkedOut?: unknown;
  ciStatus?: unknown;
  dirty?: unknown;
  divergent?: unknown;
  equivalent?: unknown;
  localOnly?: unknown;
  merged?: unknown;
  prUrl?: unknown;
  stale?: unknown;
}

export interface FinalizationRunwayStatus {
  blockers: string[];
  branch: string;
  nextAction: string;
  prUrl: string;
  stage: "cleanup" | "ci" | "local" | "merge" | "not-created" | "pr" | "unsafe";
  status:
    | "checked-out"
    | "divergent"
    | "equivalent"
    | "local-only"
    | "missing"
    | "merged"
    | "pr-open"
    | "stale"
    | "unsafe";
  warnings: string[];
}

export function classifyFinalizationRunwayFromFacts(
  facts: FinalizationRunwayFacts = {},
): FinalizationRunwayStatus {
  const branch = stringValue(facts.branch);
  const prUrl = stringValue(facts.prUrl);
  const warnings: string[] = [];
  const blockers: string[] = [];

  if (facts.dirty === true || facts.checkedOut === true) {
    blockers.push(
      facts.checkedOut === true
        ? `Finalization branch is currently checked out: ${branch || "(unknown)"}.`
        : "Working tree is dirty; finalization runway is unsafe.",
    );
    return status(
      facts.checkedOut === true ? "checked-out" : "unsafe",
      "unsafe",
      branch,
      prUrl,
      blockers,
      warnings,
    );
  }
  if (facts.branchExists !== true) {
    return status(
      "missing",
      "not-created",
      branch,
      prUrl,
      blockers,
      warnings,
      "Create the review branch from the finalization plan.",
    );
  }
  if (facts.divergent === true) {
    blockers.push(
      `Existing finalization branch diverges from the planned review content: ${branch}.`,
    );
    return status("divergent", "unsafe", branch, prUrl, blockers, warnings);
  }
  if (facts.stale === true) {
    blockers.push(`Existing finalization branch is stale relative to the plan: ${branch}.`);
    return status("stale", "unsafe", branch, prUrl, blockers, warnings);
  }
  if (facts.equivalent === true && facts.localOnly === true) {
    warnings.push(`Review branch exists only locally: ${branch}.`);
    return status(
      "local-only",
      "local",
      branch,
      prUrl,
      blockers,
      warnings,
      "Push the review branch or open a PR before calling finalization published.",
    );
  }
  if (prUrl) {
    const ci = stringValue(facts.ciStatus).toLowerCase();
    if (ci && !["success", "passed", "green"].includes(ci)) {
      warnings.push(`PR exists but CI is not green yet: ${ci}.`);
      return status("pr-open", "ci", branch, prUrl, blockers, warnings);
    }
    if (facts.merged === true) {
      return status(
        "merged",
        "cleanup",
        branch,
        prUrl,
        blockers,
        warnings,
        "Verify trunk contains the review branch, then clean up source/session artifacts.",
      );
    }
    return status(
      "pr-open",
      "merge",
      branch,
      prUrl,
      blockers,
      warnings,
      "Review PR, wait for CI, merge, verify trunk, then clean up.",
    );
  }
  if (facts.equivalent === true) {
    warnings.push(`Equivalent finalization branch exists without PR evidence: ${branch}.`);
    return status(
      "equivalent",
      "pr",
      branch,
      prUrl,
      blockers,
      warnings,
      "Open a PR or record PR evidence before merge or cleanup claims.",
    );
  }
  return status("unsafe", "unsafe", branch, prUrl, ["Existing branch state is unknown."], warnings);
}

function status(
  statusValue: FinalizationRunwayStatus["status"],
  stage: FinalizationRunwayStatus["stage"],
  branch: string,
  prUrl: string,
  blockers: string[],
  warnings: string[],
  nextAction = "",
): FinalizationRunwayStatus {
  return {
    status: statusValue,
    stage,
    branch,
    prUrl,
    blockers,
    warnings,
    nextAction: nextAction || blockers[0] || warnings[0] || "Finalization runway is clear.",
  };
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}
