type ProgressSnapshot = object;
type GeneratedSnapshot<Snapshot extends ProgressSnapshot> = Snapshot & { generation: number };

export function createCoalescingProgressWriter<Snapshot extends ProgressSnapshot>({
  initialGeneration = 0,
  minWriteIntervalMs = 50,
  write,
}: {
  initialGeneration?: number;
  minWriteIntervalMs?: number;
  write: (snapshot: GeneratedSnapshot<Snapshot>) => Promise<void>;
}) {
  let generation = safeGeneration(initialGeneration);
  let pending: GeneratedSnapshot<Snapshot> | null = null;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWriteStartedAt = 0;
  let failure: unknown = null;
  let closed = false;

  const startWrite = () => {
    if (active || !pending || failure) return;
    const snapshot = pending;
    pending = null;
    lastWriteStartedAt = Date.now();
    active = Promise.resolve()
      .then(() => write(snapshot))
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        active = null;
        if (pending && !closed && !failure) schedule();
      });
  };

  const schedule = () => {
    if (active || timer || !pending || failure) return;
    const delay = Math.max(0, minWriteIntervalMs - (Date.now() - lastWriteStartedAt));
    if (delay === 0) return startWrite();
    timer = setTimeout(() => {
      timer = null;
      startWrite();
    }, delay);
  };

  const flush = async () => {
    for (;;) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (failure) throw failure;
      if (!active && pending) startWrite();
      const current = active;
      if (!current) return;
      await current;
    }
  };

  return {
    queue(snapshot: Snapshot): GeneratedSnapshot<Snapshot> {
      if (closed) throw new Error("Active progress writer is closed.");
      const generated = { ...snapshot, generation: ++generation };
      pending = generated;
      schedule();
      return generated;
    },
    flush,
    async close() {
      closed = true;
      await flush();
    },
  };
}

function safeGeneration(value: unknown): number {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}
