import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathExists } from "../helpers/cli-session.js";
import { quoteForShell } from "../helpers/process.js";

import { runCli, withTempDir } from "../helpers/cli-test-context.js";

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

test("research-start dry-run prints the full qualitative loop start plan", async () => {
  await withTempDir("research-start-dry-run", async (dir) => {
    const result = await runCli([
      "research-start",
      "--cwd",
      dir,
      "--slug",
      "language-support",
      "--goal",
      "Improve language support in CodeStory",
      "--checks-command",
      `${quoteForShell(process.execPath)} -e "process.exit(0)"`,
      "--dry-run",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.slug, "language-support");
    assert.equal(payload.metricName, "quality_gap");
    assert.match(payload.commands.setup, /\bresearch-setup\b/);
    assert.match(payload.commands.benchmarkLint, /\bbenchmark-lint\b/);
    assert.match(payload.commands.doctor, /\bdoctor\b.*--check-benchmark/);
    assert.match(payload.commands.baseline, /(?:^|\s)next(?:\s|$).*--compact/);
    assert.match(payload.commands.logBaseline, /\blog\b.*--status measure/);
    assert.match(payload.commands.resume, /\brecommend-next\b.*--compact/);
    assert.equal(await pathExists(path.join(dir, "autoresearch.config.json")), false);
  });
});

test("research-start creates a quality-gap session and can skip baseline logging", async () => {
  await withTempDir("research-start-baseline", async (dir) => {
    const result = await runCli([
      "research-start",
      "--cwd",
      dir,
      "--slug",
      "language-support",
      "--goal",
      "Improve language support in CodeStory",
      "--no-baseline-log",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metricName, "quality_gap");
    assert.equal(payload.baselineLogged, false);
    const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
    assert.equal(config.metricName, "quality_gap");
    assert.match(config.benchmarkCommand, /autoresearch\.(ps1|sh)/);
    assert.equal(
      await pathExists(
        path.join(dir, "autoresearch.research", "language-support", "quality-gaps.md"),
      ),
      true,
    );
  });
});

test("research-start skip-init skips default baseline logging cleanly", async () => {
  await withTempDir("research-start-skip-init", async (dir) => {
    const result = await runCli([
      "research-start",
      "--cwd",
      dir,
      "--slug",
      "language-support",
      "--goal",
      "Improve language support in CodeStory",
      "--skip-init",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.baselineLogged, false);
    assert.match(payload.baselineSkippedReason, /skip-init/i);
    assert.equal(payload.setup.init, null);
    assert.equal(payload.benchmarkLint.ok, true);
    assert.equal(payload.benchmarkLint.metricName, "quality_gap");
    assert.equal(payload.doctor.benchmark.emitsPrimary, true);
    assert.equal(await pathExists(path.join(dir, "autoresearch.last-run.json")), false);
    assert.equal(await pathExists(path.join(dir, "autoresearch.jsonl")), false);
    assert.equal(await pathExists(path.join(dir, "autoresearch.config.json")), true);
    assert.equal(
      await pathExists(
        path.join(dir, "autoresearch.research", "language-support", "quality-gaps.md"),
      ),
      true,
    );
  });
});

test("research-start default baseline logging keeps benchmark command authority aligned", async () => {
  await withTempDir("research-start-default-baseline", async (dir) => {
    const result = await runCli([
      "research-start",
      "--cwd",
      dir,
      "--slug",
      "language-support",
      "--goal",
      "Improve language support in CodeStory",
      "--json",
    ]);

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.baselineLogged, true);

    const config = JSON.parse(await readFile(path.join(dir, "autoresearch.config.json"), "utf8"));
    const baselineCommand = payload.baselinePacket?.run?.command;
    const baselineIdentityCommand =
      payload.baselinePacket?.packetEvidence?.commandIdentity?.command;
    assert.equal(config.benchmarkCommand, baselineCommand);
    assert.equal(config.benchmarkCommand, baselineIdentityCommand);
    assert.match(config.benchmarkCommand, /autoresearch\.(ps1|sh)/);

    const ledger = (await readFile(path.join(dir, "autoresearch.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const measureEntry = ledger.find((entry) => entry.status === "measure");
    assert.ok(measureEntry);
    assert.equal(measureEntry.benchmarkContract?.command, config.benchmarkCommand);
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
