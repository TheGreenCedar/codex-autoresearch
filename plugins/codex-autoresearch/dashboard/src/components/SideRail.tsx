export function SideRail({ liveActions, showcase }) {
  const status = showcase ? "Live" : liveActions ? "Live" : "Static";
  const detail = showcase ? "Runboard" : liveActions ? "Visual aid" : "Snapshot";
  return (
    <aside className="side-rail" aria-label="Dashboard sections">
      <div className="rail-mark">AR</div>
      <nav className="side-nav">
        <a href="#decision-rail">
          <span className="nav-icon">1</span>
          <span>Move</span>
        </a>
        <a href="#trend-panel">
          <span className="nav-icon">2</span>
          <span>Metric</span>
        </a>
        <a href="#codex-brief">
          <span className="nav-icon">3</span>
          <span>Brief</span>
        </a>
        <a href="#ledger">
          <span className="nav-icon">4</span>
          <span>Ledger</span>
        </a>
      </nav>
      <div className="side-status">
        <span>
          <span className="live-dot" />
          {status}
        </span>
        <strong id="side-mode-detail">{detail}</strong>
      </div>
    </aside>
  );
}
