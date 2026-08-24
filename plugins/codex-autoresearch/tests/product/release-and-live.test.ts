import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertNoSensitiveEvidence,
  git,
  runCli,
  setupFixture,
  withLiveServer,
  withTempDir,
} from "./helpers.js";

const secondsOneBenchmark = `${JSON.stringify(process.execPath)} -e "console.log('METRIC seconds=1')"`;
const valueFileBenchmark = `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs'); const value=fs.readFileSync('src/value.txt','utf8').trim(); console.log('METRIC seconds='+(value==='kept'?1:2))"`;

function requiredEvidenceCodes(plan) {
  return plan.requiredEvidence.diagnosticCodes;
}

test("finalize-preview summarizes kept commits without creating branches", async () => {
  await withTempDir("finalize-preview", async (dir) => {
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "codex@example.test"]);
    await git(dir, ["config", "user.name", "Codex Test"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "value.txt"), "base\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "base"]);
    await git(dir, ["branch", "develop"]);

    await git(dir, ["switch", "-c", "codex/autoresearch-preview"]);
    await setupFixture(dir, {
      name: "preview",
      completeContract: true,
      benchmarkCommand: valueFileBenchmark,
    });
    const configPath = path.join(dir, "autoresearch.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ...config,
          checksAuthoritative: true,
          noiseModel: { kind: "deterministic" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "session"]);
    const accepted = await runCli([
      "new-segment",
      "--cwd",
      dir,
      "--reason",
      "Accept the finalization fixture contract",
      "--yes",
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);
    const baselinePacket = await runCli(["next", "--cwd", dir]);
    assert.equal(baselinePacket.code, 0, baselinePacket.stderr);
    const baseline = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Reference measurement",
    ]);
    assert.equal(baseline.code, 0, baseline.stderr);
    await writeFile(path.join(dir, "src", "value.txt"), "kept\n");
    const candidate = await runCli(["next", "--cwd", dir]);
    assert.equal(candidate.code, 0, candidate.stderr);
    const candidatePayload = JSON.parse(candidate.stdout);
    assert.equal(
      candidatePayload.decision.allowedStatuses.includes("keep"),
      true,
      JSON.stringify(candidatePayload.run.contractKeepEligibility, null, 2),
    );
    const keep = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "keep",
      "--description",
      "Keep value",
      "--commit-paths",
      "src",
    ]);
    assert.equal(keep.code, 0, keep.stderr);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "record run"]);

    const preview = await runCli(["finalize-preview", "--cwd", dir]);
    assert.equal(preview.code, 0, preview.stderr);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.progress.mode, "synchronous");
    assert.equal(payload.progress.status, "completed");
    assert.equal(payload.progress.stages[0].stage, "finalize-preview");
    assert.equal(payload.groups.length, 1);
    assert.deepEqual(payload.groups[0].files, ["src/value.txt"]);

    const developPreview = await runCli(["finalize-preview", "--cwd", dir, "--trunk", "develop"]);
    assert.equal(developPreview.code, 0, developPreview.stderr);
    assert.match(
      JSON.parse(developPreview.stdout).suggestedCommand,
      /--trunk (?:'develop'|"develop"|develop)\b/,
    );

    const branches = await git(dir, ["branch", "--list", "autoresearch-review/*"]);
    assert.equal(branches, "");
  });
});

test("live server exposes health and view-model endpoints", async () => {
  await withTempDir("live-server", async (dir) => {
    await setupFixture(dir, {
      name: "live",
      acceptedContract: true,
      benchmarkCommand: secondsOneBenchmark,
    });
    const baselinePacket = await runCli(["next", "--cwd", dir]);
    assert.equal(baselinePacket.code, 0, baselinePacket.stderr);
    const baseline = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      "Baseline",
    ]);
    assert.equal(baseline.code, 0, baseline.stderr);

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    const exportPlan = exportPayload.viewModel.decisionPlanProjection;
    assert.equal(exportPlan.kind, "dashboard-decision-plan-projection");
    assert.equal(exportPlan.action.kind, "direct-work");
    assert.equal(exportPlan.capabilities["run-packet"], "allowed");
    assert.equal(exportPlan.capabilities.finalize, "blocked");
    assert.equal(exportPlan.loopDisposition.kind, "continue");
    assert.equal(exportPlan.parentDisposition.kind, "hand-back");
    assert.ok(requiredEvidenceCodes(exportPlan).includes("finalization-blocked"));

    await withLiveServer(dir, async (payload) => {
      assert.equal(payload.modeGuidance.deliveryMode, "live-server");
      assert.equal(payload.verified, true);
      assert.match(
        payload.deferredViewModel.availableAt,
        /^http:\/\/127\.0\.0\.1:\d+\/view-model\.json$/,
      );
      assert.match(payload.healthUrl, /^http:\/\/127\.0\.0\.1:\d+\/health$/);
      assert.match(payload.modeGuidance.difference, /read-only snapshots|fallback snapshot/);
      const health = await fetch(`${payload.url}health`).then((res) => res.json());
      assert.equal(health.ok, true);
      const ledger = await fetch(`${payload.url}autoresearch.jsonl`);
      assert.equal(ledger.status, 404);
      const ledgerBody = await ledger.json();
      assert.match(ledgerBody.error, /--debug-ledger/);
      const html = await fetch(payload.url).then((res) => res.text());
      assert.match(html, /"deliveryMode":"live-server"/);
      const embeddedEntries = JSON.parse(
        html.match(
          /window\.__AUTORESEARCH_DATA__ = ([\s\S]*?);\nwindow\.__AUTORESEARCH_META__/,
        )?.[1] || "null",
      );
      assert.deepEqual(embeddedEntries, []);
      for (const forbidden of [
        "Live actions available",
        "live-actions-panel",
        "action-receipt",
        "actionNonce",
        "X-Autoresearch-Action-Nonce",
        "/actions/",
      ]) {
        assert.equal(html.includes(forbidden), false, `live dashboard exposed ${forbidden}`);
      }
      const viewModel = await fetch(`${payload.url}view-model.json`).then((res) => res.json());
      assert.equal(viewModel.summary.runs, 1);
      assert.equal(Array.isArray(viewModel.ledgerEntries), true);
      assert.ok(viewModel.ledgerEntries.some((entry) => entry.type === "config"));
      assert.ok(viewModel.ledgerEntries.some((entry) => entry.description === "Baseline"));
      assert.equal(viewModel.decisionPlanProjection.decisionId, exportPlan.decisionId);
      assert.equal(viewModel.decisionPlanProjection.action.kind, exportPlan.action.kind);
      assert.equal(
        viewModel.decisionPlanProjection.primaryBlockerCode,
        exportPlan.primaryBlockerCode,
      );
    });
  });
});

test("dashboard export and live endpoints redact sensitive evidence", async () => {
  await withTempDir("dashboard-redaction", async (dir) => {
    await setupFixture(dir, {
      name: "redacted live",
      acceptedContract: true,
      benchmarkCommand: secondsOneBenchmark,
    });
    const sensitiveEvidence = [
      "api_key=abcdefghijklmnop",
      "Bearer zyxwvutsrqponmlkjihgfedcba",
      "https://user:pass@example.com/path",
      "C:\\Users\\Alice\\.env.local",
      "/home/alice/.env",
      "Error: failed\n    at leak (C:\\Users\\Alice\\repo\\src\\secret.ts:1:2)",
    ].join(" ");
    const baselinePacket = await runCli(["next", "--cwd", dir]);
    assert.equal(baselinePacket.code, 0, baselinePacket.stderr);
    const baseline = await runCli([
      "log",
      "--cwd",
      dir,
      "--from-last",
      "--status",
      "measure",
      "--description",
      `Baseline ${sensitiveEvidence}`,
      "--asi",
      JSON.stringify({
        hypothesis: `Try the secret-bearing path ${sensitiveEvidence}`,
        evidence: sensitiveEvidence,
        next_action_hint: `Continue without leaking ${sensitiveEvidence}`,
      }),
    ]);
    assert.equal(baseline.code, 0, baseline.stderr);

    const exported = await runCli(["export", "--cwd", dir]);
    assert.equal(exported.code, 0, exported.stderr);
    const html = await readFile(path.join(dir, "autoresearch-dashboard.html"), "utf8");
    assertNoSensitiveEvidence(html);

    await withLiveServer(dir, async (payload) => {
      const html = await fetch(payload.url).then((res) => res.text());
      const viewModel = await fetch(`${payload.url}view-model.json`).then((res) => res.json());
      const viewModelText = JSON.stringify(viewModel);
      const ledger = await fetch(`${payload.url}autoresearch.jsonl`);

      assertNoSensitiveEvidence(html);
      assertNoSensitiveEvidence(viewModelText);
      assert.equal(Array.isArray(viewModel.ledgerEntries), true);
      assert.match(JSON.stringify(viewModel.ledgerEntries), /api_key=<redacted>/);
      assert.equal(ledger.status, 404);
    });

    await withLiveServer(
      dir,
      async (payload) => {
        assert.equal(payload.debugLedger.enabled, true);
        const jsonl = await fetch(`${payload.url}autoresearch.jsonl`).then((res) => res.text());
        const viewModel = await fetch(`${payload.url}view-model.json`).then((res) => res.json());
        const viewModelText = JSON.stringify(viewModel);

        assertNoSensitiveEvidence(jsonl);
        assertNoSensitiveEvidence(viewModelText);
        assert.match(jsonl, /api_key=<redacted>/);
        assert.match(jsonl, /Bearer <redacted>/);
        assert.match(jsonl, /https:\/\/<credentials>@example\.com/);
        assert.match(viewModelText, /<env-file>/);
        assert.match(`${jsonl}\n${viewModelText}`, /<stack-frame>/);
        assert.doesNotMatch(`${jsonl}\n${viewModelText}`, /secret\.ts/);
      },
      ["--debug-ledger"],
    );
  });
});

test("live server has no dashboard action routes because CLI owns mutations", async () => {
  await withTempDir("live-gap-action", async (dir) => {
    await runCli([
      "research-setup",
      "--cwd",
      dir,
      "--slug",
      "Custom Study",
      "--goal",
      "Study live gaps",
    ]);

    await withLiveServer(dir, async (payload) => {
      const action = await fetch(`${payload.url}actions/gap-candidates`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: new URL(payload.url).origin },
        body: JSON.stringify({}),
      });
      assert.equal(action.status, 404);
      const body = await action.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "Not found");
    });
  });
});

test("live server log actions stay disabled and leave last-run packets untouched", async () => {
  await withTempDir("live-log-action", async (dir) => {
    const benchmarkCommand = `${JSON.stringify(process.execPath)} -e "console.log('METRIC seconds=2')"`;
    await setupFixture(dir, {
      name: "live log",
      acceptedContract: true,
      benchmarkCommand,
    });
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.resultingDecision.action.kind, "log-decision");
    assert.equal(packet.resultingDecision.primaryBlockerCode, "pending-packet");
    assert.equal(packet.resultingDecision.capabilities["run-packet"], "blocked");
    assert.equal(packet.resultingDecision.capabilities["mutate-session"], "allowed");
    assert.equal(packet.resultingDecision.loopDisposition.kind, "blocked");
    assert.equal(packet.resultingDecision.parentDisposition.kind, "hand-back");
    assert.ok(requiredEvidenceCodes(packet.resultingDecision).includes("pending-packet"));

    await withLiveServer(dir, async (payload) => {
      const viewModel = await fetch(`${payload.url}view-model.json`).then((res) => res.json());
      assert.equal(viewModel.missionControl.logDecision.available, true);

      const action = await fetch(`${payload.url}actions/log-keep`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: new URL(payload.url).origin },
        body: JSON.stringify({
          confirm: "log-keep",
          lastRunFingerprint: viewModel.missionControl.logDecision.lastRunFingerprint,
          description: "Live kept packet",
          asi: {
            hypothesis: "Live packet improved the metric.",
            evidence: "seconds=2",
            next_action_hint: "Review finalization.",
          },
        }),
      });
      assert.equal(action.status, 404);
      const actionBody = await action.json();
      assert.equal(actionBody.ok, false);
      assert.equal(actionBody.error, "Not found");

      const state = JSON.parse((await runCli(["state", "--cwd", dir])).stdout);
      assert.equal(state.runs, 0);
      assert.equal(state.kept, 0);
    });
  });
});
