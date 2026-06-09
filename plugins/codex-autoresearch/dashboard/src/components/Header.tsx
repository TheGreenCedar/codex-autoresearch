import { useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
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
  refreshLiveData: () => Promise<void> | void;
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
  const liveReceipt = liveReceiptFor({ dashboardUrl, liveStatus, mode });
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
              onClick={() => refreshLiveData()}
            >
              Refresh now
            </button>
            <button
              id="live-toggle"
              type="button"
              className="tool-button subtle"
              hidden={!mode.liveRefresh}
              onClick={() => setLiveEnabled((value) => !value)}
              aria-pressed={liveEnabled}
            >
              {liveEnabled ? "Pause auto-refresh" : "Resume auto-refresh"}
            </button>
            <button
              id="copy-dashboard-url"
              type="button"
              className="tool-button subtle"
              hidden={!dashboardUrl}
              onClick={copyDashboardUrl}
              aria-describedby="copy-dashboard-url-status"
            >
              {copiedUrl ? "Copied live URL" : "Copy live URL"}
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
              <ThemeToggleContent theme={theme} />
            </button>
          </div>
          <div className="generated-cell">
            <span>Generated</span>
            <strong>{generated}</strong>
          </div>
          <em
            id="copy-dashboard-url-status"
            className="copy-status"
            hidden={!copiedUrl}
            aria-live="polite"
          >
            Copied live dashboard URL; no session state changed.
          </em>
          <em
            id="copy-dashboard-url-error"
            className="copy-status"
            hidden={copyUrlStatus !== "error"}
            role="alert"
          >
            Dashboard URL copy failed.
          </em>
        </div>
      </div>
      {liveReceipt || attentionStatus || hasMultipleSegments ? (
        <div className="toolbar-controls">
          {liveReceipt ? (
            <p className={`toolbar-live-receipt ${liveReceipt.tone}`} id="live-handoff-receipt">
              <span>{liveReceipt.label}</span>
              <strong>{liveReceipt.value}</strong>
              <em>{liveReceipt.detail}</em>
            </p>
          ) : null}
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

function ThemeToggleContent({ theme }: { theme: "light" | "dark" }) {
  if (theme === "light") {
    return (
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
    );
  }
  return (
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
  return (
    <div className="segment-navigator" id="segment-navigator">
      <label
        className="segment-navigator-label"
        id="segment-navigator-label"
        htmlFor="segment-select"
      >
        Segments
      </label>
      <select
        id="segment-select"
        className="segment-select"
        value={String(activeSegment)}
        aria-describedby="segment-summary"
        onChange={(event) => setActiveSegment(Number(event.currentTarget.value))}
      >
        {normalized.segments.map((item) => {
          const title = segmentTitle(item);
          return (
            <option key={item.segment} value={String(item.segment)}>
              {`S${item.segment + 1} - ${title} - ${segmentRunText(item)} / ${segmentKeptText(item)} - ${segmentStatusLabel(item, normalized)}`}
            </option>
          );
        })}
      </select>
      <p id="segment-summary" className="segment-note">
        {active
          ? `Showing segment ${active.segment + 1} of ${normalized.segments.length}: ${activeTitle}. ${segmentRunText(active)}, ${segmentKeptText(active)}.`
          : `Showing segment ${activeSegment + 1} of ${normalized.segments.length}.`}
      </p>
    </div>
  );
}

function segmentTitle(segment: SessionSegment | undefined) {
  return segment?.config.name || "Autoresearch";
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

function liveReceiptFor({
  dashboardUrl,
  liveStatus,
  mode,
}: {
  dashboardUrl: string;
  liveStatus: { title?: string; detail?: string };
  mode: DashboardMode;
}) {
  if (!dashboardUrl && !mode.liveRefresh) return null;
  const staleOrDead = /(failed|unavailable|error|stale|dead)/i.test(
    `${liveStatus.title || ""} ${liveStatus.detail || ""}`,
  );
  const port = portFromUrl(dashboardUrl);
  return {
    label: mode.liveRefresh ? "Live handoff" : "Dashboard handoff",
    value: [dashboardUrl || "No live URL", port ? `port ${port}` : ""].filter(Boolean).join(" / "),
    detail: staleOrDead
      ? liveStatus.detail || "Live readout is stale or unavailable."
      : mode.liveRefresh
        ? "Live readout is refreshable; copy only shares the URL."
        : "Static readout; copy only shares the URL.",
    tone: staleOrDead ? "warn" : "good",
  };
}

function portFromUrl(value: string) {
  if (!value) return "";
  try {
    return new URL(value).port;
  } catch {
    return "";
  }
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
