import fsp from "node:fs/promises";

import { redactEvidenceText } from "../evidence-redaction.js";

type UnlinkFn = (filePath: string) => Promise<void>;
type CleanupWarningContext = { workDir?: string };
export type CleanupWarning = { code: string; message: string };

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

export async function clearFilesWithWarnings(
  filePaths: Iterable<string>,
  unlink: UnlinkFn = fsp.unlink,
  context: CleanupWarningContext = {},
): Promise<CleanupWarning[]> {
  const warnings: CleanupWarning[] = [];
  for (const filePath of new Set(filePaths)) {
    try {
      await unlink(filePath);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      warnings.push({
        code: "last_run_cleanup_failed",
        message: `Last-run cleanup failed: ${redactEvidenceText(
          error instanceof Error ? error.message : String(error),
          context,
        )}.`,
      });
    }
  }
  return warnings;
}
