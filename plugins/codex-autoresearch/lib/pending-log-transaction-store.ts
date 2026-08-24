import type { PrivateStateSpec } from "./git-private-state.js";
import { resolveSessionPaths } from "./session-paths.js";
import { isUnknownRecord, type UnknownRecord } from "./types/json.js";

export const PENDING_LOG_TRANSACTION_GIT_PATH = "autoresearch/pending-log-transaction.json";

export interface PendingLogTransactionSnapshot {
  present: true;
  schemaVersion: number | null;
  status: "done" | "failed" | "pending" | "unknown";
  transactionId: string;
  consistent: boolean;
  diagnosticCode: "pending-log-transaction-inconsistent" | "pending-log-transaction";
  receipt: UnknownRecord | null;
}

export function pendingLogTransactionStateSpec(workDir: string): PrivateStateSpec {
  return {
    fallbackPath: resolveSessionPaths({ workDir }).pendingLogTransactionFallbackPath,
    gitRelativePath: PENDING_LOG_TRANSACTION_GIT_PATH,
    label: "pending log receipt",
  };
}

export function parsePendingLogTransactionBytes(
  bytes: Uint8Array | null,
): PendingLogTransactionSnapshot | null {
  if (bytes == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return inconsistent(null);
  }
  if (!isUnknownRecord(parsed)) return inconsistent(null);
  const transaction = isUnknownRecord(parsed.transaction) ? parsed.transaction : null;
  const schemaVersion = Number.isSafeInteger(parsed.schemaVersion)
    ? Number(parsed.schemaVersion)
    : null;
  const status = ["pending", "failed", "done"].includes(String(parsed.status || ""))
    ? (parsed.status as "done" | "failed" | "pending")
    : "unknown";
  const transactionId = typeof transaction?.id === "string" ? transaction.id : "";
  const consistent =
    parsed.type === "autoresearch.log.transaction" &&
    schemaVersion === 2 &&
    status !== "unknown" &&
    transactionId.length > 0;
  return {
    present: true,
    schemaVersion,
    status,
    transactionId,
    consistent,
    diagnosticCode: consistent ? "pending-log-transaction" : "pending-log-transaction-inconsistent",
    receipt: parsed,
  };
}

function inconsistent(receipt: UnknownRecord | null): PendingLogTransactionSnapshot {
  return {
    present: true,
    schemaVersion: null,
    status: "unknown",
    transactionId: "",
    consistent: false,
    diagnosticCode: "pending-log-transaction-inconsistent",
    receipt,
  };
}
