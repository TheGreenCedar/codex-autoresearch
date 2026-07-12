export interface TimelineSampleOptions<T extends object> {
  anchors?: Array<T | null | undefined>;
  key: (item: T) => number;
  maxItems: number;
  selectedKey?: number | null;
  status: (item: T) => string;
}

export function sampleTimeline<T extends object>(
  items: T[],
  { anchors = [], key, maxItems, selectedKey = null, status }: TimelineSampleOptions<T>,
): T[] {
  if (items.length <= maxItems) return items;

  const selected = new Set<number>();
  const add = (item: T | null | undefined) => {
    if (item && selected.size < maxItems) selected.add(key(item));
  };
  const addEvenly = (slots: number) => {
    const remaining = items.filter((item) => !selected.has(key(item)));
    for (let slot = 0; slot < slots; slot += 1) {
      const index = Math.floor(((slot + 0.5) * remaining.length) / slots);
      add(remaining[Math.min(index, remaining.length - 1)]);
    }
  };

  add(items[0]);
  add(items.at(-1));
  for (const anchor of anchors) add(anchor);
  if (selectedKey != null) add(items.find((item) => key(item) === selectedKey));

  for (const failureStatus of ["crash", "checks_failed"]) {
    add(items.findLast((item) => status(item) === failureStatus));
  }

  addEvenly(Math.ceil((maxItems - selected.size) / 2));

  for (let index = items.length - 1; index > 0 && selected.size < maxItems; index -= 1) {
    if (status(items[index]) !== status(items[index - 1])) add(items[index]);
  }

  addEvenly(maxItems - selected.size);
  return items.filter((item) => selected.has(key(item)));
}
