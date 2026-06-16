const NAV_ITEMS = [
  ["#trend-panel", "1", "Metric"],
  ["#decision-rail", "2", "Move"],
  ["#codex-brief", "3", "Brief"],
  ["#ledger", "4", "Ledger"],
] as const;

export function SideRail({ live, showcase }: { live: boolean; showcase: boolean }) {
  const status = showcase ? "Demo" : live ? "Live" : "Static";
  const detail = showcase ? "Snapshot" : live ? "Readout" : "Snapshot";
  return (
    <aside className="side-rail" aria-label="Dashboard sections">
      <div className="rail-mark">AR</div>
      <nav className="side-nav">
        {NAV_ITEMS.map(([href, index, label]) => (
          <a href={href} key={href}>
            <span className="nav-icon">{index}</span>
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="side-status">
        <span>
          <span className="live-dot" aria-hidden="true" />
          {status}
        </span>
        <strong id="side-mode-detail">{detail}</strong>
      </div>
    </aside>
  );
}
