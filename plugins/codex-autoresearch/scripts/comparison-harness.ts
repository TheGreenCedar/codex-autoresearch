import fsp from "node:fs/promises";
import path from "node:path";
import {
  parseComparisonProtocol,
  prepareComparison,
  validateComparisonSchedule,
  collectComparison,
} from "../lib/comparative-protocol.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
};
async function json(file: string | null) {
  if (!file) throw new Error("A required study file is missing.");
  return JSON.parse(await fsp.readFile(path.resolve(file), "utf8"));
}
if (!args.includes("--enable")) {
  console.log(
    JSON.stringify({
      enabled: false,
      modelRunsStarted: 0,
      message:
        "Comparison is disabled. A separately authorized pilot or preregistered study is required before preparing or collecting trials.",
    }),
  );
} else {
  const protocol = parseComparisonProtocol(await json(option("--protocol-file")));
  if (args.includes("--prepare")) {
    const directory = option("--output-dir");
    if (!directory)
      throw new Error("Choose a new private output directory for the sealed schedule.");
    await fsp.mkdir(path.resolve(directory));
    const schedule = prepareComparison(protocol);
    await fsp.writeFile(
      path.join(directory, "schedule.private.json"),
      JSON.stringify(schedule, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    await fsp.writeFile(
      path.join(directory, "assessment.blind.json"),
      JSON.stringify(
        {
          protocolDigest: protocol.digest,
          trials: schedule.trials.map(({ id, taskId }) => ({ trialId: id, taskId })),
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        enabled: true,
        modelRunsStarted: 0,
        protocolDigest: protocol.digest,
        fixedTrials: schedule.trials.length,
        privateSchedule: path.resolve(directory, "schedule.private.json"),
        blindAssessment: path.resolve(directory, "assessment.blind.json"),
      }),
    );
  } else if (args.includes("--collect")) {
    const schedule = validateComparisonSchedule(await json(option("--schedule-file")), protocol);
    const receipts: unknown = await json(option("--receipts-file"));
    const assessments: unknown = option("--assessments-file")
      ? await json(option("--assessments-file"))
      : [];
    if (!Array.isArray(receipts) || !Array.isArray(assessments))
      throw new Error("Receipts and assessments must be arrays of signed envelopes.");
    console.log(
      JSON.stringify(collectComparison(protocol, schedule, receipts, assessments), null, 2),
    );
  } else
    console.log(
      JSON.stringify({
        enabled: true,
        modelRunsStarted: 0,
        protocolDigest: protocol.digest,
        message:
          "Protocol valid. Use --prepare or --collect; execution belongs to the accepted host and its enforced aggregate budgets.",
      }),
    );
}
