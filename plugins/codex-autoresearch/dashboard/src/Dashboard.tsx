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
import {
  CodexBrief,
  FinalizationChecklist,
  QualityGapPanel,
  ResearchTruthMeter,
  StrategyMemory,
} from "./components/ContextPanels";
import { Ledger } from "./components/Ledger";

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
  const { liveEnabled, liveStatus, refreshLiveData, setLiveEnabled } = useLiveDashboard({
    meta,
    mode,
    setEntries,
    setMeta,
    setViewModel,
    viewModel,
  });

  return (
    <div
      className={`runboard-shell ${mode.liveActions || mode.showcase ? "mode-live" : "mode-static"}`}
    >
      <nav className="skip-links" aria-label="Skip links">
        <a href="#trend-panel">Run chart</a>
        <a href="#codex-brief">Codex brief</a>
        <a href="#strategy-memory">Session memory</a>
        <a href="#decision-rail">Current decision</a>
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

        <section className="metric-layout" aria-label="Metric evidence">
          <TrendPanel session={session} readout={readout} />
          <ScoreStrip session={session} readout={readout} />
        </section>

        <section className="brief-layout" aria-label="Codex session context">
          <CodexBrief session={session} viewModel={viewModel} />
          <StrategyMemory viewModel={viewModel} />
        </section>

        <section className="decision-layout" aria-label="Current operator decision">
          <DecisionRail readout={readout} viewModel={viewModel} mode={mode} />
        </section>

        <Ledger session={session} readout={readout} />

        <section className="workspace-grid">
          <ResearchTruthMeter viewModel={viewModel} />
          <FinalizationChecklist viewModel={viewModel} />
          <QualityGapPanel viewModel={viewModel} />
        </section>
      </main>
    </div>
  );
}
