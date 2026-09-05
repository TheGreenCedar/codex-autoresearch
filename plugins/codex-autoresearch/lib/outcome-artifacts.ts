import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertSafeWriteTarget, checkedAtomicWriteFile } from "./checked-write.js";
import { outcomeStateLocation } from "./outcome-store.js";
import { pathInsideScope } from "./outcome-inputs.js";
import {
  hashOutcomeValue,
  outcomeDigest,
  outcomeEnum,
  outcomeId,
  outcomeObject,
  outcomeString,
  outcomeTimestamp,
  type OutcomeState,
} from "./outcome-contract.js";
import { normalizeRelativePaths } from "./literal-paths.js";
import { runProcess } from "./runner.js";
import type { ActionSpecification, InputFingerprint } from "./investigation-records.js";

export interface StoredCandidateFile {
  kind: "file" | "symlink";
  digest: string;
  executable: boolean;
}
export interface CandidateBase {
  id: string;
  executionId: string;
  worktree: string;
  paths: string[];
  inputDigest: string;
  files: Record<string, StoredCandidateFile>;
  createdAt: string;
}
export interface RetainedCodePatch {
  id: string;
  executionId: string;
  worktree: string;
  paths: string[];
  inputDigest: string;
  digest: string;
  createdAt: string;
  disposition: "retained-only";
}

export async function storeOutcomeObject(
  cwd: string,
  bytes: Buffer,
): Promise<{ digest: string; path: string }> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const location = await outcomeStateLocation(cwd);
  const target = path.join(path.dirname(location.path), "objects", digest);
  await assertSafeWriteTarget(location.root, target);
  try {
    const existing = await fsp.readFile(target);
    if (!existing.equals(bytes))
      throw new Error("Immutable outcome artifact bytes were substituted.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
    await checkedAtomicWriteFile(location.root, target, bytes, { mode: 0o600 });
  }
  return { digest, path: target };
}

export async function readOutcomeObject(cwd: string, digest: string): Promise<Buffer> {
  outcomeDigest(digest);
  const location = await outcomeStateLocation(cwd);
  const target = path.join(path.dirname(location.path), "objects", digest);
  await assertSafeWriteTarget(location.root, target);
  const bytes = await fsp.readFile(target);
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new Error("Immutable outcome artifact digest mismatch.");
  return bytes;
}

async function captureFile(
  cwd: string,
  file: string,
  fingerprint: InputFingerprint,
): Promise<StoredCandidateFile | null> {
  const target = path.join(cwd, file);
  const stat = await fsp.lstat(target);
  if (stat.isDirectory()) return null;
  if (!stat.isFile() && !stat.isSymbolicLink())
    throw new Error("Candidate artifact is not a regular file or internal link.");
  const kind = stat.isSymbolicLink() ? "symlink" : "file";
  const executable = kind === "file" && (stat.mode & 0o111) !== 0;
  const bytes =
    kind === "symlink" ? Buffer.from(await fsp.readlink(target)) : await fsp.readFile(target);
  const fingerprintDigest =
    kind === "symlink"
      ? hashOutcomeValue({ kind, target: bytes.toString() })
      : createHash("sha256")
          .update(executable ? "executable\0" : "file\0")
          .update(bytes)
          .digest("hex");
  if (fingerprintDigest !== fingerprint.files[file])
    throw new Error("Candidate changed between input capture and artifact preservation.");
  const object = await storeOutcomeObject(cwd, bytes);
  return { kind, executable, digest: object.digest };
}

export async function captureCandidateBase(
  cwd: string,
  action: ActionSpecification,
  input: InputFingerprint,
): Promise<CandidateBase | null> {
  if (!action.effects.includes("edit")) return null;
  const files: Record<string, StoredCandidateFile> = {};
  for (const file of Object.keys(input.files).filter((file) =>
    pathInsideScope(file, action.paths),
  )) {
    const captured = await captureFile(cwd, file, input);
    if (captured) files[file] = captured;
  }
  return {
    id: action.id,
    executionId: action.id,
    worktree: cwd,
    paths: action.paths,
    inputDigest: input.digest,
    files,
    createdAt: new Date().toISOString(),
  };
}

export async function createOwnedCandidatePatch(
  cwd: string,
  state: OutcomeState,
  input: InputFingerprint,
  selectedPaths: string[],
  timeoutSeconds: number,
  executionId: string,
): Promise<{ digest: string; path: string; paths: string[] }> {
  cwd = await fsp.realpath(cwd);
  const paths = normalizeRelativePaths(selectedPaths, "selected patch paths");
  if (
    !paths.length ||
    paths.some((file) => !pathInsideScope(file, state.contract.authorization.editable))
  )
    throw new Error("Retained patch paths must remain inside accepted editable scope.");
  if (!(timeoutSeconds > 0))
    throw new Error("The action has no remaining reserved time for patch preservation.");
  const bases = state.candidateBases.filter(
    (base) => base.worktree === cwd && base.executionId === executionId,
  );
  const candidates = [
    ...new Set([...Object.keys(input.files), ...bases.flatMap((base) => Object.keys(base.files))]),
  ].filter((file) => pathInsideScope(file, paths));
  const location = await outcomeStateLocation(cwd);
  const temporaryRoot = path.join(path.dirname(location.path), "tmp");
  await assertSafeWriteTarget(location.root, path.join(temporaryRoot, "probe"));
  await fsp.mkdir(temporaryRoot, { recursive: true });
  const temporary = await fsp.mkdtemp(path.join(temporaryRoot, "candidate-patch-"));
  const baseDir = path.join(temporary, "base");
  const currentDir = path.join(temporary, "current");
  await fsp.mkdir(baseDir);
  await fsp.mkdir(currentDir);
  const included: string[] = [];
  const materialize = async (root: string, file: string, entry: StoredCandidateFile) => {
    const destination = path.join(root, file);
    const relative = path.relative(root, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Candidate artifact path escapes the patch root.");
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const bytes = await readOutcomeObject(cwd, entry.digest);
    if (entry.kind === "symlink") await fsp.symlink(bytes.toString(), destination);
    else await fsp.writeFile(destination, bytes, { mode: entry.executable ? 0o755 : 0o644 });
  };
  try {
    for (const file of candidates) {
      const owner = bases.find((base) => pathInsideScope(file, base.paths));
      if (!owner) continue;
      const before = owner.files[file];
      const after = input.files[file] ? await captureFile(cwd, file, input) : null;
      if (!before && !after) continue;
      included.push(file);
      if (before) await materialize(baseDir, file, before);
      if (after) await materialize(currentDir, file, after);
    }
    const result = await runProcess(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-index",
        "--no-renames",
        "--binary",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "base",
        "current",
      ],
      { cwd: temporary, envMode: "minimal", timeoutSeconds, maxOutputBytes: 16 * 1024 * 1024 },
    );
    if (
      (result.code !== 0 && result.code !== 1) ||
      result.timedOut ||
      result.terminationFailed ||
      result.outputTruncated
    )
      throw new Error(
        "Complete owned candidate patch could not be captured within its reservation.",
      );
    const headers = new Map<string, string>();
    for (const file of included) {
      for (const [beforeRoot, afterRoot] of [
        ["base", "current"],
        ["current", "current"],
        ["base", "base"],
      ])
        headers.set(
          `diff --git ${gitPatchPath(`a/${beforeRoot}/${file}`)} ${gitPatchPath(`b/${afterRoot}/${file}`)}`,
          `diff --git ${gitPatchPath(`a/${file}`)} ${gitPatchPath(`b/${file}`)}`,
        );
      for (const [marker, from, to] of [
        ["---", "a/base", "a"],
        ["+++", "b/current", "b"],
      ]) {
        for (const suffix of ["", "\t"])
          headers.set(
            `${marker} ${gitPatchPath(`${from}/${file}`)}${suffix}`,
            `${marker} ${gitPatchPath(`${to}/${file}`)}${suffix}`,
          );
      }
    }
    const patch = result.stdout
      .split("\n")
      .map((line) => {
        if (
          !/^(diff --git |--- |\+\+\+ )/.test(line) ||
          line === "--- /dev/null" ||
          line === "+++ /dev/null"
        )
          return line;
        const normalized = headers.get(line);
        if (!normalized) throw new Error("Patch header does not match its selected owned path.");
        return normalized;
      })
      .join("\n");
    const stored = await storeOutcomeObject(cwd, Buffer.from(patch));
    return { ...stored, paths: included };
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

export function parseCandidateBase(value: unknown): CandidateBase {
  const input = outcomeObject(value, "candidate base");
  const files = outcomeObject(input.files, "candidate base files");
  return {
    id: outcomeId(input.id),
    executionId: outcomeId(input.executionId),
    worktree: outcomeString(input.worktree, "candidate worktree"),
    paths: normalizeRelativePaths(input.paths, "candidate base paths"),
    inputDigest: outcomeDigest(input.inputDigest),
    createdAt: outcomeTimestamp(input.createdAt, "candidate capture time"),
    files: Object.fromEntries(
      Object.entries(files).map(([file, value]) => {
        const entry = outcomeObject(value, "stored candidate file");
        if (typeof entry.executable !== "boolean")
          throw new Error("Candidate executable mode must be explicit.");
        if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
          throw new Error("Stored candidate file escapes its owner.");
        return [
          file,
          {
            kind: outcomeEnum(entry.kind, ["file", "symlink"], "candidate file kind"),
            digest: outcomeDigest(entry.digest),
            executable: entry.executable,
          },
        ];
      }),
    ),
  };
}

export function parseRetainedCodePatch(value: unknown): RetainedCodePatch {
  const input = outcomeObject(value, "retained code patch");
  if (input.disposition !== "retained-only")
    throw new Error("Retaining code cannot accept it for delivery.");
  return {
    id: outcomeId(input.id),
    executionId: outcomeId(input.executionId),
    worktree: outcomeString(input.worktree, "patch worktree"),
    paths: normalizeRelativePaths(input.paths, "patch paths"),
    inputDigest: outcomeDigest(input.inputDigest),
    digest: outcomeDigest(input.digest),
    createdAt: outcomeTimestamp(input.createdAt, "patch capture time"),
    disposition: "retained-only",
  };
}

function gitPatchPath(file: string): string {
  const escaped = (character: string) =>
    character.charCodeAt(0) < 32 ||
    character.charCodeAt(0) === 127 ||
    character === '"' ||
    character === "\\";
  const characters = Array.from(file);
  if (!characters.some(escaped)) return file;
  const escapes: Record<string, string> = {
    "\t": "\\t",
    "\n": "\\n",
    "\r": "\\r",
    "\b": "\\b",
    "\f": "\\f",
    "\v": "\\v",
    "\x07": "\\a",
    '"': '\\"',
    "\\": "\\\\",
  };
  return (
    '"' +
    characters
      .map((character) =>
        escaped(character)
          ? (escapes[character] ?? `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`)
          : character,
      )
      .join("") +
    '"'
  );
}
