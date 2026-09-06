import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli, withTempDir } from "../helpers/cli-test-context.js";
import { actionFixture, governedFixture } from "../helpers/outcome-fixtures.js";

async function writeInput(root: string, name: string, value: unknown): Promise<string> {
  const file = path.join(root, name);
  await fsp.writeFile(file, JSON.stringify(value));
  return file;
}

test("the ordinary CLI starts an explicit outcome, resumes a ticket, and logs without a metric", async () => {
  await withTempDir("outcome-cli", async (root) => {
    const cwd = path.join(root, "project");
    await fsp.mkdir(cwd);
    const contract = await writeInput(root, "outcome.json", governedFixture(cwd));
    const action = await writeInput(root, "action.json", actionFixture("A1"));
    const missing = await runCli(["next", "--cwd", cwd, "--action-file", action]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /explicit resource budget/);
    const start = await runCli(["outcome", "start", "--cwd", cwd, "--contract-file", contract]);
    assert.equal(start.code, 0, start.stderr);
    assert.equal(JSON.parse(start.stdout).resultingDecision.investigation.status, "active");
    const next = await runCli(["next", "--cwd", cwd, "--action-file", action]);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(JSON.parse(next.stdout).actionTicket.id, "A1");
    const resume = await runCli(["next", "--cwd", cwd, "--resume", "A1"]);
    assert.equal(resume.code, 0, resume.stderr);
    assert.equal(JSON.parse(resume.stdout).execution.id, "A1");
    const observation = await writeInput(root, "observation.json", {
      id: "E1",
      executionId: "A1",
      criterionId: "compatibility",
      text: "The fixture is incompatible",
      completed: true,
      observation: { observed: "counterexample" },
      resolution: "refuted",
    });
    const logged = await runCli(["log", "--cwd", cwd, "--observation-file", observation]);
    assert.equal(logged.code, 0, logged.stderr);
    assert.equal(JSON.parse(logged.stdout).evidence.result.validity, "valid");
    const reads = await Promise.all(
      ["state", "doctor", "recommend-next", "finalize-preview"].map((command) =>
        runCli([command, "--cwd", cwd]),
      ),
    );
    for (const result of reads) assert.equal(result.code, 0, result.stderr);
    const plans = reads.map((result) => JSON.parse(result.stdout).decisionPlanProjection);
    assert.equal(new Set(plans.map((plan) => plan.decisionId)).size, 1);
    for (const plan of plans) {
      assert.equal(plan.investigation.remaining.actions, 4);
      assert.deepEqual(plan.investigation.unresolvedCriteria, ["compatibility"]);
    }
    await assert.rejects(fsp.access(path.join(cwd, "autoresearch.jsonl")));
    const legacyMutation = await runCli([
      "new-segment",
      "--cwd",
      cwd,
      "--reason",
      "Reset effort",
      "--yes",
    ]);
    assert.equal(legacyMutation.code, 1);
    assert.match(legacyMutation.stderr, /legacy session mutation/);
  });
});
