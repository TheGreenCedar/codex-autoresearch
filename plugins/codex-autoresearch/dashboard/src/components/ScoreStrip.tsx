import type { DashboardReadout, SessionSegment } from "../types";
import { formatConfidence, formatImprovement, formatMetricValue, statusCounts } from "../model";

interface ScoreStripProps {
  session: SessionSegment;
  readout: DashboardReadout;
}

export function ScoreStrip({ session, readout }: ScoreStripProps) {
  const counts = statusCounts(session.runs);
  return (
    <section className="score-strip" aria-label="Current readout">
      <ScoreCell
        label="Baseline"
        id="baseline-value"
        value={formatMetricValue(readout.baseline, readout.metricDefinition)}
      />
      <ScoreCell
        label="Best"
        id="best-value"
        value={formatMetricValue(readout.best, readout.metricDefinition)}
      />
      <ScoreCell
        label="Improvement"
        id="improvement-value"
        value={formatImprovement(readout.improvement)}
      />
      <ScoreCell
        label="Confidence"
        id="confidence-value"
        value={formatConfidence(readout.confidence)}
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
