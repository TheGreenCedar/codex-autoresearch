import { createHash } from "node:crypto";

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
  ledgerRelation: PendingLogLedgerRelation;
  receipt: UnknownRecord | null;
}

export type PendingLogLedgerRelation =
  | {
      kind: "absent" | "complete" | "receipt-owned-torn-suffix";
      transactionId: string;
      prefixByteLength: number;
    }
  | {
      kind: "unrelated";
      transactionId: string;
      reason: string;
    };

export function pendingLogTransactionStateSpec(workDir: string): PrivateStateSpec {
  return {
    fallbackPath: resolveSessionPaths({ workDir }).pendingLogTransactionFallbackPath,
    gitRelativePath: PENDING_LOG_TRANSACTION_GIT_PATH,
    label: "pending log receipt",
  };
}

export function parsePendingLogTransactionBytes(
  bytes: Uint8Array | null,
  ledgerBytes: Uint8Array | null = null,
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
    ledgerRelation: inspectPendingLogLedgerRelation(parsed, ledgerBytes),
    receipt: parsed,
  };
}

export function inspectPendingLogLedgerRelation(
  receipt: UnknownRecord,
  ledgerBytes: Uint8Array | null,
): PendingLogLedgerRelation {
  const transaction = isUnknownRecord(receipt.transaction) ? receipt.transaction : {};
  const ledgerEvent = isUnknownRecord(receipt.ledgerEvent) ? receipt.ledgerEvent : {};
  const evidence = isUnknownRecord(receipt.evidence) ? receipt.evidence : {};
  const transactionId = typeof transaction.id === "string" ? transaction.id : "";
  const eventTransactionId =
    typeof ledgerEvent.transactionId === "string" ? ledgerEvent.transactionId : "";
  const eventDigest = typeof ledgerEvent.eventDigest === "string" ? ledgerEvent.eventDigest : "";
  const prefixByteLength = Number(ledgerEvent.prefixByteLength);
  const prefixDigest = typeof ledgerEvent.prefixDigest === "string" ? ledgerEvent.prefixDigest : "";
  const prefixDelimiter = ledgerEvent.prefixDelimiter;
  const lifecycle = Array.isArray(evidence.processLifecycle) ? evidence.processLifecycle : null;
  const experiment = isUnknownRecord(evidence.experiment) ? evidence.experiment : null;
  if (
    !transactionId ||
    eventTransactionId !== transactionId ||
    !eventDigest ||
    !Number.isSafeInteger(prefixByteLength) ||
    prefixByteLength < 0 ||
    !/^[a-f0-9]{64}$/i.test(prefixDigest) ||
    (prefixDelimiter !== "" && prefixDelimiter !== "\n") ||
    !lifecycle ||
    lifecycle.some((entry) => !isUnknownRecord(entry)) ||
    !experiment
  ) {
    return {
      kind: "unrelated",
      transactionId,
      reason: "The pending receipt cannot prove an exact ledger suffix relation.",
    };
  }
  const current = Buffer.from(ledgerBytes || new Uint8Array());
  if (current.byteLength < prefixByteLength) {
    return {
      kind: "unrelated",
      transactionId,
      reason: "The ledger changed before the pending transaction prefix.",
    };
  }
  const prefix = current.subarray(0, prefixByteLength);
  if (sha256Bytes(prefix) !== prefixDigest) {
    return {
      kind: "unrelated",
      transactionId,
      reason: "The ledger prefix changed while the log transaction was pending.",
    };
  }
  const requiredDelimiter =
    prefix.byteLength > 0 && prefix[prefix.byteLength - 1] !== 0x0a ? "\n" : "";
  if (prefixDelimiter !== requiredDelimiter) {
    return {
      kind: "unrelated",
      transactionId,
      reason: "The receipt-owned ledger row delimiter does not match the prepared prefix.",
    };
  }
  const baseRows = [...lifecycle, experiment];
  const expectedRows = baseRows.map((row, entryIndex) => ({
    ...row,
    logTransaction: {
      id: transactionId,
      eventDigest,
      entryIndex,
      entryCount: baseRows.length,
    },
  }));
  const expected = Buffer.from(
    `${prefixDelimiter}${expectedRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  const suffix = current.subarray(prefixByteLength);
  if (suffix.equals(expected)) return { kind: "complete", transactionId, prefixByteLength };
  if (suffix.byteLength === 0) return { kind: "absent", transactionId, prefixByteLength };
  if (
    suffix.byteLength < expected.byteLength &&
    expected.subarray(0, suffix.byteLength).equals(suffix)
  ) {
    return { kind: "receipt-owned-torn-suffix", transactionId, prefixByteLength };
  }
  return {
    kind: "unrelated",
    transactionId,
    reason:
      "The ledger suffix is not an unambiguous partial write owned by the pending transaction.",
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
    ledgerRelation: {
      kind: "unrelated",
      transactionId: "",
      reason: "The pending receipt is not valid JSON transaction evidence.",
    },
    receipt,
  };
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
