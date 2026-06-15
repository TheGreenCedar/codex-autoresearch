import fsp from "node:fs/promises";

import { redactEvidenceText } from "../evidence-redaction.js";

type UnlinkFn = (filePath: string) => Promise<void>;
type CleanupWarningContext = { workDir?: string };

export function pendingReceiptCleanupWarning(
  error: unknown,
  context: CleanupWarningContext = {},
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactEvidenceText(rawMessage, context);
  return `Pending receipt cleanup failed: ${message}.`;
}

export async function clearPendingLogTransaction(
  receiptPath: string | null,
  unlink: UnlinkFn = fsp.unlink,
): Promise<void> {
  if (!receiptPath) return;
  try {
    await unlink(receiptPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function clearPendingLogTransactionWithWarning(
  receiptPath: string | null,
  unlink: UnlinkFn = fsp.unlink,
  context: CleanupWarningContext = {},
): Promise<string | null> {
  try {
    await clearPendingLogTransaction(receiptPath, unlink);
    return null;
  } catch (error) {
    return pendingReceiptCleanupWarning(error, context);
  }
}
