import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CommandDecisionProtocolError,
  commandDecisionProtocolFailureEnvelope,
  runCommandDecisionProtocol,
} from "../../lib/command-decision-protocol.js";
import { compileDecisionPlan, decisionDiagnostic } from "../../lib/decision-compiler.js";
import type { CoherentSessionSnapshot } from "../../lib/coherent-session-snapshot.js";
import { publicState } from "../../lib/commands/state.js";
import {
  CanonicalSessionSourceError,
  loadCanonicalSessionDecision,
} from "../../lib/session-decision.js";
import {
  currentSessionMutationLockContext,
  withSessionMutationLock,
} from "../../lib/session-mutation-lock.js";
import { quoteForAcceptedShell } from "../helpers/process.js";
import { git, runCli, setupFixture, withTempDir } from "../helpers/cli-test-context.js";
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

test("doctor observations remain output-only while the protocol preserves canonical authority", async () => {
  await withTempDir("command-protocol-doctor-observations", async (dir) => {
    const missingMetricCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('no metric')"`;
    const setup = await setupFixture(dir, {
      name: "doctor observation authority",
      acceptedContract: true,
      benchmarkCommand: missingMetricCommand,
    });
    assert.equal(setup.code, 0, setup.stderr);

    const immediate = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(immediate.code, 0, immediate.stderr);
    const immediatePlan = JSON.parse(immediate.stdout).decisionPlanProjection;

    const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark", "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const payload = JSON.parse(doctor.stdout);

    assert.equal(payload.ok, false);
    assert.match(payload.issues.join("\n"), /primary metric/i);
    assert.equal(payload.benchmark.emitsPrimary, false);
    assert.equal(payload.preconditionDecision.decisionId, immediatePlan.decisionId);
    assert.equal(payload.preconditionDecision.generationId, immediatePlan.generationId);
    assert.deepEqual(payload.decisionPlan, payload.preconditionDecision);
    assert.deepEqual(payload.resultingDecision, payload.preconditionDecision);
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

test("command decision protocol normalizes only typed canonical source failures", async () => {
  await withTempDir("command-protocol-source-failure", async (dir) => {
    let mutated = false;
    const sourceFailure = new CanonicalSessionSourceError(
      "Corrupt autoresearch.jsonl at line 2: invalid JSON",
    );

    await withSessionMutationLock(dir, "setup", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "setup",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision: async () => {
            throw sourceFailure;
          },
          mutate: async () => {
            mutated = true;
            return { ok: true };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandDecisionProtocolError);
          assert.equal(error.code, "coherent-snapshot-source-invalid");
          assert.match(error.message, /precondition decision for setup/i);
          assert.match(error.message, /Corrupt autoresearch\.jsonl at line 2/i);
          assert.equal(error.preconditionDecision, null);
          assert.equal(error.mutation, null);
          assert.equal(error.resultingDecision, null);
          assert.deepEqual(commandDecisionProtocolFailureEnvelope(error), {
            code: "coherent-snapshot-source-invalid",
            message: error.message,
          });
          return true;
        },
      );
    });
    assert.equal(mutated, false);

    const programmingFailure = new Error("compiler invariant failed");
    await withSessionMutationLock(dir, "setup", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "setup",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision: async () => {
            throw programmingFailure;
          },
          mutate: async () => ({ ok: true }),
        }),
        (error: unknown) => {
          assert.equal(error, programmingFailure);
          assert.equal(error instanceof CommandDecisionProtocolError, false);
          return true;
        },
      );
    });

    const structuredFailure = new CommandDecisionProtocolError({
      code: "coherent-snapshot-unavailable",
      message: "three coherent attempts exhausted",
    });
    await withSessionMutationLock(dir, "setup", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "setup",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision: async () => {
            throw structuredFailure;
          },
          mutate: async () => ({ ok: true }),
        }),
        (error: unknown) => {
          assert.equal(error, structuredFailure);
          return true;
        },
      );
    });
  });
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
      assert.equal(result.result.sessionCwd, sessionCwd);
      assert.equal(result.result.workDir, workDir);
      assert.equal(result.result.config, snapshot.config);
      assert.equal(result.result.snapshot, snapshot);
      assert.equal(result.result.factCollection, undefined);
      assert.equal(result.result.preconditionDecision, result.preconditionDecision);
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
      `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
      "--checks-command",
      `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`,
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

test("typed recovery cannot bypass an unrelated concrete capability blocker", async () => {
  await withTempDir("command-recovery-capability-intersection", async (dir) => {
    const snapshot = snapshotFixture(dir, "generation-recovery-intersection");
    const plan = compileDecisionPlan(snapshot, [
      decisionDiagnostic("stale-packet"),
      decisionDiagnostic("active-process"),
    ]);
    assert.equal(plan.capabilities["mutate-session"], "allowed");
    assert.equal(plan.capabilities["run-packet"], "blocked");
    let mutated = false;

    await withSessionMutationLock(dir, "next", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "next",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision: async () => ({ ok: true as const, attempts: 1, snapshot, plan }),
          mutate: async () => {
            mutated = true;
            return { ok: true };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandDecisionProtocolError);
          assert.equal(error.code, "mutation-precondition-blocked");
          assert.match(error.message, /run-packet/);
          return true;
        },
      );
    });

    assert.equal(mutated, false);
  });
});

test("current-tree finalization recovery admits only the exceptional command", async () => {
  await withTempDir("command-current-tree-finalization", async (dir) => {
    const snapshot = snapshotFixture(dir, "generation-current-tree-finalization");
    const recoveryPlan = compileDecisionPlan(snapshot, [
      decisionDiagnostic("current-tree-finalization"),
    ]);
    assert.equal(recoveryPlan.capabilities.finalize, "recovery-only");
    const recoveryLoader = async () => ({
      ok: true as const,
      attempts: 1,
      snapshot,
      plan: recoveryPlan,
    });

    await withSessionMutationLock(dir, "finalize-current-tree", async () => {
      const result = await runCommandDecisionProtocol({
        command: "finalize-current-tree",
        requestedCwd: dir,
        expectedWorkDir: dir,
        loadDecision: recoveryLoader,
        mutate: async () => ({ ready: true }),
      });
      assert.deepEqual(result.result, { ready: true });
    });

    let currentTreeApplyMutated = false;
    await withSessionMutationLock(dir, "finalize-autoresearch:apply", async () => {
      const result = await runCommandDecisionProtocol({
        command: "finalize-autoresearch:apply",
        requestedCwd: dir,
        expectedWorkDir: dir,
        loadDecision: recoveryLoader,
        mutate: async () => {
          currentTreeApplyMutated = true;
          return { ready: true };
        },
      });
      assert.deepEqual(result.result, { ready: true });
    });
    assert.equal(currentTreeApplyMutated, true);

    let ordinaryPlanMutated = false;
    await withSessionMutationLock(dir, "finalize-autoresearch:plan", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "finalize-autoresearch:plan",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision: recoveryLoader,
          mutate: async () => {
            ordinaryPlanMutated = true;
            return { ready: true };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandDecisionProtocolError);
          assert.equal(error.code, "mutation-precondition-blocked");
          return true;
        },
      );
    });
    assert.equal(ordinaryPlanMutated, false);

    const ordinaryReadyPlan = compileDecisionPlan(snapshot, [
      decisionDiagnostic("finalization-ready"),
    ]);
    let exceptionalCommandMutated = false;
    await withSessionMutationLock(dir, "finalize-current-tree", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "finalize-current-tree",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision: async () => ({
            ok: true as const,
            attempts: 1,
            snapshot,
            plan: ordinaryReadyPlan,
          }),
          mutate: async () => {
            exceptionalCommandMutated = true;
            return { ready: true };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandDecisionProtocolError);
          assert.equal(error.code, "mutation-precondition-blocked");
          assert.match(error.message, /current-tree-finalization/);
          return true;
        },
      );
    });
    assert.equal(exceptionalCommandMutated, false);

    const blockedPlan = compileDecisionPlan(snapshot, [
      decisionDiagnostic("current-tree-finalization"),
      decisionDiagnostic("goal-mismatch"),
    ]);
    assert.equal(blockedPlan.capabilities.finalize, "blocked");
    let blockedRecoveryMutated = false;
    await withSessionMutationLock(dir, "finalize-current-tree", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "finalize-current-tree",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision: async () => ({
            ok: true as const,
            attempts: 1,
            snapshot,
            plan: blockedPlan,
          }),
          mutate: async () => {
            blockedRecoveryMutated = true;
            return { ready: true };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandDecisionProtocolError);
          assert.equal(error.code, "mutation-precondition-blocked");
          return true;
        },
      );
    });
    assert.equal(blockedRecoveryMutated, false);
  });
});

test("finalize-current-tree requires the exceptional canonical route", async () => {
  await withTempDir("command-current-tree-route-required", async (dir) => {
    const snapshot = snapshotFixture(dir, "generation-finalization-ready");
    const ordinaryReadyPlan = compileDecisionPlan(snapshot, [
      decisionDiagnostic("finalization-ready"),
    ]);
    let mutated = false;
    await withSessionMutationLock(dir, "finalize-current-tree", async () => {
      await assert.rejects(
        runCommandDecisionProtocol({
          command: "finalize-current-tree",
          requestedCwd: dir,
          expectedWorkDir: dir,
          loadDecision: async () => ({
            ok: true as const,
            attempts: 1,
            snapshot,
            plan: ordinaryReadyPlan,
          }),
          mutate: async () => {
            mutated = true;
            return { ready: true };
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandDecisionProtocolError);
          assert.equal(error.code, "mutation-precondition-blocked");
          assert.match(error.message, /current-tree-finalization/);
          return true;
        },
      );
    });
    assert.equal(mutated, false);
  });
});

test("locked protocol enforces the concrete command capability before mutation", async () => {
  await withTempDir("command-concrete-capability", async (dir) => {
    const cases = [
      {
        command: "log",
        commandArgs: { status: "keep" },
        diagnostic: decisionDiagnostic("quality-evidence-required"),
        capability: "authorize-keep",
      },
      {
        command: "finalize-autoresearch:apply",
        diagnostic: decisionDiagnostic("finalization-blocked"),
        capability: "finalize",
      },
      {
        command: "next",
        diagnostic: decisionDiagnostic("packet-budget-exhausted"),
        capability: "run-packet",
      },
      {
        command: "new-segment",
        diagnostic: decisionDiagnostic("pending-log-transaction-inconsistent"),
        capability: "transition-segment",
        keepMutationAllowed: true,
      },
    ] as const;
    for (const item of cases) {
      const snapshot = snapshotFixture(dir, `generation-${item.capability}`);
      const plan = compileDecisionPlan(snapshot, [item.diagnostic]);
      if ("keepMutationAllowed" in item) plan.capabilities["mutate-session"] = "allowed";
      assert.notEqual(plan.capabilities[item.capability], "allowed");
      let mutated = false;
      await withSessionMutationLock(dir, item.command, async () => {
        await assert.rejects(
          runCommandDecisionProtocol({
            command: item.command,
            ...("commandArgs" in item ? { commandArgs: item.commandArgs } : {}),
            requestedCwd: dir,
            expectedWorkDir: dir,
            loadDecision: async () => ({ ok: true as const, attempts: 1, snapshot, plan }),
            mutate: async () => {
              mutated = true;
              return { ok: true };
            },
          }),
          (error: unknown) => {
            assert.ok(error instanceof CommandDecisionProtocolError);
            assert.equal(error.code, "mutation-precondition-blocked");
            assert.match(error.message, new RegExp(item.capability));
            return true;
          },
        );
      });
      assert.equal(mutated, false, item.command);
    }
  });
});

test("state and a locked mutation precondition compile one decision for the same generation", async () => {
  await withTempDir("command-complete-canonical-facts", async (dir) => {
    await mkdir(path.join(dir, "src"));
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "complete canonical facts",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
      "--checks-command",
      `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`,
      "--scope",
      "src",
      "--commit-paths",
      "src",
    ]);
    assert.equal(setup.code, 0, setup.stderr);

    const stateResult = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(stateResult.code, 0, stateResult.stderr);
    const state = JSON.parse(stateResult.stdout);
    const mutationResult = await runCli(["config", "--cwd", dir, "--max-iterations", "7"]);
    assert.equal(mutationResult.code, 0, mutationResult.stderr);
    const mutation = JSON.parse(mutationResult.stdout);
    const statePlan = state.decisionPlanProjection;
    const preconditionPlan = mutation.preconditionDecision;

    assert.equal(preconditionPlan.generationId, statePlan.generationId);
    assert.equal(preconditionPlan.decisionId, statePlan.decisionId);
    assert.equal(preconditionPlan.primaryBlockerCode, statePlan.primaryBlockerCode);
    assert.equal(preconditionPlan.capabilities.finalize, statePlan.capabilities.finalize);
    assert.deepEqual(preconditionPlan.loopDisposition, statePlan.loopDisposition);
    assert.deepEqual(preconditionPlan.parentDisposition, statePlan.parentDisposition);
  });
});

test("state reuses the accepted canonical plan and fact collection without recollecting", async () => {
  await withTempDir("state-accepted-canonical-facts", async (dir) => {
    await git(dir, ["init", "-b", "main"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, ".gitignore"), "autoresearch*\n");
    await writeFile(path.join(dir, "autoresearch.sh"), "echo committed\n");
    await git(dir, ["add", ".gitignore"]);
    await git(dir, ["add", "-f", "autoresearch.sh"]);
    await git(dir, ["commit", "-m", "baseline scaffold"]);
    const setup = await setupFixture(dir, {
      name: "accepted canonical facts",
      acceptedContract: true,
    });
    assert.equal(setup.code, 0, setup.stderr);
    await writeFile(path.join(dir, "autoresearch.sh"), "echo 'METRIC seconds=1'\n");

    const loaded = await loadCanonicalSessionDecision({ requestedCwd: dir });
    assert.equal(loaded.ok, true);
    if (!loaded.ok || !loaded.factCollection) assert.fail("canonical decision facts are required");
    const acceptedScaffoldHealth = structuredClone(loaded.factCollection.scaffoldHealth);
    const acceptedChecks = acceptedScaffoldHealth.checks;
    assert.ok(Array.isArray(acceptedChecks));
    assert.equal(
      acceptedChecks.some(
        (check) =>
          check && typeof check === "object" && "severity" in check && check.severity === "blocker",
      ),
      false,
    );

    // This would alter a fresh fact collection, but the supplied snapshot, plan, and facts
    // are one already-accepted coherent capture and must remain the sole authority.
    await writeFile(path.join(dir, "autoresearch.sh"), "bash ./autoresearch.sh\n");
    const state = await publicState({
      cwd: dir,
      coherentSnapshot: loaded.snapshot,
      canonicalDecisionPlan: loaded.plan,
      canonicalDecisionFacts: loaded.factCollection,
    });
    const statePlan = state.decisionPlan as Record<string, unknown>;

    assert.equal(statePlan.generationId, loaded.plan.generationId);
    assert.equal(statePlan.decisionId, loaded.plan.decisionId);
    assert.deepEqual(state.scaffoldHealth, acceptedScaffoldHealth);
  });
});

test("state rejects a kind-and-schema-version DecisionPlan lookalike", async () => {
  await withTempDir("state-rejects-decision-lookalike", async (dir) => {
    const setup = await setupFixture(dir, {
      name: "decision lookalike",
      acceptedContract: true,
    });
    assert.equal(setup.code, 0, setup.stderr);
    const loaded = await loadCanonicalSessionDecision({ requestedCwd: dir });
    assert.equal(loaded.ok, true);
    if (!loaded.ok || !loaded.factCollection) assert.fail("canonical decision facts are required");

    const lookalike = {
      ...loaded.plan,
      schemaVersion: 1,
      compilerSchemaVersion: 999,
      decisionId: "forged-decision-id",
      action: {
        ...loaded.plan.action,
        commandDigest: 123,
      },
    };
    const state = await publicState({
      cwd: dir,
      compact: true,
      coherentSnapshot: loaded.snapshot,
      canonicalDecisionPlan: lookalike,
      canonicalDecisionFacts: loaded.factCollection,
    });
    const statePlan = state.decisionPlanProjection as Record<string, unknown>;
    const action = statePlan.action as Record<string, unknown>;

    assert.equal(statePlan.compilerSchemaVersion, loaded.plan.compilerSchemaVersion);
    assert.equal(statePlan.decisionId, loaded.plan.decisionId);
    assert.equal(action.commandDigest, loaded.plan.action.commandDigest);
  });
});

test("same-status scaffold facts change the decision without entering the raw generation", async () => {
  await withTempDir("command-derived-fact-generation", async (dir) => {
    await git(dir, ["init", "-b", "main"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, ".gitignore"), "autoresearch*\n");
    await writeFile(path.join(dir, "autoresearch.sh"), "echo committed\n");
    await git(dir, ["add", ".gitignore"]);
    await git(dir, ["add", "-f", "autoresearch.sh"]);
    await git(dir, ["commit", "-m", "baseline scaffold"]);
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "derived fact generation",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
      "--checks-command",
      `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`,
      "--scope",
      "src",
      "--commit-paths",
      "src",
    ]);
    assert.equal(setup.code, 0, setup.stderr);

    await writeFile(path.join(dir, "autoresearch.sh"), "echo 'METRIC seconds=1'\n");
    const valid = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(valid.code, 0, valid.stderr);
    const validPlan = JSON.parse(valid.stdout).decisionPlanProjection;
    assert.equal(validPlan.requiredEvidence.diagnosticCodes.includes("scaffold-invalid"), false);

    await writeFile(path.join(dir, "autoresearch.sh"), "bash ./autoresearch.sh\n");
    const recursive = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(recursive.code, 0, recursive.stderr);
    const recursivePlan = JSON.parse(recursive.stdout).decisionPlanProjection;
    assert.equal(recursivePlan.requiredEvidence.diagnosticCodes.includes("scaffold-invalid"), true);
    assert.equal(recursivePlan.generationId, validPlan.generationId);
    assert.notEqual(recursivePlan.decisionId, validPlan.decisionId);
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

test("failed mutations retain authority when the resulting decision capture also fails", async (t) => {
  const captureFailures = [
    {
      name: "thrown source read",
      capture: async () => {
        throw new Error("resulting capture exploded");
      },
      expectedMessage: /resulting capture exploded/,
    },
    {
      name: "typed invalid source",
      capture: async () => ({
        ok: false as const,
        attempts: 1,
        diagnostic: {
          code: "coherent-snapshot-source-invalid" as const,
          message: "persisted marker left the ledger source invalid",
        },
      }),
      expectedMessage: /persisted marker left the ledger source invalid/,
    },
  ] as const;

  for (const captureFailure of captureFailures) {
    await t.test(captureFailure.name, async () => {
      await withTempDir(`command-protocol-double-failure-${captureFailure.name}`, async (dir) => {
        const marker = path.join(dir, "persisted-before-failure.marker");
        const snapshot = snapshotFixture(dir, "generation-before-double-failure");
        const preconditionPlan = compileDecisionPlan(snapshot, []);
        let captureCount = 0;

        await withSessionMutationLock(dir, "next", async () => {
          await assert.rejects(
            runCommandDecisionProtocol({
              command: "next",
              requestedCwd: dir,
              expectedWorkDir: dir,
              loadDecision: async () => {
                captureCount += 1;
                if (captureCount === 1) {
                  return {
                    ok: true as const,
                    attempts: 1,
                    snapshot,
                    plan: preconditionPlan,
                  };
                }
                return await captureFailure.capture();
              },
              mutate: async () => {
                await writeFile(marker, "persisted\n");
                throw new Error("mutation persisted then failed");
              },
            }),
            (error: unknown) => {
              assert.ok(error instanceof CommandDecisionProtocolError);
              const protocolError = error as CommandDecisionProtocolError & {
                resultingCaptureDiagnostic?: { code?: unknown; message?: unknown };
              };
              assert.equal(protocolError.code, "mutation-failed");
              assert.match(protocolError.message, /mutation persisted then failed/);
              assert.equal(protocolError.preconditionDecision, preconditionPlan);
              assert.equal(protocolError.mutation?.command, "next");
              assert.equal(protocolError.mutation?.status, "failed");
              assert.equal(
                protocolError.mutation?.preconditionGenerationId,
                preconditionPlan.generationId,
              );
              assert.equal(protocolError.resultingDecision, null);
              assert.equal(
                protocolError.resultingCaptureDiagnostic?.code,
                "coherent-snapshot-source-invalid",
              );
              assert.match(
                String(protocolError.resultingCaptureDiagnostic?.message || ""),
                captureFailure.expectedMessage,
              );

              const envelope = commandDecisionProtocolFailureEnvelope(protocolError);
              assert.equal(envelope.preconditionDecision, preconditionPlan);
              assert.equal(envelope.mutation, protocolError.mutation);
              assert.deepEqual(
                envelope.resultingCaptureDiagnostic,
                protocolError.resultingCaptureDiagnostic,
              );
              assert.equal(Object.hasOwn(envelope, "resultingDecision"), false);
              return true;
            },
          );
        });

        assert.equal(captureCount, 2);
        await access(marker);
      });
    });
  }
});

test("real mutating CLI routes setup and doctor benchmark checks through the protocol", async () => {
  await withTempDir("command-protocol-cli", async (dir) => {
    await mkdir(path.join(dir, "src"));
    const benchmark = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const checks = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;
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
