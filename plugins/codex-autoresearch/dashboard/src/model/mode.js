export function dashboardMode(meta = {}) {
  const live = Boolean(meta.liveActionsAvailable) && (typeof location !== "undefined" && /^https?:$/.test(location.protocol));
  const guidance = meta.modeGuidance || {};
  if (live) {
    return {
      liveActions: true,
      title: guidance.title || "Live dashboard",
      detail: guidance.detail || "Live refresh and guarded local actions are available.",
      refreshDone: "Live data refreshed",
      actionNote: "Guarded actions execute through the local autoresearch server.",
    };
  }
  return {
    liveActions: false,
    title: guidance.title || "Static snapshot",
    detail: guidance.detail || "Read-only export. Use autoresearch serve for executable dashboard actions.",
    refreshDone: "Snapshot refreshed",
    actionNote: "Commands only.",
  };
}
