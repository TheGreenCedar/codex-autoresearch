import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { quoteForAcceptedShell } from "../helpers/process.js";

import { git, runCli, withTempDir, setupFixture } from "../helpers/cli-test-context.js";

const contractChecksCommand = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)"`;

async function appendLegacyLedgerRows(dir: string, rows: Record<string, unknown>[]) {
  const ledgerPath = path.join(dir, "autoresearch.jsonl");
  const ledger = await readFile(ledgerPath, "utf8");
  await writeFile(
    ledgerPath,
    `${ledger}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

async function prepareAcceptedCandidateFixture(
  dir: string,
  options: {
    baselineMetric?: number;
    benchmarkCommand: string;
    commandFile?: string;
    commandFileContract?: boolean;
    direction?: "higher" | "lower";
    envFile?: string;
    metricName?: string;
    name: string;
  },
) {
  await mkdir(path.join(dir, "contract"), { recursive: true });
  await writeFile(path.join(dir, "contract", "checks.mjs"), "process.exit(0);\n", "utf8");
  const checksCommand = `${quoteForAcceptedShell(process.execPath)} contract/checks.mjs`;
  const setup = await setupFixture(
    dir,
    options.commandFileContract
      ? {
          direction: options.direction,
          metricName: options.metricName,
          name: options.name,
        }
      : {
          completeContract: true,
          benchmarkCommand: options.benchmarkCommand,
          checksCommand,
          direction: options.direction,
          metricName: options.metricName,
          name: options.name,
        },
  );
  assert.equal(setup.code, 0, setup.stderr);
  await mkdir(path.join(dir, "src"), { recursive: true });
  const configPath = path.join(dir, "autoresearch.config.json");
  const commandFileContents = options.commandFile
    ? await readFile(path.join(dir, options.commandFile), "utf8")
    : "";
  const config = options.commandFileContract ? {} : JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        ...(options.commandFileContract
          ? {
              benchmarkCommand: commandFileContents,
              checksCommand,
              commitPaths: ["src"],
              editableScope: ["src"],
              maxIterations: 6,
              packetBudget: 6,
              packetEnvFile: options.envFile,
              protectedBenchmarkPaths: [options.commandFile],
            }
          : {}),
        checkImplementationPaths: ["contract/checks.mjs"],
        checksAuthoritative: true,
        noiseModel: { kind: "deterministic" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await git(dir, ["init"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "accepted contract fixture"]);
  const accepted = await runCli([
    "new-segment",
    "--cwd",
    dir,
    ...(options.commandFile ? ["--benchmark-command", commandFileContents] : []),
    ...(options.envFile ? ["--packet-env-file", options.envFile] : []),
    "--reason",
    "Accept the complete packet fixture contract",
    "--yes",
  ]);
  assert.equal(accepted.code, 0, accepted.stderr);
  const baseline = await runCli([
    "log",
    "--cwd",
    dir,
    "--metric",
    String(options.baselineMetric ?? 0),
    "--status",
    "measure",
    "--description",
    "Accepted reference observation",
  ]);
  assert.equal(baseline.code, 0, baseline.stderr);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "candidate.txt"), "accepted candidate\n", "utf8");
}

async function setupCommandFileContract(
  dir: string,
  options: {
    checksCommand?: string;
    commandFile: string;
    direction?: "higher" | "lower";
    envFile: string;
    metricName?: string;
    name: string;
  },
) {
  const setup = await setupFixture(dir, {
    direction: options.direction,
    metricName: options.metricName,
    name: options.name,
  });
  assert.equal(setup.code, 0, setup.stderr);
  const benchmarkCommand = await readFile(path.join(dir, options.commandFile), "utf8");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "autoresearch.config.json"),
    `${JSON.stringify(
      {
        benchmarkCommand,
        checksCommand: options.checksCommand ?? contractChecksCommand,
        commitPaths: ["src"],
        editableScope: ["src"],
        maxIterations: 6,
        packetBudget: 6,
        packetEnvFile: options.envFile,
        protectedBenchmarkPaths: [options.commandFile],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const accepted = await runCli([
    "new-segment",
    "--cwd",
    dir,
    "--benchmark-command",
    benchmarkCommand,
    "--packet-env-file",
    options.envFile,
    "--reason",
    "Accept the command-file packet fixture contract",
    "--yes",
  ]);
  assert.equal(accepted.code, 0, accepted.stderr);
}

test("skill metadata keeps the default prompt inside the interface mapping", async () => {
  const metadata = await readFile(
    path.join(process.cwd(), "skills", "codex-autoresearch", "agents", "openai.yaml"),
    "utf8",
  );
  const interfaceBlock = metadata.match(/^interface:\n((?:^ {2}[^\n]+\n?)*)/m)?.[1] || "";

  assert.match(interfaceBlock, /^ {2}default_prompt:\s+".+"$/m);
  assert.doesNotMatch(metadata, /^default_prompt:/m);
});

test("next supports command-file, env-file, and ARTIFACT output contracts", async () => {
  await withTempDir("command-env-artifact", async (dir) => {
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(path.join(dir, "out", "manifest.json"), '{"ok":true}\n', "utf8");
    await writeFile(
      path.join(dir, "out", "task-manifest.json"),
      JSON.stringify({ tasks: [{ id: "task-1", status: "done" }] }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      "console.log(`METRIC score=${process.env.SCORE}`);\nconsole.log('ARTIFACT manifest=out/manifest.json');\nconsole.log('ARTIFACT task_manifest=out/task-manifest.json');\n",
      "utf8",
    );
    await writeFile(path.join(dir, "packet.command"), "node packet-runner.mjs", "utf8");
    await writeFile(path.join(dir, ".packet.env"), "SCORE=7\n", "utf8");
    await prepareAcceptedCandidateFixture(dir, {
      name: "artifact packet",
      metricName: "score",
      direction: "higher",
      benchmarkCommand: "node packet-runner.mjs",
      commandFile: "packet.command",
      commandFileContract: true,
      envFile: ".packet.env",
    });

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "packet.command",
      "--packet-env-file",
      ".packet.env",
    ]);
    assert.equal(packet.code, 0, packet.stderr);
    const payload = JSON.parse(packet.stdout);
    assert.equal(payload.run.parsedPrimary, 7);
    assert.equal(payload.run.artifacts.manifest, "out/manifest.json");
    assert.equal(payload.run.artifacts.task_manifest, "out/task-manifest.json");
    assert.equal(payload.packetEvidence.artifacts[0].exists, true);
    assert.equal(payload.packetEvidence.taskArtifacts.acceptedTasks.length, 1);
    assert.equal(payload.packetEvidence.taskArtifacts.quarantinedTasks.length, 0);
    assert.deepEqual(payload.run.envKeys, ["SCORE"]);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep artifact packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const logPayload = JSON.parse(logged.stdout);
    assert.equal(logPayload.experiment.artifacts.manifest, "out/manifest.json");
    assert.equal(logPayload.experiment.taskArtifacts.acceptedTasks[0].id, "task-1");

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(
      statePayload.evidenceRegistry.currentRuns[0].taskArtifacts.acceptedTasks[0].id,
      "task-1",
    );
  });
});

test("malformed task manifests are quarantined without invalidating primary metrics", async () => {
  await withTempDir("task-manifest-malformed", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC score=1'); console.log('ARTIFACT task_manifest=task-manifest.json')"`;
    await setupFixture(dir, {
      name: "task manifest",
      metricName: "score",
      direction: "higher",
      acceptedContract: true,
      benchmarkCommand: command,
    });
    await writeFile(path.join(dir, "task-manifest.json"), "{not json}\n", "utf8");

    const packet = await runCli(["next", "--cwd", dir]);
    assert.equal(packet.code, 0, packet.stderr);
    const payload = JSON.parse(packet.stdout);
    assert.equal(payload.run.parsedPrimary, 1);
    assert.equal(payload.packetEvidence.metrics.score, 1);
    assert.equal(payload.packetEvidence.taskArtifacts.acceptedTasks.length, 0);
    assert.equal(payload.packetEvidence.taskArtifacts.quarantinedTasks.length, 1);
  });
});

test("symlinked task manifests outside the workdir are quarantined", async (t) => {
  await withTempDir("task-manifest-symlink-outside", async (dir) => {
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outsideDir, { recursive: true });
    try {
      const outsideManifest = path.join(outsideDir, "task-manifest.json");
      await writeFile(
        outsideManifest,
        JSON.stringify({ tasks: [{ id: "outside-secret-task", status: "done" }] }),
        "utf8",
      );
      const linkPath = path.join(dir, "task-manifest.json");
      try {
        await symlink(outsideManifest, linkPath, "file");
      } catch (error) {
        t.skip(`file symlink unavailable on this platform: ${error}`);
        return;
      }

      const command = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC score=1'); console.log('ARTIFACT task_manifest=task-manifest.json')"`;
      await setupFixture(dir, {
        name: "task manifest symlink",
        metricName: "score",
        direction: "higher",
        acceptedContract: true,
        benchmarkCommand: command,
      });

      const packet = await runCli(["next", "--cwd", dir]);
      assert.equal(packet.code, 0, packet.stderr);
      const payload = JSON.parse(packet.stdout);
      const taskArtifacts = payload.packetEvidence.taskArtifacts;
      assert.equal(taskArtifacts.acceptedTasks.length, 0);
      assert.equal(taskArtifacts.quarantinedTasks.length, 1);
      assert.match(taskArtifacts.warnings.join("\n"), /outside_workdir_realpath|escapes/i);
      assert.doesNotMatch(JSON.stringify(taskArtifacts), /outside-secret-task/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("external catalog recipes require trust and record provenance", async () => {
  await withTempDir("catalog-trust", async (dir) => {
    const catalogPath = path.join(dir, "recipes.json");
    const catalog = {
      recipes: [
        {
          id: "external-speed",
          title: "External speed",
          metricName: "seconds",
          metricUnit: "s",
          direction: "lower",
          benchmarkCommand: `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
          benchmarkPrintsMetric: true,
          checksCommand: contractChecksCommand,
          scope: ["src"],
        },
      ],
    };
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");

    const blocked = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--recipe",
      "external-speed",
      "--catalog",
      catalogPath,
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /trust-catalog|External catalog recipe/);

    const trusted = await runCli([
      "setup",
      "--cwd",
      dir,
      "--recipe",
      "external-speed",
      "--catalog",
      catalogPath,
      "--trust-catalog",
      "--commit-paths",
      "src",
      "--max-iterations",
      "6",
      "--packet-budget",
      "6",
    ]);
    assert.equal(trusted.code, 0, trusted.stderr);
    const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
    assert.equal(config.recipeId, "external-speed");
    assert.equal(config.recipeCatalogProvenance.recipeId, "external-speed");
    assert.equal(config.recipeCatalogProvenance.source, "recipes.json");
    assert.match(config.recipeCatalogProvenance.recipeHash, /^[a-f0-9]{64}$/);

    const plan = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--recipe",
      "external-speed",
      "--catalog",
      catalogPath,
      "--trust-catalog",
    ]);
    assert.equal(plan.code, 0, plan.stderr);
    const planPayload = JSON.parse(plan.stdout);
    assert.equal(planPayload.recommendedRecipe.id, "external-speed");
    assert.match(planPayload.nextCommand, /--catalog/);
    assert.match(planPayload.nextCommand, /--trust-catalog/);

    await mkdir(path.join(dir, "src"), { recursive: true });
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept the trusted external recipe contract",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);

    catalog.recipes[0].benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=2')"`;
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");
    const doctor = await runCli(["doctor", "--cwd", dir, "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.catalogTrust.skipped, true);
    assert.equal(
      doctorPayload.issues.some((issue) => /Trusted catalog recipe changed/.test(issue)),
      false,
    );

    const revalidatedDoctor = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--revalidate-catalog",
      "--json-full",
    ]);
    assert.equal(revalidatedDoctor.code, 0, revalidatedDoctor.stderr);
    const revalidatedPayload = JSON.parse(revalidatedDoctor.stdout);
    assert.equal(revalidatedPayload.ok, false);
    assert.match(revalidatedPayload.issues.join("\n"), /Trusted catalog recipe changed/);

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.doctor.catalogTrust.skipped, true);
  });
});

test("doctor skips remote catalog requests unless revalidation is explicit", async () => {
  await withTempDir("catalog-doctor-opt-in", async (dir) => {
    await setupFixture(dir, { name: "catalog doctor" });
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      `${JSON.stringify(
        {
          recipeCatalogProvenance: {
            source: "https://127.0.0.1:9/recipes.json",
            recipeId: "private",
            recipeHash: "0".repeat(64),
            catalogHash: "0".repeat(64),
          },
        },
        null,
        2,
      )}\n`,
    );

    const defaultDoctor = await runCli(["doctor", "--cwd", dir, "--json-full"]);
    assert.equal(defaultDoctor.code, 0, defaultDoctor.stderr);
    assert.equal(JSON.parse(defaultDoctor.stdout).catalogTrust.skipped, true);

    const revalidated = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--revalidate-catalog",
      "--json-full",
    ]);
    assert.equal(revalidated.code, 0, revalidated.stderr);
    const payload = JSON.parse(revalidated.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.issues.join("\n"), /public addresses/);
  });
});

test("external ARTIFACT paths are quarantined instead of stored as usable paths", async () => {
  await withTempDir("external-artifact", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} packet-runner.mjs`;
    const outside = path.join(path.dirname(dir), "outside-manifest.json");
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      [
        "console.log('METRIC score=7');",
        `console.log('ARTIFACT manifest=${outside.replace(/\\/g, "\\\\")}');`,
      ].join("\n"),
      "utf8",
    );
    await setupFixture(dir, {
      name: "external artifact packet",
      metricName: "score",
      direction: "higher",
      acceptedContract: true,
      benchmarkCommand: command,
    });

    const packet = await runCli(["next", "--cwd", dir]);
    assert.equal(packet.code, 0, packet.stderr);
    const payload = JSON.parse(packet.stdout);
    assert.equal(payload.run.artifacts.manifest, "<outside-workdir>");
    assert.equal(payload.packetEvidence.artifacts[0].exists, false);
    assert.equal(payload.packetEvidence.artifacts[0].quarantined, true);
    assert.match(payload.packetEvidence.artifactWarnings.join("\n"), /quarantined/);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Keep external artifact evidence",
    ]);
    assert.notEqual(logged.code, 0);
    assert.match(logged.stderr, /outside the approved artifact root|quarantined/i);
    await access(path.join(dir, "autoresearch.last-run.json"));
    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.evidenceRegistry.currentArtifacts.length, 0);
  });
});

test("ARTIFACT paths through linked directories outside the workdir are quarantined", async (t) => {
  await withTempDir("linked-external-artifact", async (dir) => {
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outsideDir, { recursive: true });
    try {
      await writeFile(path.join(outsideDir, "manifest.json"), '{"secret":true}\n', "utf8");
      const linkPath = path.join(dir, "linked-out");
      try {
        await symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        t.skip(
          `directory symlink creation unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return;
      }

      const command = `${quoteForAcceptedShell(process.execPath)} packet-runner.mjs`;
      await writeFile(
        path.join(dir, "packet-runner.mjs"),
        [
          "console.log('METRIC score=7');",
          "console.log('ARTIFACT manifest=linked-out/manifest.json');",
        ].join("\n"),
        "utf8",
      );
      await setupFixture(dir, {
        name: "linked external artifact",
        metricName: "score",
        direction: "higher",
        acceptedContract: true,
        benchmarkCommand: command,
      });

      const packet = await runCli(["next", "--cwd", dir]);
      assert.equal(packet.code, 0, packet.stderr);
      const payload = JSON.parse(packet.stdout);
      assert.equal(payload.run.artifacts.manifest, "<outside-workdir>");
      assert.equal(payload.packetEvidence.artifacts[0].exists, false);
      assert.equal(payload.packetEvidence.artifacts[0].quarantined, true);
      assert.match(payload.packetEvidence.artifactWarnings.join("\n"), /quarantined/);
      assert.doesNotMatch(JSON.stringify(payload.packetEvidence), /secret/);

      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--from-last",
        "--status",
        "measure",
        "--description",
        "Keep linked external artifact evidence",
      ]);
      assert.notEqual(logged.code, 0);
      assert.match(logged.stderr, /outside the approved artifact root|quarantined/i);
      await access(path.join(dir, "autoresearch.last-run.json"));
      const state = await runCli(["state", "--cwd", dir, "--json-full"]);
      assert.equal(state.code, 0, state.stderr);
      const statePayload = JSON.parse(state.stdout);
      assert.equal(statePayload.evidenceRegistry.currentArtifacts.length, 0);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("accepted logged artifacts become current evidence in state registry", async () => {
  await withTempDir("accepted-artifact-registry", async (dir) => {
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(path.join(dir, "out", "manifest.json"), '{"ok":true}\n', "utf8");
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      "console.log('METRIC score=7');\nconsole.log('ARTIFACT manifest=out/manifest.json');\n",
      "utf8",
    );
    await prepareAcceptedCandidateFixture(dir, {
      name: "accepted artifact registry",
      metricName: "score",
      direction: "higher",
      benchmarkCommand: `${quoteForAcceptedShell(process.execPath)} packet-runner.mjs`,
    });

    const packet = await runCli(["next", "--cwd", dir]);
    assert.equal(packet.code, 0, packet.stderr);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep accepted artifact evidence",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.evidenceRegistry.currentArtifacts.length, 1);
    assert.equal(statePayload.evidenceRegistry.currentArtifacts[0].name, "manifest");
    assert.equal(statePayload.evidenceRegistry.currentArtifacts[0].evidenceStatus, "accepted");
    assert.equal(statePayload.evidenceRegistry.counts.accepted, 2);
  });
});

test("last-run packet storage redacts raw benchmark evidence and still logs from last", async () => {
  await withTempDir("last-run-redaction", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} runner.mjs`;
    await writeFile(
      path.join(dir, "runner.mjs"),
      [
        "console.log('METRIC seconds=1');",
        "console.log('api_key=abcdefghijklmnop');",
        "console.log('Bearer zyxwvutsrqponmlkjihgfedcba');",
      ].join("\n"),
      "utf8",
    );
    await setupFixture(dir, {
      name: "redacted packet",
      acceptedContract: true,
      benchmarkCommand: command,
    });

    const packet = await runCli(["next", "--cwd", dir]);
    assert.equal(packet.code, 0, packet.stderr);
    assert.doesNotMatch(packet.stdout, /abcdefghijklmnop/);
    assert.doesNotMatch(packet.stdout, /zyxwvutsrqponmlkjihgfedcba/);
    assert.match(packet.stdout, /api_key=<redacted>/);
    assert.match(packet.stdout, /Bearer <redacted>/);
    const payload = JSON.parse(packet.stdout);
    assert.equal(payload.packetEvidence.stdoutTail.includes("abcdefghijklmnop"), false);
    assert.equal(payload.run.tailOutput.includes("abcdefghijklmnop"), false);
    assert.doesNotMatch(JSON.stringify(payload.run.progressSnapshot), /zyxwvutsrqponmlkjihgfedcba/);

    const lastRunText = await readFile(path.join(dir, "autoresearch.last-run.json"), "utf8");
    assert.doesNotMatch(lastRunText, /abcdefghijklmnop/);
    assert.doesNotMatch(lastRunText, /zyxwvutsrqponmlkjihgfedcba/);
    assert.match(lastRunText, /api_key=<redacted>/);
    assert.match(lastRunText, /Bearer <redacted>/);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Keep redacted packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const loggedPayload = JSON.parse(logged.stdout);
    assert.equal(loggedPayload.experiment.metric, 1);
    assert.equal(loggedPayload.lastRunCleared, true);
  });
});

test("last-run packet storage redacts run benchmark contract command and option-file metadata", async () => {
  await withTempDir("last-run-contract-redaction", async (dir) => {
    const commandSecret = "command-secret-abcdefghijklmnop";
    const checksSecret = "checks-secret-zyxwvutsrqpon";
    const commandFile = path.join(dir, "private-packet.command");
    const envFile = path.join(dir, ".env.private");
    const checksCommand = `${quoteForAcceptedShell(process.execPath)} -e "process.exit(0)" -- --token ${checksSecret}`;
    const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=2')" -- --api-key ${commandSecret}`;
    await writeFile(commandFile, benchmarkCommand, "utf8");
    await writeFile(envFile, "PACKET_TOKEN=env-secret-qwertyuiop\n", "utf8");
    await setupCommandFileContract(dir, {
      name: "redacted contract",
      checksCommand,
      commandFile: "private-packet.command",
      envFile: ".env.private",
    });

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "private-packet.command",
      "--packet-env-file",
      ".env.private",
    ]);
    assert.equal(packet.code, 0, packet.stderr);

    const lastRunText = await readFile(path.join(dir, "autoresearch.last-run.json"), "utf8");
    assert.doesNotMatch(lastRunText, new RegExp(commandSecret));
    assert.doesNotMatch(lastRunText, new RegExp(checksSecret));
    assert.match(lastRunText, /private-packet\.command/);
    assert.doesNotMatch(lastRunText, /\.env\.private/);

    const stored = JSON.parse(lastRunText);
    const contract = stored.run.benchmarkContract;
    assert.match(contract.command, /--api-key <redacted>/);
    assert.match(contract.checksCommand, /--token <redacted>/);
    assert.match(stored.run.acceptedEvaluator.execution.command.script, /--api-key <redacted>/);
    assert.match(stored.run.acceptedChecks[0].execution.command.script, /--token <redacted>/);
    assert.equal(stored.run.acceptedEvaluator.execution.environment.source.path, "<env-file>");
    assert.equal(
      stored.run.acceptedEvaluator.execution.protectedInputs.some(
        (input: Record<string, unknown>) =>
          input.role === "evaluator" && input.path === "private-packet.command",
      ),
      true,
    );
  });
});

test("last-run packet storage does not corrupt common option-file basenames", async () => {
  await withTempDir("last-run-common-basename-redaction", async (dir) => {
    const commandFile = path.join(dir, "run");
    const envFile = path.join(dir, "env");
    const benchmarkCommand = `${quoteForAcceptedShell(process.execPath)} -e "console.log('METRIC seconds=3'); console.log('ordinary run env node packet text')"`;
    await writeFile(commandFile, benchmarkCommand, "utf8");
    await writeFile(envFile, "PACKET_TOKEN=common-name-env-value\n", "utf8");
    await setupCommandFileContract(dir, {
      name: "common basename contract",
      commandFile: "run",
      envFile: "env",
    });

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "run",
      "--packet-env-file",
      "env",
    ]);
    assert.equal(packet.code, 0, packet.stderr);

    const lastRunText = await readFile(path.join(dir, "autoresearch.last-run.json"), "utf8");
    assert.match(lastRunText, /ordinary run env node packet text/);

    const stored = JSON.parse(lastRunText);
    const acceptedExecution = stored.run.acceptedEvaluator.execution;
    assert.equal(
      acceptedExecution.protectedInputs.some(
        (input: Record<string, unknown>) => input.role === "evaluator" && input.path === "run",
      ),
      true,
    );
    assert.equal(acceptedExecution.environment.source.kind, "file");
    assert.equal(acceptedExecution.environment.source.path, "<env-file>");
    assert.match(acceptedExecution.environment.source.contentDigest, /^[a-f0-9]{64}$/);
    assert.equal(stored.run.tailOutput.includes("ordinary run env node packet text"), true);
  });
});

test("next command response redacts raw benchmark evidence", async () => {
  await withTempDir("run-response-redaction", async (dir) => {
    const command = `${quoteForAcceptedShell(process.execPath)} runner.mjs`;
    await writeFile(
      path.join(dir, "runner.mjs"),
      [
        "console.log('METRIC seconds=1');",
        "console.log('api_key=abcdefghijklmnop');",
        "console.log('Bearer zyxwvutsrqponmlkjihgfedcba');",
        "console.log('win_path=C:\\\\Users\\\\alice\\\\secret.txt');",
        "console.log('win_slash=C:/Users/alice/secret.txt');",
        "console.log('posix_path=/home/alice/secret.txt');",
        "console.log('unc_path=\\\\\\\\server\\\\share\\\\secret.txt');",
        "console.log('secret_from_env=' + process.env.SAMPLE_SECRET);",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(dir, "packet.command"), command, "utf8");
    await writeFile(path.join(dir, ".env.secret"), "SAMPLE_SECRET=from-env-secret-value\n", "utf8");
    await setupCommandFileContract(dir, {
      name: "redacted run",
      commandFile: "packet.command",
      envFile: ".env.secret",
    });

    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "packet.command",
      "--packet-env-file",
      ".env.secret",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /abcdefghijklmnop/);
    assert.doesNotMatch(result.stdout, /zyxwvutsrqponmlkjihgfedcba/);
    assert.doesNotMatch(result.stdout, /from-env-secret-value/);
    assert.doesNotMatch(result.stdout, /C:\\\\Users\\\\alice/);
    assert.doesNotMatch(result.stdout, /C:\/Users\/alice/);
    assert.doesNotMatch(result.stdout, /\/home\/alice/);
    assert.doesNotMatch(result.stdout, /server\\\\share/);
    assert.match(result.stdout, /api_key=<redacted>/);
    assert.match(result.stdout, /Bearer <redacted>/);
    assert.match(result.stdout, /secret_from_env=<redacted>/);
    assert.match(result.stdout, /<network-path>/);
    const payload = JSON.parse(result.stdout).run;
    assert.equal(payload.acceptedEvaluator.execution.environment.source.path, "<env-file>");
    assert.equal(payload.tailOutput.includes("abcdefghijklmnop"), false);
    assert.doesNotMatch(JSON.stringify(payload.progressSnapshot), /zyxwvutsrqponmlkjihgfedcba/);
  });
});

test("command and env files are included in benchmark contract drift", async () => {
  await withTempDir("command-env-contract-drift", async (dir) => {
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      "console.log(`METRIC score=${process.env.SCORE}`);\n",
      "utf8",
    );
    await writeFile(path.join(dir, "packet.command"), "node packet-runner.mjs", "utf8");
    await writeFile(path.join(dir, ".packet.env"), "SCORE=7\n", "utf8");
    await setupCommandFileContract(dir, {
      name: "contract files",
      metricName: "score",
      direction: "higher",
      commandFile: "packet.command",
      envFile: ".packet.env",
    });

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "packet.command",
      "--packet-env-file",
      ".packet.env",
    ]);
    assert.equal(packet.code, 0, packet.stderr);
    assert.equal(JSON.parse(packet.stdout).run.parsedPrimary, 7);

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Keep first packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    await writeFile(path.join(dir, ".packet.env"), "SCORE=8\n", "utf8");
    const blocked = await runCli([
      "next",
      "--cwd",
      dir,
      "--command-file",
      "packet.command",
      "--packet-env-file",
      ".packet.env",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(
      blocked.stderr,
      /accepted execution environment digest|environment-file contents changed/i,
    );
  });
});

test("packet env defaults to minimal and is part of benchmark contract and doctor recheck", async () => {
  await withTempDir("packet-env-mode-contract", async (dir) => {
    const scriptPath = path.join(dir, "env-mode-runner.mjs");
    await writeFile(
      scriptPath,
      [
        "const inherited = process.env.AUTORESEARCH_ENV_MODE_REVIEW === 'parent';",
        "console.log(`METRIC score=${inherited ? 2 : 1}`);",
        "",
      ].join("\n"),
      "utf8",
    );
    const command = `${quoteForAcceptedShell(process.execPath)} ${quoteForAcceptedShell(scriptPath)}`;
    await setupFixture(dir, {
      name: "env mode contract",
      metricName: "score",
      direction: "higher",
      acceptedContract: true,
      benchmarkCommand: command,
    });
    const previous = process.env.AUTORESEARCH_ENV_MODE_REVIEW;
    process.env.AUTORESEARCH_ENV_MODE_REVIEW = "parent";
    try {
      const packet = await runCli(["next", "--cwd", dir, "--checks-policy", "manual"]);
      assert.equal(packet.code, 0, packet.stderr);
      assert.equal(JSON.parse(packet.stdout).run.parsedPrimary, 1);

      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--from-last",
        "--status",
        "measure",
        "--description",
        "Keep minimal env packet",
      ]);
      assert.equal(logged.code, 0, logged.stderr);
      const loggedPayload = JSON.parse(logged.stdout);
      assert.equal(loggedPayload.experiment.benchmarkContract.packetEnvMode, "minimal");

      const doctor = await runCli(["doctor", "--cwd", dir, "--check-benchmark", "--json-full"]);
      assert.equal(doctor.code, 0, doctor.stderr);
      const doctorPayload = JSON.parse(doctor.stdout);
      assert.equal(doctorPayload.benchmark.packetEnvMode, "minimal");
      assert.equal(doctorPayload.benchmark.parsedMetrics.score, 1);

      const inheritedDoctor = await runCli([
        "doctor",
        "--cwd",
        dir,
        "--check-benchmark",
        "--packet-env-mode",
        "inherit",
        "--json-full",
      ]);
      assert.equal(inheritedDoctor.code, 0, inheritedDoctor.stderr);
      const inheritedDoctorPayload = JSON.parse(inheritedDoctor.stdout);
      assert.equal(inheritedDoctorPayload.ok, false);
      assert.equal(inheritedDoctorPayload.benchmark.packetEnvMode, null);
      assert.deepEqual(inheritedDoctorPayload.benchmark.parsedMetrics, {});
      assert.match(
        `${inheritedDoctorPayload.benchmark.metricError}\n${inheritedDoctorPayload.issues.join("\n")}`,
        /accepted.*experiment contract|start a new segment/i,
      );
    } finally {
      if (previous == null) delete process.env.AUTORESEARCH_ENV_MODE_REVIEW;
      else process.env.AUTORESEARCH_ENV_MODE_REVIEW = previous;
    }
  });
});

test("working directories outside cwd require per-command authorization", async () => {
  await withTempDir("outside-working-directory", async (root) => {
    const session = path.join(root, "session");
    const target = path.join(root, "target");
    await mkdir(session, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(
      path.join(session, "autoresearch.config.json"),
      `${JSON.stringify({ workingDir: "../target" }, null, 2)}\n`,
    );

    const blocked = await runCli(["state", "--cwd", session, "--json-full"]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /--allow-outside-workdir/);

    const initialized = await runCli([
      "setup",
      "--cwd",
      session,
      "--allow-outside-workdir",
      "--name",
      "external target",
      "--metric-name",
      "seconds",
    ]);
    assert.equal(initialized.code, 0, initialized.stderr);
    await access(path.join(target, "autoresearch.jsonl"));
  });
});

test("state separates development best from promotion-grade best", async () => {
  await withTempDir("promotion-tracks", async (dir) => {
    await setupFixture(dir, {
      name: "promotion",
      metricName: "score",
      direction: "higher",
      acceptedContract: true,
    });
    await appendLegacyLedgerRows(dir, [
      {
        run: 1,
        metric: 0.6,
        metrics: { promotionGrade: 0 },
        status: "keep",
        description: "score 0.6",
      },
      {
        run: 2,
        metric: 0.8,
        metrics: { promotionGrade: 1 },
        status: "keep",
        description: "score 0.8",
      },
      {
        run: 3,
        metric: 0.9,
        metrics: { promotionGrade: 0 },
        status: "keep",
        description: "score 0.9",
      },
    ]);
    const state = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.best, 0.9);
    assert.equal(payload.development.best, 0.9);
    assert.equal(payload.promotion.best, 0.8);
    assert.equal(payload.promotion.kept, 1);
  });
});
