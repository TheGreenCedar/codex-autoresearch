import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runOutcomeWorker } from "../../lib/outcome-worker.js";
import { inspectProcessIdentity } from "../../lib/runner.js";

const cwd = process.argv[2];
const rename = fsp.rename;
let outcomeReplacements = 0;
let failedReplacement: string | null = null;
let failures = 0;
fsp.rename = async (from, to) => {
  if (path.basename(String(to)) === "outcome.json") {
    outcomeReplacements += 1;
    if (outcomeReplacements === 2) {
      failedReplacement = String(from);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (await fsp.readFile(path.join(cwd, "src/started.txt"), "utf8").catch(() => "")) break;
        await delay(10);
      }
      assert.ok(await fsp.readFile(path.join(cwd, "src/started.txt"), "utf8"));
    }
    if (String(from) === failedReplacement) {
      failures += 1;
      throw Object.assign(new Error("injected admission replacement failure"), { code: "EPERM" });
    }
  }
  await rename(from, to);
};
try {
  await runOutcomeWorker(cwd, "A1");
  assert.equal(failures, process.platform === "win32" ? 5 : 1);
  const childPid = Number(await fsp.readFile(path.join(cwd, "src/started.txt"), "utf8"));
  assert.equal((await inspectProcessIdentity(childPid)).identity, null);
} finally {
  fsp.rename = rename;
  await fsp.mkdir(path.join(cwd, ".autoresearch"), { recursive: true });
  await fsp.writeFile(path.join(cwd, ".autoresearch/stop-admission-child"), "stop");
  const childPid = Number(
    await fsp.readFile(path.join(cwd, "src/started.txt"), "utf8").catch(() => ""),
  );
  if (childPid)
    for (let attempts = 0; attempts < 20; attempts++) {
      if ((await inspectProcessIdentity(childPid)).identity === null) break;
      await delay(100);
    }
}
