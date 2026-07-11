import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { validateLiveDashboardPayload } from "../bootstrap";
import { formatDisplayTime } from "../model";
import type { DashboardEntry, DashboardMeta, DashboardMode, DashboardViewModel } from "../types";

type LiveStatus = { title: string; detail: string };
type LiveDashboardSnapshot = {
  entries: DashboardEntry[];
  generatedAt: string;
  viewModel: DashboardViewModel;
};

const LIVE_VIEW_MODEL_RETRY_LIMIT = 1;

type DashboardErrorPayload = {
  code?: unknown;
  detail?: unknown;
  error?: unknown;
  message?: unknown;
  retryable?: unknown;
};

class DashboardResponseError extends Error {
  readonly code: string | null;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    message: string,
    {
      code,
      retryable,
      status,
    }: {
      code: string | null;
      retryable: boolean;
      status: number;
    },
  ) {
    super(message);
    this.name = "DashboardResponseError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

interface UseLiveDashboardArgs {
  meta: DashboardMeta;
  mode: DashboardMode;
  setEntries: Dispatch<SetStateAction<DashboardEntry[]>>;
  setMeta: Dispatch<SetStateAction<DashboardMeta>>;
  setViewModel: Dispatch<SetStateAction<DashboardViewModel>>;
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
  const [lastGoodAt, setLastGoodAt] = useState<string | null>(() => meta.generatedAt || null);
  const lastGoodAtRef = useRef<string | null>(meta.generatedAt || null);
  const activeAbortController = useRef<AbortController | null>(null);
  const lastAutoAnnouncementAt = useRef(0);

  const refreshLiveData = useCallback(
    async (source: "auto" | "manual" = "manual") => {
      if (typeof fetch !== "function") {
        setRefreshState("error");
        setLiveStatus(refreshUnavailableStatus());
        return;
      }
      if (activeAbortController.current) return;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      activeAbortController.current = controller;
      let settledState: "idle" | "error" = "idle";
      try {
        setRefreshState("refreshing");
        if (source === "manual") {
          setLiveStatus(refreshingStatus(lastGoodAtRef.current));
        }
        const snapshot = await fetchLiveDashboardSnapshot(controller?.signal ?? null);
        setEntries(snapshot.entries);
        setViewModel(snapshot.viewModel);
        lastGoodAtRef.current = snapshot.generatedAt;
        setLastGoodAt(snapshot.generatedAt);
        setMeta((current) => ({
          ...current,
          viewModel: snapshot.viewModel,
          generatedAt: snapshot.generatedAt,
          ledgerBounds: snapshot.viewModel.ledgerBounds || current.ledgerBounds,
        }));
        if (source === "manual" || shouldAnnounceAutoRefresh(lastAutoAnnouncementAt.current)) {
          if (source === "auto") lastAutoAnnouncementAt.current = Date.now();
          setLiveStatus(refreshSuccessStatus(refreshDone, snapshot.generatedAt));
        }
      } catch (error) {
        if (!isAbortError(error)) {
          const message = error instanceof Error ? error.message : String(error);
          setLiveStatus(refreshFailureStatus(liveRefresh, message, lastGoodAtRef.current));
          settledState = "error";
        }
      } finally {
        if (activeAbortController.current === controller) {
          activeAbortController.current = null;
        }
        setRefreshState(settledState);
      }
    },
    [liveRefresh, refreshDone, setEntries, setMeta, setViewModel],
  );

  useEffect(() => {
    if (!liveEnabled || !liveRefresh) return undefined;
    refreshLiveData("auto");
    const refreshMs = Math.max(1, Number(meta.refreshMs || 5000));
    const timer = setInterval(() => refreshLiveData("auto"), refreshMs);
    return () => {
      clearInterval(timer);
      activeAbortController.current?.abort();
    };
  }, [liveEnabled, meta.refreshMs, liveRefresh, refreshLiveData]);

  return {
    lastGoodAt,
    liveEnabled,
    liveStatus,
    refreshState,
    refreshLiveData,
    setLiveEnabled,
  };
}

function refreshingStatus(lastGoodAt: string | null): LiveStatus {
  return {
    title: "Refreshing readout…",
    detail: lastGoodAt
      ? `Current evidence stays visible. Last validated ${formatDisplayTime(lastGoodAt)}.`
      : "Current evidence stays visible until the refresh is validated.",
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
  for (let attempt = 0; attempt <= LIVE_VIEW_MODEL_RETRY_LIMIT; attempt += 1) {
    const viewModelResponse = await fetch("view-model.json", noStoreRequest(signal));
    const failure = await responseFailure(viewModelResponse, "view-model.json");
    if (failure) {
      if (failure.retryable && attempt < LIVE_VIEW_MODEL_RETRY_LIMIT && !signal?.aborted) {
        continue;
      }
      throw failure;
    }

    let rawPayload: unknown;
    try {
      rawPayload = await viewModelResponse.json();
    } catch {
      throw new Error("Live readout payload is not valid JSON.");
    }
    const payload = validateLiveDashboardPayload(rawPayload);
    if (!payload.ok) throw new Error(payload.reason);
    return {
      entries: payload.entries,
      generatedAt: new Date().toISOString(),
      viewModel: payload.viewModel,
    };
  }

  throw new Error("view-model.json could not be refreshed");
}

function noStoreRequest(signal: AbortSignal | null): RequestInit {
  return signal ? { cache: "no-store", signal } : { cache: "no-store" };
}

function refreshSuccessStatus(refreshDone: string, generatedAt: string): LiveStatus {
  return {
    title: refreshDone,
    detail: formatDisplayTime(generatedAt),
  };
}

function refreshFailureStatus(
  liveRefresh: boolean,
  message: string,
  lastGoodAt: string | null,
): LiveStatus {
  const retained = lastGoodAt
    ? `Showing the last known valid readout, validated ${formatDisplayTime(lastGoodAt)}.`
    : "Showing the initial validated readout as the last known valid readout.";
  return {
    title: liveRefresh ? "Live refresh failed" : "Snapshot refresh failed",
    detail: `${retained} ${message} Restart the Autoresearch CLI: serve --cwd <project>. Then reload.`,
  };
}

function refreshUnavailableStatus(): LiveStatus {
  return {
    title: "Snapshot refresh unavailable",
    detail: "Showing the last known valid readout. This browser context does not expose fetch.",
  };
}

async function responseFailure(
  response: Response,
  label: string,
): Promise<DashboardResponseError | null> {
  if (response.ok) return null;
  const payload = await readErrorPayload(response);
  const status = response.status ? ` ${response.status}` : "";
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  const detail = `${status}${statusText}`.trim();
  const fallbackMessage = detail
    ? `${label} returned HTTP ${detail}`
    : `${label} returned a non-OK response`;
  const payloadMessage =
    stringValue(payload?.message) ?? stringValue(payload?.detail) ?? stringValue(payload?.error);
  return new DashboardResponseError(payloadMessage || fallbackMessage, {
    code: stringValue(payload?.code),
    retryable: payload?.retryable === true,
    status: response.status || 0,
  });
}

async function readErrorPayload(response: Response): Promise<DashboardErrorPayload | null> {
  const maybeJson = response as Response & { json?: () => Promise<unknown> };
  if (typeof maybeJson.json !== "function") return null;
  try {
    const payload = await maybeJson.json();
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as DashboardErrorPayload)
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    String((error as { name?: unknown }).name) === "AbortError"
  );
}

function shouldAnnounceAutoRefresh(lastAnnouncementAt: number): boolean {
  return Date.now() - lastAnnouncementAt > 30000;
}
