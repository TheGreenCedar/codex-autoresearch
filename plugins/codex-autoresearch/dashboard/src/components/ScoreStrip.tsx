import type { DashboardReadout, SessionSegment } from "../types";
import { formatConfidence, formatImprovement, formatMetricValue, statusCounts } from "../model";

interface ScoreStripProps {
  session: SessionSegment;
  readout: DashboardReadout;
  layout?: "stack" | "bar";
}

export function ScoreStrip({ session, readout, layout = "stack" }: ScoreStripProps) {
  const counts = statusCounts(session.runs);
  const latest = readout.recentRuns[0] || null;
  return (
    <section className={`score-strip score-strip--${layout}`} aria-label="What changed">
      <ScoreCell
        label="Best kept change"
        id="best-value"
        value={formatMetricValue(readout.best, readout.metricDefinition)}
      />
      <ScoreCell
        label="Latest packet"
        id="latest-value"
        value={
          latest
            ? `#${latest.run} ${latest.status || "logged"}`
            : `${session.runs.length} run${session.runs.length === 1 ? "" : "s"}`
        }
      />
      <ScoreCell
        label="Baseline"
        id="baseline-value"
        value={formatMetricValue(readout.baseline, readout.metricDefinition)}
      />
      <ScoreCell
        label="Confidence"
        id="confidence-value"
        value={formatConfidence(readout.confidence)}
      />
      <ScoreCell
        label="Improvement"
        id="improvement-value"
        value={formatImprovement(readout.improvement)}
      />
      <ScoreCell
        label="Runs"
        id="runs-value"
        value={`${session.runs.length} (${counts.keep} kept)`}
      />
    </section>
  );
}

interface ScoreCellProps {
  label: string;
  value: string;
  id: string;
}

function ScoreCell({ label, value, id }: ScoreCellProps) {
  return (
    <div className="score-cell">
      <span className="score-label">{label}</span>
      <strong id={id}>{value}</strong>
    </div>
  );
}
