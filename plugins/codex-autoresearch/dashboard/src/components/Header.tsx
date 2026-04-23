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
  const hasMultipleSegments = normalized.segments.length > 1;
  const generated = meta.generatedAt ? formatDisplayTime(meta.generatedAt) : "Snapshot";
  const metricLabel = readout.metricDefinition.metricName || session.config.metricName || "metric";
  return (
    <header className="masthead">
      <div className="masthead-top">
        <div className="session-contract">
          <p className="eyebrow">Autoresearch runboard</p>
          <h1>{session.config.name || "Autoresearch"}</h1>
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
              {liveEnabled ? "Live on" : "Live off"}
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
