import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

// Run in a dedicated Node process: this mocks built-in process/OS boundaries.
// No command is spawned and no real process receives a signal.
test("Windows orphan cleanup retains uncertainty and never adopts a reused root PID", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalKill = process.kill;
  const originalExecFile = childProcess.execFile;
  const rootPid = 424240;
  const orphanPid = 424241;
  let scenario = "orphan";
  let livePids = new Set<number>();
  let calls: { ids: number[]; force: boolean; liveRoot: boolean }[] = [];

  Object.defineProperty(process, "platform", { value: "win32" });
  process.kill = (pid, signal) => {
    assert.equal(signal, 0, "Only mocked liveness queries are allowed.");
    if (livePids.has(pid)) return true;
    throw Object.assign(new Error("Process absent"), { code: "ESRCH" });
  };
  childProcess.execFile = ((
    command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, output: string) => void,
  ) => {
    if (command === "powershell.exe") {
      const script = args[args.indexOf("-Command") + 1];
      if (script.includes("$RootProcessId")) {
        // The initial required-root query cannot find the exited evaluator.
        if (args.at(-1) === "1") {
          queueMicrotask(() => callback(Object.assign(new Error("root_missing"), { code: 1 }), ""));
          return {};
        }
        // Before the refreshed query, an unrelated process reuses the root PID.
        if (scenario === "reused") livePids.add(rootPid);
        const rows = [
          ...(livePids.has(rootPid)
            ? [{ pid: rootPid, ppid: 1, started: "NEW-UNRELATED-ROOT" }]
            : []),
          ...(livePids.has(orphanPid)
            ? [{ pid: orphanPid, ppid: rootPid, started: "OWNED-ORPHAN" }]
            : []),
        ];
        queueMicrotask(() => callback(null, JSON.stringify(rows)));
        return {};
      }
      const rows = [
        ...(livePids.has(orphanPid) ? [{ pid: orphanPid, started: "OWNED-ORPHAN" }] : []),
        ...(livePids.has(rootPid) ? [{ pid: rootPid, started: "NEW-UNRELATED-ROOT" }] : []),
      ];
      queueMicrotask(() => callback(null, JSON.stringify(rows)));
      return {};
    }
    if (command === "taskkill") {
      const ids = args.flatMap((value, index) =>
        value === "/pid" ? [Number(args[index + 1])] : [],
      );
      calls.push({ ids, force: args.includes("/f"), liveRoot: livePids.has(rootPid) });
      const found = ids.some((pid) => livePids.has(pid));
      for (const pid of ids) {
        livePids.delete(pid);
        if (pid === rootPid && found) livePids.delete(orphanPid);
      }
      queueMicrotask(() =>
        callback(found ? null : Object.assign(new Error("Process absent"), { code: 128 }), ""),
      );
      return {};
    }
    throw new Error(`Unexpected mocked command: ${command}`);
  }) as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();

  try {
    const { terminateProcessTree } = await import("../../lib/runner.js");
    for (scenario of ["orphan", "reused"]) {
      livePids = new Set([orphanPid]);
      calls = [];
      const result = await terminateProcessTree(rootPid);
      const unrelatedRootTargeted = calls.some(
        (call) => call.ids.includes(rootPid) && call.liveRoot,
      );

      assert.equal(result.proven, false, "Missing initial root identity must retain uncertainty.");
      assert.equal(
        calls.some((call) => call.ids.includes(rootPid)),
        false,
        "A missing initial root does not authorize root taskkill.",
      );
      if (scenario === "orphan") {
        assert.equal(livePids.has(orphanPid), false, "Ordinary orphan cleanup must still work.");
      } else {
        assert.equal(unrelatedRootTargeted, false, "Never kill a replacement root.");
        assert.equal(livePids.has(rootPid), true, "Replacement root remains untouched.");
      }
    }
  } finally {
    childProcess.execFile = originalExecFile;
    process.kill = originalKill;
    Object.defineProperty(process, "platform", originalPlatform);
    syncBuiltinESMExports();
  }
});
