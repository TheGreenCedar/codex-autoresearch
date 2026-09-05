import { recordFrom } from "./model";
import { useMemo } from "react";
import type { DashboardEntry, DashboardMeta } from "./types";
import { buildReadout, dashboardMode } from "./model";
import { DASHBOARD_VIEWS, DEFAULT_DASHBOARD_VIEW } from "./constants";
import type { DashboardView } from "./constants";
import { useDashboardSession } from "./hooks/useDashboardSession";
import { useDashboardTheme } from "./hooks/useDashboardTheme";
import { useLiveDashboard } from "./hooks/useLiveDashboard";
import { useRunToast } from "./hooks/useRunToast";
import { useUrlParam } from "./hooks/useUrlState";
import { SideRail } from "./components/SideRail";
import { Header } from "./components/Header";
import { DecisionRail } from "./components/DecisionRail";
import { MissionControl } from "./components/MissionControl";
import { ScoreStrip } from "./components/ScoreStrip";
import { SignalStrip } from "./components/SignalStrip";
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
  initialEntries: DashboardEntry[];
  initialMeta: DashboardMeta;
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
  const ledgerBounds = meta.ledgerBounds || viewModel.ledgerBounds;
  const invalidLedgerEntryCount =
    normalized.invalidLedgerEntryCount + finiteNonNegative(ledgerBounds?.invalidLedgerEntryCount);
  const readout = useMemo(
    () => buildReadout(session, viewModel, invalidLedgerEntryCount),
    [invalidLedgerEntryCount, session, viewModel],
  );
  const { lastGoodAt, liveEnabled, liveStatus, refreshLiveData, refreshState, setLiveEnabled } =
    useLiveDashboard({ meta, mode, setEntries, setMeta, setViewModel });

  const { theme, setTheme } = useDashboardTheme();
  const { dismissToast, toast } = useRunToast(activeSegment, session.runs);
  const [viewParam, setViewParam] = useUrlParam("view", DASHBOARD_VIEWS, DEFAULT_DASHBOARD_VIEW);
  const view = viewParam as DashboardView;
  const auditView = view === "audit";
  const hasOutcome =
    typeof recordFrom(recordFrom(viewModel.decisionPlanProjection).investigation).id === "string";

  return (
    <div
      className={`runboard-shell ${mode.liveRefresh || mode.showcase ? "mode-live" : "mode-static"} ${
        auditView ? "view-audit" : "view-operate"
      }`}
    >
      <nav className="skip-links" aria-label="Skip links">
        <a href="#decision-rail">Next action</a>
        {!hasOutcome ? <a href="#trend-panel">Packet trend</a> : null}
        {!hasOutcome ? <a href="#codex-brief">Codex brief</a> : null}
        {auditView && !hasOutcome ? <a href="#strategy-memory">Strategy lanes</a> : null}
        {!hasOutcome || (auditView && session.runs.length > 0) ? (
          <a href="#ledger">Ledger</a>
        ) : null}
      </nav>
      <SideRail
        live={Boolean(mode.liveRefresh)}
        showcase={Boolean(mode.showcase)}
        hasOutcome={hasOutcome}
        auditView={auditView}
      />

      <main className="wrap" aria-busy={refreshState === "refreshing"}>
        <Header
          hasOutcome={hasOutcome}
          session={session}
          normalized={normalized}
          activeSegment={activeSegment}
          setActiveSegment={setActiveSegment}
          mode={mode}
          meta={meta}
          liveStatus={liveStatus}
          refreshState={refreshState}
          lastGoodAt={lastGoodAt}
          liveEnabled={liveEnabled}
          setLiveEnabled={setLiveEnabled}
          refreshLiveData={refreshLiveData}
          readout={readout}
          theme={theme}
          setTheme={setTheme}
          view={view}
          setView={setViewParam}
        />

        <section className="decision-layout" aria-label="Current operator decision">
          <DecisionRail readout={readout} viewModel={viewModel} mode={mode} auditView={auditView} />
        </section>

        {!hasOutcome ? (
          <section
            className={`metric-layout${auditView ? "" : " metric-layout--chart-primary"}`}
            aria-label="Metric evidence"
          >
            <div className="metric-primary-column">
              <TrendPanel
                session={session}
                readout={readout}
                detailsDefaultOpen={false}
                chartHeight={auditView ? 350 : 420}
              />
              <div className="post-chart-runway" aria-label="Readout context">
                {auditView ? <MissionControl viewModel={viewModel} mode={mode} /> : null}
                <SignalStrip view={view} viewModel={viewModel} />
              </div>
            </div>
            {auditView ? (
              <ScoreStrip
                session={session}
                readout={readout}
                summary={viewModel.summary}
                layout="stack"
              />
            ) : null}
          </section>
        ) : null}

        {!auditView && !hasOutcome ? (
          <ScoreStrip
            session={session}
            readout={readout}
            summary={viewModel.summary}
            layout="compact"
          />
        ) : null}

        {!hasOutcome ? (
          <section className="brief-layout" aria-label="Codex session context">
            <CodexBrief session={session} viewModel={viewModel} />
            {auditView ? <StrategyMemory viewModel={viewModel} /> : null}
          </section>
        ) : null}

        {!hasOutcome || (auditView && session.runs.length > 0) ? (
          <Ledger session={session} readout={readout} ledgerBounds={ledgerBounds} />
        ) : null}

        {auditView && !hasOutcome ? (
          <section className="workspace-grid" id="workspace-grid" aria-label="Audit context">
            <ResearchTruthMeter viewModel={viewModel} />
            <FinalizationChecklist viewModel={viewModel} />
            <ProcessHygiene viewModel={viewModel} />
            <QualityGapPanel viewModel={viewModel} />
          </section>
        ) : null}
      </main>

      <div
        className="toast-container"
        role={toast?.type === "warn" ? "alert" : "status"}
        aria-live={toast?.type === "warn" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {toast ? (
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
        ) : null}
      </div>
    </div>
  );
}

function finiteNonNegative(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}
