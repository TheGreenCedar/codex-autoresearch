import assert from "node:assert/strict";
import test from "node:test";

import { gitRefComponent } from "../../lib/git-ref.js";

test("git ref components remove trailing dots and lock suffixes", () => {
  assert.equal(gitRefComponent("Diagnostic cleanup."), "diagnostic-cleanup");
  assert.equal(gitRefComponent("Final review.lock"), "final-review-lock");
  assert.equal(gitRefComponent("..lock"), "lock");
});

test("shortened git ref components retain stable uniqueness", () => {
  const sharedPrefix = "a".repeat(120);
  const first = gitRefComponent(`${sharedPrefix}-first`, { maxLength: 48 });
  const second = gitRefComponent(`${sharedPrefix}-second`, { maxLength: 48 });

  assert.equal(first.length, 48);
  assert.equal(second.length, 48);
  assert.notEqual(first, second);
  assert.equal(first, gitRefComponent(`${sharedPrefix}-first`, { maxLength: 48 }));
  assert.doesNotMatch(first, /\.$|\.lock$/i);
});
