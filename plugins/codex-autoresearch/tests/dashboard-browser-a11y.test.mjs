import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dashboardHtml, serveHtml } from "./dashboard-browser-fixture.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotPath = path.join(pluginRoot, "tmp", "dashboard-browser-a11y-modal.png");
const payloadFailureScreenshotPath = path.join(
  pluginRoot,
  "tmp",
  "dashboard-browser-payload-failure.png",
);
const decisionDesktopScreenshotPath = path.join(
  pluginRoot,
  "tmp",
  "dashboard-decision-desktop.png",
);
const decisionMobileScreenshotPath = path.join(pluginRoot, "tmp", "dashboard-decision-mobile.png");
const operatorDemoScreenshotPath = path.join(
  pluginRoot,
  "tmp",
  "dashboard-operator-demo-details.png",
);

test("dashboard geometry evidence rejects an empty demo", () => {
  assert.throws(
    () => validateDashboardGeometryEvidence(emptyDashboardGeometryObservations(true)),
    (error) => error?.code === "V27_DASHBOARD_GEOMETRY_EMPTY",
  );
});

test("Chrome startup recognizes a DevTools endpoint split across stderr chunks", async () => {
  const browser = new EventEmitter();
  browser.stderr = new PassThrough();
  const endpoint = waitForDevToolsEndpoint(browser);

  browser.stderr.write("DevTools listen");
  browser.stderr.write("ing on ws://127.0.0.1:9222/devtools/browser/test\n");

  assert.equal(await endpoint, "ws://127.0.0.1:9222/devtools/browser/test");
  browser.stderr.destroy();
});

test("real browser covers dashboard focus, live refresh, motion, mobile, and large ledgers", async () => {
  const browserExecutable = resolveBrowserExecutable();
  assert.ok(
    browserExecutable,
    "Set CODEX_AUTORESEARCH_BROWSER to Chrome or Edge for the opt-in browser accessibility check.",
  );
  await runDashboardGeometryOperatorTask(browserExecutable);

  const fixture = await dashboardHtml();
  const server = await serveHtml(fixture.html, fixture.failureHtml, fixture.livePayload);
  const staticFixtureDir = await mkdtemp(path.join(tmpdir(), "autoresearch-dashboard-static-"));
  const staticFixturePath = path.join(staticFixtureDir, "autoresearch-dashboard.html");
  const smallFixturePath = path.join(staticFixtureDir, "autoresearch-dashboard-100.html");
  await writeFile(staticFixturePath, fixture.staticHtml);
  await writeFile(smallFixturePath, fixture.smallHtml);
  assert.ok(fixture.livePayloadBytes <= 2_500_000, `${fixture.livePayloadBytes} response bytes`);
  let browser;

  try {
    browser = await launchBrowser(browserExecutable);
    const client = await CdpClient.connect(browser.wsUrl);
    try {
      const page = await openPage(client, server.url);
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
        page.sessionId,
      );
      await waitForPageReady(client, page.sessionId);
      await waitForSelector(client, page.sessionId, "#trend-chart-range");
      const readyMs = await evaluate(client, page.sessionId, "Math.round(performance.now())");
      assert.ok(readyMs <= 2_000, `${readyMs}ms dashboard readiness`);
      await waitForFunction(
        client,
        page.sessionId,
        "() => document.querySelector('#ledger-body')?.textContent?.includes('#5001')",
        "Live refresh did not render run #5001.",
      );
      await evaluate(client, page.sessionId, "document.querySelector('#live-toggle').click()");
      await waitForFunction(
        client,
        page.sessionId,
        "() => document.querySelector('#live-toggle')?.getAttribute('aria-pressed') === 'false'",
        "Live refresh did not pause after proving the initial automatic update.",
      );
      const desktopChart = await dashboardScaleState(client, page.sessionId);
      assert.ok(desktopChart.chartPoints <= 48, JSON.stringify(desktopChart));
      assert.equal(desktopChart.chartRanges, 1);
      assert.equal(desktopChart.pointButtons, 0);
      assert.equal(desktopChart.hiddenPointLists, 0);
      const canonicalOperateDecision = await decisionViewportState(client, page.sessionId);
      assert.equal(canonicalOperateDecision.audit, false);
      assert.equal(canonicalOperateDecision.visible, true);
      assert.equal(canonicalOperateDecision.status, "Blocked");
      assert.equal(canonicalOperateDecision.blocker, "quality-evidence-required");
      await captureScreenshot(client, page.sessionId, decisionDesktopScreenshotPath);
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
        page.sessionId,
      );
      const initialMobileDecision = await decisionViewportState(client, page.sessionId);
      assert.equal(initialMobileDecision.visible, true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await captureScreenshot(client, page.sessionId, decisionMobileScreenshotPath);
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
        page.sessionId,
      );

      await evaluate(client, page.sessionId, "document.querySelector('#view-toggle').click()");
      await waitForSelector(client, page.sessionId, "#workspace-grid");
      const canonicalAuditDecision = await decisionViewportState(client, page.sessionId);
      assert.deepEqual(
        canonicalAuditDecision.fields,
        canonicalOperateDecision.fields,
        "Operate and audit views diverged from the canonical decision.",
      );
      await evaluate(
        client,
        page.sessionId,
        "document.querySelector('details.signal-item summary').focus()",
      );
      await pressKey(client, page.sessionId, "Enter");
      await waitForFunction(
        client,
        page.sessionId,
        "() => document.querySelector('details.signal-item')?.open === true",
        "Signal details did not open from the keyboard.",
      );
      const signalDetails = await evaluate(
        client,
        page.sessionId,
        "document.querySelector('details.signal-item p')?.textContent?.trim() || ''",
      );
      assert.ok(signalDetails, "Signal details were not visibly available without hover.");
      await evaluate(client, page.sessionId, "document.querySelector('#view-toggle').click()");
      await waitForNoSelector(client, page.sessionId, "#workspace-grid");

      await evaluate(
        client,
        page.sessionId,
        "document.querySelector('#refresh-now').focus(); document.querySelector('#refresh-now').click()",
      );
      await waitForFunction(
        client,
        page.sessionId,
        "() => document.querySelector('#refresh-now')?.disabled === true",
        "Manual refresh did not expose its busy state.",
      );
      const refreshing = await evaluate(
        client,
        page.sessionId,
        `(() => ({
          busy: document.querySelector('main')?.getAttribute('aria-busy'),
          disabled: document.querySelector('#refresh-now')?.disabled,
          detail: document.querySelector('#live-detail')?.textContent?.trim() || '',
          title: document.querySelector('#live-title')?.textContent?.trim() || ''
        }))()`,
      );
      assert.equal(refreshing.busy, "true");
      assert.equal(refreshing.disabled, true);
      assert.match(refreshing.title, /Refreshing/);
      assert.match(refreshing.detail, /Last validated/);
      await waitForFunction(
        client,
        page.sessionId,
        "() => document.querySelector('#refresh-now')?.disabled === false",
        "Manual refresh did not settle.",
      );
      await waitForActiveElement(client, page.sessionId, "#refresh-now");
      const lastGood = await evaluate(
        client,
        page.sessionId,
        "document.querySelector('#last-good-status strong')?.textContent?.trim() || ''",
      );
      assert.notEqual(lastGood, "Initial snapshot");
      assert.equal(
        server.liveRequestCount(),
        2,
        "The automatic and first manual refreshes should consume exactly two fixture responses.",
      );

      await evaluate(client, page.sessionId, "document.querySelector('#refresh-now').click()");
      await waitForNodeValue(
        server.liveRequestCount,
        (count) => count === 3,
        "The failed manual refresh did not reach the fixture server.",
      );
      await waitForFunction(
        client,
        page.sessionId,
        "() => document.querySelector('#live-region')?.getAttribute('role') === 'alert'",
        "Refresh failure did not become an alert.",
      );
      const failedRefresh = await evaluate(
        client,
        page.sessionId,
        `(() => ({
          busy: document.querySelector('main')?.getAttribute('aria-busy'),
          detail: document.querySelector('#live-detail')?.textContent?.trim() || '',
          runs: document.querySelector('#runs-value')?.textContent?.trim() || ''
        }))()`,
      );
      assert.equal(failedRefresh.busy, "false");
      assert.match(failedRefresh.detail, /last known valid readout, validated/i);
      assert.match(failedRefresh.runs, /5001/);
      const initialLedger = await evaluate(
        client,
        page.sessionId,
        `(() => ({
          rows: document.querySelectorAll('#ledger-body tr').length,
          pageText: document.querySelector('.ledger-pagination [aria-current="page"]')?.textContent?.trim() || '',
          chartRanges: document.querySelectorAll('#trend-chart input[type="range"]').length,
          pointButtons: document.querySelectorAll('.chart-point-button').length,
          hiddenPointLists: document.querySelectorAll('.chart-data-list li').length
        }))()`,
      );
      assert.equal(initialLedger.rows, 20);
      assert.equal(initialLedger.pageText, "Page 1 of 251");
      assert.equal(initialLedger.chartRanges, 1);
      assert.equal(initialLedger.pointButtons, 0);
      assert.equal(initialLedger.hiddenPointLists, 0);
      await evaluate(
        client,
        page.sessionId,
        `(() => {
          const metric = document.querySelector('#ledger-body tr .metric-stack');
          metric.querySelector('strong').textContent = '12345678901234567890.123456789s';
          metric.querySelector('span').textContent = '+12345678901234567890.1%';
        })()`,
      );
      const ledgerGeometry = await evaluate(
        client,
        page.sessionId,
        `(() => [...document.querySelectorAll('#ledger-body tr')].slice(0, 20).map((row) => {
          const cells = row.querySelectorAll('td');
          const range = document.createRange();
          range.selectNodeContents(cells[2].querySelector('.metric-stack'));
          const metric = range.getBoundingClientRect();
          const description = cells[3].getBoundingClientRect();
          return { metricRight: metric.right, descriptionLeft: description.left };
        }))()`,
      );
      assert.ok(
        ledgerGeometry.every((row) => row.metricRight <= row.descriptionLeft + 0.5),
        JSON.stringify(ledgerGeometry),
      );

      const paginationStartedAt = Date.now();
      await evaluate(
        client,
        page.sessionId,
        "document.querySelector('.ledger-pagination button:last-child').click()",
      );
      await waitForFunction(
        client,
        page.sessionId,
        "() => document.querySelector('.ledger-pagination [aria-current=\"page\"]')?.textContent?.includes('Page 2')",
        "Large ledger did not show the next 20 older rows.",
      );
      const paginationMs = Date.now() - paginationStartedAt;
      assert.ok(paginationMs <= 200, "Ledger pagination exceeded 200ms");
      assert.equal(
        await evaluate(
          client,
          page.sessionId,
          "document.querySelectorAll('#ledger-body tr').length",
        ),
        20,
      );

      const opener = await tabUntil(client, page.sessionId, "#trend-chart-range", 80);
      assert.equal(opener.matches, true, `Tab did not reach the chart range: ${opener.summary}`);
      assert.match(
        opener.ariaValueText,
        /run 5000/i,
        "Live refresh should preserve the externally selected chart run.",
      );

      const priorRun = opener.run;
      const rangeStartedAt = Date.now();
      await pressKey(client, page.sessionId, "ArrowLeft");
      await waitForFunction(
        client,
        page.sessionId,
        `(run) => document.querySelector('#trend-chart-range')?.getAttribute('data-chart-run') !== run`,
        "Chart range did not move to the previous sampled run.",
        [priorRun],
      );
      const rangeMs = Date.now() - rangeStartedAt;
      assert.ok(rangeMs <= 200, "Chart range interaction exceeded 200ms");
      const rangeBeforeOpen = await activeElement(client, page.sessionId, "#trend-chart-range");
      assert.equal(
        rangeBeforeOpen.matches,
        true,
        `Chart range lost focus before opening details: ${rangeBeforeOpen.summary}`,
      );
      assert.notEqual(
        rangeBeforeOpen.run,
        priorRun,
        "Chart range focus did not retain the newly selected run.",
      );

      await pressKey(client, page.sessionId, "Enter");
      await waitForSelector(client, page.sessionId, '[role="dialog"][aria-modal="true"]');
      await waitForActiveElement(client, page.sessionId, ".modal-close");
      const closeButton = await activeElement(client, page.sessionId, ".modal-close");
      assert.equal(closeButton.ariaLabel, "Close experiment details");

      await pressKey(client, page.sessionId, "Tab");
      const afterTab = await activeElement(client, page.sessionId, '[role="dialog"] *');
      assert.equal(afterTab.insideDialog, true, `Tab left the modal: ${afterTab.summary}`);

      await pressKey(client, page.sessionId, "Tab", { shift: true });
      const afterShiftTab = await activeElement(client, page.sessionId, '[role="dialog"] *');
      assert.equal(
        afterShiftTab.insideDialog,
        true,
        `Shift+Tab left the modal: ${afterShiftTab.summary}`,
      );

      const criticalFailures = await evaluate(
        client,
        page.sessionId,
        `(${String(collectCriticalAccessibilityFailures)})()`,
      );
      assert.deepEqual(criticalFailures, []);

      await captureScreenshot(client, page.sessionId, screenshotPath);

      await pressKey(client, page.sessionId, "Escape");
      await waitForNoSelector(client, page.sessionId, '[role="dialog"]');
      await waitForActiveElement(client, page.sessionId, "#trend-chart-range");

      await client.send(
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
        page.sessionId,
      );
      const reducedMotion = await evaluate(
        client,
        page.sessionId,
        "getComputedStyle(document.querySelector('.chart-open-details')).transitionDuration",
      );
      assert.ok(["0.001ms", "1e-06s"].includes(reducedMotion), reducedMotion);

      const smallPage = await openPage(client, pathToFileURL(smallFixturePath).href);
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
        smallPage.sessionId,
      );
      await waitForPageReady(client, smallPage.sessionId);
      await waitForSelector(client, smallPage.sessionId, "#trend-chart-range");
      const smallScale = await dashboardScaleState(client, smallPage.sessionId);
      const smallAx = await client.send("Accessibility.getFullAXTree", {}, smallPage.sessionId);

      await client.send("Target.activateTarget", { targetId: page.targetId });
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
        page.sessionId,
      );
      try {
        await waitForFunction(
          client,
          page.sessionId,
          "() => document.querySelectorAll('.chart-point-group > .chart-point').length <= 10",
          "Mobile chart did not settle to its point budget.",
        );
      } catch (error) {
        const diagnostics = await evaluate(
          client,
          page.sessionId,
          `(() => {
            const panelWidth = document.querySelector('#trend-panel')?.clientWidth || 0;
            const range = document.querySelector('#trend-chart-range');
            return {
              visibility: document.visibilityState,
              viewportWidth: window.innerWidth,
              panelWidth,
              chartWidth: document.querySelector('.chart-visual')?.clientWidth || 0,
              expectedBudget: Math.min(48, Math.max(10, Math.floor(panelWidth / 56))),
              rangeMax: Number(range?.max ?? -1),
              selectedRun: range?.getAttribute('data-chart-run') || '',
              pointCount: document.querySelectorAll('.chart-point-group > .chart-point').length,
              sampleNote: document.querySelector('.chart-sample-note')?.textContent?.trim() || ''
            };
          })()`,
        );
        throw new Error(`${error.message} ${JSON.stringify(diagnostics)}`);
      }
      await evaluate(client, page.sessionId, "document.querySelector('.toast-close')?.click()");
      await waitForNoSelector(client, page.sessionId, ".toast");
      const mobile = await dashboardScaleState(client, page.sessionId);
      const largeAx = await client.send("Accessibility.getFullAXTree", {}, page.sessionId);
      const largeSliders = largeAx.nodes.filter((node) => node.role?.value === "slider");
      const smallSemanticAx = semanticAxNodeCount(smallAx.nodes);
      const largeSemanticAx = semanticAxNodeCount(largeAx.nodes);

      assert.equal(mobile.noPageOverflow, true, JSON.stringify(mobile));
      assert.equal(mobile.shellFits, true, JSON.stringify(mobile));
      assert.equal(mobile.ledgerFits, true, JSON.stringify(mobile));
      assert.equal(mobile.mobileLabels, true, JSON.stringify(mobile));
      assert.ok(mobile.elements <= 1_200, JSON.stringify(mobile));
      assert.ok(mobile.buttons <= 20, JSON.stringify(mobile));
      assert.ok(mobile.chartPoints <= 10, JSON.stringify(mobile));
      assert.equal(mobile.chartRanges, 1);
      assert.equal(mobile.pointButtons, 0);
      assert.equal(mobile.hiddenPointLists, 0);
      assert.equal(mobile.ledgerRows, 20);
      assert.ok(mobile.minimumOperationalFont >= 12, JSON.stringify(mobile));
      assert.ok(
        mobile.elements - smallScale.elements <= 10,
        JSON.stringify({ smallScale, mobile }),
      );
      assert.ok(largeAx.nodes.length <= 1_300, `${largeAx.nodes.length} raw AX nodes`);
      assert.ok(
        largeSemanticAx - smallSemanticAx <= 10,
        JSON.stringify({
          smallSemanticAx,
          largeSemanticAx,
        }),
      );
      assert.equal(largeSliders.length, 1);

      const staticPage = await openPage(client, pathToFileURL(staticFixturePath).href);
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
        staticPage.sessionId,
      );
      await waitForPageReady(client, staticPage.sessionId);
      const staticShare = await evaluate(
        client,
        staticPage.sessionId,
        `(() => ({
          copyHidden: document.querySelector('#copy-dashboard-url')?.hidden,
          guidance: document.querySelector('#static-share-guidance')?.textContent?.trim() || '',
          localPathVisible: document.body.textContent.includes(location.href)
        }))()`,
      );
      assert.equal(staticShare.copyHidden, true);
      assert.equal(staticShare.localPathVisible, false);
      assert.match(staticShare.guidance, /Share this HTML file/);

      const failurePage = await openPage(client, `${server.url}payload-missing.html`);
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
        failurePage.sessionId,
      );
      await waitForPageReady(client, failurePage.sessionId);
      await waitForSelector(client, failurePage.sessionId, '.payload-failure-card[role="alert"]');
      const payloadFailure = await evaluate(
        client,
        failurePage.sessionId,
        `(() => ({
          evidenceTreePresent: Boolean(document.querySelector('.runboard-shell, #trend-panel')),
          heading: document.querySelector('#payload-failure-title')?.textContent?.trim() || '',
          modeVisible: document.querySelector('.payload-failure-facts')?.textContent?.includes('Unknown Delivery Mode') || false,
          provenanceVisible: document.querySelector('.payload-failure-facts')?.textContent?.includes('Dashboard payload unavailable') || false,
          recovery: document.querySelector('#payload-failure-recovery')?.textContent?.trim() || '',
          state: document.querySelector('#dashboard-root')?.dataset.dashboardState || ''
        }))()`,
      );
      assert.deepEqual(payloadFailure, {
        evidenceTreePresent: false,
        heading: "Dashboard Payload Unavailable",
        modeVisible: true,
        provenanceVisible: true,
        recovery:
          "Run the Autoresearch CLI: export --cwd <project>, or serve --cwd <project>. Then reload.",
        state: "payload-unavailable",
      });
      await captureScreenshot(client, failurePage.sessionId, payloadFailureScreenshotPath);
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
        failurePage.sessionId,
      );
      const mobileFailure = await evaluate(
        client,
        failurePage.sessionId,
        `(() => ({
          cardFits: document.querySelector('.payload-failure-card').getBoundingClientRect().right <= window.innerWidth,
          noPageOverflow: document.documentElement.scrollWidth <= window.innerWidth
        }))()`,
      );
      assert.deepEqual(mobileFailure, { cardFits: true, noPageOverflow: true });

      console.log(`METRIC dashboard_ready_ms=${readyMs}`);
      console.log(`METRIC dashboard_response_bytes=${fixture.livePayloadBytes}`);
      console.log(`METRIC dashboard_mobile_elements=${mobile.elements}`);
      console.log(`METRIC dashboard_mobile_buttons=${mobile.buttons}`);
      console.log(`METRIC dashboard_mobile_chart_points=${mobile.chartPoints}`);
      console.log(`METRIC dashboard_dom_growth=${mobile.elements - smallScale.elements}`);
      console.log(`METRIC dashboard_ax_nodes=${largeAx.nodes.length}`);
      console.log(`METRIC dashboard_ax_growth=${largeSemanticAx - smallSemanticAx}`);
      console.log(`METRIC dashboard_range_interaction_ms=${rangeMs}`);
      console.log(`METRIC dashboard_pagination_ms=${paginationMs}`);
      console.log(`ARTIFACT dashboard_browser_a11y_screenshot=${screenshotPath}`);
      console.log(`ARTIFACT dashboard_payload_failure_screenshot=${payloadFailureScreenshotPath}`);
      console.log(
        `ARTIFACT dashboard_decision_desktop_screenshot=${decisionDesktopScreenshotPath}`,
      );
      console.log(`ARTIFACT dashboard_decision_mobile_screenshot=${decisionMobileScreenshotPath}`);
    } finally {
      await client.close();
    }
  } finally {
    await browser?.close();
    await server.close();
    await rm(staticFixtureDir, { recursive: true, force: true });
  }
});

function semanticAxNodeCount(nodes) {
  return nodes.filter(
    (node) => !node.ignored && !["StaticText", "InlineTextBox"].includes(node.role?.value || ""),
  ).length;
}

async function runDashboardGeometryOperatorTask(browserExecutable) {
  let tempRoot;
  let browser;
  let client;
  let observations = emptyDashboardGeometryObservations(false);
  try {
    tempRoot = await mkdtemp(path.join(tmpdir(), "autoresearch-dashboard-operator-evidence-"));
    const demoSource = path.join(pluginRoot, "examples", "demo-session");
    const demoDir = path.join(tempRoot, "demo-session");
    const output = path.join(demoDir, "tmp", "operator-evidence.html");
    await cp(demoSource, demoDir, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(demoSource, source);
        return !relative.split(path.sep).includes("tmp") && !/\.(?:html|png)$/i.test(relative);
      },
    });
    await mkdir(path.dirname(output), { recursive: true });
    await runProductExport(demoDir);
    browser = await launchBrowser(browserExecutable);
    client = await CdpClient.connect(browser.wsUrl);
    const page = await openPage(client, pathToFileURL(output).href);
    await client.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      page.sessionId,
    );
    await waitForPageReady(client, page.sessionId);
    await waitForSelector(client, page.sessionId, "#trend-chart-range");
    observations = await initialDashboardGeometryEvidence(client, page.sessionId);
    await waitForFunction(
      client,
      page.sessionId,
      "() => document.querySelectorAll('.chart-point-group > .chart-point').length > 0",
      "The exported public demo rendered no chart points.",
    );
    const contrastScreenshots = await captureChartContrastScreenshots(client, page.sessionId);
    const chartObservations = await dashboardGeometryEvidence(
      client,
      page.sessionId,
      contrastScreenshots,
    );
    await evaluate(
      client,
      page.sessionId,
      `(() => {
        window.scrollTo(0, Math.max(0, document.querySelector('#trend-panel').offsetTop - 8));
        document.querySelector('#trend-chart-range').focus({ preventScroll: true });
      })()`,
    );
    await pressKey(client, page.sessionId, "Enter");
    await waitForSelector(client, page.sessionId, '[role="dialog"][aria-modal="true"]');
    observations = {
      ...chartObservations,
      ...(await dashboardModalEvidence(client, page.sessionId)),
    };
    validateDashboardGeometryEvidence(observations);
    await pressKey(client, page.sessionId, "Escape");
    await waitForFunction(
      client,
      page.sessionId,
      "() => !document.querySelector('[role=\"dialog\"]')",
      "The public showcase should show the chart without an overlay.",
    );
    await captureScreenshot(client, page.sessionId, operatorDemoScreenshotPath);
    emitDashboardGeometryEvidence("pass", observations);
    console.log(`ARTIFACT dashboard_operator_demo_screenshot=${operatorDemoScreenshotPath}`);
  } catch (error) {
    emitDashboardGeometryEvidence("fail", {
      ...observations,
      failureCode: "V27_DASHBOARD_GEOMETRY_EMPTY",
      error: String(error?.message || error).slice(0, 1_000),
    });
    throw error;
  } finally {
    await client?.close();
    await browser?.close();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}

function emitDashboardGeometryEvidence(status, observations) {
  const passed = status === "pass" ? 1 : 0;
  console.log(
    `EVIDENCE ${JSON.stringify({
      schemaVersion: 1,
      suite: "v2.7-operator-tasks",
      case: "dashboard-geometry",
      status,
      observations,
    })}`,
  );
  console.log(
    `EVIDENCE_SUMMARY ${JSON.stringify({
      schemaVersion: 1,
      suite: "v2.7-operator-tasks",
      status,
      tasks: 1,
      passed,
      failed: 1 - passed,
    })}`,
  );
}

function validateDashboardGeometryEvidence(observation) {
  if (
    observation.factsCollected !== true ||
    !Number.isInteger(observation.plottedPoints) ||
    observation.plottedPoints < 1 ||
    observation.plottedPoints > 48 ||
    observation.finitePointBounds !== observation.plottedPoints ||
    observation.visiblePoints !== observation.plottedPoints ||
    observation.pointContrastSamples !== Math.min(3, observation.visiblePoints) ||
    !Number.isFinite(observation.pointContrastMinimum) ||
    observation.pointContrastMinimum < 3 ||
    observation.pointContrastMinimum > 21 ||
    !Number.isFinite(observation.chartHeight) ||
    observation.chartHeight < 1 ||
    observation.chartHeight > 1_000 ||
    !Number.isFinite(observation.chartWidth) ||
    observation.chartWidth < 1 ||
    observation.chartWidth > 2_000 ||
    !boundedPositiveInteger(observation.contrastScreenshotWidth, 4_000) ||
    !boundedPositiveInteger(observation.contrastScreenshotHeight, 4_000) ||
    !Number.isFinite(observation.pointHorizontalSpan) ||
    observation.pointHorizontalSpan < 10 ||
    observation.pointHorizontalSpan > observation.chartWidth ||
    !Number.isFinite(observation.pointVerticalSpan) ||
    observation.pointVerticalSpan < 1 ||
    observation.pointVerticalSpan > observation.chartHeight ||
    !Number.isFinite(observation.pointVerticalSpanRatio) ||
    observation.pointVerticalSpanRatio < 0.1 ||
    observation.pointVerticalSpanRatio > 1 ||
    !Number.isInteger(observation.visibleLinePaths) ||
    observation.visibleLinePaths < 1 ||
    observation.visibleLinePaths > 8 ||
    !Number.isFinite(observation.visibleLineLength) ||
    observation.visibleLineLength < 100 ||
    observation.visibleLineLength > 100_000 ||
    !Number.isFinite(observation.lineContrast) ||
    observation.lineContrast < 3 ||
    observation.lineContrast > 21 ||
    observation.lineContrastSamples !== observation.visibleLinePaths ||
    !Number.isFinite(observation.lineHorizontalSpan) ||
    observation.lineHorizontalSpan < 100 ||
    observation.lineHorizontalSpan > observation.chartWidth ||
    observation.placeholderCount !== 0 ||
    observation.rangeEnabled !== true ||
    observation.outputVisible !== true ||
    !boundedPositiveInteger(observation.rangeDetailCharacters, 500) ||
    !boundedPositiveInteger(observation.outputDetailCharacters, 500) ||
    !boundedPositiveInteger(observation.modalRunNumber, 1_000_000) ||
    !boundedPositiveInteger(observation.modalStatusCode, 5) ||
    !boundedPositiveInteger(observation.modalMetricValues, 10) ||
    !Number.isInteger(observation.modalNonPlaceholderMetricValues) ||
    observation.modalNonPlaceholderMetricValues < 2 ||
    observation.modalNonPlaceholderMetricValues > observation.modalMetricValues ||
    !boundedPositiveInteger(observation.modalExperimentCharacters, 2_000)
  ) {
    const error = new Error("The dashboard demo has empty chart geometry or run details.");
    error.code = "V27_DASHBOARD_GEOMETRY_EMPTY";
    throw error;
  }
  return observation;
}

function emptyDashboardGeometryObservations(factsCollected) {
  return {
    factsCollected,
    chartHeight: 0,
    chartWidth: 0,
    contrastScreenshotHeight: 0,
    contrastScreenshotWidth: 0,
    finitePointBounds: 0,
    lineContrast: 0,
    lineContrastSamples: 0,
    lineHorizontalSpan: 0,
    linePixelFacts: [],
    modalExperimentCharacters: 0,
    modalMetricValues: 0,
    modalNonPlaceholderMetricValues: 0,
    modalRunNumber: 0,
    modalStatusCode: 0,
    outputDetailCharacters: 0,
    outputVisible: false,
    placeholderCount: 0,
    plottedPoints: 0,
    pointContrastMinimum: 0,
    pointContrastSamples: 0,
    pointHorizontalSpan: 0,
    pointPixelFacts: [],
    pointVerticalSpan: 0,
    pointVerticalSpanRatio: 0,
    rangeDetailCharacters: 0,
    rangeEnabled: false,
    visibleLineLength: 0,
    visibleLinePaths: 0,
    visiblePoints: 0,
  };
}

async function initialDashboardGeometryEvidence(client, sessionId) {
  const facts = await evaluate(
    client,
    sessionId,
    `(() => {
      const points = [...document.querySelectorAll('.chart-point-group > .chart-point')];
      const chart = document.querySelector('.chart-visual')?.getBoundingClientRect();
      return {
        chartHeight: chart?.height || 0,
        chartWidth: chart?.width || 0,
        finitePointBounds: points.filter((point) => {
          const rect = point.getBoundingClientRect();
          return [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
        }).length,
        plottedPoints: points.length,
      };
    })()`,
  );
  return { ...emptyDashboardGeometryObservations(true), ...facts };
}

function boundedPositiveInteger(value, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}

async function captureChartContrastScreenshots(client, sessionId) {
  const painted = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
  const hiddenPointCount = await evaluate(
    client,
    sessionId,
    `(async () => {
      const elements = [...document.querySelectorAll('.chart-point, .latest-halo')];
      for (const element of elements) {
        element.dataset.operatorEvidenceDisplay = element.style.display;
        element.style.setProperty('display', 'none', 'important');
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return elements.length;
    })()`,
  );
  assert.ok(hiddenPointCount > 0, `Expected chart points to hide; observed ${hiddenPointCount}.`);
  try {
    const lineOnly = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const hiddenLineCount = await evaluate(
      client,
      sessionId,
      `(async () => {
        const elements = [...document.querySelectorAll('.linePath')];
        for (const element of elements) {
          element.dataset.operatorEvidenceDisplay = element.style.display;
          element.style.setProperty('display', 'none', 'important');
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return elements.length;
      })()`,
    );
    assert.ok(hiddenLineCount > 0, `Expected chart lines to hide; observed ${hiddenLineCount}.`);
    const background = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
    assert.notEqual(
      lineOnly.data,
      painted.data,
      "Hidden chart points did not change the screenshot.",
    );
    assert.notEqual(
      background.data,
      lineOnly.data,
      "Hidden chart line did not change the screenshot.",
    );
    return {
      painted: painted.data,
      lineOnly: lineOnly.data,
      background: background.data,
    };
  } finally {
    await evaluate(
      client,
      sessionId,
      `(() => {
        for (const element of document.querySelectorAll('[data-operator-evidence-display]')) {
          element.style.display = element.dataset.operatorEvidenceDisplay || '';
          delete element.dataset.operatorEvidenceDisplay;
        }
      })()`,
    );
  }
}

async function dashboardGeometryEvidence(client, sessionId, screenshots) {
  return evaluate(
    client,
    sessionId,
    `(async () => {
      const loadScreenshot = (data) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(image, 0, 0);
          resolve({ context, width: canvas.width, height: canvas.height });
        };
        image.onerror = () => reject(new Error('Could not decode dashboard contrast screenshot.'));
        image.src = 'data:image/png;base64,' + data;
      });
      const paintedScreenshot = await loadScreenshot(${JSON.stringify(screenshots.painted)});
      const lineOnlyScreenshot = await loadScreenshot(${JSON.stringify(screenshots.lineOnly)});
      const backgroundScreenshot = await loadScreenshot(${JSON.stringify(screenshots.background)});
      const screenshotPixel = (screenshot, x, y) => {
        const scaledX = Math.max(0, Math.min(screenshot.width - 1, Math.round(x * screenshot.width / innerWidth)));
        const scaledY = Math.max(0, Math.min(screenshot.height - 1, Math.round(y * screenshot.height / innerHeight)));
        return [...screenshot.context.getImageData(scaledX, scaledY, 1, 1).data].slice(0, 3);
      };
      const points = [...document.querySelectorAll('.chart-point-group > .chart-point')];
      const lines = [...new Set([...document.querySelectorAll('.linePath')].flatMap((element) =>
        typeof element.getTotalLength === 'function' ? [element] : [...element.querySelectorAll('path')]
      ))];
      const range = document.querySelector('#trend-chart-range');
      const output = document.querySelector('.chart-navigator output');
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const experiment = [...(dialog?.querySelectorAll('.experiment-detail-list dt') || [])]
        .find((term) => term.textContent?.trim() === 'Experiment')
        ?.nextElementSibling;
      const metricValues = [...(dialog?.querySelectorAll('.experiment-metrics strong') || [])]
        .map((element) => element.textContent?.trim() || '');
      const rangeDetail = range?.getAttribute('aria-valuetext')?.trim() || '';
      const outputDetail = output?.textContent?.trim() || '';
      const outputBounds = output?.getBoundingClientRect();
      const modalTitle = dialog?.querySelector('#experiment-modal-title')?.textContent?.trim() || '';
      const modalStatus = dialog?.getAttribute('data-status') || '';
      const modalStatusText = dialog?.querySelector('.eyebrow')?.textContent?.trim() || '';
      const experimentDetail = experiment?.textContent?.trim() || '';
      const requiredText = [rangeDetail, outputDetail, modalTitle, modalStatusText, ...metricValues, experimentDetail];
      const placeholder = (value) => {
        const text = String(value || '').trim();
        return !text || text === '—' || /no plotted/i.test(text) || /\\bunknown\\b/i.test(text);
      };
      const luminance = (color) => {
        const channels = color.map((value) => {
          const normalized = value / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const contrast = (foreground, background) => {
        const first = luminance(foreground);
        const second = luminance(background);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };
      const intersects = (rect, bounds) => rect.right > bounds.left && rect.left < bounds.right &&
        rect.bottom > bounds.top && rect.top < bounds.bottom;
      const chart = document.querySelector('.chart-visual');
      const chartBounds = chart?.getBoundingClientRect() || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
      const viewportBounds = { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
      const pointBounds = points.map((point) => point.getBoundingClientRect());
      const finitePointBounds = pointBounds.filter((rect) =>
        [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0
      ).length;
      const visiblePointElements = points.filter((point, index) => {
        const style = getComputedStyle(point);
        const rect = pointBounds[index];
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0 &&
          intersects(rect, chartBounds) && intersects(rect, viewportBounds);
      });
      const visibleLines = lines.filter((line) => {
        const style = getComputedStyle(line);
        const rect = line.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 && style.stroke !== 'none' && Number(style.strokeOpacity) > 0 &&
          rect.width > 0 && rect.height > 0 &&
          intersects(rect, chartBounds) && intersects(rect, viewportBounds);
      });
      const contrastFactAt = (screenshot, x, y) => {
        const painted = screenshotPixel(screenshot, x, y);
        const background = screenshotPixel(backgroundScreenshot, x, y);
        return { painted, background, ratio: contrast(painted, background) };
      };
      const pointContrastFacts = visiblePointElements.slice(0, 3).map((point) => {
        const rect = point.getBoundingClientRect();
        return contrastFactAt(paintedScreenshot, rect.left + rect.width / 2, rect.top + rect.height / 2);
      });
      const lineContrastFacts = visibleLines.map((line) => {
        const point = line.getPointAtLength(line.getTotalLength() / 2);
        const matrix = line.getScreenCTM();
        const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        return contrastFactAt(lineOnlyScreenshot, screenPoint.x, screenPoint.y);
      });
      const pointContrasts = pointContrastFacts.map((fact) => fact.ratio);
      const lineContrasts = lineContrastFacts.map((fact) => fact.ratio);
      const visiblePointBounds = visiblePointElements.map((point) => point.getBoundingClientRect());
      const pointCenters = visiblePointBounds.map((rect) => rect.top + rect.height / 2).filter(Number.isFinite);
      const pointHorizontalCenters = visiblePointBounds.map((rect) => rect.left + rect.width / 2).filter(Number.isFinite);
      const pointVerticalSpan = pointCenters.length > 1 ? Math.max(...pointCenters) - Math.min(...pointCenters) : 0;
      const pointHorizontalSpan = pointHorizontalCenters.length > 1 ? Math.max(...pointHorizontalCenters) - Math.min(...pointHorizontalCenters) : 0;
      const lineHorizontalSpan = visibleLines.length ? Math.min(chartBounds.right, Math.max(...visibleLines.map((line) => line.getBoundingClientRect().right))) -
        Math.max(chartBounds.left, Math.min(...visibleLines.map((line) => line.getBoundingClientRect().left))) : 0;
      const statusCodes = { measure: 1, keep: 2, discard: 3, crash: 4, checks_failed: 5 };
      return {
        factsCollected: true,
        chartHeight: Math.min(1_000, Math.round(chartBounds.height * 1_000) / 1_000),
        chartWidth: Math.min(2_000, Math.round(chartBounds.width * 1_000) / 1_000),
        contrastScreenshotHeight: paintedScreenshot.height,
        contrastScreenshotWidth: paintedScreenshot.width,
        finitePointBounds,
        lineContrast: lineContrasts.length ? Math.min(21, Math.round(Math.min(...lineContrasts) * 1_000) / 1_000) : 0,
        lineContrastSamples: lineContrasts.length,
        linePixelFacts: lineContrastFacts,
        lineHorizontalSpan: Math.min(2_000, Math.round(lineHorizontalSpan * 1_000) / 1_000),
        modalExperimentCharacters: Math.min(2_000, experimentDetail.length),
        modalMetricValues: Math.min(10, metricValues.length),
        modalNonPlaceholderMetricValues: Math.min(10, metricValues.filter((value) => !placeholder(value)).length),
        modalRunNumber: Math.min(1_000_000, Number(modalTitle.match(/^Run #(\\d+)$/)?.[1] || 0)),
        modalStatusCode: statusCodes[modalStatus] || 0,
        outputDetailCharacters: Math.min(500, outputDetail.length),
        outputVisible: Boolean(outputBounds && outputBounds.width > 0 && outputBounds.height > 0 && getComputedStyle(output).display !== 'none' && getComputedStyle(output).visibility !== 'hidden' && Number(getComputedStyle(output).opacity) > 0),
        placeholderCount: Math.min(100, requiredText.filter(placeholder).length),
        plottedPoints: points.length,
        pointContrastMinimum: pointContrasts.length ? Math.min(21, Math.round(Math.min(...pointContrasts) * 1_000) / 1_000) : 0,
        pointContrastSamples: pointContrasts.length,
        pointPixelFacts: pointContrastFacts,
        pointHorizontalSpan: Math.min(2_000, Math.round(pointHorizontalSpan * 1_000) / 1_000),
        pointVerticalSpan: Math.min(1_000, Math.round(pointVerticalSpan * 1_000) / 1_000),
        pointVerticalSpanRatio: chartBounds.height > 0 ? Math.min(1, Math.round((pointVerticalSpan / chartBounds.height) * 1_000) / 1_000) : 0,
        rangeDetailCharacters: Math.min(500, rangeDetail.length),
        rangeEnabled: Boolean(range && !range.disabled),
        visibleLineLength: Math.min(100_000, Math.round(visibleLines.reduce((total, line) => total + line.getTotalLength(), 0))),
        visibleLinePaths: Math.min(8, visibleLines.length),
        visiblePoints: visiblePointElements.length,
      };
    })()`,
  );
}

async function dashboardModalEvidence(client, sessionId) {
  return evaluate(
    client,
    sessionId,
    `(() => {
      const range = document.querySelector('#trend-chart-range');
      const output = document.querySelector('.chart-navigator output');
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const experiment = [...(dialog?.querySelectorAll('.experiment-detail-list dt') || [])]
        .find((term) => term.textContent?.trim() === 'Experiment')
        ?.nextElementSibling;
      const metricValues = [...(dialog?.querySelectorAll('.experiment-metrics strong') || [])]
        .map((element) => element.textContent?.trim() || '');
      const rangeDetail = range?.getAttribute('aria-valuetext')?.trim() || '';
      const outputDetail = output?.textContent?.trim() || '';
      const outputBounds = output?.getBoundingClientRect();
      const modalTitle = dialog?.querySelector('#experiment-modal-title')?.textContent?.trim() || '';
      const modalStatus = dialog?.getAttribute('data-status') || '';
      const modalStatusText = dialog?.querySelector('.eyebrow')?.textContent?.trim() || '';
      const experimentDetail = experiment?.textContent?.trim() || '';
      const requiredText = [rangeDetail, outputDetail, modalTitle, modalStatusText, ...metricValues, experimentDetail];
      const placeholder = (value) => {
        const text = String(value || '').trim();
        return !text || text === '—' || /no plotted/i.test(text) || /\\bunknown\\b/i.test(text);
      };
      const statusCodes = { measure: 1, keep: 2, discard: 3, crash: 4, checks_failed: 5 };
      return {
        modalExperimentCharacters: Math.min(2_000, experimentDetail.length),
        modalMetricValues: Math.min(10, metricValues.length),
        modalNonPlaceholderMetricValues: Math.min(10, metricValues.filter((value) => !placeholder(value)).length),
        modalRunNumber: Math.min(1_000_000, Number(modalTitle.match(/^Run #(\\d+)$/)?.[1] || 0)),
        modalStatusCode: statusCodes[modalStatus] || 0,
        outputDetailCharacters: Math.min(500, outputDetail.length),
        outputVisible: Boolean(outputBounds && outputBounds.width > 0 && outputBounds.height > 0 && getComputedStyle(output).display !== 'none' && getComputedStyle(output).visibility !== 'hidden' && Number(getComputedStyle(output).opacity) > 0),
        placeholderCount: Math.min(100, requiredText.filter(placeholder).length),
        rangeDetailCharacters: Math.min(500, rangeDetail.length),
        rangeEnabled: Boolean(range && !range.disabled),
      };
    })()`,
  );
}

function runProductExport(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(pluginRoot, "scripts", "autoresearch.mjs"),
        "export",
        "--cwd",
        cwd,
        "--output",
        "tmp/operator-evidence.html",
        "--showcase",
      ],
      {
        cwd: pluginRoot,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Public demo export failed with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function dashboardScaleState(client, sessionId) {
  return evaluate(
    client,
    sessionId,
    `(() => {
      const shell = document.querySelector('.runboard-shell')?.getBoundingClientRect();
      const ledger = document.querySelector('.ledger-scroll')?.getBoundingClientRect();
      const rows = [...document.querySelectorAll('#ledger-body tr')];
      const operational = [...document.querySelectorAll(
        '#chart-keyboard-help, .chart-navigator label, .chart-navigator output, .chart-sample-note, .chart-open-details, .ledger-cell, .ledger-cell *, .ledger-pagination *'
      )].filter((element) => element.textContent?.trim() && getComputedStyle(element).display !== 'none');
      const fontSizes = operational.map((element) => Number.parseFloat(getComputedStyle(element).fontSize));
      return {
        elements: document.querySelectorAll('*').length,
        buttons: document.querySelectorAll('button').length,
        chartPoints: document.querySelectorAll('.chart-point-group > .chart-point').length,
        chartRanges: document.querySelectorAll('#trend-chart input[type="range"]').length,
        pointButtons: document.querySelectorAll('.chart-point-button').length,
        hiddenPointLists: document.querySelectorAll('.chart-data-list li').length,
        ledgerRows: rows.length,
        minimumOperationalFont: Math.min(...fontSizes),
        mobileLabels: rows.every((row) => [...row.querySelectorAll('td')].every((cell) => {
          const content = getComputedStyle(cell, '::before').content;
          return content && content !== 'none' && content !== '""';
        })),
        noPageOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        shellFits: Boolean(shell && shell.left >= 0 && shell.right <= window.innerWidth + 1),
        ledgerFits: Boolean(ledger && ledger.left >= 0 && ledger.right <= window.innerWidth + 1),
      };
    })()`,
  );
}

async function decisionViewportState(client, sessionId) {
  return evaluate(
    client,
    sessionId,
    `(() => {
      const rail = document.querySelector('#decision-rail').getBoundingClientRect();
      const summary = document.querySelector('#decision-envelope-summary').getBoundingClientRect();
      const field = (id) => document.querySelector('#' + id)?.textContent?.trim() || '';
      return {
        audit: document.querySelector('#view-toggle')?.getAttribute('aria-pressed') === 'true',
        blocker: field('decision-blocker'),
        fields: ['decision-status', 'decision-blocker', 'next-action-detail', 'decision-next-command'].map(field),
        status: field('decision-status'),
        visible: rail.top >= 0 && summary.top >= 0 && summary.bottom <= innerHeight
      };
    })()`,
  );
}

function resolveBrowserExecutable() {
  const configured = process.env.CODEX_AUTORESEARCH_BROWSER;
  if (configured && existsSync(configured)) return configured;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

async function launchBrowser(executable) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "autoresearch-browser-a11y-"));
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  let wsUrl;
  try {
    wsUrl = await waitForDevToolsEndpoint(browser);
  } catch (error) {
    await closeBrowserProcess(browser, userDataDir);
    throw error;
  }
  return {
    wsUrl,
    close: () => closeBrowserProcess(browser, userDataDir),
  };
}

function waitForDevToolsEndpoint(browser) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderrTail = "";
    const timeout = setTimeout(() => {
      finish(reject, new Error("Timed out waiting for Chrome DevTools endpoint."));
    }, 15000);
    const cleanup = () => {
      clearTimeout(timeout);
      browser.off("exit", onExit);
      browser.off("error", onError);
      browser.stderr.off("data", onData);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onExit = (code) => {
      finish(reject, new Error(`Browser exited before DevTools was ready with code ${code}.`));
    };
    const onError = (error) => {
      finish(reject, error);
    };
    const onData = (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-8192);
      const match = stderrTail.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(resolve, match[1]);
    };

    browser.once("exit", onExit);
    browser.once("error", onError);
    browser.stderr.on("data", onData);
  });
}

async function closeBrowserProcess(browser, userDataDir) {
  if (browser.exitCode == null && browser.signalCode == null && !browser.killed) {
    browser.kill();
  }
  if (browser.exitCode == null && browser.signalCode == null) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 2000);
      browser.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  await rm(userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

class CdpClient {
  static async connect(wsUrl) {
    assert.equal(typeof WebSocket, "function", "Node.js WebSocket support is required.");
    const socket = new WebSocket(wsUrl);
    const client = new CdpClient(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return client;
  }

  constructor(socket) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP socket closed."));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    this.socket.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  waitForEvent(method, sessionId, predicate = () => true, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const listener = { method, sessionId, predicate, resolve, reject };
      this.listeners.push(listener);
      setTimeout(() => {
        this.listeners = this.listeners.filter((item) => item !== listener);
        reject(new Error(`Timed out waiting for CDP event ${method}.`));
      }, timeoutMs);
    });
  }

  handleMessage(data) {
    const message = JSON.parse(String(data));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) {
      if (listener.method !== message.method) continue;
      if (listener.sessionId && listener.sessionId !== message.sessionId) continue;
      if (!listener.predicate(message.params || {})) continue;
      this.listeners = this.listeners.filter((item) => item !== listener);
      listener.resolve(message.params || {});
    }
  }

  async close() {
    try {
      await this.send("Browser.close");
    } catch {
      // The browser may already be shutting down after Browser.close.
    }
    this.socket.close();
  }
}

async function openPage(client, url) {
  const { targetId } = await client.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  const loaded = client.waitForEvent("Page.loadEventFired", sessionId);
  await client.send("Page.navigate", { url }, sessionId);
  await loaded;
  return { sessionId, targetId };
}

async function waitForPageReady(client, sessionId) {
  await waitForFunction(
    client,
    sessionId,
    "() => window.__AUTORESEARCH_DASHBOARD_READY__ === true",
    "Dashboard did not finish rendering in the browser.",
  );
}

async function waitForSelector(client, sessionId, selector) {
  await waitForFunction(
    client,
    sessionId,
    `(selector) => Boolean(document.querySelector(selector))`,
    `Missing selector: ${selector}`,
    [selector],
  );
}

async function waitForNoSelector(client, sessionId, selector) {
  await waitForFunction(
    client,
    sessionId,
    `(selector) => !document.querySelector(selector)`,
    `Selector stayed present: ${selector}`,
    [selector],
  );
}

async function waitForActiveElement(client, sessionId, selector) {
  await waitForFunction(
    client,
    sessionId,
    `(selector) => Boolean(document.activeElement?.matches(selector))`,
    `Active element did not match: ${selector}`,
    [selector],
  );
}

async function waitForFunction(client, sessionId, fn, message, args = [], timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await evaluate(client, sessionId, `(${fn})(...${JSON.stringify(args)})`);
    if (result) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function waitForNodeValue(readValue, accepts, message, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (accepts(readValue())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime.evaluate failed.",
    );
  }
  return result.result.value;
}

async function tabUntil(client, sessionId, selector, maxTabs) {
  for (let index = 0; index < maxTabs; index += 1) {
    await pressKey(client, sessionId, "Tab");
    const active = await activeElement(client, sessionId, selector);
    if (active.matches) return active;
  }
  return activeElement(client, sessionId, selector);
}

async function activeElement(client, sessionId, selector) {
  return evaluate(
    client,
    sessionId,
    `(() => {
      const active = document.activeElement;
      const summary = active
        ? [active.tagName.toLowerCase(), active.id ? "#" + active.id : "", active.className ? "." + String(active.className).trim().replace(/\\s+/g, ".") : ""].join("")
        : "none";
      return {
        ariaLabel: active?.getAttribute("aria-label") || "",
        ariaValueText: active?.getAttribute("aria-valuetext") || "",
        insideDialog: Boolean(active?.closest('[role="dialog"]')),
        matches: Boolean(active?.matches(${JSON.stringify(selector)})),
        run: active?.getAttribute("data-chart-run") || "",
        summary,
        text: active?.textContent?.trim() || "",
      };
    })()`,
  );
}

async function pressKey(client, sessionId, key, options = {}) {
  const codes = {
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
    Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  };
  const keySpec = codes[key];
  assert.ok(keySpec, `Unsupported key: ${key}`);
  const modifiers = options.shift ? 8 : 0;
  const params = {
    key,
    code: keySpec.code,
    windowsVirtualKeyCode: keySpec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keySpec.windowsVirtualKeyCode,
    modifiers,
  };
  await client.send(
    "Input.dispatchKeyEvent",
    key === "Enter"
      ? { ...params, type: "keyDown", text: "\r", unmodifiedText: "\r" }
      : { ...params, type: "rawKeyDown" },
    sessionId,
  );
  await client.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" }, sessionId);
}

async function captureScreenshot(client, sessionId, targetPath) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const { data } = await client.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    sessionId,
  );
  await writeFile(targetPath, Buffer.from(data, "base64"));
}

function collectCriticalAccessibilityFailures() {
  const root = document.querySelector("#trend-panel");
  const failures = [];
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const textFromIdRefs = (value) =>
    String(value || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() || "")
      .filter(Boolean)
      .join(" ");
  const accessibleName = (element) =>
    element.getAttribute("aria-label") ||
    textFromIdRefs(element.getAttribute("aria-labelledby")) ||
    element.textContent?.trim() ||
    "";
  const assertIdRefs = (element, attr) => {
    const value = element.getAttribute(attr);
    if (!value) return;
    for (const id of value.split(/\s+/).filter(Boolean)) {
      if (!document.getElementById(id)) {
        failures.push(`${describeElement(element)} references missing ${attr} id ${id}`);
      }
    }
  };
  const describeElement = (element) =>
    [
      element.tagName.toLowerCase(),
      element.id ? `#${element.id}` : "",
      element.className ? `.${String(element.className).trim().replace(/\s+/g, ".")}` : "",
    ].join("");

  for (const element of root.querySelectorAll("[aria-labelledby],[aria-describedby]")) {
    assertIdRefs(element, "aria-labelledby");
    assertIdRefs(element, "aria-describedby");
  }
  for (const button of root.querySelectorAll("button")) {
    if (visible(button) && !accessibleName(button)) {
      failures.push(`${describeElement(button)} has no accessible name`);
    }
  }
  const ranges = root.querySelectorAll('#trend-chart input[type="range"]');
  if (ranges.length !== 1) failures.push(`chart exposes ${ranges.length} range controls`);
  const range = ranges[0];
  if (range && !range.getAttribute("aria-valuetext")) {
    failures.push("chart range has no concise current-run value");
  }
  if (range?.getAttribute("aria-haspopup") !== "dialog") {
    failures.push("chart range does not expose its details dialog");
  }
  if (root.querySelectorAll(".chart-point-button, .chart-data-list li").length) {
    failures.push("chart retains duplicate per-point accessibility nodes");
  }
  if (root.querySelector(".chart-visual")?.getAttribute("aria-hidden") !== "true") {
    failures.push("chart SVG is not decorative");
  }
  const dialog = root.querySelector('[role="dialog"]');
  if (!dialog) {
    failures.push("experiment modal dialog is missing");
  } else {
    if (dialog.getAttribute("aria-modal") !== "true") {
      failures.push("experiment modal does not set aria-modal=true");
    }
    if (!accessibleName(dialog)) {
      failures.push("experiment modal has no accessible name");
    }
    if (!dialog.querySelector(".modal-close")) {
      failures.push("experiment modal close button is missing");
    }
  }
  return failures;
}
