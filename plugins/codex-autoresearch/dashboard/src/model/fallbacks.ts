import type { AiSummaryModel, DashboardViewModel, SessionSegment } from "../types";
import { asiText } from "./asi";
import { statusCounts } from "./status";

export function fallbackAiSummary(
  session: SessionSegment,
  viewModel: DashboardViewModel,
): AiSummaryModel {
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
