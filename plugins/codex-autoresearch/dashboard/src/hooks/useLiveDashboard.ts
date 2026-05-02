import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { actionLabel, formatDisplayTime, parseJsonl } from "../model";
import type {
  ActionReceipt,
  ActionState,
  DashboardEntry,
  DashboardMeta,
  DashboardMode,
  DashboardViewModel,
} from "../types";

type LiveStatus = { title: string; detail: string };
type ActionPayload = {
  ok?: boolean;
  error?: string;
  stderr?: string;
  receipt?: ActionReceipt;
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
  viewModel,
}: UseLiveDashboardArgs) {
  const [liveStatus, setLiveStatus] = useState<LiveStatus>(() => liveStatusFor(mode, meta));
  const [liveEnabled, setLiveEnabled] = useState(mode.liveRefresh);
  const [refreshState, setRefreshState] = useState<"idle" | "refreshing" | "error">("idle");
  const [actionsById, setActionsById] = useState<Record<string, ActionState>>({});
  const [lastReceipt, setLastReceipt] = useState<ActionReceipt | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const refreshLiveData = useCallback(async () => {
    if (typeof fetch !== "function") {
      setLiveStatus(refreshUnavailableStatus());
      return;
    }
    try {
      setRefreshState("refreshing");
      const [jsonlResponse, viewModelResponse] = await Promise.all([
        fetch("autoresearch.jsonl", { cache: "no-store" }),
        fetch("view-model.json", { cache: "no-store" }),
      ]);
      if (jsonlResponse.ok) {
        const text = await jsonlResponse.text();
        setEntries(parseJsonl(text));
      }
      if (viewModelResponse.ok) {
        const payload = (await viewModelResponse.json()) as DashboardViewModel;
        setViewModel(payload || {});
        setMeta((current) => ({
          ...current,
          viewModel: payload || {},
          generatedAt: new Date().toISOString(),
        }));
      }
      setLiveStatus({
        title: mode.refreshDone,
        detail: formatDisplayTime(new Date().toISOString()),
      });
      setRefreshState("idle");
      setRefreshGeneration((value) => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLiveStatus({
        title: mode.liveRefresh ? "Live refresh failed" : "Snapshot refresh failed",
        detail: message,
      });
      setRefreshState("error");
      setLastError(message);
    }
  }, [mode.liveRefresh, mode.refreshDone, setEntries, setMeta, setViewModel]);

  const runLiveAction = useCallback(
    async (
      action: string,
      bodyOverride: Record<string, unknown> | null = null,
    ): Promise<{
      ok: boolean;
      receipt: ActionReceipt | null;
      payload?: ActionPayload;
      error?: unknown;
    } | void> => {
      if (!action || !mode.liveActions || typeof fetch !== "function") {
        setLiveStatus({
          title: "Live action unavailable",
          detail: "Use CLI for actions; the served dashboard is a live readout.",
        });
        return;
      }
      try {
        setActionsById((current) => ({ ...current, [action]: { pending: true, error: "" } }));
        setLiveStatus({ title: `${actionLabel(action)} action`, detail: "Running..." });
        const body = bodyOverride || actionBodyFor(action, viewModel?.qualityGap?.slug);
        const response = await fetch(`actions/${action}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Autoresearch-Action-Nonce": meta.actionNonce || "",
          },
          body: JSON.stringify(body),
        });
        const payload = (await response
          .json()
          .catch(() => ({ ok: false, error: `HTTP ${response.status}` }))) as ActionPayload;
        const receipt = receiptFromPayload(action, payload);
        setLastReceipt(receipt);
        setLiveStatus({
          title: `${actionLabel(action)} action`,
          detail: payload.ok
            ? receipt.nextStep || "Completed"
            : receipt.stderrSummary || payload.error || `HTTP ${response.status}`,
        });
        setActionsById((current) => ({ ...current, [action]: { pending: false, receipt } }));
        if (payload.ok && action !== "export") await refreshLiveData();
        return { ok: Boolean(payload.ok), receipt, payload };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLiveStatus({ title: "Live action unavailable", detail: message });
        setLastError(message);
        setActionsById((current) => ({ ...current, [action]: { pending: false, error: message } }));
        return { ok: false, receipt: null, error };
      }
    },
    [meta.actionNonce, mode.liveActions, refreshLiveData, viewModel?.qualityGap?.slug],
  );

  useEffect(() => {
    if (!liveEnabled || !mode.liveRefresh) return undefined;
    refreshLiveData();
    const refreshMs = Math.max(1, Number(meta.refreshMs || 5000));
    const timer = setInterval(refreshLiveData, refreshMs);
    return () => clearInterval(timer);
  }, [liveEnabled, meta.refreshMs, mode.liveRefresh, refreshLiveData]);

  return {
    liveEnabled,
    liveStatus,
    refreshState,
    actionsById,
    lastReceipt,
    lastError,
    refreshGeneration,
    refreshLiveData,
    runLiveAction,
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

function refreshUnavailableStatus(): LiveStatus {
  return {
    title: "Snapshot refresh unavailable",
    detail: "This browser context does not expose fetch.",
  };
}

function actionBodyFor(action: string, researchSlug: string | undefined): Record<string, unknown> {
  if (action === "gap-candidates") {
    return { researchSlug: researchSlug || "research" };
  }
  return {};
}

function receiptFromPayload(action: string, payload: ActionPayload): ActionReceipt {
  return (
    payload.receipt ||
    ({
      ok: Boolean(payload.ok),
      action,
      status: payload.ok ? "completed" : "failed",
      stderrSummary: payload.stderr || payload.error || "Failed",
    } satisfies ActionReceipt)
  );
}
