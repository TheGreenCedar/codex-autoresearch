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
}: HeaderProps) {
  const { copied: copiedUrl, copy: copyDashboardUrlText } = useCopyText();
  const hasMultipleSegments = normalized.segments.length > 1;
  const generated = meta.generatedAt ? formatDisplayTime(meta.generatedAt) : "Snapshot";
  const metricLabel = readout.metricDefinition.metricName || session.config.metricName || "metric";
  const dashboardUrl = useMemo(() => dashboardUrlFrom(meta), [meta]);
  const attentionStatus = attentionStatusFor(liveStatus);
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
          </div>
          <div className="generated-cell">
            <span>Generated</span>
            <strong>{generated}</strong>
          </div>
          <em id="copy-dashboard-url-status" className="copy-status" hidden={!copiedUrl}>
            Dashboard URL copied.
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
          <span id="segment-select-wrap" hidden={!hasMultipleSegments} className="segment-control">
            <label htmlFor="segment-select">Segment</label>
            <select
              id="segment-select"
              value={activeSegment}
              onChange={(event) => setActiveSegment(Number(event.target.value))}
            >
              {normalized.segments.map((item) => (
                <option key={item.segment} value={item.segment}>
                  {`Segment ${item.segment + 1} - ${item.config.name || "Autoresearch"} (${item.runs.length} runs)`}
                </option>
              ))}
            </select>
          </span>
          {hasMultipleSegments ? (
            <p id="segment-note" className="segment-note">
              {`Showing segment ${activeSegment + 1} of ${normalized.segments.length}`}
            </p>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

function attentionStatusFor(liveStatus: { title?: string; detail?: string }) {
  if (isAttentionStatus(liveStatus.title)) {
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
