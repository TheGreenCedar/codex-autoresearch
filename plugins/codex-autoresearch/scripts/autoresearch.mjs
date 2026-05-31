#!/usr/bin/env node
import { ensureRuntime, isDirectScript } from "./bootstrap-runtime.mjs";

const runtime = await import(await ensureRuntime("autoresearch.mjs", import.meta.url));

export const runAutoresearchCli = runtime.runAutoresearchCli;

if (isDirectScript(import.meta.url)) {
  const code = await runtime.runAutoresearchCli(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
