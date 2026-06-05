import { type UnknownRecord, unknownRecordOrEmpty } from "./types/json.js";

export interface DecisionThresholdConfig {
  compactions: number;
  goalTokensUsed: number;
  goalTimeUsedSeconds: number;
  functionCalls: number;
  shellPolls: number;
  rejectedOrRegressedRunsInFamily: number;
  repeatedSmallProbeWindow: number;
  repeatedSmallProbeMinimum: number;
  shelfRelativeEpsilon: number;
  outputCommandTokenBudget: number;
  outputCommandLineBudget: number;
  outputSegmentTokenBudget: number;
  repeatedCommandHeadCount: number;
  repeatedCheckHeadCount: number;
  segmentVisibleLabelChars: number;
}

export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholdConfig = {
  compactions: 3,
  goalTokensUsed: 1_000_000,
  goalTimeUsedSeconds: 14_400,
  functionCalls: 500,
  shellPolls: 50,
  rejectedOrRegressedRunsInFamily: 3,
  repeatedSmallProbeWindow: 6,
  repeatedSmallProbeMinimum: 4,
  shelfRelativeEpsilon: 0.001,
  outputCommandTokenBudget: 20_000,
  outputCommandLineBudget: 500,
  outputSegmentTokenBudget: 100_000,
  repeatedCommandHeadCount: 10,
  repeatedCheckHeadCount: 5,
  segmentVisibleLabelChars: 48,
};

export function resolveDecisionThresholds(config: UnknownRecord = {}): DecisionThresholdConfig {
  const nested = unknownRecordOrEmpty(config.decisionThresholds);
  const merged = { ...config, ...nested };
  return {
    compactions: positiveInt(merged.compactions, DEFAULT_DECISION_THRESHOLDS.compactions),
    goalTokensUsed: positiveInt(merged.goalTokensUsed, DEFAULT_DECISION_THRESHOLDS.goalTokensUsed),
    goalTimeUsedSeconds: positiveInt(
      merged.goalTimeUsedSeconds,
      DEFAULT_DECISION_THRESHOLDS.goalTimeUsedSeconds,
    ),
    functionCalls: positiveInt(merged.functionCalls, DEFAULT_DECISION_THRESHOLDS.functionCalls),
    shellPolls: positiveInt(merged.shellPolls, DEFAULT_DECISION_THRESHOLDS.shellPolls),
    rejectedOrRegressedRunsInFamily: positiveInt(
      merged.rejectedOrRegressedRunsInFamily,
      DEFAULT_DECISION_THRESHOLDS.rejectedOrRegressedRunsInFamily,
    ),
    repeatedSmallProbeWindow: positiveInt(
      merged.repeatedSmallProbeWindow,
      DEFAULT_DECISION_THRESHOLDS.repeatedSmallProbeWindow,
    ),
    repeatedSmallProbeMinimum: positiveInt(
      merged.repeatedSmallProbeMinimum,
      DEFAULT_DECISION_THRESHOLDS.repeatedSmallProbeMinimum,
    ),
    shelfRelativeEpsilon: positiveNumber(
      merged.shelfRelativeEpsilon,
      DEFAULT_DECISION_THRESHOLDS.shelfRelativeEpsilon,
    ),
    outputCommandTokenBudget: positiveInt(
      merged.outputCommandTokenBudget,
      DEFAULT_DECISION_THRESHOLDS.outputCommandTokenBudget,
    ),
    outputCommandLineBudget: positiveInt(
      merged.outputCommandLineBudget,
      DEFAULT_DECISION_THRESHOLDS.outputCommandLineBudget,
    ),
    outputSegmentTokenBudget: positiveInt(
      merged.outputSegmentTokenBudget,
      DEFAULT_DECISION_THRESHOLDS.outputSegmentTokenBudget,
    ),
    repeatedCommandHeadCount: positiveInt(
      merged.repeatedCommandHeadCount,
      DEFAULT_DECISION_THRESHOLDS.repeatedCommandHeadCount,
    ),
    repeatedCheckHeadCount: positiveInt(
      merged.repeatedCheckHeadCount,
      DEFAULT_DECISION_THRESHOLDS.repeatedCheckHeadCount,
    ),
    segmentVisibleLabelChars: positiveInt(
      merged.segmentVisibleLabelChars,
      DEFAULT_DECISION_THRESHOLDS.segmentVisibleLabelChars,
    ),
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
