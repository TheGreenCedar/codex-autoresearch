import fsp from "node:fs/promises";
import path from "node:path";
import { startOutcome, amendOutcome, stopOutcome, readOutcome } from "../outcome-store.js";
import { outcomeEnum, outcomeString } from "../outcome-contract.js";
import {
  nominateOutcomeAction,
  resumeOutcomeAction,
  logOutcomeObservation,
} from "../investigation-workflow.js";
import { loadCanonicalSessionDecision } from "../session-decision.js";
import { projectCompactDecisionPlan, projectResolvedDecision } from "../decision-projection.js";
import type { UnknownRecord } from "../types/json.js";

export async function readStructuredOutcomeFile(file: unknown): Promise<unknown> {
  const target = path.resolve(outcomeString(file, "structured input file"));
  const stat = await fsp.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error("Structured outcome input must be a regular file at most 1 MiB.");
  return JSON.parse(await fsp.readFile(target, "utf8"));
}

function workDir(args: UnknownRecord): string {
  return path.resolve(String(args.cwd ?? args.workingDir ?? process.cwd()));
}

export async function outcomeCommand(args: UnknownRecord): Promise<UnknownRecord> {
  const positionals = Array.isArray(args._) ? args._ : [];
  const action = outcomeEnum(
    positionals[1] ?? args.action,
    ["start", "adopt", "amend", "stop"],
    "outcome action",
  );
  const cwd = workDir(args);
  const state =
    action === "stop"
      ? await stopOutcome(cwd, outcomeString(args.reason, "stop reason"))
      : action === "amend"
        ? await amendOutcome(
            cwd,
            await readStructuredOutcomeFile(args.contractFile),
            outcomeString(args.authorization, "amendment authorization"),
            outcomeString(args.reason, "amendment reason"),
          )
        : await startOutcome(cwd, await readStructuredOutcomeFile(args.contractFile), {
            adopt: action === "adopt",
          });
  return {
    ok: true,
    workDir: cwd,
    outcomeId: state.contract.id,
    revision: state.revision,
    authorization: state.contract.authorization.reference,
    budget: state.contract.budget,
  };
}

export async function nextOutcomeAction(args: UnknownRecord): Promise<UnknownRecord> {
  if (args.actionFile && args.resume)
    throw new Error("Choose an action specification or an execution to resume.");
  const cwd = workDir(args);
  const receipt = args.resume
    ? await resumeOutcomeAction(cwd, outcomeString(args.resume, "execution identity"))
    : await nominateOutcomeAction(cwd, await readStructuredOutcomeFile(args.actionFile));
  return {
    ok: true,
    workDir: cwd,
    execution: { ...receipt, token: undefined },
    actionTicket:
      receipt.status.kind === "ticket"
        ? {
            id: receipt.id,
            authorization: receipt.authorizationDigest,
            action: receipt.action,
            inputDigest: receipt.input?.digest,
            reservationId: receipt.reservationId,
          }
        : null,
  };
}

export async function logInvestigationObservation(args: UnknownRecord): Promise<UnknownRecord> {
  const cwd = workDir(args);
  const evidence = await logOutcomeObservation(
    cwd,
    await readStructuredOutcomeFile(args.observationFile),
  );
  return { ok: true, workDir: cwd, evidence };
}

export async function maybeOutcomeReadout(args: UnknownRecord): Promise<UnknownRecord | null> {
  const cwd = workDir(args);
  if (!(await readOutcome(cwd))) return null;
  const loaded = await loadCanonicalSessionDecision({ requestedCwd: cwd });
  if (!loaded.ok) return { ok: false, code: loaded.diagnostic.code, diagnostic: loaded.diagnostic };
  const projection = loaded.plan.investigation;
  return {
    ok: true,
    workDir: cwd,
    investigation: projection,
    result: loaded.plan.outcome,
    decisionPlanProjection: projectCompactDecisionPlan(loaded.plan),
    resolvedDecision: projectResolvedDecision(loaded.plan),
    criterionCoverage: loaded.snapshot.outcome!.contract.criteria.map((criterion) => ({
      ...criterion,
      covered: !projection?.unresolvedCriteria.includes(criterion.id),
    })),
    delivery: projection?.delivery,
    evidenceCount: loaded.snapshot.outcome!.evidence.length,
    ...(args.jsonFull
      ? {
          investigations: loaded.snapshot.outcome!.investigations,
          evidence: loaded.snapshot.outcome!.evidence,
          executions: loaded.snapshot.outcome!.executions.map(
            ({ token: _token, ...receipt }) => receipt,
          ),
        }
      : {}),
  };
}
