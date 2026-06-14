import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type { UnknownRecord } from "./types/json.js";

export type SessionRecord = UnknownRecord & Record<string, any>;

export interface SessionReadCache {
  recordsByCwd: Map<string, SessionRecord[]>;
  stateByCwd: Map<string, unknown>;
}

export function createSessionReadCache(): SessionReadCache {
  return { recordsByCwd: new Map(), stateByCwd: new Map() };
}

export function jsonlPath(workDir: string): string {
  return path.join(workDir, "autoresearch.jsonl");
}

export function appendJsonl(workDir: string, entry: UnknownRecord): void {
  fs.appendFileSync(jsonlPath(workDir), `${JSON.stringify(entry)}\n`);
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
  const cached = readCache.recordsByCwd.get(cacheKey);
  if (cached) return cached;
  const records = readJsonl(workDir);
  readCache.recordsByCwd.set(cacheKey, records);
  return records;
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
