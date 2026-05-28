import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { DEMO_ENTRIES, DEMO_META } from "../demoData";
import { defaultConfig, normalizeEntries } from "../model";
import { getUrlValue, setUrlValue } from "./useUrlState";
import type {
  DashboardEntry,
  DashboardMeta,
  DashboardViewModel,
  NormalizedEntries,
  SessionSegment,
} from "../types";

interface UseDashboardSessionArgs {
  initialEntries?: DashboardEntry[];
  initialMeta?: DashboardMeta;
}

interface DashboardSessionState {
  activeSegment: number;
  entries: DashboardEntry[];
  meta: DashboardMeta;
  normalized: NormalizedEntries;
  session: SessionSegment;
  setActiveSegment: (segment: number) => void;
  setEntries: Dispatch<SetStateAction<DashboardEntry[]>>;
  setMeta: Dispatch<SetStateAction<DashboardMeta>>;
  setViewModel: Dispatch<SetStateAction<DashboardViewModel>>;
  viewModel: DashboardViewModel;
}

export function useDashboardSession({
  initialEntries,
  initialMeta,
}: UseDashboardSessionArgs): DashboardSessionState {
  const [entries, setEntries] = useState<DashboardEntry[]>(() => initialEntriesFor(initialEntries));
  const [meta, setMeta] = useState<DashboardMeta>(() => initialMeta || DEMO_META);
  const [viewModel, setViewModel] = useState<DashboardViewModel>(
    () => initialMeta?.viewModel || {},
  );
  const normalized = useMemo(() => normalizeEntries(entries), [entries]);
  const urlSegment = useMemo(() => readSegmentParam(), []);
  const [activeSegment, setActiveSegment] = useState(() =>
    urlSegment == null ? normalized.latestSegment : urlSegment,
  );
  const [manualSegment, setManualSegment] = useState(urlSegment != null);
  const selectActiveSegment = useCallback((segment: number) => {
    setManualSegment(true);
    setActiveSegment(segment);
    setUrlValue("segment", String(segment));
  }, []);

  useEffect(() => {
    const exists = normalized.segments.some((segment) => segment.segment === activeSegment);
    if (!manualSegment || !exists) {
      setActiveSegment(normalized.latestSegment);
      if (!exists) setManualSegment(false);
    }
  }, [activeSegment, manualSegment, normalized.latestSegment, normalized.segments]);

  const session = useMemo(() => sessionFor(normalized, activeSegment), [activeSegment, normalized]);

  return {
    activeSegment,
    entries,
    meta,
    normalized,
    session,
    setActiveSegment: selectActiveSegment,
    setEntries,
    setMeta,
    setViewModel,
    viewModel,
  };
}

function readSegmentParam(): number | null {
  const raw = getUrlValue("segment");
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function initialEntriesFor(initialEntries?: DashboardEntry[]) {
  const sourceEntries = Array.isArray(initialEntries) ? initialEntries : [];
  return sourceEntries.length ? sourceEntries : DEMO_ENTRIES;
}

function sessionFor(normalized: NormalizedEntries, activeSegment: number): SessionSegment {
  const active =
    normalized.segments.find((segment) => segment.segment === activeSegment) ||
    normalized.segments.find((segment) => segment.segment === normalized.latestSegment) ||
    normalized.segments[0];
  return active || { segment: 0, config: defaultConfig(), runs: [] };
}
