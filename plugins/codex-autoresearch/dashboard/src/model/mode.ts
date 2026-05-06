import type { DashboardMeta, DashboardMode } from "../types";

export function dashboardMode(meta: DashboardMeta = {}): DashboardMode {
  const showcase = Boolean(meta.showcaseMode || meta.settings?.showcaseMode);
  const httpServed = typeof location !== "undefined" && /^https?:$/.test(location.protocol);
  const liveRefresh = Boolean(meta.liveRefreshAvailable) && httpServed;
  const guidance = meta.modeGuidance || {};
  if (showcase) {
    return {
      liveRefresh: false,
      liveActions: false,
      showcase: true,
      title: "Demo Snapshot",
      detail: guidance.detail || "100 embedded packets.",
      refreshDone: "Demo snapshot refreshed",
      actionNote: "Demo shows the served readout; actions stay in CLI.",
    };
  }
  if (liveRefresh) {
    return {
      liveRefresh: true,
      liveActions: false,
      title: "Live Readout",
      detail: guidance.detail || "Live refresh is available; actions stay in CLI.",
      refreshDone: "Live readout refreshed",
      actionNote: "Use CLI for setup, packet runs, logging, and finalization.",
    };
  }
  return {
    liveRefresh: false,
    liveActions: false,
    title: "Static Snapshot",
    detail: guidance.detail || "Read-only export. Serve the dashboard for fresh state.",
    refreshDone: "Snapshot refreshed",
    actionNote: "Commands only.",
  };
}
