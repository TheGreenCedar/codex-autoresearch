import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolvePackageRoot } from "../../lib/runtime-paths.js";
import {
  configureTestGitRepo,
  runProcess,
  testGitArgs,
  withTempDir as withNamedTempDir,
} from "../helpers/process.js";

export const pluginRoot = resolvePackageRoot(import.meta.url);
export const finalizer = path.join(pluginRoot, "scripts", "finalize-autoresearch.mjs");
export const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");

export async function run(command, args, cwd, allowFailure = false) {
  const result = await runProcess(command, args, cwd);
  if (!allowFailure && result.code !== 0) {
    const commandLine = command + " " + args.join(" ");
    throw new Error(commandLine + " failed:\n" + result.stdout + result.stderr);
  }
  return result;
}

export async function git(args, cwd) {
  const result = await run("git", testGitArgs(args), cwd);
  if (args[0] === "init") await configureTestGitRepo(cwd);
  return result;
}

export async function writeFile(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents, "utf8");
}

export async function withTempRoot(prefix, body) {
  return await withNamedTempDir(prefix.replace(/-$/, ""), "root", body);
}

export function testWithTempRoot(name, prefix, body) {
  test(name, async () => {
    await withTempRoot(prefix, body);
  });
}

export async function writeCompleteFinalizationEvidenceFixture(
  repo: string,
  options: {
    acceptedEvaluation?: boolean;
    description?: string;
    direction?: "higher" | "lower";
    editableScope?: string[];
    goal?: string;
    metric?: number;
    metricName?: string;
    name?: string;
    targetCommit?: string;
  } = {},
) {
  const ledgerPath = path.join(repo, "autoresearch.jsonl");
  const existing = await readExistingLedger(ledgerPath);
  const legacyConfig = [...existing]
    .reverse()
    .find((record) => record && typeof record === "object" && record.type === "config");
  const name = options.name || String(legacyConfig?.name || "finalization fixture");
  const goal =
    options.goal ??
    (Object.hasOwn(legacyConfig || {}, "goal")
      ? String(legacyConfig?.goal || "")
      : "Exercise review branch planning.");
  const metricName = options.metricName || String(legacyConfig?.metricName || "score");
  const direction =
    options.direction || (legacyConfig?.bestDirection === "higher" ? "higher" : "lower");
  const targetCommit = (
    await git(["rev-parse", options.targetCommit || latestAcceptedCommit(existing) || "HEAD"], repo)
  ).stdout.trim();
  const currentHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
  assert.equal(
    currentHead,
    targetCommit,
    "Create later rejected or unlogged history only after the real accepted target fixture.",
  );
  const targetParentResult = await run(
    "git",
    testGitArgs(["rev-parse", `${targetCommit}^`]),
    repo,
    true,
  );
  assert.equal(
    targetParentResult.code,
    0,
    "Complete finalization evidence needs a parent commit for its real baseline packet.",
  );
  const baselineCommit = targetParentResult.stdout.trim();
  const changedFiles = (
    await git(["diff", "--name-only", baselineCommit, targetCommit], repo)
  ).stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter((file) => file && !file.startsWith("autoresearch"));
  const inferredScope = [
    ...new Set(
      changedFiles
        .map((file) => (/[*?[\]]/.test(file) ? path.posix.dirname(file) : file))
        .filter((file) => file !== "."),
    ),
  ];
  const editableScope = options.editableScope || inferredScope;
  if (editableScope.length === 0) editableScope.push("src");
  const candidateRecordIndex = findAcceptedEvaluationIndex(existing, targetCommit);
  const candidateRecord = candidateRecordIndex >= 0 ? existing[candidateRecordIndex] : null;
  const candidateMetric =
    options.metric ??
    (Number.isFinite(candidateRecord?.metric) ? Number(candidateRecord.metric) : 1);
  const baselineMetric = candidateMetric + (direction === "higher" ? -1 : 1);
  const benchmarkProgram = [
    'const { spawnSync } = require("node:child_process");',
    `const changedFiles = ${JSON.stringify(changedFiles)};`,
    'const diff = spawnSync("git", ["diff", "--quiet", "HEAD", "--", ...changedFiles],',
    '  { env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } });',
    "if (diff.error) throw diff.error;",
    "if (diff.status !== 0 && diff.status !== 1) process.exit(diff.status ?? 1);",
    `const metric = diff.status === 0 ? ${candidateMetric} : ${baselineMetric};`,
    `console.log(${JSON.stringify(`METRIC ${metricName}=`)} + metric);`,
  ].join(" ");
  const benchmarkCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    benchmarkProgram,
  )}`;
  const checksCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    "process.exit(0)",
  )}`;
  const rawRecords = existing.filter(
    (record) => record?.type !== "config" && record?.type !== "experiment-contract-accepted",
  );
  const replacedRecordIndex = findAcceptedEvaluationIndex(rawRecords, targetCommit);
  if (options.acceptedEvaluation !== false && replacedRecordIndex >= 0) {
    rawRecords.splice(replacedRecordIndex, 1);
  }

  const excludePathResult = (
    await git(["rev-parse", "--git-path", "info/exclude"], repo)
  ).stdout.trim();
  const excludePath = path.isAbsolute(excludePathResult)
    ? excludePathResult
    : path.join(repo, excludePathResult);
  await fsp.mkdir(path.dirname(excludePath), { recursive: true });
  await fsp.appendFile(excludePath, "\nautoresearch*\n", "utf8");
  await fsp.rm(ledgerPath, { force: true });

  const setup = await run(
    process.execPath,
    [
      cli,
      "setup",
      "--cwd",
      repo,
      "--name",
      name,
      "--goal",
      goal,
      "--metric-name",
      metricName,
      "--direction",
      direction,
      "--benchmark-command",
      benchmarkCommand,
      "--checks-command",
      checksCommand,
      "--scope",
      editableScope.join(","),
      "--commit-paths",
      editableScope.join(","),
      "--max-iterations",
      "6",
      "--packet-budget",
      "6",
      "--overwrite",
    ],
    repo,
  );
  const setupPayload = JSON.parse(setup.stdout);
  const configPath = path.join(repo, "autoresearch.config.json");
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  await fsp.writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        checksAuthoritative: true,
        commitPaths: editableScope,
        editableScope,
        maxIterations: 6,
        noiseModel: { kind: "deterministic" },
        packetBudget: 6,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const accepted = await run(
    process.execPath,
    [
      cli,
      "new-segment",
      "--cwd",
      repo,
      "--reason",
      "Accept the complete finalization fixture contract",
      "--yes",
    ],
    repo,
  );
  const acceptedPayload = JSON.parse(accepted.stdout);
  assert.equal(acceptedPayload.experimentContract?.status, "accepted");

  await materializeCommitPaths(repo, baselineCommit, changedFiles);
  const baseline = await run(process.execPath, [cli, "next", "--cwd", repo], repo);
  const baselinePayload = JSON.parse(baseline.stdout);
  assert.equal(baselinePayload.run?.parsedPrimary, baselineMetric);
  const baselineLog = await run(
    process.execPath,
    [
      cli,
      "log",
      "--cwd",
      repo,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Accepted finalization fixture baseline",
    ],
    repo,
  );
  assert.equal(JSON.parse(baselineLog.stdout).experiment?.status, "measure");
  await materializeCommitPaths(repo, targetCommit, changedFiles);

  const earnedRecords = await readExistingLedger(ledgerPath);
  let nextRun =
    earnedRecords.reduce(
      (maximum, record) =>
        Number.isSafeInteger(record?.run) ? Math.max(maximum, Number(record.run)) : maximum,
      0,
    ) + 1;
  const orderedRawRecords = rawRecords.map((record) => {
    if (!Number.isSafeInteger(record?.run)) return record;
    const orderedRecord = { ...record, run: nextRun };
    nextRun += 1;
    return orderedRecord;
  });
  await fsp.appendFile(
    ledgerPath,
    orderedRawRecords.length > 0
      ? `${orderedRawRecords.map((record) => JSON.stringify(record)).join("\n")}\n`
      : "",
    "utf8",
  );

  assert.ok(setupPayload.files.length > 0);
  if (options.acceptedEvaluation !== false) {
    const candidate = await run(process.execPath, [cli, "next", "--cwd", repo], repo);
    const candidatePayload = JSON.parse(candidate.stdout);
    assert.equal(candidatePayload.run?.parsedPrimary, candidateMetric);
    assert.equal(candidatePayload.decision?.allowedStatuses?.includes("keep"), true);
    const kept = await run(
      process.execPath,
      [
        cli,
        "log",
        "--cwd",
        repo,
        "--from-last",
        "--status",
        "keep",
        "--description",
        options.description ||
          candidateRecord?.description ||
          "Accepted finalization fixture evaluation",
        "--commit",
        targetCommit,
      ],
      repo,
    );
    const keptPayload = JSON.parse(kept.stdout);
    assert.equal(keptPayload.experiment?.status, "keep");
    assert.equal(commitMatches(keptPayload.experiment?.commit, targetCommit), true);
  }
  const ledger = await readExistingLedger(ledgerPath);
  const acceptance = ledger.find((record) => record?.type === "experiment-contract-accepted");
  assert.ok(acceptance);
  return { acceptance, targetCommit };
}

async function readExistingLedger(ledgerPath: string): Promise<Array<Record<string, any>>> {
  try {
    return (await fsp.readFile(ledgerPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function materializeCommitPaths(repo: string, commit: string, relativePaths: string[]) {
  for (const relativePath of relativePaths) {
    const exists = await run(
      "git",
      testGitArgs(["cat-file", "-e", `${commit}:${relativePath}`]),
      repo,
      true,
    );
    const filePath = path.join(repo, relativePath);
    if (exists.code !== 0) {
      await fsp.rm(filePath, { force: true });
      continue;
    }
    const contents = await run("git", testGitArgs(["show", `${commit}:${relativePath}`]), repo);
    await writeFile(filePath, contents.stdout);
  }
}

function latestAcceptedCommit(records: Array<Record<string, any>>): string {
  return String(
    [...records]
      .reverse()
      .find(
        (record) =>
          record?.status === "keep" &&
          record?.evidenceStatus !== "rejected" &&
          record?.evidenceStatus !== "superseded" &&
          record?.commit,
      )?.commit || "",
  );
}

function commitMatches(reference: unknown, targetCommit: string): boolean {
  const candidate = String(reference || "").toLowerCase();
  return candidate.length >= 7 && targetCommit.toLowerCase().startsWith(candidate);
}

function findAcceptedEvaluationIndex(
  records: Array<Record<string, any>>,
  targetCommit: string,
): number {
  const accepted = (record: Record<string, any>) =>
    record?.status === "keep" &&
    record?.evidenceStatus !== "rejected" &&
    record?.evidenceStatus !== "superseded";
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (accepted(records[index]) && commitMatches(records[index]?.commit, targetCommit))
      return index;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (accepted(records[index]) && !records[index]?.commit) return index;
  }
  return -1;
}

export async function createEvidencePlanFixture(root, name, options = {}) {
  const repo = path.join(root, name);
  await fsp.mkdir(repo, { recursive: true });
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);
  await writeFile(path.join(repo, ".gitignore"), "autoresearch.jsonl\n");
  await writeFile(path.join(repo, "src", "value.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);
  await git(["switch", "-c", `codex/${name}`], repo);
  await writeFile(path.join(repo, "src", "value.txt"), "accepted\n");
  await git(["add", "src/value.txt"], repo);
  await git(["commit", "-m", "accepted change"], repo);
  const commit = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
  const commitReference = options.commitRef ? options.commitRef(commit) : commit;
  const malformedCommitReference = !commitMatches(commitReference, commit);
  await writeFile(
    path.join(repo, "autoresearch.jsonl"),
    [
      JSON.stringify({
        type: "config",
        goal: "Deliver a shippable correctness improvement.",
      }),
      JSON.stringify({
        run: 1,
        status: "keep",
        evidenceStatus: "accepted",
        metric: 1,
        commit: commitReference,
        description: "Accepted change",
        evidence: "correctness checks passed",
      }),
      "",
    ].join("\n"),
  );
  await writeCompleteFinalizationEvidenceFixture(repo, {
    acceptedEvaluation: !malformedCommitReference,
    name,
    targetCommit: commit,
  });
  const output = path.join(root, `${name}.groups.json`);
  const planResult = await run(
    process.execPath,
    [finalizer, "plan", "--output", output, "--goal", name],
    repo,
    malformedCommitReference,
  );
  if (malformedCommitReference) {
    return { commit, output, plan: null, planResult, repo };
  }
  const plan = JSON.parse(await fsp.readFile(output, "utf8"));
  assert.ok(plan.accepted_evidence_fingerprint?.fingerprint);
  return { commit, output, plan, planResult, repo };
}
