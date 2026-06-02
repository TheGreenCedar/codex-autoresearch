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
    return fallback.filter((item) => item.trim().length > 0).map((item) => item.trim());
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
