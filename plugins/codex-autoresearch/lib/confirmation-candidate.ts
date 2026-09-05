import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { captureOutcomeInputs } from "./outcome-inputs.js";
import { hashOutcomeValue } from "./outcome-contract.js";
import {
  parseConfirmationCandidate,
  type ConfirmationCandidate,
} from "./github-confirmation-records.js";

export async function captureConfirmationCandidate(
  cwd: string,
  environment: string,
): Promise<ConfirmationCandidate> {
  const input = await captureOutcomeInputs(cwd, environment);
  const files: ConfirmationCandidate["files"] = {};
  let bytes = 0;
  for (const file of Object.keys(input.files)) {
    const absolute = path.join(cwd, file);
    const stat = await fsp.lstat(absolute);
    if (stat.isDirectory()) continue;
    const kind = stat.isSymbolicLink() ? "symlink" : "file";
    const content =
      kind === "symlink" ? Buffer.from(await fsp.readlink(absolute)) : await fsp.readFile(absolute);
    bytes += content.length;
    if (bytes > 4 * 1024 * 1024)
      throw new Error("Confirmation candidate exceeds the current 4 MiB content bound.");
    files[file] = {
      kind,
      executable: kind === "file" && (stat.mode & 0o111) !== 0,
      bytesBase64: content.toString("base64"),
    };
  }
  const candidate: ConfirmationCandidate = { schemaVersion: 1, input, files };
  validateConfirmationCandidate(candidate, input.digest);
  return candidate;
}

/** Candidate bytes, directory membership, link targets, and assessed input are one identity. */
export function validateConfirmationCandidate(
  value: unknown,
  expectedInputDigest: string,
): ConfirmationCandidate {
  const candidate = parseConfirmationCandidate(value);
  if (candidate.input.digest !== expectedInputDigest)
    throw new Error("Confirmation artifact assesses a different candidate input.");
  for (const file of Object.keys(candidate.files))
    if (!Object.hasOwn(candidate.input.files, file))
      throw new Error("Candidate artifact includes unassessed content.");
  for (const [file, expected] of Object.entries(candidate.input.files)) {
    const entry = candidate.files[file];
    if (!entry) {
      const names = Object.keys(candidate.input.files)
        .filter((child) => path.posix.dirname(child) === file)
        .map((child) => path.posix.basename(child))
        .sort();
      if (hashOutcomeValue({ kind: "directory", names }) !== expected)
        throw new Error("Candidate directory inventory does not match its input fingerprint.");
      continue;
    }
    const bytes = Buffer.from(entry.bytesBase64, "base64");
    const digest =
      entry.kind === "symlink"
        ? hashOutcomeValue({ kind: "symlink", target: bytes.toString() })
        : createHash("sha256")
            .update(entry.executable ? "executable\0" : "file\0")
            .update(bytes)
            .digest("hex");
    if (digest !== expected)
      throw new Error("Candidate bytes do not match their assessed input fingerprint.");
  }
  return candidate;
}
