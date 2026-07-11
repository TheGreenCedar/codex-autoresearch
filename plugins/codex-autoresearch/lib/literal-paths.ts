import path from "node:path";

import { listOption } from "./session-core.js";

export function normalizeRelativePaths(paths: unknown, optionName = "paths"): string[] {
  return listOption(paths).map((item) => {
    const normalized = item.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (
      !normalized ||
      normalized === "." ||
      path.isAbsolute(normalized) ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized === ".." ||
      normalized.startsWith(":") ||
      /[*?[\]]/.test(normalized) ||
      normalized.startsWith(".git/") ||
      normalized === ".git"
    ) {
      throw new Error(
        `${optionName} must contain literal project-relative paths that do not escape the working directory or use Git pathspec magic: ${item}`,
      );
    }
    return normalized.replace(/\/$/, "");
  });
}
