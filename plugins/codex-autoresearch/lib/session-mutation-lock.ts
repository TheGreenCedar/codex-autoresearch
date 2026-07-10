import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { assertSafeWriteTarget } from "./checked-write.js";

const LOCK_FILE = ".autoresearch-mutation.lock";
const SHARED_LOCK_ROOT = "codex-autoresearch-locks";
const MAX_RECOVERY_DEPTH = 16;

type LockRecord = { pid: number; command: string; timestamp: string; token: string };
type RecoveryClaim = { path: string; token: string };

export async function sessionMutationLockLocation(
  workDir: string,
): Promise<{ root: string; path: string }> {
  const userScope =
    typeof process.getuid === "function"
      ? `uid-${process.getuid()}`
      : `user-${createHash("sha256").update(os.homedir().toLowerCase()).digest("hex").slice(0, 16)}`;
  const root = path.join(os.tmpdir(), `${SHARED_LOCK_ROOT}-${userScope}`);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Autoresearch lock root must be a real directory: ${root}`);
  }
  try {
    await fsp.chmod(root, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  const securedRoot = await fsp.lstat(root);
  if (
    typeof process.getuid === "function" &&
    (securedRoot.uid !== process.getuid() || (securedRoot.mode & 0o077) !== 0)
  ) {
    throw new Error(`Autoresearch lock root ownership or permissions are unsafe: ${root}`);
  }
  const realRoot = await fsp.realpath(root);
  const resolvedWorkDir = await fsp.realpath(workDir);
  const normalizedWorkDir =
    process.platform === "win32" ? resolvedWorkDir.toLowerCase() : resolvedWorkDir;
  const identity = createHash("sha256").update(normalizedWorkDir).digest("hex");
  return { root: realRoot, path: path.join(realRoot, `${identity}.mutation.lock`) };
}

export function sessionRecoveryLockPath(
  lockPath: string,
  ownerToken: string,
  parentToken = "",
): string {
  const identity = createHash("sha256")
    .update(`${ownerToken}:${parentToken}`)
    .digest("hex")
    .slice(0, 20);
  return `${lockPath}.recovery-${identity}`;
}

export async function withSessionMutationLock<T>(
  sessionRoot: string,
  command: string,
  action: () => Promise<T>,
  explicitLockPath = "",
): Promise<T> {
  const lockPath = explicitLockPath || path.join(path.resolve(sessionRoot), LOCK_FILE);
  const token = randomUUID();
  const acquiredLockPath = await acquire(lockPath, sessionRoot, {
    pid: process.pid,
    command,
    timestamp: new Date().toISOString(),
    token,
  });
  try {
    return await action();
  } finally {
    await release(acquiredLockPath, token);
  }
}

async function acquire(lockPath: string, root: string, record: LockRecord): Promise<string> {
  const safeLockPath = await assertSafeWriteTarget(root, lockPath);
  await fsp.mkdir(path.dirname(safeLockPath), { recursive: true });
  if ((await assertSafeWriteTarget(root, lockPath)) !== safeLockPath) {
    throw new Error(`Autoresearch lock root changed while acquiring ${safeLockPath}.`);
  }
  try {
    await createLock(safeLockPath, record);
    return safeLockPath;
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const owner = await readLock(safeLockPath);
  if (!owner || !isDead(owner.pid)) {
    throw new Error(
      `Autoresearch mutation is already running${owner ? ` (pid ${owner.pid}, command ${owner.command}, since ${owner.timestamp})` : " (lock owner metadata is invalid)"}.`,
    );
  }
  const recoveryRecord: LockRecord = {
    ...record,
    command: `${record.command}:lock-recovery`,
    token: randomUUID(),
  };
  const canonicalRoot = await fsp.realpath(root);
  const claims = await acquireRecoveryAuthority(safeLockPath, canonicalRoot, owner, recoveryRecord);
  try {
    const confirmed = await readLock(safeLockPath);
    if (!confirmed || confirmed.token !== owner.token || !isDead(confirmed.pid)) {
      throw new Error("Autoresearch mutation lock changed during dead-owner recovery.");
    }
    await fsp.unlink(safeLockPath);
    await createLock(safeLockPath, record);
    return safeLockPath;
  } finally {
    await releaseRecoveryClaims(claims);
  }
}

async function acquireRecoveryAuthority(
  lockPath: string,
  root: string,
  deadOwner: LockRecord,
  record: LockRecord,
): Promise<RecoveryClaim[]> {
  const claims: RecoveryClaim[] = [];
  let parentToken = "";
  for (let depth = 0; depth < MAX_RECOVERY_DEPTH; depth += 1) {
    const recoveryPath = sessionRecoveryLockPath(lockPath, deadOwner.token, parentToken);
    const safeRecoveryPath = await assertSafeWriteTarget(root, recoveryPath);
    try {
      await createLock(safeRecoveryPath, record);
      claims.push({ path: safeRecoveryPath, token: record.token });
      return claims;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const owner = await readLock(safeRecoveryPath);
    if (!owner || !isDead(owner.pid)) {
      throw new Error(
        `Autoresearch lock recovery is already running${owner ? ` (pid ${owner.pid}, since ${owner.timestamp})` : " (owner metadata is invalid)"}.`,
      );
    }
    claims.push({ path: safeRecoveryPath, token: owner.token });
    parentToken = owner.token;
  }
  throw new Error("Autoresearch lock recovery exceeded the dead-owner recovery depth limit.");
}

async function releaseRecoveryClaims(claims: RecoveryClaim[]): Promise<void> {
  for (const claim of [...claims].reverse()) {
    await release(claim.path, claim.token);
  }
}

async function createLock(lockPath: string, record: LockRecord): Promise<void> {
  const handle = await fsp.open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.unlink(lockPath).catch(() => {});
    throw error;
  }
}

async function release(lockPath: string, token: string): Promise<void> {
  const owner = await readLock(lockPath);
  if (owner?.token !== token) return;
  await fsp.unlink(lockPath).catch((error: any) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function readLock(lockPath: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await fsp.readFile(lockPath, "utf8"));
    return Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value?.token === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

function isDead(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: any) {
    return error?.code === "ESRCH";
  }
}
