import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSpawnCommand } from "../scripts/check-runner.js";
import {
  dashboardExportAssetIssues,
  dashboardGeneratedDemoExport,
  demoDashboardExportCommand,
  releaseChecksumIssue,
  resolveNpmCommand,
} from "../scripts/check.js";

test("check runner refuses Windows command scripts instead of routing through cmd", () => {
  assert.throws(
    () =>
      resolveSpawnCommand("npm.cmd", ["run", "test:compiled"], {
        platform: "win32",
      }),
    /Refusing to run Windows command script/,
  );
});

test("check runner keeps Windows native executable paths as argv values", () => {
  const resolved = resolveSpawnCommand("C:\\Program Files\\nodejs\\node.exe", ["script.mjs"], {
    platform: "win32",
  });

  assert.equal(resolved.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(resolved.args, ["script.mjs"]);
});

test("check runner leaves native commands unchanged", () => {
  assert.deepEqual(resolveSpawnCommand("node", ["--version"], { platform: "linux" }), {
    command: "node",
    args: ["--version"],
  });
});

test("npm resolver uses npm_execpath as a shell-free npm entrypoint", async () => {
  const npmCli = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js";
  const resolved = await resolveNpmCommand(["run", "test:compiled"], {
    access: async (candidate) => {
      assert.equal(candidate, npmCli);
    },
    env: { npm_execpath: npmCli },
    nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
  });

  assert.deepEqual(resolved, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: [npmCli, "run", "test:compiled"],
  });
});

test("npm resolver checks common Windows npm-cli.js locations before failing", async () => {
  const npmCli = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js";
  const seen: string[] = [];
  const resolved = await resolveNpmCommand(["pack"], {
    access: async (candidate) => {
      seen.push(candidate);
      if (candidate !== npmCli) throw new Error("missing");
    },
    env: {
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      Path: "C:\\Tools",
    },
    nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
  });

  assert.deepEqual(resolved, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: [npmCli, "pack"],
  });
  assert.ok(seen.includes(npmCli));
});

test("npm resolver refuses bare npm fallback on Windows", async () => {
  await assert.rejects(
    resolveNpmCommand(["run", "test:compiled"], {
      access: async () => {
        throw new Error("missing");
      },
      env: { Path: "C:\\Tools" },
      nodeExecPath: "C:\\Node\\node.exe",
      platform: "win32",
    }),
    /will not fall back to npm\.cmd, npm\.ps1, or bare npm/,
  );
});

test("npm resolver keeps non-Windows bare npm fallback", async () => {
  const resolved = await resolveNpmCommand(["run", "test:compiled"], {
    access: async () => {
      throw new Error("missing");
    },
    env: { PATH: "/usr/bin" },
    nodeExecPath: "/usr/bin/node",
    platform: "linux",
  });

  assert.deepEqual(resolved, { command: "npm", args: ["run", "test:compiled"] });
});

test("demo export asset parity rejects a stale inline dashboard script", () => {
  const assets = {
    app: "console.log('fresh dashboard');",
    css: "body { color: #111111; }",
  };
  const html = [
    "<!doctype html>",
    "<style>",
    assets.css,
    "</style>",
    "<script>",
    "window.__AUTORESEARCH_DATA__ = [];",
    "window.__AUTORESEARCH_META__ = {};",
    "</script>",
    "<script>",
    "console.log('stale dashboard');",
    "</script>",
  ].join("\n");

  assert.deepEqual(dashboardExportAssetIssues(html, assets), [
    "inline dashboard script does not match assets/dashboard-build/dashboard-app.js after </script escaping",
  ]);
});

test("demo trust generates its dashboard export in ignored demo tmp", () => {
  const [label, command, args] = demoDashboardExportCommand();

  assert.equal(label, "demo:export");
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [
    "scripts/autoresearch.mjs",
    "export",
    "--cwd",
    "examples/demo-session",
    "--output",
    "tmp/autoresearch-dashboard.check.html",
    "--showcase",
  ]);
  assert.equal(
    dashboardGeneratedDemoExport,
    "examples/demo-session/tmp/autoresearch-dashboard.check.html",
  );
  assert.notEqual(
    dashboardGeneratedDemoExport,
    "examples/demo-session/autoresearch-dashboard.html",
  );
});

test("demo export asset parity accepts documented closing-tag escaping", () => {
  const assets = {
    app: "const closing = '</script>';",
    css: ".sample::after { content: '</style>'; }",
  };
  const html = [
    "<!doctype html>",
    "<style>",
    ".sample::after { content: '<\\/style>'; }",
    "</style>",
    "<script>",
    "window.__AUTORESEARCH_DATA__ = [];",
    "window.__AUTORESEARCH_META__ = {};",
    "</script>",
    "<script>",
    "const closing = '<\\/script>';",
    "</script>",
  ].join("\n");

  assert.deepEqual(dashboardExportAssetIssues(html, assets), []);
});

test("release package smoke rejects multi-entry checksum manifests", async () => {
  await withTempDir("release-checksum-multi-", async (dir) => {
    const tarball = path.join(dir, "codex-autoresearch-2.4.0.tgz");
    const checksum = path.join(dir, "codex-autoresearch-2.4.0.tgz.sha256");
    const bytes = "release tarball";
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(tarball, bytes, "utf8");
    await writeFile(
      checksum,
      `${hash}  ${path.basename(tarball)}\n${"0".repeat(64)}  other.tgz\n`,
      "utf8",
    );

    assert.match(
      await releaseChecksumIssue(tarball, checksum),
      /must contain exactly one asset entry; found 2/,
    );
  });
});

test("release package smoke rejects unnamed checksum manifests", async () => {
  await withTempDir("release-checksum-unnamed-", async (dir) => {
    const tarball = path.join(dir, "codex-autoresearch-2.4.0.tgz");
    const checksum = path.join(dir, "codex-autoresearch-2.4.0.tgz.sha256");
    const bytes = "release tarball";
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(tarball, bytes, "utf8");
    await writeFile(checksum, `${hash}\n`, "utf8");

    assert.match(
      await releaseChecksumIssue(tarball, checksum),
      /must contain a SHA-256 entry generated by sha256sum/,
    );
  });
});

async function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
