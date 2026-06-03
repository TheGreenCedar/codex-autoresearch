type LooseObject = Record<string, unknown>;

export type PacketDiagnosticStage =
  | "retrieved_but_not_cited"
  | "lost_in_synthesis_or_citation"
  | "missing_quality_score"
  | "marked_sufficient_but_failed"
  | "none";

export interface PacketDiagnostics {
  primaryStage: PacketDiagnosticStage;
  stages: PacketDiagnosticStage[];
  unresolved: boolean;
  reasons: string[];
  recommendation: string;
  command: string;
  taskArtifacts?: unknown;
}

export function classifyPacketDiagnostics(input: LooseObject = {}): PacketDiagnostics {
  const packetEvidence = objectValue(input.packetEvidence) || {};
  const run = objectValue(input.run) || {};
  const decision = objectValue(input.decision) || {};
  const metrics = collectMetrics(input, packetEvidence);
  const text = [
    packetEvidence.stderrTail,
    packetEvidence.stderr,
    packetEvidence.stdoutTail,
    packetEvidence.stdout,
    input.stderr,
    input.stdout,
  ]
    .map(stringValue)
    .filter(Boolean)
    .join("\n");
  const stages: PacketDiagnosticStage[] = [];
  const reasons: string[] = [];

  if (missingQualityScore({ input, packetEvidence, run, decision, metrics, text })) {
    addStage(stages, reasons, "missing_quality_score", "Packet exited without a quality score.");
  }
  if (markedSufficientButFailed({ input, packetEvidence, metrics, text })) {
    addStage(
      stages,
      reasons,
      "marked_sufficient_but_failed",
      "Packet was marked sufficient but the quality metric failed.",
    );
  }
  if (lostInSynthesisOrCitation(metrics)) {
    addStage(
      stages,
      reasons,
      "lost_in_synthesis_or_citation",
      "High symbol recall did not carry through to file, claim, or citation recall.",
    );
  }
  if (retrievedButNotCited({ input, packetEvidence, metrics })) {
    addStage(
      stages,
      reasons,
      "retrieved_but_not_cited",
      "Retrieval found evidence, but citation or claim recall stayed low.",
    );
  }

  const primaryStage = stages[0] || "none";
  return {
    primaryStage,
    stages,
    unresolved: primaryStage !== "none",
    reasons,
    recommendation:
      primaryStage === "none"
        ? ""
        : `Inspect packet diagnostic stage ${primaryStage} before another packet.`,
    command: stringValue(input.command),
    taskArtifacts: packetEvidence.taskArtifacts || null,
  };
}

function collectMetrics(input: LooseObject, packetEvidence: LooseObject): LooseObject {
  return {
    ...objectValue(input.metrics),
    ...objectValue(objectValue(input.run)?.metrics),
    ...objectValue(objectValue(input.run)?.parsedMetrics),
    ...objectValue(objectValue(input.decision)?.metrics),
    ...objectValue(objectValue(input.decision)?.parsedMetrics),
    ...objectValue(packetEvidence.metrics),
    ...objectValue(packetEvidence.parsedMetrics),
  };
}

function missingQualityScore({
  input,
  packetEvidence,
  run,
  decision,
  metrics,
  text,
}: {
  input: LooseObject;
  packetEvidence: LooseObject;
  run: LooseObject;
  decision: LooseObject;
  metrics: LooseObject;
  text: string;
}): boolean {
  if (booleanValue(metrics.missing_quality_score || input.missingQualityScore)) return true;
  if (!hasPacketDiagnosticEvidence({ input, packetEvidence, run, decision, metrics, text })) {
    return false;
  }
  if (/missing[_ -]?quality[_ -]?score|no quality score|quality score missing/i.test(text)) {
    return true;
  }
  const metricName = stringValue(
    input.metricName || input.primaryMetricName || objectValue(input.config)?.metricName,
  );
  if (metricName && numberValue(metrics[metricName]) != null) return false;
  const expectedQuality =
    booleanValue(input.expectedQualityScore) ||
    /quality|citation_recall|claim_recall|file_recall|symbol_recall/.test(metricName);
  if (!expectedQuality) return false;
  return qualityMetric(metrics, metricName) == null;
}

function markedSufficientButFailed({
  input,
  packetEvidence,
  metrics,
  text,
}: {
  input: LooseObject;
  packetEvidence: LooseObject;
  metrics: LooseObject;
  text: string;
}): boolean {
  if (
    booleanValue(
      metrics.marked_sufficient_but_failed ||
        metrics.sufficient_quality_mismatch ||
        input.markedSufficientButFailed,
    )
  ) {
    return true;
  }
  const sufficient =
    booleanValue(metrics.sufficient) ||
    booleanValue(metrics.marked_sufficient) ||
    booleanValue(packetEvidence.sufficient) ||
    /\bsufficient\b/i.test(text);
  if (!sufficient) return false;
  if (booleanValue(metrics.quality_pass) === false || booleanValue(metrics.quality_failed)) {
    return true;
  }
  const qualityGap = numberValue(metrics.quality_gap);
  if (qualityGap != null) return qualityGap > 0;
  const quality = numberValue(metrics.quality);
  const threshold = numberValue(input.qualityThreshold) ?? 1;
  return quality != null && quality < threshold;
}

function lostInSynthesisOrCitation(metrics: LooseObject): boolean {
  const symbolRecall = numberValue(metrics.symbol_recall || metrics.observed_symbol_recall);
  if (symbolRecall == null || symbolRecall < 0.75) return false;
  const fileRecall = numberValue(metrics.file_recall || metrics.expected_file_recall);
  const claimRecall = numberValue(metrics.claim_recall);
  const citationRecall = numberValue(metrics.citation_recall || metrics.citation_coverage);
  return [fileRecall, claimRecall, citationRecall].some((value) => value != null && value < 0.5);
}

function retrievedButNotCited({
  input,
  packetEvidence,
  metrics,
}: {
  input: LooseObject;
  packetEvidence: LooseObject;
  metrics: LooseObject;
}): boolean {
  if (!hasRetrievalSignal({ input, packetEvidence, metrics })) return false;
  const citationRecall = numberValue(metrics.citation_recall || metrics.citation_coverage);
  const claimRecall = numberValue(metrics.claim_recall);
  const fileRecall = numberValue(metrics.file_recall);
  return [citationRecall, claimRecall, fileRecall].some((value) => value != null && value < 0.5);
}

function hasRetrievalSignal({
  input,
  packetEvidence,
  metrics,
}: {
  input: LooseObject;
  packetEvidence: LooseObject;
  metrics: LooseObject;
}): boolean {
  const retrievalCount = firstNumber(
    metrics.retrieval_hits,
    metrics.retrieved_count,
    metrics.retrieval_count,
    input.retrievalHits,
    packetEvidence.retrievalHits,
    packetEvidence.retrievedCount,
  );
  if (retrievalCount != null && retrievalCount > 0) return true;
  if (numberValue(metrics.symbol_recall || metrics.observed_symbol_recall) != null) return true;
  return [
    packetEvidence.retrieved,
    packetEvidence.retrievals,
    packetEvidence.searchResults,
    input.packetEvidence,
  ].some((value) => Array.isArray(value) && value.length > 0);
}

function qualityMetric(metrics: LooseObject, metricName = ""): number | null {
  return firstNumber(
    metricName ? metrics[metricName] : null,
    metrics.quality_gap,
    metrics.quality,
    metrics.quality_score,
    metrics.citation_recall,
    metrics.claim_recall,
    metrics.file_recall,
    metrics.symbol_recall,
  );
}

function hasPacketDiagnosticEvidence({
  input,
  packetEvidence,
  run,
  decision,
  metrics,
  text,
}: {
  input: LooseObject;
  packetEvidence: LooseObject;
  run: LooseObject;
  decision: LooseObject;
  metrics: LooseObject;
  text: string;
}): boolean {
  if (text.trim()) return true;
  if (Object.keys(packetEvidence).length > 0) return true;
  if (Object.keys(run).length > 0) return true;
  if (Object.keys(decision).length > 0) return true;
  if (Object.keys(metrics).length > 0 && input.packetEvidence != null) return true;
  return false;
}

function addStage(
  stages: PacketDiagnosticStage[],
  reasons: string[],
  stage: PacketDiagnosticStage,
  reason: string,
): void {
  if (stages.includes(stage)) return;
  stages.push(stage);
  reasons.push(reason);
}

function objectValue(value: unknown): LooseObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseObject)
    : null;
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    if (/^(true|yes|1|pass|passed|sufficient)$/i.test(value.trim())) return true;
    if (/^(false|no|0|fail|failed|insufficient)$/i.test(value.trim())) return false;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
