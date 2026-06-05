import assert from "node:assert/strict";
import test from "node:test";

import { renderCliHelp } from "../../lib/cli/help.js";

test("default help leads with the short happy path", () => {
  const help = renderCliHelp();

  assert.match(help, /setup -> doctor -> next -> log -> state -> finalize-preview/);
  assert.match(help, /node scripts\/autoresearch\.mjs setup --cwd <project>/);
  assert.match(help, /node scripts\/autoresearch\.mjs finalize-preview --cwd <project>/);
  assert.match(help, /Run `--help --all` for advanced diagnostics and maintainer commands\./);
  assert.doesNotMatch(help, /codex-goal-brief/);
  assert.doesNotMatch(help, /clear --cwd/);
});

test("full help preserves advanced and maintainer commands", () => {
  const help = renderCliHelp({ all: true });

  assert.match(help, /codex-goal-brief/);
  assert.match(help, /session-forensics/);
  assert.match(help, /finalize-current-tree/);
  assert.match(help, /clear --cwd <project>/);
  assert.doesNotMatch(help, /Run `--help --all`/);
});
