import baseTest from "node:test";

type TestFn = typeof baseTest;
type ShardRange = {
  end: number;
  start: number;
};

const shard = parseShard(process.env.CODEX_AUTORESEARCH_TEST_SHARD);
const shardRange = parseShardRange(process.env.CODEX_AUTORESEARCH_TEST_SHARD_RANGE);
const discover = process.env.CODEX_AUTORESEARCH_TEST_DISCOVER === "1";
let testIndex = 0;

function parseShard(value: string | undefined): { index: number; total: number } | null {
  if (!value) return null;
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match) throw new Error(`Invalid CODEX_AUTORESEARCH_TEST_SHARD: ${value}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
    throw new Error(`Invalid CODEX_AUTORESEARCH_TEST_SHARD: ${value}`);
  }
  return { index, total };
}

function parseShardRange(value: string | undefined): ShardRange | null {
  if (!value) return null;
  const match = value.match(/^(\d+):(\d+)$/);
  if (!match) throw new Error(`Invalid CODEX_AUTORESEARCH_TEST_SHARD_RANGE: ${value}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new Error(`Invalid CODEX_AUTORESEARCH_TEST_SHARD_RANGE: ${value}`);
  }
  return { end, start };
}

function isEnabled(index: number): boolean {
  if (shardRange) return index >= shardRange.start && index < shardRange.end;
  if (shard) return index % shard.total === shard.index - 1;
  return true;
}

if (discover) {
  process.on("beforeExit", () => {
    console.log(`AUTORESEARCH_TEST_COUNT ${testIndex}`);
  });
}

const shardedTest = ((name: any, options: any, fn?: any) => {
  if ((!discover && !shard && !shardRange) || typeof name !== "string") {
    return (baseTest as any)(name, options, fn);
  }
  const current = testIndex;
  testIndex += 1;
  if (discover || !isEnabled(current)) return undefined as any;
  return (baseTest as any)(name, options, fn);
}) as TestFn;

Object.assign(shardedTest, baseTest);

export default shardedTest;
