import type { UnknownRecord } from "../types/json.js";

export function buildNextPacketId(history: UnknownRecord = {}, fingerprint: string): string {
  return `packet-${history.nextRun || "next"}-${fingerprint.slice(0, 12)}`;
}
