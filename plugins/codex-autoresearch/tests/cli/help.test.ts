import assert from "node:assert/strict";
import test from "node:test";

import { renderCliHelp } from "../../lib/cli/help.js";

test("default help leads with the short happy path", () => {
  const help = renderCliHelp();

  assert.match(help, /setup -> doctor -> next -> log -> state -> finalize-preview/);
  assert.match(help, /Read-only planning:/);
  assert.match(help, /setup-plan --cwd <project>/);
  assert.match(help, /prompt-plan --cwd <project>/);
  assert.match(help, /node scripts\/autoresearch\.mjs setup --cwd <project>/);
  assert.match(help, /setup-plan --cwd <project> .*--direction lower\|higher/);
  assert.match(help, /setup --cwd <project> .*--direction lower\|higher/);
  assert.match(help, /node scripts\/autoresearch\.mjs finalize-preview --cwd <project>/);
  assert.ok(help.indexOf("setup-plan --cwd <project>") < help.indexOf("setup --cwd <project>"));
  assert.ok(help.indexOf("prompt-plan --cwd <project>") < help.indexOf("setup --cwd <project>"));
  assert.match(help, /Run `--help --all` for advanced diagnostics and maintainer commands\./);
  assert.doesNotMatch(help, /codex-goal-brief/);
  assert.doesNotMatch(help, /clear --cwd/);
});

test("full help preserves advanced and maintainer commands", () => {
  const help = renderCliHelp({ all: true });

  assert.match(help, /codex-goal-brief/);
  assert.match(help, /session-forensics/);
  assert.match(help, /finalize-current-tree/);
  assert.match(help, /Current-tree finalization:/);
  assert.match(help, /clean Git-backed non-trunk source branch/);
  assert.match(help, /session artifacts are excluded by default/);
  assert.match(help, /setup-plan --cwd <project> .*--direction lower\|higher/);
  assert.match(help, /setup --cwd <project> .*--direction lower\|higher/);
  assert.match(help, /clear --cwd <project>/);
  assert.doesNotMatch(help, /Run `--help --all`/);
});

test("full help documents fixed-control rerun overrides on guarded commands", () => {
  const help = renderCliHelp({ all: true });
  for (const command of ["run", "next", "doctor", "benchmark-inspect", "benchmark-lint"]) {
    const usageLine = help
      .split("\n")
      .find((line) => line.includes(`node scripts/autoresearch.mjs ${command} --cwd <project>`));

    assert.ok(usageLine, `${command} usage line should be present`);
    assert.match(usageLine, /--allow-fixed-control-rerun/);
  }
});

test("full help documents shared setup guardrails for guide", () => {
  const help = renderCliHelp({ all: true });
  const guideLine = help
    .split("\n")
    .find((line) => line.includes("node scripts/autoresearch.mjs guide --cwd <project>"));

  assert.ok(guideLine, "guide usage line should be present");
  for (const flag of [
    "--protected-benchmark-paths",
    "--secondary-metric-constraints",
    "--secondary-metric-constraint-mode",
    "--packet-budget",
    "--wall-clock-budget-seconds",
    "--budget-note",
  ]) {
    assert.match(guideLine, new RegExp(flag));
  }
});
