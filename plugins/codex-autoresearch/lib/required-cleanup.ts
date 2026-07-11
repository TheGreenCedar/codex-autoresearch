function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runWithRequiredCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
  cleanupLabel: string,
): Promise<T> {
  let value!: T;
  let actionFailed = false;
  let primaryError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    value = await action();
  } catch (error) {
    actionFailed = true;
    primaryError = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }
  if (cleanupFailed) {
    if (!actionFailed) throw cleanupError;
    throw new AggregateError(
      [primaryError, cleanupError],
      `${errorMessage(primaryError)}\n${cleanupLabel}: ${errorMessage(cleanupError)}`,
    );
  }
  if (actionFailed) throw primaryError;
  return value;
}
