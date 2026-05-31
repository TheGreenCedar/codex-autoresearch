import { useCallback, useEffect, useState } from "react";
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

  const refreshLiveData = useCallback(async () => {
    if (typeof fetch !== "function") {
      setLiveStatus(refreshUnavailableStatus());
      return;
    }
    try {
      setRefreshState("refreshing");
      const snapshot = await fetchLiveDashboardSnapshot();
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
      const message = error instanceof Error ? error.message : String(error);
      setLiveStatus(refreshFailureStatus(liveRefresh, message));
      setRefreshState("error");
      setLastError(message);
    }
  }, [liveRefresh, refreshDone, setEntries, setMeta, setViewModel]);

  useEffect(() => {
    if (!liveEnabled || !liveRefresh) return undefined;
    refreshLiveData();
    const refreshMs = Math.max(1, Number(meta.refreshMs || 5000));
    const timer = setInterval(refreshLiveData, refreshMs);
    return () => clearInterval(timer);
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

async function fetchLiveDashboardSnapshot(): Promise<LiveDashboardSnapshot> {
  const [jsonlResponse, viewModelResponse] = await Promise.all([
    fetch("autoresearch.jsonl", { cache: "no-store" }),
    fetch("view-model.json", { cache: "no-store" }),
  ]);
  const failures = [
    responseFailure(jsonlResponse, "autoresearch.jsonl"),
    responseFailure(viewModelResponse, "view-model.json"),
  ].filter(Boolean);
  if (failures.length) throw new Error(failures.join("; "));

  const text = await jsonlResponse.text();
  const payload = (await viewModelResponse.json()) as DashboardViewModel;
  return {
    entries: parseJsonl(text),
    generatedAt: new Date().toISOString(),
    viewModel: payload || {},
  };
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
