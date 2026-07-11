#!/usr/bin/env node
import { ensureRuntime, isDirectScript } from "./bootstrap-runtime.mjs";

const runtime = await import(await ensureRuntime("operator-task-benchmark.mjs", import.meta.url));

export const runOperatorTaskSuite = runtime.runOperatorTaskSuite;

if (isDirectScript(import.meta.url)) {
  process.exitCode = await runtime.runOperatorTaskSuite();
}
