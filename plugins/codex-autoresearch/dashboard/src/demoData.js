export const DEMO_ENTRIES = [
  { type: "config", name: "Autoresearch", metricName: "quality_gap", bestDirection: "lower", metricUnit: " gaps" },
  { type: "run", run: 1, metric: 6, status: "keep", description: "Baseline quality pass", confidence: 1, asi: { hypothesis: "Find the current product gaps.", next_action_hint: "Close the highest-signal dashboard gap." } },
  { type: "run", run: 2, metric: 3, status: "keep", description: "Guided setup and finalization preview", confidence: 2, asi: { evidence: "quality_gap=3", next_action_hint: "Preview finalization after the next clean run." } },
  { type: "run", run: 3, metric: 4, status: "discard", description: "Too much panel chrome", confidence: 1, asi: { rollback_reason: "Made the cockpit harder to scan." } },
];

export const DEMO_META = {
  deliveryMode: "static-export",
  generatedAt: new Date().toISOString(),
  modeGuidance: { title: "Static snapshot", detail: "Read-only snapshot." },
  viewModel: {
    nextBestAction: {
      priority: "Narrow",
      title: "Pick a quality gap",
      detail: "Close the highest-signal dashboard gap.",
      utilityCopy: "Convert the next gap into one measured hypothesis.",
      source: "quality-gap",
    },
    missionControl: {
      activeStep: "gaps",
      steps: [
        { id: "setup", title: "Setup", state: "done", detail: "Session setup is readable." },
        { id: "gaps", title: "Gap review", state: "ready", detail: "3 open / 6 total." },
        { id: "finalize", title: "Finalize", state: "idle", detail: "Preview after the next keep." },
      ],
    },
    experimentMemory: {
      latestNextAction: "Close the highest-signal dashboard gap.",
      plateau: { detected: false },
      lanePortfolio: [
        { id: "ui", title: "Dashboard UX", status: "active", nextActionHint: "Make the next action obvious." },
        { id: "safety", title: "Loop safety", status: "watch", nextActionHint: "Keep stale packet checks visible." },
      ],
    },
    aiSummary: {
      title: "Next move is ready",
      happened: ["3 runs logged", "2 kept", "1 discarded"],
      plan: ["Close the highest-signal dashboard gap.", "Preview finalization after a clean keep."],
      blockers: [],
      source: "latest #3 / dashboard state",
    },
  },
};
