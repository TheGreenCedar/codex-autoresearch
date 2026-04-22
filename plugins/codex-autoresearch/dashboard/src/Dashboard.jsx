import { useMemo } from "react";
import { buildReadout, dashboardMode } from "./model.js";
import { useDashboardSession } from "./hooks/useDashboardSession.js";
import { useLiveDashboard } from "./hooks/useLiveDashboard.js";
import { SideRail } from "./components/SideRail.jsx";
import { Header } from "./components/Header.jsx";
import { DecisionRail } from "./components/DecisionRail.jsx";
import { ScoreStrip } from "./components/ScoreStrip.jsx";
import { TrendPanel } from "./components/TrendPanel.jsx";
import { MissionPanel } from "./components/MissionPanel.jsx";
import { CodexBrief, LiveActions, QualityGapPanel, StrategyMemory } from "./components/ContextPanels.jsx";
import { Ledger } from "./components/Ledger.jsx";

export function Dashboard({ initialEntries, initialMeta }) {
  const {
    activeSegment,
    meta,
    normalized,
    session,
    setActiveSegment,
    setEntries,
    setMeta,
    setViewModel,
    viewModel,
  } = useDashboardSession({ initialEntries, initialMeta });
  const mode = dashboardMode(meta);
  const readout = useMemo(() => buildReadout(session, viewModel), [session, viewModel]);
  const {
    liveEnabled,
    liveStatus,
    refreshLiveData,
    runLiveAction,
    setLiveEnabled,
  } = useLiveDashboard({
    meta,
    mode,
    setEntries,
    setMeta,
    setViewModel,
    viewModel,
  });

  return (
    <div className="runboard-shell">
      <SideRail liveActions={mode.liveActions} />

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
