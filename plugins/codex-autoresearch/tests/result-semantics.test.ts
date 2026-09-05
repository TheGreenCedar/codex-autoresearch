import { formatCliJson } from "../lib/cli-json.js";
import assert from "node:assert/strict";
import test from "node:test";
import { classifyResult, isResultSemantics } from "../lib/result-semantics.js";

test("valid counterexamples, invalid measurements, and inconclusive observations are distinct", () => {
  const negative = classifyResult({ kind: "predicate", observed: "counterexample" }, "rejected");
  assert.equal(negative.execution, "completed");
  assert.equal(negative.validity, "valid");
  assert.equal(negative.conclusion, "refuted");
  assert.equal(negative.attainment, "unsatisfied");
  assert.equal(negative.movement, "unknown");
  const invalid = classifyResult({ kind: "invalid", execution: "failed" });
  assert.equal(invalid.validity, "invalid");
  assert.equal(invalid.conclusion, "inconclusive");
  const uncertain = classifyResult({ kind: "predicate", observed: "inconclusive" });
  assert.equal(uncertain.validity, "valid");
  assert.equal(uncertain.attainment, "unknown");
  for (const result of [negative, invalid, uncertain]) assert.ok(isResultSemantics(result));
});

test("metric improvement below target neither attains the criterion nor accepts code", () => {
  const result = classifyResult({
    kind: "metric",
    value: 80,
    reference: 70,
    direction: "higher",
    minimumImprovement: 2,
    tolerance: 1,
    target: { comparator: ">=", value: 90 },
  });
  assert.equal(result.movement, "improved");
  assert.equal(result.attainment, "unsatisfied");
  assert.equal(result.codeAcceptance, "unassessed");
  assert.equal(result.conclusion, "inconclusive");
  const attained = classifyResult({
    kind: "metric",
    value: 95,
    reference: null,
    direction: "higher",
    minimumImprovement: 0,
    tolerance: 0,
    target: { comparator: ">=", value: 90 },
  });
  assert.equal(attained.movement, "unknown");
  assert.equal(attained.attainment, "satisfied");
  assert.equal(attained.codeAcceptance, "unassessed");
});

test("nonfinite metric evidence cannot satisfy a target or establish movement", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const result = classifyResult({
      kind: "metric",
      value,
      reference: 1,
      direction: "higher",
      minimumImprovement: 0,
      tolerance: 0,
      target: { comparator: ">=", value: 0 },
    });
    assert.equal(result.validity, "invalid");
    assert.equal(result.attainment, "unknown");
    assert.equal(result.movement, "unknown");
  }
});

test("result dimensions reject coerced JSON values", () => {
  const result = classifyResult({ kind: "predicate", observed: "counterexample" });
  for (const key of Object.keys(result))
    for (const malformed of [["valid"], [result[key as keyof typeof result]], 0, null, {}, true])
      assert.equal(isResultSemantics({ ...result, [key]: malformed }), false, key);
});

test("compact result formatting preserves independent dimensions and ordinary JSON values", () => {
  const value = {
    result: classifyResult({ kind: "predicate", observed: "counterexample" }),
    history: [null, { text: 'quoted " text', count: 1 }],
    empty: {},
  };
  assert.deepEqual(JSON.parse(formatCliJson(value)), value);
  assert.equal(formatCliJson({ result: value.result }).split("\n").length, 3);
});
