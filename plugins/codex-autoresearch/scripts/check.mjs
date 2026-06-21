#!/usr/bin/env node
import { ensureRuntime } from "./bootstrap-runtime.mjs";

await import(await ensureRuntime("check.mjs", import.meta.url));
