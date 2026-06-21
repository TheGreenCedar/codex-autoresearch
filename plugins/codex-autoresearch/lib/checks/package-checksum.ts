import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT } from "./check-common.js";

export async function releaseChecksumIssue(tarball: string, checksumPath: string): Promise<string> {
  let checksumText = "";
  try {
    checksumText = await fsp.readFile(checksumPath, "utf8");
  } catch (error) {
    return `Checksum file could not be read at ${checksumPath}: ${String(error)}`;
  }

  const tarballName = path.basename(tarball);
  let expectedHash = "";
  try {
    expectedHash = await parseStrictSha256Manifest(checksumText, tarballName);
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }

  const actualHash = await fileSha256(tarball);
  if (actualHash !== expectedHash) {
    return `Checksum mismatch for ${tarballName}: expected ${expectedHash}, got ${actualHash}.`;
  }
  return "";
}

export async function parseStrictSha256Manifest(
  text: string,
  expectedFileName: string,
): Promise<string> {
  const releaseIntegrity = (await import(
    pathToFileURL(path.join(ROOT, "scripts", "release-integrity.mjs")).href
  )) as {
    parseSha256Manifest: (text: string, expectedFileName: string) => string;
  };
  return releaseIntegrity.parseSha256Manifest(text, expectedFileName);
}

export async function fileSha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await fsp.readFile(file))
    .digest("hex");
}
