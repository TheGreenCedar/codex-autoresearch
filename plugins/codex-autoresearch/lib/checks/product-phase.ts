import { errorMessage, indent, node, runPhase, type CommandSpec } from "./check-common.js";
import { resolveNpmCommand } from "./npm-command.js";

export const PRODUCT_PHASE_TIMEOUT_SECONDS = 1_800;

export async function runProductPhase(): Promise<boolean> {
  let productChecks: CommandSpec[];
  try {
    productChecks = await productCheckCommands();
  } catch (error) {
    console.log("\n== product ==");
    console.log("fail npm-resolution");
    console.log(indent(errorMessage(error)));
    return false;
  }
  return runPhase("product", productChecks, {
    streamOutput: true,
    timeoutSeconds: PRODUCT_PHASE_TIMEOUT_SECONDS,
  });
}

async function productCheckCommands(): Promise<CommandSpec[]> {
  const npmTest = await resolveNpmCommand(["run", "test:compiled"]);
  return [
    ["quality-gap", node, ["scripts/perfection-benchmark.mjs", "--fail-on-gap"]],
    ["command-surface-map", node, ["dist/scripts/command-surface-map.mjs"]],
    ["help:autoresearch", node, ["scripts/autoresearch.mjs", "--help"]],
    ["help:finalize", node, ["scripts/finalize-autoresearch.mjs", "--help"]],
    ["tests", npmTest.command, npmTest.args],
  ];
}
