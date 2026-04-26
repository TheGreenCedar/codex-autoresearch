import fs from "node:fs";
import path from "node:path";
import { resolvePackageRoot } from "./runtime-paths.js";

const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const PLUGIN_PACKAGE_JSON = path.join(PLUGIN_ROOT, "package.json");

const packageVersion = JSON.parse(fs.readFileSync(PLUGIN_PACKAGE_JSON, "utf8")).version;
if (typeof packageVersion !== "string" || packageVersion.trim().length === 0) {
  throw new Error("Missing plugin package version");
}

export const PLUGIN_VERSION = packageVersion;
