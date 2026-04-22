import { directionLabel, formatDisplayTime } from "../model.js";

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
}) {
  const hasMultipleSegments = normalized.segments.length > 1;
  const generated = meta.generatedAt ? formatDisplayTime(meta.generatedAt) : "Snapshot";
  return (
    <header className="masthead">
      <div className="session-contract">
        <p className="eyebrow">Autoresearch runboard</p>
        <h1>{session.config.name || "Autoresearch"}</h1>
        <div className="metric-line">
          <span>{session.config.metricName || "metric"}</span>
          <span>{directionLabel(session.config.bestDirection)}</span>
          <span>{session.runs.length} run{session.runs.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div className="header-controls">
        <span id="segment-select-wrap" hidden={!hasMultipleSegments} className="segment-control">
          <label htmlFor="segment-select">Segment</label>
          <select id="segment-select" value={activeSegment} onChange={(event) => setActiveSegment(Number(event.target.value))}>
            {normalized.segments.map((item) => (
              <option key={item.segment} value={item.segment}>
                {`Segment ${item.segment + 1} - ${item.config.name || "Autoresearch"} (${item.runs.length} runs)`}
              </option>
            ))}
          </select>
        </span>
        <div className="status-strip" id="live-region" aria-live="polite">
          <span id="live-title">{liveStatus.title || mode.title}</span>
          <strong id="live-detail">{liveStatus.detail || mode.detail}</strong>
        </div>
        <div className="header-actions">
          <button id="refresh-now" type="button" className="tool-button" hidden={!mode.liveActions} onClick={refreshLiveData}>
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
      <p id="segment-note" className="segment-note">
        {hasMultipleSegments ? `Showing segment ${activeSegment + 1} of ${normalized.segments.length}` : "Showing current segment"}
      </p>
    </header>
  );
}
