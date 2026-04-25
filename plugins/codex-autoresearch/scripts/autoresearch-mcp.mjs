#!/usr/bin/env node
import { ensureRuntime } from "./bootstrap-runtime.mjs";

await import(await ensureRuntime("autoresearch-mcp.mjs", import.meta.url));
