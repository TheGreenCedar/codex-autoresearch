import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import type { CoherentSessionSnapshot } from "../coherent-session-snapshot.js";
import type { DecisionPlan } from "../decision-compiler.js";
import type { SessionDecisionFactCollection } from "../session-decision.js";
import { resolveWorkDir as resolveSessionWorkDir } from "../session-core.js";

const outsideWorkdirAuthorization = new AsyncLocalStorage<boolean>();
type ResolvedWorkDir = ReturnType<typeof resolveSessionWorkDir>;
type AcceptedWorkdirResolution = ResolvedWorkDir & {
  coherentSnapshot?: CoherentSessionSnapshot;
  canonicalDecisionPlan?: DecisionPlan;
  canonicalDecisionFacts?: SessionDecisionFactCollection;
};
const acceptedWorkdirResolution = new AsyncLocalStorage<AcceptedWorkdirResolution>();

export function resolveAuthorizedWorkDir(cwd: unknown) {
  const accepted = acceptedWorkdirResolution.getStore();
  const requested = path.resolve(String(cwd || "") || process.cwd());
  if (
    accepted &&
    (requested === path.resolve(accepted.sessionCwd) ||
      requested === path.resolve(accepted.workDir))
  ) {
    return accepted;
  }
  return resolveSessionWorkDir(String(cwd || "") || undefined, {
    allowOutsideWorkdir: outsideWorkdirAuthorization.getStore() === true,
  });
}

export async function withAcceptedWorkdirResolution<T>(
  resolution: AcceptedWorkdirResolution,
  action: () => Promise<T>,
): Promise<T> {
  return await acceptedWorkdirResolution.run(resolution, action);
}

export function acceptedSessionDecisionContext(): {
  snapshot: CoherentSessionSnapshot;
  plan: DecisionPlan;
  facts: SessionDecisionFactCollection;
} | null {
  const accepted = acceptedWorkdirResolution.getStore();
  return accepted?.coherentSnapshot &&
    accepted.canonicalDecisionPlan &&
    accepted.canonicalDecisionFacts
    ? {
        snapshot: accepted.coherentSnapshot,
        plan: accepted.canonicalDecisionPlan,
        facts: accepted.canonicalDecisionFacts,
      }
    : null;
}

export async function withOutsideWorkdirAuthorization<T>(
  allowed: boolean,
  action: () => Promise<T>,
): Promise<T> {
  return await outsideWorkdirAuthorization.run(allowed, action);
}
