import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotPath = path.join(pluginRoot, "tmp", "dashboard-browser-a11y-modal.png");

test("real browser keeps chart point modal keyboard flow accessible", async () => {
  const browserExecutable = resolveBrowserExecutable();
  assert.ok(
    browserExecutable,
    "Set CODEX_AUTORESEARCH_BROWSER to Chrome or Edge for the opt-in browser accessibility check.",
  );

  const html = await dashboardHtml();
  const server = await serveHtml(html);
  const browser = await launchBrowser(browserExecutable);

  try {
    const client = await CdpClient.connect(browser.wsUrl);
    try {
      const page = await openPage(client, server.url);
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
        page.sessionId,
      );
      await waitForPageReady(client, page.sessionId);
      await waitForSelector(client, page.sessionId, ".chart-point-button");

      const opener = await tabUntil(client, page.sessionId, ".chart-point-button", 80);
      assert.equal(opener.matches, true, `Tab did not reach a chart point: ${opener.summary}`);
      assert.match(opener.ariaLabel, /Open details for run/);

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
      await waitForActiveElement(
        client,
        page.sessionId,
        `.chart-point-button[data-chart-run="${opener.run}"]`,
      );

      console.log(`ARTIFACT dashboard_browser_a11y_screenshot=${screenshotPath}`);
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
    await browser.close();
  }
});

async function dashboardHtml() {
  const template = await readFile(path.join(pluginRoot, "assets", "template.html"), "utf8");
  const css = await readFile(
    path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.css"),
    "utf8",
  );
  const app = await readFile(
    path.join(pluginRoot, "assets", "dashboard-build", "dashboard-app.js"),
    "utf8",
  );
  const entries = [
    {
      type: "config",
      name: "browser chart modal accessibility",
      metricName: "seconds",
      bestDirection: "lower",
      metricUnit: "s",
    },
    { type: "run", run: 1, metric: 5, status: "keep", description: "Baseline", confidence: 1 },
    {
      type: "run",
      run: 2,
      metric: 4,
      status: "discard",
      description: "Rejected shortcut",
      confidence: 2,
    },
    {
      type: "run",
      run: 3,
      metric: 3,
      status: "keep",
      description: "Improved candidate",
      confidence: 3,
    },
  ];
  const meta = { deliveryMode: "static-export", liveActionsAvailable: false, commands: [] };
  return template
    .replace("__AUTORESEARCH_DATA_PAYLOAD__", () =>
      JSON.stringify(entries).replaceAll("<", "\\u003c"),
    )
    .replace("__AUTORESEARCH_META_PAYLOAD__", () => JSON.stringify(meta).replaceAll("<", "\\u003c"))
    .replace("__AUTORESEARCH_DASHBOARD_CSS__", () => css)
    .replace("__AUTORESEARCH_DASHBOARD_APP__", () => app);
}

async function serveHtml(html) {
  const server = http.createServer((request, response) => {
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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
  const wsUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Chrome DevTools endpoint."));
    }, 15000);
    browser.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Browser exited before DevTools was ready with code ${code}.`));
    });
    browser.stderr.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    browser.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return {
    wsUrl,
    async close() {
      if (!browser.killed) browser.kill();
      if (browser.exitCode == null && browser.signalCode == null) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 2000);
          browser.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
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
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
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

async function evaluate(client, sessionId, expression) {
  const result = await client.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed.");
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
  await client.send("Input.dispatchKeyEvent", { ...params, type: "rawKeyDown" }, sessionId);
  if (key === "Enter") {
    await client.send(
      "Input.dispatchKeyEvent",
      { ...params, type: "char", text: "\r", unmodifiedText: "\r" },
      sessionId,
    );
  }
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
  for (const chartButton of root.querySelectorAll(".chart-point-button")) {
    if (chartButton.getAttribute("aria-haspopup") !== "dialog") {
      failures.push(`${describeElement(chartButton)} does not expose dialog affordance`);
    }
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
