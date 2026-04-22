import { useMemo, useState } from "react";
import { DEMO_ENTRIES, DEMO_META } from "../demoData.js";
import { defaultConfig, normalizeEntries } from "../model.js";

export function useDashboardSession({ initialEntries, initialMeta }) {
  const [entries, setEntries] = useState(() => {
    const sourceEntries = Array.isArray(initialEntries) ? initialEntries : [];
    return sourceEntries.length ? sourceEntries : DEMO_ENTRIES;
  });
  const [meta, setMeta] = useState(() => initialMeta || DEMO_META);
  const [viewModel, setViewModel] = useState(() => initialMeta?.viewModel || {});
  const normalized = useMemo(() => normalizeEntries(entries), [entries]);
  const [activeSegment, setActiveSegment] = useState(() => normalized.latestSegment);
  const session = useMemo(() => {
    const active = normalized.segments.find((segment) => segment.segment === activeSegment)
      || normalized.segments.find((segment) => segment.segment === normalized.latestSegment)
      || normalized.segments[0];
    return active || { segment: 0, config: defaultConfig(), runs: [] };
  }, [activeSegment, normalized]);

  return {
    activeSegment,
    entries,
    meta,
    normalized,
    session,
    setActiveSegment,
    setEntries,
    setMeta,
    setViewModel,
    viewModel,
  };
}
