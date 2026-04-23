import { useCallback, useEffect, useState } from "react";
import { actionLabel, formatDisplayTime, parseJsonl } from "../model.js";

export function useLiveDashboard({
  meta,
  mode,
  setEntries,
  setMeta,
  setViewModel,
  viewModel,
}) {
  const [liveStatus, setLiveStatus] = useState(() => ({
    title: mode.title,
    detail: `${mode.detail}${meta.generatedAt ? ` Generated ${formatDisplayTime(meta.generatedAt)}.` : ""}`,
  }));
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [refreshState, setRefreshState] = useState("idle");
  const [actionsById, setActionsById] = useState({});
  const [lastReceipt, setLastReceipt] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const refreshLiveData = useCallback(async () => {
    if (typeof fetch !== "function") {
      setLiveStatus({ title: "Snapshot refresh unavailable", detail: "This browser context does not expose fetch." });
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
        const payload = await viewModelResponse.json();
        setViewModel(payload || {});
        setMeta((current) => ({ ...current, viewModel: payload || {}, generatedAt: new Date().toISOString() }));
      }
      setLiveStatus({ title: mode.refreshDone, detail: formatDisplayTime(new Date().toISOString()) });
      setRefreshState("idle");
      setRefreshGeneration((value) => value + 1);
    } catch (error) {
      setLiveStatus({ title: mode.liveActions ? "Live refresh failed" : "Snapshot refresh failed", detail: error.message || String(error) });
      setRefreshState("error");
      setLastError(error.message || String(error));
    }
  }, [mode.liveActions, mode.refreshDone, setEntries, setMeta, setViewModel]);

  const runLiveAction = useCallback(async (action, bodyOverride = null) => {
    if (!action || !mode.liveActions || typeof fetch !== "function") {
      setLiveStatus({ title: "Live action unavailable", detail: "Open the dashboard through autoresearch serve to execute guarded actions." });
      return;
    }
    try {
      setActionsById((current) => ({ ...current, [action]: { pending: true, error: "" } }));
      setLiveStatus({ title: `${actionLabel(action)} action`, detail: "Running..." });
      const body = bodyOverride || (action === "gap-candidates" ? { researchSlug: viewModel?.qualityGap?.slug || "research" } : {});
      const response = await fetch(`actions/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Autoresearch-Action-Nonce": meta.actionNonce || "",
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
      const receipt = payload.receipt || {
        ok: Boolean(payload.ok),
        action,
        status: payload.ok ? "completed" : "failed",
        stderrSummary: payload.stderr || payload.error || "Failed",
      };
      setLastReceipt(receipt);
      setLiveStatus({
        title: `${actionLabel(action)} action`,
        detail: payload.ok ? (receipt.nextStep || "Completed") : (receipt.stderrSummary || payload.error || `HTTP ${response.status}`),
      });
      setActionsById((current) => ({ ...current, [action]: { pending: false, receipt } }));
      if (payload.ok && action !== "export") await refreshLiveData();
      return { ok: Boolean(payload.ok), receipt, payload };
    } catch (error) {
      setLiveStatus({ title: "Live action unavailable", detail: error.message || String(error) });
      setLastError(error.message || String(error));
      setActionsById((current) => ({ ...current, [action]: { pending: false, error: error.message || String(error) } }));
      return { ok: false, receipt: null, error };
    }
  }, [meta.actionNonce, mode.liveActions, refreshLiveData, viewModel?.qualityGap?.slug]);

  useEffect(() => {
    if (!liveEnabled || !mode.liveActions) return undefined;
    refreshLiveData();
    const refreshMs = Math.max(1, Number(meta.refreshMs || 5000));
    const timer = setInterval(refreshLiveData, refreshMs);
    return () => clearInterval(timer);
  }, [liveEnabled, meta.refreshMs, mode.liveActions, refreshLiveData]);

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
