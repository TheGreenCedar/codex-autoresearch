import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  DashboardMeta,
  DashboardMode,
  DashboardReadout,
  NormalizedEntries,
  SessionSegment,
} from "../types";
import { directionLabel, formatDisplayTime } from "../model";

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
  const [copiedUrl, setCopiedUrl] = useState(false);
  const hasMultipleSegments = normalized.segments.length > 1;
  const generated = meta.generatedAt ? formatDisplayTime(meta.generatedAt) : "Snapshot";
  const metricLabel = readout.metricDefinition.metricName || session.config.metricName || "metric";
  const dashboardUrl = useMemo(() => dashboardUrlFrom(meta), [meta]);
  const copyDashboardUrl = async () => {
    if (!dashboardUrl) return;
    const copied = await copyText(dashboardUrl);
    setCopiedUrl(copied);
    if (copied) window.setTimeout(() => setCopiedUrl(false), 1600);
  };
  return (
    <header className="masthead">
      <div className="masthead-top">
        <div className="session-contract">
          <h1>Autoresearch Runboard</h1>
          <p className="eyebrow">{session.config.name || "Autoresearch session"}</p>
          <div className="metric-line">
            <span>{metricLabel}</span>
            <span>{directionLabel(readout.metricDefinition.bestDirection)}</span>
            <span>
              {session.runs.length} run{session.runs.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div className="header-utility">
          <div className="header-actions">
            <button
              id="refresh-now"
              type="button"
              className="tool-button"
              hidden={!mode.liveActions}
              onClick={refreshLiveData}
            >
              Refresh live data
            </button>
            <button
              id="live-toggle"
              type="button"
              className="tool-button subtle"
              hidden={!mode.liveActions}
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
        </div>
      </div>
      <div className="header-controls">
        <div className="status-strip" id="live-region" aria-live="polite">
          <span id="live-title">{liveStatus.title || mode.title}</span>
          <strong id="live-detail">{liveStatus.detail || mode.detail}</strong>
          <em id="copy-dashboard-url-status" hidden={!copiedUrl}>
            Dashboard URL copied.
          </em>
        </div>
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
    </header>
  );
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

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
