import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import {
  sessionMutationLockLocation,
  withSessionMutationLock,
} from "../lib/session-mutation-lock.js";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseOutcomeContract, outcomeUsage } from "../lib/outcome-contract.js";
import { loadCoherentSessionSnapshot } from "../lib/coherent-session-snapshot.js";
import {
  amendOutcome,
  outcomeStateLocation,
  readOutcome,
  reserveOutcomeAction,
  settleOutcomeAction,
  startOutcome,
} from "../lib/outcome-store.js";
import { runGit, withTempDir } from "./helpers/process.js";

export function outcomeFixture(cwd: string) {
  return {
    id: "bounded-investigation",
    objective: "Remove the corruption without changing compatible output",
    criteria: [
      {
        id: "compatibility",
        description: "Exact compatible output",
        authority: "internal",
        subject: "candidate",
      },
    ],
    authorization: {
      reference: "user-approved-contract",
      worktrees: [cwd],
      editable: ["src", "bench"],
      protected: ["checks"],
      effects: ["inspect", "edit", "execute", "git"],
      environments: ["local"],
      delivery: "patch",
    },
    budget: {
      actions: 3,
      executionSeconds: 60,
      deadline: new Date(Date.now() + 120_000).toISOString(),
    },
  };
}

test("outcomes require an explicit finite budget and disjoint bounded scope", () => {
  const fixture = outcomeFixture(process.cwd());
  assert.equal(parseOutcomeContract(fixture).budget.actions, 3);
  for (const budget of [
    undefined,
    {},
    { actions: 0 },
    { executionSeconds: Infinity },
    { actions: 1.5 },
  ]) {
    assert.throws(() => parseOutcomeContract({ ...fixture, budget }), /budget/i);
  }
  assert.throws(
    () =>
      parseOutcomeContract({
        ...fixture,
        authorization: { ...fixture.authorization, editable: ["../outside"] },
      }),
    /path|scope/i,
  );
  assert.throws(
    () =>
      parseOutcomeContract({
        ...fixture,
        authorization: { ...fixture.authorization, protected: ["src/checks"] },
      }),
    /overlap/i,
  );
});

test("reservations are replay-safe and unknown consumption keeps its exposure", async () => {
  await withTempDir("outcome", "accounting", async (cwd) => {
    await startOutcome(cwd, outcomeFixture(cwd));
    const request = {
      id: "first",
      investigationId: "H1",
      specificationDigest: "a".repeat(64),
      seconds: 40,
    };
    await reserveOutcomeAction(cwd, request);
    await reserveOutcomeAction(cwd, request);
    await assert.rejects(
      reserveOutcomeAction(cwd, { ...request, seconds: 20 }),
      /identity|different/i,
    );
    await assert.rejects(
      reserveOutcomeAction(cwd, { ...request, id: "second", seconds: 30 }),
      /budget/i,
    );
    await settleOutcomeAction(cwd, "first", { kind: "unknown", reason: "Observer disconnected" });
    const state = await readOutcome(cwd);
    assert.ok(state);
    assert.equal(outcomeUsage(state).actions, 1);
    assert.equal(outcomeUsage(state).reservedSeconds, 40);
    assert.equal(outcomeUsage(state).unknownExecutions, 1);
    await assert.rejects(
      reserveOutcomeAction(cwd, { ...request, id: "replacement" }),
      /unknown|unresolved|budget/i,
    );
    await settleOutcomeAction(cwd, "first", { kind: "measured", seconds: 12 });
    await settleOutcomeAction(cwd, "first", { kind: "measured", seconds: 12 });
    await assert.rejects(
      settleOutcomeAction(cwd, "first", { kind: "measured", seconds: 11 }),
      /settled|different/i,
    );
    assert.equal(outcomeUsage((await readOutcome(cwd))!).measuredSeconds, 12);
  });
});

test("amendments preserve usage and need an explicit authorization reference", async () => {
  await withTempDir("outcome", "amendment", async (cwd) => {
    const contract = outcomeFixture(cwd);
    await startOutcome(cwd, contract);
    await reserveOutcomeAction(cwd, {
      id: "one",
      investigationId: "H1",
      specificationDigest: "b".repeat(64),
      seconds: 5,
    });
    await settleOutcomeAction(cwd, "one", { kind: "measured", seconds: 5 });
    await assert.rejects(
      amendOutcome(cwd, { ...contract, objective: "An easier objective" }, "", "changed"),
      /authorization/i,
    );
    await amendOutcome(
      cwd,
      { ...contract, budget: { ...contract.budget, actions: 4 } },
      "user-amendment",
      "Additional allowance",
    );
    const state = await readOutcome(cwd);
    assert.ok(state);
    assert.equal(outcomeUsage(state).actions, 1);
    assert.equal(outcomeUsage(state).measuredSeconds, 5);
    assert.equal(state.history.length, 2);
  });
});

test("linked worktrees share accounting and cannot both reserve the last allowance", async () => {
  await withTempDir("outcome", "linked", async (root) => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await mkdir(first);
    await runGit(first, ["init"]);
    await runGit(first, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    await runGit(first, ["worktree", "add", "-b", "second", second]);
    const input = outcomeFixture(first);
    await startOutcome(first, {
      ...input,
      authorization: { ...input.authorization, worktrees: [first, second] },
      budget: { actions: 1 },
    });
    const reservations = await Promise.allSettled(
      [first, second].map((cwd, index) =>
        reserveOutcomeAction(cwd, {
          id: `request-${index}`,
          investigationId: "H1",
          specificationDigest: String(index).repeat(64),
          seconds: 1,
        }),
      ),
    );
    assert.equal(reservations.filter((r) => r.status === "fulfilled").length, 1);
    assert.deepEqual(await readOutcome(first), await readOutcome(second));
  });
});

test("adoption retains dirty files and unknown costs, and later legacy writes block actions", async () => {
  await withTempDir("outcome", "adopt", async (cwd) => {
    const ledger = '{"type":"config","name":"existing"}\n';
    await writeFile(path.join(cwd, "autoresearch.jsonl"), ledger);
    await writeFile(path.join(cwd, "private-work.txt"), "keep me");
    await startOutcome(cwd, outcomeFixture(cwd), { adopt: true });
    const state = await readOutcome(cwd);
    assert.ok(state?.adoption);
    assert.equal(state.adoption.priorConsumption.kind, "unknown");
    assert.equal(await readFile(path.join(cwd, "autoresearch.jsonl"), "utf8"), ledger);
    assert.equal(await readFile(path.join(cwd, "private-work.txt"), "utf8"), "keep me");
    await writeFile(
      path.join(cwd, "autoresearch.jsonl"),
      ledger + '{"type":"config","name":"changed"}\n',
    );
    await assert.rejects(
      reserveOutcomeAction(cwd, {
        id: "one",
        investigationId: "H1",
        specificationDigest: "a".repeat(64),
        seconds: 1,
      }),
      /legacy.*drift/i,
    );
  });
});

test("adoption refuses present pending receipts and malformed process evidence", async () => {
  await withTempDir("outcome", "pending", async (cwd) => {
    await writeFile(path.join(cwd, "autoresearch.pending-transaction.json"), "{}");
    await assert.rejects(startOutcome(cwd, outcomeFixture(cwd), { adopt: true }), /pending/i);
    assert.equal(await readOutcome(cwd), null);
  });
  await withTempDir("outcome", "malformed-process", async (cwd) => {
    await writeFile(path.join(cwd, "autoresearch.progress.json"), "not-json");
    await assert.rejects(startOutcome(cwd, outcomeFixture(cwd), { adopt: true }), /process/i);
    assert.equal(await readOutcome(cwd), null);
  });
});

test("fresh outcomes detect newly created legacy state and adoption authenticates artifacts", async () => {
  await withTempDir("outcome", "new-legacy-writer", async (cwd) => {
    await startOutcome(cwd, outcomeFixture(cwd));
    await writeFile(path.join(cwd, "autoresearch.config.json"), "{}");
    await assert.rejects(
      reserveOutcomeAction(cwd, {
        id: "one",
        investigationId: "H1",
        specificationDigest: "a".repeat(64),
        seconds: 1,
      }),
      /legacy.*drift/i,
    );
  });
  await withTempDir("outcome", "artifacts", async (cwd) => {
    await writeFile(path.join(cwd, "proof.txt"), "retained negative result");
    await writeFile(
      path.join(cwd, "autoresearch.jsonl"),
      JSON.stringify({ run: 1, artifacts: { proof: "proof.txt" } }) + "\n",
    );
    await writeFile(path.join(cwd, "autoresearch.md"), "");
    const state = await startOutcome(cwd, outcomeFixture(cwd), { adopt: true });
    const artifact = state.legacySources.find((source) => source.path.endsWith("proof.txt"));
    assert.equal(
      Buffer.from(artifact?.bytesBase64 ?? "", "base64").toString(),
      "retained negative result",
    );
    await writeFile(path.join(cwd, "proof.txt"), "substituted");
    await assert.rejects(
      reserveOutcomeAction(cwd, {
        id: "one",
        investigationId: "H1",
        specificationDigest: "a".repeat(64),
        seconds: 1,
      }),
      /legacy.*drift/i,
    );
  });
});

test("corrupt and symlinked outcome state never becomes a new empty outcome", async () => {
  await withTempDir("outcome", "corrupt", async (cwd) => {
    await startOutcome(cwd, outcomeFixture(cwd));
    const location = await outcomeStateLocation(cwd);
    await writeFile(location.path, "not-json");
    await assert.rejects(readOutcome(cwd));
    await assert.rejects(startOutcome(cwd, outcomeFixture(cwd)));
  });
  await withTempDir("outcome", "symlink", async (cwd) => {
    const outside = path.join(cwd, "outside.json");
    await writeFile(outside, "{}");
    const location = await outcomeStateLocation(cwd);
    await mkdir(path.dirname(location.path), { recursive: true });
    await symlink(outside, location.path);
    await assert.rejects(readOutcome(cwd), /regular file|symlink/i);
    assert.equal((await loadCoherentSessionSnapshot({ requestedCwd: cwd })).ok, false);
    assert.equal(await readFile(outside, "utf8"), "{}");
  });
});

test("directory artifact membership and bytes remain authenticated after adoption", async () => {
  await withTempDir("outcome", "directory-artifact", async (cwd) => {
    await mkdir(path.join(cwd, "evidence", "empty"), { recursive: true });
    await writeFile(path.join(cwd, "evidence", "result.txt"), "negative");
    await writeFile(
      path.join(cwd, "autoresearch.jsonl"),
      JSON.stringify({ run: 1, artifacts: { bundle: "evidence" } }) + "\n",
    );
    const state = await startOutcome(cwd, outcomeFixture(cwd), { adopt: true });
    assert.ok(
      state.legacySources.some(
        (source) => source.kind === "directory" && source.path.endsWith("empty"),
      ),
    );
    assert.ok(
      state.legacySources.some(
        (source) => source.kind === "file" && source.path.endsWith("result.txt"),
      ),
    );
    await writeFile(path.join(cwd, "evidence", "new.txt"), "later");
    await assert.rejects(
      reserveOutcomeAction(cwd, {
        id: "one",
        investigationId: "H1",
        specificationDigest: "a".repeat(64),
        seconds: 1,
      }),
      /legacy.*drift/i,
    );
  });
});

test("worktree amendments preserve old guards and refuse newly admitted pending work", async () => {
  await withTempDir("outcome", "amended-worktree", async (root) => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await mkdir(first);
    await runGit(first, ["init"]);
    await runGit(first, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    await runGit(first, ["worktree", "add", "-b", "second", second]);
    const original = outcomeFixture(first);
    await startOutcome(first, original);
    const expanded = {
      ...original,
      authorization: { ...original.authorization, worktrees: [first, second] },
    };
    const pending = path.join(second, "autoresearch.pending-transaction.json");
    await writeFile(pending, "{}");
    await assert.rejects(amendOutcome(first, expanded, "user-added-worktree", "Add B"), /pending/i);
    await rm(pending);
    await writeFile(path.join(second, "autoresearch.jsonl"), '{"type":"config"}\n');
    const amended = await amendOutcome(first, expanded, "user-added-worktree", "Add B");
    assert.equal(amended.adoption?.priorConsumption.kind, "unknown");
    await amendOutcome(first, original, "user-removed-worktree", "Remove B");
    await reserveOutcomeAction(first, {
      id: "one",
      investigationId: "H1",
      specificationDigest: "a".repeat(64),
      seconds: 1,
    });
    await assert.rejects(readOutcome(second), /outside.*authorization/i);
  });
});

test("amendment keeps newly admitted legacy writers excluded through the authority commit", async () => {
  await withTempDir("outcome", "amendment-commit", async (root) => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await mkdir(first);
    await runGit(first, ["init"]);
    await runGit(first, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    await runGit(first, ["worktree", "add", "-b", "second", second]);
    const original = outcomeFixture(first);
    await startOutcome(first, original);
    const location = await outcomeStateLocation(first);
    const legacyLock = await sessionMutationLockLocation(second);
    const originalRename = fsp.rename;
    let checkedCommit = false;
    fsp.rename = async (from, to) => {
      if (to === location.path) {
        checkedCommit = true;
        await assert.rejects(
          withSessionMutationLock(
            legacyLock.root,
            "legacy-writer",
            async () => {
              await writeFile(path.join(second, "autoresearch.pending-transaction.json"), "{}");
            },
            legacyLock.path,
          ),
          /already running|locked|another/i,
        );
      }
      await originalRename(from, to);
    };
    try {
      await amendOutcome(
        first,
        { ...original, authorization: { ...original.authorization, worktrees: [first, second] } },
        "user-added-worktree",
        "Add B",
      );
    } finally {
      fsp.rename = originalRename;
    }
    assert.equal(checkedCommit, true);
  });
});
