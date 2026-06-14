import fsp from "node:fs/promises";

type UnlinkFn = (filePath: string) => Promise<void>;

export function pendingReceiptCleanupWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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
): Promise<string | null> {
  try {
    await clearPendingLogTransaction(receiptPath, unlink);
    return null;
  } catch (error) {
    return pendingReceiptCleanupWarning(error);
  }
}
