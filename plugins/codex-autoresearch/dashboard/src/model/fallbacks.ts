import type { DashboardViewModel, MissionControlModel, SessionSegment } from "../types";
import { asiText } from "./asi";
import { statusCounts } from "./status";

export function fallbackMissionControl(viewModel: DashboardViewModel): MissionControlModel {
  const action = viewModel.nextBestAction || {};
  return {
    activeStep: action.safeAction || "next",
    steps: [
      {
        id: "setup",
        title: "Setup",
        state: "done",
        detail: "Session setup is readable.",
        safeAction: "setup-plan",
      },
      {
        id: "next",
        title: action.title || "Next move",
        state: "ready",
        detail: action.detail || "Choose the next measured hypothesis.",
        safeAction: action.safeAction || "",
      },
      {
        id: "finalize",
        title: "Finalize",
        state: "idle",
        detail: "Preview when kept evidence is ready.",
        safeAction: "finalize-preview",
      },
    ],
    logDecision: viewModel.missionControl?.logDecision || {
      available: false,
      allowedStatuses: [],
      suggestedStatus: "",
      commandsByStatus: {},
    },
  };
}

export function fallbackAiSummary(session: SessionSegment, viewModel: DashboardViewModel) {
  const runs = session.runs || [];
  const counts = statusCounts(runs);
  const latest = runs.at(-1);
  return {
    title: viewModel.nextBestAction?.title || "Next move is ready",
    happened: [
      `${runs.length} runs logged`,
      `${counts.keep} kept`,
      `${counts.discard + counts.crash + counts.checks_failed} failed or rejected`,
    ],
    plan: [
      viewModel.readout?.nextAction ||
        viewModel.nextBestAction?.detail ||
        asiText(
          latest,
          ["next_action_hint", "nextAction", "next_action"],
          "Capture the next measured packet and log the decision.",
        ),
    ],
    blockers: [],
    source: latest ? `latest #${latest.run} / dashboard state` : "dashboard state",
  };
}
