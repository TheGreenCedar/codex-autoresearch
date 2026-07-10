import type { DashboardReadout, DashboardSummary, SessionSegment } from "../types";
import { formatConfidence, formatImprovement, formatMetricValue, statusCounts } from "../model";

interface ScoreStripProps {
  session: SessionSegment;
  readout: DashboardReadout;
  summary?: DashboardSummary;
  layout?: "stack" | "compact";
}

export function ScoreStrip({ session, readout, summary, layout = "stack" }: ScoreStripProps) {
  const counts = statusCounts(session.runs);
  const latest = readout.recentRuns[0] || null;
  const canonicalSummary = summary?.segment === session.segment ? summary : null;
  const runCount = finiteCount(canonicalSummary?.runs, session.runs.length);
  const keptCount = finiteCount(canonicalSummary?.kept, counts.keep);
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
            : `${runCount} run${runCount === 1 ? "" : "s"}`
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
      <ScoreCell label="Runs" id="runs-value" value={`${runCount} (${keptCount} kept)`} />
    </section>
  );
}

function finiteCount(value: unknown, fallback: number): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : fallback;
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
