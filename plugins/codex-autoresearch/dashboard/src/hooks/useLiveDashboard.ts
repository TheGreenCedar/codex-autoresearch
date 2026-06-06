import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { formatDisplayTime, parseJsonl } from "../model";
import type { DashboardEntry, DashboardMeta, DashboardMode, DashboardViewModel } from "../types";

type LiveStatus = { title: string; detail: string };
type LiveDashboardSnapshot = {
  entries: DashboardEntry[];
  generatedAt: string;
  viewModel: DashboardViewModel;
};

interface UseLiveDashboardArgs {
  meta: DashboardMeta;
  mode: DashboardMode;
  setEntries: Dispatch<SetStateAction<DashboardEntry[]>>;
  setMeta: Dispatch<SetStateAction<DashboardMeta>>;
  setViewModel: Dispatch<SetStateAction<DashboardViewModel>>;
  viewModel: DashboardViewModel;
}

export function useLiveDashboard({
  meta,
  mode,
  setEntries,
  setMeta,
  setViewModel,
}: UseLiveDashboardArgs) {
  const { liveRefresh, refreshDone } = mode;
  const [liveStatus, setLiveStatus] = useState<LiveStatus>(() => liveStatusFor(mode, meta));
  const [liveEnabled, setLiveEnabled] = useState(liveRefresh);
  const [refreshState, setRefreshState] = useState<"idle" | "refreshing" | "error">("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const latestRefreshId = useRef(0);
  const activeAbortController = useRef<AbortController | null>(null);

  const refreshLiveData = useCallback(async () => {
    if (typeof fetch !== "function") {
      setLiveStatus(refreshUnavailableStatus());
      return;
    }
    const refreshId = latestRefreshId.current + 1;
    latestRefreshId.current = refreshId;
    activeAbortController.current?.abort();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    activeAbortController.current = controller;
    const isLatestRefresh = () => refreshId === latestRefreshId.current;
    try {
      setRefreshState("refreshing");
      setLastError(null);
      const snapshot = await fetchLiveDashboardSnapshot(controller?.signal ?? null);
      if (!isLatestRefresh()) return;
      setEntries(snapshot.entries);
      setViewModel(snapshot.viewModel);
      setMeta((current) => ({
        ...current,
        viewModel: snapshot.viewModel,
        generatedAt: snapshot.generatedAt,
      }));
      setLiveStatus(refreshSuccessStatus(refreshDone, snapshot.generatedAt));
      setRefreshState("idle");
      setRefreshGeneration((value) => value + 1);
    } catch (error) {
      if (!isLatestRefresh() || isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      setLiveStatus(refreshFailureStatus(liveRefresh, message));
      setRefreshState("error");
      setLastError(message);
    } finally {
      if (activeAbortController.current === controller) {
        activeAbortController.current = null;
      }
    }
  }, [liveRefresh, refreshDone, setEntries, setMeta, setViewModel]);

  useEffect(() => {
    if (!liveEnabled || !liveRefresh) return undefined;
    refreshLiveData();
    const refreshMs = Math.max(1, Number(meta.refreshMs || 5000));
    const timer = setInterval(refreshLiveData, refreshMs);
    return () => {
      clearInterval(timer);
      activeAbortController.current?.abort();
    };
  }, [liveEnabled, meta.refreshMs, liveRefresh, refreshLiveData]);

  return {
    liveEnabled,
    liveStatus,
    refreshState,
    lastError,
    refreshGeneration,
    refreshLiveData,
    setLiveEnabled,
  };
}

function liveStatusFor(mode: DashboardMode, meta: DashboardMeta): LiveStatus {
  return {
    title: mode.title,
    detail: mode.showcase
      ? mode.detail
      : `${mode.detail}${meta.generatedAt ? ` Generated ${formatDisplayTime(meta.generatedAt)}.` : ""}`,
  };
}

async function fetchLiveDashboardSnapshot(
  signal: AbortSignal | null,
): Promise<LiveDashboardSnapshot> {
  const viewModelResponse = await fetch("view-model.json", noStoreRequest(signal));
  const failure = responseFailure(viewModelResponse, "view-model.json");
  if (failure) throw new Error(failure);

  const payload = (await viewModelResponse.json()) as DashboardViewModel;
  const embeddedEntries = entriesFromViewModel(payload);
  return {
    entries: embeddedEntries ?? (await fetchLegacyLedgerEntries(signal)),
    generatedAt: new Date().toISOString(),
    viewModel: payload || {},
  };
}

async function fetchLegacyLedgerEntries(signal: AbortSignal | null): Promise<DashboardEntry[]> {
  const jsonlResponse = await fetch("autoresearch.jsonl", noStoreRequest(signal));
  const failure = responseFailure(jsonlResponse, "autoresearch.jsonl");
  if (failure) throw new Error(failure);
  return parseJsonl(await jsonlResponse.text());
}

function noStoreRequest(signal: AbortSignal | null): RequestInit {
  return signal ? { cache: "no-store", signal } : { cache: "no-store" };
}

function entriesFromViewModel(
  payload: DashboardViewModel | null | undefined,
): DashboardEntry[] | null {
  if (!payload) return null;
  for (const key of ["ledgerEntries", "entries", "dashboardEntries"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isDashboardEntry);
  }
  return null;
}

function isDashboardEntry(value: unknown): value is DashboardEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refreshSuccessStatus(refreshDone: string, generatedAt: string): LiveStatus {
  return {
    title: refreshDone,
    detail: formatDisplayTime(generatedAt),
  };
}

function refreshFailureStatus(liveRefresh: boolean, message: string): LiveStatus {
  return {
    title: liveRefresh ? "Live refresh failed" : "Snapshot refresh failed",
    detail: message,
  };
}

function refreshUnavailableStatus(): LiveStatus {
  return {
    title: "Snapshot refresh unavailable",
    detail: "This browser context does not expose fetch.",
  };
}

function responseFailure(response: Response, label: string): string | null {
  if (response.ok) return null;
  const status = response.status ? ` ${response.status}` : "";
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  const detail = `${status}${statusText}`.trim();
  return detail ? `${label} returned HTTP ${detail}` : `${label} returned a non-OK response`;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    String((error as { name?: unknown }).name) === "AbortError"
  );
}
