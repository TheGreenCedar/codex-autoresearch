import { runOutcomeWorker } from "../lib/outcome-worker.js";
import { parseArgs } from "node:util";

const args = parseArgs({
  options: { cwd: { type: "string" }, execution: { type: "string" } },
  strict: true,
});
if (!args.values.cwd || !args.values.execution)
  throw new Error("A durable worker requires its nominated cwd and execution identity.");
await runOutcomeWorker(args.values.cwd, args.values.execution);
