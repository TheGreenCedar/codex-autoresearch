import { createHash } from "node:crypto";
import { withOutcomeMutation } from "../lib/outcome-store.js";
import { storeOutcomeObject } from "../lib/outcome-artifacts.js";
import { verifiedOutcomeDeliveries } from "../lib/outcome-delivery.js";
import type { GitHubTransport } from "../lib/github-artifact.js";
import { captureOutcomeInputs } from "../lib/outcome-inputs.js";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startOutcome, readOutcome, outcomeStateLocation } from "../lib/outcome-store.js";
import { nominateOutcomeAction, logOutcomeObservation } from "../lib/investigation-workflow.js";
import { launchOutcomeWorker } from "../lib/outcome-worker.js";
import { logOutcomeDelivery } from "../lib/outcome-delivery.js";
import { readOutcomeObject } from "../lib/outcome-artifacts.js";
import { maybeOutcomeReadout } from "../lib/commands/outcome.js";
import { governedFixture, actionFixture } from "./helpers/outcome-fixtures.js";
import { withTempDir } from "./helpers/process.js";

async function fixture(
  cwd: string,
  endpoint = "patch",
  options: { twoFiles?: boolean; deliverySeconds?: number } = {},
) {
  await fsp.mkdir(path.join(cwd, "src"));
  await fsp.mkdir(path.join(cwd, "checks"));
  await fsp.writeFile(path.join(cwd, "src/value.txt"), "preexisting user change\n");
  await fsp.writeFile(
    path.join(cwd, "checks/evaluate.cjs"),
    `console.log('AUTORESEARCH_OBSERVATION {"kind":"predicate","observed":"satisfied"}');`,
  );
  if (options.twoFiles) await fsp.writeFile(path.join(cwd, "src/other.txt"), "original");
  const base = governedFixture(cwd);
  await startOutcome(cwd, {
    ...base,
    authorization: {
      ...base.authorization,
      delivery: endpoint,
      effects: [...base.authorization.effects, "git", "publish"],
    },
    deliveryTarget: ["integrated", "deployed"].includes(endpoint)
      ? { repository: "fixture/delivery", ref: "accepted", environment: "production" }
      : null,
    budget: { actions: 3, executionSeconds: 180 },
  });
  const action = actionFixture("A1");
  await nominateOutcomeAction(cwd, {
    ...action,
    purpose: "preparation",
    effects: ["edit"],
    paths: ["src"],
    seconds: 30,
    evaluator: null,
  });
  await fsp.writeFile(
    path.join(cwd, "src/value.txt"),
    "preexisting user change\nowned candidate\n",
  );
  if (options.twoFiles) await fsp.writeFile(path.join(cwd, "src/other.txt"), "owned second change");
  await logOutcomeObservation(cwd, {
    id: "E1",
    executionId: "A1",
    criterionId: "compatibility",
    text: "Prepared owned candidate",
    completed: true,
  });
  await nominateOutcomeAction(cwd, {
    ...action,
    id: "A2",
    mode: "process",
    effects: ["execute"],
    seconds: 30,
    evaluator: {
      ...action.evaluator,
      argv: [process.execPath, "checks/evaluate.cjs"],
      checkArgv: [process.execPath, "-e", "process.exit(0)"],
    },
  });
  await launchOutcomeWorker(cwd, "A2");
  const until = Date.now() + 10_000;
  while ((await readOutcome(cwd))!.executions[1].status.kind !== "completed") {
    if (Date.now() > until) throw new Error("Checks worker did not complete");
    await delay(50);
  }
  await logOutcomeObservation(cwd, {
    id: "E2",
    executionId: "A2",
    criterionId: "compatibility",
    text: "Actual current compatibility and correctness checks",
  });
  await nominateOutcomeAction(cwd, {
    ...action,
    id: "A3",
    purpose: "delivery",
    paths: endpoint === "integrated" ? ["src"] : [],
    effects: [
      "inspect",
      ...(endpoint === "integrated" ? ["git"] : endpoint === "deployed" ? ["publish"] : []),
    ],
    seconds: options.deliverySeconds ?? 30,
    evaluator: null,
  });
  return {
    id: "D1",
    executionId: "A3",
    delivery:
      endpoint === "answer"
        ? { answer: "The compatibility example passes." }
        : { candidateExecutionId: "A1", paths: ["src/value.txt"] },
  };
}

test("delivery accepts only the owned checked patch and completes even on the final action allowance", async () => {
  await withTempDir("delivery", "owned-patch", async (cwd) => {
    const input = await fixture(cwd);
    const before = await maybeOutcomeReadout({ cwd });
    assert.equal((before!.delivery as { status: string }).status, "ready");
    const delivered = await logOutcomeDelivery(cwd, input);
    const patch = (await readOutcomeObject(cwd, delivered.artifactDigest)).toString();
    assert.match(patch, /\+owned candidate/);
    assert.doesNotMatch(patch, /\+preexisting user change/);
    const state = (await readOutcome(cwd))!;
    assert.equal(state.executions[2].result?.codeAcceptance, "accepted");
    const readout = await maybeOutcomeReadout({ cwd });
    assert.equal((readout!.investigation as { status: string }).status, "satisfied");
    assert.equal((readout!.delivery as { status: string }).status, "delivered");
    assert.deepEqual(await logOutcomeDelivery(cwd, input), delivered);
    assert.equal((await readOutcome(cwd))!.deliveries.length, 1);
    await assert.rejects(
      logOutcomeDelivery(cwd, { ...input, delivery: { ...input.delivery, paths: ["checks"] } }),
      /different content/,
    );
    await fsp.writeFile(path.join(cwd, "src/value.txt"), "changed after delivery\n");
    assert.notEqual(
      ((await maybeOutcomeReadout({ cwd }))!.delivery as { status: string }).status,
      "delivered",
    );
  });
});

test("missing delivery artifacts and changed candidate inputs cannot establish completion", async () => {
  await withTempDir("delivery", "missing-artifact", async (cwd) => {
    const input = await fixture(cwd, "answer");
    const delivered = await logOutcomeDelivery(cwd, input);
    const owner = await outcomeStateLocation(cwd);
    await fsp.unlink(path.join(path.dirname(owner.path), "objects", delivered.artifactDigest));
    assert.notEqual(
      ((await maybeOutcomeReadout({ cwd }))!.delivery as { status: string }).status,
      "delivered",
    );
  });
  await withTempDir("delivery", "changed-candidate", async (cwd) => {
    const input = await fixture(cwd);
    await fsp.writeFile(path.join(cwd, "src/value.txt"), "unassessed replacement");
    await assert.rejects(logOutcomeDelivery(cwd, input), /differs/);
    assert.equal((await readOutcome(cwd))!.deliveries.length, 0);
  });
});

test("literal prototype-looking filenames participate in complete input identity", async () => {
  await withTempDir("delivery", "literal-filenames", async (cwd) => {
    await fsp.writeFile(path.join(cwd, "__proto__"), "assessed");
    const before = await captureOutcomeInputs(cwd, "local");
    assert.equal(Object.hasOwn(before.files, "__proto__"), true);
    await fsp.writeFile(path.join(cwd, "__proto__"), "substituted");
    assert.notEqual((await captureOutcomeInputs(cwd, "local")).digest, before.digest);
  });
});

async function externalFixture(
  cwd: string,
  statusEnvironment = "production",
): Promise<GitHubTransport> {
  const fingerprint = await captureOutcomeInputs(cwd, "local");
  const tree = [];
  for (const file of Object.keys(fingerprint.files)) {
    const stat = await fsp.lstat(path.join(cwd, file));
    if (stat.isDirectory()) continue;
    const bytes = await fsp.readFile(path.join(cwd, file));
    tree.push({
      path: file,
      type: "blob",
      mode: stat.mode & 0o111 ? "100755" : "100644",
      sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    });
  }
  return {
    async json(endpoint) {
      if (endpoint.includes("/commits/"))
        return { sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } };
      if (endpoint.includes("/git/trees/")) return { sha: "b".repeat(40), truncated: false, tree };
      if (endpoint.endsWith("/deployments/1"))
        return { id: 1, sha: "a".repeat(40), environment: "production" };
      if (endpoint.includes("/statuses"))
        return [
          {
            state: "success",
            environment: statusEnvironment,
            deployment_url: "https://api.github.com/repos/fixture/delivery/deployments/1",
          },
        ];
      throw new Error("Unexpected delivery fixture endpoint");
    },
    async artifact() {
      throw new Error("No artifact endpoint is used for delivery");
    },
  };
}

test("selected patches cannot omit part of the assessed owned delta", async () => {
  await withTempDir("delivery", "subset", async (cwd) => {
    const input = await fixture(cwd, "patch", { twoFiles: true });
    await assert.rejects(logOutcomeDelivery(cwd, input), /complete owned delta/);
    assert.equal((await readOutcome(cwd))!.deliveries.length, 0);
  });
});

test("external endpoints bind the complete assessed tree and latest deployment environment", async () => {
  for (const endpoint of ["integrated", "deployed"])
    await withTempDir("delivery", endpoint, async (cwd) => {
      const input = await fixture(cwd, endpoint);
      const request = { ...input, delivery: { ...input.delivery, deploymentId: 1 } };
      if (endpoint === "deployed")
        await assert.rejects(
          logOutcomeDelivery(cwd, request, await externalFixture(cwd, "staging")),
          /accepted environment/,
        );
      const delivered = await logOutcomeDelivery(cwd, request, await externalFixture(cwd));
      assert.equal(
        (await verifiedOutcomeDeliveries(cwd, (await readOutcome(cwd))!)).has(delivered.id),
        true,
      );
      const unrelated = await storeOutcomeObject(cwd, Buffer.from("unrelated artifact"));
      await withOutcomeMutation(cwd, async (state) => {
        state.deliveries[0].artifactDigest = unrelated.digest;
      });
      assert.equal((await verifiedOutcomeDeliveries(cwd, (await readOutcome(cwd))!)).size, 0);
    });
});

test("late final input capture cannot accept an over-budget delivery and still accounts for its work", async () => {
  await withTempDir("delivery", "deadline", async (cwd) => {
    const input = await fixture(cwd, "answer", { deliverySeconds: 0.15 });
    const original = fsp.readdir;
    const canonicalRoot = await fsp.realpath(cwd);
    let rootReads = 0;
    fsp.readdir = (async (...args: Parameters<typeof fsp.readdir>) => {
      if (String(args[0]) === canonicalRoot && ++rootReads === 3) await delay(300);
      return await Reflect.apply(original, fsp, args);
    }) as typeof fsp.readdir;
    try {
      await assert.rejects(logOutcomeDelivery(cwd, input), /allowance|provenance/);
    } finally {
      fsp.readdir = original;
    }
    const state = (await readOutcome(cwd))!;
    assert.equal(state.deliveries.length, 0);
    assert.equal(state.executions[2].status.kind, "failed");
    assert.equal(state.reservations[2].settlement.kind, "measured");
  });
});
