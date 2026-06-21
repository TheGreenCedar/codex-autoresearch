import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeLedger(dir: string, records: Record<string, unknown>[]) {
  await writeFile(
    path.join(dir, "autoresearch.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
}

export function parseLedger(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
