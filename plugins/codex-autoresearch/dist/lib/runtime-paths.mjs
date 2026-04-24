import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
//#region lib/runtime-paths.ts
function findPackageRoot(startDir) {
	let current = path.resolve(startDir);
	for (;;) {
		if (fs.existsSync(path.join(current, "package.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`Could not find package.json above ${startDir}`);
		current = parent;
	}
}
function resolvePackageRoot(metaUrl) {
	return findPackageRoot(path.dirname(fileURLToPath(metaUrl)));
}
function resolveRepoRoot(metaUrl) {
	return path.resolve(resolvePackageRoot(metaUrl), "..", "..");
}
//#endregion
export { resolvePackageRoot, resolveRepoRoot };
