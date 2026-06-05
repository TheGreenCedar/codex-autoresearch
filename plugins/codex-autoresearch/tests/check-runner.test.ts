import assert from "node:assert/strict";
import test from "node:test";

import { resolveSpawnCommand } from "../scripts/check-runner.js";

test("check runner invokes Windows command scripts through cmd without shell option", () => {
  const resolved = resolveSpawnCommand("npm.cmd", ["run", "test:compiled"], {
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    platform: "win32",
  });

  assert.equal(resolved.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(resolved.args, ["/d", "/c", "call", "npm.cmd", "run", "test:compiled"]);
});

test("check runner leaves native commands unchanged", () => {
  assert.deepEqual(resolveSpawnCommand("node", ["--version"], { platform: "linux" }), {
    command: "node",
    args: ["--version"],
  });
});
