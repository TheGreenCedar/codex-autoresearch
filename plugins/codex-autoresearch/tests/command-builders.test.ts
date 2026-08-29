import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildCompactRecommendNextResponse,
  buildRecommendNextResponse,
} from "../lib/commands/recommend-next.js";
import { clearPendingLogTransactionWithWarning } from "../lib/commands/log.js";
import { buildCompactStateResponse } from "../lib/commands/state.js";
import { buildContinuationCommands } from "../lib/commands/continuation.js";
import { buildDashboardCommands, buildDashboardSettings } from "../lib/commands/dashboard.js";
import { commandHandlerAdapterBindings, createCliCommandHandlers } from "../lib/cli-handlers.js";
import { renderCliHelp } from "../lib/cli/help.js";
import { boolOption, numberOption, parseCliArgs, parseJsonOption } from "../lib/cli/args.js";
import {
  actionPolicyRequiresSessionLock,
  commandRequiresSessionMutationLock,
  commandUsesSessionDecisionProtocol,
  commandTable,
  compatibilityErrorForCli,
} from "../lib/command-table.js";
import { quoteShellArg, renderShellCommand } from "../lib/command-rendering.js";
import {
  compileDecisionPlan,
  decisionDiagnostic,
  type DecisionDiagnosticCode,
} from "../lib/decision-compiler.js";
import { projectCompactDecisionPlan } from "../lib/decision-projection.js";
import type { CoherentSessionSnapshot } from "../lib/coherent-session-snapshot.js";
import {
  assertRunResourcePreflight,
  buildActiveRunPacketId,
  buildProcessLifecycleRecord,
} from "../lib/process-governor.js";
import {
  actionPolicyForTool,
  commandActionAliases,
  toolMetadata,
  toolRegistry,
} from "../lib/tool-registry.js";
import { toolSchemas } from "../lib/tool-schemas.js";

test("command rendering quotes hostile benchmark args for the selected shell", () => {
  const benchmark =
    "node -e \"console.log('METRIC seconds=1 $HOME $(whoami) `whoami` C:\\bench path')\"";

  assert.equal(
    quoteShellArg(benchmark, "powershell"),
    "'node -e \\\"console.log(''METRIC seconds=1 $HOME $(whoami) `whoami` C:\\bench path'')\\\"'",
  );
  assert.equal(
    quoteShellArg(benchmark, "bash"),
    "'node -e \"console.log('\"'\"'METRIC seconds=1 $HOME $(whoami) `whoami` C:\\bench path'\"'\"')\"'",
  );
  assert.equal(
    renderShellCommand(
      ["C:\\Program Files\\nodejs\\node.exe", "scripts\\autoresearch.mjs", "--flag", benchmark],
      "powershell",
    ),
    "& { $PSNativeCommandArgumentPassing = 'Legacy'; & 'C:\\Program Files\\nodejs\\node.exe' scripts\\autoresearch.mjs --flag 'node -e \\\"console.log(''METRIC seconds=1 $HOME $(whoami) `whoami` C:\\bench path'')\\\"' }",
  );
});

test("log command helper reports pending receipt cleanup failure without losing durable log", async () => {
  const warning = await clearPendingLogTransactionWithWarning(
    "/tmp/autoresearch/pending-log-transaction.json",
    async () => {
      throw new Error("filesystem denied unlink");
    },
  );

  assert.match(warning || "", /Pending receipt cleanup failed: filesystem denied unlink\./);
});

test("log command helper redacts local paths in pending receipt cleanup warnings", async () => {
  const warning = await clearPendingLogTransactionWithWarning(
    "C:\\Users\\Alice\\secret-client\\.git\\autoresearch\\pending-log-transaction.json",
    async () => {
      throw new Error(
        "EPERM: operation not permitted, unlink 'C:\\Users\\Alice\\secret-client\\.git\\autoresearch\\pending-log-transaction.json'",
      );
    },
    { workDir: "C:\\Users\\Alice\\secret-client" },
  );

  assert.doesNotMatch(warning || "", /Alice|secret-client/);
  assert.match(warning || "", /<workdir>|C:\\Users\\<user>/);
});

test("run command helper blocks packets when resource budgets are exhausted", () => {
  assert.throws(
    () =>
      assertRunResourcePreflight({
        command: "node benchmark.js",
        config: {},
        entries: [
          buildProcessLifecycleRecord({
            packetId: "packet-2-active",
            processId: "benchmark",
            event: "started",
            at: "2026-06-01T00:00:00.000Z",
          }),
        ],
      }),
    /Resource preflight blocked packet start:/,
  );
  assert.equal(buildActiveRunPacketId(2), "packet-2-active");
});

test("tool registry owns command aliases and static safety metadata", () => {
  assert.equal(commandActionAliases.doctorExplain, "doctor");
  assert.equal(commandActionAliases.liveDashboard, "serve dashboard");
  assert.equal(toolMetadata("doctor_session")?.conditionallyMutating, true);
  assert.equal(toolMetadata("doctor_session")?.openWorld, true);
  assert.equal(actionPolicyForTool("integrations", { subcommand: "sync-recipes" }), "read");
});

test("command table derives schemas, registry, handlers, help, and compatibility migrations", async () => {
  const dependencies = Object.fromEntries(
    commandTable.map((command) => [command.handler, async (args: unknown) => args]),
  );
  const handlers = createCliCommandHandlers({
    ...dependencies,
    doctorHooks: async (args: unknown) => args,
    interactiveSetup: async (args: unknown) => args,
    parseJsonOption,
  } as any);
  const tableCliNames = commandTable.map((command) => command.cliCommand).sort();
  const tableToolNames = commandTable.map((command) => command.name).sort();

  assert.equal(new Set(tableCliNames).size, commandTable.length);
  assert.equal(new Set(tableToolNames).size, commandTable.length);
  assert.deepEqual(Object.keys(handlers).sort(), tableCliNames);
  assert.deepEqual(Object.keys(toolRegistry).sort(), tableToolNames);
  assert.deepEqual(toolSchemas.map((schema) => schema.name).sort(), tableToolNames);
  assert.deepEqual(
    toolSchemas.map((schema) => [schema.name, Object.keys(schema.outputSchema.properties)]),
    commandTable.map((command) => [
      command.name,
      [
        ...command.outputFields,
        ...(command.decisionProtocol === "session-mutation"
          ? ["preconditionDecision", "mutation", "resultingDecision"]
          : []),
      ],
    ]),
  );
  for (const command of commandTable) {
    const help = renderCliHelp({ command: command.cliCommand });
    assert.match(help, new RegExp(`Command: ${command.cliCommand}`));
    assert.match(help, new RegExp(command.help[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.throws(
    () => handlers.state({ _: ["state"], cwd: ".", typoOption: true }),
    /Unknown argument for read_state: typoOption/,
  );
  const qualityGap = await handlers["quality-gap"]({
    _: ["quality-gap"],
    cwd: ".",
    json: true,
  });
  assert.equal(qualityGap.result.json, true);
  assert.deepEqual(
    commandTable.filter((command) => command.compatibility).map((command) => command.cliCommand),
    ["init", "run", "integrations"],
  );
  for (const command of ["init", "run", "integrations"]) {
    const migrationError = compatibilityErrorForCli(command);
    assert.match(migrationError || "", /scheduled for removal after 2026-10-01/);
    assert.match(renderCliHelp({ command }), /Migration: .*migrate/i);
    const definition = commandTable.find((entry) => entry.cliCommand === command)!;
    const schema = toolSchemas.find((entry) => entry.name === definition.name)!;
    assert.deepEqual(definition.outputFields, []);
    assert.equal(schema.description, definition.compatibility!.error);
    assert.match(String(schema.annotations.safety), /Fails before dispatch, locking, or mutation/);
  }
});

test("table lock policy covers every mutating and conditional command", () => {
  const conditionalArgs: Record<string, Record<string, unknown>> = {
    clear: { confirm: true },
    guide: { startDashboard: true },
    "session-forensics": { apply: true },
    "research-start": {},
    "research-fanout": { yes: true },
    "lane-runner": { command: "git status --short" },
    "partial-results": { record: "candidate-1" },
    "ledger-doctor": { repair: true },
    "gap-candidates": { modelCommand: "node model.mjs" },
    "benchmark-inspect": { command: "node bench.mjs" },
    "benchmark-lint": { command: "node bench.mjs" },
    "checks-inspect": { command: "npm test" },
    doctor: { checkBenchmark: true },
    "new-segment": { confirm: true },
    "promote-gate": { confirm: true },
  };
  assert.deepEqual(
    Object.keys(conditionalArgs).sort(),
    commandTable
      .filter((command) => command.conditionallyMutating)
      .map((command) => command.cliCommand)
      .sort(),
  );

  for (const command of commandTable) {
    const defaultMutates = actionPolicyRequiresSessionLock(command.actionPolicy);
    if (defaultMutates && command.sessionLock !== "none") {
      assert.equal(
        commandRequiresSessionMutationLock(command.cliCommand),
        true,
        `${command.cliCommand} should lock by default`,
      );
      assert.equal(command.decisionProtocol, "session-mutation");
      assert.equal(commandUsesSessionDecisionProtocol(command.cliCommand), true);
    }
    if (command.sessionLock === "none") {
      assert.equal(commandRequiresSessionMutationLock(command.cliCommand), false);
      assert.notEqual(command.decisionProtocol, "session-mutation");
      assert.equal(commandUsesSessionDecisionProtocol(command.cliCommand), false);
    }
    if (command.inputSchema.properties?.dry_run) {
      assert.equal(
        commandRequiresSessionMutationLock(command.cliCommand, {
          dryRun: true,
        }),
        false,
      );
    }
  }
  for (const [command, args] of Object.entries(conditionalArgs)) {
    const definition = commandTable.find((entry) => entry.cliCommand === command)!;
    assert.equal(
      commandRequiresSessionMutationLock(command, args),
      definition.sessionLock === "none" ? false : true,
      `${command} conditional lock policy drifted`,
    );
    assert.equal(
      commandUsesSessionDecisionProtocol(command, args),
      definition.sessionLock === "none" ? false : true,
      `${command} conditional mutation protocol drifted`,
    );
    if (definition.sessionLock !== "none") {
      assert.equal(definition.decisionProtocol, "session-mutation");
    }
  }
  assert.equal(commandRequiresSessionMutationLock("guide", { startDashboard: true }), false);
});

test("handler adapters invoke the binding declared by each table entry", async () => {
  const calls: string[] = [];
  const dependencies = Object.fromEntries(
    commandTable
      .filter((command) => !command.compatibility)
      .map((command) => [
        command.handler,
        async (...args: unknown[]) => {
          calls.push(command.handler);
          return command.handler === "measureQualityGap"
            ? { binding: command.handler, metricOutput: "METRIC quality_gap=0" }
            : { args, binding: command.handler };
        },
      ]),
  );
  const handlers = createCliCommandHandlers({
    ...dependencies,
    doctorHooks: async () => ({ hooks: true }),
    interactiveSetup: async () => ({ interactive: true }),
    parseJsonOption,
  } as any);

  assert.deepEqual([...commandHandlerAdapterBindings].sort(), [
    "checksInspect",
    "doctorSession",
    "logExperiment",
    "measureQualityGap",
    "publicState",
    "recipeCommand",
    "serveDashboard",
    "setupSession",
  ]);
  for (const command of commandTable.filter((entry) => !entry.compatibility)) {
    calls.length = 0;
    await handlers[command.cliCommand]({ _: [command.cliCommand], cwd: "." });
    assert.deepEqual(calls, [command.handler], `${command.cliCommand} bypassed its table binding`);
  }
});

test("dashboard command helper builds read-only continuation commands", () => {
  const commands = buildDashboardCommands({
    researchSlug: "review round",
    scriptPath: "/tmp/plugin/scripts/autoresearch.mjs",
    shellQuote: JSON.stringify,
    workDir: "/tmp/project",
  });

  assert.equal(
    commands[0].command,
    'node "/tmp/plugin/scripts/autoresearch.mjs" state --cwd "/tmp/project" --report',
  );
  assert.ok(commands.some((command) => command.command.includes("finalize-preview")));
  assert.ok(commands.some((command) => command.command.includes('--research-slug "review round"')));
});

test("continuation command helper quotes cwd and quality-gap slug", () => {
  const commands = buildContinuationCommands({
    researchSlug: "review round",
    scriptPath: "/tmp/plugin/scripts/autoresearch.mjs",
    shellQuote: JSON.stringify,
    workDir: "/tmp/project",
  });

  assert.equal(
    commands.state,
    'node "/tmp/plugin/scripts/autoresearch.mjs" state --cwd "/tmp/project"',
  );
  assert.match(commands.gapCandidates, /--research-slug "review round"/);
});

test("dashboard settings preserve policy defaults with overrides", () => {
  assert.deepEqual(buildDashboardSettings({ keepPolicy: "primary-or-risk-reduction" }), {
    autonomyMode: "guarded",
    checksPolicy: "always",
    keepPolicy: "primary-or-risk-reduction",
    recipeId: "",
  });
  assert.equal(buildDashboardSettings({}, { publicExport: true }).publicExport, true);
});

test("CLI arg parser preserves camel aliases and passthrough args", () => {
  const parsed = parseCliArgs([
    "next",
    "--working-dir=C:\\repo",
    "--json-full",
    "--",
    "--not-an-option",
  ]);

  assert.deepEqual(parsed._, ["next", "--not-an-option"]);
  assert.equal(parsed.workingDir, "C:\\repo");
  assert.equal(parsed.jsonFull, true);
});

test("CLI arg parser covers finalizer positional mode and flags", () => {
  const plan = parseCliArgs([
    "plan",
    "--cwd",
    "C:\\repo",
    "--output=groups.json",
    "--goal",
    "speed-loop",
    "--trunk",
    "dev",
    "--collapse-overlap",
  ]);
  const apply = parseCliArgs(["--cwd", "C:\\repo", "groups.json"]);

  assert.deepEqual(plan._, ["plan"]);
  assert.equal(plan.cwd, "C:\\repo");
  assert.equal(plan.output, "groups.json");
  assert.equal(plan.goal, "speed-loop");
  assert.equal(plan.trunk, "dev");
  assert.equal(plan.collapseOverlap, true);
  assert.deepEqual(apply._, ["groups.json"]);
  assert.equal(apply.cwd, "C:\\repo");
});

test("CLI option helpers preserve loose command input behavior", () => {
  assert.deepEqual(parseJsonOption('{"metric":1}', null), { metric: 1 });
  assert.equal(parseJsonOption("", "fallback"), "fallback");
  assert.equal(numberOption("2.5", 0), 2.5);
  assert.equal(boolOption("yes"), true);
  assert.throws(() => numberOption(true, 0), /Expected a number/);
});

if (process.platform === "win32") {
  test("PowerShell command rendering preserves argv with embedded double quotes", () => {
    const benchmark =
      "node -e \"console.log('METRIC seconds=1 $HOME $(whoami) `whoami` C:\\bench path')\"";
    const rendered = renderShellCommand(
      [process.execPath, "-e", "process.stdout.write(process.argv[1])", benchmark],
      "powershell",
    );

    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      encoding: "utf8",
      input: rendered,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, benchmark);
  });
}

test("recommend-next response projects one canonical DecisionPlan and preserves fact fields", () => {
  const decisionPlan = decisionPlanFixture({
    code: "runtime-integrity",
    message: "Inspect runtime drift.",
    command: "node scripts/autoresearch.mjs doctor --cwd .",
  });
  const response = buildRecommendNextResponse({
    workDir: "/tmp/project",
    decisionPlan,
    commands: { state: "node scripts/autoresearch.mjs state --cwd ." },
    operatorChecklist: {
      command: "node scripts/autoresearch.mjs doctor --cwd .",
    },
    runtimeProvenance: { drifted: true },
    laneLifecycle: { staleLanes: ["scout"] },
    packetDiagnostics: { unresolved: true },
  });

  assert.equal(response.ok, true);
  assert.equal(response.workDir, "/tmp/project");
  assert.equal((response.action as Record<string, unknown>).kind, decisionPlan.action.kind);
  assert.equal(response.nextAction, decisionPlan.action.reason);
  assert.deepEqual(response.blockers, ["runtime-integrity"]);
  assert.equal(response.commands.primary, decisionPlan.action.command);
  assert.equal(
    (response.decisionPlanProjection as Record<string, unknown>).decisionId,
    decisionPlan.decisionId,
  );
  assert.equal(response.resolvedDecision?.decisionId, decisionPlan.decisionId);
  assert.deepEqual(response.operatorChecklist, {
    command: "node scripts/autoresearch.mjs doctor --cwd .",
  });
  assert.deepEqual(response.runtimeProvenance, { drifted: true });
  assert.deepEqual(response.laneLifecycle, { staleLanes: ["scout"] });
  assert.deepEqual(response.packetDiagnostics, { unresolved: true });
});

test("compatibility handlers fail with their exact migration error", async () => {
  const handlers = createCliCommandHandlers({} as any);
  await assert.rejects(
    handlers.integrations({ _: ["integrations"], subcommand: "doctor" }),
    /integrations is a compatibility command scheduled for removal after 2026-10-01/,
  );
});

test("compact recommend-next consumes the canonical decision-plan projection", () => {
  const decisionPlan = decisionPlanFixture({
    code: "finalization-claim-blocked",
    message: "Current branch tree is not covered.",
    command: "node scripts/autoresearch.mjs finalize-preview --cwd /tmp/project",
  });
  const decisionPlanProjection = projectCompactDecisionPlan(decisionPlan);
  const response = buildCompactRecommendNextResponse({
    workDir: "/tmp/project",
    compactState: {
      ok: true,
      workDir: "/tmp/project",
      nextAction: decisionPlan.action.reason,
      commands: {
        next: "node scripts/autoresearch.mjs next --cwd /tmp/project --compact",
        state: "node scripts/autoresearch.mjs state --cwd /tmp/project --compact",
      },
      decisionPlanProjection,
    },
  });

  assert.equal(
    (response.decisionPlanProjection as Record<string, unknown>).decisionId,
    decisionPlan.decisionId,
  );
  assert.equal((response.action as Record<string, unknown>).kind, decisionPlan.action.kind);
  assert.equal(response.commands.primary, decisionPlan.action.command);
  assert.doesNotMatch(String(response.commands.primary), /\bnext\b/);
});

test("compact state response projects canonical decision semantics within stable compact fields", () => {
  const decisionPlan = decisionPlanFixture({
    code: "no-learning-pause",
    message: "Clean up stale lanes.",
  });
  const response = buildCompactStateResponse({
    workDir: "/tmp/project",
    runs: 3,
    kept: 1,
    discarded: 1,
    measured: 1,
    decisionPlan,
    runtimeProvenance: { status: "fresh" },
    laneLifecycle: { staleLanes: ["scout"] },
    packetDiagnostics: { unresolved: true },
    watchdogSummary: { stale: true },
  });

  assert.equal(response.ok, true);
  assert.equal(response.runs, 3);
  assert.equal(response.kept, 1);
  assert.equal(response.nextAction, decisionPlan.action.reason);
  assert.equal(
    (response.decisionPlanProjection as Record<string, unknown>).decisionId,
    decisionPlan.decisionId,
  );
  assert.equal(Object.hasOwn(response, "resolvedDecision"), false);
  assert.equal(Object.hasOwn(response, "loopContract"), false);
  assert.equal(Object.hasOwn(response, "laneLifecycle"), false);
  assert.equal(Object.hasOwn(response, "packetDiagnostics"), false);
  assert.equal(Object.hasOwn(response, "resumeAudit"), false);
});

test("compact recommend-next ignores legacy command aliases and enforces Unicode budgets", () => {
  const decisionPlan = decisionPlanFixture({
    code: "no-learning-pause",
    message: "Pause packet work.",
  });
  const response = buildCompactRecommendNextResponse({
    workDir: `C:/${"😀".repeat(8_000)}`,
    compactState: {
      workDir: `C:/${"😀".repeat(8_000)}`,
      goal: "界".repeat(20_000),
      nextAction: decisionPlan.action.reason,
      decisionPlanProjection: projectCompactDecisionPlan(decisionPlan),
      resolvedDecision: {
        command: "<command-placeholder>",
        canonicalNextAction: {
          kind: "next-packet",
          command: "node -e \"require('child_process').execSync('whoami')\"",
        },
      },
      commands: {
        primary: "node -e \"require('child_process').execSync('whoami')\"",
        state: "<state-command>",
      },
    },
  });
  const serialized = JSON.stringify(response, null, 2);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 5_200);
  assert.ok(serialized.split("\n").length <= 120);
  assert.equal((response.commands as Record<string, unknown>).primary, undefined);
  assert.doesNotMatch(serialized, /child_process|command-placeholder|state-command/);
});

function decisionPlanFixture({
  code,
  message,
  command = "",
}: {
  code?: DecisionDiagnosticCode;
  message?: string;
  command?: string;
} = {}) {
  const snapshot: CoherentSessionSnapshot = {
    kind: "coherent-session-snapshot",
    schemaVersion: 1,
    generationId: "command-builder-generation",
    sessionCwd: "/tmp/project",
    workDir: "/tmp/project",
    vector: {
      ledger: { size: 0, mtimeNs: "0", tailHash: "missing" },
      config: { storage: "session", hash: "config" },
      packet: { storage: "git-private", hash: "missing" },
      receipt: { storage: "git-private", hash: "missing" },
      process: { storage: "git-private", hash: "missing" },
      git: { head: "head", indexTree: "index", statusHash: "status" },
    },
    records: [],
    config: {},
    lastRunPacket: null,
    pendingTransaction: null,
    processProgress: null,
    git: { head: "head", indexTree: "index", statusHash: "status" },
    sourceDiagnostics: { ledgerIssues: [] },
    semanticFacts: {
      contractDigest: "contract-a",
      evaluatorIdentity: "evaluator-a",
      acceptedCheckIdentities: ["check-a@digest-a"],
      preconditionEpoch: "epoch-a",
    },
  };
  return compileDecisionPlan(
    snapshot,
    code ? [decisionDiagnostic(code, { message, command })] : [],
  );
}
