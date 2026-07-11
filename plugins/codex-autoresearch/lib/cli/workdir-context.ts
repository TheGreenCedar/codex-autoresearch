import { AsyncLocalStorage } from "node:async_hooks";

import { resolveWorkDir as resolveSessionWorkDir } from "../session-core.js";

const outsideWorkdirAuthorization = new AsyncLocalStorage<boolean>();

export function resolveAuthorizedWorkDir(cwd: unknown) {
  return resolveSessionWorkDir(String(cwd || "") || undefined, {
    allowOutsideWorkdir: outsideWorkdirAuthorization.getStore() === true,
  });
}

export async function withOutsideWorkdirAuthorization<T>(
  allowed: boolean,
  action: () => Promise<T>,
): Promise<T> {
  return await outsideWorkdirAuthorization.run(allowed, action);
}
