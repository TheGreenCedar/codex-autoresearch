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

export const PRODUCT_PHASE_TIMEOUT_SECONDS = process.platform === "win32" ? 4_800 : 1_800;

export const PRODUCT_TEST_SCRIPTS = [
  "test:compiled:cli",
  "test:compiled:dashboard",
  "test:compiled:finalize",
  "test:compiled:process",
  "test:compiled:core",
] as const;

export async function runProductPhase(): Promise<boolean> {
  let productChecks: CommandSpec[];
  let testChecks: CommandSpec[];
  try {
    productChecks = productCheckCommands();
    testChecks = await Promise.all(
      PRODUCT_TEST_SCRIPTS.map(async (script): Promise<CommandSpec> => {
        const npmTest = await resolveNpmCommand(["run", script]);
        return [script, npmTest.command, npmTest.args];
      }),
    );
  } catch (error) {
    console.log("\n== product ==");
    console.log("fail npm-resolution");
    console.log(indent(errorMessage(error)));
    return false;
  }
  const [operatorEvidence, ...remainingChecks] = productChecks;
  const options = {
    streamOutput: true,
    timeoutSeconds: PRODUCT_PHASE_TIMEOUT_SECONDS,
  };
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
  if (!(await runPhase("product", remainingChecks, options))) return false;
  for (const testCheck of testChecks) {
    if (!(await runPhase(testCheck[0], [testCheck], options))) return false;
  }
  return true;
}

function productCheckCommands(): CommandSpec[] {
  return [
    ["operator-task-evidence", node, ["scripts/operator-task-benchmark.mjs", "--fail-on-failure"]],
    ["command-surface-map", node, ["dist/scripts/command-surface-map.mjs"]],
    ["help:autoresearch", node, ["scripts/autoresearch.mjs", "--help"]],
    ["help:finalize", node, ["scripts/finalize-autoresearch.mjs", "--help"]],
  ];
}
