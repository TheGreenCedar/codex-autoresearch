import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { resolveSessionPaths } from "./session-paths.js";
import { checkedAppendFileSync } from "./checked-write.js";
import type { UnknownRecord } from "./types/json.js";

export type SessionRecord = UnknownRecord & Record<string, any>;

export interface SessionReadCache {
  recordsByCwd: Map<string, SessionRecord[]>;
  stateByCwd: Map<string, unknown>;
  ledgerStampByCwd?: Map<string, string>;
  invalidateOnLedgerChange?: boolean;
}

export function createSessionReadCache(
  options: { invalidateOnLedgerChange?: boolean } = {},
): SessionReadCache {
  return {
    recordsByCwd: new Map(),
    stateByCwd: new Map(),
    ledgerStampByCwd: new Map(),
    invalidateOnLedgerChange: options.invalidateOnLedgerChange === true,
  };
}

export function jsonlPath(workDir: string): string {
  return resolveSessionPaths({ workDir }).ledgerPath;
}

export function appendJsonl(workDir: string, entry: UnknownRecord): void {
  const paths = resolveSessionPaths({ workDir });
  checkedAppendFileSync(paths.sessionDir, paths.ledgerPath, `${JSON.stringify(entry)}\n`);
}

export function readJsonl(workDir: string): SessionRecord[] {
  const filePath = jsonlPath(workDir);
  if (!fs.existsSync(filePath)) return [];
  return parseJsonlLines(fs.readFileSync(filePath, "utf8"), filePath);
}

export async function* streamJsonl(workDir: string): AsyncGenerator<SessionRecord> {
  const filePath = jsonlPath(workDir);
  if (!fs.existsSync(filePath)) return;
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const rawLine of lines) {
      index += 1;
      const line = String(rawLine).trim();
      if (!line) continue;
      yield parseJsonlLine(line, filePath, index);
    }
  } finally {
    stream.destroy();
  }
}

export async function readJsonlTail(workDir: string, maxEntries = 50): Promise<SessionRecord[]> {
  const limit = Math.max(0, Math.floor(Number(maxEntries) || 0));
  if (limit === 0) return [];
  const tail = [];
  for await (const entry of streamJsonl(workDir)) {
    tail.push(entry);
    if (tail.length > limit) tail.shift();
  }
  return tail;
}

export function loadSessionRecords(
  workDir: string,
  readCache?: SessionReadCache | null,
): SessionRecord[] {
  if (!readCache) return readJsonl(workDir);
  const cacheKey = path.resolve(workDir);
  refreshSessionReadCacheForLedgerStamp(workDir, readCache);
  const cached = readCache.recordsByCwd.get(cacheKey);
  if (cached) return cached;
  const records = readJsonl(workDir);
  readCache.recordsByCwd.set(cacheKey, records);
  return records;
}

export function refreshSessionReadCacheForLedgerStamp(
  workDir: string,
  readCache?: SessionReadCache | null,
): void {
  if (!readCache) return;
  if (readCache.invalidateOnLedgerChange !== true) return;
  const cacheKey = path.resolve(workDir);
  const stampByCwd = readCache.ledgerStampByCwd ?? new Map<string, string>();
  readCache.ledgerStampByCwd = stampByCwd;
  const nextStamp = ledgerStamp(workDir);
  const previousStamp = stampByCwd.get(cacheKey);
  if (previousStamp && previousStamp !== nextStamp) {
    readCache.recordsByCwd.delete(cacheKey);
    readCache.stateByCwd.delete(cacheKey);
  }
  stampByCwd.set(cacheKey, nextStamp);
}

function ledgerStamp(workDir: string): string {
  const filePath = jsonlPath(workDir);
  try {
    const stats = fs.statSync(filePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch (error) {
    if (isFileNotFound(error)) return "missing";
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseJsonlLines(text: string, filePath: string): SessionRecord[] {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseJsonlLine(line, filePath, index + 1));
}

function parseJsonlLine(line: string, filePath: string, index: number): SessionRecord {
  try {
    return JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSONL in ${filePath} at line ${index}: ${message}`);
  }
}
