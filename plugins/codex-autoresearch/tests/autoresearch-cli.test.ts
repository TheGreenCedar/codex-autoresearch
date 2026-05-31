import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "./helpers/sharded-test.js";
import { JSDOM } from "jsdom";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import { PLUGIN_VERSION } from "../lib/plugin-version.js";
import {
  createCliRunner,
  quoteForShell,
  runGit,
  withTempDir as withNamedTempDir,
} from "./helpers/process.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");
const runCli = createCliRunner(cli, pluginRoot);
const withTempDir = (name, fn) => withNamedTempDir("autoresearch", name, fn);

const git = async (cwd, args) => {
  return await runGit(cwd, args);
};

async function renderExportedDashboard(html) {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "dangerously",
    url: "file:///autoresearch-dashboard.html",
  });
  const started = Date.now();
  while (!dom.window.__AUTORESEARCH_DASHBOARD_READY__) {
    if (Date.now() - started > 2000)
      throw new Error("Dashboard React app did not finish rendering.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return dom;
}

test("run reports missing primary metric as a failed experiment", async () => {
  await withTempDir("missing-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "missing metric", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('no metric here')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.parsedPrimary, null);
    assert.match(payload.metricError, /seconds/);
    assert.equal(payload.logHint.status, "crash");
    assert.deepEqual(payload.logHint.allowedStatuses, ["crash"]);
  });
});

test("partial-results records diagnostic measure evidence from a failed packet artifact", async () => {
  await withTempDir("partial-results-record", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "partial salvage", "--metric-name", "seconds"]);
    const script = path.join(dir, "partial-packet.mjs");
    await writeFile(
      script,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('out', { recursive: true });",
        "writeFileSync('out/rows.json', JSON.stringify({ schemaVersion: 1, metricName: 'seconds', formulaVersion: 'v1', rows: [{ seconds: 4.2, rawBody: 'must not persist' }] }));",
        "console.log('ARTIFACT rows=out/rows.json');",
        "process.exit(1);",
      ].join("\n"),
    );

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
    ]);
    assert.equal(packet.code, 0, packet.stderr);
    const packetPayload = JSON.parse(packet.stdout);

    const list = await runCli(["partial-results", "--cwd", dir, "--from-last"]);
    assert.equal(list.code, 0, list.stderr);
    const listPayload = JSON.parse(list.stdout);
    assert.equal(listPayload.candidates.length, 1);
    assert.equal(listPayload.candidates[0].status, "scored");
    assert.equal(listPayload.candidates[0].metricValue, 4.2);
    assert.equal(JSON.stringify(listPayload).includes("must not persist"), false);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.canonicalNextAction.kind, "partial-salvage");
    assert.equal(statePayload.nextAction, statePayload.canonicalNextAction.reason);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.action.kind, "partial-salvage");
    assert.equal(recommendPayload.nextAction, statePayload.canonicalNextAction.reason);
    assert.equal(
      recommendPayload.decisionEnvelope.canonicalNextAction.kind,
      statePayload.canonicalNextAction.kind,
    );

    const record = await runCli([
      "partial-results",
      "--cwd",
      dir,
      "--record",
      listPayload.candidates[0].id,
    ]);
    assert.equal(record.code, 0, record.stderr);
    const recordPayload = JSON.parse(record.stdout);
    assert.equal(recordPayload.experiment.status, "measure");
    assert.equal(recordPayload.experiment.metricEligible, false);
    assert.equal(recordPayload.experiment.partialResult.validationStatus, "scored");
    assert.equal(recordPayload.evidenceClaim.promotionRelevance, "diagnostic");

    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.match(ledger, /"status":"measure"/);
    assert.match(ledger, /"partialResult"/);
    await assert.rejects(access(packetPayload.lastRunPath));
    const evidenceIndex = await readFile(
      path.join(dir, "autoresearch.research", "partial-results", "evidence-index.json"),
      "utf8",
    );
    assert.match(evidenceIndex, /benchmark-artifact/);
  });
});

test("state surfaces active runner progress while next is still executing", async () => {
  await withTempDir("active-progress", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "active progress", "--metric-name", "seconds"]);
    const script = path.join(dir, "slow-packet.mjs");
    await writeFile(
      script,
      ["setTimeout(() => {", "  console.log('METRIC seconds=1');", "}, 1500);"].join("\n"),
    );

    const child = spawn(process.execPath, [
      cli,
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    let progress = null;
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const state = await runCli(["state", "--cwd", dir, "--compact"]);
      assert.equal(state.code, 0, state.stderr);
      const payload = JSON.parse(state.stdout);
      progress = payload.experimentEconomics?.progress || null;
      if (progress?.exitState === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(progress?.exitState, "running");
    assert.match(progress?.packetId || "", /active/);

    const exitCode = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(exitCode, 0, stderr);
    const packetPayload = JSON.parse(stdout);
    assert.equal(packetPayload.packetEvidence.progressSnapshot.exitState, "completed");
  });
});

test("research-setup creates a quality_gap scratchpad and benchmark", async () => {
  await withTempDir("research-setup", async (dir) => {
    const result = await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "Project Study",
      "--goal",
      "Study the project before improving it",
      "--max-iterations",
      "7",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.slug, "project-study");
    assert.equal(payload.init.config.metricName, "quality_gap");
    assert.equal(payload.init.config.bestDirection, "lower");
    assert.equal(payload.qualityGap.open, 6);

    const researchRoot = path.join(dir, "autoresearch.research", "project-study");
    assert.match(await readFile(path.join(researchRoot, "brief.md"), "utf8"), /Study the project/);
    assert.match(await readFile(path.join(researchRoot, "sources.md"), "utf8"), /Claim Supported/);
    assert.match(
      await readFile(path.join(researchRoot, "synthesis.md"), "utf8"),
      /Quality-Gap Translation/,
    );
    assert.match(await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8"), /- \[ \]/);

    const scriptName = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
    const benchmark = await readFile(path.join(dir, scriptName), "utf8");
    assert.match(benchmark, /quality-gap/);
    assert.match(benchmark, /project-study/);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).config.metricName, "quality_gap");

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const exportPayload = JSON.parse(exportResult.stdout);
    assert.match(exportPayload.modeGuidance.difference, /read-only fallback snapshot/);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.match(dashboard, /"deliveryMode":"static-export"/);
    assert.match(dashboard, /Read-only snapshot/);
    assert.doesNotMatch(dashboard, /Serve dashboard/);
    assert.doesNotMatch(dashboard, /--research-slug \\"project-study\\"/);
    assert.match(dashboard, /activeResearchSlug/);
  });
});

test("quality-gap counts checked and unchecked research gaps", async () => {
  await withTempDir("quality-gap", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "study",
      "--goal",
      "Study quality gaps",
    ]);
    await writeFile(
      path.join(dir, "autoresearch.research", "study", "quality-gaps.md"),
      [
        "# Quality Gaps",
        "",
        "- [ ] Open gap",
        "- [x] Closed gap",
        "- [X] Rejected with evidence",
        "- [ ] Another open gap",
        "- plain note",
        "",
      ].join("\n"),
    );

    const result = await runCli(["quality-gap", "--cwd", dir, "--research-slug", "study"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /METRIC quality_gap=2/);
    assert.match(result.stdout, /METRIC quality_total=4/);
    assert.match(result.stdout, /METRIC quality_closed=2/);

    const listed = await runCli([
      "quality-gap",
      "--cwd",
      dir,
      "--research-slug",
      "study",
      "--list",
    ]);
    assert.equal(listed.code, 0, listed.stderr);
    const listedPayload = JSON.parse(listed.stdout);
    assert.deepEqual(listedPayload.openItems, ["Open gap", "Another open gap"]);
    assert.deepEqual(listedPayload.closedItems, ["Closed gap", "Rejected with evidence"]);
  });
});

test("session-forensics supports dry-run and safe apply capsule writes", async () => {
  await withTempDir("session-forensics-cli", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-25T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Segments UX is not the best." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "git status --short" }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call1",
            output:
              "Chunk ID: abc\nProcess exited with code 0\nOriginal token count: 25000\nTotal output lines: 600\nOutput:\ntoken=abcdefghijklmnop",
          },
        }),
      ].join("\n"),
    );

    const dryRun = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--dry-run",
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.ok, true);
    assert.equal(dryPayload.dryRun, true);
    assert.equal(dryPayload.wrote, false);
    assert.equal(dryPayload.plannedFiles.length, 4);
    await assert.rejects(() =>
      access(path.join(dir, "autoresearch.research", "session-019e", "session-digest.md")),
    );

    const applied = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--apply",
    ]);
    assert.equal(applied.code, 0, applied.stderr);
    const applyPayload = JSON.parse(applied.stdout);
    assert.equal(applyPayload.wrote, true);
    assert.equal(applyPayload.evidenceClaims > 0, true);

    const researchRoot = path.join(dir, "autoresearch.research", "session-019e");
    const digest = await readFile(path.join(researchRoot, "session-digest.md"), "utf8");
    const gaps = await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8");
    const evidence = JSON.parse(
      await readFile(path.join(researchRoot, "evidence-index.json"), "utf8"),
    );
    assert.match(digest, /Session Forensics Import/);
    assert.match(gaps, /\[evidence:ev-/);
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(JSON.stringify(evidence).includes("abcdefghijklmnop"), false);

    const reapplied = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--apply",
    ]);
    assert.equal(reapplied.code, 0, reapplied.stderr);
    const evidenceAfter = JSON.parse(
      await readFile(path.join(researchRoot, "evidence-index.json"), "utf8"),
    );
    const claimIds = new Set(
      (evidenceAfter.claims || []).map((claim: { id?: string }) => claim.id).filter(Boolean),
    );
    const gapsAfter = await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8");
    const referencedIds = [...gapsAfter.matchAll(/\[evidence:(ev-[^\]]+)\]/g)].map(
      (match) => match[1],
    );
    assert.equal(referencedIds.length > 0, true);
    for (const evidenceId of referencedIds) {
      assert.equal(claimIds.has(evidenceId), true, evidenceId);
    }
    assert.equal((evidenceAfter.claims || []).length >= (evidence.claims || []).length, true);
  });
});

test("run returns explicit keep/discard decision options instead of a fake status", async () => {
  await withTempDir("decision-hint", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "decision hint", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1.25')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.logHint.status, null);
    assert.equal(payload.logHint.needsDecision, true);
    assert.deepEqual(payload.logHint.allowedStatuses, ["keep", "discard", "measure"]);
  });
});

test("state and dashboard math keep zero-valued metrics visible", async () => {
  await withTempDir("zero-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "zero metric", "--metric-name", "failures"]);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0",
      "--status",
      "keep",
      "--description",
      "Reach zero failures",
    ]);
    assert.equal(log.code, 0, log.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, 0);
    assert.equal(payload.best, 0);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assert.match(dashboard, /Reach zero failures/);
  });
});

test("log accepts metrics from a JSON file for PowerShell-safe logging", async () => {
  await withTempDir("metrics-file", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "metrics file", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "metrics.json"),
      JSON.stringify(
        {
          promotionGrade: true,
          queryCount: 12,
          evidenceLabel: 'holdout "quoted" path',
          windowsPath: "C:\\tmp\\artifact.json",
        },
        null,
        2,
      ),
      "utf8",
    );

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "File-backed metrics",
      "--metrics-file",
      "metrics.json",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);

    assert.equal(payload.experiment.metrics.promotionGrade, true);
    assert.equal(payload.experiment.metrics.queryCount, 12);
    assert.equal(payload.experiment.metrics.evidenceLabel, 'holdout "quoted" path');
    assert.equal(payload.experiment.metrics.windowsPath, "C:\\tmp\\artifact.json");
    assert.equal(payload.experiment.evidenceStatus, "accepted");
    assert.equal(payload.experiment.promotion.label, "promotion_eligible");
  });
});

test("state supports negative metrics when lower is better", async () => {
  await withTempDir("negative-metric", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "negative metric",
      "--metric-name",
      "delta",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline positive delta",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "-2",
      "--status",
      "keep",
      "--description",
      "Beat baseline below zero",
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, 1);
    assert.equal(payload.best, -2);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const chart = dom.window.document.getElementById("trend-chart").innerHTML;
    assert.match(chart, /#1 1 keep/);
    assert.match(chart, /#2 -2 keep/);
    assert.doesNotMatch(chart, /Infinity|NaN/);
    assert.equal(dom.window.document.getElementById("improvement-value").textContent, "+300.0%");
    dom.window.close();
  });
});

test("state reports corrupt JSONL with the ledger path", async () => {
  await withTempDir("state-corrupt-jsonl", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({ type: "config", name: "corrupt state", metricName: "seconds" }),
        "{ not valid json",
      ].join("\n") + "\n",
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.notEqual(state.code, 0);
    assert.match(state.stderr, /autoresearch\.jsonl/);
    assert.match(state.stderr, /line 2/);
  });
});

test("discarded metrics do not become best or suppress on-improvement checks", async () => {
  await withTempDir("discarded-best", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "discarded best",
      "--metric-name",
      "seconds",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "discard",
      "--description",
      "Faster but rejected",
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).best, 10);

    const checksFile =
      process.platform === "win32" ? "autoresearch.checks.ps1" : "autoresearch.checks.sh";
    const checksBody = process.platform === "win32" ? "exit 1\n" : "#!/bin/sh\nexit 1\n";
    await writeFile(path.join(dir, checksFile), checksBody, "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=7')"`;
    const result = await runCli([
      "run",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "on-improvement",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.improvesPrimary, true);
    assert.equal(payload.checks?.passed, false);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.logHint.allowedStatuses, ["checks_failed"]);
  });
});

test("next supports command-file, env-file, and ARTIFACT output contracts", async () => {
  await withTempDir("command-env-artifact", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "artifact packet",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(path.join(dir, "out", "manifest.json"), '{"ok":true}\n', "utf8");
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      "console.log(`METRIC score=${process.env.SCORE}`);\nconsole.log('ARTIFACT manifest=out/manifest.json');\n",
      "utf8",
    );
    await writeFile(path.join(dir, "packet.command"), "node packet-runner.mjs\n", "utf8");
    await writeFile(path.join(dir, ".packet.env"), "SCORE=7\n", "utf8");

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
    assert.equal(payload.packetEvidence.artifacts[0].exists, true);
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
    assert.equal(JSON.parse(logged.stdout).experiment.artifacts.manifest, "out/manifest.json");
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
          benchmarkCommand: `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
          benchmarkPrintsMetric: true,
          checksCommand: "",
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
      "--skip-init",
    ]);
    assert.equal(trusted.code, 0, trusted.stderr);
    const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
    assert.equal(config.recipeId, "external-speed");
    assert.equal(config.recipeCatalogProvenance.recipeId, "external-speed");
    assert.equal(config.recipeCatalogProvenance.source, "recipes.json");
    assert.match(config.recipeCatalogProvenance.recipeHash, /^[a-f0-9]{64}$/);

    const promptPlan = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Optimize the external speed recipe.",
      "--recipe",
      "external-speed",
      "--catalog",
      catalogPath,
      "--trust-catalog",
    ]);
    assert.equal(promptPlan.code, 0, promptPlan.stderr);
    const promptPayload = JSON.parse(promptPlan.stdout);
    assert.equal(promptPayload.setup.recommendedRecipe.id, "external-speed");
    assert.match(promptPayload.setup.nextCommand, /--catalog/);
    assert.match(promptPayload.setup.nextCommand, /--trust-catalog/);

    catalog.recipes[0].benchmarkCommand = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=2')"`;
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");
    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, false);
    assert.match(doctorPayload.issues.join("\n"), /Trusted catalog recipe changed/);

    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.ok, false);
    assert.match(nextPayload.doctor.issues.join("\n"), /Trusted catalog recipe changed/);
  });
});

test("external ARTIFACT paths are quarantined instead of stored as usable paths", async () => {
  await withTempDir("external-artifact", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "external artifact packet",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    const outside = path.join(path.dirname(dir), "outside-manifest.json");
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      [
        "console.log('METRIC score=7');",
        `console.log('ARTIFACT manifest=${outside.replace(/\\/g, "\\\\")}');`,
      ].join("\n"),
      "utf8",
    );

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} packet-runner.mjs`,
    ]);
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
      "keep",
      "--description",
      "Keep external artifact evidence",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    assert.equal(JSON.parse(logged.stdout).experiment.artifacts.manifest, "<outside-workdir>");
    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.evidenceRegistry.currentArtifacts.length, 0);
    assert.equal(statePayload.evidenceRegistry.counts.rejected, 1);
  });
});

test("accepted logged artifacts become current evidence in state registry", async () => {
  await withTempDir("accepted-artifact-registry", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "accepted artifact registry",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(path.join(dir, "out", "manifest.json"), '{"ok":true}\n', "utf8");
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      "console.log('METRIC score=7');\nconsole.log('ARTIFACT manifest=out/manifest.json');\n",
      "utf8",
    );

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} packet-runner.mjs`,
    ]);
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

    const state = await runCli(["state", "--cwd", dir]);
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
    await runCli(["init", "--cwd", dir, "--name", "redacted packet", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "runner.mjs"),
      [
        "console.log('METRIC seconds=1');",
        "console.log('api_key=abcdefghijklmnop');",
        "console.log('Bearer zyxwvutsrqponmlkjihgfedcba');",
      ].join("\n"),
      "utf8",
    );

    const packet = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} runner.mjs`,
    ]);
    assert.equal(packet.code, 0, packet.stderr);
    const payload = JSON.parse(packet.stdout);
    assert.equal(payload.packetEvidence.stdoutTail.includes("abcdefghijklmnop"), false);

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
      "keep",
      "--description",
      "Keep redacted packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const loggedPayload = JSON.parse(logged.stdout);
    assert.equal(loggedPayload.experiment.metric, 1);
    assert.equal(loggedPayload.lastRunCleared, true);
  });
});

test("command and env files are included in benchmark contract drift", async () => {
  await withTempDir("command-env-contract-drift", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "contract files",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await writeFile(
      path.join(dir, "packet-runner.mjs"),
      "console.log(`METRIC score=${process.env.SCORE}`);\n",
      "utf8",
    );
    await writeFile(path.join(dir, "packet.command"), "node packet-runner.mjs\n", "utf8");
    await writeFile(path.join(dir, ".packet.env"), "SCORE=7\n", "utf8");

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
      "keep",
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
    assert.equal(blocked.code, 0, blocked.stderr);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.doctor.issues.join("\n"), /contract changed/i);
  });
});

test("state separates development best from promotion-grade best", async () => {
  await withTempDir("promotion-tracks", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "promotion",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    for (const [metric, promotionGrade] of [
      [0.6, 0],
      [0.8, 1],
      [0.9, 0],
    ]) {
      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--metric",
        String(metric),
        "--status",
        "keep",
        "--description",
        `score ${metric}`,
        "--metrics",
        JSON.stringify({ promotionGrade }),
      ]);
      assert.equal(logged.code, 0, logged.stderr);
    }
    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.best, 0.9);
    assert.equal(payload.development.best, 0.9);
    assert.equal(payload.promotion.best, 0.8);
    assert.equal(payload.promotion.kept, 1);
  });
});

test("research-fanout records generic parallel lanes without creating a bespoke metric", async () => {
  await withTempDir("research-fanout", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "fanout", "--metric-name", "quality_gap"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "measure",
      "--description",
      "Baseline measurement",
      "--asi",
      JSON.stringify({
        hypothesis: "Measure current research gaps",
        lane: "benchmark-contract",
        next_action_hint: "Scout benchmark validity before editing.",
      }),
    ]);

    const fanout = await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);
    assert.equal(fanout.code, 0, fanout.stderr);
    const plan = JSON.parse(fanout.stdout);
    assert.equal(plan.ok, true);
    assert.equal(plan.dryRun, false);
    assert.ok(plan.parallelLanes.length >= 4);
    assert.ok(plan.parallelLanes.length <= 6);
    assert.match(plan.fanoutPlan.metric.contract, /configured benchmark METRIC output/);
    assert.equal(plan.parallelLanes[0].evidenceStatus, "provisional");

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.ok(payload.parallelLanes.length > 0);
    assert.equal(payload.fanoutPlan.status, "planned");
    assert.equal(payload.metric, "quality_gap");

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const exportPayload = JSON.parse(exportResult.stdout);
    assert.ok(exportPayload.viewModel.parallelLanes.length > 0);
    assert.equal(exportPayload.viewModel.fanoutPlan.status, "planned");
    assert.equal(exportPayload.viewModel.evidenceLedger.counts.provisional, 1);
  });
});

test("lane-runner allows read-only lanes without worktree isolation", async () => {
  await withTempDir("lane-runner-read-only", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--summary",
      "Scout found one benchmark-contract hypothesis.",
      "--recommendation",
      "Run one benchmark-contract packet next.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.lane.mode, "read_only_scout");
    assert.equal(payload.result.status, "completed");
    assert.equal(payload.result.evidenceAccepted, true);
    assert.equal(payload.result.isolation.worktree, "");
    assert.deepEqual(payload.result.isolation.writeScope, []);

    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.match(ledger, /"type":"lane_result"/);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    const lane = statePayload.parallelLanes.find((item) => item.id === "read-only-scout");
    assert.equal(lane.status, "completed");
    assert.equal(lane.evidenceStatus, "accepted");
  });
});

test("empty lane-runner records are planned breadcrumbs, not watchdog progress", async () => {
  await withTempDir("lane-runner-empty-planned", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "lane watchdog",
      "--metric-name",
      "quality_gap",
      "--max-iterations",
      "100",
    ]);
    const oldTimestamp = Date.now() - 10 * 60 * 60 * 1000;
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "lane watchdog",
          metricName: "quality_gap",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          metric: 4,
          status: "measure",
          description: "Old baseline.",
          timestamp: oldTimestamp,
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const emptyResult = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--yes",
    ]);
    assert.equal(emptyResult.code, 0, emptyResult.stderr);
    const emptyPayload = JSON.parse(emptyResult.stdout);
    assert.equal(emptyPayload.result.status, "planned");
    assert.equal(emptyPayload.result.evidenceAccepted, false);

    const staleState = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(staleState.code, 0, staleState.stderr);
    const stalePayload = JSON.parse(staleState.stdout);
    const plannedLane = stalePayload.parallelLanes.find((item) => item.id === "read-only-scout");
    assert.equal(plannedLane.status, "planned");
    assert.equal(plannedLane.evidenceStatus, "provisional");
    assert.equal(stalePayload.watchdogSummary.stale, true);

    const commandResult = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--command",
      `${quoteForShell(process.execPath)} -e ""`,
      "--allow-non-git-command",
      "--yes",
    ]);
    assert.equal(commandResult.code, 0, commandResult.stderr);
    const commandPayload = JSON.parse(commandResult.stdout);
    assert.equal(commandPayload.result.status, "completed");
    assert.equal(commandPayload.result.evidenceAccepted, true);

    const freshState = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(freshState.code, 0, freshState.stderr);
    const freshPayload = JSON.parse(freshState.stdout);
    const completedLane = freshPayload.parallelLanes.find((item) => item.id === "read-only-scout");
    assert.equal(completedLane.status, "completed");
    assert.equal(completedLane.evidenceStatus, "accepted");
    assert.equal(freshPayload.watchdogSummary.stale, false);
  });
});

test("lane-runner blocks implementation lanes without explicit isolation", async () => {
  await withTempDir("lane-runner-isolation", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--summary",
      "Try an implementation candidate.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Implementation lanes require explicit isolation/);
  });
});

test("lane-runner rejects missing and foreign implementation worktrees", async () => {
  await withTempDir("lane-runner-worktree-edges", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "README.md"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const missing = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      "missing-worktree-path",
      "--command",
      "git status --short",
      "--summary",
      "Missing worktree.",
      "--yes",
    ]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /existing Git worktree/i);

    const foreignRepo = path.join(dir, "foreign-repo");
    await mkdir(foreignRepo, { recursive: true });
    await git(foreignRepo, ["init"]);
    await git(foreignRepo, ["config", "user.email", "codex@example.test"]);
    await git(foreignRepo, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(foreignRepo, "README.md"), "foreign\n", "utf8");
    await git(foreignRepo, ["add", "-A"]);
    await git(foreignRepo, ["commit", "-m", "foreign"]);

    const foreign = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      foreignRepo,
      "--command",
      "git status --short",
      "--summary",
      "Foreign worktree.",
      "--yes",
    ]);
    assert.notEqual(foreign.code, 0);
    assert.match(foreign.stderr, /same Git repository/i);
  });
});

test("lane-runner allows a sibling implementation worktree", async () => {
  await withTempDir("lane-runner-worktree-pass", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "README.md"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const worktreePath = path.join(dir, "lane-worktree");
    await git(dir, ["worktree", "add", worktreePath, "-b", "lane-impl"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      worktreePath,
      "--command",
      "git status --short",
      "--summary",
      "Sibling worktree command.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.commandResult.code, 0);
  });
});

test("lane-runner rejects the main checkout as an implementation worktree", async () => {
  await withTempDir("lane-runner-main-worktree", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--worktree",
      ".",
      "--summary",
      "Unsafe main checkout.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /separate Git worktree/);
  });
});

test("lane-runner blocks implementation commands that escape write scope", async () => {
  await withTempDir("lane-runner-write-scope", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('outside.txt','escape')\"",
      "--summary",
      "Unsafe write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outside --write-scope/);
  });
});

test("lane-runner blocks write-scope commands that hide changes in commits", async () => {
  await withTempDir("lane-runner-write-scope-commit", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('outside.txt','escape')\" && git add outside.txt && git commit -m escape",
      "--summary",
      "Hidden unsafe write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cannot run git cleanup|cannot move HEAD/);
  });
});

test("lane-runner blocks write-scope mutators before execution", async () => {
  const blockedCommands = [
    ["git stash push -m blocked", /cannot run git cleanup|look mutating/i],
    ["git cherry-pick HEAD", /cannot run git cleanup|look mutating/i],
    ["git revert --no-edit HEAD", /cannot run git cleanup|look mutating/i],
    ["npm ci", /cannot run git cleanup|dependency|look mutating/i],
  ];
  for (const [command, pattern] of blockedCommands) {
    await withTempDir("lane-runner-write-scope-mutator", async (dir) => {
      await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
      await git(dir, ["init"]);
      await git(dir, ["config", "user.email", "codex@example.test"]);
      await git(dir, ["config", "user.name", "Codex Test"]);
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-m", "initial"]);
      const marker = path.join(dir, "lane-ran.marker");
      const guardedCommand = `${command} && node -e "require('fs').writeFileSync('lane-ran.marker','ran')"`;

      const result = await runCli([
        "lane-runner",
        "--cwd",
        dir,
        "--lane-id",
        "implementation-candidate",
        "--mode",
        "implementation",
        "--write-scope",
        "src",
        "--command",
        guardedCommand,
        "--summary",
        "Unsafe mutator.",
        "--yes",
      ]);
      assert.notEqual(result.code, 0, command);
      assert.match(result.stderr, pattern, command);
      await assert.rejects(() => access(marker));
    });
  }
});

test("lane-runner blocks write-scope cleanup commands in the main checkout", async () => {
  await withTempDir("lane-runner-write-scope-cleanup", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "git -C . reset --hard",
      "--summary",
      "Unsafe cleanup.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cannot run git cleanup/);
  });
});

test("lane-runner refuses write-scope when unrelated dirty files already exist", async () => {
  await withTempDir("lane-runner-write-scope-pre-dirty", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "owned.txt"), "before\n", "utf8");
    await writeFile(path.join(dir, "outside.txt"), "before\n", "utf8");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);
    await writeFile(path.join(dir, "outside.txt"), "user edit\n", "utf8");

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "implementation-candidate",
      "--mode",
      "implementation",
      "--write-scope",
      "src",
      "--command",
      "node -e \"require('fs').writeFileSync('src/owned.txt','after')\"",
      "--summary",
      "Owned write.",
      "--yes",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /dirty files outside scope/);
  });
});

test("lane-runner ignores completed lane results from older segments", async () => {
  await withTempDir("lane-runner-segment-results", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "quality_gap"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "7",
      "--status",
      "measure",
      "--description",
      "First segment measurement.",
    ]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);
    const first = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "benchmark-contract",
      "--summary",
      "Old segment result.",
      "--recommendation",
      "Do not reuse this after a segment change.",
      "--yes",
    ]);
    assert.equal(first.code, 0, first.stderr);

    await runCli(["new-segment", "--cwd", dir, "--reason", "New lane decision round.", "--yes"]);
    const second = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "benchmark-contract",
      "--dry-run",
    ]);
    assert.equal(second.code, 0, second.stderr);
    const payload = JSON.parse(second.stdout);
    assert.equal(payload.coordinatorRecommendation.status, "needs_lane_result");
    assert.notEqual(
      payload.coordinatorRecommendation.nextAction,
      "Do not reuse this after a segment change.",
    );
  });
});

test("lane-runner synthesizes completed lane results into one next action", async () => {
  await withTempDir("lane-runner-synthesis", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lane runner", "--metric-name", "quality_gap"]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);

    const result = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "benchmark-contract",
      "--summary",
      "Benchmark contract is the riskiest assumption.",
      "--recommendation",
      "Run one measured packet that validates benchmark contract parsing.",
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.coordinatorRecommendation.status, "ready");
    assert.equal(
      payload.coordinatorRecommendation.nextAction,
      "Run one measured packet that validates benchmark contract parsing.",
    );
    assert.equal(typeof payload.coordinatorRecommendation.nextAction, "string");
  });
});

test("state and doctor surface scaffold health and evidence labels", async () => {
  await withTempDir("truth-layer-state", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "truth layer",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: ["src/missing.ts"] }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(dir, "autoresearch.ps1"),
      "& powershell -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1\n",
      "utf8",
    );
    await writeFile(path.join(dir, "autoresearch.sh"), "bash ./autoresearch.sh\n", "utf8");

    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "perfect dev slice pending repeat",
      "--metrics",
      JSON.stringify({ repeatRequired: 1 }),
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.scaffoldHealth.ok, false);
    assert.ok(
      payload.scaffoldHealth.checks.some((check) => check.code === "self_recursive_wrapper"),
    );
    assert.ok(payload.scaffoldHealth.checks.some((check) => check.code === "missing_commit_path"));
    assert.ok(payload.researchIntegrity.evidenceLabels.includes("dev_best"));
    assert.ok(payload.researchIntegrity.evidenceLabels.includes("pending_repeat"));
    assert.match(payload.researchIntegrity.warnings.join("\n"), /perfect/i);

    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.scaffoldHealth.ok, false);
    assert.match(doctorPayload.warnings.join("\n"), /self-recursive|commitPaths/i);
  });
});

test("scaffold health catches direct PowerShell wrapper self-recursion", async () => {
  await withTempDir("powershell-direct-self-recursion", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "powershell recursion",
      "--metric-name",
      "score",
    ]);
    await writeFile(path.join(dir, "autoresearch.ps1"), "& .\\autoresearch.ps1\n", "utf8");

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.scaffoldHealth.ok, false);
    assert.ok(
      payload.scaffoldHealth.checks.some((check) => check.code === "self_recursive_wrapper"),
    );
  });
});

test("benchmark-lint separates metric parsing from research integrity", async () => {
  await withTempDir("benchmark-lint-integrity", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "lint integrity",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);

    const result = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--metric-name",
      "score",
      "--sample",
      "METRIC score=1\nMETRIC hit_at_10=1\n",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metricParsing.ok, true);
    assert.equal(payload.researchIntegrity.ok, false);
    assert.match(payload.researchIntegrity.warnings.join("\n"), /perfect|holdout|repeat/i);
  });
});

test("doctor does not treat routine rollback wording as evidence invalidation", async () => {
  await withTempDir("doctor-routine-rollback", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "routine rollback",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "kept candidate",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0.9",
      "--status",
      "discard",
      "--description",
      "ordinary rejected packet",
      "--asi",
      JSON.stringify({ rollback_reason: "reverted scoped experiment changes" }),
    ]);

    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.researchIntegrity.blockers, []);
    assert.ok(!payload.researchIntegrity.evidenceLabels.includes("invalidated"));
  });
});

test("prompt-plan prefers documented repo benchmark hints over generic cargo recipes", async () => {
  await withTempDir("prompt-plan-doc-hints", async (dir) => {
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(
      path.join(dir, "Cargo.toml"),
      [
        "[package]",
        'name = "prompt-plan-doc-hints"',
        'version = "0.1.0"',
        'edition = "2021"',
        "",
        "[dev-dependencies]",
        'criterion = "0.5"',
        "",
        "[[bench]]",
        'name = "generic_bench"',
        "harness = false",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(dir, "scripts", "embedding-harness.mjs"),
      "console.log('repo-specific embedding harness');\n",
      "utf8",
    );
    await writeFile(
      path.join(dir, "docs", "autoresearch-benchmark.md"),
      [
        "# Autoresearch benchmark",
        "",
        "Use `node scripts/embedding-harness.mjs --holdout fresh` for the measured loop.",
        "The harness prints `METRIC embedding_score=<number>` from the fresh embedding holdout.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runCli([
      "prompt-plan",
      "--cwd",
      dir,
      "--prompt",
      "Optimize the embedding pipeline runtime using the project benchmark.",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.intent.setupDefaults.benchmarkCommand, /embedding-harness\.mjs/);
    assert.doesNotMatch(payload.intent.setupDefaults.benchmarkCommand, /cargo\s+(test|bench)/);
    assert.equal(
      payload.intent.inferredFrom.discoveredBenchmark.path,
      "docs/autoresearch-benchmark.md",
    );
  });
});

test("run notes append inside the managed ledger block", async () => {
  await withTempDir("managed-ledger", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "ledger", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "autoresearch.md"),
      "# Session\n\n## Guardrails\nKeep this section stable.\n",
      "utf8",
    );
    for (const metric of ["3", "2"]) {
      const logged = await runCli([
        "log",
        "--cwd",
        dir,
        "--metric",
        metric,
        "--status",
        "keep",
        "--description",
        `Run ${metric}`,
      ]);
      assert.equal(logged.code, 0, logged.stderr);
    }
    const note = await readFile(path.join(dir, "autoresearch.md"), "utf8");
    assert.match(note, /## Run Ledger/);
    assert.equal((note.match(/AUTORESEARCH_RUN_LEDGER:START/g) || []).length, 1);
    assert.match(note, /Run 1 keep: Run 3[\s\S]+Run 2 keep: Run 2/);
    assert.match(note, /## Guardrails\nKeep this section stable\.\n\n## Run Ledger/);
  });
});

test("benchmark contract changes block the next packet until a new segment", async () => {
  await withTempDir("contract-drift", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "contract",
      "--metric-name",
      "score",
      "--direction",
      "higher",
    ]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxIterations: 5 }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(dir, "packet.cmd"),
      "node -e \"console.log('METRIC score=1')\"\n",
      "utf8",
    );

    const packet = await runCli(["next", "--cwd", dir, "--command-file", "packet.cmd"]);
    assert.equal(packet.code, 0, packet.stderr);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Baseline contract",
    ]);
    assert.equal(logged.code, 0, logged.stderr);

    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxIterations: 8 }, null, 2),
      "utf8",
    );
    const blocked = await runCli(["next", "--cwd", dir, "--command-file", "packet.cmd"]);
    assert.equal(blocked.code, 0, blocked.stderr);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.doctor.issues.join("\n"), /Benchmark\/check\/config contract changed/);
    assert.match(payload.nextAction, /new segment|old evidence|contract/i);
  });
});

test("new segment does not treat its own ledger append as dirty source drift", async () => {
  await withTempDir("segment-self-dirty", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await runCli(["init", "--cwd", dir, "--name", "segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "measure",
      "--description",
      "Initial segment measurement",
    ]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial session"]);

    const segment = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "fresh metric phase",
      "--yes",
    ]);
    assert.equal(segment.code, 0, segment.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.segment, 1);
    assert.equal(payload.decisionEnvelope.dirtySourceDrift.dirty, false);
    assert.ok(
      payload.warningDetails.every((warning) => warning.code !== "git_dirty"),
      "session-only dirtiness should not be reported as source drift",
    );
    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.doesNotMatch(doctorPayload.warnings.join("\n"), /Git worktree is dirty/);
    assert.ok(
      doctorPayload.warningDetails.every((warning) => warning.code !== "git_dirty"),
      "doctor should use the same session-only dirtiness filter as state",
    );

    await writeFile(path.join(dir, "tracked.txt"), "changed\n", "utf8");
    const dirty = await runCli(["state", "--cwd", dir]);
    assert.equal(dirty.code, 0, dirty.stderr);
    const dirtyPayload = JSON.parse(dirty.stdout);
    assert.equal(dirtyPayload.decisionEnvelope.dirtySourceDrift.dirty, true);
    assert.ok(dirtyPayload.warningDetails.some((warning) => warning.code === "git_dirty"));
  });
});

test("state and recommend-next share watchdog canonical next-action parity", async () => {
  await withTempDir("watchdog-cli-parity", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "watchdog parity", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "discard",
      "--description",
      "No movement",
    ]);

    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const oldMs = Date.now() - 10 * 60 * 60 * 1000;
    const lines = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const entry of lines) {
      if (entry.run != null) entry.timestamp = oldMs;
    }
    await writeFile(
      ledgerPath,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxIterations: 100 }, null, 2),
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.watchdogSummary?.stale, true);
    assert.equal(statePayload.decisionEnvelope?.watchdog?.stale, true);
    assert.equal(statePayload.limitReached, false);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.decisionEnvelope?.watchdog?.stale, true);
    assert.equal(
      recommendPayload.decisionEnvelope?.canonicalNextAction?.kind,
      statePayload.canonicalNextAction?.kind,
    );
    assert.equal(
      recommendPayload.decisionEnvelope?.watchdog?.recommendation,
      statePayload.decisionEnvelope?.watchdog?.recommendation,
    );
    assert.match(
      String(statePayload.decisionEnvelope?.watchdog?.recommendation || ""),
      /Intervene|finalize|rescope/i,
    );
  });
});

test("fanout plans are scoped to the active segment", async () => {
  await withTempDir("fanout-segment-scope", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "fanout scope", "--metric-name", "quality_gap"]);
    const fanout = await runCli(["research-fanout", "--cwd", dir, "--lanes", "4", "--yes"]);
    assert.equal(fanout.code, 0, fanout.stderr);
    const plan = JSON.parse(fanout.stdout).fanoutPlan;
    assert.ok(plan.id);

    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "measure",
      "--description",
      "Segment zero measurement",
    ]);
    await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "fresh segment for fanout scope",
      "--yes",
    ]);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.segment, 1);
    assert.equal(payload.fanoutProvenance?.matchedSegment, false);
    assert.equal(payload.fanoutProvenance?.source, "memory_or_defaults");
    assert.notEqual(payload.fanoutPlan?.id, plan.id);
    assert.equal(payload.fanoutPlan, null);
  });
});

test("read-only lane-runner rejects commands outside git without explicit opt-in", async () => {
  await withTempDir("lane-runner-non-git", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "non git lane", "--metric-name", "quality_gap"]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "2", "--yes"]);

    const blocked = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--command",
      `${quoteForShell(process.execPath)} -e "console.log('scout')"`,
      "--yes",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /Git worktree|porcelain verification/i);

    const allowed = await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--command",
      `${quoteForShell(process.execPath)} -e "console.log('scout')"`,
      "--allow-non-git-command",
      "--yes",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
  });
});

test("completed lane results count as watchdog progress signals", async () => {
  await withTempDir("watchdog-lane-result", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "lane watchdog",
      "--metric-name",
      "seconds",
      "--max-iterations",
      "100",
    ]);
    await runCli(["research-fanout", "--cwd", dir, "--lanes", "2", "--yes"]);
    const oldMs = Date.now() - 10 * 60 * 60 * 1000;
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "keep",
      "--description",
      "Old baseline",
    ]);
    const ledgerPath = path.join(dir, "autoresearch.jsonl");
    const lines = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const entry of lines) {
      if (entry.run != null) entry.timestamp = oldMs;
    }
    await writeFile(
      ledgerPath,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const before = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(JSON.parse(before.stdout).watchdogSummary?.stale, true);

    await runCli([
      "lane-runner",
      "--cwd",
      dir,
      "--lane-id",
      "read-only-scout",
      "--summary",
      "Scout completed.",
      "--recommendation",
      "Run one measured packet next.",
      "--yes",
    ]);

    const after = await runCli(["state", "--cwd", dir, "--compact"]);
    const afterPayload = JSON.parse(after.stdout);
    assert.equal(afterPayload.watchdogSummary?.stale, false);
    assert.ok(
      afterPayload.parallelLanes.some(
        (lane) => lane.id === "read-only-scout" && lane.status === "completed",
      ),
    );
  });
});

test("dashboard includes segment controls and visual-aid layout", async () => {
  await withTempDir("dashboard-cockpit", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    await runCli(["init", "--cwd", dir, "--name", "second segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Second baseline",
    ]);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const doc = dom.window.document;
    const rendered = doc.body.innerHTML;

    assert.ok(doc.getElementById("segment-navigator"));
    assert.ok(doc.getElementById("segment-tab-0"));
    assert.ok(doc.getElementById("segment-tab-1"));
    assert.ok(doc.getElementById("live-toggle"));
    assert.doesNotMatch(dashboard, /id="command-grid"/);
    assert.match(doc.body.textContent, /Run log/);
    assert.ok(doc.getElementById("ledger-scroll"));
    assert.match(doc.body.textContent, /Codex brief/);
    assert.ok(doc.getElementById("ai-summary-title"));
    assert.equal(doc.getElementById("mission-control-grid"), null);
    assert.equal(doc.getElementById("run-log-decision"), null);
    assert.equal(doc.getElementById("trust-strip"), null);
    assert.match(dashboard, /__AUTORESEARCH_META__/);
    assert.doesNotMatch(dashboard, /clipboard\?\.writeText/);
    assert.doesNotMatch(dashboard, /autoresearch\.mjs/);
    assert.match(doc.body.textContent, /Finalize/);
    assert.ok(rendered.indexOf('id="trend-panel"') < rendered.indexOf('id="codex-brief"'));
    assert.ok(rendered.indexOf('id="codex-brief"') < rendered.indexOf('id="strategy-memory"'));
    assert.ok(rendered.indexOf('id="strategy-memory"') < rendered.indexOf('id="decision-rail"'));
    assert.ok(rendered.indexOf('id="decision-rail"') < rendered.indexOf('id="ledger"'));
    assert.ok(rendered.indexOf('id="trend-panel"') < rendered.indexOf('id="ledger"'));
    assert.ok(rendered.indexOf('id="ledger"') < rendered.indexOf('id="research-truth-meter"'));
    dom.window.close();
  });
});

test("config persists operator settings and extends iteration limits", async () => {
  await withTempDir("operator-config", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "operator config", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);

    const result = await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "on-improvement",
      "--keep-policy",
      "primary-or-risk-reduction",
      "--dashboard-refresh-seconds",
      "2",
      "--extend",
      "4",
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.config.autonomyMode, "owner-autonomous");
    assert.equal(payload.config.checksPolicy, "on-improvement");
    assert.equal(payload.config.keepPolicy, "primary-or-risk-reduction");
    assert.equal(payload.config.dashboardRefreshSeconds, 2);
    assert.equal(payload.config.maxIterations, 5);
    assert.deepEqual(payload.config.commitPaths, ["src", "tests"]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.settings.autonomyMode, "owner-autonomous");
    assert.equal(statePayload.limit.remainingIterations, 4);
    assert.match(statePayload.commands[0].command, /autoresearch\.mjs/);
    assert.match(statePayload.commands[0].command, /--cwd/);
  });
});

test("next writes a reusable last-run packet and log can consume it", async () => {
  await withTempDir("last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "last run", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3'); console.log('METRIC cache_hits=8')"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, 3);
    assert.equal(packet.decision.metrics.cache_hits, 8);
    assert.equal(packet.decision.safeSuggestedStatus, "keep");
    assert.equal(packet.decision.promotion.label, "exploratory");
    assert.match(packet.decision.statusGuidance, /Safe to consider keep/);
    assert.equal(packet.decision.diversityGuidance, null);
    assert.equal(packet.decision.asiTemplate.lane, "");
    assert.match(packet.packetEvidence.packetId, /^packet-/);
    assert.equal(packet.packetEvidence.commandIdentity.command, command);
    assert.equal(packet.packetEvidence.exitStatus, 0);
    assert.equal(packet.packetEvidence.metrics.seconds, 3);
    assert.match(packet.packetEvidence.stdoutTail, /METRIC seconds=3/);
    assert.match(packet.packetEvidence.freshnessFingerprint, /^[a-f0-9]{64}$/);

    const lastRun = JSON.parse(await readFile(packet.lastRunPath, "utf8"));
    assert.equal(lastRun.decision.metric, 3);
    assert.equal(lastRun.decision.promotion.label, "exploratory");
    assert.equal(lastRun.packetEvidence.metrics.cache_hits, 8);
    assert.equal(lastRun.history.nextRun, 1);
    assert.equal(lastRun.history.config.metricName, "seconds");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard cached packet",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.metric, 3);
    assert.equal(payload.experiment.metrics.cache_hits, 8);
    assert.equal(payload.experiment.metricEligible, true);
    assert.equal(payload.experiment.promotion.label, "invalidated");
    assert.match(payload.experiment.packetFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(payload.lastRunCleared, true);
    await assert.rejects(access(packet.lastRunPath));

    const duplicate = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Duplicate cached packet",
    ]);
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.stderr, /No last-run packet/);
  });
});

test("next parses metrics from the full benchmark output before display truncation", async () => {
  await withTempDir("full-output-metric", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "full output", "--metric-name", "seconds"]);
    const script = path.join(dir, "noisy-benchmark.mjs");
    await writeFile(
      script,
      [
        "console.log('METRIC seconds=7');",
        "for (let i = 0; i < 3000; i += 1) console.log(`noise ${i} ${'x'.repeat(80)}`);",
        "",
      ].join("\n"),
      "utf8",
    );

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      `${quoteForShell(process.execPath)} ${quoteForShell(script)}`,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, 7);
    assert.equal(packet.run.parsedPrimary, 7);
    assert.equal(packet.run.outputTruncated, true);
  });
});

test("successful last-run packets require explicit status and suggest discard for regressions", async () => {
  await withTempDir("last-run-suggest-discard", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "suggest discard",
      "--metric-name",
      "seconds",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=4')"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.suggestedStatus, "discard");
    assert.deepEqual(packet.decision.allowedStatuses, ["keep", "discard", "measure"]);

    const missingStatus = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--description",
      "No status",
    ]);
    assert.notEqual(missingStatus.code, 0);
    assert.match(missingStatus.stderr, /status is required/);

    const discard = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard slower run",
    ]);
    assert.equal(discard.code, 0, discard.stderr);
    assert.equal(JSON.parse(discard.stdout).experiment.status, "discard");
  });
});

test("stale last-run packets are rejected when history advances", async () => {
  await withTempDir("stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "stale packet", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    const directLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "keep",
      "--description",
      "Manual run",
    ]);
    assert.equal(directLog.code, 0, directLog.stderr);

    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Last-run packet is stale/);
    assert.match(stale.stderr, /next --cwd/);
    assert.match(stale.stderr, /--status measure/);
  });
});

test("stale last-run packets are rejected when scoped git evidence changes", async () => {
  await withTempDir("stale-last-run-git-evidence", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "git stale packet", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "tracked.txt"), "changed after next\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Old packet after file edit",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /Git dirty state changed|scoped file fingerprints changed/);
  });
});

test("stale last-run packets are rejected when dirty file contents change without status shape changes", async () => {
  await withTempDir("stale-last-run-dirty-content", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "dirty content packet",
      "--metric-name",
      "seconds",
    ]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "dirty before packet\n", "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "tracked.txt"), "dirty after packet\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet after dirty content edit",
      "--allow-add-all",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /dirty file contents changed/);
  });
});

test("stale last-run packets are rejected when untracked directory contents change", async () => {
  await withTempDir("stale-last-run-untracked-dir", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "untracked dir packet",
      "--metric-name",
      "seconds",
    ]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await mkdir(path.join(dir, "scratch"), { recursive: true });
    await writeFile(path.join(dir, "scratch", "thing.txt"), "before packet\n", "utf8");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    await writeFile(path.join(dir, "scratch", "thing.txt"), "after packet\n", "utf8");
    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old packet after untracked dir edit",
      "--allow-add-all",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /dirty file contents changed|Git dirty state changed/);
  });
});

test("last-run packets are rejected when config changes before logging", async () => {
  await withTempDir("config-stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first config", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    const secondConfig = await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "second config",
      "--metric-name",
      "points",
      "--direction",
      "higher",
    ]);
    assert.equal(secondConfig.code, 0, secondConfig.stderr);

    const stale = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Old metric packet",
    ]);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /session config changed/);
  });
});

test("owner-autonomous runs return continuation instead of handing control back", async () => {
  await withTempDir("continuation", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "continuation", "--metric-name", "seconds"]);
    await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "manual",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");
    assert.equal(packet.continuation.requiresLogDecision, true);
    assert.equal(packet.continuation.shouldAskUser, false);
    assert.equal(packet.continuation.forbidFinalAnswer, true);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.continuation.stage, "logged");
    assert.equal(payload.continuation.shouldContinue, true);
    assert.equal(payload.continuation.shouldAskUser, false);
    assert.equal(payload.continuation.forbidFinalAnswer, true);
    assert.match(payload.continuation.nextAction, /without asking the user/);
    assert.match(payload.continuation.commands.next, / next /);
  });
});

test("guarded sessions with active budgets keep continuation non-final", async () => {
  await withTempDir("guarded-active-budget", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "budget", "--metric-name", "seconds"]);
    await runCli(["config", "--cwd", dir, "--checks-policy", "manual", "--max-iterations", "3"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");
    assert.equal(packet.continuation.activeBudget, true);
    assert.equal(packet.continuation.shouldContinue, true);
    assert.equal(packet.continuation.forbidFinalAnswer, true);
    assert.match(packet.report.tried, /seconds=3/);
    assert.equal(packet.doctor, undefined);
    assert.match(packet.fullPacket, /lastRunPath/);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.continuation.stage, "logged");
    assert.equal(payload.continuation.activeBudget, true);
    assert.equal(payload.continuation.shouldContinue, true);
    assert.equal(payload.continuation.forbidFinalAnswer, true);
    assert.match(payload.continuation.finalAnswerPolicy, /Do not stop/);

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.activeBudget, true);
    assert.equal(statePayload.forbidFinalAnswer, true);
    assert.match(statePayload.commands.next, /--compact/);
    assert.match(statePayload.report.next, /Keep going/);
  });
});

test("continuation stops cleanly at the configured iteration limit", async () => {
  await withTempDir("continuation-limit", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "continuation limit",
      "--metric-name",
      "seconds",
    ]);
    await runCli([
      "config",
      "--cwd",
      dir,
      "--autonomy-mode",
      "owner-autonomous",
      "--checks-policy",
      "manual",
      "--max-iterations",
      "1",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(next.code, 0, next.stderr);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Limit baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.limit.limitReached, true);
    assert.equal(payload.continuation.shouldContinue, false);
    assert.match(payload.continuation.stopReason, /maxIterations reached/);
    assert.match(payload.continuation.commands.extendLimit, /--extend 10/);
  });
});

test("log from last packet rejects keep after failed checks", async () => {
  await withTempDir("last-run-check-failure", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "last run checks", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(1)"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-command",
      checks,
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.deepEqual(packet.decision.allowedStatuses, ["checks_failed"]);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Should not keep failed checks",
    ]);
    assert.notEqual(log.code, 0);
    assert.match(log.stderr, /Cannot log status 'keep'/);

    const jsonl = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(jsonl, /Should not keep failed checks/);
  });
});

test("metricless failure logs do not become baseline or best", async () => {
  await withTempDir("metricless-failures", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "metricless failures",
      "--metric-name",
      "seconds",
    ]);

    const crash = await runCli([
      "log",
      "--cwd",
      dir,
      "--status",
      "crash",
      "--description",
      "Benchmark crashed before metric",
    ]);
    assert.equal(crash.code, 0, crash.stderr);
    const crashPayload = JSON.parse(crash.stdout);
    assert.equal(crashPayload.experiment.metric, null);
    assert.equal(crashPayload.experiment.metricEligible, false);
    assert.equal(crashPayload.experiment.promotion.label, "blocked");

    const checksFailed = await runCli([
      "log",
      "--cwd",
      dir,
      "--status",
      "checks_failed",
      "--description",
      "Checks failed before metric",
    ]);
    assert.equal(checksFailed.code, 0, checksFailed.stderr);
    const checksFailedPayload = JSON.parse(checksFailed.stdout);
    assert.equal(checksFailedPayload.experiment.metric, null);
    assert.equal(checksFailedPayload.experiment.metricEligible, false);
    assert.equal(checksFailedPayload.experiment.promotion.label, "blocked");

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    assert.equal(payload.baseline, null);
    assert.equal(payload.best, null);
    assert.equal(payload.crashed, 1);
    assert.equal(payload.checksFailed, 1);
  });
});

test("measure logs metric evidence without keep/finalizer eligibility or git mutation", async () => {
  await withTempDir("measure-log-git-safe", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test User"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    const headBefore = await git(dir, ["rev-parse", "HEAD"]);

    await runCli(["init", "--cwd", dir, "--name", "measure", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1.23",
      "--status",
      "measure",
      "--description",
      "Record observation only",
      "--asi",
      JSON.stringify({ promotionGrade: true, evidence: "diagnostic measurement only" }),
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.status, "measure");
    assert.equal(payload.experiment.metricEligible, false);
    assert.equal(payload.experiment.promotion.label, "measurement");
    assert.equal(payload.experiment.commit, "");
    assert.equal(payload.git, "Git: no commit created.");
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), headBefore);
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.kept, 0);
    assert.equal(statePayload.measured, 1);
    assert.equal(statePayload.baseline, 1.23);
    assert.equal(statePayload.best, null);
    assert.equal(statePayload.promotion.count, 0);
    assert.equal(statePayload.promotion.baseline, null);
    assert.equal(statePayload.development.latest.status, "measure");
    assert.equal(statePayload.development.latest.metric, 1.23);

    const explicitCommit = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1.24",
      "--status",
      "measure",
      "--description",
      "Invalid commit provenance",
      "--commit",
      "HEAD",
    ]);
    assert.notEqual(explicitCommit.code, 0);
    assert.match(explicitCommit.stderr, /--commit is not allowed for measure logs/);
  });
});

test("from-last errors name next and manual measure recovery commands", async () => {
  await withTempDir("from-last-recovery", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "recovery", "--metric-name", "seconds"]);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "No packet",
    ]);
    assert.notEqual(log.code, 0);
    assert.match(log.stderr, /No last-run packet found/);
    assert.match(log.stderr, /next --cwd/);
    assert.match(log.stderr, /--status measure/);
  });
});

test("compact state, recommend-next, and onboarding-packet surface decision envelopes", async () => {
  await withTempDir("decision-envelope", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "envelope", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1.5')"`;

    const next = await runCli(["next", "--cwd", dir, "--command", command, "--compact"]);
    assert.equal(next.code, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.ok(nextPayload.decision.allowedStatuses.includes("measure"));

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.decisionEnvelope.activeSegment.segment, 0);
    assert.equal(statePayload.resumeAudit.latestPacketFreshness.fresh, true);
    assert.equal(statePayload.decisionEnvelope.finalizationReadiness.available, true);
    assert.equal(typeof statePayload.decisionEnvelope.nextAction, "string");

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.decisionEnvelope.latestPacketFreshness.fresh, true);
    assert.equal(recommendPayload.decisionEnvelope.nextAction, recommendPayload.nextAction);

    const onboarding = await runCli(["onboarding-packet", "--cwd", dir, "--compact"]);
    assert.equal(onboarding.code, 0, onboarding.stderr);
    const onboardingPayload = JSON.parse(onboarding.stdout);
    assert.equal(onboardingPayload.decisionEnvelope.latestPacketFreshness.fresh, true);
    assert.equal(onboardingPayload.resumeAudit.activeSegment.runs, 0);
  });
});

test("legacy failed sentinel metrics do not suppress next-run baseline guidance", async () => {
  await withTempDir("legacy-sentinel-baseline", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "legacy sentinel", "--metric-name", "seconds"]);

    const legacyFailure = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "-999",
      "--status",
      "crash",
      "--description",
      "Legacy sentinel failure",
    ]);
    assert.equal(legacyFailure.code, 0, legacyFailure.stderr);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).baseline, null);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=5')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.decision.rawSuggestedStatus, "keep");
    assert.equal(payload.decision.safeSuggestedStatus, "keep");
  });
});

test("metricless failed last-run packets log cleanly and preserve packet on invalid status", async () => {
  await withTempDir("metricless-last-run", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "metricless last run",
      "--metric-name",
      "seconds",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "process.exit(1)"`;

    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.decision.metric, null);
    assert.deepEqual(packet.decision.allowedStatuses, ["crash"]);

    const invalid = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Wrong failed status",
    ]);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /Cannot log status 'keep'/);
    await access(path.join(dir, "autoresearch.last-run.json"));

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "crash",
      "--description",
      "Log failed packet",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const payload = JSON.parse(logged.stdout);
    assert.equal(payload.experiment.metric, null);
    assert.equal(payload.experiment.metricEligible, false);
    assert.equal(payload.experiment.promotion.label, "blocked");
    assert.match(payload.experiment.packetFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(payload.lastRunCleared, true);
    await assert.rejects(access(path.join(dir, "autoresearch.last-run.json")));
  });
});

test("keep, discard, and measure still require finite metrics", async () => {
  await withTempDir("metric-required", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "metric required", "--metric-name", "seconds"]);

    for (const status of ["keep", "discard", "measure"]) {
      const result = await runCli([
        "log",
        "--cwd",
        dir,
        "--status",
        status,
        "--description",
        `${status} without metric`,
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /metric is required/);
    }
  });
});

test("state normalizes invalid metrics before experiment memory ranking", async () => {
  await withTempDir("state-invalid-metric-memory", async (dir) => {
    await writeFile(
      path.join(dir, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "invalid metric memory",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          metric: false,
          status: "keep",
          description: "Invalid metric",
          asi: { family: "same" },
        }),
        JSON.stringify({
          run: 2,
          metric: "not-a-number",
          status: "discard",
          description: "Invalid string",
          asi: { family: "same" },
        }),
        JSON.stringify({
          run: 3,
          metric: 5,
          status: "keep",
          description: "Real metric",
          asi: { family: "same" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const payload = JSON.parse(state.stdout);
    const family = payload.memory.families.find((item) => item.label === "same");

    assert.equal(payload.baseline, 5);
    assert.equal(payload.best, 5);
    assert.deepEqual(
      payload.memory.kept.map((item) => item.metric),
      [null, 5],
    );
    assert.equal(family.bestRun.run, 3);
    assert.equal(family.bestRun.metric, 5);
    assert.equal(family.bestKeptRun.run, 3);
    assert.equal(family.bestKeptRun.metric, 5);
  });
});

test("last-run packet does not dirty git worktrees before discard logging", async () => {
  await withTempDir("git-last-run", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "git last run", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.doesNotMatch(packet.lastRunPath, /autoresearch\.last-run\.json$/);

    const statusBeforeLog = await git(dir, ["status", "--short"]);
    assert.equal(statusBeforeLog, "");

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "discard",
      "--description",
      "Discard clean packet",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.metric, 3);
  });
});

test("no-change keep records no fake kept commit", async () => {
  await withTempDir("no-change-keep", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "no change keep", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);

    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep evidence without file changes",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(log.code, 0, log.stderr);
    const payload = JSON.parse(log.stdout);
    assert.equal(payload.experiment.commit, "");
    assert.match(payload.git, /nothing to commit/);
  });
});

test("config extend is based on the active segment run count", async () => {
  await withTempDir("segment-extend", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "first segment", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    await runCli(["init", "--cwd", dir, "--name", "second segment", "--metric-name", "seconds"]);

    const result = await runCli(["config", "--cwd", dir, "--extend", "4"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.config.maxIterations, 4);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.limit.maxIterations, 4);
    assert.equal(statePayload.limit.remainingIterations, 4);
  });
});

test("dashboard script renders zero and negative metric points", async () => {
  await withTempDir("dashboard-runtime", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "runtime dashboard",
      "--metric-name",
      "delta",
      "--direction",
      "lower",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "0",
      "--status",
      "keep",
      "--description",
      "Zero baseline",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "-2",
      "--status",
      "keep",
      "--description",
      "Negative improvement",
    ]);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    const dom = await renderExportedDashboard(dashboard);
    const chart = dom.window.document.getElementById("trend-chart").innerHTML;
    assert.match(chart, /#1 0 keep/);
    assert.match(chart, /#2 -2 keep/);
    dom.window.close();
  });
});

test("keep commits can be scoped to experiment paths", async () => {
  await withTempDir("scoped-commit", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "scoped commit", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, "scratch.txt"), "do not commit\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Scope the keep commit",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const committed = await git(dir, ["show", "--name-only", "--format=", "HEAD"]);
    assert.match(committed, /tracked\.txt/);
    assert.doesNotMatch(committed, /scratch\.txt/);

    const status = await git(dir, ["status", "--short"]);
    assert.match(status, /\?\? scratch\.txt/);
  });
});

test("keep logs require scoped commit paths or explicit add-all in git repos", async () => {
  await withTempDir("keep-add-all-gate", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "add all gate", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked keep",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /commitPaths is empty/);
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);

    const allowed = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Allow broad keep",
      "--allow-add-all",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(JSON.parse(allowed.stdout).git, /explicit add-all/);
  });
});

test("keep logs preflight missing commit paths before git add mutates the index", async () => {
  await withTempDir("missing-commit-path-preflight", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "missing path", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: ["docs/testing/research-data-catalog.md"] }, null, 2),
      "utf8",
    );
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked missing path",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /Configured commitPaths do not exist before git add/);
    assert.doesNotMatch(blocked.stderr, /pathspec/);
    assert.equal(await git(dir, ["diff", "--cached", "--name-only"]), "");
    assert.match(await git(dir, ["status", "--short"]), /M tracked\.txt/);
  });
});

test("keep logs allow tracked deletions in commit paths", async () => {
  await withTempDir("tracked-deletion-commit-path", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "delete tracked", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await rm(path.join(dir, "tracked.txt"));

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Delete tracked file",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const latestCommit = JSON.parse(logged.stdout).experiment.commit;
    assert.match(latestCommit, /^[0-9a-f]{7,12}$/);
    assert.match(
      await git(dir, ["show", "--name-status", "--format=", "HEAD"]),
      /D\s+tracked\.txt/,
    );
  });
});

test("keep logs report structured git index lock recovery", async () => {
  await withTempDir("git-index-lock", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "lock", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(dir, ".git", "index.lock"), "stale lock\n", "utf8");

    const blocked = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Blocked lock",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /Git index lock blocked git add/);
    assert.match(blocked.stderr, /Live git process check/);
    assert.match(blocked.stderr, /has not staged or committed anything/);
  });
});

test("logged packets do not leave .git autoresearch runtime dirs as stale artifacts", async () => {
  await withTempDir("git-runtime-dir-not-stale", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "runtime dir", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "packet.command"),
      "node -e \"console.log('METRIC seconds=1')\"\n",
      "utf8",
    );
    await git(dir, ["add", "autoresearch.jsonl", "packet.command"]);
    await git(dir, ["commit", "-m", "session"]);

    const packet = await runCli(["next", "--cwd", dir, "--command-file", "packet.command"]);
    assert.equal(packet.code, 0, packet.stderr);
    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Record clean packet",
      "--allow-add-all",
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    await access(path.join(dir, ".git", "autoresearch"));

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const warningCodes = JSON.parse(state.stdout).warningDetails.map((warning) => warning.code);
    assert.ok(!warningCodes.includes("stale_benchmark_artifacts"));
  });
});

test("keep logs can record an existing commit without staging dirty work", async () => {
  await withTempDir("keep-existing-commit", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "existing commit", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "manual experiment"]);
    const manualCommit = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(path.join(dir, "scratch.txt"), "leave dirty\n", "utf8");

    const logged = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Record existing commit",
      "--commit",
      manualCommit,
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const payload = JSON.parse(logged.stdout);
    assert.equal(payload.experiment.commit, manualCommit.slice(0, 12));
    assert.match(payload.git, /recorded existing commit/);
    assert.match(await git(dir, ["status", "--short"]), /\?\? autoresearch\.jsonl/);
    assert.match(await git(dir, ["status", "--short"]), /\?\? scratch\.txt/);
  });
});

test("doctor and dashboard stay quiet about empty commit paths until keep logging needs them", async () => {
  await withTempDir("empty-commit-path-warning", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "warning", "--metric-name", "seconds"]);
    const doctor = await runCli(["doctor", "--cwd", dir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.ok(
      !doctorPayload.warningDetails.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.ok(
      !statePayload.warningDetails.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    assert.ok(
      !exportPayload.viewModel.warnings.some(
        (warning) => warning.code === "empty_commit_paths_in_git_repo",
      ),
    );
  });
});

test("dashboard export decision envelope carries dirty source drift", async () => {
  await withTempDir("dashboard-dirty-envelope", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "dirty dashboard", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "changed\n", "utf8");

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const payload = JSON.parse(exported.stdout);
    assert.equal(payload.viewModel.decisionEnvelope.dirtySourceDrift.dirty, true);
    assert.ok(
      payload.viewModel.decisionEnvelope.dirtySourceDrift.warnings.some(
        (warning) => warning.code === "git_dirty",
      ),
    );
  });
});

test("export treats missing keep commits as finalization backlog instead of trust warnings", async () => {
  await withTempDir("missing-keep-commit-preview", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "preview quiet", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await git(dir, ["branch", "-M", "main"]);
    await git(dir, ["checkout", "-b", "experiment"]);

    const sessionLog = [
      JSON.stringify({
        type: "config",
        name: "preview quiet",
        metricName: "seconds",
        metricUnit: "s",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        metric: 10,
        status: "keep",
        description: "Keep baseline without commit metadata",
        timestamp: Date.now(),
        segment: 0,
        confidence: 1,
        asi: {
          evidence: "seconds=10",
          next_action_hint: "Confirm correctness before review packaging.",
        },
      }),
      "",
    ].join("\n");
    await writeFile(path.join(dir, "autoresearch.jsonl"), sessionLog, "utf8");
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "keep without commit metadata"]);

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    const trustReasons = exportPayload.viewModel.trustState.reasons.join("\n");
    assert.doesNotMatch(trustReasons, /has no commit/i);
    const previewPacket = exportPayload.viewModel.finalizationChecklist.find(
      (item) => item.label === "Preview packet",
    );
    assert.equal(previewPacket.state, "idle");
    assert.match(previewPacket.detail, /commit-backed keep logs/i);
  });
});

test("keep logs fail instead of recording success when git add fails", async () => {
  await withTempDir("keep-add-failure", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "git add failure", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Should not be logged",
      "--commit-paths",
      "missing.txt",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Configured commitPaths do not exist before git add/);

    const log = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(log, /Should not be logged/);
  });
});

test("keep logs fail instead of recording success when git commit fails", async () => {
  await withTempDir("keep-commit-failure", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);
    await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", "utf8");

    await runCli(["init", "--cwd", dir, "--name", "commit failure", "--metric-name", "seconds"]);
    await writeFile(path.join(dir, "tracked.txt"), "after\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Should not commit",
      "--commit-paths",
      "tracked.txt",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Git commit failed/);

    const log = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(log, /Should not commit/);
  });
});

test("discard reverts scoped experiment paths without deleting unrelated dirty work", async () => {
  await withTempDir("safe-discard", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "value.txt"), "base\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "safe discard", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({ commitPaths: ["src"] }, null, 2),
    );
    await git(dir, ["add", "autoresearch.jsonl", "autoresearch.config.json"]);
    await git(dir, ["commit", "-m", "session"]);

    await writeFile(path.join(dir, "src", "value.txt"), "experiment\n", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "unrelated dirty work\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "discard",
      "--description",
      "Discard scoped experiment",
    ]);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await readFile(path.join(dir, "src", "value.txt"), "utf8"), "base\n");
    assert.equal(await readFile(path.join(dir, "notes.txt"), "utf8"), "unrelated dirty work\n");
  });
});

test("discard without scoped paths refuses to clean a dirty git tree", async () => {
  await withTempDir("unsafe-discard", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli(["init", "--cwd", dir, "--name", "unsafe discard", "--metric-name", "seconds"]);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "scratch.txt"), "unrelated\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "discard",
      "--description",
      "Unsafe discard",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Refusing broad discard cleanup/);
    assert.equal(await readFile(path.join(dir, "scratch.txt"), "utf8"), "unrelated\n");
  });
});

test("clear removes deep research scratchpads", async () => {
  await withTempDir("clear-research", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "cleanup",
      "--goal",
      "Cleanup research",
    ]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const result = await runCli(["clear", "--cwd", dir, "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(researchRoot));
  });
});

test("clear dry-run previews deletion targets without removing files", async () => {
  await withTempDir("clear-dry-run", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "preview",
      "--goal",
      "Preview cleanup",
    ]);
    const researchRoot = path.join(dir, "autoresearch.research");
    await access(researchRoot);

    const result = await runCli(["clear", "--cwd", dir, "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.deleted.length, 0);
    assert.ok(payload.targets.includes(researchRoot));
    assert.ok(payload.wouldDelete.includes(researchRoot));
    await access(researchRoot);
  });
});

test("setup-plan preserves explicit command and state inputs", async () => {
  await withTempDir("setup-plan-inputs", async (dir) => {
    const benchmark = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const checks = `${quoteForShell(process.execPath)} -e "process.exit(0)"`;
    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "explicit setup",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--checks-command",
      checks,
      "--commit-paths",
      "src,tests",
      "--max-iterations",
      "7",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.nextCommand, /--benchmark-command/);
    assert.match(payload.nextCommand, /METRIC seconds=1/);
    assert.match(payload.nextCommand, /--checks-command/);
    assert.match(payload.nextCommand, /process\.exit\(0\)/);
    assert.match(payload.nextCommand, /--commit-paths "src,tests"/);
    assert.match(payload.nextCommand, /--max-iterations "7"/);
    assert.equal(payload.benchmarkMode.printsMetric, true);
    assert.match(payload.benchmarkLintCommand, /benchmark-lint/);
    assert.equal(payload.missingEssentials.length, 0);
    assert.equal(payload.nextStep.stage, "setup-repair");
    assert.equal(payload.nextStep.nextAction.title, "Create session setup");
    assert.equal(payload.nextStep.nextAction.safety, "state_mutation");
    assert.match(payload.nextStep.nextAction.command, / setup /);
    assert.equal(payload.nextStep.nextAction.toolName, "setup_session");
    assert.deepEqual(
      payload.firstRunChecklist.map((step) => step.step),
      ["setup", "benchmark-lint", "doctor", "checkpoint", "baseline", "log"],
    );

    await runCli(["init", "--cwd", dir, "--name", "guide setup", "--metric-name", "seconds"]);
    const guide = await runCli(["guide", "--cwd", dir, "--benchmark-command", benchmark]);
    assert.equal(guide.code, 0, guide.stderr);
    const guidePayload = JSON.parse(guide.stdout);
    assert.equal(guidePayload.nextStep.stage, "baseline-packet");
    assert.equal(guidePayload.nextStep.nextAction.title, "Run baseline packet");
    assert.equal(guidePayload.nextStep.nextAction.safety, "process_start");
    assert.match(guidePayload.nextStep.nextAction.command, / next /);
  });
});

test("setup-plan treats recommended recipe benchmark as configured", async () => {
  await withTempDir("setup-plan-recipe-defaults", async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      '{"scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
      "utf8",
    );

    const result = await runCli(["setup-plan", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.recommendedRecipe.id, "node-test-runtime");
    assert.deepEqual(payload.missing, []);
    assert.deepEqual(payload.missingEssentials, []);
    assert.doesNotMatch(payload.nextStep.nextAction.reason, /benchmark_command/);
    assert.match(payload.nextCommand, /--recipe "node-test-runtime"/);
  });
});

test("setup-plan warns when files in scope and commit paths diverge", async () => {
  await withTempDir("setup-plan-scope-warning", async (dir) => {
    const result = await runCli([
      "setup-plan",
      "--cwd",
      dir,
      "--name",
      "scope warning",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`,
      "--files-in-scope",
      "src",
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.scopeWarnings.join("\n"), /tests/);
    assert.match(payload.notes.join("\n"), /Scope warning/);
  });
});

test("setup does not append elapsed metrics to explicit metric-emitting benchmarks", async () => {
  await withTempDir("setup-explicit-metric", async (dir) => {
    const benchmark = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=42')"`;
    const result = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "explicit metric setup",
      "--metric-name",
      "seconds",
      "--benchmark-command",
      benchmark,
      "--commit-paths",
      "src,tests",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.checkpoint.paths.includes("autoresearch.md"));
    assert.ok(payload.checkpoint.paths.includes("autoresearch.config.json"));
    assert.ok(payload.checkpoint.paths.includes(".gitattributes"));
    assert.match(payload.checkpoint.commands.join("\n"), /git add --/);
    assert.equal(payload.benchmarkMode.printsMetric, true);
    assert.match(payload.benchmarkLintCommand, /benchmark-lint/);
    assert.deepEqual(
      payload.firstRunChecklist.map((step) => step.step),
      ["setup", "benchmark-lint", "doctor", "checkpoint", "baseline", "log"],
    );

    const scriptName = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
    const script = await readFile(path.join(dir, scriptName), "utf8");
    assert.match(script, /METRIC seconds=42/);
    assert.doesNotMatch(script, /Elapsed\.TotalSeconds|elapsed_seconds/);
    assert.doesNotMatch(script, /METRIC seconds=\{0\}|printf 'METRIC seconds/);

    const sessionDoc = await readFile(path.join(dir, "autoresearch.md"), "utf8");
    assert.match(sessionDoc, /`src`: in configured commit scope/);
    assert.match(sessionDoc, /`tests`: in configured commit scope/);
    assert.doesNotMatch(sessionDoc, /TBD: add files after initial inspection/);

    const attributes = await readFile(path.join(dir, ".gitattributes"), "utf8");
    assert.match(attributes, /autoresearch\.jsonl text eol=lf/);
    assert.match(attributes, /autoresearch\.md text eol=lf/);
    assert.match(attributes, /autoresearch\.ideas\.md text eol=lf/);
  });
});

test("ledger appends use LF on Windows-facing sessions", async () => {
  await withTempDir("ledger-lf", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "lf", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const ledger = await readFile(path.join(dir, "autoresearch.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /\r\n/);
    assert.match(ledger, /\n/);
  });
});

test("benchmark-inspect warns before suspicious full benchmark probes", async () => {
  await withTempDir("benchmark-inspect", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "inspect", "--metric-name", "score"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('case-a')"`;
    const result = await runCli(["benchmark-inspect", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ranCommand, true);
    assert.match(payload.outputPreview, /case-a/);
    assert.match(payload.hints.join("\n"), /METRIC score=<number>/);

    const suspicious = await runCli([
      "benchmark-inspect",
      "--cwd",
      dir,
      "--command",
      "CODESTORY_PIPELINE_LIST_CASES=1 node scripts/autoresearch-indexer-embedder-pipeline.mjs",
    ]);
    assert.equal(suspicious.code, 0, suspicious.stderr);
    const suspiciousPayload = JSON.parse(suspicious.stdout);
    assert.match(suspiciousPayload.warnings.join("\n"), /CODESTORY_EMBED_RESEARCH_LIST=1/);
  });
});

test("checks-inspect catches malformed cargo checks and broad failures", async () => {
  await withTempDir("checks-inspect", async (dir) => {
    const cargoShape = `${quoteForShell(process.execPath)} -e "console.error(\\"error: unexpected argument 'build_search_state' found\\\\n\\\\nUsage: cargo.exe test [OPTIONS] [TESTNAME] [-- [ARGS]...]\\"); process.exit(1)"`;
    const shapeResult = await runCli(["checks-inspect", "--cwd", dir, "--command", cargoShape]);
    assert.equal(shapeResult.code, 0, shapeResult.stderr);
    const shapePayload = JSON.parse(shapeResult.stdout);
    assert.equal(shapePayload.ok, false);
    assert.match(shapePayload.warnings.join("\n"), /Cargo rejected/);
    assert.match(shapePayload.nextAction, /Fix command-shape/);

    const broadFailure = `${quoteForShell(process.execPath)} -e "console.error(\\"test runtime::one ... FAILED\\\\ntest semantic::two ... FAILED\\"); process.exit(1)"`;
    const broadResult = await runCli(["checks-inspect", "--cwd", dir, "--command", broadFailure]);
    assert.equal(broadResult.code, 0, broadResult.stderr);
    const broadPayload = JSON.parse(broadResult.stdout);
    assert.deepEqual(broadPayload.failedTests, ["runtime::one", "semantic::two"]);
    assert.match(broadPayload.warnings.join("\n"), /2 tests failed/);
  });
});

test("promote-gate dry-runs and appends measurement gate metadata", async () => {
  await withTempDir("promote-gate", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "gate", "--metric-name", "score"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);
    const dryRun = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "move to 150 queries",
      "--query-count",
      "150",
      "--dry-run",
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.dryRun, true);
    assert.equal(dryPayload.entry.measurementGate.queryCount, 150);

    const confirmed = await runCli([
      "promote-gate",
      "--cwd",
      dir,
      "--reason",
      "move to 150 queries",
      "--gate-name",
      "150-query gate",
      "--query-count",
      "150",
      "--yes",
    ]);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    const payload = JSON.parse(confirmed.stdout);
    assert.equal(payload.nextSegment, 1);
    assert.equal(payload.entry.measurementGate.name, "150-query gate");

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(JSON.parse(state.stdout).segment, 1);
  });
});

test("invalid iteration limits and negative extensions fail loudly", async () => {
  await withTempDir("invalid-iteration-limits", async (dir) => {
    const setup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "bad limit",
      "--metric-name",
      "seconds",
      "--max-iterations",
      "0",
    ]);
    assert.notEqual(setup.code, 0);
    assert.match(setup.stderr, /maxIterations must be a positive integer/);

    const fractionalSetup = await runCli([
      "setup",
      "--cwd",
      dir,
      "--name",
      "fractional limit",
      "--metric-name",
      "seconds",
      "--max-iterations",
      "1.5",
    ]);
    assert.notEqual(fractionalSetup.code, 0);
    assert.match(fractionalSetup.stderr, /maxIterations must be a positive integer/);

    await runCli(["init", "--cwd", dir, "--name", "config limit", "--metric-name", "seconds"]);
    const config = await runCli(["config", "--cwd", dir, "--extend", "-1"]);
    assert.notEqual(config.code, 0);
    assert.match(config.stderr, /extend must be a non-negative integer/);

    const fractionalExtend = await runCli(["config", "--cwd", dir, "--extend", "1.5"]);
    assert.notEqual(fractionalExtend.code, 0);
    assert.match(fractionalExtend.stderr, /extend must be a non-negative integer/);
  });
});

test("log accepts ASI from a JSON file", async () => {
  await withTempDir("asi-file", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "asi file", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "asi.json"),
      JSON.stringify({
        hypothesis: "avoid shell quoting",
        evidence: "file parsed",
        next_action_hint: "continue",
      }),
      "utf8",
    );

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi-file",
      "asi.json",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const ledger = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const run = ledger.find((entry) => entry.run === 1);
    assert.equal(run.asi.hypothesis, "avoid shell quoting");
    assert.equal(run.asi.evidence, "file parsed");
  });
});

test("log accepts ASI from --asi-json-file for PowerShell-safe logging", async () => {
  await withTempDir("asi-json-file", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "asi json file", "--metric-name", "seconds"]);
    await writeFile(
      path.join(dir, "asi.json"),
      JSON.stringify(
        {
          hypothesis: "avoid powershell quoting",
          evidence: 'file parsed with "quotes"',
          next_action_hint: "continue",
          windowsPath: "C:\\tmp\\asi.json",
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "3",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi-json-file",
      "asi.json",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const ledger = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const run = ledger.find((entry) => entry.run === 1);
    assert.equal(run.asi.hypothesis, "avoid powershell quoting");
    assert.equal(run.asi.evidence, 'file parsed with "quotes"');
    assert.equal(run.asi.windowsPath, "C:\\tmp\\asi.json");

    const conflict = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "4",
      "--status",
      "keep",
      "--description",
      "Conflict",
      "--asi-json-file",
      "asi.json",
      "--asi",
      "{}",
    ]);
    assert.notEqual(conflict.code, 0);
    assert.match(conflict.stderr, /Use either --asi or --asi-json-file/);
  });
});

test("broad discard cleanup preserves deep research scratchpads", async () => {
  await withTempDir("preserve-research", async (dir) => {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "study",
      "--goal",
      "Preserve research",
    ]);
    await writeFile(path.join(dir, "tracked.txt"), "experiment\n", "utf8");
    const gapsPath = path.join(dir, "autoresearch.research", "study", "quality-gaps.md");
    await writeFile(gapsPath, "- [ ] Preserve this scratchpad\n", "utf8");

    const result = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "discard",
      "--description",
      "Discard broad change",
      "--allow-dirty-revert",
    ]);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await readFile(path.join(dir, "tracked.txt"), "utf8"), "base\n");
    assert.equal(await readFile(gapsPath, "utf8"), "- [ ] Preserve this scratchpad\n");
  });
});

test("CLI parser accepts equals-form options", async () => {
  await withTempDir("equals-options", async (dir) => {
    const init = await runCli([
      "init",
      `--cwd=${dir}`,
      "--name=equals options",
      "--metric-name=seconds",
    ]);
    assert.equal(init.code, 0, init.stderr);
    const state = await runCli(["state", `--cwd=${dir}`]);
    assert.equal(state.code, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).config.metricName, "seconds");
  });
});

test("tool schemas expose guidance and output contracts", async () => {
  const [
    { toolSchemas },
    { validateToolContracts },
    { actionPolicyForTool, cliCommandForTool, toolMutates, validateToolRegistry },
  ] = await Promise.all([
    import("../lib/tool-schemas.js"),
    import("../lib/tool-contracts.js"),
    import("../lib/tool-registry.js"),
  ]);
  const contractCheck = validateToolContracts(toolSchemas);
  assert.equal(contractCheck.ok, true, contractCheck.issues.join("\n"));
  const registryCheck = validateToolRegistry(toolSchemas);
  assert.equal(registryCheck.ok, true, JSON.stringify(registryCheck));

  const guided = toolSchemas.find((tool) => tool.name === "guided_setup");
  const next = toolSchemas.find((tool) => tool.name === "next_experiment");
  const doctor = toolSchemas.find((tool) => tool.name === "doctor_session");
  const checksInspect = toolSchemas.find((tool) => tool.name === "checks_inspect");
  const researchFanout = toolSchemas.find((tool) => tool.name === "research_fanout");
  const serve = toolSchemas.find((tool) => tool.name === "serve_dashboard");

  assert.ok(guided);
  assert.ok(researchFanout);
  assert.ok(checksInspect);
  assert.ok(serve);
  assert.match(guided.description, /first-run or resume action packet/);
  assert.equal(guided.outputSchema.type, "object");
  assert.equal(next.outputSchema.type, "object");
  assert.match(next.description, /normal measured loop iteration/);
  assert.match(serve.description, /live local dashboard/);
  assert.equal(
    doctor.annotations.safety,
    "Read-only unless benchmark check runs configured commands.",
  );
  assert.equal(
    guided.annotations.safety,
    "Read-only by default; starts a local dashboard only when start_dashboard=true.",
  );
  assert.equal(guided.annotations.readOnlyHint, false);
  assert.equal(researchFanout.annotations.readOnlyHint, false);
  assert.equal(researchFanout.annotations.openWorldHint, false);
  assert.equal(guided.annotations.openWorldHint, true);
  assert.equal(next.annotations.readOnlyHint, false);
  assert.equal(next.annotations.openWorldHint, true);

  const richDoctor = toolSchemas.find((tool) => tool.name === "doctor_session");
  assert.equal(richDoctor.outputSchema.type, "object");
  assert.equal(guided.outputSchema.properties.workDir.type, "string");
  assert.equal(guided.inputSchema.properties.start_dashboard.type, "boolean");
  assert.equal(guided.inputSchema.properties.port.type, "number");
  assert.equal(guided.outputSchema.properties.commands.type, "array");
  assert.equal(guided.outputSchema.properties.commands.items.type, "string");
  assert.equal(guided.outputSchema.properties.dashboard.type, "object");
  assert.equal(next.outputSchema.properties.parsedMetrics, undefined);
  assert.equal(next.outputSchema.properties.decision.type, "object");
  assert.equal(richDoctor.outputSchema.properties.issues.type, "array");
  assert.equal(richDoctor.outputSchema.properties.issues.items.type, "string");
  const qualityGap = toolSchemas.find((tool) => tool.name === "measure_quality_gap");
  assert.equal(qualityGap.outputSchema.properties.open.type, "number");
  assert.equal(qualityGap.outputSchema.properties.openItems.items.type, "string");
  for (const tool of toolSchemas) {
    for (const [field, schema] of Object.entries(tool.outputSchema.properties || {})) {
      assert.ok(schema.type, `${tool.name}.${field} should expose a concrete output type`);
      if (schema.type === "array") assert.ok(schema.items, `${tool.name}.${field} needs items`);
    }
  }
  assert.equal(
    richDoctor.annotations.safety,
    "Read-only unless benchmark check runs configured commands.",
  );
  assert.equal(richDoctor.annotations.readOnlyHint, false);
  assert.equal(richDoctor.annotations.openWorldHint, true);
  assert.equal(cliCommandForTool("next_experiment"), "next");
  assert.equal(cliCommandForTool("research_fanout"), "research-fanout");
  assert.equal(cliCommandForTool("checks_inspect"), "checks-inspect");
  assert.equal(toolMutates("next_experiment"), true);
  assert.equal(toolMutates("research_fanout"), false);
  assert.equal(actionPolicyForTool("research_fanout"), "read");
  assert.equal(actionPolicyForTool("research_fanout", { yes: true }), "state_mutation");
  assert.equal(toolMutates("read_state"), false);
});

test("CLI and tool argument normalization share runtime contracts", async () => {
  const {
    normalizeCliCommandArguments,
    normalizeRuntimeToolArguments,
    normalizeToolArguments,
    requireUnsafeCommandGate,
    validateToolArguments,
  } = await import("../lib/tool-schemas.js");

  const toolArgs = validateToolArguments("setup_plan", {
    workingDir: "C:/repo",
    recipe: "node-test-runtime",
    metricName: "seconds",
    benchmarkCommand: "node bench.js",
    commitPaths: ["src"],
    allowUnsafeCommand: true,
  });
  assert.deepEqual(toolArgs, {
    working_dir: "C:/repo",
    recipe_id: "node-test-runtime",
    metric_name: "seconds",
    benchmark_command: "node bench.js",
    commit_paths: ["src"],
    allow_unsafe_command: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("setup_plan", toolArgs), {
    cwd: "C:/repo",
    recipeId: "node-test-runtime",
    metricName: "seconds",
    benchmarkCommand: "node bench.js",
    commitPaths: ["src"],
    allow_unsafe_command: true,
  });
  assert.deepEqual(
    normalizeCliCommandArguments("setup-plan", {
      cwd: "C:/repo",
      recipe: "node-test-runtime",
      metricName: "seconds",
      benchmarkCommand: "node bench.js",
      commitPaths: ["src"],
    }),
    {
      cwd: "C:/repo",
      recipeId: "node-test-runtime",
      metricName: "seconds",
      benchmarkCommand: "node bench.js",
      commitPaths: ["src"],
    },
  );
  const setupSessionArgs = validateToolArguments("setup_session", {
    workingDir: "C:/repo",
    recipeId: "external-speed",
    catalog: "recipes.json",
    trustCatalog: true,
    allowUnsafeCommand: true,
  });
  assert.equal(setupSessionArgs.trust_catalog, true);
  assert.deepEqual(normalizeRuntimeToolArguments("setup_session", setupSessionArgs), {
    cwd: "C:/repo",
    recipeId: "external-speed",
    catalog: "recipes.json",
    trustCatalog: true,
    allow_unsafe_command: true,
  });
  const logArgs = validateToolArguments("log_experiment", {
    workingDir: "C:/repo",
    status: "keep",
    description: "ASI file",
    asiJsonFile: "asi.json",
  });
  assert.equal(logArgs.asi_json_file, "asi.json");
  assert.deepEqual(normalizeRuntimeToolArguments("log_experiment", logArgs), {
    cwd: "C:/repo",
    status: "keep",
    description: "ASI file",
    asiJsonFile: "asi.json",
  });
  const promptPlanArgs = validateToolArguments("prompt_plan", {
    workingDir: "C:/repo",
    prompt: "Optimize the external recipe.",
    recipeId: "external-speed",
    catalog: "recipes.json",
    trustCatalog: true,
    allowUnsafeCommand: true,
  });
  assert.equal(promptPlanArgs.trust_catalog, true);
  assert.deepEqual(normalizeRuntimeToolArguments("prompt_plan", promptPlanArgs), {
    cwd: "C:/repo",
    prompt: "Optimize the external recipe.",
    recipeId: "external-speed",
    catalog: "recipes.json",
    trustCatalog: true,
    allow_unsafe_command: true,
  });
  assert.throws(
    () => requireUnsafeCommandGate("setup_session", { catalog: "recipes.json" }),
    /allow_unsafe_command=true/,
  );
  assert.doesNotThrow(() =>
    requireUnsafeCommandGate("prompt_plan", {
      catalog: "recipes.json",
      allow_unsafe_command: true,
    }),
  );
  assert.equal(normalizeToolArguments("clear_session", { yes: true }).confirm, true);

  const laneRunnerArgs = validateToolArguments("lane_runner", {
    workingDir: "C:/repo",
    laneId: "read-only-scout",
    mode: "read_only_scout",
    command: "git status --short",
    yes: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("lane_runner", laneRunnerArgs), {
    cwd: "C:/repo",
    laneId: "read-only-scout",
    mode: "read_only_scout",
    command: "git status --short",
    yes: true,
  });

  const forensicsArgs = validateToolArguments("session_forensics", {
    workingDir: "C:/repo",
    sessionJsonl: "rollout.jsonl",
    researchSlug: "study",
    apply: true,
  });
  assert.deepEqual(normalizeRuntimeToolArguments("session_forensics", forensicsArgs), {
    cwd: "C:/repo",
    sessionJsonl: "rollout.jsonl",
    researchSlug: "study",
    apply: true,
  });

  const partialResultsArgs = validateToolArguments("partial_results", {
    workingDir: "C:/repo",
    fromLast: true,
    record: "rows=out/rows.json",
    description: "Salvage rows",
  });
  assert.deepEqual(normalizeRuntimeToolArguments("partial_results", partialResultsArgs), {
    cwd: "C:/repo",
    fromLast: true,
    record: "rows=out/rows.json",
    description: "Salvage rows",
  });

  const goalBridgeArgs = validateToolArguments("codex_goal_bridge", {
    workingDir: "C:/repo",
    codexGoalObjective: "Close the loop",
    codexGoalStatus: "active",
  });
  assert.deepEqual(normalizeRuntimeToolArguments("codex_goal_bridge", goalBridgeArgs), {
    cwd: "C:/repo",
    codexGoalObjective: "Close the loop",
    codexGoalStatus: "active",
  });
});

test("log rejects conflicting metrics inputs and invalid evidence status", async () => {
  await withTempDir("log-contract-edges", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "log contract", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const packet = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(packet.code, 0, packet.stderr);

    const metricsConflict = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "conflict",
      "--metrics",
      '{"seconds":1}',
      "--metrics-file",
      "metrics.json",
    ]);
    assert.notEqual(metricsConflict.code, 0);
    assert.match(metricsConflict.stderr, /either --metrics or --metrics-file/i);

    const invalidEvidence = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "bad evidence",
      "--evidence-status",
      "mystery",
    ]);
    assert.notEqual(invalidEvidence.code, 0);
    assert.match(invalidEvidence.stderr, /evidence-status/i);
  });
});

test("plugin manifest does not declare an MCP server", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const pkg = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));

  assert.equal(manifest.mcpServers, undefined);
  assert.equal(pkg.files.includes(".mcp.json"), false);
  await assert.rejects(access(path.join(pluginRoot, ".mcp.json")));
  await assert.rejects(access(path.join(pluginRoot, "scripts", "autoresearch-mcp.mjs")));
});

test("metric names must match the METRIC parser grammar", async () => {
  await withTempDir("bad-metric-name", async (dir) => {
    const result = await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "bad metric",
      "--metric-name",
      "bad metric",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Metric name/);
  });
});

test("export refuses to write outside the working directory", async () => {
  await withTempDir("contained-export", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "contained export", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);

    const result = await runCli(["export", "--cwd", dir, "--output", "../escape.html"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outside the working directory/);
  });
});

test("export is compact by default and full with json-full", async () => {
  await withTempDir("compact-export", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "compact export", "--metric-name", "seconds"]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Baseline",
    ]);

    const compact = await runCli(["export", "--cwd", dir]);
    assert.equal(compact.code, 0, compact.stderr);
    const compactPayload = JSON.parse(compact.stdout);
    assert.equal(compactPayload.ok, true);
    assert.equal(compactPayload.summary.runs, 1);
    assert.equal(compactPayload.best, 1);
    assert.equal(compactPayload.viewModel, undefined);
    assert.equal(compactPayload.progress.stages[0].stage, "export");

    const full = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(full.code, 0, full.stderr);
    const fullPayload = JSON.parse(full.stdout);
    assert.equal(fullPayload.viewModel.summary.runs, 1);
  });
});

test("large benchmark output is capped and marked truncated", async () => {
  await withTempDir("large-output", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "large output", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('x'.repeat(30000)); console.log('METRIC seconds=1')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.outputTruncated, true);
    assert.ok(payload.tailOutput.length < 9000);
    assert.equal(payload.parsedPrimary, 1);
  });
});

test("large no-newline benchmark tails do not hide early metrics", async () => {
  await withTempDir("large-no-newline-output", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "large no newline", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "process.stdout.write('METRIC seconds=2\\n'); process.stdout.write('x'.repeat(300000))"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.outputTruncated, true);
    assert.ok(payload.tailOutput.length < 9000);
    assert.equal(payload.parsedPrimary, 2);
  });
});

test("large metric streams retain bounded metrics and primary evidence", async () => {
  await withTempDir("large-metric-stream", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "large metric stream",
      "--metric-name",
      "seconds",
    ]);
    const command = `${quoteForShell(process.execPath)} -e "for (let i = 0; i < 20000; i++) console.log('METRIC m' + i + '=' + i); console.log('METRIC seconds=1')"`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metricsTruncated, true);
    assert.equal(payload.parsedPrimary, 1);
    assert.equal(payload.parsedMetrics.seconds, 1);
    assert.ok(Object.keys(payload.parsedMetrics).length <= 513);
  });
});

test("large metric streams keep a primary metric outside retained output tails", async () => {
  await withTempDir("large-metric-primary-middle", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "large primary stream",
      "--metric-name",
      "seconds",
    ]);
    const emitter = path.join(dir, "emit-metrics.mjs");
    await writeFile(
      emitter,
      [
        "function writeMetrics(prefix, count) {",
        "  let chunk = '';",
        "  for (let i = 0; i < count; i += 1) {",
        "    chunk += `METRIC ${prefix}${i}=${i}\\n`;",
        "    if (chunk.length > 65536) { process.stdout.write(chunk); chunk = ''; }",
        "  }",
        "  if (chunk) process.stdout.write(chunk);",
        "}",
        "writeMetrics('pre', 12000);",
        "process.stdout.write('METRIC seconds=7\\n');",
        "writeMetrics('post', 90000);",
      ].join("\n"),
      "utf8",
    );
    const command = `${quoteForShell(process.execPath)} ${quoteForShell(emitter)}`;
    const result = await runCli(["run", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.metricsTruncated, true);
    assert.equal(payload.parsedPrimary, 7);
    assert.equal(payload.parsedMetrics.seconds, 7);
    assert.ok(Object.keys(payload.parsedMetrics).length <= 513);
  });
});

test("next command runs preflight and benchmark as one decision packet", async () => {
  await withTempDir("next-command", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "next command", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=2')"`;
    const result = await runCli(["next", "--cwd", dir, "--command", command]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.doctor.ok, true);
    assert.equal(payload.run.parsedPrimary, 2);
    assert.equal(payload.run.progress.mode, "synchronous");
    assert.equal(payload.run.progress.status, "completed");
    assert.equal(payload.run.progress.cancellable, false);
    assert.equal(payload.run.progress.cancelStatus, "not_requested");
    assert.equal(payload.run.progress.stages[0].stage, "benchmark");
    assert.equal(payload.run.progress.stages[0].status, "completed");
    assert.match(payload.run.progress.latestOutputTail, /METRIC seconds=2/);
    assert.deepEqual(payload.decision.allowedStatuses, ["keep", "discard", "measure"]);
    assert.equal(payload.decision.suggestedStatus, "keep");
    assert.equal(payload.decision.safeSuggestedStatus, "keep");
    assert.match(payload.decision.statusGuidance, /Safe to consider keep/);
    assert.ok(Array.isArray(payload.decision.lanePortfolio));
    assert.equal(payload.decision.diversityGuidance, null);
    assert.match(payload.nextAction, /Log this run/);
  });
});

test("dashboard renders an operator readout from ASI and failures", async () => {
  await withTempDir("dashboard-readout", async (dir) => {
    await runCli([
      "init",
      "--cwd",
      dir,
      "--name",
      "dashboard readout",
      "--metric-name",
      "seconds",
      "--metric-unit",
      "s",
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "10",
      "--status",
      "keep",
      "--description",
      "Baseline",
      "--asi",
      JSON.stringify({
        hypothesis: "baseline",
        family: "baseline",
        lane: "incumbent-confirmation",
        next_action_hint: "try caching",
      }),
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "7",
      "--status",
      "keep",
      "--description",
      "Cache package metadata",
      "--asi",
      JSON.stringify({
        hypothesis: "metadata cache removes repeated filesystem scans",
        family: "metadata cache",
        lane: "near-neighbor",
        evidence: "seconds improved from 10 to 7",
        next_action_hint: "measure memory impact next",
      }),
    ]);
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "12",
      "--status",
      "discard",
      "--description",
      "Inline all parsing",
      "--asi",
      JSON.stringify({
        family: "parser inlining",
        lane: "near-neighbor",
        rollback_reason: "slower and harder to read",
        next_action_hint: "avoid parser inlining",
      }),
    ]);

    const state = await runCli(["state", "--cwd", dir]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.ok(statePayload.memory.families.length >= 2);
    assert.equal(typeof statePayload.memory.plateau.detected, "boolean");
    assert.equal(typeof statePayload.memory.novelty.score, "number");
    assert.ok(statePayload.memory.lanePortfolio.some((lane) => lane.id === "measurement-quality"));
    assert.ok(statePayload.memory.diversityGuidance);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);
    const dashboard = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");

    assert.match(dashboard, /Codex brief/);
    assert.match(dashboard, /Best kept change/);
    assert.match(dashboard, /Recent failure/);
    assert.match(dashboard, /Next action/);
    assert.match(dashboard, /Parallel exploration board/);
    assert.match(dashboard, /lower is better/);
    assert.ok(payload.viewModel.nextBestAction.detail);
    assert.ok(payload.viewModel.nextBestAction.explanation.why);
    assert.ok(payload.viewModel.nextBestAction.explanation.avoids);
    assert.ok(payload.viewModel.nextBestAction.explanation.proof);
    assert.ok(
      payload.viewModel.nextBestAction.command || payload.viewModel.nextBestAction.safeAction,
    );
    assert.match(payload.viewModel.aiSummary.happened.join(" "), /runs/);
    assert.match(
      payload.viewModel.aiSummary.plan.join(" "),
      /avoid parser inlining|comparison anchor/i,
    );
    assert.equal(payload.viewModel.experimentMemory.latestNextAction, "avoid parser inlining");
    assert.equal(payload.viewModel.portfolio.families.length > 0, true);
    assert.equal(
      payload.viewModel.portfolio.lanes.some((lane) => lane.id === "measurement-quality"),
      true,
    );
    assert.equal(typeof payload.viewModel.portfolio.plateau.detected, "boolean");
    assert.equal(payload.progress.mode, "synchronous");
    assert.equal(payload.progress.status, "completed");
    assert.equal(payload.progress.stages[0].stage, "export");
  });
});

test("dashboard does not recommend next when manual metrics have no benchmark command", async () => {
  await withTempDir("dashboard-manual-no-command", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "manual metrics", "--metric-name", "seconds"]);
    const log = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "5",
      "--status",
      "keep",
      "--description",
      "Manual baseline",
    ]);
    assert.equal(log.code, 0, log.stderr);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);

    assert.equal(payload.viewModel.guidedSetup.stage, "needs-benchmark-command");
    assert.equal(payload.viewModel.setup.defaultBenchmarkCommandReady, false);
    assert.equal(payload.viewModel.nextBestAction.kind, "benchmark-command");
    assert.match(payload.viewModel.nextBestAction.title, /benchmark command/i);
    assert.doesNotMatch(payload.viewModel.nextBestAction.title, /next measured/i);
  });
});

test("dashboard surfaces stale last-run packets before normal next guidance", async () => {
  await withTempDir("dashboard-stale-last-run", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "stale dashboard", "--metric-name", "seconds"]);
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=3')"`;
    const next = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--checks-policy",
      "manual",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const directLog = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "2",
      "--status",
      "keep",
      "--description",
      "Manual run",
    ]);
    assert.equal(directLog.code, 0, directLog.stderr);

    const exportResult = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);
    const payload = JSON.parse(exportResult.stdout);

    assert.equal(payload.viewModel.guidedSetup.stage, "stale-last-run");
    assert.equal(payload.viewModel.lastRun.freshness.fresh, false);
    assert.equal(payload.viewModel.nextBestAction.kind, "stale-packet");
    assert.match(payload.viewModel.guidedSetup.commands.replaceLast, /--command/);
    assert.match(payload.viewModel.guidedSetup.commands.replaceLast, /METRIC seconds=3/);
    assert.match(payload.viewModel.guidedSetup.commands.replaceLast, /--checks-policy "manual"/);
    assert.equal(
      payload.viewModel.nextBestAction.command,
      payload.viewModel.guidedSetup.commands.replaceLast,
    );
    assert.match(payload.viewModel.nextBestAction.detail, /Last-run packet is stale/);
    assert.match(payload.viewModel.readout.nextAction, /Last-run packet is stale/);
  });
});

test("doctor summarizes readiness and detects missing benchmark metrics", async () => {
  await withTempDir("doctor", async (dir) => {
    await runCli(["init", "--cwd", dir, "--name", "doctor", "--metric-name", "seconds"]);

    const command = `${quoteForShell(process.execPath)} -e "console.log('no metric')"`;
    const result = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--command",
      command,
      "--check-benchmark",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.benchmark.checked, true);
    assert.equal(payload.benchmark.emitsPrimary, false);
    assert.equal(payload.benchmark.progress.mode, "synchronous");
    assert.equal(payload.benchmark.progress.status, "failed");
    assert.equal(payload.benchmark.progress.cancellable, false);
    assert.equal(payload.benchmark.progress.stages[0].stage, "benchmark");
    assert.match(payload.issues.join("\n"), /primary metric/);
    assert.match(payload.nextAction, /benchmark/i);
  });
});

test("drift report treats installed routing as removed", async () => {
  const { buildDriftReport } = await import("../lib/drift-doctor.js");
  const report = await buildDriftReport({
    pluginRoot,
    includeInstalled: true,
    inspectInstalled: async () => ({
      ok: true,
      available: false,
      pluginName: "codex-autoresearch",
      confidence: "not-applicable",
    }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.local.version, PLUGIN_VERSION);
  assert.equal(report.local.surfaces.cliRuntime, PLUGIN_VERSION);
  assert.equal(report.installed.available, false);
  assert.deepEqual(report.warnings, []);
});

test("runShell configures a POSIX process group for timeout cleanup", async () => {
  const [cliShim, bootstrap, runner] = await Promise.all([
    readFile(cli, "utf8"),
    readFile(path.join(pluginRoot, "scripts", "bootstrap-runtime.mjs"), "utf8"),
    readFile(path.join(pluginRoot, "lib", "runner.ts"), "utf8"),
  ]);
  assert.match(cliShim, /import \{ ensureRuntime \} from "\.\/bootstrap-runtime\.mjs"/);
  assert.match(
    cliShim,
    /await import\(await ensureRuntime\("autoresearch\.mjs", import\.meta\.url\)\)/,
  );
  assert.match(bootstrap, /path\.join\(pluginRoot, "dist", "scripts", entrypoint\)/);
  assert.match(bootstrap, /node scripts\/autoresearch\.mjs --help/);
  assert.match(runner, /detached:\s*process\.platform !== "win32"/);
});
