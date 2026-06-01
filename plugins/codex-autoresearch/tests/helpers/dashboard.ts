import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { resolvePackageRoot } from "../../lib/runtime-paths.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const dashboardTemplatePath = path.join(pluginRoot, "assets", "template.html");
const dashboardBuildPath = path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.js");
const dashboardCssPath = path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.css");
const dashboardReadyMessage = "Dashboard React app did not finish rendering.";
const rebuildDashboardEnv = "CODEX_AUTORESEARCH_TEST_REBUILD_DASHBOARD";

type DashboardAssets = {
  app: string;
  css: string;
};

export const dashboardConfigEntry = ({
  name,
  metricName,
  bestDirection = "lower",
  metricUnit = "",
}) => ({
  type: "config",
  name,
  metricName,
  bestDirection,
  metricUnit,
});

export const emptyCommandMeta = (meta = {}) => ({ ...meta, commands: [] });

export async function waitFor(predicate, message) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function createDashboardHarness() {
  let tempBuildDir = "";
  let dashboardAssets: DashboardAssets | null = null;
  const dashboardWindows = [];

  const closeDashboardWindows = () => {
    while (dashboardWindows.length > 0) {
      const window = dashboardWindows.pop();
      try {
        window?.close?.();
      } catch {
        // Ignore cleanup errors for deterministic teardown.
      }
    }
  };

  const readCheckedInDashboardAssets = async (): Promise<DashboardAssets> => ({
    app: await readFile(dashboardBuildPath, "utf8"),
    css: await readFile(dashboardCssPath, "utf8"),
  });

  const buildDashboardAssets = async () => {
    if (process.env[rebuildDashboardEnv] !== "1") {
      dashboardAssets = await readCheckedInDashboardAssets();
      return;
    }
    const { build: viteBuild } = await import("vite");
    tempBuildDir = await mkdtemp(path.join(tmpdir(), "autoresearch-dashboard-test-"));
    await viteBuild({
      configFile: path.join(pluginRoot, "vite.dashboard.config.ts"),
      logLevel: "silent",
      build: {
        outDir: tempBuildDir,
        emptyOutDir: true,
      },
    });
    dashboardAssets = {
      app: await readFile(path.join(tempBuildDir, "dashboard-app.js"), "utf8"),
      css: await readFile(path.join(tempBuildDir, "dashboard-app.css"), "utf8"),
    };
  };

  const cleanupBuildAssets = async () => {
    closeDashboardWindows();
    if (tempBuildDir) await rm(tempBuildDir, { recursive: true, force: true });
  };

  const readDashboardAssets = async () => {
    dashboardAssets ||= await readCheckedInDashboardAssets();
    return dashboardAssets;
  };

  const dashboardUrl = (meta, options) =>
    options.url ||
    (meta.deliveryMode === "live-server"
      ? "http://127.0.0.1/"
      : "file:///autoresearch-dashboard.html");

  const getRequiredElement = (dom, id) => {
    const element = dom.window.document.getElementById(id);
    assert.ok(element, `Missing dashboard element: ${id}`);
    return element;
  };

  const runDashboard = async (entries, meta = {}, options = {}) => {
    const template = await readFile(dashboardTemplatePath, "utf8");
    const { app, css } = await readDashboardAssets();
    const html = template
      .replace("__AUTORESEARCH_DATA_PAYLOAD__", () =>
        JSON.stringify(entries).replace(/</g, "\\u003c"),
      )
      .replace("__AUTORESEARCH_META_PAYLOAD__", () => JSON.stringify(meta).replace(/</g, "\\u003c"))
      .replace("__AUTORESEARCH_DASHBOARD_CSS__", () => css)
      .replace("__AUTORESEARCH_DASHBOARD_APP__", () => app);
    const dom = new JSDOM(html, {
      pretendToBeVisual: true,
      runScripts: "dangerously",
      url: dashboardUrl(meta, options),
      beforeParse: options.beforeParse,
    });
    dashboardWindows.push(dom.window);
    await waitFor(() => dom.window.__AUTORESEARCH_DASHBOARD_READY__, dashboardReadyMessage);
    const getById = (id) => getRequiredElement(dom, id);
    const queryById = (id) => dom.window.document.getElementById(id);
    return { dom, getById, queryById };
  };

  return {
    buildDashboardAssets,
    cleanupBuildAssets,
    closeDashboardWindows,
    runDashboard,
  };
}
