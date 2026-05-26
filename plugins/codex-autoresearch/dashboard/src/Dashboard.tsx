import { useMemo } from "react";
import type { DashboardEntry, DashboardMeta } from "./types";
import { buildReadout, dashboardMode } from "./model";
import { useDashboardSession } from "./hooks/useDashboardSession";
import { useDashboardTheme } from "./hooks/useDashboardTheme";
import { useLiveDashboard } from "./hooks/useLiveDashboard";
import { useRunToast } from "./hooks/useRunToast";
import { SideRail } from "./components/SideRail";
import { Header } from "./components/Header";
import { DecisionRail } from "./components/DecisionRail";
import { MissionControl } from "./components/MissionControl";
import { ScoreStrip } from "./components/ScoreStrip";
import { TrendPanel } from "./components/TrendPanel";
import {
  CodexBrief,
  FinalizationChecklist,
  ProcessHygiene,
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

  const { theme, setTheme } = useDashboardTheme();
  const { dismissToast, toast } = useRunToast(activeSegment, session.runs);

  const decisionRail = (
    <section className="decision-layout" aria-label="Current operator decision">
      <DecisionRail readout={readout} viewModel={viewModel} mode={mode} />
    </section>
  );

  return (
    <div
      className={`runboard-shell ${mode.liveRefresh || mode.showcase ? "mode-live" : "mode-static"}`}
    >
      <nav className="skip-links" aria-label="Skip links">
        <a href="#trend-panel">Run chart</a>
        <a href="#decision-rail">Current decision</a>
        <a href="#codex-brief">Codex brief</a>
        <a href="#strategy-memory">Session memory</a>
        <a href="#ledger">Ledger</a>
      </nav>
      <SideRail live={Boolean(mode.liveRefresh)} showcase={Boolean(mode.showcase)} />

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
          theme={theme}
          setTheme={setTheme}
        />

        <MissionControl viewModel={viewModel} mode={mode} />

        <section className="metric-layout" aria-label="Metric evidence">
          <div className="metric-primary-column">
            <TrendPanel session={session} readout={readout} />
            {mode.liveRefresh ? decisionRail : null}
          </div>
          <ScoreStrip session={session} readout={readout} />
        </section>

        <section className="brief-layout" aria-label="Codex session context">
          <CodexBrief session={session} viewModel={viewModel} />
          <StrategyMemory viewModel={viewModel} />
        </section>
        {mode.liveRefresh ? null : decisionRail}

        <Ledger session={session} readout={readout} />

        <section className="workspace-grid">
          <ResearchTruthMeter viewModel={viewModel} />
          <FinalizationChecklist viewModel={viewModel} />
          <ProcessHygiene viewModel={viewModel} />
          <QualityGapPanel viewModel={viewModel} />
        </section>
      </main>

      {toast && (
        <div className="toast-container" aria-live="polite">
          <div className={`toast ${toast.type}`} key={toast.id}>
            <div className="toast-content">
              <div className="toast-title">{toast.title}</div>
              <div className="toast-message">{toast.message}</div>
            </div>
            <button
              type="button"
              className="toast-close"
              aria-label="Close notification"
              onClick={dismissToast}
            >
              &times;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
