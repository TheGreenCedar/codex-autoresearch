#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { ensureRuntime } from "./bootstrap-runtime.mjs";

const runtime = await import(await ensureRuntime("autoresearch.mjs", import.meta.url));

export const runAutoresearchCli = runtime.runAutoresearchCli;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await runtime.runAutoresearchCli(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
