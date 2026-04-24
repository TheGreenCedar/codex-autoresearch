import type { DashboardMeta, DashboardMode } from "../types";

export function dashboardMode(meta: DashboardMeta = {}): DashboardMode {
  const showcase = Boolean(meta.showcaseMode || meta.settings?.showcaseMode);
  const httpServed = typeof location !== "undefined" && /^https?:$/.test(location.protocol);
  const liveRefresh = Boolean(meta.liveRefreshAvailable || meta.liveActionsAvailable) && httpServed;
  const liveActions = Boolean(meta.liveActionsAvailable) && httpServed;
  const guidance = meta.modeGuidance || {};
  if (showcase) {
    return {
      liveRefresh: true,
      liveActions: false,
      showcase: true,
      title: guidance.title || "Live runboard",
      detail: guidance.detail || "100 embedded packets.",
      refreshDone: "Live demo refreshed",
      actionNote: "Demo shows the served readout; actions stay in CLI or MCP.",
    };
  }
  if (liveRefresh) {
    return {
      liveRefresh: true,
      liveActions,
      title: guidance.title || "Live dashboard",
      detail: guidance.detail || "Live refresh is available; actions stay in CLI or MCP.",
      refreshDone: "Live data refreshed",
      actionNote: "Use CLI or MCP for setup, packet runs, logging, and finalization.",
    };
  }
  return {
    liveRefresh: false,
    liveActions: false,
    title: guidance.title || "Static snapshot",
    detail: guidance.detail || "Read-only export. Serve the dashboard for fresh state.",
    refreshDone: "Snapshot refreshed",
    actionNote: "Commands only.",
  };
}
