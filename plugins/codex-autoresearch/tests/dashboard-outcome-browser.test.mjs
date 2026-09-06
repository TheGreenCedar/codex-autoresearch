import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { chromium, firefox, webkit } from "playwright";
import { startOutcome, readOutcomeBytes } from "../dist/lib/outcome-store.mjs";
import {
  nominateOutcomeAction,
  logOutcomeObservation,
} from "../dist/lib/investigation-workflow.mjs";
import { governedFixture, actionFixture } from "../dist/tests/helpers/outcome-fixtures.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

test(
  "nonnumeric outcome export preserves canonical decisions and audit evidence in three browsers",
  { timeout: 120_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "autoresearch-outcome-browser-"));
    const outputDir = path.join(pluginRoot, "tmp", "dashboard-outcome");
    await mkdir(outputDir, { recursive: true });
    try {
      await startOutcome(cwd, {
        ...governedFixture(cwd),
        objective: "Restore compatible parser output",
        budget: { actions: 4, executionSeconds: 1200 },
      });
      await nominateOutcomeAction(cwd, { ...actionFixture("A1"), seconds: 300 });
      await logOutcomeObservation(cwd, {
        id: "E1",
        executionId: "A1",
        criterionId: "compatibility",
        text: "The legacy example returned a counterexample.",
        observation: { kind: "predicate", observed: "counterexample" },
        completed: true,
        resolution: "refuted",
      });
      await nominateOutcomeAction(cwd, {
        ...actionFixture("A2"),
        seconds: 300,
        purpose: "preparation",
        evaluator: null,
        investigation: {
          ...actionFixture("A2").investigation,
          id: "H2",
          question: "Does the narrower fix preserve all examples?",
          evidenceRefs: ["E1"],
        },
        evidenceRefs: ["E1"],
      });
      const before = await readOutcomeBytes(cwd);
      const cli = path.join(pluginRoot, "scripts/autoresearch.mjs");
      const state = JSON.parse((await run(process.execPath, [cli, "state", "--cwd", cwd])).stdout);
      const exported = JSON.parse(
        (await run(process.execPath, [cli, "export", "--cwd", cwd])).stdout,
      );
      assert.deepEqual(await readOutcomeBytes(cwd), before, "Export changed outcome state");
      const afterExport = JSON.parse(
        (await run(process.execPath, [cli, "state", "--cwd", cwd])).stdout,
      );
      assert.equal(afterExport.resolvedDecision.decisionId, state.resolvedDecision.decisionId);
      await assert.rejects(
        run(process.execPath, [
          cli,
          "export",
          "--cwd",
          cwd,
          "--output",
          path.join(cwd, "subject.html"),
        ]),
      );
      assert.equal(state.investigation.status, "active");
      assert.equal(state.criterionCoverage[0].covered, false);
      for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
        const browser = await engine.launch({ headless: true });
        try {
          const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
          await page.goto(pathToFileURL(exported.output).href);
          await page.locator("#outcome-objective").waitFor();
          assert.equal(
            await page.locator("#outcome-objective").innerText(),
            state.investigation.objective,
          );
          assert.equal(
            await page.locator("#outcome-status").innerText(),
            state.investigation.status,
          );
          assert.equal(
            await page.locator("#outcome-question").innerText(),
            state.investigation.question,
          );
          assert.equal(
            await page.locator("#next-action-detail").innerText(),
            state.resolvedDecision.nextAction,
          );
          assert.match(await page.locator("#outcome-allowance").innerText(), /2 actions/);
          assert.equal(await page.locator("#trend-panel").count(), 0);
          assert.equal(await page.locator("#outcome-unresolved").innerText(), "compatibility");
          await page.screenshot({
            path: path.join(outputDir, `${name}-desktop.png`),
            fullPage: true,
          });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.screenshot({
            path: path.join(outputDir, `${name}-mobile.png`),
            fullPage: true,
          });
          await page.locator("#view-toggle").click();
          assert.equal(
            await page.locator("#decision-plan-decision-id").innerText(),
            state.resolvedDecision.decisionId,
          );
          assert.match(
            await page.locator('[aria-label="Governed outcome"]').innerText(),
            /counterexample/,
          );
          assert.doesNotMatch(
            await page.locator("body").innerText(),
            /capture a baseline|Run a baseline|lower is better|Promotion proof/i,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            true,
            `${name} mobile overflow`,
          );
          await page.screenshot({
            path: path.join(outputDir, `${name}-audit-mobile.png`),
            fullPage: true,
          });
        } finally {
          await browser.close();
        }
      }
      assert.deepEqual(await readOutcomeBytes(cwd), before);
      await readFile(exported.output);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("delivered outcome stays satisfied after export and shows no further command", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "autoresearch-delivered-browser-"));
  let browser;
  try {
    const base = governedFixture(cwd);
    await startOutcome(cwd, {
      ...base,
      authorization: { ...base.authorization, delivery: "answer" },
      budget: { actions: 2, executionSeconds: 600 },
    });
    await nominateOutcomeAction(cwd, { ...actionFixture("A1"), seconds: 300 });
    await logOutcomeObservation(cwd, {
      id: "E1",
      executionId: "A1",
      criterionId: "compatibility",
      text: "Synthetic criterion satisfied.",
      observation: { kind: "predicate", observed: "satisfied" },
      completed: true,
    });
    await nominateOutcomeAction(cwd, {
      ...actionFixture("A2"),
      seconds: 300,
      purpose: "delivery",
      evaluator: null,
    });
    const { logOutcomeDelivery } = await import("../dist/lib/outcome-delivery.mjs");
    await logOutcomeDelivery(cwd, {
      id: "D1",
      executionId: "A2",
      delivery: { answer: "The synthetic criterion is satisfied by the recorded observation." },
    });
    const cli = path.join(pluginRoot, "scripts/autoresearch.mjs");
    const before = JSON.parse((await run(process.execPath, [cli, "state", "--cwd", cwd])).stdout);
    const exported = JSON.parse(
      (await run(process.execPath, [cli, "export", "--cwd", cwd])).stdout,
    );
    const after = JSON.parse(
      (await run(process.execPath, [cli, "finalize-preview", "--cwd", cwd])).stdout,
    );
    assert.equal(before.investigation.status, "satisfied");
    assert.equal(after.resolvedDecision.decisionId, before.resolvedDecision.decisionId);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(exported.output).href);
    await page.locator("#outcome-status").waitFor();
    assert.equal(await page.locator("#outcome-status").innerText(), "satisfied");
    assert.equal(await page.locator("#decision-status").innerText(), "Satisfied");
    assert.equal(
      await page.locator("#decision-next-command").innerText(),
      "No further command required.",
    );
    await page.screenshot({
      path: path.join(pluginRoot, "tmp/dashboard-outcome/chromium-satisfied.png"),
      fullPage: true,
    });
  } finally {
    await browser?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
