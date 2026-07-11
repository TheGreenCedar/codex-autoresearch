import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertNoSensitiveEvidence,
  git,
  pluginRoot,
  repoRoot,
  runCli,
  setupFixture,
  withLiveServer,
  withTempDir,
} from "./helpers.js";

test("release workflows preserve synchronized auto-release and tarball safeguards", async () => {
  const autoRelease = await readFile(
    path.join(repoRoot, ".github", "workflows", "auto-release.yml"),
    "utf8",
  );
  const release = await readFile(
    path.join(repoRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const ci = await readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const maintainers = await readFile(path.join(pluginRoot, "docs", "maintainers.md"), "utf8");
  const packageSmoke = await readFile(
    path.join(pluginRoot, "lib", "checks", "package-smoke.ts"),
    "utf8",
  );
  const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
  const codeql = await readFile(path.join(repoRoot, ".github", "workflows", "codeql.yml"), "utf8");

  assert.match(autoRelease, /branches:\s*\n\s*-\s*main/);
  assert.match(autoRelease, /plugins\/codex-autoresearch\/package\.json/);
  assert.match(autoRelease, /plugins\/codex-autoresearch\/package-lock\.json/);
  assert.match(autoRelease, /plugins\/codex-autoresearch\/\.codex-plugin\/plugin\.json/);
  assert.match(autoRelease, /CHANGELOG\.md/);
  assert.match(autoRelease, /contents:\s*read/);
  assert.match(autoRelease, /Version surfaces are not synchronized/);
  assert.match(autoRelease, /uses:\s*\.\/\.github\/workflows\/release\.yml/);

  assert.doesNotMatch(release, /push:\s*\n\s*tags:/);
  assert.match(release, /os:\s*\[ubuntu-latest,\s*windows-latest,\s*macos-latest\]/);
  assert.match(release, /npm run check/);
  for (const workflow of [ci, release]) {
    assert.match(workflow, /npx playwright install --with-deps chromium firefox webkit/);
    assert.match(workflow, /npm run test:dashboard:cross-browser/);
    assert.match(
      workflow,
      /actions\/upload-artifact@[0-9a-f]{40}[\s\S]*tmp\/dashboard-cross-browser\//,
    );
  }
  assert.equal(
    packageJson.scripts["test:dashboard:cross-browser"],
    "npm run build:dashboard && node --test tests/dashboard-cross-browser.test.mjs",
  );
  assert.match(packageJson.devDependencies.playwright, /^\^1\./);
  assert.equal(packageJson.devDependencies["@playwright/test"], undefined);
  assert.match(maintainers, /Automation does not prove spoken output/);
  assert.match(maintainers, /pass\/fail\/needs-follow-up/);
  assert.match(maintainers, /do not turn an unrecorded or partial pass into a compliance claim/);
  assert.match(release, /node scripts\/autoresearch\.mjs --help/);
  assert.match(release, /Refuse existing tag or release/);
  assert.match(release, /npm pack/);
  assert.match(release, /--phase release-package-smoke/);
  assert.match(packageSmoke, /"scripts\/check\.mjs"/);
  assert.match(packageSmoke, /"dist\/scripts\/check\.mjs"/);
  assert.match(packageSmoke, /"dist\/lib\/checks\/package-smoke\.mjs"/);
  assert.match(packageSmoke, /runPackageRuntimeSmokeFromTarball/);
  assert.match(packageSmoke, /runExtractedPackageDashboardExportSmoke/);
  assert.match(packageSmoke, /check-source-hygiene/);
  assert.match(packageSmoke, /"--phase", "source-hygiene"/);
  assert.match(packageSmoke, /ALLOWED_PACKAGED_SOURCE_SCRIPTS/);
  assert.match(packageSmoke, /ALLOWED_PACKAGED_DIST_SCRIPTS/);
  assert.equal(packageJson.files.includes("dist/scripts/"), false);
  assert.equal(packageJson.files.includes("scripts/*.mjs"), false);
  for (const file of [
    "dist/scripts/autoresearch.mjs",
    "dist/scripts/check.mjs",
    "dist/scripts/check-runner.mjs",
    "dist/scripts/finalize-autoresearch.mjs",
    "scripts/autoresearch.mjs",
    "scripts/bootstrap-runtime.mjs",
    "scripts/check.mjs",
    "scripts/directory-swap.mjs",
    "scripts/finalize-autoresearch.mjs",
    "scripts/release-integrity.mjs",
  ]) {
    assert.ok(packageJson.files.includes(file), `${file} is explicitly packaged`);
  }
  assert.match(release, /gh release create/);
  assert.match(release, /--target "\$GITHUB_SHA"/);

  assert.match(codeql, /pull_request:/);
  assert.match(codeql, /branches:\s*\n\s*-\s*main\s*\n\s*-\s*dev/);
});

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
    await setupFixture(dir, { name: "preview" });
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "session"]);
    await writeFile(path.join(dir, "src", "value.txt"), "kept\n");
    const keep = await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      "Keep value",
      "--commit-paths",
      "src",
    ]);
    assert.equal(keep.code, 0, keep.stderr);
    await git(dir, ["add", "autoresearch.jsonl"]);
    await git(dir, ["commit", "-m", "record run"]);

    const preview = await runCli(["finalize-preview", "--cwd", dir]);
    assert.equal(preview.code, 0, preview.stderr);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, true);
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
    await setupFixture(dir, { name: "live" });
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

    const exported = await runCli(["export", "--cwd", dir, "--json-full"]);
    assert.equal(exported.code, 0, exported.stderr);
    const exportPayload = JSON.parse(exported.stdout);
    assert.equal(exportPayload.decisionEnvelopeSummary.kind, "benchmark-command");
    assert.equal(exportPayload.decisionEnvelopeSummary.runs, 1);

    await withLiveServer(dir, async (payload) => {
      assert.equal(payload.modeGuidance.deliveryMode, "live-server");
      assert.equal(payload.verified, true);
      assert.equal(payload.decisionEnvelopeSummary, null);
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
      assert.equal(viewModel.ledgerEntries.length, 2);
      assert.equal(viewModel.ledgerEntries[0].type, "config");
      assert.equal(viewModel.ledgerEntries[1].description, "Baseline");
    });
  });
});

test("dashboard export and live endpoints redact sensitive evidence", async () => {
  await withTempDir("dashboard-redaction", async (dir) => {
    await setupFixture(dir, { name: "redacted live" });
    const sensitiveEvidence = [
      "api_key=abcdefghijklmnop",
      "Bearer zyxwvutsrqponmlkjihgfedcba",
      "https://user:pass@example.com/path",
      "C:\\Users\\Alice\\.env.local",
      "/home/alice/.env",
      "Error: failed\n    at leak (C:\\Users\\Alice\\repo\\src\\secret.ts:1:2)",
    ].join(" ");
    await runCli([
      "log",
      "--cwd",
      dir,
      "--metric",
      "1",
      "--status",
      "keep",
      "--description",
      `Baseline ${sensitiveEvidence}`,
      "--asi",
      JSON.stringify({
        hypothesis: `Try the secret-bearing path ${sensitiveEvidence}`,
        evidence: sensitiveEvidence,
        next_action_hint: `Continue without leaking ${sensitiveEvidence}`,
      }),
    ]);

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
    await setupFixture(dir, { name: "live log" });
    const benchmarkFile = process.platform === "win32" ? "autoresearch.ps1" : "autoresearch.sh";
    const benchmarkBody =
      process.platform === "win32"
        ? 'Write-Output "METRIC seconds=2"\n'
        : "#!/bin/sh\nprintf 'METRIC seconds=2\\n'\n";
    await writeFile(path.join(dir, benchmarkFile), benchmarkBody, "utf8");
    const next = await runCli(["next", "--cwd", dir]);
    assert.equal(next.code, 0, next.stderr);
    const packet = JSON.parse(next.stdout);
    assert.equal(packet.continuation.stage, "needs-log-decision");

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
