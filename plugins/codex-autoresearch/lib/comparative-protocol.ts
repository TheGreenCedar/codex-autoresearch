import { createPublicKey, randomInt, randomUUID, verify } from "node:crypto";
import {
  outcomeDigest,
  outcomeEnum,
  outcomeNumber,
  outcomeObject,
  outcomeString,
  outcomeStrings,
  hashOutcomeValue,
} from "./outcome-contract.js";

export const COMPARISON_ARMS = ["ordinary-codex", "released-2.9.0", "candidate-3.0"] as const;
export type ComparisonArm = (typeof COMPARISON_ARMS)[number];
export const ACCOUNTED_PHASES = [
  "preparation",
  "execution",
  "failed-attempts",
  "review",
  "operator-intervention",
  "recovery",
  "handoff",
] as const;
export interface ComparisonProtocol {
  schemaVersion: 1;
  id: string;
  stage: "pilot" | "scoring";
  model: string;
  environmentDigest: string;
  authorization: {
    reference: string;
    maxRuns: number;
    maxTotalSeconds: number;
    maxTotalCostUsd: number;
  };
  aggregatePerTaskArm: { seconds: number; tokens: number; costUsd: number };
  seeds: string[];
  tasks: Array<{
    id: string;
    kind: "uncertain" | "simple" | "infeasible";
    author: string;
    inputDigest: string;
    sealedAt: string;
  }>;
  arms: Record<ComparisonArm, { runtimeDigest: string; version: string }>;
  hostAuthority: { reference: string; publicKey: string; enforcementReference: string };
  assessmentAuthority: { reference: string; publicKey: string };
  preregistration: null | {
    reference: string;
    analysisDigest: string;
    simpleNoninferiorityMargin: number;
  };
  digest: string;
}
function count(value: unknown, label: string) {
  const result = outcomeNumber(value, label, 1);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer.`);
  return result;
}
export function parseComparisonProtocol(value: unknown): ComparisonProtocol {
  const input = outcomeObject(value, "comparison protocol");
  if (input.schemaVersion !== 1) throw new Error("Unsupported comparison protocol.");
  const stage = outcomeEnum(input.stage, ["pilot", "scoring"], "study stage");
  const authorization = outcomeObject(input.authorization, "separate study budget authorization");
  const budget = outcomeObject(input.aggregatePerTaskArm, "identical aggregate task/arm budget");
  const aggregatePerTaskArm = {
    seconds: outcomeNumber(budget.seconds, "task/arm seconds", Number.MIN_VALUE),
    tokens: count(budget.tokens, "task/arm tokens"),
    costUsd: outcomeNumber(budget.costUsd, "task/arm cost", Number.MIN_VALUE),
  };
  const seeds = outcomeStrings(input.seeds, "fixed seeds");
  if (!Array.isArray(input.tasks) || !input.tasks.length)
    throw new Error("Independently authored sealed tasks are required.");
  const tasks = input.tasks.map((value: unknown) => {
    const task = outcomeObject(value, "sealed task");
    const sealedAt = outcomeString(task.sealedAt, "task sealing time");
    if (!Number.isFinite(Date.parse(sealedAt))) throw new Error("Task sealing time is invalid.");
    return {
      id: outcomeString(task.id, "task ID"),
      kind: outcomeEnum(task.kind, ["uncertain", "simple", "infeasible"], "task kind"),
      author: outcomeString(task.author, "independent task author"),
      inputDigest: outcomeDigest(task.inputDigest),
      sealedAt,
    };
  });
  if (new Set(tasks.map((task) => task.inputDigest)).size !== tasks.length)
    throw new Error("Duplicate sealed task inputs cannot count as independent tasks.");
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
    throw new Error("Task IDs must be unique.");
  const rawArms = outcomeObject(input.arms, "comparison arms");
  const arms = Object.fromEntries(
    COMPARISON_ARMS.map((arm) => {
      const entry = outcomeObject(rawArms[arm], arm);
      return [
        arm,
        {
          runtimeDigest: outcomeDigest(entry.runtimeDigest),
          version: outcomeString(entry.version, `${arm} version`),
        },
      ];
    }),
  ) as ComparisonProtocol["arms"];
  if (
    Object.keys(rawArms).length !== 3 ||
    arms["released-2.9.0"].version !== "2.9.0" ||
    (arms["candidate-3.0"].version !== "3.0.0" &&
      !arms["candidate-3.0"].version.startsWith("3.0.0-"))
  )
    throw new Error("Compare ordinary Codex, released 2.9.0, and an identified 3.0 artifact.");
  const host = outcomeObject(input.hostAuthority, "host telemetry authority"),
    assessor = outcomeObject(input.assessmentAuthority, "blinded assessment authority");
  const key = (value: unknown, label: string) => {
    const parsed = createPublicKey(outcomeString(value, label));
    if (parsed.asymmetricKeyType !== "ed25519")
      throw new Error("Study authorities require Ed25519 verification keys.");
    return parsed.export({ type: "spki", format: "pem" }).toString();
  };
  const hostAuthority = {
    reference: outcomeString(host.reference, "host authority"),
    publicKey: key(host.publicKey, "host verification key"),
    enforcementReference: outcomeString(
      host.enforcementReference,
      "actual host budget enforcement",
    ),
  };
  const assessmentAuthority = {
    reference: outcomeString(assessor.reference, "assessment authority"),
    publicKey: key(assessor.publicKey, "assessment verification key"),
  };
  if (
    hostAuthority.reference === assessmentAuthority.reference ||
    hostAuthority.publicKey === assessmentAuthority.publicKey ||
    tasks.some((task) => task.author === hostAuthority.reference)
  )
    throw new Error(
      "Task authorship, run custody, and blinded assessment require explicit separate ownership.",
    );
  let preregistration: ComparisonProtocol["preregistration"] = null;
  if (stage === "scoring") {
    const raw = outcomeObject(input.preregistration, "preregistered scoring study");
    preregistration = {
      reference: outcomeString(raw.reference, "preregistration reference"),
      analysisDigest: outcomeDigest(raw.analysisDigest),
      simpleNoninferiorityMargin: outcomeNumber(
        raw.simpleNoninferiorityMargin,
        "simple-task noninferiority margin",
      ),
    };
    if (preregistration.simpleNoninferiorityMargin > 1)
      throw new Error("Noninferiority margin must be at most one.");
  }
  const body: Omit<ComparisonProtocol, "digest"> = {
    schemaVersion: 1,
    id: outcomeString(input.id, "study ID"),
    stage,
    model: outcomeString(input.model, "identical model"),
    environmentDigest: outcomeDigest(input.environmentDigest),
    authorization: {
      reference: outcomeString(authorization.reference, "separate budget decision"),
      maxRuns: count(authorization.maxRuns, "fixed run ceiling"),
      maxTotalSeconds: outcomeNumber(
        authorization.maxTotalSeconds,
        "study time ceiling",
        Number.MIN_VALUE,
      ),
      maxTotalCostUsd: outcomeNumber(
        authorization.maxTotalCostUsd,
        "study cost ceiling",
        Number.MIN_VALUE,
      ),
    },
    aggregatePerTaskArm,
    seeds,
    tasks,
    arms,
    hostAuthority,
    assessmentAuthority,
    preregistration,
  };
  const scheduled = tasks.length * seeds.length * COMPARISON_ARMS.length;
  if (
    scheduled > body.authorization.maxRuns ||
    tasks.length * 3 * aggregatePerTaskArm.seconds > body.authorization.maxTotalSeconds ||
    tasks.length * 3 * aggregatePerTaskArm.costUsd > body.authorization.maxTotalCostUsd
  )
    throw new Error("The fixed schedule exceeds its separately accepted study ceiling.");
  const digest = hashOutcomeValue(body);
  if (input.digest !== undefined && input.digest !== digest)
    throw new Error("Comparison protocol digest mismatch.");
  return { ...body, digest };
}
export interface ComparisonSchedule {
  schemaVersion: 1;
  protocolDigest: string;
  trials: Array<{ id: string; taskId: string; arm: ComparisonArm; seed: string }>;
}
export function prepareComparison(protocol: ComparisonProtocol): ComparisonSchedule {
  const trials = protocol.tasks.flatMap((task) =>
    protocol.seeds.flatMap((seed) =>
      COMPARISON_ARMS.map((arm) => ({ id: randomUUID(), taskId: task.id, arm, seed })),
    ),
  );
  for (let i = trials.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [trials[i], trials[j]] = [trials[j], trials[i]];
  }
  return { schemaVersion: 1, protocolDigest: protocol.digest, trials };
}
export function validateComparisonSchedule(
  value: unknown,
  protocol: ComparisonProtocol,
): ComparisonSchedule {
  const input = outcomeObject(value, "study schedule");
  if (
    input.schemaVersion !== 1 ||
    input.protocolDigest !== protocol.digest ||
    !Array.isArray(input.trials)
  )
    throw new Error("Schedule differs from the accepted protocol.");
  const trials = input.trials.map((value: unknown) => {
    const entry = outcomeObject(value, "trial");
    return {
      id: outcomeString(entry.id, "blind trial ID"),
      taskId: outcomeString(entry.taskId, "trial task"),
      arm: outcomeEnum(entry.arm, COMPARISON_ARMS, "trial arm"),
      seed: outcomeString(entry.seed, "trial seed"),
    };
  });
  const expected = new Set(
    protocol.tasks.flatMap((task) =>
      protocol.seeds.flatMap((seed) =>
        COMPARISON_ARMS.map((arm) => JSON.stringify([task.id, arm, seed])),
      ),
    ),
  );
  if (
    new Set(trials.map((trial) => trial.id)).size !== trials.length ||
    trials.length !== expected.size
  )
    throw new Error("Schedule duplicates or omits independent assignments.");
  for (const trial of trials)
    if (!expected.delete(JSON.stringify([trial.taskId, trial.arm, trial.seed])))
      throw new Error("Schedule changes a sealed task, arm, or seed.");
  return { schemaVersion: 1, protocolDigest: protocol.digest, trials };
}
interface VerifiedTrial {
  id: string;
  taskId: string;
  arm: ComparisonArm;
  seconds: number;
  tokens: number;
  costUsd: number;
  operatorSeconds: number;
  artifactDigest: string;
  verifiedOutcome: boolean | null;
  infeasibleHandled: boolean | null;
}
function signedPayload(value: unknown, publicKey: string) {
  const envelope = outcomeObject(value, "signed receipt");
  const payload = outcomeObject(envelope.payload, "receipt payload");
  if (
    !verify(
      null,
      Buffer.from(hashOutcomeValue(payload)),
      publicKey,
      Buffer.from(outcomeString(envelope.signature, "receipt signature"), "base64"),
    )
  )
    throw new Error("Receipt signature does not match its accepted authority.");
  return payload;
}
export function collectComparison(
  protocol: ComparisonProtocol,
  schedule: ComparisonSchedule,
  receipts: unknown[],
  assessments: unknown[] = [],
) {
  validateComparisonSchedule(schedule, protocol);
  if (receipts.length !== schedule.trials.length)
    throw new Error("Missing runs remain incomplete; do not score or silently replace them.");
  const observed = new Set<string>();
  const trials: VerifiedTrial[] = receipts.map((value) => {
    const receipt = signedPayload(value, protocol.hostAuthority.publicKey);
    const id = outcomeString(receipt.trialId, "receipt trial ID");
    const trial = schedule.trials.find((trial) => trial.id === id);
    const task = protocol.tasks.find((task) => task.id === trial?.taskId);
    if (!trial || !task || observed.has(id))
      throw new Error("Receipt duplicates or invents a scheduled execution.");
    observed.add(id);
    if (
      receipt.protocolDigest !== protocol.digest ||
      receipt.model !== protocol.model ||
      receipt.environmentDigest !== protocol.environmentDigest ||
      receipt.inputDigest !== task.inputDigest ||
      receipt.runtimeDigest !== protocol.arms[trial.arm].runtimeDigest ||
      receipt.seed !== trial.seed ||
      receipt.enforcementReference !== protocol.hostAuthority.enforcementReference
    )
      throw new Error(
        "Actual model, environment, task, runtime, seed, or enforced budget differs across arms.",
      );
    const phases = outcomeObject(receipt.phases, "complete cumulative accounting");
    if (Object.keys(phases).length !== ACCOUNTED_PHASES.length)
      throw new Error(
        "Every preparation, failure, review, intervention, recovery, and handoff phase must be accounted.",
      );
    let seconds = 0,
      tokens = 0,
      costUsd = 0,
      operatorSeconds = 0;
    for (const phase of ACCOUNTED_PHASES) {
      const usage = outcomeObject(phases[phase], phase);
      const measured = outcomeNumber(usage.seconds, `${phase} seconds`);
      seconds += measured;
      tokens += outcomeNumber(usage.tokens, `${phase} tokens`);
      costUsd += outcomeNumber(usage.costUsd, `${phase} cost`);
      if (phase === "operator-intervention") operatorSeconds += measured;
    }
    return {
      id,
      taskId: task.id,
      arm: trial.arm,
      seconds,
      tokens,
      costUsd,
      operatorSeconds,
      artifactDigest: outcomeDigest(receipt.artifactDigest),
      verifiedOutcome: null,
      infeasibleHandled: null,
    };
  });
  for (const task of protocol.tasks)
    for (const arm of COMPARISON_ARMS) {
      const group = trials.filter((trial) => trial.taskId === task.id && trial.arm === arm);
      const sum = (key: "seconds" | "tokens" | "costUsd") =>
        group.reduce((total, trial) => total + trial[key], 0);
      if (
        sum("seconds") > protocol.aggregatePerTaskArm.seconds ||
        sum("tokens") > protocol.aggregatePerTaskArm.tokens ||
        sum("costUsd") > protocol.aggregatePerTaskArm.costUsd
      )
        throw new Error(
          "Actual aggregate task/arm consumption exceeded its identical budget; the comparison is not eligible.",
        );
    }
  if (
    trials.reduce((sum, trial) => sum + trial.costUsd, 0) >
      protocol.authorization.maxTotalCostUsd ||
    trials.reduce((sum, trial) => sum + trial.seconds, 0) > protocol.authorization.maxTotalSeconds
  )
    throw new Error("Actual study consumption exceeded its accepted ceiling.");
  if (protocol.stage === "pilot") {
    if (assessments.length) throw new Error("The reliability pilot is non-scoring.");
    return {
      stage: "pilot",
      conclusion: "non-scoring",
      trials: trials.length,
      independentTasks: protocol.tasks.length,
      totalCostUsd: trials.reduce((sum, trial) => sum + trial.costUsd, 0),
      totalSeconds: trials.reduce((sum, trial) => sum + trial.seconds, 0),
      next: "Make a separate preregistered scoring budget decision; no automatic expansion.",
    };
  }
  if (assessments.length !== trials.length)
    throw new Error("Scoring requires all blinded outcome assessments.");
  const assessed = new Set<string>();
  for (const value of assessments) {
    const assessment = signedPayload(value, protocol.assessmentAuthority.publicKey);
    if ("arm" in assessment || "runtimeDigest" in assessment || "model" in assessment)
      throw new Error("Assessment payload exposes the treatment arm.");
    const id = outcomeString(assessment.trialId, "blind assessment ID"),
      trial = trials.find((trial) => trial.id === id);
    if (
      !trial ||
      assessed.has(id) ||
      assessment.protocolDigest !== protocol.digest ||
      assessment.artifactDigest !== trial.artifactDigest ||
      typeof assessment.verifiedOutcome !== "boolean" ||
      typeof assessment.infeasibleHandled !== "boolean"
    )
      throw new Error("Assessment does not bind one verified blind output.");
    assessed.add(id);
    trial.verifiedOutcome = assessment.verifiedOutcome;
    trial.infeasibleHandled = assessment.infeasibleHandled;
  }
  const taskResults = protocol.tasks.map((task) => ({
    taskId: task.id,
    kind: task.kind,
    arms: Object.fromEntries(
      COMPARISON_ARMS.map((arm) => {
        const group = trials.filter((trial) => trial.taskId === task.id && trial.arm === arm);
        const mean = (fn: (trial: VerifiedTrial) => number) =>
          group.reduce((sum, trial) => sum + fn(trial), 0) / group.length;
        return [
          arm,
          {
            verifiedOutcome: mean((trial) => Number(trial.verifiedOutcome)),
            infeasibleHandled: mean((trial) => Number(trial.infeasibleHandled)),
            costUsd: mean((trial) => trial.costUsd),
            operatorSeconds: mean((trial) => trial.operatorSeconds),
          },
        ];
      }),
    ),
  }));
  return {
    stage: "scoring",
    conclusion: "inconclusive",
    independentUnit: "task",
    independentTasks: taskResults.length,
    repeatedSeedsAreIndependent: false,
    taskResults,
    analysis: {
      protocolDigest: protocol.digest,
      preregistration: protocol.preregistration,
      benefitTargets: [
        "more verified outcomes on uncertain tasks",
        "no higher cost per verified success",
        "less operator burden",
        "simple benchmark noninferiority",
      ],
      requirement:
        "Apply the independently preregistered analysis to these paired task-level results. Unresolved uncertainty remains inconclusive; this collector does not establish comparative benefit.",
    },
  };
}
