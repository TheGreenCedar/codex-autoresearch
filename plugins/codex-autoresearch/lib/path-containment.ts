import fs from "node:fs";
import path from "node:path";

export interface PathContainmentResult {
  absolutePath: string;
  error: string;
  inside: boolean;
  realPath: string;
  realRoot: string;
  relativePath: string;
}

export function resolvePathInsideRootSync(root: string, target: string): PathContainmentResult {
  const absoluteRoot = path.resolve(root || process.cwd());
  const absolutePath = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(absoluteRoot, target);
  const relativePath = slashPath(path.relative(absoluteRoot, absolutePath));
  const lexicalInside = isPathInside(absoluteRoot, absolutePath);
  const rootReal = realPathForTargetSync(absoluteRoot);
  const targetReal = lexicalInside
    ? realPathForTargetSync(absolutePath)
    : { error: "", path: absolutePath };
  const error = rootReal.error || targetReal.error;
  return {
    absolutePath,
    error,
    inside: lexicalInside && !error && isPathInside(rootReal.path, targetReal.path),
    realPath: targetReal.path,
    realRoot: rootReal.path,
    relativePath,
  };
}

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function realPathForTargetSync(target: string): { error: string; path: string } {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved)) return realPathOrErrorSync(resolved);
  const parent = nearestExistingParentSync(path.dirname(resolved));
  const parentReal = realPathOrErrorSync(parent);
  if (parentReal.error) return { error: parentReal.error, path: resolved };
  return { error: "", path: path.resolve(parentReal.path, path.relative(parent, resolved)) };
}

function realPathOrErrorSync(target: string): { error: string; path: string } {
  try {
    return { error: "", path: fs.realpathSync.native(target) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      path: path.resolve(target),
    };
  }
}

function nearestExistingParentSync(start: string): string {
  let cursor = path.resolve(start);
  while (!fs.existsSync(cursor)) {
    const next = path.dirname(cursor);
    if (next === cursor) return cursor;
    cursor = next;
  }
  return cursor;
}

function slashPath(value: string): string {
  return value.replace(/\\/g, "/");
}
