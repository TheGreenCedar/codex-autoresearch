import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { dashboardHtml, serveHtml } from "./dashboard-browser-fixture.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(pluginRoot, "tmp", "dashboard-cross-browser");

test(
  "Chromium, Firefox, and WebKit preserve release-critical served and static dashboard behavior",
  { timeout: 180_000 },
  async () => {
    await rm(evidenceDir, { recursive: true, force: true });
    await mkdir(evidenceDir, { recursive: true });
    const fixture = await dashboardHtml();

    for (const [browserName, browserType] of Object.entries({ chromium, firefox, webkit })) {
      await exerciseBrowser(browserName, browserType, fixture);
    }

    console.log(`ARTIFACT dashboard_cross_browser_evidence=${evidenceDir}`);
  },
);

async function exerciseBrowser(browserName, browserType, fixture) {
  const staticDir = await mkdtemp(path.join(tmpdir(), `autoresearch-${browserName}-`));
  const staticPath = path.join(staticDir, "autoresearch-dashboard.html");
  let server;
  let browser;

  try {
    server = await serveHtml(fixture.html, fixture.failureHtml, fixture.livePayload);
    await writeFile(staticPath, fixture.staticHtml);
    browser = await browserType.launch({ headless: true });
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await desktop.newPage();
      await page.goto(server.url);
      await waitForDashboard(page);
      await page.locator("#ledger-body").getByText("#5001", { exact: true }).waitFor();
      await assertDashboardShape(page, "Page 1 of 251");

      await page.locator("#refresh-now").click();
      await page.locator("#refresh-now:disabled").waitFor();
      await page.locator("#refresh-now:enabled").waitFor();

      const range = page.locator("#trend-chart-range");
      await range.focus();
      const selectedRun = await range.getAttribute("data-chart-run");
      await range.press("ArrowLeft");
      assert.notEqual(await range.getAttribute("data-chart-run"), selectedRun);
      await range.press("Enter");
      const dialog = page.locator('[role="dialog"][aria-modal="true"]');
      await dialog.waitFor();
      assert.equal(
        await page.locator(".modal-close").evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await page.waitForFunction(() => document.activeElement?.id === "trend-chart-range");

      await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
      assert.equal(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), true);
      assert.equal(
        await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
        true,
      );
      const reducedMotion = await page.locator(".chart-open-details").evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
          transitionDuration: style.transitionDuration,
        };
      });
      assert.equal(reducedMotion.scrollBehavior, "auto");
      assert.ok(
        reducedMotion.transitionDuration
          .split(",")
          .every((value) => ["0.001ms", "1e-06s", "0.000001s"].includes(value.trim())),
        `${browserName} reduced transition duration: ${reducedMotion.transitionDuration}`,
      );
      await page.screenshot({
        path: path.join(evidenceDir, `${browserName}-served-forced-colors.png`),
        fullPage: true,
      });
    } finally {
      await desktop.close();
    }

    const mobile = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await mobile.newPage();
      await page.goto(pathToFileURL(staticPath).href);
      await waitForDashboard(page);
      await assertDashboardShape(page, "Page 1 of 250");
      assert.equal(await page.locator("#copy-dashboard-url").isHidden(), true);
      assert.match(
        await page.locator("#static-share-guidance").innerText(),
        /Share this HTML file/,
      );

      const touchTargets = await page
        .locator("#trend-chart-range, .chart-open-details, .ledger-pagination button")
        .evaluateAll((nodes) =>
          nodes
            .map((node) => node.getBoundingClientRect())
            .map(({ width, height }) => ({ width, height })),
        );
      assert.ok(
        touchTargets.every(({ width, height }) => width >= 44 && height >= 44),
        `${browserName} touch targets: ${JSON.stringify(touchTargets)}`,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      const olderRuns = page.getByRole("button", { name: "Older runs" });
      await page.evaluate(() => scrollTo(0, 0));
      await olderRuns.tap();
      await page.waitForFunction(
        (expected) =>
          document
            .querySelector('.ledger-pagination [aria-current="page"]')
            ?.textContent?.trim() === expected,
        "Page 2 of 250",
      );
      assert.ok(await page.evaluate(() => scrollY > 0), `${browserName} tap did not scroll`);
      await page.getByRole("button", { name: "Newer runs" }).tap();
      await page.waitForFunction(
        (expected) =>
          document
            .querySelector('.ledger-pagination [aria-current="page"]')
            ?.textContent?.trim() === expected,
        "Page 1 of 250",
      );

      await page.locator(".chart-open-details").tap();
      await page.locator('[role="dialog"][aria-modal="true"]').waitFor();
      const closeTarget = await page.locator(".modal-close").evaluate((node) => {
        const { width, height } = node.getBoundingClientRect();
        return { width, height };
      });
      assert.ok(closeTarget.width >= 44 && closeTarget.height >= 44, JSON.stringify(closeTarget));
      await page.locator(".modal-close").tap();
      await page.screenshot({
        path: path.join(evidenceDir, `${browserName}-static-touch.png`),
        fullPage: true,
      });
    } finally {
      await mobile.close();
    }

    const reflowServer = await serveHtml(fixture.html, fixture.failureHtml, fixture.livePayload);
    let reflow;
    try {
      reflow = await browser.newContext({ viewport: { width: 640, height: 800 } });
      const page = await reflow.newPage();
      await page.goto(reflowServer.url);
      await waitForDashboard(page);
      await page.waitForFunction(() => {
        const text = document.querySelector("#last-good-status strong")?.textContent?.trim();
        return Boolean(text && text !== "Initial snapshot");
      });
      assert.equal(await page.locator("main").getAttribute("aria-busy"), "false");
      assert.equal(await page.locator("#live-region").getAttribute("role"), "status");
      assert.match(await page.locator("#live-title").innerText(), /Live readout refreshed/i);
      assert.match(await page.locator("#runs-value").innerText(), /5001/);
      for (const [zoom, width] of [
        [200, 640],
        [400, 320],
      ]) {
        await page.setViewportSize({ width, height: 800 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        assert.equal(await page.locator("#trend-chart-range").isVisible(), true);
        await page.screenshot({
          path: path.join(evidenceDir, `${browserName}-served-${zoom}-percent-reflow.png`),
          fullPage: true,
        });
      }
    } finally {
      await reflow?.close();
      await reflowServer.close();
    }
  } finally {
    await browser?.close();
    await server?.close();
    await rm(staticDir, { recursive: true, force: true });
  }
}

async function waitForDashboard(page) {
  await page.locator('#dashboard-root[data-dashboard-state="ready"]').waitFor();
  await page.locator("#trend-chart-range").waitFor();
}

async function assertDashboardShape(page, expectedPage) {
  assert.equal(await page.locator("#ledger-body tr").count(), 20);
  assert.equal(
    (await page.locator('.ledger-pagination [aria-current="page"]').innerText()).trim(),
    expectedPage,
  );
  assert.equal(await page.locator('#trend-chart input[type="range"]').count(), 1);
  assert.ok(await page.locator("#trend-chart-range").getAttribute("aria-valuetext"));
}
