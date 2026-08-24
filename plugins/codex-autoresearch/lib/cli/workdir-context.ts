import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import { resolveWorkDir as resolveSessionWorkDir } from "../session-core.js";

const outsideWorkdirAuthorization = new AsyncLocalStorage<boolean>();
type ResolvedWorkDir = ReturnType<typeof resolveSessionWorkDir>;
const acceptedWorkdirResolution = new AsyncLocalStorage<ResolvedWorkDir>();

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
  resolution: ResolvedWorkDir,
  action: () => Promise<T>,
): Promise<T> {
  return await acceptedWorkdirResolution.run(resolution, action);
}

export async function withOutsideWorkdirAuthorization<T>(
  allowed: boolean,
  action: () => Promise<T>,
): Promise<T> {
  return await outsideWorkdirAuthorization.run(allowed, action);
}
