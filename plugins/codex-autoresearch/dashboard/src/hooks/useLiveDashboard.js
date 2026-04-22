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

  const refreshLiveData = useCallback(async () => {
    if (typeof fetch !== "function") {
      setLiveStatus({ title: "Snapshot refresh unavailable", detail: "This browser context does not expose fetch." });
      return;
    }
    try {
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
    } catch (error) {
      setLiveStatus({ title: mode.liveActions ? "Live refresh failed" : "Snapshot refresh failed", detail: error.message || String(error) });
    }
  }, [mode.liveActions, mode.refreshDone, setEntries, setMeta, setViewModel]);

  const runLiveAction = useCallback(async (action, bodyOverride = null) => {
    if (!action || !mode.liveActions || typeof fetch !== "function") {
      setLiveStatus({ title: "Live action unavailable", detail: "Open the dashboard through autoresearch serve to execute guarded actions." });
      return;
    }
    try {
      setLiveStatus({ title: `${actionLabel(action)} action`, detail: "Running..." });
      const body = bodyOverride || (action === "gap-candidates" ? { researchSlug: viewModel?.qualityGap?.slug || "research" } : {});
      const response = await fetch(`actions/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      setLiveStatus({
        title: `${actionLabel(action)} action`,
        detail: payload.ok ? "Completed" : (payload.stderr || payload.error || "Failed"),
      });
      if (payload.ok && action !== "export") await refreshLiveData();
    } catch (error) {
      setLiveStatus({ title: "Live action unavailable", detail: error.message || String(error) });
    }
  }, [mode.liveActions, refreshLiveData, viewModel?.qualityGap?.slug]);

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
    refreshLiveData,
    runLiveAction,
    setLiveEnabled,
  };
}
