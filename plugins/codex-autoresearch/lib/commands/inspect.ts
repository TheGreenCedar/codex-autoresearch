import type { ShellRunResult } from "../runner.js";

type LooseObject = Record<string, any>;

export interface InspectCommandDeps {
  currentState: (workDir: string) => LooseObject;
  defaultBenchmarkCommand: (workDir: string) => Promise<string>;
  finiteMetric: (value: unknown) => number | null;
  headText: (text: string, maxLines?: number, maxBytes?: number) => string;
  metricParseSource: (result: LooseObject) => string;
  numberOption: (value: unknown, fallback: number) => number;
  parseMetricLines: (output: string) => Record<string, number>;
  resolveWorkDir: (value: string) => { workDir: string; config: LooseObject };
  runShell: (
    command: string,
    cwd: string,
    timeoutSeconds: number,
    options?: LooseObject,
  ) => Promise<ShellRunResult>;
  validateMetricName: (name: string) => string;
}

export function createInspectCommands(deps: InspectCommandDeps) {
  async function benchmarkLint(args: LooseObject) {
    const { workDir } = deps.resolveWorkDir(args.working_dir || args.cwd);
    const state = deps.currentState(workDir);
    const metricName = deps.validateMetricName(
      args.metric_name || args.metricName || state.config.metricName || "metric",
    );
    let sample = args.sample || "";
    let commandResult = null;
    const timeoutSeconds = deps.numberOption(args.timeout_seconds ?? args.timeoutSeconds, 60);
    if (!sample) {
      const command = args.command || (await deps.defaultBenchmarkCommand(workDir));
      if (command) {
        commandResult = await deps.runShell(command, workDir, timeoutSeconds, {
          retainMetricNames: [metricName],
        });
        sample = deps.metricParseSource(commandResult);
      }
    }
    const parsedMetrics = deps.parseMetricLines(sample);
    const emitsPrimary = deps.finiteMetric(parsedMetrics[metricName]) != null;
    const issues = [];
    const warnings = [];
    if (!sample) {
      issues.push("No sample output, command, or default autoresearch script was available.");
    } else if (!Object.keys(parsedMetrics).length) {
      issues.push("No METRIC name=value lines were parsed.");
    } else if (!emitsPrimary) {
      issues.push(`Primary metric METRIC ${metricName}=<number> was not emitted.`);
    }
    if (commandResult && (commandResult.exitCode !== 0 || commandResult.timedOut)) {
      issues.push(
        `Benchmark command failed during lint: exit ${commandResult.exitCode ?? "none"}${commandResult.timedOut ? " (timed out)" : ""}.`,
      );
      if (commandResult.timedOut && !Object.keys(parsedMetrics).length) {
        warnings.push(
          "Lint timed out before METRIC output. Prefer linting a generated wrapper, artifact/sample mode, or rerun with --timeout-seconds only after bounding the workload.",
        );
      }
    }
    if (Object.keys(parsedMetrics).length > 20) {
      warnings.push("Benchmark emits many metrics; keep the primary metric obvious and stable.");
    }
    return {
      ok: issues.length === 0,
      workDir,
      metricName,
      checkedCommand: commandResult?.command || args.command || "",
      parsedMetrics,
      emitsPrimary,
      issues,
      warnings,
      timeoutSeconds: commandResult ? timeoutSeconds : null,
      contractCheckHint:
        "Use --sample for pure parser checks, or lint the generated autoresearch wrapper after setup when the raw workload is expensive.",
      example: `METRIC ${metricName}=1.23`,
      nextAction: issues.length
        ? commandResult?.timedOut
          ? `Bound the benchmark or use a sample/artifact-mode lint before running full packets; then prove METRIC ${metricName}=<number>.`
          : `Update the benchmark so it prints METRIC ${metricName}=<number>.`
        : "Benchmark output satisfies the metric contract.",
    };
  }

  async function benchmarkInspect(args: LooseObject) {
    const { workDir } = deps.resolveWorkDir(args.working_dir || args.cwd);
    const state = deps.currentState(workDir);
    const command = String(args.command || "").trim();
    const timeoutSeconds = Math.max(
      1,
      deps.numberOption(args.timeout_seconds ?? args.timeoutSeconds, 5),
    );
    const warnings = benchmarkInspectWarnings(command);
    if (!command) {
      return {
        ok: true,
        workDir,
        ranCommand: false,
        command: "",
        timeoutSeconds: null,
        parsedMetrics: {},
        outputPreview: "",
        warnings,
        hints: benchmarkInspectHints(state.config.metricName || ""),
        nextAction:
          "Run benchmark-inspect with the benchmark's list/artifact command before any expensive full packet.",
      };
    }
    const result = await deps.runShell(command, workDir, timeoutSeconds, {
      retainMetricNames: [state.config.metricName].filter(Boolean),
    });
    const output = deps.metricParseSource(result) || result.fullOutput || result.output || "";
    const parsedMetrics = deps.parseMetricLines(output);
    const timedOutBeforeMetric = result.timedOut && Object.keys(parsedMetrics).length === 0;
    if (timedOutBeforeMetric) {
      warnings.push(
        "The inspect command timed out before any METRIC output. Use a benchmark-specific list/dry-run/artifact mode before running the full packet.",
      );
    }
    if (result.exitCode !== 0 && !result.timedOut) {
      warnings.push(
        `The inspect command exited ${result.exitCode}; verify the command is a bounded probe.`,
      );
    }
    return {
      ok: !result.timedOut && result.exitCode === 0,
      workDir,
      ranCommand: true,
      command: result.command,
      timeoutSeconds,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      parsedMetrics,
      outputPreview: deps.headText(output || result.fullOutput || result.output || "", 30, 12000),
      outputTruncated: Boolean(result.outputTruncated || result.fullOutputTruncated),
      warnings,
      hints: benchmarkInspectHints(state.config.metricName || ""),
      nextAction:
        result.timedOut || result.exitCode !== 0
          ? "Switch to a bounded list/dry-run/artifact command, then lint the metric contract."
          : "If this is bounded and representative, run benchmark-lint or the first compact next packet.",
    };
  }

  async function checksInspect(args: LooseObject) {
    const { workDir } = deps.resolveWorkDir(args.working_dir || args.cwd);
    const command = String(args.command || args.checks_command || args.checksCommand || "").trim();
    const timeoutSeconds = Math.max(
      1,
      deps.numberOption(args.timeout_seconds ?? args.timeoutSeconds, 60),
    );
    if (!command) {
      return {
        ok: true,
        workDir,
        ranCommand: false,
        command: "",
        timeoutSeconds: null,
        exitCode: null,
        timedOut: false,
        failedTests: [],
        warnings: ["No checks command was provided."],
        hints: checksInspectHints(),
        outputPreview: "",
        nextAction:
          "Run checks-inspect with the exact correctness command before treating a failed suite as evidence.",
      };
    }
    const result = await deps.runShell(command, workDir, timeoutSeconds);
    const output = result.fullOutput || result.output || "";
    const failedTests = extractFailedTests(output);
    const warnings = checksInspectWarnings(command, output, result, failedTests);
    return {
      ok: !result.timedOut && result.exitCode === 0,
      workDir,
      ranCommand: true,
      command: result.command,
      timeoutSeconds,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      failedTests,
      warnings,
      hints: checksInspectHints(),
      outputPreview: deps.headText(output, 50, 16000),
      outputTruncated: Boolean(result.outputTruncated || result.fullOutputTruncated),
      nextAction:
        result.timedOut || result.exitCode !== 0
          ? "Fix command-shape problems first, then separate touched-path failures from broader suite failures before logging checks_failed."
          : "Checks command completed cleanly; include it as verification evidence before logging or finalizing.",
    };
  }

  return { benchmarkLint, benchmarkInspect, checksInspect };
}

function benchmarkInspectWarnings(command) {
  const warnings = [];
  if (!command) return warnings;
  if (/CODESTORY_PIPELINE_LIST_CASES\s*=\s*1/i.test(command)) {
    warnings.push(
      "This looks like the wrong CodeStory list flag seen in onboarding; use CODESTORY_EMBED_RESEARCH_LIST=1 for the current pipeline list mode.",
    );
  }
  if (!/(LIST|DRY|INSPECT|SAMPLE|ARTIFACT|LIMIT|COUNT|HELP)/i.test(command)) {
    warnings.push(
      "Command does not advertise an obvious list/dry-run/sample bound. Confirm it will not start the full benchmark.",
    );
  }
  return warnings;
}

function benchmarkInspectHints(metricName = "") {
  return [
    "Prefer a benchmark-native list, dry-run, sample, artifact, or small-count mode before a full packet.",
    "Use benchmark-lint --sample for pure METRIC parser checks when the raw command is expensive.",
    metricName
      ? `The primary contract remains METRIC ${metricName}=<number>.`
      : "After setup, the primary contract is METRIC <name>=<number>.",
    "For the CodeStory parse/index/embed pipeline, the known case-list switch is CODESTORY_EMBED_RESEARCH_LIST=1.",
  ];
}

function checksInspectWarnings(command, output, result, failedTests) {
  const warnings = [];
  if (result.timedOut) {
    warnings.push(
      "The checks command timed out. Narrow it to touched paths or increase the timeout before using it as decision evidence.",
    );
  }
  if (cargoUnexpectedArgument(output)) {
    warnings.push(
      "Cargo rejected the check command shape. cargo test accepts one name filter per invocation; run separate exact filters or a package target such as --lib.",
    );
  }
  if (/cargo(?:\.exe)?\s+test/i.test(command) && looksLikeMultipleCargoFilters(command)) {
    warnings.push(
      "This cargo test command appears to include multiple name filters before --; prefer separate exact test invocations or a broader target filter.",
    );
  }
  if (failedTests.length > 1) {
    warnings.push(
      `${failedTests.length} tests failed. Classify touched-path failures separately from pre-existing or broad-suite failures before deciding keep/discard/checks_failed.`,
    );
  } else if (failedTests.length === 1) {
    warnings.push(
      `One test failed: ${failedTests[0]}. Confirm whether it is caused by the current packet before logging checks_failed.`,
    );
  }
  if (result.exitCode !== 0 && !result.timedOut && failedTests.length === 0) {
    warnings.push(
      `The checks command exited ${result.exitCode} without a parsed failed-test list; inspect the output for setup, command, or environment failure.`,
    );
  }
  return warnings;
}

function cargoUnexpectedArgument(output = "") {
  return (
    /unexpected argument ['"`][^'"`]+['"`] found/i.test(output) &&
    /Usage:\s+cargo(?:\.exe)? test/i.test(output)
  );
}

function looksLikeMultipleCargoFilters(command = "") {
  const beforeHarnessArgs = String(command).split(/\s+--\s+/)[0];
  const tokens: string[] = beforeHarnessArgs.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const testIndex = tokens.findIndex(
    (token, index) => token.replace(/['"]/g, "") === "test" && index > 0,
  );
  if (testIndex < 0) return false;
  const filters = [];
  for (let index = testIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/^['"]|['"]$/g, "");
    if (!token || token.startsWith("-")) {
      if (token === "-p" || token === "--package" || token === "--manifest-path") index += 1;
      continue;
    }
    filters.push(token);
  }
  return filters.length > 1;
}

function extractFailedTests(output = "") {
  const tests = [];
  const seen = new Set();
  const patterns = [
    /test\s+([^\s]+)\s+\.\.\.\s+FAILED/g,
    /^\s*([A-Za-z0-9_:.-]+)\s+---\s+FAILED/gm,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output))) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        tests.push(name);
      }
    }
  }
  return tests.slice(0, 20);
}

function checksInspectHints() {
  return [
    "For Cargo, do not pass multiple test name filters in one cargo test invocation.",
    "Use separate exact filters for touched tests, or a broader package target when the goal is suite health.",
    "If a broad suite fails, record which failures are touched-path, pre-existing, or environment-related before logging checks_failed.",
  ];
}
