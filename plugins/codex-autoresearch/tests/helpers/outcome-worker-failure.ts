import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readOutcome } from "../../lib/outcome-store.js";
import { runOutcomeWorker } from "../../lib/outcome-worker.js";

const cwd = process.argv[2];
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const originalPath = process.env[pathKey];
const removeProcessQueries = async () => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const childPid = Number(
      await fsp.readFile(path.join(cwd, "src/check-started.txt"), "utf8").catch(() => ""),
    );
    const state = await readOutcome(cwd);
    const child = state?.executions[0].worker?.child;
    if (child?.identity && child.pid === childPid) {
      process.env[pathKey] = "";
      return;
    }
    await delay(100);
  }
  throw new Error("The fixture check did not acquire a durable native identity.");
};
let monitorFailure: unknown = null;
const monitor = removeProcessQueries().catch((error: unknown) => {
  monitorFailure = error;
});
try {
  await runOutcomeWorker(cwd, "A1");
  await monitor;
  if (monitorFailure) throw monitorFailure;
} finally {
  process.env[pathKey] = originalPath;
  await fsp.mkdir(path.join(cwd, ".autoresearch"), { recursive: true });
  await fsp.writeFile(path.join(cwd, ".autoresearch/stop-check"), "stop");
}
