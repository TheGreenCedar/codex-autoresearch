import assert from "node:assert/strict";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { logExperiment } from "../../lib/commands/log.js";
import { quoteForAcceptedShell } from "../helpers/process.js";
import { git, runCli, setupFixture, withTempDir } from "../helpers/cli-test-context.js";

type FaultPoint =
  | "before:commit-applied-or-verified"
  | "after:commit-applied-or-verified"
  | "before:ledger-event-present"
  | "after:ledger-event-present"
  | "before:tracked-cleanup-complete"
  | "after:tracked-cleanup-complete"
  | "before:untracked-cleanup-complete"
  | "after:untracked-cleanup-complete"
  | "before:packet-cleanup-complete"
  | "after:packet-cleanup-complete"
  | "after:commit-ref-updated";

const invokeLog = logExperiment as unknown as (
  args: Record<string, unknown>,
  options?: { faultInjection?: (point: FaultPoint) => void | Promise<void> },
) => Promise<Record<string, any>>;

async function setupTransactionFixture(
  dir: string,
  options: {
    artifactPath?: string;
    commitPaths?: string[];
    commitCandidateBeforePacket?: boolean;
    candidateScore?: string;
    detachBeforePacket?: boolean;
    dirtySessionBeforePacket?: boolean;
    generateArtifactDuringRun?: boolean;
    initialScore?: string;
    outsideDirtyBeforePacket?: boolean;
    outsideTracked?: boolean;
    partialCleanupCandidates?: boolean;
    partialTrackedCleanupCandidates?: boolean;
    protectedArtifact?: boolean;
    stagedAddedCandidate?: "ignored" | "ordinary";
    untrackedCandidate?: boolean;
  } = {},
) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "contract"), { recursive: true });
  await writeFile(path.join(dir, "src", "score.txt"), `${options.initialScore ?? "1"}\n`);
  if (options.outsideTracked) {
    await writeFile(path.join(dir, "outside.txt"), "outside baseline\n");
  }
  if (options.partialTrackedCleanupCandidates) {
    await mkdir(path.join(dir, "src", "z"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.txt"), "tracked baseline a\n");
    await writeFile(path.join(dir, "src", "z", "blocked.txt"), "tracked baseline blocked\n");
  }
  if (options.stagedAddedCandidate === "ignored") {
    await writeFile(path.join(dir, ".gitignore"), "src/*.generated\n");
  }
  await writeFile(
    path.join(dir, "contract", "evaluator.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      ...(options.artifactPath && options.generateArtifactDuringRun
        ? [
            'import { mkdirSync, writeFileSync } from "node:fs";',
            'import { dirname } from "node:path";',
            `const artifactPath = ${JSON.stringify(options.artifactPath)};`,
            "mkdirSync(dirname(artifactPath), { recursive: true });",
            "writeFileSync(artifactPath, '{\"proof\":true}\\n');",
          ]
        : []),
      'const score = readFileSync("src/score.txt", "utf8").trim();',
      "console.log(`METRIC score=${score}`);",
      ...(options.artifactPath
        ? [`console.log(${JSON.stringify(`ARTIFACT proof=${options.artifactPath}`)});`]
        : []),
      "",
    ].join("\n"),
  );
  await writeFile(path.join(dir, "contract", "checks.mjs"), "process.exit(0);\n");
  const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} contract/evaluator.mjs`;
  const checksCommand = `${quoteForAcceptedShell(process.execPath)} contract/checks.mjs`;
  const setup = await setupFixture(dir, {
    name: "exactly once logging",
    goal: "Keep only accepted candidate evidence.",
    metricName: "score",
    direction: "higher",
    completeContract: true,
    benchmarkCommand,
    checksCommand,
    packetBudget: 20,
    scope: "src",
  });
  assert.equal(setup.code, 0, setup.stderr);
  const protectedPaths = ["contract/evaluator.mjs"];
  if (options.protectedArtifact && options.artifactPath) {
    protectedPaths.push(options.artifactPath);
  }
  const configPath = path.join(dir, "autoresearch.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        checkImplementationPaths: ["contract/checks.mjs"],
        checksAuthoritative: true,
        commitPaths: options.commitPaths ?? ["src"],
        editableScope: ["src"],
        maxIterations: 20,
        metricSemantics: { kind: "maximize", minimumImprovement: 0 },
        noiseModel: { kind: "deterministic" },
        protectedBenchmarkPaths: protectedPaths,
      },
      null,
      2,
    )}\n`,
  );
  await git(dir, ["init", "--initial-branch", "main"]);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial session"]);
  const initialCommit = await git(dir, ["rev-parse", "HEAD"]);
  const acceptContract = async () => {
    const acceptedContract = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept the exactly-once transaction fixture contract",
      "--yes",
    ]);
    assert.equal(acceptedContract.code, 0, acceptedContract.stderr);
  };
  const logBaseline = async () => {
    const baseline = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "measure",
      "--description",
      "Manual reference observation",
    ]);
    assert.equal(baseline.code, 0, baseline.stderr);
  };
  if (options.outsideDirtyBeforePacket) {
    await writeFile(path.join(dir, "outside.txt"), "outside accepted dirty state\n");
  }
  if (options.commitCandidateBeforePacket) {
    await writeFile(path.join(dir, "src", "score.txt"), `${options.candidateScore ?? "2"}\n`);
    await git(dir, ["add", "src/score.txt"]);
    await git(dir, ["commit", "-m", "imported candidate"]);
    await acceptContract();
    await logBaseline();
  } else {
    await acceptContract();
    await logBaseline();
    await writeFile(path.join(dir, "src", "score.txt"), `${options.candidateScore ?? "2"}\n`);
  }
  if (options.untrackedCandidate) {
    await writeFile(path.join(dir, "src", "scratch.txt"), "candidate scratch\n");
  }
  if (options.stagedAddedCandidate) {
    const addedPath =
      options.stagedAddedCandidate === "ignored" ? "src/new.generated" : "src/new.txt";
    await writeFile(path.join(dir, addedPath), "staged candidate addition\n");
    await git(dir, [
      "add",
      ...(options.stagedAddedCandidate === "ignored" ? ["-f"] : []),
      addedPath,
    ]);
  }
  if (options.partialCleanupCandidates) {
    await mkdir(path.join(dir, "src", "z"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.txt"), "first cleanup target\n");
    await writeFile(path.join(dir, "src", "z", "blocked.txt"), "blocked cleanup target\n");
    await chmod(path.join(dir, "src", "z"), 0o500);
  }
  if (options.partialTrackedCleanupCandidates) {
    await writeFile(path.join(dir, "src", "a.txt"), "tracked candidate a\n");
    await writeFile(path.join(dir, "src", "z", "blocked.txt"), "tracked candidate blocked\n");
  }
  if (options.detachBeforePacket) {
    await git(dir, ["switch", "--detach"]);
  }
  if (options.dirtySessionBeforePacket) {
    await writeFile(path.join(dir, "autoresearch.md"), "operator state that must survive\n");
  }
  const packet = await runCli(["next", "--cwd", dir]);
  assert.equal(packet.code, 0, packet.stderr);
  assert.equal(
    JSON.parse(packet.stdout).decision.allowedStatuses.includes("keep"),
    true,
    packet.stdout,
  );
  return { initialCommit };
}

async function receiptPath(dir: string): Promise<string> {
  return path.resolve(
    dir,
    await git(dir, ["rev-parse", "--git-path", "autoresearch/pending-log-transaction.json"]),
  );
}

async function ledgerRows(dir: string): Promise<Record<string, any>[]> {
  return (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const keepArgs = (dir: string, description = "Keep accepted candidate") => ({
  cwd: dir,
  from_last: true,
  status: "keep",
  description,
});

const discardArgs = (dir: string, description = "Discard candidate") => ({
  cwd: dir,
  from_last: true,
  status: "discard",
  description,
});

async function failAt(point: FaultPoint, expected: FaultPoint) {
  if (point === expected) throw new Error(`Injected log fault at ${point}`);
}

async function installGitShim(
  dir: string,
  name: string,
  body: string[],
): Promise<{ env: NodeJS.ProcessEnv; marker: string }> {
  const realGit = "/usr/bin/git";
  await access(realGit);
  const shimDir = path.join(dir, ".git", "autoresearch-test-shims", name);
  const marker = path.join(shimDir, "marker");
  await mkdir(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, "git");
  await writeFile(
    shimPath,
    [
      "#!/bin/sh",
      `REAL_GIT=${quoteForAcceptedShell(realGit)}`,
      `MARKER=${quoteForAcceptedShell(marker)}`,
      ...body,
      'exec "$REAL_GIT" "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(shimPath, 0o755);
  return {
    env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH || ""}` },
    marker,
  };
}

const keepCliArgs = (dir: string, description = "Keep accepted candidate") => [
  "log",
  "--cwd",
  dir,
  "--from-last",
  "--status",
  "keep",
  "--description",
  description,
];

test("manual measurement remains loggable in an unborn Git repository", async () => {
  await withTempDir("unborn-measure", async (dir) => {
    await git(dir, ["init"]);
    await setupFixture(dir, { name: "unborn measurement" });

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "measure",
      "--description",
      "Manual reference observation",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const rows = await ledgerRows(dir);
    assert.equal(rows.filter((row) => row.run === 1).length, 1);
  });
});

test(
  "keep retries converge after faults before and after Git, ledger, and packet cleanup",
  { timeout: 450_000 },
  async (t) => {
    const points: FaultPoint[] = [
      "before:commit-applied-or-verified",
      "after:commit-applied-or-verified",
      "before:ledger-event-present",
      "after:ledger-event-present",
      "before:packet-cleanup-complete",
      "after:packet-cleanup-complete",
    ];
    for (const point of points) {
      await t.test(point, async () => {
        await withTempDir(`keep-${point.replaceAll(":", "-")}`, async (dir) => {
          await setupTransactionFixture(dir);
          await assert.rejects(
            invokeLog(keepArgs(dir), { faultInjection: (seen) => failAt(seen, point) }),
            new RegExp(point),
          );
          const receipt = JSON.parse(await readFile(await receiptPath(dir), "utf8"));
          assert.equal(receipt.type, "autoresearch.log.transaction");
          assert.equal(receipt.schemaVersion, 2);
          for (const field of [
            "transaction",
            "input",
            "packet",
            "contract",
            "evidence",
            "preGit",
            "status",
            "completedStages",
            "commitExpectation",
            "ledgerEvent",
            "cleanup",
            "failures",
          ]) {
            assert.equal(Object.hasOwn(receipt, field), true, field);
          }

          const retried = await invokeLog(keepArgs(dir));
          assert.equal(retried.ok, true);
          assert.equal(Number(await git(dir, ["rev-list", "--count", "HEAD"])), 2);
          const rows = await ledgerRows(dir);
          const logged = rows.filter((row) => row.description === "Keep accepted candidate");
          assert.equal(logged.length, 1);
          assert.match(String(logged[0].logTransaction?.id || ""), /^[a-f0-9]{64}$/);
          assert.match(String(logged[0].logTransaction?.eventDigest || ""), /^[a-f0-9]{64}$/);
          await assert.rejects(access(await receiptPath(dir)), /ENOENT/);
        });
      });
    }
  },
);

test("keep retry recovers a recorded commit before its stage checkpoint", async () => {
  await withTempDir("recorded-commit-before-checkpoint", async (dir) => {
    await setupTransactionFixture(dir);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "after:commit-ref-updated"),
      }),
      /after:commit-ref-updated/,
    );

    const retried = await invokeLog(keepArgs(dir));
    assert.equal(retried.ok, true);
    assert.equal(Number(await git(dir, ["rev-list", "--count", "HEAD"])), 2);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      1,
    );
  });
});

test("keep rejects commit scope that omits the accepted editable candidate", async () => {
  await withTempDir("keep-omitted-accepted-candidate", async (dir) => {
    await setupTransactionFixture(dir);
    const before = await git(dir, ["rev-parse", "HEAD"]);

    await assert.rejects(
      invokeLog({ ...keepArgs(dir), commit_paths: ["contract"] }),
      /commit.*scope|accepted.*editable|evaluated candidate/i,
    );

    assert.equal(await git(dir, ["rev-parse", "HEAD"]), before);
    assert.equal(await readFile(path.join(dir, "src", "score.txt"), "utf8"), "2\n");
  });
});

test("create-mode keep rejects an evaluated no-op candidate", async () => {
  await withTempDir("keep-evaluated-no-op", async (dir) => {
    await setupTransactionFixture(dir, { candidateScore: "2", initialScore: "2" });
    const before = await git(dir, ["rev-parse", "HEAD"]);

    await assert.rejects(invokeLog(keepArgs(dir)), /no-op|no changes|candidate tree/i);

    assert.equal(await git(dir, ["rev-parse", "HEAD"]), before);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      0,
    );
  });
});

test("create-mode keep rejects an evaluated-scope no-op even when add-all includes outside changes", async () => {
  await withTempDir("keep-evaluated-scope-no-op", async (dir) => {
    await setupTransactionFixture(dir, {
      candidateScore: "2",
      commitPaths: [],
      initialScore: "2",
      outsideDirtyBeforePacket: true,
    });
    const before = await git(dir, ["rev-parse", "HEAD"]);

    await assert.rejects(
      invokeLog({ ...keepArgs(dir), allow_add_all: true, commit_paths: [] }),
      /no-op|no changes|candidate.*delta|evaluated.*scope/i,
    );

    assert.equal(await git(dir, ["rev-parse", "HEAD"]), before);
    assert.equal(
      await readFile(path.join(dir, "outside.txt"), "utf8"),
      "outside accepted dirty state\n",
    );
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      0,
    );
  });
});

test("create-mode keep includes a newly added accepted editable candidate file", async () => {
  await withTempDir("keep-new-untracked-candidate", async (dir) => {
    await setupTransactionFixture(dir, { untrackedCandidate: true });

    const logged = await invokeLog(keepArgs(dir));

    assert.equal(logged.ok, true);
    assert.equal(await git(dir, ["show", "HEAD:src/score.txt"]), "2");
    assert.equal(await git(dir, ["show", "HEAD:src/scratch.txt"]), "candidate scratch");
    assert.equal(await git(dir, ["status", "--short", "--", "src"]), "");
  });
});

test("keep retry rejects staged-only index drift after ref advancement", async () => {
  await withTempDir("keep-index-drift-after-ref", async (dir) => {
    await setupTransactionFixture(dir);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "after:commit-ref-updated"),
      }),
      /after:commit-ref-updated/,
    );
    await writeFile(path.join(dir, "src", "score.txt"), "99\n");
    await git(dir, ["add", "src/score.txt"]);
    await writeFile(path.join(dir, "src", "score.txt"), "2\n");
    assert.equal(await git(dir, ["show", ":src/score.txt"]), "99");

    await assert.rejects(
      invokeLog(keepArgs(dir)),
      /index.*changed|prepared.*index|staged.*changed/i,
    );

    assert.equal(await git(dir, ["show", ":src/score.txt"]), "99");
  });
});

test("keep retry completes a failed index reconciliation before marking commit complete", async () => {
  await withTempDir("keep-retry-index-reconciliation", async (dir) => {
    await setupTransactionFixture(dir);
    const indexLock = path.resolve(dir, await git(dir, ["rev-parse", "--git-path", "index.lock"]));
    try {
      await assert.rejects(
        invokeLog(keepArgs(dir), {
          faultInjection: async (seen) => {
            if (seen === "after:commit-ref-updated") {
              await writeFile(indexLock, "block index reconciliation\n");
            }
          },
        }),
        /index\.lock|index.*lock|reconciliation/i,
      );
    } finally {
      await rm(indexLock, { force: true });
    }
    const pending = JSON.parse(await readFile(await receiptPath(dir), "utf8"));
    assert.match(String(pending.commitExpectation.oid || ""), /^[a-f0-9]{40,64}$/);

    const retried = await invokeLog(keepArgs(dir));

    assert.equal(retried.ok, true);
    assert.equal(await git(dir, ["diff", "--cached", "--name-only"]), "");
    assert.equal(Number(await git(dir, ["rev-list", "--count", "HEAD"])), 2);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      1,
    );
  });
});

test("OID-present keep recovery atomically excludes a concurrent index writer", async (t) => {
  if (process.platform === "win32") {
    t.skip("the one-shot Git shim uses POSIX executable semantics");
    return;
  }
  await withTempDir("keep-atomic-index-reconciliation", async (dir) => {
    await setupTransactionFixture(dir);
    const indexLock = path.resolve(dir, await git(dir, ["rev-parse", "--git-path", "index.lock"]));
    try {
      await assert.rejects(
        invokeLog(keepArgs(dir), {
          faultInjection: async (seen) => {
            if (seen === "after:commit-ref-updated") {
              await writeFile(indexLock, "block initial index reconciliation\n");
            }
          },
        }),
        /index\.lock|index.*lock|reconciliation/i,
      );
    } finally {
      await rm(indexLock, { force: true });
    }
    const pending = JSON.parse(await readFile(await receiptPath(dir), "utf8"));
    assert.match(String(pending.commitExpectation.oid || ""), /^[a-f0-9]{40,64}$/);
    const shim = await installGitShim(dir, "atomic-index", [
      'command_name=""',
      'for arg in "$@"; do',
      '  case "$arg" in reset|restore|write-tree) command_name="$arg" ;; esac',
      "done",
      'if [ ! -e "$MARKER" ] && { [ "$command_name" = "reset" ] || [ -e .git/index.lock ]; }; then',
      "  printf '99\\n' > src/score.txt",
      '  if env -u GIT_INDEX_FILE "$REAL_GIT" add src/score.txt 2>/dev/null; then',
      "    printf 'staged\\n' > \"$MARKER\"",
      "  else",
      "    printf 'blocked\\n' > \"$MARKER\"",
      "  fi",
      "  printf '2\\n' > src/score.txt",
      "fi",
    ]);

    const previousPath = process.env.PATH;
    let retried: Record<string, any>;
    try {
      process.env.PATH = shim.env.PATH;
      retried = await invokeLog(keepArgs(dir));
    } finally {
      process.env.PATH = previousPath;
    }

    assert.equal(retried.ok, true);
    assert.equal(await readFile(shim.marker, "utf8"), "blocked\n");
    assert.equal(await git(dir, ["diff", "--cached", "--name-only"]), "");
    assert.equal(await git(dir, ["show", "HEAD:src/score.txt"]), "2");
  });
});

test("keep retry rejects a same-parent symbolic branch switch", async () => {
  await withTempDir("keep-symbolic-ref-drift", async (dir) => {
    await setupTransactionFixture(dir);
    const preparedParent = await git(dir, ["rev-parse", "HEAD"]);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:commit-applied-or-verified"),
      }),
      /before:commit-applied-or-verified/,
    );
    await git(dir, ["switch", "-c", "other"]);

    await assert.rejects(invokeLog(keepArgs(dir)), /branch|symbolic|prepared ref|HEAD state/i);

    assert.equal(await git(dir, ["rev-parse", "refs/heads/main"]), preparedParent);
    assert.equal(await git(dir, ["rev-parse", "refs/heads/other"]), preparedParent);
    assert.equal(await readFile(path.join(dir, "src", "score.txt"), "utf8"), "2\n");
  });
});

test("keep commit compare-and-swap preserves prepared detached HEAD state", async () => {
  await withTempDir("keep-prepared-detached-head", async (dir) => {
    await setupTransactionFixture(dir, { detachBeforePacket: true });
    const main = await git(dir, ["rev-parse", "refs/heads/main"]);

    const logged = await invokeLog(keepArgs(dir));

    assert.equal(logged.ok, true);
    assert.equal(await git(dir, ["branch", "--show-current"]), "");
    assert.equal(await git(dir, ["rev-parse", "refs/heads/main"]), main);
    assert.notEqual(await git(dir, ["rev-parse", "HEAD"]), main);
    assert.equal(await git(dir, ["show", "HEAD:src/score.txt"]), "2");
  });
});

test("symbolic HEAD identity and intended branch update share one atomic ref transaction", async (t) => {
  if (process.platform === "win32") {
    t.skip("the one-shot Git shim uses POSIX executable semantics");
    return;
  }
  await withTempDir("keep-atomic-symbolic-head", async (dir) => {
    await setupTransactionFixture(dir);
    const parent = await git(dir, ["rev-parse", "HEAD"]);
    await git(dir, ["branch", "other", parent]);
    const shim = await installGitShim(dir, "atomic-symbolic-head", [
      'seen_verify=""',
      'seen_ref=""',
      'for arg in "$@"; do',
      '  [ "$arg" = "--verify" ] && seen_verify="yes"',
      '  [ "$arg" = "refs/heads/main" ] && seen_ref="yes"',
      "done",
      'if [ "$seen_verify" = "yes" ] && [ "$seen_ref" = "yes" ] && [ -e .git/HEAD.lock ] && [ ! -e "$MARKER" ]; then',
      '  if "$REAL_GIT" switch --quiet other 2>"$MARKER.error"; then',
      "    printf 'raced\\n' > \"$MARKER\"",
      "  else",
      "    printf 'blocked\\n' > \"$MARKER\"",
      "  fi",
      "fi",
    ]);

    const previousPath = process.env.PATH;
    let logged: Record<string, any>;
    try {
      process.env.PATH = shim.env.PATH;
      logged = await invokeLog(keepArgs(dir));
    } finally {
      process.env.PATH = previousPath;
    }

    assert.equal(logged.ok, true);
    assert.equal(
      await readFile(shim.marker, "utf8"),
      "blocked\n",
      await readFile(`${shim.marker}.error`, "utf8").catch(() => ""),
    );
    assert.equal(await git(dir, ["branch", "--show-current"]), "main");
    assert.notEqual(await git(dir, ["rev-parse", "refs/heads/main"]), parent);
    assert.equal(await git(dir, ["rev-parse", "refs/heads/other"]), parent);
  });
});

test("detached HEAD identity and update share one atomic ref transaction", async (t) => {
  if (process.platform === "win32") {
    t.skip("the one-shot Git shim uses POSIX executable semantics");
    return;
  }
  await withTempDir("keep-atomic-detached-head", async (dir) => {
    await setupTransactionFixture(dir, { detachBeforePacket: true });
    const parent = await git(dir, ["rev-parse", "HEAD"]);
    const shim = await installGitShim(dir, "atomic-detached-head", [
      'command_name=""',
      'previous_arg=""',
      'for arg in "$@"; do',
      '  [ "$arg" = "update-ref" ] && command_name="update-ref"',
      '  [ "$previous_arg" = "--git-path" ] && [ "$arg" = "HEAD" ] && command_name="head-path"',
      '  previous_arg="$arg"',
      "done",
      'if { [ "$command_name" = "update-ref" ] || [ "$command_name" = "head-path" ]; } && [ ! -e "$MARKER" ]; then',
      '  if "$REAL_GIT" switch --quiet main 2>"$MARKER.error"; then',
      "    printf 'raced\\n' > \"$MARKER\"",
      "  else",
      "    printf 'blocked\\n' > \"$MARKER\"",
      "  fi",
      "fi",
    ]);

    const previousPath = process.env.PATH;
    let failure: unknown = null;
    try {
      process.env.PATH = shim.env.PATH;
      await invokeLog(keepArgs(dir));
    } catch (error) {
      failure = error;
    } finally {
      process.env.PATH = previousPath;
    }

    assert.equal(
      await readFile(shim.marker, "utf8"),
      "raced\n",
      await readFile(`${shim.marker}.error`, "utf8").catch(() => ""),
    );
    assert.match(
      failure instanceof Error ? failure.message : String(failure || ""),
      /prepared.*HEAD|detached.*changed|atomic.*ref|compare-and-swap/i,
    );
    assert.equal(await git(dir, ["branch", "--show-current"]), "main");
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), parent);
    assert.equal(await git(dir, ["rev-parse", "refs/heads/main"]), parent);
  });
});

test("failed ref-lock acquisition preserves every foreign lock sentinel", async (t) => {
  for (const fixture of [
    { label: "symbolic intended ref", detach: false, lockPath: "refs/heads/main.lock" },
    { label: "symbolic HEAD", detach: false, lockPath: "HEAD.lock" },
    { label: "detached HEAD", detach: true, lockPath: "HEAD.lock" },
  ] as const) {
    await t.test(fixture.label, async () => {
      await withTempDir(`foreign-${fixture.label.replaceAll(" ", "-")}-lock`, async (dir) => {
        await setupTransactionFixture(dir, { detachBeforePacket: fixture.detach });
        const parent = await git(dir, ["rev-parse", "HEAD"]);
        const lockPath = path.resolve(
          dir,
          await git(dir, ["rev-parse", "--git-path", fixture.lockPath]),
        );
        const sentinel = `foreign writer owns ${fixture.label}\n`;
        await writeFile(lockPath, sentinel, { flag: "wx" });
        try {
          await assert.rejects(
            invokeLog(keepArgs(dir)),
            /atomic.*lock|could not lock|active Git commands/i,
          );
          assert.equal(await readFile(lockPath, "utf8"), sentinel);
          assert.equal(await git(dir, ["rev-parse", "HEAD"]), parent);
        } finally {
          await rm(lockPath, { force: true });
        }
      });
    });
  }
});

test("unsupported ref storage fails closed before the atomic symbolic-ref update", async (t) => {
  if (process.platform === "win32") {
    t.skip("the one-shot Git shim uses POSIX executable semantics");
    return;
  }
  await withTempDir("keep-unsupported-atomic-ref", async (dir) => {
    await setupTransactionFixture(dir);
    const parent = await git(dir, ["rev-parse", "HEAD"]);
    const shim = await installGitShim(dir, "unsupported-atomic-ref", [
      'previous_arg=""',
      'for arg in "$@"; do',
      '  if [ "$previous_arg" = "rev-parse" ] && [ "$arg" = "--show-ref-format" ]; then',
      "    printf 'reftable\\n'",
      "    exit 0",
      "  fi",
      '  previous_arg="$arg"',
      "done",
    ]);

    const logged = await runCli(keepCliArgs(dir), { env: shim.env, spawn: true });

    assert.notEqual(logged.code, 0);
    assert.match(logged.stderr, /Git reference storage.*atomic.*symbolic.*files.*upgrade/i);
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), parent);
  });
});

test("older Git without show-ref-format uses the files-ref lock boundary", async (t) => {
  if (process.platform === "win32") {
    t.skip("the one-shot Git shim uses POSIX executable semantics");
    return;
  }
  await withTempDir("keep-older-git-files-ref", async (dir) => {
    await setupTransactionFixture(dir);
    await git(dir, ["config", "core.repositoryFormatVersion", "1"]);
    await git(dir, ["config", "extensions.refStorage", "files"]);
    const parent = await git(dir, ["rev-parse", "HEAD"]);
    const shim = await installGitShim(dir, "older-files-ref", [
      'previous_arg=""',
      'for arg in "$@"; do',
      '  if [ "$previous_arg" = "rev-parse" ] && [ "$arg" = "--show-ref-format" ]; then',
      "    printf 'fatal: unknown option: --show-ref-format\\n' >&2",
      "    exit 129",
      "  fi",
      '  previous_arg="$arg"',
      "done",
    ]);

    const logged = await runCli(keepCliArgs(dir), { env: shim.env, spawn: true });

    assert.equal(logged.code, 0, logged.stderr);
    assert.notEqual(await git(dir, ["rev-parse", "HEAD"]), parent);
    assert.equal(await git(dir, ["show", "HEAD:src/score.txt"]), "2");
  });
});

test("ledger append inserts a receipt-owned delimiter after a valid unterminated prefix", async () => {
  await withTempDir("ledger-prefix-delimiter", async (dir) => {
    await setupFixture(dir, { name: "ledger delimiter" });
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const prefix = await readFile(ledgerPath, "utf8");
    assert.equal(prefix.endsWith("\n"), true);
    await writeFile(ledgerPath, prefix.slice(0, -1), "utf8");

    const logged = await invokeLog({
      cwd: dir,
      metric: 1,
      status: "measure",
      description: "Delimited measure",
    });

    assert.equal(logged.ok, true);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Delimited measure").length,
      1,
    );
  });
});

test("partial untracked cleanup resumes target by target", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not enforce the POSIX directory mode used to hold one cleanup target");
    return;
  }
  await withTempDir("partial-untracked-cleanup", async (dir) => {
    const blockedDirectory = path.join(dir, "src", "z");
    try {
      await setupTransactionFixture(dir, { partialCleanupCandidates: true });
      await assert.rejects(
        invokeLog(discardArgs(dir)),
        /Git untracked cleanup failed|failed to remove|Permission denied/i,
      );
      await assert.rejects(access(path.join(dir, "src", "a.txt")), /ENOENT/);
      await access(path.join(blockedDirectory, "blocked.txt"));

      await chmod(blockedDirectory, 0o700);
      const retried = await invokeLog(discardArgs(dir));

      assert.equal(retried.ok, true);
      await assert.rejects(access(path.join(dir, "src", "a.txt")), /ENOENT/);
      await assert.rejects(access(path.join(blockedDirectory, "blocked.txt")), /ENOENT/);
    } finally {
      await chmod(blockedDirectory, 0o700).catch(() => {});
    }
  });
});

test("partial tracked cleanup separately rejects staged drift behind a clean worktree", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not enforce the POSIX directory mode used to hold one cleanup target");
    return;
  }
  await withTempDir("partial-tracked-cleanup-staged-drift", async (dir) => {
    const blockedDirectory = path.join(dir, "src", "z");
    const blockedPath = path.join(blockedDirectory, "blocked.txt");
    try {
      await setupTransactionFixture(dir, { partialTrackedCleanupCandidates: true });
      await chmod(blockedDirectory, 0o500);
      await assert.rejects(
        invokeLog(discardArgs(dir)),
        /Git tracked cleanup failed|Permission denied|could not unlink|unable to create/i,
      );
      assert.equal(await readFile(path.join(dir, "src", "a.txt"), "utf8"), "tracked baseline a\n");
      assert.equal(await readFile(blockedPath, "utf8"), "tracked candidate blocked\n");

      await chmod(blockedDirectory, 0o700);
      await writeFile(blockedPath, "operator staged drift\n");
      await git(dir, ["add", "src/z/blocked.txt"]);
      await git(dir, ["restore", "--worktree", "--source=HEAD", "--", "src/z/blocked.txt"]);
      assert.equal(await readFile(blockedPath, "utf8"), "tracked baseline blocked\n");
      assert.equal(await git(dir, ["show", ":src/z/blocked.txt"]), "operator staged drift");

      await assert.rejects(
        invokeLog(discardArgs(dir)),
        /tracked cleanup.*index|cleanup.*drift|staged.*changed/i,
      );

      assert.equal(await git(dir, ["show", ":src/z/blocked.txt"]), "operator staged drift");
      await access(await receiptPath(dir));
    } finally {
      await chmod(blockedDirectory, 0o700).catch(() => {});
    }
  });
});

test("tracked cleanup removes staged additions after restoring their index entry", async (t) => {
  for (const kind of ["ordinary", "ignored"] as const) {
    await t.test(kind, async () => {
      await withTempDir(`discard-staged-added-${kind}`, async (dir) => {
        await setupTransactionFixture(dir, { stagedAddedCandidate: kind });
        const addedPath = kind === "ignored" ? "src/new.generated" : "src/new.txt";
        assert.equal(await git(dir, ["show", `:${addedPath}`]), "staged candidate addition");

        const logged = await invokeLog(discardArgs(dir));

        assert.equal(logged.ok, true);
        await assert.rejects(access(path.join(dir, addedPath)), /ENOENT/);
        assert.equal(await git(dir, ["status", "--short", "--", "src"]), "");
        assert.equal(await git(dir, ["ls-files", "--", addedPath]), "");
      });
    });
  }
});

test(
  "non-keep retries converge after faults around ledger and independent cleanup stages",
  { timeout: 400_000 },
  async (t) => {
    const points: FaultPoint[] = [
      "before:ledger-event-present",
      "after:ledger-event-present",
      "before:tracked-cleanup-complete",
      "after:tracked-cleanup-complete",
      "before:untracked-cleanup-complete",
      "after:untracked-cleanup-complete",
      "before:packet-cleanup-complete",
      "after:packet-cleanup-complete",
    ];
    for (const point of points) {
      await t.test(point, async () => {
        await withTempDir(`discard-${point.replaceAll(":", "-")}`, async (dir) => {
          await setupTransactionFixture(dir, { untrackedCandidate: true });
          await assert.rejects(
            invokeLog(discardArgs(dir), { faultInjection: (seen) => failAt(seen, point) }),
            new RegExp(point),
          );
          const pending = JSON.parse(await readFile(await receiptPath(dir), "utf8"));
          assert.equal(pending.status, "failed");
          const retried = await invokeLog(discardArgs(dir));
          assert.equal(retried.ok, true);
          assert.equal(await readFile(path.join(dir, "src", "score.txt"), "utf8"), "1\n");
          await assert.rejects(access(path.join(dir, "src", "scratch.txt")), /ENOENT/);
          const rows = await ledgerRows(dir);
          assert.equal(rows.filter((row) => row.description === "Discard candidate").length, 1);
          await assert.rejects(access(await receiptPath(dir)), /ENOENT/);
        });
      });
    }
  },
);

test("pending retries reject changed inputs and preserve the original transaction", async () => {
  await withTempDir("changed-input-retry", async (dir) => {
    await setupTransactionFixture(dir);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:ledger-event-present"),
      }),
      /before:ledger-event-present/,
    );
    const before = await readFile(await receiptPath(dir), "utf8");
    await assert.rejects(
      invokeLog(keepArgs(dir, "Changed retry description")),
      /changed inputs|different input/i,
    );
    assert.equal(await readFile(await receiptPath(dir), "utf8"), before);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      0,
    );
  });
});

test("pending keep retry rejects candidate drift before commit", async () => {
  await withTempDir("candidate-drift-retry", async (dir) => {
    await setupTransactionFixture(dir);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:commit-applied-or-verified"),
      }),
      /before:commit-applied-or-verified/,
    );
    await writeFile(path.join(dir, "src", "score.txt"), "3\n");

    await assert.rejects(invokeLog(keepArgs(dir)), /candidate.*changed|fingerprint.*changed/i);
    assert.equal(Number(await git(dir, ["rev-list", "--count", "HEAD"])), 1);
  });
});

test("pending keep retry rejects accepted contract input drift before commit", async () => {
  await withTempDir("contract-input-drift-retry", async (dir) => {
    await setupTransactionFixture(dir);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:commit-applied-or-verified"),
      }),
      /before:commit-applied-or-verified/,
    );
    await writeFile(
      path.join(dir, "contract", "evaluator.mjs"),
      "console.log('METRIC score=999');\n",
    );

    await assert.rejects(
      invokeLog(keepArgs(dir)),
      /accepted.*input.*changed|protected.*changed|contract.*no longer/i,
    );
    assert.equal(Number(await git(dir, ["rev-list", "--count", "HEAD"])), 1);
  });
});

test("initial keep revalidates accepted protected inputs inside the commit stage", async () => {
  await withTempDir("initial-contract-input-drift", async (dir) => {
    await setupTransactionFixture(dir);
    const parent = await git(dir, ["rev-parse", "HEAD"]);

    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: async (seen) => {
          if (seen === "before:commit-applied-or-verified") {
            await writeFile(path.join(dir, "contract", "checks.mjs"), "process.exit(1);\n");
          }
        },
      }),
      /accepted.*input.*changed|protected.*changed|contract.*no longer/i,
    );

    assert.equal(await git(dir, ["rev-parse", "HEAD"]), parent);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      0,
    );
  });
});

test("initial keep revalidates accepted repository state inside the commit stage", async () => {
  await withTempDir("initial-repository-drift", async (dir) => {
    await setupTransactionFixture(dir, { outsideTracked: true });
    const parent = await git(dir, ["rev-parse", "HEAD"]);

    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: async (seen) => {
          if (seen === "before:commit-applied-or-verified") {
            await writeFile(path.join(dir, "outside.txt"), "outside drift at commit boundary\n");
          }
        },
      }),
      /repository.*changed|outside.*editable|accepted.*contract|dirty state/i,
    );

    assert.equal(await git(dir, ["rev-parse", "HEAD"]), parent);
    assert.equal(
      await readFile(path.join(dir, "outside.txt"), "utf8"),
      "outside drift at commit boundary\n",
    );
  });
});

test("keep revalidates accepted authority after ref advancement before evidence append", async () => {
  await withTempDir("post-ref-contract-input-drift", async (dir) => {
    await setupTransactionFixture(dir);
    const checksPath = path.join(dir, "contract", "checks.mjs");
    const acceptedChecks = await readFile(checksPath, "utf8");

    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: async (seen) => {
          if (seen === "after:commit-ref-updated") {
            await writeFile(checksPath, "process.exit(1);\n");
          }
        },
      }),
      /accepted.*input.*changed|protected.*changed|contract.*no longer/i,
    );

    assert.equal(Number(await git(dir, ["rev-list", "--count", "HEAD"])), 2);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      0,
    );
    await access(await receiptPath(dir));

    await writeFile(checksPath, acceptedChecks);
    const retried = await invokeLog(keepArgs(dir));
    assert.equal(retried.ok, true);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      1,
    );
  });
});

test("pending retries reject receipt evidence and cleanup-path tampering", async (t) => {
  await t.test("evidence payload", async () => {
    await withTempDir("tampered-receipt-evidence", async (dir) => {
      await setupTransactionFixture(dir);
      await assert.rejects(
        invokeLog(keepArgs(dir), {
          faultInjection: (seen) => failAt(seen, "before:ledger-event-present"),
        }),
        /before:ledger-event-present/,
      );
      const pendingPath = await receiptPath(dir);
      const receipt = JSON.parse(await readFile(pendingPath, "utf8"));
      receipt.evidence.experiment.description = "Tampered evidence";
      await writeFile(pendingPath, `${JSON.stringify(receipt, null, 2)}\n`);

      await assert.rejects(invokeLog(keepArgs(dir)), /receipt.*integrity|malformed/i);
      assert.equal(
        (await ledgerRows(dir)).filter((row) => row.description === "Tampered evidence").length,
        0,
      );
    });
  });

  await t.test("packet cleanup target", async () => {
    await withTempDir("tampered-receipt-cleanup", async (dir) => {
      const victim = path.join(path.dirname(dir), `${path.basename(dir)}-victim.txt`);
      await writeFile(victim, "preserve me\n");
      try {
        await setupTransactionFixture(dir);
        await assert.rejects(
          invokeLog(discardArgs(dir), {
            faultInjection: (seen) => failAt(seen, "before:ledger-event-present"),
          }),
          /before:ledger-event-present/,
        );
        const pendingPath = await receiptPath(dir);
        const receipt = JSON.parse(await readFile(pendingPath, "utf8"));
        receipt.cleanup.packetPaths = [victim];
        await writeFile(pendingPath, `${JSON.stringify(receipt, null, 2)}\n`);

        await assert.rejects(invokeLog(discardArgs(dir)), /receipt.*integrity|cleanup.*path/i);
        assert.equal(await readFile(victim, "utf8"), "preserve me\n");
      } finally {
        await rm(victim, { force: true });
      }
    });
  });
});

test("pending retry rejects a transaction row whose content no longer matches its event digest", async () => {
  await withTempDir("tampered-ledger-event", async (dir) => {
    await setupTransactionFixture(dir);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "after:ledger-event-present"),
      }),
      /after:ledger-event-present/,
    );
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const rows = await ledgerRows(dir);
    const transactionRow = rows.find((row) => row.description === "Keep accepted candidate");
    assert.ok(transactionRow);
    transactionRow.description = "Corrupted transaction row";
    await writeFile(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    await assert.rejects(
      invokeLog(keepArgs(dir)),
      /ledger event.*content|different.*digest|not an unambiguous partial write/i,
    );
  });
});

test("tracked and untracked discard cleanup resume independently", async () => {
  await withTempDir("mixed-cleanup", async (dir) => {
    await setupTransactionFixture(dir, { untrackedCandidate: true });
    await assert.rejects(
      invokeLog(discardArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:tracked-cleanup-complete"),
      }),
      /before:tracked-cleanup-complete/,
    );
    assert.equal(await readFile(path.join(dir, "src", "score.txt"), "utf8"), "2\n");
    await assert.rejects(access(path.join(dir, "src", "scratch.txt")), /ENOENT/);
    const receipt = JSON.parse(await readFile(await receiptPath(dir), "utf8"));
    assert.equal(receipt.completedStages.includes("tracked-cleanup-complete"), false);
    assert.equal(receipt.completedStages.includes("untracked-cleanup-complete"), true);

    await assert.rejects(
      invokeLog(discardArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:packet-cleanup-complete"),
      }),
      /before:packet-cleanup-complete/,
    );
    const resumedReceipt = JSON.parse(await readFile(await receiptPath(dir), "utf8"));
    assert.deepEqual(resumedReceipt.completedStages, [
      "prepared",
      "ledger-event-present",
      "tracked-cleanup-complete",
      "untracked-cleanup-complete",
    ]);
    await invokeLog(discardArgs(dir));
    assert.equal(await readFile(path.join(dir, "src", "score.txt"), "utf8"), "1\n");
  });
});

test("safe evidence artifacts are hashed outside editable and protected scope without staling the candidate", async () => {
  await withTempDir("safe-evidence", async (dir) => {
    await mkdir(path.join(dir, "evidence"), { recursive: true });
    await setupTransactionFixture(dir, {
      artifactPath: "evidence/proof.json",
      generateArtifactDuringRun: true,
    });
    const statusBeforeLog = await git(dir, ["status", "--short", "--untracked-files=all"]);
    assert.match(statusBeforeLog, /\?\? evidence\/proof\.json/);
    const logged = await invokeLog(keepArgs(dir));
    assert.equal(logged.ok, true);
    assert.equal(logged.experiment.artifactEvidence[0].path, "evidence/proof.json");
    assert.match(logged.experiment.artifactEvidence[0].digest, /^[a-f0-9]{64}$/);
  });
});

test("broad discard cleanup preserves verified evidence artifacts", async () => {
  await withTempDir("preserve-discard-evidence", async (dir) => {
    await setupTransactionFixture(dir, {
      artifactPath: "evidence/proof.json",
      commitPaths: [],
      generateArtifactDuringRun: true,
    });
    const logged = await invokeLog({ ...discardArgs(dir), allow_dirty_revert: true });
    assert.equal(logged.ok, true);
    assert.equal(
      await readFile(path.join(dir, "evidence", "proof.json"), "utf8"),
      '{"proof":true}\n',
    );
  });
});

test("evidence artifacts fail closed on root escape, scope overlap, external targets, and linked escapes", async (t) => {
  await t.test("editable overlap", async () => {
    await withTempDir("artifact-editable-overlap", async (dir) => {
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "proof.json"), "{}\n");
      await setupTransactionFixture(dir, { artifactPath: "src/proof.json" });
      await assert.rejects(invokeLog(keepArgs(dir)), /artifact.*editable|scope overlap/i);
    });
  });
  await t.test("protected overlap", async () => {
    await withTempDir("artifact-protected-overlap", async (dir) => {
      await mkdir(path.join(dir, "contract"), { recursive: true });
      await writeFile(path.join(dir, "contract", "proof.json"), "{}\n");
      await setupTransactionFixture(dir, {
        artifactPath: "contract/proof.json",
        protectedArtifact: true,
      });
      await assert.rejects(invokeLog(keepArgs(dir)), /artifact.*protected|scope overlap/i);
    });
  });
  await t.test("Git private overlap", async () => {
    await withTempDir("artifact-git-private-overlap", async (dir) => {
      await git(dir, ["init"]);
      await setupFixture(dir, { name: "Git-private artifact overlap" });
      await assert.rejects(
        invokeLog({
          cwd: dir,
          metric: 1,
          status: "measure",
          description: "Reject Git-private artifact",
          artifacts: { proof: ".git/config" },
        }),
        /artifact.*protected|scope overlap|Git.private/i,
      );
    });
  });
  await t.test("external target", async () => {
    await withTempDir("artifact-external", async (dir) => {
      const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside-proof.json`);
      await writeFile(outside, "{}\n");
      try {
        await setupTransactionFixture(dir, { artifactPath: outside });
        await assert.rejects(invokeLog(keepArgs(dir)), /artifact.*outside|quarantined/i);
      } finally {
        await rm(outside, { force: true });
      }
    });
  });
  await t.test("symlink or junction escape", async () => {
    await withTempDir("artifact-linked", async (dir) => {
      const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "proof.json"), "{}\n");
      await mkdir(dir, { recursive: true });
      try {
        await symlink(
          outside,
          path.join(dir, "linked"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        t.skip(`directory links unavailable: ${String(error)}`);
        await rm(outside, { recursive: true, force: true });
        return;
      }
      try {
        await setupTransactionFixture(dir, { artifactPath: "linked/proof.json" });
        await assert.rejects(
          invokeLog(keepArgs(dir)),
          /artifact.*outside|symlink|junction|quarantined/i,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
  await t.test("internal linked editable alias", async () => {
    await withTempDir("artifact-linked-editable", async (dir) => {
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "proof.json"), "{}\n");
      await writeFile(path.join(dir, ".gitignore"), "linked-src\n");
      try {
        await symlink(
          path.join(dir, "src"),
          path.join(dir, "linked-src"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        t.skip(`directory links unavailable: ${String(error)}`);
        return;
      }
      await setupTransactionFixture(dir, { artifactPath: "linked-src/proof.json" });
      await assert.rejects(invokeLog(keepArgs(dir)), /artifact.*editable|scope overlap/i);
    });
  });
  await t.test("artifact root escape", async () => {
    await withTempDir("artifact-root-escape", async (dir) => {
      await mkdir(path.join(dir, "evidence"), { recursive: true });
      await mkdir(path.join(dir, "other"), { recursive: true });
      await writeFile(path.join(dir, "other", "proof.json"), "{}\n");
      await setupTransactionFixture(dir, { artifactPath: "other/proof.json" });
      const packetPath = path.join(dir, ".git", "autoresearch", "last-run.json");
      const packet = JSON.parse(await readFile(packetPath, "utf8"));
      packet.run.progressSnapshot.artifactRoot = "evidence";
      await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
      await assert.rejects(invokeLog(keepArgs(dir)), /artifact root|outside.*artifact/i);
    });
  });
});

test("manual evidence artifacts still honor configured editable and protected scope", async (t) => {
  for (const [label, artifactPath, expected] of [
    ["editable", "src/score.txt", /artifact.*editable/i],
    ["protected", "contract/evaluator.mjs", /artifact.*protected/i],
  ] as const) {
    await t.test(label, async () => {
      await withTempDir(`manual-artifact-${label}`, async (dir) => {
        await setupTransactionFixture(dir);
        await assert.rejects(
          invokeLog({
            cwd: dir,
            metric: 2,
            status: "measure",
            description: `Manual ${label} artifact`,
            artifacts: { proof: artifactPath },
          }),
          expected,
        );
      });
    });
  }
});

test("accepted artifact scope fails closed when runtime config drifts", async () => {
  await withTempDir("manual-artifact-accepted-scope-drift", async (dir) => {
    await setupTransactionFixture(dir);
    const configPath = path.join(dir, "autoresearch.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    delete config.protectedBenchmarkPaths;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await assert.rejects(
      invokeLog({
        cwd: dir,
        metric: 2,
        status: "measure",
        description: "Manual artifact after scope drift",
        artifacts: { proof: "contract/evaluator.mjs" },
      }),
      /accepted.*contract|protected|drift|does not match/i,
    );
  });
});

test("evidence digest drift after interruption blocks ledger append", async () => {
  await withTempDir("artifact-digest-drift", async (dir) => {
    await mkdir(path.join(dir, "evidence"), { recursive: true });
    await writeFile(path.join(dir, "evidence", "proof.json"), '{"version":1}\n');
    await setupTransactionFixture(dir, { artifactPath: "evidence/proof.json" });
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:ledger-event-present"),
      }),
      /before:ledger-event-present/,
    );
    await writeFile(path.join(dir, "evidence", "proof.json"), '{"version":2}\n');
    await assert.rejects(invokeLog(keepArgs(dir)), /artifact.*digest.*changed|digest drift/i);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      0,
    );
  });
});

test("evidence root link drift after interruption blocks ledger append", async (t) => {
  await withTempDir("artifact-root-link-drift", async (dir) => {
    const evidenceDir = path.join(dir, "evidence");
    const replacementDir = path.join(dir, "replacement-evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "proof.json"), '{"version":1}\n');
    await setupTransactionFixture(dir, { artifactPath: "evidence/proof.json" });
    const packetPath = path.join(dir, ".git", "autoresearch", "last-run.json");
    const packet = JSON.parse(await readFile(packetPath, "utf8"));
    packet.run.progressSnapshot.artifactRoot = "evidence";
    await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:ledger-event-present"),
      }),
      /before:ledger-event-present/,
    );
    await rm(evidenceDir, { recursive: true, force: true });
    await mkdir(replacementDir, { recursive: true });
    await writeFile(path.join(replacementDir, "proof.json"), '{"version":1}\n');
    try {
      await symlink(replacementDir, evidenceDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`directory links unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(invokeLog(keepArgs(dir)), /artifact root|symlink|junction|escaped/i);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      0,
    );
  });
});

test("imported commits require accepted evaluation of the current candidate", async () => {
  await withTempDir("dirty-imported-current-head", async (dir) => {
    await setupTransactionFixture(dir);
    const current = await git(dir, ["rev-parse", "HEAD"]);
    await assert.rejects(
      invokeLog({ ...keepArgs(dir, "Unevaluated imported tree"), commit: current }),
      /accepted evaluation|evaluated candidate|current candidate/i,
    );
  });
  await withTempDir("wrong-imported-commit", async (dir) => {
    const { initialCommit } = await setupTransactionFixture(dir, {
      commitCandidateBeforePacket: true,
    });
    await assert.rejects(
      invokeLog({ ...keepArgs(dir, "Wrong imported commit"), commit: initialCommit }),
      /accepted evaluation|evaluated candidate|current candidate/i,
    );
  });
  await withTempDir("accepted-imported-commit", async (dir) => {
    await setupTransactionFixture(dir, { commitCandidateBeforePacket: true });
    const current = await git(dir, ["rev-parse", "HEAD"]);
    const accepted = await invokeLog({ ...keepArgs(dir), commit: current });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.experiment.commit, current.slice(0, 12));
    assert.equal(accepted.experiment.candidateOrigin.kind, "commit");
  });
  await withTempDir("accepted-imported-commit-retry", async (dir) => {
    await setupTransactionFixture(dir, { commitCandidateBeforePacket: true });
    const current = await git(dir, ["rev-parse", "HEAD"]);
    const args = { ...keepArgs(dir), commit: current };
    await assert.rejects(
      invokeLog(args, {
        faultInjection: (seen) => failAt(seen, "before:ledger-event-present"),
      }),
      /before:ledger-event-present/,
    );
    const accepted = await invokeLog(args);
    assert.equal(accepted.ok, true);
    assert.equal(
      (await ledgerRows(dir)).filter((row) => row.description === "Keep accepted candidate").length,
      1,
    );
  });
});

test("pending keep recovery rejects a same-message commit with the wrong intended tree", async () => {
  await withTempDir("wrong-tree-interrupted-commit", async (dir) => {
    await setupTransactionFixture(dir, { commitPaths: [] });
    const args = { ...keepArgs(dir), allow_add_all: true, commit_paths: [] };
    await assert.rejects(
      invokeLog(args, {
        faultInjection: (seen) => failAt(seen, "before:commit-applied-or-verified"),
      }),
      /before:commit-applied-or-verified/,
    );
    const pending = JSON.parse(await readFile(await receiptPath(dir), "utf8"));
    const messagePath = path.join(dir, ".git", "unrelated-commit-message.txt");
    await writeFile(messagePath, pending.commitExpectation.message, "utf8");
    await git(dir, ["commit", "--allow-empty", "-F", messagePath]);
    const unrelatedHead = await git(dir, ["rev-parse", "HEAD"]);

    await assert.rejects(
      invokeLog(args),
      /HEAD changed|tree.*changed|intended.*tree|repository revision.*expected HEAD/i,
    );
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), unrelatedHead);
    assert.equal(await readFile(path.join(dir, "src", "score.txt"), "utf8"), "2\n");
    assert.equal(await git(dir, ["show", "--name-only", "--format=", "HEAD"]), "");
  });
});

test("keep commit creation is hook-free and stays bound to the evaluated candidate tree", async () => {
  await withTempDir("hook-free-intended-tree", async (dir) => {
    await setupTransactionFixture(dir);
    await git(dir, ["config", "core.hooksPath", ".git/hooks"]);
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(
      hookPath,
      [
        "#!/bin/sh",
        "printf '99\\n' > src/score.txt",
        "git add src/score.txt",
        "printf 'ran\\n' > .git/autoresearch-hook-ran",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(hookPath, 0o755);

    const logged = await invokeLog(keepArgs(dir));

    assert.equal(logged.ok, true);
    assert.equal(await git(dir, ["show", "HEAD:src/score.txt"]), "2");
    await assert.rejects(access(path.join(dir, ".git", "autoresearch-hook-ran")), /ENOENT/);
  });
});

test("non-keep retry rejects tracked candidate work created after the crash", async () => {
  await withTempDir("discard-post-crash-drift", async (dir) => {
    await setupTransactionFixture(dir);
    await assert.rejects(
      invokeLog(discardArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:tracked-cleanup-complete"),
      }),
      /before:tracked-cleanup-complete/,
    );
    await writeFile(path.join(dir, "src", "score.txt"), "99 user work after crash\n");

    await assert.rejects(invokeLog(discardArgs(dir)), /cleanup.*drift|worktree.*changed/i);
    assert.equal(
      await readFile(path.join(dir, "src", "score.txt"), "utf8"),
      "99 user work after crash\n",
    );
  });
});

test("non-keep retry rejects untracked candidate work changed after the crash", async () => {
  await withTempDir("discard-untracked-post-crash-drift", async (dir) => {
    await setupTransactionFixture(dir, { untrackedCandidate: true });
    await assert.rejects(
      invokeLog(discardArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:untracked-cleanup-complete"),
      }),
      /before:untracked-cleanup-complete/,
    );
    await writeFile(path.join(dir, "src", "scratch.txt"), "operator work after crash\n");

    await assert.rejects(invokeLog(discardArgs(dir)), /cleanup.*drift|worktree.*changed/i);
    assert.equal(
      await readFile(path.join(dir, "src", "scratch.txt"), "utf8"),
      "operator work after crash\n",
    );
  });
});

test("cleanup plans structurally exclude session and evidence paths before destructive stages", async () => {
  await withTempDir("cleanup-structural-exclusions", async (dir) => {
    await setupTransactionFixture(dir, {
      artifactPath: "evidence/proof.json",
      commitPaths: [],
      dirtySessionBeforePacket: true,
      generateArtifactDuringRun: true,
    });
    await assert.rejects(
      invokeLog(
        { ...discardArgs(dir), allow_dirty_revert: true },
        {
          faultInjection: (seen) => failAt(seen, "before:tracked-cleanup-complete"),
        },
      ),
      /before:tracked-cleanup-complete/,
    );

    const pending = JSON.parse(await readFile(await receiptPath(dir), "utf8"));
    assert.equal(pending.cleanup.trackedPaths.includes("autoresearch.md"), false);
    assert.equal(pending.cleanup.untrackedPaths.includes("evidence/proof.json"), false);
    assert.equal(
      await readFile(path.join(dir, "autoresearch.md"), "utf8"),
      "operator state that must survive\n",
    );
    assert.equal(
      await readFile(path.join(dir, "evidence", "proof.json"), "utf8"),
      '{"proof":true}\n',
    );
  });
});

test("real log retry repairs only a receipt-owned torn ledger suffix", async () => {
  await withTempDir("owned-torn-ledger-suffix", async (dir) => {
    await setupTransactionFixture(dir);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:ledger-event-present"),
      }),
      /before:ledger-event-present/,
    );
    const pending = JSON.parse(await readFile(await receiptPath(dir), "utf8"));
    const baseRows = [...pending.evidence.processLifecycle, pending.evidence.experiment];
    const firstExpected = {
      ...baseRows[0],
      logTransaction: {
        id: pending.transaction.id,
        eventDigest: pending.ledgerEvent.eventDigest,
        entryIndex: 0,
        entryCount: baseRows.length,
      },
    };
    const serialized = JSON.stringify(firstExpected);
    await appendFile(
      path.join(dir, "autoresearch.jsonl"),
      serialized.slice(0, Math.floor(serialized.length / 2)),
      "utf8",
    );

    const retried = await runCli(keepCliArgs(dir));

    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(JSON.parse(retried.stdout).ok, true);
    const rows = await ledgerRows(dir);
    const transactionRows = rows.filter((row) => row.logTransaction?.id === pending.transaction.id);
    assert.equal(transactionRows.length, baseRows.length);
    assert.equal(
      new Set(transactionRows.map((row) => row.logTransaction.entryIndex)).size,
      baseRows.length,
    );
  });
});

test("pending log recovery refuses an unrelated malformed ledger suffix", async () => {
  await withTempDir("foreign-torn-ledger-suffix", async (dir) => {
    await setupTransactionFixture(dir);
    await assert.rejects(
      invokeLog(keepArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:ledger-event-present"),
      }),
      /before:ledger-event-present/,
    );
    const pendingPath = await receiptPath(dir);
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const beforeReceipt = await readFile(pendingPath, "utf8");
    await appendFile(ledgerPath, '{"foreign":"corruption"', "utf8");
    const beforeLedger = await readFile(ledgerPath, "utf8");

    const refused = await runCli(keepCliArgs(dir));

    assert.notEqual(refused.code, 0);
    assert.match(
      refused.stderr,
      /ledger.*integrity|receipt-owned|unambiguous partial write|malformed/i,
    );
    assert.equal(await readFile(ledgerPath, "utf8"), beforeLedger);
    assert.equal(await readFile(pendingPath, "utf8"), beforeReceipt);
  });
});

test("forged done stages cannot skip non-keep cleanup or packet clearing", async () => {
  await withTempDir("forged-done-stages", async (dir) => {
    await setupTransactionFixture(dir, { untrackedCandidate: true });
    await assert.rejects(
      invokeLog(discardArgs(dir), {
        faultInjection: (seen) => failAt(seen, "before:tracked-cleanup-complete"),
      }),
      /before:tracked-cleanup-complete/,
    );
    const pendingPath = await receiptPath(dir);
    const pending = JSON.parse(await readFile(pendingPath, "utf8"));
    pending.completedStages = [
      "prepared",
      "ledger-event-present",
      "tracked-cleanup-complete",
      "untracked-cleanup-complete",
      "packet-cleanup-complete",
      "done",
    ];
    pending.status = "done";
    await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`);

    await assert.rejects(invokeLog(discardArgs(dir)), /receipt.*integrity|completed.*stage/i);
    assert.equal(await readFile(path.join(dir, "src", "score.txt"), "utf8"), "2\n");
    await assert.rejects(access(path.join(dir, "src", "scratch.txt")), /ENOENT/);
    await access(pendingPath);
  });
});

test("completed cleanup and packet stages are reverified before retry skips them", async (t) => {
  await t.test("tracked cleanup postcondition", async () => {
    await withTempDir("completed-tracked-cleanup-drift", async (dir) => {
      await setupTransactionFixture(dir, { untrackedCandidate: true });
      await assert.rejects(
        invokeLog(discardArgs(dir), {
          faultInjection: (seen) => failAt(seen, "after:tracked-cleanup-complete"),
        }),
        /after:tracked-cleanup-complete/,
      );
      await writeFile(path.join(dir, "src", "score.txt"), "operator edit after cleanup\n");

      await assert.rejects(
        invokeLog(discardArgs(dir)),
        /cleanup.*postcondition|worktree.*changed/i,
      );
      assert.equal(
        await readFile(path.join(dir, "src", "score.txt"), "utf8"),
        "operator edit after cleanup\n",
      );
    });
  });

  await t.test("untracked cleanup postcondition", async () => {
    await withTempDir("completed-untracked-cleanup-drift", async (dir) => {
      await setupTransactionFixture(dir, { untrackedCandidate: true });
      await assert.rejects(
        invokeLog(discardArgs(dir), {
          faultInjection: (seen) => failAt(seen, "after:untracked-cleanup-complete"),
        }),
        /after:untracked-cleanup-complete/,
      );
      await writeFile(path.join(dir, "src", "scratch.txt"), "operator edit after cleanup\n");

      await assert.rejects(
        invokeLog(discardArgs(dir)),
        /cleanup.*postcondition|worktree.*changed/i,
      );
      assert.equal(
        await readFile(path.join(dir, "src", "scratch.txt"), "utf8"),
        "operator edit after cleanup\n",
      );
    });
  });

  await t.test("packet cleanup postcondition", async () => {
    await withTempDir("completed-packet-cleanup-drift", async (dir) => {
      await setupTransactionFixture(dir);
      const packetPath = path.join(dir, ".git", "autoresearch", "last-run.json");
      const packet = await readFile(packetPath, "utf8");
      await assert.rejects(
        invokeLog(keepArgs(dir), {
          faultInjection: (seen) => failAt(seen, "after:packet-cleanup-complete"),
        }),
        /after:packet-cleanup-complete/,
      );
      await writeFile(packetPath, packet, "utf8");

      await assert.rejects(
        invokeLog(keepArgs(dir)),
        /packet.*cleanup.*postcondition|packet.*present/i,
      );
      await access(await receiptPath(dir));
    });
  });
});

test("last-run keep rejects missing or conflicting evidence axes", async (t) => {
  for (const [label, mutatePacket] of [
    [
      "missing axes",
      (packet: Record<string, any>) => {
        delete packet.run.runPurpose;
        delete packet.run.evaluationAuthority;
        delete packet.run.candidateOrigin;
      },
    ],
    [
      "conflicting authority",
      (packet: Record<string, any>) => {
        packet.run.evaluationAuthority = "manual";
        packet.run.executionAuthority = "accepted-contract";
      },
    ],
    [
      "invalid candidate origin",
      (packet: Record<string, any>) => {
        packet.run.candidateOrigin = { kind: "commit", oid: "short" };
      },
    ],
  ] as const) {
    await t.test(label, async () => {
      await withTempDir(`packet-axes-${label.replaceAll(" ", "-")}`, async (dir) => {
        await setupTransactionFixture(dir);
        const packetPath = path.join(dir, ".git", "autoresearch", "last-run.json");
        const packet = JSON.parse(await readFile(packetPath, "utf8"));
        mutatePacket(packet);
        await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);

        await assert.rejects(
          invokeLog(keepArgs(dir)),
          /evidence axes|run purpose|authority|origin/i,
        );
        assert.equal(Number(await git(dir, ["rev-list", "--count", "HEAD"])), 1);
      });
    });
  }
});
