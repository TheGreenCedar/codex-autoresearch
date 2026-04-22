import { formatConfidence, formatImprovement, formatMetric, statusCounts } from "../model.js";

export function ScoreStrip({ session, readout }) {
  const counts = statusCounts(session.runs);
  return (
    <section className="score-strip" aria-label="Current readout">
      <ScoreCell label="Baseline" id="baseline-value" value={formatMetric(readout.baseline, session.config.metricUnit)} />
      <ScoreCell label="Best" id="best-value" value={formatMetric(readout.best, session.config.metricUnit)} />
      <ScoreCell label="Improvement" id="improvement-value" value={formatImprovement(readout.improvement)} />
      <ScoreCell label="Confidence" id="confidence-value" value={formatConfidence(readout.confidence)} />
      <ScoreCell label="Runs" id="runs-value" value={`${session.runs.length} (${counts.keep} kept)`} />
    </section>
  );
}

function ScoreCell({ label, value, id }) {
  return (
    <div className="score-cell">
      <span className="score-label">{label}</span>
      <strong id={id}>{value}</strong>
    </div>
  );
}
