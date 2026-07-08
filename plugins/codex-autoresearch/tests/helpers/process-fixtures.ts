import { resolvePackageRoot } from "../../lib/runtime-paths.js";
import { runProcess } from "./process.js";

const pluginRoot = resolvePackageRoot(import.meta.url);

export async function runNode(args, { cwd = pluginRoot, env = process.env } = {}) {
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  return await runProcess(process.execPath, args, {
    cwd,
    env: childEnv,
  });
}
