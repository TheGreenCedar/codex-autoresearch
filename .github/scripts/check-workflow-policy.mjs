#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.join(".github", "workflows");
const trustedOwners = new Set(["actions", "github"]);
const shaPattern = /^[0-9a-f]{40}$/i;
const violations = [];

for (const file of fs
  .readdirSync(root)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))) {
  const content = fs.readFileSync(path.join(root, file), "utf8");
  content.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/\buses:\s*['"]?([^'"\s#]+)['"]?/);
    if (!match) return;
    const spec = match[1];
    if (spec.startsWith("./")) return;
    const at = spec.lastIndexOf("@");
    if (at === -1) {
      violations.push(`${file}:${index + 1} ${spec} is missing an immutable ref`);
      return;
    }
    const action = spec.slice(0, at);
    const ref = spec.slice(at + 1);
    const owner = action.split("/")[0];
    if (!trustedOwners.has(owner) && !shaPattern.test(ref)) {
      violations.push(
        `${file}:${index + 1} ${spec} must pin third-party actions to a full-length SHA`,
      );
    }
  });
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("Workflow policy passed: third-party GitHub Actions are pinned to full-length SHAs.");
