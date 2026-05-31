import path from "node:path";
import { runCommand } from "./check-runner.js";

type ShardResult = {
  code: number | null;
  count: number | null;
  durationSeconds: number;
  label: string;
  stderr: string;
  stdout: string;
};

type ShardSpec = {
  file: string;
  shards: number;
};

type ShardTask = {
  count: number | null;
  label: string;
  range: { end: number; start: number } | null;
  spec: ShardSpec;
};

function parseArgs(argv: string[]): { jobs: number; specs: ShardSpec[] } {
  let jobs = parsePositiveInteger(
    process.env.CODEX_AUTORESEARCH_TEST_SHARD_JOBS || "8",
    "CODEX_AUTORESEARCH_TEST_SHARD_JOBS",
  );
  const specs: ShardSpec[] = [];
  let index = 0;
  if (argv[index] === "--jobs") {
    jobs = parsePositiveInteger(argv[index + 1], "--jobs");
    index += 2;
  }
  for (; index < argv.length; index += 1) {
    const file = argv[index];
    const next = argv[index + 1];
    const shards = Number(next);
    if (!file || !Number.isInteger(shards) || shards < 1) {
      throw new Error(
        "Usage: node scripts/run-test-shards.mjs [--jobs <count>] <test-file> <shards> [...]",
      );
    }
    specs.push({ file, shards });
    index += 1;
  }
  if (!specs.length) throw new Error("At least one test file and shard count is required.");
  return { jobs, specs };
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${label} must be a positive integer.\nUsage: node scripts/run-test-shards.mjs [--jobs <count>] <test-file> <shards> [...]`,
    );
  }
  return parsed;
}

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<ShardResult> {
  const label = args.at(-1) || "node";
  const startedAt = Date.now();
  return runCommand([label, process.execPath, args], { cwd: process.cwd(), env }).then(
    (result) => ({
      code: result.code,
      count: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      label,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  );
}

async function discoverTestCount(file: string): Promise<number | null> {
  const result = await runNode(["--test", "--test-concurrency=1", file], {
    ...process.env,
    CODEX_AUTORESEARCH_TEST_DISCOVER: "1",
  });
  if (result.code !== 0) {
    console.log(`${result.stdout}${result.stderr}`.trim());
    throw new Error(`Failed to discover test count for ${file}`);
  }
  const match = result.stdout.match(/(?:^|\n)AUTORESEARCH_TEST_COUNT (\d+)(?:\r?\n|$)/);
  return match ? Number(match[1]) : null;
}

function buildTasks(spec: ShardSpec, count: number | null): ShardTask[] {
  if (!count || spec.shards === 1) {
    return [{ count, label: `${path.basename(spec.file)} 1/1`, range: null, spec }];
  }
  const shards = Math.min(spec.shards, count);
  const size = Math.ceil(count / shards);
  const tasks = Array.from({ length: shards }, (_, index) => {
    const start = index * size;
    const end = Math.min(count, start + size);
    return {
      count: end - start,
      label: "",
      range: { end, start },
      spec,
    };
  }).filter((task) => task.range && task.range.start < task.range.end);
  return tasks.map((task, index) => ({
    ...task,
    label: `${path.basename(spec.file)} ${index + 1}/${tasks.length} (${task.range.start + 1}-${task.range.end})`,
  }));
}

async function runShard(task: ShardTask): Promise<ShardResult> {
  const startedAt = Date.now();
  const result = await runNode(["--test", "--test-concurrency=1", task.spec.file], {
    ...process.env,
    ...(task.range
      ? { CODEX_AUTORESEARCH_TEST_SHARD_RANGE: `${task.range.start}:${task.range.end}` }
      : {}),
  });
  return {
    ...result,
    count: task.count,
    durationSeconds: (Date.now() - startedAt) / 1000,
    label: task.label,
  };
}

async function runWithLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const current = next;
      next += 1;
      results[current] = await tasks[current]();
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(result: ShardResult): string {
  const status = result.code === 0 ? "PASS" : "FAIL";
  const code = result.code === 0 ? "" : ` code=${result.code}`;
  const count = result.count == null ? "" : ` tests=${result.count}`;
  return `${status} ${result.label}${code}${count} (${result.durationSeconds.toFixed(1)}s)`;
}

const startedAt = Date.now();
const { jobs, specs } = parseArgs(process.argv.slice(2));
const tasks = (
  await Promise.all(
    specs.map(async (spec) => {
      if (spec.shards === 1) return buildTasks(spec, null);
      const count = await discoverTestCount(spec.file);
      if (count == null) {
        throw new Error(
          `${spec.file} did not emit AUTORESEARCH_TEST_COUNT during shard discovery.`,
        );
      }
      return buildTasks(spec, count);
    }),
  )
).flat();
const results = await runWithLimit(
  tasks.map((task) => () => runShard(task)),
  jobs,
);

for (const result of results) {
  console.log(summarize(result));
  const output = `${result.stdout}${result.stderr}`;
  if (result.code !== 0 || process.env.CODEX_AUTORESEARCH_TEST_SHARD_VERBOSE === "1") {
    console.log(output.trim());
  }
}

console.log(`Shard wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
if (results.some((result) => result.code !== 0)) process.exitCode = 1;
