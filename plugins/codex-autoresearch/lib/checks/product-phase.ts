import { validateOperatorTaskRunOutput } from "../../scripts/operator-task-benchmark.js";
import {
  errorMessage,
  indent,
  node,
  runCommand,
  runPhase,
  type CommandSpec,
} from "./check-common.js";
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
  const [operatorEvidence, ...remainingChecks] = productChecks;
  const options = { streamOutput: true, timeoutSeconds: PRODUCT_PHASE_TIMEOUT_SECONDS };
  console.log("\n== operator task evidence ==");
  const evidenceResult = await runCommand(operatorEvidence, options);
  try {
    if (evidenceResult.code !== 0) throw new Error(`Operator tasks exited ${evidenceResult.code}.`);
    validateOperatorTaskRunOutput(evidenceResult.stdout);
    console.log("ok operator-task-evidence");
  } catch (error) {
    console.log("fail operator-task-evidence");
    console.log(indent(errorMessage(error)));
    return false;
  }
  return await runPhase("product", remainingChecks, options);
}

async function productCheckCommands(): Promise<CommandSpec[]> {
  const npmTest = await resolveNpmCommand(["run", "test:compiled"]);
  return [
    ["operator-task-evidence", node, ["scripts/operator-task-benchmark.mjs", "--fail-on-failure"]],
    ["command-surface-map", node, ["dist/scripts/command-surface-map.mjs"]],
    ["help:autoresearch", node, ["scripts/autoresearch.mjs", "--help"]],
    ["help:finalize", node, ["scripts/finalize-autoresearch.mjs", "--help"]],
    ["tests", npmTest.command, npmTest.args],
  ];
}
