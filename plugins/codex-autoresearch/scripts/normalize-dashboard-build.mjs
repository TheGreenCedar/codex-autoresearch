#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const bundlePath = path.join(process.cwd(), "assets", "dashboard-build", "dashboard-app.js");
let bundle = readFileSync(bundlePath, "utf8");

bundle = bundle
  .replaceAll(
    "Object.defineProperty(n.prototype,`props`,",
    'Object.defineProperty(n.prototype,"props",',
  )
  .replaceAll(
    "Object.defineProperty(r.DetermineComponentFrameRoot,`name`,",
    'Object.defineProperty(r.DetermineComponentFrameRoot,"name",',
  )
  .replaceAll("Object.defineProperty(mn,`passive`,", 'Object.defineProperty(mn,"passive",');

writeFileSync(bundlePath, bundle);
