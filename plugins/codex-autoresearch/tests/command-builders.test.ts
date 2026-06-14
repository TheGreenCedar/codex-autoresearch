import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildCompactRecommendNextResponse,
  buildRecommendNextResponse,
  selectRecommendNextRuntimeAuthority,
} from "../lib/commands/recommend-next.js";
import { clearPendingLogTransactionWithWarning } from "../lib/commands/log.js";
import { buildNextPacketId } from "../lib/commands/next.js";
import { assertRunResourcePreflight, buildActiveRunPacketId } from "../lib/commands/run.js";
import { buildCompactStateResponse } from "../lib/commands/state.js";
import { createCliCommandHandlers } from "../lib/cli-handlers.js";
import { quoteShellArg, renderShellCommand } from "../lib/command-rendering.js";

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

test("run command helper blocks packets when resource budgets are exhausted", () => {
  assert.throws(
    () =>
      assertRunResourcePreflight({
        command: "node benchmark.js",
        config: {},
        entries: [
          {
            type: "process_manager",
            status: "stale",
            timestamp: "2026-06-01T00:00:00.000Z",
            reason: "stale active_process residue after reboot",
          },
        ],
      }),
    /Resource preflight blocked packet start:/,
  );
  assert.equal(buildActiveRunPacketId(2), "packet-2-active");
});

test("next command helper builds stable packet evidence ids", () => {
  assert.equal(buildNextPacketId({ nextRun: 7 }, "abcdef1234567890"), "packet-7-abcdef123456");
  assert.equal(buildNextPacketId({}, "1234567890abcdef"), "packet-next-1234567890ab");
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

test("recommend-next response preserves stable fields and optional governance fields", () => {
  const response = buildRecommendNextResponse({
    workDir: "/tmp/project",
    action: { kind: "runtime-provenance" },
    nextAction: "Inspect runtime drift.",
    commands: { primary: "node scripts/autoresearch.mjs doctor --cwd ." },
    operatorChecklist: { command: "node scripts/autoresearch.mjs doctor --cwd ." },
    runtimeProvenance: { drifted: true },
    loopContract: { nextActionKind: "runtime-provenance" },
    laneLifecycle: { staleLanes: ["scout"] },
    packetDiagnostics: { unresolved: true },
  });

  assert.equal(response.ok, true);
  assert.equal(response.workDir, "/tmp/project");
  assert.deepEqual(response.blockers, []);
  assert.equal(response.nextAction, "Inspect runtime drift.");
  assert.deepEqual(response.operatorChecklist, {
    command: "node scripts/autoresearch.mjs doctor --cwd .",
  });
  assert.deepEqual(response.runtimeProvenance, { drifted: true });
  assert.deepEqual(response.loopContract, { nextActionKind: "runtime-provenance" });
  assert.deepEqual(response.laneLifecycle, { staleLanes: ["scout"] });
  assert.deepEqual(response.packetDiagnostics, { unresolved: true });
});

test("integrations handler prefers normalized subcommand argument", async () => {
  const calls: Array<{ subcommand: string | undefined; catalog?: string }> = [];
  const handlers = createCliCommandHandlers({
    integrationsCommand: async (subcommand: string | undefined, args: Record<string, unknown>) => {
      calls.push({ subcommand, catalog: String(args.catalog || "") });
      return { ok: true, subcommand };
    },
  });

  const response = await handlers.integrations({
    _: ["integrations"],
    subcommand: "doctor",
    catalog: "recipes.json",
  });

  assert.deepEqual(calls, [{ subcommand: "doctor", catalog: "recipes.json" }]);
  assert.deepEqual(response.result, { ok: true, subcommand: "doctor" });
});

test("recommend-next authority prefers dashboard runtime drift over compact source-only state", () => {
  const authority = selectRecommendNextRuntimeAuthority({
    viewModel: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "runtime-provenance",
          reason: "Inspect installed runtime drift before continuing.",
        },
        loopContract: {
          ok: false,
          blockers: [{ kind: "runtime-provenance" }],
        },
        runtimeProvenance: {
          status: "drift-detected",
          drifted: true,
        },
      },
      processHygiene: {
        runtimeDrift: {
          status: "checked",
          drifted: false,
        },
      },
    },
    compact: {
      canonicalNextAction: {
        kind: "next-packet",
        reason: "Run the next packet.",
      },
      runtimeProvenance: {
        status: "unavailable",
        driftConfidence: "source-only",
        drifted: false,
      },
      loopContract: {
        ok: true,
      },
    },
  });

  assert.equal((authority.canonicalNextAction as any).kind, "runtime-provenance");
  assert.deepEqual(authority.runtimeProvenance, {
    status: "drift-detected",
    drifted: true,
  });
  assert.deepEqual(authority.loopContract, {
    ok: false,
    blockers: [{ kind: "runtime-provenance" }],
  });
});

test("recommend-next authority keeps unavailable runtime probes non-blocking", () => {
  const authority = selectRecommendNextRuntimeAuthority({
    viewModel: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "next-packet",
          reason: "Run the next packet.",
        },
        loopContract: {
          ok: true,
          blockers: [],
        },
        runtimeProvenance: {
          status: "unavailable",
          driftConfidence: "unavailable",
          drifted: false,
        },
      },
    },
    compact: {
      canonicalNextAction: {
        kind: "runtime-provenance",
        reason: "Inspect runtime drift.",
      },
    },
  });

  assert.equal((authority.canonicalNextAction as any).kind, "next-packet");
  assert.deepEqual(authority.loopContract, {
    ok: true,
    blockers: [],
  });
  assert.deepEqual(authority.runtimeProvenance, {
    status: "unavailable",
    driftConfidence: "unavailable",
    drifted: false,
  });
});

test("recommend-next authority uses full envelope when dashboard-only blockers exist", () => {
  const authority = selectRecommendNextRuntimeAuthority({
    viewModel: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "finalization",
          reason: "Preview finalization before another packet.",
        },
        loopContract: {
          ok: true,
          canRunNextPacket: false,
          blockers: [],
          warnings: [{ kind: "finalization" }],
        },
        finalizationReadiness: {
          available: true,
          ready: true,
        },
      },
    },
    compact: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "next-packet",
          reason: "Run the next packet.",
        },
        loopContract: {
          ok: true,
          canRunNextPacket: true,
          blockers: [],
          warnings: [],
        },
      },
    },
  });

  assert.equal((authority.canonicalNextAction as any).kind, "finalization");
  assert.deepEqual(authority.loopContract, {
    ok: true,
    canRunNextPacket: false,
    blockers: [],
    warnings: [{ kind: "finalization" }],
  });
});

test("compact recommend-next preserves finalization readiness as canonical authority", () => {
  const response = buildCompactRecommendNextResponse({
    workDir: "/tmp/project",
    compactState: {
      ok: true,
      workDir: "/tmp/project",
      nextAction: "Use finalize-current-tree.",
      commands: {
        finalizePreview: "node scripts/autoresearch.mjs finalize-preview --cwd /tmp/project",
        next: "node scripts/autoresearch.mjs next --cwd /tmp/project --compact",
        state: "node scripts/autoresearch.mjs state --cwd /tmp/project --compact",
      },
      canonicalNextAction: {
        kind: "current-tree-finalization",
        reason: "Use finalize-current-tree.",
        command: "",
      },
      decisionEnvelope: {
        finalizationReadiness: {
          available: true,
          ready: false,
          actionCode: "current-tree-finalization",
          warnings: ["Current branch tree is not covered."],
        },
        canonicalNextAction: {
          kind: "current-tree-finalization",
          reason: "Use finalize-current-tree.",
          command: "",
        },
        loopContract: {
          ok: false,
          canRunNextPacket: false,
          blockers: [{ kind: "current-tree-finalization" }],
        },
      },
    },
  });

  assert.equal((response.decisionEnvelope as any).finalizationReadiness.available, true);
  assert.equal((response.action as any).kind, "current-tree-finalization");
  assert.equal(
    response.commands.primary,
    "node scripts/autoresearch.mjs finalize-preview --cwd /tmp/project",
  );
  assert.doesNotMatch(String(response.commands.primary), /\bnext\b/);
});

test("recommend-next authority preserves compact state when checked runtime is clean", () => {
  const authority = selectRecommendNextRuntimeAuthority({
    viewModel: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "benchmark-command",
          reason: "Configure a benchmark command.",
        },
        loopContract: {
          ok: true,
          blockers: [],
        },
        runtimeProvenance: {
          status: "checked",
          drifted: false,
        },
      },
    },
    compact: {
      decisionEnvelope: {
        canonicalNextAction: {
          kind: "watchdog",
          reason: "Intervene after stale progress.",
        },
        loopContract: {
          ok: true,
          blockers: [],
        },
      },
    },
  });

  assert.equal((authority.canonicalNextAction as any).kind, "watchdog");
  assert.deepEqual(authority.runtimeProvenance, {
    status: "checked",
    drifted: false,
  });
});

test("compact state response preserves stable compact fields and optional loop fields", () => {
  const response = buildCompactStateResponse({
    workDir: "/tmp/project",
    runs: 3,
    kept: 1,
    discarded: 1,
    measured: 1,
    nextAction: "Clean up stale lanes.",
    runtimeProvenance: { status: "fresh" },
    loopContract: { mayRunPacket: false },
    laneLifecycle: { staleLanes: ["scout"] },
    packetDiagnostics: { unresolved: true },
    watchdogSummary: { stale: true },
  });

  assert.equal(response.ok, true);
  assert.equal(response.runs, 3);
  assert.equal(response.kept, 1);
  assert.equal(response.nextAction, "Clean up stale lanes.");
  assert.deepEqual(response.runtimeProvenance, { status: "fresh" });
  assert.deepEqual(response.loopContract, { mayRunPacket: false });
  assert.deepEqual(response.laneLifecycle, { staleLanes: ["scout"] });
  assert.deepEqual(response.packetDiagnostics, { unresolved: true });
  assert.deepEqual(response.watchdogSummary, { stale: true });
});
