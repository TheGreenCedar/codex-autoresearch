import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { isPathInside } from "./path-containment.js";

type WriteData = string | Uint8Array;

export async function assertSafeWriteTarget(root: string, target: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!isPathInside(absoluteRoot, absoluteTarget) || absoluteRoot === absoluteTarget) {
    throw new Error(`Refusing write outside the session root: ${absoluteTarget}`);
  }
  const rootStat = await fsp.lstat(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Session root must be a real directory: ${absoluteRoot}`);
  }
  const realRoot = await fsp.realpath(absoluteRoot);
  const safeTarget = path.join(realRoot, path.relative(absoluteRoot, absoluteTarget));
  const relativeParent = path.relative(realRoot, path.dirname(safeTarget));
  let cursor = realRoot;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fsp.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Write parent must not be a symlink, junction, or file: ${cursor}`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  const existingParent = await nearestExistingParent(path.dirname(safeTarget));
  const realParent = await fsp.realpath(existingParent);
  if (!isPathInside(realRoot, realParent)) {
    throw new Error(`Write parent escapes the session root: ${safeTarget}`);
  }
  try {
    const targetStat = await fsp.lstat(safeTarget);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(`Write target must be a regular file: ${safeTarget}`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return safeTarget;
}

export async function checkedAtomicWriteFile(
  root: string,
  target: string,
  data: WriteData,
  options: { mode?: number } = {},
): Promise<void> {
  const safeTarget = await assertSafeWriteTarget(root, target);
  await fsp.mkdir(path.dirname(safeTarget), { recursive: true });
  if ((await assertSafeWriteTarget(root, target)) !== safeTarget) {
    throw new Error(`Session root changed while preparing write: ${root}`);
  }
  const temp = path.join(
    path.dirname(safeTarget),
    `.${path.basename(safeTarget)}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | null = null;
  let committed = false;
  try {
    handle = await fsp.open(temp, "wx", options.mode ?? 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temp, safeTarget);
    committed = true;
    await fsp.chmod(safeTarget, options.mode ?? 0o600).catch(() => {});
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!committed) await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

export async function checkedAppendFile(
  root: string,
  target: string,
  data: WriteData,
  options: { mode?: number } = {},
): Promise<void> {
  const safeTarget = await assertSafeWriteTarget(root, target);
  await fsp.mkdir(path.dirname(safeTarget), { recursive: true });
  if ((await assertSafeWriteTarget(root, target)) !== safeTarget) {
    throw new Error(`Session root changed while preparing append: ${root}`);
  }
  const handle = await fsp.open(safeTarget, "a", options.mode ?? 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chmod(safeTarget, options.mode ?? 0o600).catch(() => {});
}

export async function assertSafeDirectoryTree(root: string, target: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!isPathInside(absoluteRoot, absoluteTarget) || absoluteRoot === absoluteTarget) {
    throw new Error(`Refusing directory mutation outside the session root: ${absoluteTarget}`);
  }
  const rootStat = await fsp.lstat(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Session root must be a real directory: ${absoluteRoot}`);
  }
  const realRoot = await fsp.realpath(absoluteRoot);
  const safeTarget = path.join(realRoot, path.relative(absoluteRoot, absoluteTarget));
  let cursor = realRoot;
  for (const part of path.relative(realRoot, safeTarget).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fsp.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Session directory must not be a symlink, junction, or file: ${cursor}`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") return safeTarget;
      throw error;
    }
  }
  await assertTreeContainsNoLinks(safeTarget);
  return safeTarget;
}

export async function checkedReplaceDirectory(
  root: string,
  target: string,
  source: string,
): Promise<void> {
  const safeTarget = await assertSafeDirectoryTree(root, target);
  await assertTreeContainsNoLinks(source);
  const parent = path.dirname(safeTarget);
  const staging = path.join(parent, `.${path.basename(safeTarget)}.${randomUUID()}.tmp`);
  let committed = false;
  try {
    await fsp.cp(source, staging, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    if ((await assertSafeDirectoryTree(root, target)) !== safeTarget) {
      throw new Error(`Session root changed while replacing directory: ${root}`);
    }
    await fsp.rm(safeTarget, { recursive: true, force: true });
    await fsp.rename(staging, safeTarget);
    committed = true;
  } finally {
    if (!committed) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function checkedEnsureDirectory(root: string, target: string): Promise<void> {
  const safeTarget = await assertSafeDirectoryTree(root, target);
  await fsp.mkdir(safeTarget, { recursive: true });
  if ((await assertSafeDirectoryTree(root, target)) !== safeTarget) {
    throw new Error(`Session root changed while creating directory: ${root}`);
  }
}

export function checkedAppendFileSync(root: string, target: string, data: WriteData): void {
  const safeTarget = assertSafeWriteTargetSync(root, target);
  const handle = fs.openSync(safeTarget, "a", 0o600);
  try {
    fs.writeFileSync(handle, data);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.chmodSync(safeTarget, 0o600);
  } catch {
    // Windows permissions are best effort; the reparse checks remain mandatory.
  }
}

function assertSafeWriteTargetSync(root: string, target: string): string {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!isPathInside(absoluteRoot, absoluteTarget) || absoluteRoot === absoluteTarget) {
    throw new Error(`Refusing write outside the session root: ${absoluteTarget}`);
  }
  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Session root must be a real directory: ${absoluteRoot}`);
  }
  const realRoot = fs.realpathSync.native(absoluteRoot);
  const safeTarget = path.join(realRoot, path.relative(absoluteRoot, absoluteTarget));
  let cursor = realRoot;
  const relativeParent = path.relative(realRoot, path.dirname(safeTarget));
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Write parent must not be a symlink, junction, or file: ${cursor}`);
    }
  }
  let parent = path.dirname(safeTarget);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (!isPathInside(realRoot, fs.realpathSync.native(parent))) {
    throw new Error(`Write parent escapes the session root: ${safeTarget}`);
  }
  if (fs.existsSync(safeTarget)) {
    const stat = fs.lstatSync(safeTarget);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Write target must be a regular file: ${safeTarget}`);
    }
  }
  return safeTarget;
}

async function nearestExistingParent(start: string): Promise<string> {
  let cursor = path.resolve(start);
  for (;;) {
    try {
      await fsp.lstat(cursor);
      return cursor;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const next = path.dirname(cursor);
      if (next === cursor) throw error;
      cursor = next;
    }
  }
}

async function assertTreeContainsNoLinks(root: string): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    const stat = await fsp.lstat(child);
    if (stat.isSymbolicLink()) {
      throw new Error(`Session tree must not contain symlinks or junctions: ${child}`);
    }
    if (stat.isDirectory()) await assertTreeContainsNoLinks(child);
  }
}
