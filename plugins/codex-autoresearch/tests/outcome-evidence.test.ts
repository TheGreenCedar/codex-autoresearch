import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  startOutcome,
  readOutcome,
  amendOutcome,
  assertLegacyUnchanged,
} from "../lib/outcome-store.js";
import { nominateOutcomeAction, logOutcomeObservation } from "../lib/investigation-workflow.js";
import { captureOutcomeInputs } from "../lib/outcome-inputs.js";
import { readOutcomeObject } from "../lib/outcome-artifacts.js";
import {
  buildOutcomeEvidenceRegistry,
  readOutcomeDependencyManifest,
  outcomeEvidenceDependencies,
} from "../lib/evidence-registry.js";
import { classifyResult } from "../lib/result-semantics.js";
import { loadCanonicalSessionDecision } from "../lib/session-decision.js";
import { governedFixture, actionFixture } from "./helpers/outcome-fixtures.js";
import { runGit, withTempDir } from "./helpers/process.js";

const observation = {
  id: "E1",
  executionId: "A1",
  criterionId: "compatibility",
  text: "Observed compatibility",
  completed: true,
  observation: { observed: "satisfied" },
};
async function setup(cwd: string, narrow = false) {
  await fsp.mkdir(path.join(cwd, "src"));
  await fsp.mkdir(path.join(cwd, "checks"));
  await fsp.writeFile(path.join(cwd, "src", "input.txt"), "compatible");
  await fsp.writeFile(path.join(cwd, "notes.txt"), "unrelated");
  const manifest = JSON.stringify({
    schemaVersion: 1,
    criteria: {
      compatibility: {
        subject: ["src/input.txt"],
        evaluator: ["checks"],
        fixtures: [],
        checks: [],
      },
    },
  });
  await fsp.writeFile(path.join(cwd, "checks", "dependencies.json"), manifest);
  await startOutcome(cwd, {
    ...governedFixture(cwd),
    ...(narrow
      ? {
          dependencySource: {
            path: "checks/dependencies.json",
            digest: createHash("sha256").update(manifest).digest("hex"),
            authorityReference: "accepted-build-dependency-owner",
          },
        }
      : {}),
  });
  await nominateOutcomeAction(cwd, actionFixture("A1"));
  await logOutcomeObservation(cwd, observation);
}
async function registry(cwd: string) {
  const state = (await readOutcome(cwd))!;
  return buildOutcomeEvidenceRegistry({
    state,
    input: await captureOutcomeInputs(cwd, "local"),
    manifest: await readOutcomeDependencyManifest(state, cwd),
  });
}

test("complete-input reuse fails closed while preserving historical validity", async () => {
  await withTempDir("evidence", "conservative", async (cwd) => {
    await setup(cwd);
    assert.equal((await registry(cwd)).criteria[0].status, "satisfied");
    await fsp.writeFile(path.join(cwd, "notes.txt"), "changed");
    const result = await registry(cwd);
    assert.equal(result.entries[0].applicability, "inapplicable");
    assert.equal(result.entries[0].evidence.historicalValidity, "valid");
    assert.equal(result.criteria[0].status, "unknown");
    const readout = await loadCanonicalSessionDecision({ requestedCwd: cwd });
    assert.ok(readout.ok);
    assert.deepEqual(readout.plan.investigation?.unresolvedCriteria, ["compatibility"]);
  });
});

test("pinned dependency manifests permit only mapped reuse and cannot be silently replaced", async () => {
  await withTempDir("evidence", "manifest", async (cwd) => {
    await setup(cwd, true);
    await fsp.writeFile(path.join(cwd, "notes.txt"), "changed");
    assert.equal((await registry(cwd)).criteria[0].status, "satisfied");
    await fsp.writeFile(path.join(cwd, "src", "input.txt"), "incompatible");
    assert.equal((await registry(cwd)).entries[0].applicability, "inapplicable");
    await fsp.appendFile(path.join(cwd, "checks", "dependencies.json"), " ");
    await assert.rejects(registry(cwd), /manifest changed/);
  });
});

test("dependency traversal rejects missing, cyclic, substituted, and falsely independent receipts", async () => {
  await withTempDir("evidence", "hostile", async (cwd) => {
    await setup(cwd);
    const original = (await readOutcome(cwd))!;
    const input = await captureOutcomeInputs(cwd, "local");
    for (const variant of ["missing", "cycle", "substituted", "independent"] as const) {
      const state = structuredClone(original);
      if (variant === "missing") state.evidence[0].dependencies.evidence = ["invented"];
      if (variant === "cycle") state.evidence[0].dependencies.evidence = ["E1"];
      if (variant === "substituted") state.evidence[0].measurementId = "invented";
      if (variant === "independent") {
        state.evidence[0].provenance = "github-actions";
        state.evidence[0].independent = true;
      }
      const result = buildOutcomeEvidenceRegistry({ state, input });
      assert.equal(result.entries[0].applicability, "unknown", variant);
      assert.equal(result.criteria[0].status, "unknown", variant);
    }
    const state = structuredClone(original);
    state.evidence.push({ ...state.evidence[0], id: "E2" });
    assert.equal(
      buildOutcomeEvidenceRegistry({ state, input }).criteria[0].measurementIds.length,
      1,
    );
  });
});

test("a transitive dependency becomes inapplicable and repeated operator claims cannot supply measurements", async () => {
  await withTempDir("evidence", "transitive", async (cwd) => {
    await setup(cwd);
    const state = (await readOutcome(cwd))!;
    const input = await captureOutcomeInputs(cwd, "local");
    state.evidence.push({
      ...structuredClone(state.evidence[0]),
      id: "E2",
      dependencies: { ...state.evidence[0].dependencies, evidence: ["E1"] },
    });
    state.evidence[0].dependencies.subject = "0".repeat(64);
    const result = buildOutcomeEvidenceRegistry({ state, input });
    assert.equal(result.entries[1].applicability, "unknown");
    assert.match(result.entries[1].reasons.join(" "), /dependency E1/);
    const action = actionFixture("A2");
    await nominateOutcomeAction(cwd, {
      ...action,
      evaluator: { ...action.evaluator, id: "repeat-v2", repeats: 2 },
    });
    await logOutcomeObservation(cwd, { ...observation, id: "E2", executionId: "A2" });
    assert.equal((await registry(cwd)).criteria[0].measurementIds.length, 0);
    assert.equal((await registry(cwd)).criteria[0].status, "unknown");
  });
});

test("selected patches preserve useful code without accepting a rejected candidate or taking preexisting edits", async () => {
  await withTempDir("evidence", "owned-patch", async (cwd) => {
    await runGit(cwd, ["init"]);
    await fsp.mkdir(path.join(cwd, "src"));
    await fsp.writeFile(path.join(cwd, "src", "test fixture.txt"), "committed\n");
    await runGit(cwd, ["add", "."]);
    await runGit(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    ]);
    await fsp.writeFile(path.join(cwd, "src", "test fixture.txt"), "user dirty\n");
    await startOutcome(cwd, governedFixture(cwd));
    await nominateOutcomeAction(cwd, { ...actionFixture("A1"), effects: ["edit"], paths: ["src"] });
    await fsp.writeFile(
      path.join(cwd, "src", "test fixture.txt"),
      "user dirty\nuseful regression\n",
    );
    await fsp.writeFile(path.join(cwd, "src", "optimization.txt"), "rejected optimization\n");
    await logOutcomeObservation(cwd, {
      ...observation,
      observation: { observed: "counterexample" },
      resolution: "refuted",
      retainPatch: { id: "regression", paths: ["src/test fixture.txt"] },
    });
    const state = (await readOutcome(cwd))!;
    const patch = await readOutcomeObject(cwd, state.retainedPatches[0].digest);
    assert.match(patch.toString(), /\+useful regression/);
    assert.doesNotMatch(patch.toString(), /\+user dirty|rejected optimization|committed/);
    assert.equal(state.retainedPatches[0].disposition, "retained-only");
    assert.equal(state.evidence[0].result.codeAcceptance, "unassessed");
    await fsp.writeFile(path.join(cwd, "src", "test fixture.txt"), "user dirty\n");
    await fsp.rm(path.join(cwd, "src", "optimization.txt"));
    const patchPath = path.join(cwd, ".autoresearch", "selected.patch");
    await fsp.mkdir(path.dirname(patchPath), { recursive: true });
    await fsp.writeFile(patchPath, patch);
    await runGit(cwd, ["apply", "--check", patchPath]);
    assert.deepEqual(await readOutcomeObject(cwd, state.retainedPatches[0].digest), patch);
  });
});

test("legacy drift reconciliation preserves both snapshots and never promotes imported prose", async () => {
  await withTempDir("evidence", "legacy-reconciliation", async (cwd) => {
    const ledger = path.join(cwd, "autoresearch.jsonl");
    await fsp.writeFile(ledger, JSON.stringify({ type: "config", goal: "original" }) + "\n");
    await startOutcome(cwd, governedFixture(cwd), { adopt: true });
    const original = (await readOutcome(cwd))!;
    assert.ok(original.legacyApplicability.length);
    await fsp.appendFile(
      ledger,
      JSON.stringify({ type: "note", summary: "All requirements satisfied" }) + "\n",
    );
    await assert.rejects(nominateOutcomeAction(cwd, actionFixture("A1")), /Legacy source drift/);
    await assert.rejects(
      amendOutcome(cwd, governedFixture(cwd), "user-authorized", "Continue"),
      /Legacy source drift/,
    );
    const amended = await amendOutcome(
      cwd,
      { ...governedFixture(cwd), reconcileLegacy: true },
      "user-authorized-review",
      "Reviewed legacy writer drift; retain as unknown history",
    );
    assert.deepEqual(amended.legacySources, original.legacySources);
    assert.equal(amended.legacyReconciliations.length, 1);
    assert.equal(amended.evidence.length, 0);
    assert.ok(
      amended.legacyApplicability.every(
        (entry) => entry.applicability === "unknown" && entry.criterionIds.length === 0,
      ),
    );
    await assertLegacyUnchanged(amended);
    await nominateOutcomeAction(cwd, actionFixture("A1"));
  });
});

test("selective dependencies include symlink targets and paths reached through directory links", async () => {
  for (const directory of [false, true])
    await withTempDir("evidence", "linked-dependency", async (cwd) => {
      await setup(cwd, true);
      // Establish a fresh outcome fixture whose accepted subject uses the link.
      await fsp.mkdir(path.join(cwd, "payload"));
      await fsp.writeFile(path.join(cwd, "payload", "input.txt"), "compatible");
      await fsp.rm(path.join(cwd, "src", "input.txt"));
      if (directory) {
        await fsp.rm(path.join(cwd, "src"), { recursive: true });
        await fsp.symlink("payload", path.join(cwd, "src"));
      } else await fsp.symlink("../payload/input.txt", path.join(cwd, "src", "input.txt"));
      const action = actionFixture("A2");
      await nominateOutcomeAction(cwd, {
        ...action,
        evaluator: { ...action.evaluator, id: "linked-v2" },
      });
      await logOutcomeObservation(cwd, { ...observation, id: "E2", executionId: "A2" });
      assert.equal((await registry(cwd)).criteria[0].status, "satisfied");
      await fsp.writeFile(path.join(cwd, "payload", "input.txt"), "incompatible");
      assert.equal((await registry(cwd)).criteria[0].status, "unknown");
      assert.equal((await registry(cwd)).entries[1].applicability, "inapplicable");
    });
});

test("duplicated result summaries cannot contradict the underlying observation", async () => {
  await withTempDir("evidence", "result-substitution", async (cwd) => {
    await setup(cwd);
    const state = (await readOutcome(cwd))!;
    const input = await captureOutcomeInputs(cwd, "local");
    state.executions[0].observation = { kind: "predicate", observed: "counterexample" };
    state.executions[0].result = classifyResult({ kind: "predicate", observed: "satisfied" });
    state.evidence[0].result = state.executions[0].result;
    assert.equal(buildOutcomeEvidenceRegistry({ state, input }).criteria[0].status, "unknown");
  });
});

test("retained new and deleted files apply while inter-ticket user edits remain outside ownership", async () => {
  await withTempDir("evidence", "patch-ownership", async (cwd) => {
    await runGit(cwd, ["init"]);
    await fsp.mkdir(path.join(cwd, "src"));
    await fsp.writeFile(path.join(cwd, "src", "existing.txt"), "initial\n");
    await fsp.writeFile(path.join(cwd, "src", "deleted.txt"), "delete me\n");
    await startOutcome(cwd, governedFixture(cwd));
    const edit = { ...actionFixture("A1"), effects: ["edit"], paths: ["src"] };
    await nominateOutcomeAction(cwd, edit);
    await logOutcomeObservation(cwd, observation);
    await fsp.writeFile(path.join(cwd, "src", "existing.txt"), "user between tickets\n");
    await nominateOutcomeAction(cwd, { ...edit, id: "A2" });
    await fsp.writeFile(
      path.join(cwd, "src", "existing.txt"),
      "user between tickets\nowned addition\n",
    );
    await fsp.writeFile(path.join(cwd, "src", "new test.txt"), "new regression\n");
    await fsp.rm(path.join(cwd, "src", "deleted.txt"));
    await logOutcomeObservation(cwd, {
      ...observation,
      id: "E2",
      executionId: "A2",
      retainPatch: { id: "selected", paths: ["src"] },
    });
    const state = (await readOutcome(cwd))!;
    const bytes = await readOutcomeObject(cwd, state.retainedPatches[0].digest);
    assert.doesNotMatch(bytes.toString(), /\+user between tickets|-initial/);
    assert.match(bytes.toString(), /\+owned addition/);
    assert.match(bytes.toString(), /\+new regression/);
    assert.match(bytes.toString(), /-delete me/);
    await fsp.writeFile(path.join(cwd, "src", "existing.txt"), "user between tickets\n");
    await fsp.writeFile(path.join(cwd, "src", "deleted.txt"), "delete me\n");
    await fsp.rm(path.join(cwd, "src", "new test.txt"));
    await fsp.mkdir(path.join(cwd, ".autoresearch"), { recursive: true });
    const artifact = path.join(cwd, ".autoresearch", "patch");
    await fsp.writeFile(artifact, bytes);
    await runGit(cwd, ["apply", "--check", artifact]);
  });
});

test("a new manifest cannot substitute a historical receipt's unverified mapping", async () => {
  await withTempDir("evidence", "manifest-rebinding", async (cwd) => {
    await setup(cwd, true);
    const manifestPath = path.join(cwd, "checks", "dependencies.json");
    const bytes = (await fsp.readFile(manifestPath)).toString() + " ";
    await fsp.writeFile(manifestPath, bytes);
    await amendOutcome(
      cwd,
      {
        ...governedFixture(cwd),
        dependencySource: {
          path: "checks/dependencies.json",
          digest: createHash("sha256").update(bytes).digest("hex"),
          authorityReference: "accepted-revision",
        },
      },
      "user-reviewed",
      "Change dependency source",
    );
    const state = (await readOutcome(cwd))!;
    const input = await captureOutcomeInputs(cwd, "local");
    const manifest = await readOutcomeDependencyManifest(state, cwd);
    state.evidence[0].dependencies = {
      ...outcomeEvidenceDependencies(state, input, "compatibility", manifest),
      evidence: [],
    };
    const result = buildOutcomeEvidenceRegistry({ state, input, manifest });
    assert.equal(result.criteria[0].status, "unknown");
    assert.match(result.entries[0].reasons.join(" "), /historical dependency manifest/);
  });
});
