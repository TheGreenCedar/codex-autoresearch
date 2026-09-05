import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { hashOutcomeValue } from "./outcome-contract.js";
import { minimalProcessEnvironment } from "./runner.js";
import type { InputFingerprint } from "./investigation-records.js";

const PRIVATE_ROOT_FILES = new Set([
  ".git",
  ".autoresearch",
  "autoresearch.jsonl",
  "autoresearch.config.json",
  "autoresearch.last-run.json",
  "autoresearch.pending-transaction.json",
  "autoresearch.progress.json",
  "autoresearch.md",
  "autoresearch.ideas.md",
]);
const MAX_INPUT_FILES = 100_000;
const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;

/** Complete worktree inventory, including ignored build inputs. Limits fail closed. */
export async function captureOutcomeInputs(
  cwd: string,
  environment: string,
): Promise<InputFingerprint> {
  const root = await fsp.realpath(cwd);
  const files: Record<string, string> = {};
  const links: Record<string, string> = {};
  let entries = 0;
  let bytes = 0;
  const collect = async (relative: string): Promise<void> => {
    if (++entries > MAX_INPUT_FILES)
      throw new Error(
        "Complete input fingerprint exceeds the file limit; no partial fingerprint can authorize work or reuse.",
      );
    const absolute = path.join(root, relative);
    const before = await fsp.lstat(absolute, { bigint: true });
    if (before.isSymbolicLink()) {
      const target = await fsp.realpath(absolute);
      const local = path.relative(root, target);
      if (
        local === ".." ||
        local.startsWith(`..${path.sep}`) ||
        path.isAbsolute(local) ||
        local === "" ||
        PRIVATE_ROOT_FILES.has(local.split(path.sep)[0])
      )
        throw new Error(`Build input link escapes the visible worktree: ${relative}`);
      files[relative] = hashOutcomeValue({ kind: "symlink", target: await fsp.readlink(absolute) });
      links[relative] = local.split(path.sep).join("/");
      return;
    }
    if (before.isDirectory()) {
      const names = (await fsp.readdir(absolute)).sort();
      files[relative] = hashOutcomeValue({ kind: "directory", names });
      for (const name of names) await collect(`${relative}/${name}`);
      if (hashOutcomeValue(names) !== hashOutcomeValue((await fsp.readdir(absolute)).sort()))
        throw new Error(`Build input directory changed while fingerprinting: ${relative}`);
      return;
    }
    if (!before.isFile()) throw new Error(`Build input is not a regular file: ${relative}`);
    bytes += Number(before.size);
    if (bytes > MAX_INPUT_BYTES)
      throw new Error(
        "Complete input fingerprint exceeds the byte limit; no partial fingerprint can authorize work or reuse.",
      );
    const hash = createHash("sha256");
    hash.update((before.mode & 0o111n) !== 0n ? "executable\0" : "file\0");
    const handle = await fsp.open(absolute, "r");
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await handle.stat({ bigint: true });
      const current = await fsp.lstat(absolute, { bigint: true });
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        current.ino !== before.ino ||
        current.isSymbolicLink()
      )
        throw new Error(`Build input changed while fingerprinting: ${relative}`);
    } finally {
      await handle.close();
    }
    files[relative] = hash.digest("hex");
  };
  const roots = (await fsp.readdir(root)).filter((name) => !PRIVATE_ROOT_FILES.has(name)).sort();
  for (const name of roots) await collect(name);
  const currentRoots = (await fsp.readdir(root))
    .filter((name) => !PRIVATE_ROOT_FILES.has(name))
    .sort();
  if (hashOutcomeValue(roots) !== hashOutcomeValue(currentRoots))
    throw new Error("Build input membership changed while fingerprinting.");
  const environmentDigest = hashOutcomeValue({
    environment,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    variables: minimalProcessEnvironment(),
  });
  return {
    files,
    links,
    environment: environmentDigest,
    digest: hashOutcomeValue({ files, links, environment: environmentDigest }),
  };
}

export function changedOutcomePaths(before: InputFingerprint, after: InputFingerprint): string[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((file) => before.files[file] !== after.files[file])
    .sort();
}

export function pathInsideScope(file: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope === "." || file === scope || file.startsWith(`${scope}/`));
}
