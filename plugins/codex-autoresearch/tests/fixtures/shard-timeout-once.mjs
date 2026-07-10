import test from "node:test";
import { access, writeFile } from "node:fs/promises";

if (process.env.CODEX_AUTORESEARCH_TEST_DISCOVER === "1") {
  process.on("beforeExit", () => console.log("AUTORESEARCH_TEST_COUNT 2"));
} else {
  const range = process.env.CODEX_AUTORESEARCH_TEST_SHARD_RANGE;
  if (range === "0:1") {
    test("times out once", async () => {
      try {
        await access(process.env.SHARD_RETRY_MARKER);
      } catch {
        await writeFile(process.env.SHARD_RETRY_MARKER, "seen");
        await new Promise(() => {});
      }
    });
  }
  if (range === "1:2") test("passes", () => {});
}
