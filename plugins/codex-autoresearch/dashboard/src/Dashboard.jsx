import { useCallback, useEffect, useMemo, useState } from "react";
import { DEMO_ENTRIES, DEMO_META } from "./demoData.js";
import {
  actionLabel,
  buildReadout,
  dashboardMode,
  defaultConfig,
  formatDisplayTime,
  normalizeEntries,
  parseJsonl,
} from "./model.js";
import { Header } from "./components/Header.jsx";
import { DecisionRail } from "./components/DecisionRail.jsx";
import { ScoreStrip } from "./components/ScoreStrip.jsx";
import { TrendPanel } from "./components/TrendPanel.jsx";
import { MissionPanel } from "./components/MissionPanel.jsx";
import { CodexBrief, LiveActions, QualityGapPanel, StrategyMemory } from "./components/ContextPanels.jsx";
import { Ledger } from "./components/Ledger.jsx";

export function Dashboard({ initialEntries, initialMeta }) {
  const [entries, setEntries] = useState(() => initialEntries.length ? initialEntries : DEMO_ENTRIES);
  const [meta, setMeta] = useState(() => initialMeta || DEMO_META);
  const [viewModel, setViewModel] = useState(() => initialMeta?.viewModel || {});
  const normalized = useMemo(() => normalizeEntries(entries), [entries]);
  const [activeSegment, setActiveSegment] = useState(() => normalized.latestSegment);
  const active = normalized.segments.find((segment) => segment.segment === activeSegment)
    || normalized.segments.find((segment) => segment.segment === normalized.latestSegment)
    || normalized.segments[0];
  const session = active || { segment: 0, config: defaultConfig(), runs: [] };
  const mode = dashboardMode(meta);
  const readout = useMemo(() => buildReadout(session, viewModel), [session, viewModel]);
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
  }, [mode.liveActions, mode.refreshDone]);

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

  return (
    <div className="runboard-shell">
      <aside className="side-rail" aria-label="Dashboard sections">
        <div className="rail-mark">AR</div>
        <nav className="side-nav">
          <a href="#decision-rail"><span className="nav-icon">1</span><span>Move</span></a>
          <a href="#trend-panel"><span className="nav-icon">2</span><span>Metric</span></a>
          <a href="#mission-panel"><span className="nav-icon">3</span><span>Flow</span></a>
          <a href="#ledger"><span className="nav-icon">4</span><span>Ledger</span></a>
        </nav>
        <div className="side-status">
          <span><span className="live-dot" />{mode.liveActions ? "Live" : "Static"}</span>
          <strong id="side-mode-detail">{mode.liveActions ? "Local actions" : "Snapshot"}</strong>
        </div>
      </aside>

      <main className="wrap">
        <Header
          session={session}
          normalized={normalized}
          activeSegment={activeSegment}
          setActiveSegment={setActiveSegment}
          mode={mode}
          meta={meta}
          liveStatus={liveStatus}
          liveEnabled={liveEnabled}
          setLiveEnabled={setLiveEnabled}
          refreshLiveData={refreshLiveData}
        />

        <section className="metric-layout" aria-label="Metric evidence">
          <TrendPanel session={session} readout={readout} />
          <ScoreStrip session={session} readout={readout} />
        </section>

        <section className="decision-layout" aria-label="Current operator decision">
          <DecisionRail readout={readout} viewModel={viewModel} mode={mode} />
        </section>

        <section className="workspace-grid">
          <MissionPanel viewModel={viewModel} mode={mode} runLiveAction={runLiveAction} />
          <CodexBrief session={session} viewModel={viewModel} />
          <StrategyMemory viewModel={viewModel} />
          <QualityGapPanel viewModel={viewModel} />
          <LiveActions mode={mode} runLiveAction={runLiveAction} />
        </section>

        <Ledger session={session} readout={readout} />
      </main>
    </div>
  );
}
