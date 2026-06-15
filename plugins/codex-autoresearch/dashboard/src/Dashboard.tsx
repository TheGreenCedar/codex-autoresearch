import { useMemo } from "react";
import type { DashboardEntry, DashboardMeta, DashboardViewModel } from "./types";
import { buildReadout, dashboardMode, recordFrom } from "./model";
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
  const [viewParam, setViewParam] = useUrlParam("view", DASHBOARD_VIEWS, DEFAULT_DASHBOARD_VIEW);
  const view = viewParam as DashboardView;
  const auditView = view === "audit";
  const proofSignalsFirst = hasProofOrFinalizationBlockers(viewModel);

  const decisionRail = (
    <section className="decision-layout" aria-label="Current operator decision">
      <DecisionRail readout={readout} viewModel={viewModel} mode={mode} />
    </section>
  );

  return (
    <div
      className={`runboard-shell ${mode.liveRefresh || mode.showcase ? "mode-live" : "mode-static"} ${
        auditView ? "view-audit" : "view-operate"
      }`}
    >
      <nav className="skip-links" aria-label="Skip links">
        <a href="#trend-panel">Packet trend</a>
        <a href="#decision-rail">Next action</a>
        <a href="#codex-brief">Codex brief</a>
        {auditView ? <a href="#strategy-memory">Strategy lanes</a> : null}
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
          view={view}
          setView={setViewParam}
        />

        {auditView ? <MobileNextAction viewModel={viewModel} /> : null}

        <section
          className={`metric-layout${auditView ? "" : " metric-layout--chart-primary"}`}
          aria-label="Metric evidence"
        >
          <div className="metric-primary-column">
            {proofSignalsFirst ? <SignalStrip view={view} viewModel={viewModel} priority /> : null}
            <TrendPanel
              session={session}
              readout={readout}
              detailsDefaultOpen={auditView}
              chartHeight={auditView ? 350 : 420}
              afterChart={
                proofSignalsFirst ? null : <SignalStrip view={view} viewModel={viewModel} />
              }
            />
            {auditView ? decisionRail : null}
          </div>
          {auditView ? <ScoreStrip session={session} readout={readout} layout="stack" /> : null}
        </section>

        {auditView ? <MissionControl viewModel={viewModel} mode={mode} /> : null}
        {!auditView ? <ScoreStrip session={session} readout={readout} layout="compact" /> : null}
        {!auditView ? decisionRail : null}

        <section className="brief-layout" aria-label="Codex session context">
          <CodexBrief session={session} viewModel={viewModel} />
          {auditView ? <StrategyMemory viewModel={viewModel} /> : null}
        </section>

        <Ledger
          session={session}
          readout={readout}
          ledgerBounds={meta.ledgerBounds || viewModel.ledgerBounds}
        />

        {auditView ? (
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

function MobileNextAction({ viewModel }: { viewModel: DashboardViewModel }) {
  const action = recordFrom(viewModel.nextBestAction);
  const envelope = recordFrom(viewModel.decisionEnvelopeSummary);
  const title =
    cleanActionText(action.title) || cleanActionText(envelope.title) || "Choose next action";
  const packetBrake = action.packetBrake === true;
  const detail = packetBrake
    ? "Do not run another packet"
    : cleanActionText(action.detail) || cleanActionText(envelope.detail) || "Decision envelope";

  return (
    <section
      className={`mobile-next-action${packetBrake ? " warn" : ""}`}
      id="mobile-next-action"
      aria-label={`Next: ${title}. ${detail}`}
    >
      <span className="signal-label">Next</span>
      <strong title={title}>{title}</strong>
      <em title={detail}>{detail}</em>
    </section>
  );
}

function cleanActionText(value: unknown) {
  return String(value ?? "").trim();
}

function hasProofOrFinalizationBlockers(viewModel: DashboardViewModel) {
  const coverage = recordFrom(viewModel.productClaimCoverage);
  const finalization = recordFrom(viewModel.finalizePreview);
  const checklist = recordFrom(viewModel.finalizationChecklist);
  return (
    coverage.productGradeReady === false ||
    toList(coverage.blockers).length > 0 ||
    toList(coverage.missingRequiredProof).length > 0 ||
    toList(finalization.warnings).length > 0 ||
    toList(checklist.warnings).length > 0
  );
}

function toList(value: unknown) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
