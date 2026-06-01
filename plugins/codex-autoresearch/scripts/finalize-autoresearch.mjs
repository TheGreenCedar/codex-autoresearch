#!/usr/bin/env node
import { ensureRuntime } from "./bootstrap-runtime.mjs";

await import(await ensureRuntime("finalize-autoresearch.mjs", import.meta.url));
