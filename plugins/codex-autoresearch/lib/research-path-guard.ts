import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { RESEARCH_DIR } from "./session-core.js";

export interface SafeResearchPath {
  root: string;
  slug: string;
  outputDir: string;
}

const RESERVED_WINDOWS_NAMES = new Set([
  "aux",
  "con",
  "nul",
  "prn",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export function validateResearchSlug(slug: string): string {
  const value = String(slug || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error("research slug must match ^[a-z0-9][a-z0-9-]{0,63}$ and cannot contain paths");
  }
  if (RESERVED_WINDOWS_NAMES.has(value.toLowerCase())) {
    throw new Error(`research slug uses a reserved name: ${value}`);
  }
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`research slug cannot be a path: ${value}`);
  }
  if (path.isAbsolute(value)) throw new Error(`research slug cannot be absolute: ${value}`);
  return value;
}

export async function resolveSafeResearchPath(
  cwd: string,
  slug: string,
): Promise<SafeResearchPath> {
  const workDir = path.resolve(cwd || process.cwd());
  const safeSlug = validateResearchSlug(slug);
  const root = path.join(workDir, RESEARCH_DIR);
  const outputDir = path.join(root, safeSlug);
  await assertInsideResearchRoot(root, outputDir);
  return { root, slug: safeSlug, outputDir };
}

export async function assertInsideResearchRoot(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rootReal = await realPathForTarget(resolvedRoot);
  const targetReal = await realPathForTarget(resolvedTarget);
  if (!isPathInside(rootReal, targetReal)) {
    throw new Error(`target path escapes ${RESEARCH_DIR}: ${target}`);
  }
}

async function realPathForTarget(target: string): Promise<string> {
  if (fs.existsSync(target)) return await fsp.realpath(target);
  const parent = await nearestExistingParent(path.dirname(target));
  const parentReal = await realPathOrResolved(parent);
  return path.join(parentReal, path.relative(parent, target));
}

async function nearestExistingParent(start: string): Promise<string> {
  let cursor = path.resolve(start);
  while (!fs.existsSync(cursor)) {
    const next = path.dirname(cursor);
    if (next === cursor) return cursor;
    cursor = next;
  }
  return cursor;
}

async function realPathOrResolved(value: string): Promise<string> {
  try {
    return await fsp.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
