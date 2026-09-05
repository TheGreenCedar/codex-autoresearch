import { classifyResult } from "./result-semantics.js";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertSafeWriteTarget } from "./checked-write.js";
import { normalizeRelativePaths } from "./literal-paths.js";
import {
  hashOutcomeValue,
  outcomeObject,
  outcomeStrings,
  type OutcomeState,
} from "./outcome-contract.js";
import type {
  ExecutionReceipt,
  InputFingerprint,
  InvestigationEvidence,
  OutcomeEvaluator,
} from "./investigation-records.js";

export interface DependencyPaths {
  subject: string[];
  evaluator: string[];
  fixtures: string[];
  checks: string[];
}
export interface OutcomeDependencyManifest {
  sourceDigest: string;
  criteria: Record<string, DependencyPaths>;
}
export interface CriterionDependencyIdentity {
  subject: string;
  evaluator: string;
  fixtures: string;
  checks: string;
  environment: string;
  criterion: string;
  source: string;
}
export interface ApplicableOutcomeEvidence {
  evidence: InvestigationEvidence;
  applicability: "applicable" | "inapplicable" | "unknown";
  reasons: string[];
}
export interface OutcomeCriterionCoverage {
  id: string;
  status: "satisfied" | "unsatisfied" | "unknown";
  evidenceIds: string[];
  measurementIds: string[];
  requiredMeasurements: number;
  reasons: string[];
}
export interface OutcomeEvidenceRegistry {
  entries: ApplicableOutcomeEvidence[];
  criteria: OutcomeCriterionCoverage[];
}

export async function readOutcomeDependencyManifest(
  state: OutcomeState,
  cwd: string,
): Promise<OutcomeDependencyManifest | null> {
  const source = state.contract.dependencySource;
  if (!source) return null;
  const target = path.join(cwd, source.path);
  await assertSafeWriteTarget(cwd, target);
  const stat = await fsp.lstat(target);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error("Trusted dependency manifest must be a regular file at most 1 MiB.");
  const bytes = await fsp.readFile(target);
  if (createHash("sha256").update(bytes).digest("hex") !== source.digest)
    throw new Error(
      "Accepted dependency manifest changed; an explicit authorization amendment is required.",
    );
  const input = outcomeObject(JSON.parse(bytes.toString("utf8")), "dependency manifest");
  if (input.schemaVersion !== 1) throw new Error("Unsupported dependency manifest schema.");
  const criteria = outcomeObject(input.criteria, "dependency criteria");
  const parsed: Record<string, DependencyPaths> = Object.create(null);
  for (const criterion of state.contract.criteria) {
    const entry = outcomeObject(criteria[criterion.id], `dependencies for ${criterion.id}`);
    const paths = (key: string) =>
      normalizeRelativePaths(
        outcomeStrings(entry[key], `${criterion.id}.${key}`, key !== "subject"),
        `${criterion.id}.${key}`,
      );
    parsed[criterion.id] = {
      subject: paths("subject"),
      evaluator: paths("evaluator"),
      fixtures: paths("fixtures"),
      checks: paths("checks"),
    };
  }
  return { sourceDigest: hashOutcomeValue(source), criteria: parsed };
}

export function currentOutcomeEvaluator(
  state: OutcomeState,
  criterionId: string,
): OutcomeEvaluator | null {
  return (
    [...state.evaluators]
      .reverse()
      .find((evaluator) => evaluator.criterionIds.includes(criterionId)) ?? null
  );
}

export function outcomeEvidenceDependencies(
  state: OutcomeState,
  input: InputFingerprint,
  criterionId: string,
  manifest: OutcomeDependencyManifest | null,
  evaluator: OutcomeEvaluator | null = currentOutcomeEvaluator(state, criterionId),
): CriterionDependencyIdentity {
  const criterion = state.contract.criteria.find((item) => item.id === criterionId);
  if (!criterion) throw new Error("Evidence criterion is outside accepted authority.");
  const paths = manifest?.criteria[criterionId];
  if (manifest && !paths)
    throw new Error("Trusted dependency source has no mapping for this criterion.");
  const slice = (selected: string[]) => {
    const scopes = new Set(selected);
    const links: Record<string, string> = Object.create(null);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [link, target] of Object.entries(input.links)) {
        for (const scope of scopes) {
          const includesLink = scope === "." || link === scope || link.startsWith(`${scope}/`);
          const throughLink = scope.startsWith(`${link}/`);
          if (!includesLink && !throughLink) continue;
          links[link] = target;
          const dependency = throughLink ? `${target}/${scope.slice(link.length + 1)}` : target;
          if (!scopes.has(dependency)) {
            scopes.add(dependency);
            expanded = true;
          }
        }
      }
    }
    return hashOutcomeValue({
      paths: [...scopes].sort(),
      links,
      files: Object.fromEntries(
        Object.entries(input.files).filter(([file]) =>
          [...scopes].some(
            (scope) => scope === "." || file === scope || file.startsWith(`${scope}/`),
          ),
        ),
      ),
    });
  };
  const all = input.digest;
  return {
    subject: paths ? slice(paths.subject) : all,
    fixtures: paths ? slice(paths.fixtures) : all,
    evaluator: hashOutcomeValue({
      contract: evaluator?.digest ?? null,
      files: paths ? slice(paths.evaluator) : all,
    }),
    checks: hashOutcomeValue({
      argv: evaluator?.checkArgv ?? [],
      files: paths ? slice(paths.checks) : all,
    }),
    environment: input.environment,
    criterion: hashOutcomeValue(criterion),
    source: manifest?.sourceDigest ?? hashOutcomeValue({ kind: "complete-worktree" }),
  };
}

/** Read-only applicability; historical validity and original observations are never rewritten. */
export function buildOutcomeEvidenceRegistry({
  state,
  input,
  manifest = null,
  verifiedConfirmations = new Set<string>(),
  independentConfirmations = new Set<string>(),
}: {
  state: OutcomeState;
  input: InputFingerprint | null;
  manifest?: OutcomeDependencyManifest | null;
  verifiedConfirmations?: ReadonlySet<string>;
  independentConfirmations?: ReadonlySet<string>;
}): OutcomeEvidenceRegistry {
  const byId = new Map(state.evidence.map((record) => [record.id, record]));
  const memo = new Map<string, ApplicableOutcomeEvidence>();
  const visit = (id: string, ancestors: ReadonlySet<string>): ApplicableOutcomeEvidence => {
    const record = byId.get(id);
    if (!record) throw new Error(`Missing evidence dependency: ${id}`);
    if (ancestors.has(id))
      return {
        evidence: record,
        applicability: "unknown",
        reasons: ["Evidence dependency cycle."],
      };
    const cached = memo.get(id);
    if (cached) return cached;
    const reasons: string[] = [];
    let applicability: ApplicableOutcomeEvidence["applicability"] = "applicable";
    const receipt = state.executions.find((execution) => execution.id === record.executionId);
    const criterion = state.contract.criteria.find((item) => item.id === record.criterionId);
    if (
      !receipt ||
      !receipt.result ||
      receipt.status.kind !== "completed" ||
      !receipt.completedInput ||
      record.measurementId !== receipt.id ||
      record.historicalValidity !== receipt.result.validity ||
      hashOutcomeValue(record.result) !== hashOutcomeValue(receipt.result) ||
      hashOutcomeValue(receipt.result) !==
        hashOutcomeValue(resultFromOutcomeObservation(receipt, state, manifest)) ||
      (record.provenance === "worker" && receipt.action.mode !== "process") ||
      (record.provenance === "operator-observation" && receipt.action.mode !== "managed") ||
      (record.provenance === "github-actions" && !verifiedConfirmations.has(record.id))
    ) {
      applicability = "unknown";
      reasons.push("Execution, observation, or provenance binding is not verified.");
    }
    if (receipt?.completedInput && receipt.result) {
      const parent = state.history.find(
        (entry) => entry.contract.digest === receipt.authorizationDigest,
      )?.contract;
      const expectedRelation =
        receipt.result.attainment === "satisfied"
          ? "supports"
          : receipt.result.attainment === "unsatisfied"
            ? "contradicts"
            : "inconclusive";
      if (
        !parent ||
        expectedRelation !== record.relation ||
        (!receipt.action.evaluator?.criterionIds.includes(record.criterionId) &&
          record.relation !== "inconclusive")
      ) {
        applicability = "unknown";
        reasons.push(
          "Criterion relation is not established by the authorized evaluator observation.",
        );
      } else {
        const historicalCriterion = parent.criteria.find((item) => item.id === record.criterionId);
        if (
          !historicalCriterion ||
          hashOutcomeValue(historicalCriterion) !== record.dependencies.criterion
        ) {
          applicability = "unknown";
          reasons.push("Evaluator authority does not cover this criterion version.");
        } else if (
          !parent.dependencySource ||
          (manifest && manifest.sourceDigest === hashOutcomeValue(parent.dependencySource))
        ) {
          const expected = outcomeEvidenceDependencies(
            { ...state, contract: parent },
            receipt.completedInput,
            record.criterionId,
            manifest,
            receipt.action.evaluator,
          );
          for (const key of Object.keys(expected) as Array<keyof CriterionDependencyIdentity>)
            if (expected[key] !== record.dependencies[key]) {
              applicability = "unknown";
              reasons.push(`Substituted ${key} receipt dependency.`);
            }
        } else {
          applicability = "unknown";
          reasons.push(
            "The accepted historical dependency manifest is unavailable; its mapping cannot be rebound to a newer source.",
          );
        }
      }
    }
    if (record.historicalValidity !== "valid") {
      applicability = "unknown";
      reasons.push("Historical measurement validity is not established.");
    }
    if (!input || !criterion || (state.contract.dependencySource && !manifest)) {
      applicability = "unknown";
      reasons.push("Current subject, criterion, or accepted dependency source is unavailable.");
    } else {
      const current = outcomeEvidenceDependencies(state, input, criterion.id, manifest);
      for (const key of Object.keys(current) as Array<keyof CriterionDependencyIdentity>) {
        if (record.dependencies[key] !== current[key]) {
          if (applicability !== "unknown") applicability = "inapplicable";
          reasons.push(`Changed ${key} dependency.`);
        }
      }
    }
    for (const dependencyId of record.dependencies.evidence) {
      if (!byId.has(dependencyId)) {
        applicability = "unknown";
        reasons.push(`Missing evidence dependency ${dependencyId}.`);
        continue;
      }
      const dependency = visit(dependencyId, new Set([...ancestors, id]));
      if (dependency.applicability !== "applicable") {
        applicability =
          dependency.applicability === "unknown"
            ? "unknown"
            : applicability === "unknown"
              ? "unknown"
              : "inapplicable";
        reasons.push(`Evidence dependency ${dependencyId} is ${dependency.applicability}.`);
      }
    }
    const result = { evidence: record, applicability, reasons };
    memo.set(id, result);
    return result;
  };
  const entries = state.evidence.map((record) => visit(record.id, new Set()));
  const criteria = state.contract.criteria.map((criterion): OutcomeCriterionCoverage => {
    const evaluator = currentOutcomeEvaluator(state, criterion.id);
    const applicable = entries.filter(
      (entry) =>
        entry.evidence.criterionId === criterion.id && entry.applicability === "applicable",
    );
    const contradictions = applicable.filter((entry) => entry.evidence.relation === "contradicts");
    const supports = applicable.filter(
      (entry) =>
        entry.evidence.relation === "supports" &&
        (criterion.authority !== "independent" || independentConfirmations.has(entry.evidence.id)),
    );
    const requiredMeasurements = evaluator?.repeats ?? 1;
    // Operator observations can support a single internal observation, but cannot
    // manufacture independent repeated measurements without execution receipts.
    const measurements = supports.filter(
      (entry) => requiredMeasurements === 1 || entry.evidence.provenance !== "operator-observation",
    );
    const measurementIds = [...new Set(measurements.map((entry) => entry.evidence.measurementId))];
    const reasons: string[] = [];
    if (contradictions.length)
      reasons.push("Applicable counterexample evidence remains unresolved.");
    if (measurementIds.length < requiredMeasurements)
      reasons.push(
        `Need ${requiredMeasurements} eligible distinct measurement(s); found ${measurementIds.length}.`,
      );
    if (criterion.authority === "independent" && !supports.length)
      reasons.push("Verified externally controlled confirmation is required.");
    if (evaluator?.method.kind === "metric" && measurements.length) {
      const samples = measurements
        .map(
          (entry) =>
            state.executions.find((receipt) => receipt.id === entry.evidence.executionId)
              ?.observation,
        )
        .map((observation) => (observation?.kind === "metric" ? observation.value : NaN));
      if (
        !samples.every(Number.isFinite) ||
        Math.max(...samples) - Math.min(...samples) > evaluator.method.tolerance
      )
        reasons.push("Repeated metric observations do not satisfy the accepted noise tolerance.");
    }
    return {
      id: criterion.id,
      status: contradictions.length ? "unsatisfied" : reasons.length ? "unknown" : "satisfied",
      evidenceIds: supports.map((entry) => entry.evidence.id),
      measurementIds,
      requiredMeasurements,
      reasons,
    };
  });
  return { entries, criteria };
}

export function resultFromOutcomeObservation(
  receipt: ExecutionReceipt,
  state?: OutcomeState,
  manifest: OutcomeDependencyManifest | null = null,
) {
  if (receipt.status.kind !== "completed" || !receipt.observation || !receipt.action.evaluator)
    return null;
  const evaluator = receipt.action.evaluator;
  if (receipt.observation.kind !== evaluator.method.kind) return null;
  if (receipt.status.exitCode !== 0 || receipt.checksPassed === false)
    return classifyResult({ kind: "invalid", execution: "completed" });
  if (receipt.observation.kind === "predicate") return classifyResult(receipt.observation);
  if (evaluator.method.kind !== "metric") return null;
  return classifyResult({
    kind: "metric",
    value: receipt.observation.value,
    reference: state ? metricReference(state, receipt, manifest) : null,
    direction: evaluator.method.direction,
    minimumImprovement: evaluator.method.minimumImprovement,
    tolerance: evaluator.method.tolerance,
    target: evaluator.method.target,
  });
}

/** Reference measurements are selected explicitly; their non-subject dependencies must match. */
export function metricReference(
  state: OutcomeState,
  receipt: ExecutionReceipt,
  manifest: OutcomeDependencyManifest | null,
): number | null {
  const evaluator = receipt.action.evaluator;
  const input = receipt.completedInput ?? receipt.input;
  if (
    !evaluator ||
    evaluator.method.kind !== "metric" ||
    !input ||
    !receipt.action.referenceEvidenceIds.length
  )
    return null;
  const values = new Map<string, number>();
  let baselineSubject: string | null = null;
  for (const id of receipt.action.referenceEvidenceIds) {
    const evidence = state.evidence.find((entry) => entry.id === id);
    const reference = state.executions.find((entry) => entry.id === evidence?.executionId);
    if (
      !evidence ||
      !reference ||
      reference.id === receipt.id ||
      reference.action.mode !== "process" ||
      reference.status.kind !== "completed" ||
      reference.status.exitCode !== 0 ||
      reference.checksPassed !== true ||
      reference.observation?.kind !== "metric" ||
      reference.action.evaluator?.digest !== evaluator.digest ||
      !reference.completedInput ||
      evidence.historicalValidity !== "valid" ||
      evidence.measurementId !== reference.id ||
      evidence.provenance !== "worker" ||
      reference.result?.validity !== "valid" ||
      hashOutcomeValue(evidence.result) !== hashOutcomeValue(reference.result)
    )
      return null;
    if (
      Date.parse(reference.status.completedAt) >
      Date.parse(state.reservations.find((entry) => entry.id === receipt.id)!.reservedAt)
    )
      return null;
    const left = outcomeEvidenceDependencies(
      state,
      reference.completedInput,
      evidence.criterionId,
      manifest,
      evaluator,
    );
    const right = outcomeEvidenceDependencies(
      state,
      input,
      evidence.criterionId,
      manifest,
      evaluator,
    );
    if (
      ["evaluator", "fixtures", "environment", "checks", "criterion", "source"].some(
        (key) =>
          left[key as keyof CriterionDependencyIdentity] !==
          right[key as keyof CriterionDependencyIdentity],
      )
    )
      return null;
    if (baselineSubject !== null && baselineSubject !== left.subject) return null;
    baselineSubject = left.subject;
    if (
      Object.entries(left).some(
        ([key, value]) => evidence.dependencies[key as keyof CriterionDependencyIdentity] !== value,
      )
    )
      return null;
    values.set(reference.id, reference.observation.value);
  }
  if (values.size < evaluator.repeats) return null;
  const samples = [...values.values()];
  if (Math.max(...samples) - Math.min(...samples) > evaluator.method.tolerance) return null;
  return samples.reduce((total, value) => total + value, 0) / samples.length;
}
