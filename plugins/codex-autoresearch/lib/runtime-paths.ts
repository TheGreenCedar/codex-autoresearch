import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findPackageRoot(startDir: string) {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find package.json above ${startDir}`);
    }
    current = parent;
  }
}

export function resolvePackageRoot(metaUrl: string) {
  return findPackageRoot(path.dirname(fileURLToPath(metaUrl)));
}

export function resolveRepoRoot(metaUrl: string) {
  return path.resolve(resolvePackageRoot(metaUrl), "..", "..");
}
