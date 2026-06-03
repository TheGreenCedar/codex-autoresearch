import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLaneBrief, summarizeLaneLessons, type LaneBrief } from "../lib/lane-briefs.js";

const fallbackBrief: LaneBrief = {
  objective: "Fallback objective",
  evidencePoint: "Fallback evidence point",
  boundaries: ["fallback boundary"],
  pointers: ["fallback pointer"],
  expectedDecisionOutput: "Fallback decision output",
  lessonsToAvoid: ["fallback lesson"],
};

test("normalizeLaneBrief keeps input fields and falls back for missing list fields", () => {
  const normalized = normalizeLaneBrief(
    {
      objective: "Clarify the decision gate",
      evidencePoint: "Cite the latest packet evidence",
      boundaries: ["no dashboard mutation controls", "keep METRIC name=value"],
      pointers: ["autoresearch.md", "autoresearch.jsonl"],
      expectedDecisionOutput: "A concise next-action recommendation",
    },
    fallbackBrief,
  );

  assert.deepEqual(normalized, {
    objective: "Clarify the decision gate",
    evidencePoint: "Cite the latest packet evidence",
    boundaries: ["no dashboard mutation controls", "keep METRIC name=value"],
    pointers: ["autoresearch.md", "autoresearch.jsonl"],
    expectedDecisionOutput: "A concise next-action recommendation",
    lessonsToAvoid: ["fallback lesson"],
  });
});

test("normalizeLaneBrief defaults missing lessonsToAvoid to an empty list", () => {
  const normalized = normalizeLaneBrief(
    { objective: "Keep the lane scoped" },
    { ...fallbackBrief, lessonsToAvoid: [] },
  );

  assert.deepEqual(normalized.lessonsToAvoid, []);
});

test("summarizeLaneLessons extracts concise unique lessons from lane results", () => {
  const lessons = summarizeLaneLessons([
    {
      result: {
        summary: "Keep lane prompts narrow. Extra detail belongs in evidence.",
        recommendation: "Preserve the METRIC name=value contract.",
        lessonsToAvoid: [
          "Do not add dashboard mutation controls.",
          "Keep lane prompts narrow.",
          "  ",
        ],
      },
    },
    {
      summary: "Preserve the METRIC name=value contract. Duplicate detail.",
      recommendation: "Reuse existing command surfaces.",
      lessonsToAvoid: ["Do not add dashboard mutation controls."],
    },
  ]);

  assert.deepEqual(lessons, [
    "Keep lane prompts narrow.",
    "Preserve the METRIC name=value contract.",
    "Do not add dashboard mutation controls.",
    "Reuse existing command surfaces.",
  ]);
});

test("summarizeLaneLessons returns no more than eight strings", () => {
  const lessons = summarizeLaneLessons(
    Array.from({ length: 10 }, (_, index) => ({
      summary: `Lesson ${index + 1} should be retained.`,
    })),
  );

  assert.equal(lessons.length, 8);
  assert.deepEqual(lessons, [
    "Lesson 1 should be retained.",
    "Lesson 2 should be retained.",
    "Lesson 3 should be retained.",
    "Lesson 4 should be retained.",
    "Lesson 5 should be retained.",
    "Lesson 6 should be retained.",
    "Lesson 7 should be retained.",
    "Lesson 8 should be retained.",
  ]);
});
