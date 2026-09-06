import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inflateRawSync, crc32 } from "node:zlib";
import { outcomeObject, outcomeString } from "./outcome-contract.js";

const execute = promisify(execFile);
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export interface GitHubTransport {
  json(endpoint: string, options?: { method?: "GET" | "POST"; body?: unknown }): Promise<unknown>;
  artifact(endpoint: string): Promise<Buffer>;
}

export async function githubTransport(): Promise<GitHubTransport> {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    const result = await execute("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: 10_000,
      maxBuffer: 16_384,
      windowsHide: true,
    });
    token = result.stdout.trim();
  }
  if (!token)
    throw new Error("GitHub authentication is required for accepted confirmation infrastructure.");
  const request = async (
    endpoint: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ) => {
    if (!endpoint.startsWith("/repos/") || endpoint.includes("..") || endpoint.includes("\\"))
      throw new Error("Invalid GitHub API path.");
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(options.body == null ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body == null ? undefined : JSON.stringify(options.body),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 400)
      throw new Error(`GitHub API ${response.status} for ${endpoint.split("?")[0]}.`);
    return response;
  };
  return {
    async json(endpoint, options) {
      const response = await request(endpoint, options);
      if (response.status === 204) return null;
      return await response.json();
    },
    async artifact(endpoint) {
      const response = await request(endpoint);
      if (response.status !== 302)
        throw new Error("GitHub artifact did not supply an authenticated download redirect.");
      const target = new URL(
        outcomeString(response.headers.get("location"), "artifact download location"),
      );
      if (target.protocol !== "https:" || target.username || target.password)
        throw new Error("Artifact download URL is not HTTPS.");
      // The signed redirect is GitHub-provided. Never forward authentication to storage.
      const archive = await fetch(target, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!archive.ok) throw new Error(`Artifact download failed (${archive.status}).`);
      if (Number(archive.headers.get("content-length")) > MAX_ARTIFACT_BYTES)
        throw new Error("Artifact exceeds the supported verification bound.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!archive.body) throw new Error("Empty artifact download.");
      for await (const chunk of archive.body) {
        size += chunk.length;
        if (size > MAX_ARTIFACT_BYTES)
          throw new Error("Artifact exceeds the supported verification bound.");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
  };
}

/** Read one bounded JSON file without extracting any archive path to disk. */
export function readSingleFileArtifact(
  archive: Buffer,
  expectedName: string,
  expectedDigest: string,
): unknown {
  if (
    archive.length > MAX_ARTIFACT_BYTES ||
    createHash("sha256").update(archive).digest("hex") !== expectedDigest
  )
    throw new Error("Artifact archive digest mismatch.");
  let end = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_557); index--) {
    if (
      archive.readUInt32LE(index) === 0x06054b50 &&
      index + 22 + archive.readUInt16LE(index + 20) === archive.length
    ) {
      end = index;
      break;
    }
  }
  if (
    end < 0 ||
    archive.readUInt16LE(end + 4) !== 0 ||
    archive.readUInt16LE(end + 6) !== 0 ||
    archive.readUInt16LE(end + 8) !== 1 ||
    archive.readUInt16LE(end + 10) !== 1
  )
    throw new Error("Confirmation artifact must contain exactly one ordinary ZIP entry.");
  const central = archive.readUInt32LE(end + 16);
  if (central + 46 > end || archive.readUInt32LE(central) !== 0x02014b50)
    throw new Error("Invalid artifact central directory.");
  const flags = archive.readUInt16LE(central + 8),
    method = archive.readUInt16LE(central + 10),
    size = archive.readUInt32LE(central + 20),
    expanded = archive.readUInt32LE(central + 24);
  const nameLength = archive.readUInt16LE(central + 28),
    extraLength = archive.readUInt16LE(central + 30),
    commentLength = archive.readUInt16LE(central + 32),
    local = archive.readUInt32LE(central + 42);
  if (
    flags & 1 ||
    ![0, 8].includes(method) ||
    expanded > MAX_ARTIFACT_BYTES ||
    central + 46 + nameLength + extraLength + commentLength !== end ||
    archive.subarray(central + 46, central + 46 + nameLength).toString("utf8") !== expectedName ||
    local + 30 > central ||
    archive.readUInt32LE(local) !== 0x04034b50
  )
    throw new Error("Unexpected, encrypted, or oversized artifact entry.");
  const localName = archive.readUInt16LE(local + 26),
    localExtra = archive.readUInt16LE(local + 28),
    payload = local + 30 + localName + localExtra;
  if (
    archive.subarray(local + 30, local + 30 + localName).toString("utf8") !== expectedName ||
    payload + size > central
  )
    throw new Error("Artifact local entry does not match its directory.");
  const compressed = archive.subarray(payload, payload + size);
  const bytes =
    method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_ARTIFACT_BYTES });
  if (bytes.length !== expanded || crc32(bytes) !== archive.readUInt32LE(central + 16))
    throw new Error("Artifact expanded length mismatch.");
  return JSON.parse(bytes.toString("utf8"));
}

export function artifactDigest(metadata: unknown): string {
  const input = outcomeObject(metadata, "GitHub artifact metadata");
  const digest = outcomeString(input.digest, "GitHub artifact digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || input.expired !== false)
    throw new Error("GitHub artifact has no current SHA-256 identity.");
  return digest.slice(7);
}
