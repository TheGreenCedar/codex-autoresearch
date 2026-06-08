import assert from "node:assert/strict";
import test from "node:test";

import { resolveSpawnCommand } from "../scripts/check-runner.js";
import { resolveNpmCommand } from "../scripts/check.js";

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
