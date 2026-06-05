export interface LaneBrief {
  objective: string;
  evidencePoint: string;
  boundaries: string[];
  pointers: string[];
  expectedDecisionOutput: string;
  lessonsToAvoid: string[];
}

type LaneBriefRecord = Record<string, unknown>;

const MAX_LESSONS = 8;
const MAX_LESSON_LENGTH = 180;
const MAX_RECOMMENDATION_LENGTH = 700;
const MAX_RECOMMENDATION_ITEMS = 5;
const MAX_RECOMMENDATION_ITEM_LENGTH = 220;

export interface BoundedLaneRecommendation {
  summary: string;
  recommendation: string;
  evidence: string[];
  risks: string[];
  approvalRequired: boolean;
  approvalGate: string;
}

export interface BoundedLaneRecommendationInput {
  summary?: unknown;
  recommendation?: unknown;
  evidence?: unknown;
  risks?: unknown;
  fallbackSummary?: string;
  fallbackRecommendation?: string;
}

function isRecord(value: unknown): value is LaneBriefRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return fallback;
}

function normalizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    const split = splitStringList(value);
    const source = split.length > 0 ? split : fallback;
    return source.filter((item) => item.trim().length > 0).map((item) => item.trim());
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizeLaneBrief(input: unknown, fallback: LaneBrief): LaneBrief {
  const record = isRecord(input) ? input : {};

  return {
    objective: normalizeString(record.objective, fallback.objective),
    evidencePoint: normalizeString(record.evidencePoint, fallback.evidencePoint),
    boundaries: normalizeStringList(record.boundaries, fallback.boundaries),
    pointers: normalizeStringList(record.pointers, fallback.pointers),
    expectedDecisionOutput: normalizeString(
      record.expectedDecisionOutput,
      fallback.expectedDecisionOutput,
    ),
    lessonsToAvoid: normalizeStringList(record.lessonsToAvoid, fallback.lessonsToAvoid ?? []),
  };
}

export function normalizeBoundedLaneRecommendation(
  input: BoundedLaneRecommendationInput,
): BoundedLaneRecommendation {
  const summary = boundedText(
    input.summary,
    input.fallbackSummary || "Architecture hypothesis recorded for human review.",
    MAX_RECOMMENDATION_LENGTH,
  );
  const recommendation = boundedText(
    input.recommendation,
    input.fallbackRecommendation ||
      "Ask the operator to approve or reject this architecture direction before implementation.",
    MAX_RECOMMENDATION_LENGTH,
  );
  const evidence = boundedList(input.evidence, [
    "Lane author did not provide separate evidence; read the summary before approving.",
  ]);
  const risks = boundedList(input.risks, [
    "Architecture-scale changes can invalidate local metric evidence and should not start without operator approval.",
  ]);

  return {
    summary,
    recommendation,
    evidence,
    risks,
    approvalRequired: true,
    approvalGate:
      "Human approval is required before any implementation lane or measured packet uses this recommendation.",
  };
}

function conciseLesson(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  const sentence = normalized.match(/^.{1,180}?[.!?](?=\s|$)/)?.[0] ?? normalized;

  if (sentence.length <= MAX_LESSON_LENGTH) {
    return sentence;
  }

  const breakpoint = sentence.lastIndexOf(" ", MAX_LESSON_LENGTH - 3);
  const end = breakpoint > 0 ? breakpoint : MAX_LESSON_LENGTH - 3;
  return `${sentence.slice(0, end).trimEnd()}...`;
}

function canonicalLesson(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .trim();
}

function collectLaneLessonSources(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const sources: string[] = [];
  for (const field of ["summary", "recommendation"] as const) {
    if (typeof value[field] === "string" && value[field].trim().length > 0) {
      sources.push(value[field]);
    }
  }

  if (Array.isArray(value.lessonsToAvoid)) {
    for (const item of value.lessonsToAvoid) {
      if (typeof item === "string" && item.trim().length > 0) {
        sources.push(item);
      }
    }
  }

  return sources;
}

export function summarizeLaneLessons(results: unknown[]): string[] {
  const lessons: string[] = [];
  const seen = new Set<string>();

  for (const item of results) {
    const sources = [
      ...collectLaneLessonSources(item),
      ...(isRecord(item) ? collectLaneLessonSources(item.result) : []),
    ];

    for (const source of sources) {
      const lesson = conciseLesson(source);
      const key = canonicalLesson(lesson);
      if (key.length === 0 || seen.has(key)) {
        continue;
      }

      seen.add(key);
      lessons.push(lesson);
      if (lessons.length >= MAX_LESSONS) {
        return lessons;
      }
    }
  }

  return lessons;
}

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  const text = normalizeString(value, fallback).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }

  const breakpoint = text.lastIndexOf(" ", maxLength - 3);
  const end = breakpoint > 0 ? breakpoint : maxLength - 3;
  return `${text.slice(0, end).trimEnd()}...`;
}

function boundedList(value: unknown, fallback: string[]): string[] {
  const items = normalizeStringList(value, fallback)
    .map((item) => boundedText(item, "", MAX_RECOMMENDATION_ITEM_LENGTH))
    .filter((item) => item.length > 0);
  return items.slice(0, MAX_RECOMMENDATION_ITEMS);
}

function splitStringList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}
