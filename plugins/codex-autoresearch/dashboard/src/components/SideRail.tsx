const NAV_ITEMS = [
  ["#decision-rail", "1", "Move"],
  ["#trend-panel", "2", "Metric"],
  ["#codex-brief", "3", "Brief"],
  ["#ledger", "4", "Ledger"],
] as const;

export function SideRail({ live, showcase }: { live: boolean; showcase: boolean }) {
  const status = showcase ? "Demo" : live ? "Live" : "Static";
  const detail = showcase ? "Showcase Data" : live ? "Readout" : "Snapshot";
  const markerClassName = live ? "live-dot" : "status-dot";
  return (
    <aside className="side-rail" aria-label="Dashboard sections">
      <div className="rail-mark">AR</div>
      <nav className="side-nav">
        {NAV_ITEMS.map(([href, index, label]) => (
          <a href={href} key={href} aria-label={`Dashboard section: ${label}`}>
            <span className="nav-icon" aria-hidden="true">
              {index}
            </span>
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="side-status">
        <span>
          <span className={markerClassName} aria-hidden="true" />
          {status}
        </span>
        <strong id="side-mode-detail">{detail}</strong>
      </div>
    </aside>
  );
}
