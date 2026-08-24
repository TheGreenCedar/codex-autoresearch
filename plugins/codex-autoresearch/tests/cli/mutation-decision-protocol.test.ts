import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CommandDecisionProtocolError,
  runCommandDecisionProtocol,
  withCommandDecisionDiagnostics,
} from "../../lib/command-decision-protocol.js";
import { compileDecisionPlan, decisionDiagnostic } from "../../lib/decision-compiler.js";
import type { CoherentSessionSnapshot } from "../../lib/coherent-session-snapshot.js";
import {
  currentSessionMutationLockContext,
  withSessionMutationLock,
} from "../../lib/session-mutation-lock.js";
import { quoteForShell } from "../helpers/process.js";
import { runCli, withTempDir } from "../helpers/cli-test-context.js";
import {
  createEvidencePlanFixture,
  finalizer,
  pluginRoot,
  run as runFinalizer,
} from "../finalize/helpers.js";

test("command decision protocol captures precondition, mutation, and result under one lock", async () => {
  await withTempDir("command-decision-protocol", async (dir) => {
    const events: string[] = [];
    let generation = "generation-a";
    const loadDecision = async () => {
      assert.ok(currentSessionMutationLockContext());
      events.push(`load:${generation}`);
      const snapshot = snapshotFixture(dir, generation);
      return {
        ok: true as const,
        attempts: 1,
        snapshot,
        plan: compileDecisionPlan(snapshot, []),
      };
    };

    const result = await withSessionMutationLock(dir, "setup", async () => {
      return await runCommandDecisionProtocol({
        command: "setup",
        requestedCwd: dir,
        expectedWorkDir: dir,
        loadDecision,
        mutate: async () => {
          assert.equal(currentSessionMutationLockContext()?.command, "setup");
          events.push("mutate");
          generation = "generation-b";
          return { ok: true };
        },
      });
    });

    assert.deepEqual(events, ["load:generation-a", "mutate", "load:generation-b"]);
    assert.equal(result.preconditionDecision.generationId, "generation-a");
    assert.equal(result.resultingDecision.generationId, "generation-b");
    assert.deepEqual(result.result, { ok: true });
    assert.equal(result.mutation.kind, "command-mutation-receipt");
    assert.equal(result.mutation.command, "setup");
    assert.equal(result.mutation.status, "completed");
    assert.equal(result.mutation.preconditionGenerationId, "generation-a");
    assert.equal(result.mutation.resultingGenerationId, "generation-b");
    assert.equal(result.mutation.generationChanged, true);
  });
});

test("command-scoped diagnostics participate in the single resulting compile", async () => {
  await withTempDir("command-protocol-diagnostics", async (dir) => {
    const snapshot = snapshotFixture(dir, "generation-stable");
    const loadDecision = async (input: {
      facts?: { diagnostics?: Parameters<typeof compileDecisionPlan>[1] };
    }) => ({
      ok: true as const,
      attempts: 1,
      snapshot,
      plan: compileDecisionPlan(snapshot, input.facts?.diagnostics || []),
    });

    const protocol = await withSessionMutationLock(dir, "doctor", async () =>
      runCommandDecisionProtocol({
        command: "doctor",
        requestedCwd: dir,
        expectedWorkDir: dir,
        loadDecision,
        mutate: async () =>
          withCommandDecisionDiagnostics({ ok: false }, [
            decisionDiagnostic("packet-diagnostic", { message: "benchmark failed" }),
          ]),
      }),
    );

    assert.equal(protocol.preconditionDecision.primaryBlockerCode, null);
    assert.equal(protocol.resultingDecision.primaryBlockerCode, "packet-diagnostic");
    assert.equal(protocol.resultingDecision.action.kind, "inspect-packet");
  });
});

test("command decision protocol refuses use outside the mutation lock", async () => {
  await assert.rejects(
    runCommandDecisionProtocol({
      command: "setup",
      requestedCwd: "/requested",
      expectedWorkDir: "/requested",
      loadDecision: async () => {
        throw new Error("must not read");
      },
      mutate: async () => ({ ok: true }),
    }),
    /requires the session mutation lock/i,
  );
});

test("command decision protocol rejects routing-config drift before mutation", async () => {
  await withTempDir("command-route-drift", async (dir) => {
    const lockedWorkDir = path.join(dir, "locked");
    const routedWorkDir = path.join(dir, "routed");
    await Promise.all([mkdir(lockedWorkDir), mkdir(routedWorkDir)]);
    let mutated = false;

    await withSessionMutationLock(lockedWorkDir, "config", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "config",
          requestedCwd: dir,
          expectedWorkDir: lockedWorkDir,
          loadDecision: async () => {
            const snapshot = snapshotFixture(routedWorkDir, "generation-routed", dir);
            return {
              ok: true as const,
              attempts: 1,
              snapshot,
              plan: compileDecisionPlan(snapshot, []),
            };
          },
          mutate: async () => {
            mutated = true;
            return { ok: true };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandDecisionProtocolError);
          assert.equal(error.code, "session-route-changed");
          return true;
        },
      );
    });

    assert.equal(mutated, false);
  });
});

test("command decision protocol passes the accepted snapshot route into mutation", async () => {
  await withTempDir("command-accepted-route", async (dir) => {
    const sessionCwd = path.join(dir, "session");
    const workDir = path.join(sessionCwd, "target");
    await mkdir(workDir, { recursive: true });
    const snapshot = snapshotFixture(workDir, "generation-routed", sessionCwd);

    await withSessionMutationLock(workDir, "config", async () => {
      const result = await runCommandDecisionProtocol({
        command: "config",
        requestedCwd: sessionCwd,
        expectedWorkDir: workDir,
        loadDecision: async () => ({
          ok: true as const,
          attempts: 1,
          snapshot,
          plan: compileDecisionPlan(snapshot, []),
        }),
        mutate: async (route) => route,
      });
      assert.deepEqual(result.result, {
        sessionCwd,
        workDir,
        config: snapshot.config,
        preconditionDecision: result.preconditionDecision,
      });
    });
  });
});

test("setup without an owning config writes only beneath the requested cwd", async () => {
  await withTempDir("command-initial-setup-route", async (dir) => {
    const scope = path.join(dir, "src");
    await mkdir(scope, { recursive: true });
    const packageArtifacts = [
      "autoresearch.config.json",
      "autoresearch.jsonl",
      "autoresearch.md",
      "autoresearch.sh",
      "autoresearch.ideas.md",
      process.platform === "win32" ? "autoresearch.checks.ps1" : "autoresearch.checks.sh",
    ].map((name) => path.join(pluginRoot, name));
    for (const artifact of packageArtifacts) {
      await assert.rejects(access(artifact), { code: "ENOENT" });
    }

    const result = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "initial routed setup",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
      "--checks-command",
      `${quoteForShell(process.execPath)} -e "process.exit(0)"`,
      "--scope",
      "src",
      "--commit-paths",
      "src",
    ]);

    assert.equal(result.code, 0, result.stderr);
    await access(path.join(dir, "autoresearch.config.json"));
    await access(path.join(dir, "autoresearch.jsonl"));
    for (const artifact of packageArtifacts) {
      await assert.rejects(access(artifact), { code: "ENOENT" });
    }
  });
});

test("recovery-only mutation permits only the typed recovery command", async () => {
  await withTempDir("command-recovery-capability", async (dir) => {
    const snapshot = snapshotFixture(dir, "generation-recovery");
    snapshot.pendingTransaction = {
      kind: "pending-log-transaction",
      diagnosticCode: "pending-log-transaction",
      transactionId: "transaction-a",
      status: "pending",
    } as CoherentSessionSnapshot["pendingTransaction"];
    const loadDecision = async () => ({
      ok: true as const,
      attempts: 1,
      snapshot,
      plan: compileDecisionPlan(snapshot, []),
    });
    let mutated = false;
    await withSessionMutationLock(dir, "setup", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "setup",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision,
          mutate: async () => {
            mutated = true;
            return { ok: true };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandDecisionProtocolError);
          assert.equal(error.code, "mutation-precondition-blocked");
          return true;
        },
      );
    });
    assert.equal(mutated, false);

    await withSessionMutationLock(dir, "log", async () => {
      const result = await runCommandDecisionProtocol({
        command: "log",
        requestedCwd: dir,
        expectedWorkDir: dir,
        loadDecision,
        mutate: async () => ({ ok: true }),
      });
      assert.deepEqual(result.result, { ok: true });
    });
  });
});

test("failed mutations still capture the persisted resulting decision under the lock", async () => {
  await withTempDir("command-protocol-failure", async (dir) => {
    let generation = "generation-before-failure";
    await withSessionMutationLock(dir, "next", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "next",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision: async () => {
            const snapshot = snapshotFixture(dir, generation);
            return {
              ok: true as const,
              attempts: 1,
              snapshot,
              plan: compileDecisionPlan(snapshot, []),
            };
          },
          mutate: async () => {
            generation = "generation-after-failure-persistence";
            throw new Error("process termination could not be proven");
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandDecisionProtocolError);
          assert.equal(error.code, "mutation-failed");
          assert.equal(error.mutation?.status, "failed");
          assert.equal(
            error.mutation?.resultingGenerationId,
            "generation-after-failure-persistence",
          );
          assert.equal(
            error.resultingDecision?.generationId,
            "generation-after-failure-persistence",
          );
          return true;
        },
      );
    });
  });
});

test("real mutating CLI routes setup and doctor benchmark checks through the protocol", async () => {
  await withTempDir("command-protocol-cli", async (dir) => {
    await mkdir(path.join(dir, "src"));
    const benchmark = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "mutation protocol",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--checks-command",
      checks,
      "--scope",
      "src",
      "--packet-budget",
      "3",
      "--max-iterations",
      "3",
    ]);
    assert.equal(setup.code, 0, setup.stderr);
    assertProtocolOutput(JSON.parse(setup.stdout), "setup");

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assertProtocolOutput(JSON.parse(doctor.stdout), "doctor");
  });
});

test("standalone finalizer plan route emits the shared mutation protocol", async () => {
  await withTempDir("standalone-finalizer-protocol", async (dir) => {
    const fixture = await createEvidencePlanFixture(dir, "standalone-protocol");
    const output = path.join(dir, "standalone-protocol-second.groups.json");
    const result = await runFinalizer(
      process.execPath,
      [
        finalizer,
        "plan",
        "--cwd",
        fixture.repo,
        "--output",
        output,
        "--goal",
        "standalone-protocol",
      ],
      pluginRoot,
      true,
    );
    assert.equal(result.code, 0, result.stderr);
    const protocolLine = result.stdout
      .trim()
      .split("\n")
      .reverse()
      .find((line) => line.startsWith('{"preconditionDecision"'));
    assert.ok(protocolLine, result.stdout);
    assertProtocolOutput(JSON.parse(protocolLine), "finalize-autoresearch:plan");
  });
});

function assertProtocolOutput(output: Record<string, any>, command: string): void {
  assert.equal(output.preconditionDecision?.kind, "decision-plan");
  assert.equal(output.mutation?.kind, "command-mutation-receipt");
  assert.equal(output.mutation?.command, command);
  assert.equal(output.mutation?.status, "completed");
  assert.equal(output.resultingDecision?.kind, "decision-plan");
}

function snapshotFixture(
  workDir: string,
  generationId: string,
  sessionCwd = workDir,
): CoherentSessionSnapshot {
  return {
    kind: "coherent-session-snapshot",
    schemaVersion: 1,
    generationId,
    sessionCwd,
    workDir,
    vector: {
      ledger: { size: 0, mtimeNs: "missing", tailHash: "missing" },
      config: { storage: "session", hash: "missing" },
      packet: { storage: "worktree", hash: "missing" },
      receipt: { storage: "worktree", hash: "missing" },
      process: { storage: "worktree", hash: "missing" },
      git: { head: "unborn", indexTree: "empty-index", statusHash: "status" },
    },
    records: [],
    config: {},
    lastRunPacket: null,
    pendingTransaction: null,
    processProgress: null,
    git: { head: "unborn", indexTree: "empty-index", statusHash: "status" },
    sourceDiagnostics: { ledgerIssues: [] },
    semanticFacts: {
      contractDigest: "",
      evaluatorIdentity: "",
      acceptedCheckIdentities: [],
      preconditionEpoch: "",
    },
  };
}
