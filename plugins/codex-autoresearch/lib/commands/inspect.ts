import type { UnknownRecord } from "../types/json.js";
import type { ShellRunResult } from "../runner.js";
import { runShell } from "../runner.js";
import { resolveBenchmarkCommandSource } from "../benchmark/command-input.js";
import { fixedControlBlockForCommand, type FixedControlBlock } from "../fixed-control.js";
import { buildResearchIntegrity, commandDiagnostics } from "../truth-signals.js";
import { numberOption } from "../cli/args.js";
import { resolveAuthorizedWorkDir } from "../cli/workdir-context.js";
import { currentState, finiteMetric } from "../session-core.js";
import { parseMetricLines } from "../runner.js";

type InspectShellRunResult = ShellRunResult & { separatorCommand?: boolean };
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const METRIC_NAME_PATTERN = /^[^=\s]+$/;

export async function benchmarkLint(args: UnknownRecord): Promise<UnknownRecord> {
  const { workDir, config } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  const state = currentState(workDir);
  const metricName = validateMetricName(
    args.metric_name || args.metricName || state.config.metricName || "metric",
  );
  let sample = String(args.sample || "");
  let commandResult: InspectShellRunResult | null = null;
  const timeoutSeconds = numberOption(args.timeout_seconds ?? args.timeoutSeconds, 60);
  if (!sample) {
    const commandSource = await resolveBenchmarkCommandSource(args, workDir, {
      fallbackToDefault: true,
      requireCommand: false,
      config,
    });
    const separatorCommand = commandSource.separatorCommand === true;
    const command = commandSource.command;
    if (command) {
      const fixedControlBlock = fixedControlBlockForCommand(command, config, args);
      if (fixedControlBlock) {
        return blockedBenchmarkLint({
          block: fixedControlBlock,
          config,
          metricName,
          separatorCommand,
          state,
          workDir,
        });
      }
      commandResult = await runShell(command, workDir, timeoutSeconds, {
        retainMetricNames: [metricName],
      });
      sample = metricParseSource(commandResult);
      commandResult.separatorCommand = separatorCommand;
    }
  }
  const parsedMetrics = parseMetricLines(sample);
  const parsedMetricCount = metricCount(parsedMetrics);
  const emitsPrimary = finiteMetric(parsedMetrics[metricName]) != null;
  const issues: string[] = [];
  const warnings: string[] = [];
  if (!sample) {
    issues.push("No sample output, command, or default autoresearch script was available.");
  } else if (!parsedMetricCount) {
    issues.push("No METRIC name=value lines were parsed.");
  } else if (!emitsPrimary) {
    issues.push(`Primary metric METRIC ${metricName}=<number> was not emitted.`);
  }
  if (commandResult && (commandResult.exitCode !== 0 || commandResult.timedOut)) {
    issues.push(
      `Benchmark command failed during lint: exit ${commandResult.exitCode ?? "none"}${commandResult.timedOut ? " (timed out)" : ""}.`,
    );
    if (commandResult.timedOut && !parsedMetricCount) {
      warnings.push(
        "Lint timed out before METRIC output. Prefer linting a generated wrapper, artifact/sample mode, or rerun with --timeout-seconds only after bounding the workload.",
      );
    }
    if (commandResult.terminationFailed) {
      warnings.push(
        "Process-tree termination could not be proven; verify the reported PID and descendants before another command.",
      );
    }
  }
  if (parsedMetricCount > 20) {
    warnings.push("Benchmark emits many metrics; keep the primary metric obvious and stable.");
  }
  const researchIntegrity = buildResearchIntegrity({
    state,
    config: { ...state.config, ...config },
    parsedMetrics,
    metricName,
    sample,
  });
  const metricParsing = {
    ok: issues.length === 0,
    emitsPrimary,
    parsedMetricCount,
    issues,
  };
  const diagnostics = commandDiagnostics({
    command: commandResult?.command || args.command || "",
    result: commandResult,
    separatorCommand: commandResult?.separatorCommand,
  });
  return {
    ok: issues.length === 0,
    workDir,
    metricName,
    checkedCommand: commandResult?.command || String(args.command || ""),
    parsedMetrics,
    emitsPrimary,
    metricParsing,
    researchIntegrity,
    commandDiagnostics: diagnostics,
    issues,
    warnings: [...warnings, ...researchIntegrity.warnings],
    timeoutSeconds: commandResult ? timeoutSeconds : null,
    termination: commandResult?.termination || null,
    terminationFailed: commandResult?.terminationFailed === true,
    contractCheckHint:
      "Use --sample for pure parser checks, or lint the generated autoresearch wrapper after setup when the raw workload is expensive.",
    example: `METRIC ${metricName}=1.23`,
    nextAction: issues.length
      ? commandResult?.terminationFailed
        ? "Verify the reported PID and descendants are absent before another benchmark command."
        : commandResult?.timedOut
          ? `Bound the benchmark or use a sample/artifact-mode lint before running full packets; then prove METRIC ${metricName}=<number>.`
          : `Update the benchmark so it prints METRIC ${metricName}=<number>.`
      : "Benchmark output satisfies the metric contract.",
  };
}

export async function benchmarkInspect(args: UnknownRecord): Promise<UnknownRecord> {
  const { workDir, config } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  const state = currentState(workDir);
  const command = String(args.command || "").trim();
  const timeoutSeconds = Math.max(1, numberOption(args.timeout_seconds ?? args.timeoutSeconds, 5));
  const warnings = benchmarkInspectWarnings(command);
  if (!command) {
    return {
      ...inspectionBase({
        ok: true,
        workDir,
        ranCommand: false,
        command: "",
        timeoutSeconds: null,
        exitCode: null,
        timedOut: false,
        warnings,
        hints: benchmarkInspectHints(state.config.metricName || ""),
        outputPreview: "",
        outputTruncated: false,
      }),
      parsedMetrics: {},
      nextAction:
        "Run benchmark-inspect with the benchmark's list/artifact command before any expensive full packet.",
    };
  }
  const fixedControlBlock = fixedControlBlockForCommand(command, config, args);
  if (fixedControlBlock) {
    const warning = fixedControlBlock.issue || fixedControlBlock.message || "Blocked.";
    return {
      ...inspectionBase({
        ok: false,
        workDir,
        ranCommand: false,
        command: "",
        timeoutSeconds: null,
        exitCode: null,
        timedOut: false,
        warnings: [warning],
        hints: benchmarkInspectHints(state.config.metricName || ""),
        outputPreview: "",
        outputTruncated: false,
      }),
      code: fixedControlBlock.code,
      fixedControlViolation: fixedControlBlock.fixedControlViolation,
      parsedMetrics: {},
      nextAction: fixedControlBlock.message || warning,
    };
  }
  const result = await runShell(command, workDir, timeoutSeconds, {
    retainMetricNames: [state.config.metricName].filter(Boolean),
  });
  const output = metricParseSource(result) || result.fullOutput || result.output || "";
  const parsedMetrics = parseMetricLines(output);
  const parsedMetricCount = metricCount(parsedMetrics);
  const timedOutBeforeMetric = result.timedOut && parsedMetricCount === 0;
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
  if (result.terminationFailed) {
    warnings.push(
      "Process-tree termination could not be proven; verify the reported PID and descendants before another command.",
    );
  }
  return {
    ...inspectionBase({
      ok: !result.timedOut && result.exitCode === 0,
      workDir,
      ranCommand: true,
      command: result.command,
      timeoutSeconds,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      termination: result.termination,
      terminationFailed: result.terminationFailed,
      warnings,
      hints: benchmarkInspectHints(state.config.metricName || ""),
      outputPreview: headText(output || result.fullOutput || result.output || "", 30, 12000),
      outputTruncated: Boolean(result.outputTruncated || result.fullOutputTruncated),
    }),
    parsedMetrics,
    nextAction: result.terminationFailed
      ? "Verify the reported PID and descendants are absent before another inspect command."
      : result.timedOut || result.exitCode !== 0
        ? "Switch to a bounded list/dry-run/artifact command, then lint the metric contract."
        : "If this is bounded and representative, run benchmark-lint or the first compact next packet.",
  };
}

export async function checksInspect(args: UnknownRecord): Promise<UnknownRecord> {
  const { workDir } = resolveAuthorizedWorkDir(String(args.working_dir || args.cwd || ""));
  const command = String(args.command || args.checks_command || args.checksCommand || "").trim();
  const timeoutSeconds = Math.max(1, numberOption(args.timeout_seconds ?? args.timeoutSeconds, 60));
  if (!command) {
    return {
      ...inspectionBase({
        ok: true,
        workDir,
        ranCommand: false,
        command: "",
        timeoutSeconds: null,
        exitCode: null,
        timedOut: false,
        warnings: ["No checks command was provided."],
        hints: checksInspectHints(),
        outputPreview: "",
        outputTruncated: false,
      }),
      failedTests: [],
      nextAction:
        "Run checks-inspect with the exact correctness command before treating a failed suite as evidence.",
    };
  }
  const result = await runShell(command, workDir, timeoutSeconds);
  const output = result.fullOutput || result.output || "";
  const failedTests = extractFailedTests(output);
  const warnings = checksInspectWarnings(command, output, result, failedTests);
  return {
    ...inspectionBase({
      ok: !result.timedOut && result.exitCode === 0,
      workDir,
      ranCommand: true,
      command: result.command,
      timeoutSeconds,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      termination: result.termination,
      terminationFailed: result.terminationFailed,
      warnings,
      hints: checksInspectHints(),
      outputPreview: headText(output, 50, 16000),
      outputTruncated: Boolean(result.outputTruncated || result.fullOutputTruncated),
    }),
    failedTests,
    nextAction: result.terminationFailed
      ? "Verify the reported PID and descendants are absent before another checks command."
      : result.timedOut || result.exitCode !== 0
        ? "Fix command-shape problems first, then separate touched-path failures from broader suite failures before logging checks_failed."
        : "Checks command completed cleanly; include it as verification evidence before logging or finalizing.",
  };
}

function validateMetricName(name: unknown): string {
  const value = String(name || "");
  if (!METRIC_NAME_PATTERN.test(value) || DENIED_METRIC_NAMES.has(value)) {
    throw new Error(
      `Metric name must match the METRIC parser grammar: one non-empty token without whitespace or "=". Got ${value}`,
    );
  }
  return value;
}

function metricParseSource(result: InspectShellRunResult | null): string {
  if (!result) return "";
  const retained = result.retainedMetricOutput || "";
  if (result.metricOutput) {
    return [
      result.metricOutput,
      result.metricOutputTruncated && result.fullOutput ? result.fullOutput : "",
      retained,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [result.fullOutput || result.output || "", retained].filter(Boolean).join("\n");
}

function headText(text: string, maxLines: number, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  const bounded = bytes.length > maxBytes ? bytes.subarray(0, maxBytes).toString("utf8") : text;
  return bounded.split(/\r?\n/).slice(0, maxLines).join("\n");
}

function blockedBenchmarkLint({
  block,
  config,
  metricName,
  separatorCommand,
  state,
  workDir,
}: {
  block: FixedControlBlock;
  config: UnknownRecord;
  metricName: string;
  separatorCommand: boolean;
  state: ReturnType<typeof currentState>;
  workDir: string;
}): UnknownRecord {
  const issue = block.issue || block.message || "Blocked.";
  const parsedMetrics = {};
  const researchIntegrity = buildResearchIntegrity({
    state,
    config: { ...state.config, ...config },
    parsedMetrics,
    metricName,
    sample: "",
  });
  const issues = [issue];
  return {
    ok: false,
    workDir,
    metricName,
    checkedCommand: "",
    parsedMetrics,
    emitsPrimary: false,
    metricParsing: {
      ok: false,
      emitsPrimary: false,
      parsedMetricCount: 0,
      issues,
    },
    researchIntegrity,
    commandDiagnostics: commandDiagnostics({
      command: "",
      result: null,
      separatorCommand,
    }),
    code: block.code,
    fixedControlViolation: block.fixedControlViolation,
    issues,
    warnings: researchIntegrity.warnings,
    timeoutSeconds: null,
    contractCheckHint:
      "Use --sample for pure parser checks, or lint the generated autoresearch wrapper after setup when the raw workload is expensive.",
    example: `METRIC ${metricName}=1.23`,
    nextAction: block.message || issue,
  };
}

function inspectionBase({
  ok,
  workDir,
  ranCommand,
  command,
  timeoutSeconds,
  exitCode,
  timedOut,
  termination = null,
  terminationFailed = false,
  warnings,
  hints,
  outputPreview,
  outputTruncated,
}: UnknownRecord): UnknownRecord {
  return {
    ok,
    workDir,
    ranCommand,
    command,
    timeoutSeconds,
    exitCode,
    timedOut,
    termination,
    terminationFailed,
    warnings,
    hints,
    outputPreview,
    outputTruncated,
  };
}

function benchmarkInspectWarnings(command: string): string[] {
  const warnings: string[] = [];
  if (!command) return warnings;
  pushWarning(
    warnings,
    /CODESTORY_PIPELINE_LIST_CASES\s*=\s*1/i.test(command),
    "This looks like the wrong CodeStory list flag seen in onboarding; use CODESTORY_EMBED_RESEARCH_LIST=1 for the current pipeline list mode.",
  );
  pushWarning(
    warnings,
    !/(LIST|DRY|INSPECT|SAMPLE|ARTIFACT|LIMIT|COUNT|HELP)/i.test(command),
    "Command does not advertise an obvious list/dry-run/sample bound. Confirm it will not start the full benchmark.",
  );
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

function checksInspectWarnings(
  command: string,
  output: string,
  result: ShellRunResult,
  failedTests: string[],
): string[] {
  const warnings: string[] = [];
  pushWarning(
    warnings,
    result.timedOut,
    "The checks command timed out. Narrow it to touched paths or increase the timeout before using it as decision evidence.",
  );
  pushWarning(
    warnings,
    result.terminationFailed,
    "Process-tree termination could not be proven; verify the reported PID and descendants before another command.",
  );
  pushWarning(
    warnings,
    cargoUnexpectedArgument(output),
    "Cargo rejected the check command shape. cargo test accepts one name filter per invocation; run separate exact filters or a package target such as --lib.",
  );
  pushWarning(
    warnings,
    /cargo(?:\.exe)?\s+test/i.test(command) && looksLikeMultipleCargoFilters(command),
    "This cargo test command appears to include multiple name filters before --; prefer separate exact test invocations or a broader target filter.",
  );
  if (failedTests.length > 1) {
    warnings.push(
      `${failedTests.length} tests failed. Classify touched-path failures separately from pre-existing or broad-suite failures before deciding keep/discard/checks_failed.`,
    );
  } else if (failedTests.length === 1) {
    warnings.push(
      `One test failed: ${failedTests[0]}. Confirm whether it is caused by the current packet before logging checks_failed.`,
    );
  }
  pushWarning(
    warnings,
    result.exitCode !== 0 && !result.timedOut && failedTests.length === 0,
    `The checks command exited ${result.exitCode} without a parsed failed-test list; inspect the output for setup, command, or environment failure.`,
  );
  return warnings;
}

function metricCount(parsedMetrics: Record<string, number>): number {
  return Object.keys(parsedMetrics).length;
}

function pushWarning(warnings: string[], condition: boolean, message: string): void {
  if (condition) warnings.push(message);
}

function cargoUnexpectedArgument(output = ""): boolean {
  return (
    /unexpected argument ['"`][^'"`]+['"`] found/i.test(output) &&
    /Usage:\s+cargo(?:\.exe)? test/i.test(output)
  );
}

function looksLikeMultipleCargoFilters(command = ""): boolean {
  const beforeHarnessArgs = String(command).split(/\s+--\s+/)[0];
  const tokens: string[] = beforeHarnessArgs.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const testIndex = tokens.findIndex(
    (token, index) => token.replace(/['"]/g, "") === "test" && index > 0,
  );
  if (testIndex < 0) return false;
  const filters: string[] = [];
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

function extractFailedTests(output = ""): string[] {
  const tests: string[] = [];
  const seen = new Set<string>();
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
