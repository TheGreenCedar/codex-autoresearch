import { useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { KeyboardEvent } from "react";
import type {
  DashboardMeta,
  DashboardMode,
  DashboardReadout,
  NormalizedEntries,
  SessionSegment,
} from "../types";
import { directionLabel, formatDisplayTime, recordFrom } from "../model";
import type { DashboardView } from "../constants";
import { useCopyText } from "../hooks/useCopyText";

interface HeaderProps {
  session: SessionSegment;
  normalized: NormalizedEntries;
  activeSegment: number;
  setActiveSegment: (segment: number) => void;
  mode: DashboardMode;
  meta: DashboardMeta;
  liveStatus: { title?: string; detail?: string };
  liveEnabled: boolean;
  setLiveEnabled: Dispatch<SetStateAction<boolean>>;
  refreshLiveData: () => void;
  readout: DashboardReadout;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  view: DashboardView;
  setView: (view: DashboardView) => void;
}

export function Header({
  session,
  normalized,
  activeSegment,
  setActiveSegment,
  mode,
  meta,
  liveStatus,
  liveEnabled,
  setLiveEnabled,
  refreshLiveData,
  readout,
  theme,
  setTheme,
  view,
  setView,
}: HeaderProps) {
  const { copied: copiedUrl, copy: copyDashboardUrlText, status: copyUrlStatus } = useCopyText();
  const hasMultipleSegments = normalized.segments.length > 1;
  const generated = meta.generatedAt ? formatDisplayTime(meta.generatedAt) : "Snapshot";
  const metricLabel = readout.metricDefinition.metricName || session.config.metricName || "metric";
  const dashboardUrl = useMemo(() => dashboardUrlFrom(meta), [meta]);
  const attentionStatus = statusFor(liveStatus, mode);
  const copyDashboardUrl = async () => {
    if (!dashboardUrl) return;
    await copyDashboardUrlText(dashboardUrl);
  };
  return (
    <header id="dashboard-toolbar" className="dashboard-toolbar" aria-label="Dashboard controls">
      <h1 className="sr-only">Autoresearch dashboard</h1>
      <div className="toolbar-main">
        <div className="toolbar-session" aria-label="Current session">
          <strong>{session.config.name || "Autoresearch session"}</strong>
          <div className="metric-line toolbar-metric-line">
            <span>{metricLabel}</span>
            <span>{directionLabel(readout.metricDefinition.bestDirection)}</span>
            <span>
              {session.runs.length} run{session.runs.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div className="toolbar-actions">
          <div className="header-actions">
            <button
              id="view-toggle"
              type="button"
              className="tool-button subtle"
              onClick={() => setView(view === "audit" ? "operate" : "audit")}
              aria-pressed={view === "audit"}
              aria-label={
                view === "audit" ? "Switch to focused operate view" : "Switch to full audit view"
              }
            >
              {view === "audit" ? "Focus view" : "Audit view"}
            </button>
            <button
              id="refresh-now"
              type="button"
              className="tool-button"
              hidden={!mode.liveRefresh}
              onClick={refreshLiveData}
            >
              Refresh live data
            </button>
            <button
              id="live-toggle"
              type="button"
              className="tool-button subtle"
              hidden={!mode.liveRefresh}
              onClick={() => setLiveEnabled((value) => !value)}
            >
              {liveEnabled ? "Auto-refresh on" : "Auto-refresh off"}
            </button>
            <button
              id="copy-dashboard-url"
              type="button"
              className="tool-button subtle"
              hidden={!dashboardUrl}
              onClick={copyDashboardUrl}
            >
              {copiedUrl ? "Copied URL" : "Copy URL"}
            </button>
            <button
              id="theme-toggle"
              type="button"
              className="tool-button subtle"
              onClick={() => {
                const nextTheme = theme === "light" ? "dark" : "light";
                setTheme(nextTheme);
              }}
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              {theme === "light" ? (
                <>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ marginRight: "6px" }}
                  >
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                  </svg>
                  Dark
                </>
              ) : (
                <>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ marginRight: "6px" }}
                  >
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                  </svg>
                  Light
                </>
              )}
            </button>
          </div>
          <div className="generated-cell">
            <span>Generated</span>
            <strong>{generated}</strong>
          </div>
          <em
            id="copy-dashboard-url-status"
            className="copy-status"
            aria-live="polite"
            hidden={!copiedUrl}
          >
            Dashboard URL copied.
          </em>
          <em
            id="copy-dashboard-url-error"
            className="copy-status"
            aria-live="assertive"
            hidden={copyUrlStatus !== "error"}
          >
            Dashboard URL copy failed.
          </em>
        </div>
      </div>
      {attentionStatus || hasMultipleSegments ? (
        <div className="toolbar-controls">
          {attentionStatus ? (
            <p className="toolbar-status" id="live-region" aria-live="polite">
              <span id="live-title">{attentionStatus.title}</span>
              <strong id="live-detail">{attentionStatus.detail}</strong>
            </p>
          ) : null}
          {hasMultipleSegments ? (
            <SegmentNavigator
              activeSegment={activeSegment}
              normalized={normalized}
              setActiveSegment={setActiveSegment}
            />
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

function SegmentNavigator({
  activeSegment,
  normalized,
  setActiveSegment,
}: {
  activeSegment: number;
  normalized: NormalizedEntries;
  setActiveSegment: (segment: number) => void;
}) {
  const active = normalized.segments.find((item) => item.segment === activeSegment);
  const activeTitle = segmentTitle(active);
  const selectedIndex = normalized.segments.findIndex((item) => item.segment === activeSegment);
  const selectSegment = (segment: number) => {
    setActiveSegment(segment);
    window.setTimeout(() => {
      document.getElementById(segmentButtonId(segment))?.focus();
    }, 0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const max = normalized.segments.length - 1;
    const current = selectedIndex < 0 ? 0 : selectedIndex;
    const nextIndex =
      event.key === "ArrowRight"
        ? Math.min(current + 1, max)
        : event.key === "ArrowLeft"
          ? Math.max(current - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? max
              : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    selectSegment(normalized.segments[nextIndex].segment);
  };
  return (
    <div className="segment-navigator" id="segment-navigator">
      <span className="segment-navigator-label" id="segment-navigator-label">
        Segments
      </span>
      <div
        className="segment-tablist"
        role="tablist"
        aria-labelledby="segment-navigator-label"
        onKeyDown={onKeyDown}
      >
        {normalized.segments.map((item) => {
          const title = segmentTitle(item);
          const selected = item.segment === activeSegment;
          return (
            <button
              id={segmentButtonId(item.segment)}
              key={item.segment}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="segment-panel"
              className={selected ? "segment-tab active" : "segment-tab"}
              title={title}
              onClick={() => selectSegment(item.segment)}
            >
              <span className="segment-tab-title">
                <strong>{`S${item.segment + 1}`}</strong>
                <span>{truncateTitle(title, 48)}</span>
              </span>
              <span className="segment-tab-meta">
                {segmentRunText(item)} / {segmentKeptText(item)}
              </span>
              <span className={`segment-tab-status ${segmentStatus(item, normalized)}`}>
                {segmentStatusLabel(item, normalized)}
              </span>
            </button>
          );
        })}
      </div>
      <p
        id="segment-panel"
        className="segment-note"
        role="tabpanel"
        aria-labelledby={segmentButtonId(active?.segment ?? activeSegment)}
        aria-live="polite"
        tabIndex={0}
      >
        {active
          ? `Showing segment ${active.segment + 1} of ${normalized.segments.length}: ${activeTitle}. ${segmentRunText(active)}, ${segmentKeptText(active)}.`
          : `Showing segment ${activeSegment + 1} of ${normalized.segments.length}.`}
      </p>
    </div>
  );
}

function segmentButtonId(segment: number) {
  return `segment-tab-${segment}`;
}

function segmentTitle(segment: SessionSegment | undefined) {
  return segment?.config.name || "Autoresearch";
}

function truncateTitle(value: string, max: number) {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}\u2026` : value;
}

function segmentRunText(segment: SessionSegment) {
  return `${segment.runs.length} run${segment.runs.length === 1 ? "" : "s"}`;
}

function segmentKeptText(segment: SessionSegment) {
  const kept = segment.runs.filter((run) => run.status === "keep").length;
  return `${kept} kept`;
}

function segmentStatus(segment: SessionSegment, normalized: NormalizedEntries) {
  const latest = segment.runs.at(-1);
  if (!latest) return "empty";
  if (latest.status === "crash" || latest.status === "checks_failed") return "blocked";
  if (segment.segment === normalized.latestSegment) return "active";
  return "complete";
}

function segmentStatusLabel(segment: SessionSegment, normalized: NormalizedEntries) {
  const status = segmentStatus(segment, normalized);
  if (status === "blocked") return "blocked";
  if (status === "active") return "active";
  if (status === "empty") return "empty";
  return "complete";
}

function statusFor(liveStatus: { title?: string; detail?: string }, mode: DashboardMode) {
  if (mode.liveRefresh || isAttentionStatus(liveStatus.title)) {
    return {
      title: liveStatus.title || "Dashboard notice",
      detail: liveStatus.detail || "Review the latest dashboard status.",
    };
  }
  return null;
}

function isAttentionStatus(title: unknown) {
  return typeof title === "string" && /(failed|unavailable|error|running)/i.test(title);
}

function dashboardUrlFrom(meta: DashboardMeta) {
  const settings = recordFrom(meta.settings);
  return firstString(
    meta.liveUrl,
    meta.dashboardUrl,
    meta.url,
    settings.liveUrl,
    settings.dashboardUrl,
    settings.url,
    typeof window !== "undefined" ? window.location.href : "",
  );
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
