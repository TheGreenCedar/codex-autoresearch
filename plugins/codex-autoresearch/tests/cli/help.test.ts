import assert from "node:assert/strict";
import test from "node:test";

import { renderCliHelp } from "../../lib/cli/help.js";
import {
  CliUsageError,
  parseAutoresearchCliArgs,
  parseFinalizerCliArgs,
} from "../../lib/cli/options.js";

test("default help leads with the short happy path", () => {
  const help = renderCliHelp();

  assert.match(help, /setup -> doctor -> next -> log -> state -> finalize-preview/);
  assert.match(help, /Read-only planning:/);
  assert.match(help, /setup-plan --cwd <project>/);
  assert.match(help, /prompt-plan --cwd <project>/);
  assert.match(help, /node scripts\/autoresearch\.mjs setup --cwd <project>/);
  assert.match(help, /ledger-doctor --cwd <project> \[--json\] \[--repair --yes\]/);
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
  assert.match(help, /research-start --cwd <project> .*--skip-init/);
  assert.match(help, /clear --cwd <project>/);
  assert.match(help, /ledger-doctor --cwd <project> \[--json\] \[--repair --yes\]/);
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

test("command help is scoped to the requested command", () => {
  const help = renderCliHelp({ command: "setup" });

  assert.match(help, /Command: setup/);
  assert.match(help, /autoresearch\.mjs setup --cwd <project>/);
  assert.match(help, /-h, --help/);
  assert.doesNotMatch(help, /autoresearch\.mjs setup-plan/);
  assert.doesNotMatch(help, /autoresearch\.mjs state/);
});

test("every option in full command help is accepted by the strict parser", () => {
  const commandLines = renderCliHelp({ all: true })
    .split("\n")
    .filter((line) => line.includes("node scripts/autoresearch.mjs "));

  for (const line of commandLines) {
    const command = line.match(/autoresearch\.mjs ([a-z0-9-]+)/)?.[1];
    assert.ok(command, `command should be readable from ${line}`);
    for (const match of line.matchAll(/--([a-z][a-z0-9-]*)/g)) {
      const flag = `--${match[1]}=true`;
      assert.doesNotThrow(
        () => parseAutoresearchCliArgs([command, flag]),
        `${command} should accept documented option ${flag}`,
      );
    }
  }
});

test("typed CLI parsing preserves aliases, repeated lists, booleans, and separators", () => {
  const setup = parseAutoresearchCliArgs([
    "setup",
    "--metricName",
    "latency",
    "--files-in-scope",
    "src/a.ts,src/b.ts",
    "--filesInScope",
    "src/c.ts",
    "--benchmark-prints-metric=false",
  ]);

  assert.equal(setup.metricName, "latency");
  assert.deepEqual(setup.filesInScope, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(setup.benchmarkPrintsMetric, false);

  const windowsCommand = String.raw`C:\Program Files\bench\run.mjs`;
  const run = parseAutoresearchCliArgs([
    "run",
    "--cwd",
    String.raw`C:\work trees\sample`,
    "--allow-fixed-control-rerun",
    "true",
    "--",
    "node",
    windowsCommand,
    "--label=value with spaces",
  ]);

  assert.equal(run.cwd, String.raw`C:\work trees\sample`);
  assert.equal(run.allowFixedControlRerun, true);
  assert.deepEqual(run._, ["run", "node", windowsCommand, "--label=value with spaces"]);

  const compatibilityCases = [
    {
      args: ["log", "--metric", "-2", "--status", "measure"],
      expected: { metric: "-2" },
      label: "negative option values",
    },
    {
      args: ["research-start", "--slug", "round-one", "--no-baseline-log=false"],
      expected: { noBaselineLog: false, slug: "round-one" },
      label: "existing no-prefix forms",
    },
    {
      args: ["quality-gap", "--researchSlug", "round-two"],
      expected: { researchSlug: "round-two" },
      label: "research camel aliases",
    },
    {
      args: [
        "finalize-current-tree",
        "--includeSessionArtifacts=true",
        "--exclude-session-artifacts=false",
      ],
      expected: { excludeSessionArtifacts: false, includeSessionArtifacts: true },
      label: "finalizer camel and kebab aliases",
    },
    {
      args: ["setup-plan", "--shell", "powershell", "--compact=true"],
      expected: { compact: true, shell: "powershell" },
      label: "setup CLI-only options",
    },
  ];

  for (const compatibility of compatibilityCases) {
    const parsed = parseAutoresearchCliArgs(compatibility.args);
    for (const [key, value] of Object.entries(compatibility.expected)) {
      assert.deepEqual(parsed[key], value, compatibility.label);
    }
  }
});

test("typed CLI parsing rejects unknown options and invalid boolean strings", () => {
  assert.throws(
    () => parseAutoresearchCliArgs(["state", "--bogus"]),
    (error) =>
      error instanceof CliUsageError && error.command === "state" && /bogus/.test(error.message),
  );
  assert.throws(
    () => parseAutoresearchCliArgs(["--bogus"]),
    (error) =>
      error instanceof CliUsageError && error.command === null && /bogus/.test(error.message),
  );
  assert.throws(
    () => parseAutoresearchCliArgs(["state", "--compact=perhaps"]),
    (error) =>
      error instanceof CliUsageError &&
      error.command === "state" &&
      /boolean value/.test(error.message),
  );
  assert.throws(
    () => parseAutoresearchCliArgs(["lane-runner", "--allow-non-git-command"]),
    (error) => error instanceof CliUsageError && /allow-non-git-command/.test(error.message),
  );
});

test("typed CLI parsing supports root and command short help", () => {
  assert.equal(parseAutoresearchCliArgs(["-h"]).help, true);
  const commandHelp = parseAutoresearchCliArgs(["state", "-h"]);
  assert.equal(commandHelp.help, true);
  assert.deepEqual(commandHelp._, ["state"]);

  const prefixedHelp = parseAutoresearchCliArgs(["--debug", "--all", "help", "state"]);
  assert.equal(prefixedHelp.debug, true);
  assert.equal(prefixedHelp.all, true);
  assert.deepEqual(prefixedHelp._, ["help", "state"]);

  assert.throws(
    () => parseAutoresearchCliArgs(["state", "--debug", "nonsense"]),
    (error) =>
      error instanceof CliUsageError && /debug expects a boolean value/i.test(error.message),
  );
});

test("finalizer parsing preserves leading booleans before its first positional", () => {
  assert.deepEqual(parseFinalizerCliArgs(["--help", "plan"]), {
    _: ["plan"],
    help: true,
  });
  assert.deepEqual(parseFinalizerCliArgs(["--debug", "plan"]), {
    _: ["plan"],
    debug: true,
  });
  assert.deepEqual(parseFinalizerCliArgs(["--debug", "groups.json"]), {
    _: ["groups.json"],
    debug: true,
  });
  assert.throws(
    () => parseFinalizerCliArgs(["plan", "--collapse-overlap", "maybe"]),
    (error) => error instanceof CliUsageError && /boolean value/.test(error.message),
  );
  assert.throws(
    () => parseFinalizerCliArgs(["--collapse-overlap", "maybe", "plan"]),
    (error) => error instanceof CliUsageError && /boolean value/.test(error.message),
  );
});
