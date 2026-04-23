import { useMemo } from "react";
import type { DashboardEntry, DashboardMeta } from "./types";
import { buildReadout, dashboardMode } from "./model";
import { useDashboardSession } from "./hooks/useDashboardSession";
import { useLiveDashboard } from "./hooks/useLiveDashboard";
import { SideRail } from "./components/SideRail";
import { Header } from "./components/Header";
import { DecisionRail } from "./components/DecisionRail";
import { ScoreStrip } from "./components/ScoreStrip";
import { TrendPanel } from "./components/TrendPanel";
import { MissionPanel } from "./components/MissionPanel";
import {
  CodexBrief,
  FinalizationChecklist,
  LiveActions,
  QualityGapPanel,
  ResearchTruthMeter,
  StrategyMemory,
  TrustStrip,
} from "./components/ContextPanels";
import { Ledger } from "./components/Ledger";
import { ActionReceiptPanel } from "./components/ActionReceiptPanel";

interface DashboardProps {
  initialEntries?: DashboardEntry[];
  initialMeta?: DashboardMeta;
}

export function Dashboard({ initialEntries, initialMeta }: DashboardProps) {
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
    actionsById,
    lastReceipt,
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
      <nav className="skip-links" aria-label="Skip links">
        <a href="#decision-rail">Current decision</a>
        <a href="#mission-panel">Mission control</a>
        <a href="#log-decision-panel">Log form</a>
        <a href="#action-receipt">Receipt</a>
        <a href="#trend-panel">Run chart</a>
        <a href="#ledger">Ledger</a>
      </nav>
      <SideRail liveActions={mode.liveActions} showcase={mode.showcase} />

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
          readout={readout}
        />

        <TrustStrip mode={mode} meta={meta} viewModel={viewModel} />

        <section className="metric-layout" aria-label="Metric evidence">
          <TrendPanel session={session} readout={readout} />
          <ScoreStrip session={session} readout={readout} />
        </section>

        <section className="decision-layout" aria-label="Current operator decision">
          <DecisionRail readout={readout} viewModel={viewModel} mode={mode} />
        </section>

        <section className="workspace-grid">
          <MissionPanel
            viewModel={viewModel}
            mode={mode}
            runLiveAction={runLiveAction}
            actionsById={actionsById}
            lastReceipt={lastReceipt}
          />
          <ActionReceiptPanel receipt={lastReceipt} />
          <ResearchTruthMeter viewModel={viewModel} />
          <FinalizationChecklist viewModel={viewModel} />
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
