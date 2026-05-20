import { useMemo, useState, useEffect, useRef } from "react";
import type { DashboardEntry, DashboardMeta } from "./types";
import { buildReadout, dashboardMode } from "./model";
import { useDashboardSession } from "./hooks/useDashboardSession";
import { useLiveDashboard } from "./hooks/useLiveDashboard";
import { SideRail } from "./components/SideRail";
import { Header } from "./components/Header";
import { DecisionRail } from "./components/DecisionRail";
import { MissionControl } from "./components/MissionControl";
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

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    try {
      const saved =
        typeof localStorage !== "undefined" ? localStorage.getItem("autoresearch-theme") : null;
      if (saved === "dark" || saved === "light") return saved;
      if (typeof window.matchMedia === "function") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    } catch {
      // Ignore errors in test environments
    }
    return "light";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = window.document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark-theme");
      root.classList.remove("light-theme");
    } else {
      root.classList.add("light-theme");
      root.classList.remove("dark-theme");
    }
  }, [theme]);

  // Keep theme synced with OS/System theme changes unless the user explicitly saved a manual choice
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    try {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleChange = (e: MediaQueryListEvent) => {
        try {
          const saved =
            typeof localStorage !== "undefined" ? localStorage.getItem("autoresearch-theme") : null;
          if (!saved) {
            setTheme(e.matches ? "dark" : "light");
          }
        } catch {
          // Ignore errors
        }
      };
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    } catch {
      // Ignore errors
    }
  }, []);

  const [toast, setToast] = useState<{
    id: number;
    title: string;
    message: string;
    type: "success" | "info" | "warn";
  } | null>(null);

  const prevSegment = useRef(activeSegment);
  const prevRunsLength = useRef(session.runs.length);
  const nextToastId = useRef(0);

  useEffect(() => {
    if (activeSegment === prevSegment.current && session.runs.length > prevRunsLength.current) {
      const lastRun = session.runs[session.runs.length - 1];
      if (lastRun) {
        let type: "success" | "info" | "warn" = "info";
        if (lastRun.status === "keep") {
          type = "success";
        } else if (lastRun.status === "crash" || lastRun.status === "checks_failed") {
          type = "warn";
        }
        const statusLabel = lastRun.status.toUpperCase().replace("_", " ");
        setToast({
          id: nextToastId.current++,
          title: `New Run Logged: Run #${lastRun.run}`,
          message: `Status: ${statusLabel} | ${lastRun.description || "No description provided"}`,
          type,
        });
      }
    }
    prevSegment.current = activeSegment;
    prevRunsLength.current = session.runs.length;
  }, [session.runs, activeSegment]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

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
              onClick={() => setToast(null)}
            >
              &times;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
