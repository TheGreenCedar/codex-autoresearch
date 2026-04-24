import type { DashboardMeta, DashboardMode } from "../types";

export function dashboardMode(meta: DashboardMeta = {}): DashboardMode {
  const showcase = Boolean(meta.showcaseMode || meta.settings?.showcaseMode);
  const live =
    Boolean(meta.liveActionsAvailable) &&
    typeof location !== "undefined" &&
    /^https?:$/.test(location.protocol);
  const guidance = meta.modeGuidance || {};
  if (showcase) {
    return {
      liveActions: true,
      showcase: true,
      title: guidance.title || "Live runboard",
      detail: guidance.detail || "100 embedded packets.",
      refreshDone: "Live demo refreshed",
      actionNote: "Guarded actions visible in the demo.",
    };
  }
  if (live) {
    return {
      liveActions: true,
      title: guidance.title || "Live dashboard",
      detail: guidance.detail || "Live refresh is available; actions stay in CLI or MCP.",
      refreshDone: "Live data refreshed",
      actionNote: "Guarded actions execute through the local autoresearch server.",
    };
  }
  return {
    liveActions: false,
    title: guidance.title || "Static snapshot",
    detail:
      guidance.detail ||
      "Read-only export. Use autoresearch serve for executable dashboard actions.",
    refreshDone: "Snapshot refreshed",
    actionNote: "Commands only.",
  };
}
