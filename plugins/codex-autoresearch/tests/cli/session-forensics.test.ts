import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { commandForDecisionCapsule } from "../../lib/commands/session-forensics.js";
import { writeDecisionCapsule } from "../helpers/git-fixtures.js";
import { pathExists } from "../helpers/cli-session.js";
import { quoteForShell } from "../helpers/process.js";

import { pluginRoot, runCli, withTempDir, setupFixture } from "../helpers/cli-test-context.js";

test("session-forensics supports dry-run and safe apply capsule writes", async () => {
  await withTempDir("session-forensics-cli", async (dir) => {
    const sessionPath = path.join(dir, "rollout.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-25T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Segments UX is not the best." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "git status --short" }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.500Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "API_KEY=abcdefghijklmnop node scripts/private-check.mjs",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.600Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "API_KEY=abc$def%ghi node scripts/private-check.mjs",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.700Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: 'CLIENT_SECRET="abc def ghijkl" node scripts/private-check.mjs',
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.800Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "TOKEN=abc:def:ghijkl node scripts/private-check.mjs",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.850Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "node scripts/private-check.mjs --api-key flagsecretvalue123",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.900Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: 'node scripts/private-check.mjs --client-secret "flag secret value 456"',
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.950Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "node scripts/private-check.mjs --api-key=flag:secret:value789",
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call1",
            output:
              "Chunk ID: abc\nProcess exited with code 0\nOriginal token count: 25000\nTotal output lines: 600\nOutput:\ntoken=abcdefghijklmnop",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:03.000Z",
          type: "compacted",
          payload: {},
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:04.000Z",
          type: "compacted",
          payload: {},
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:05.000Z",
          type: "compacted",
          payload: {},
        }),
      ].join("\n"),
    );

    const dryRun = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--dry-run",
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.ok, true);
    assert.equal(dryPayload.dryRun, true);
    assert.equal(dryPayload.wrote, false);
    assert.equal(dryPayload.sourcePath, "rollout.jsonl");
    assert.equal(dryPayload.compact, true);
    assert.equal(typeof dryPayload.commandClassCount, "number");
    assert.equal(Object.hasOwn(dryPayload, "commandClasses"), false);
    for (const rawSecret of [
      "abcdefghijklmnop",
      "abc$def%ghi",
      "abc def ghijkl",
      "abc:def:ghijkl",
      "flagsecretvalue123",
      "flag secret value 456",
      "flag:secret:value789",
    ]) {
      assert.equal(JSON.stringify(dryPayload).includes(rawSecret), false);
      assert.equal(JSON.stringify(dryPayload.topCommandHeads).includes(rawSecret), false);
    }
    assert.equal((dryPayload.canonicalNextAction.command || "").includes(sessionPath), false);
    assert.equal(dryPayload.canonicalNextAction.kind, "decision-capsule");
    assert.match(dryPayload.canonicalNextAction.command || "", /session-forensics/);
    assert.match(dryPayload.canonicalNextAction.command || "", /--apply/);
    assert.match(dryPayload.canonicalNextAction.command || "", /--session-jsonl rollout\.jsonl/);
    assert.match(dryPayload.canonicalNextAction.command || "", /--research-slug session-019e/);
    assert.doesNotMatch(dryPayload.canonicalNextAction.command || "", /recommend-next/);
    assert.doesNotMatch(
      dryPayload.canonicalNextAction.command || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.equal(dryPayload.plannedFiles.length, 5);
    assert.equal(dryPayload.decisionCapsule.kind, "session-decision-capsule");
    assert.match(dryPayload.decisionCapsule.nextExperiment, /context capsule|bounded|cheapest/i);
    await assert.rejects(() =>
      access(path.join(dir, "autoresearch.research", "session-019e", "session-digest.md")),
    );

    const applied = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--apply",
    ]);
    assert.equal(applied.code, 0, applied.stderr);
    const applyPayload = JSON.parse(applied.stdout);
    assert.equal(applyPayload.wrote, true);
    assert.equal(applyPayload.evidenceClaims > 0, true);

    const researchRoot = path.join(dir, "autoresearch.research", "session-019e");
    const digest = await readFile(path.join(researchRoot, "session-digest.md"), "utf8");
    const capsule = JSON.parse(
      await readFile(path.join(researchRoot, "decision-capsule.json"), "utf8"),
    );
    const gaps = await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8");
    const evidence = JSON.parse(
      await readFile(path.join(researchRoot, "evidence-index.json"), "utf8"),
    );
    assert.doesNotMatch(
      capsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.match(capsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.match(digest, /Session Forensics Import/);
    assert.match(digest, /Decision Capsule/);
    assert.equal(capsule.kind, "session-decision-capsule");
    assert.equal(JSON.stringify(capsule).includes("abcdefghijklmnop"), false);
    assert.match(gaps, /\[evidence:ev-/);
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(JSON.stringify(evidence).includes("abcdefghijklmnop"), false);

    const full = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--dry-run",
      "--json-full",
    ]);
    assert.equal(full.code, 0, full.stderr);
    const fullPayload = JSON.parse(full.stdout);
    assert.equal(fullPayload.compact, false);
    assert.equal(fullPayload.commandClasses["git status --short"], 1);
    assert.equal(
      fullPayload.commandClasses["API_KEY=<redacted> node scripts/private-check.mjs"],
      2,
    );
    assert.equal(
      fullPayload.commandClasses["CLIENT_SECRET=<redacted> node scripts/private-check.mjs"],
      1,
    );
    assert.equal(fullPayload.commandClasses["TOKEN=<redacted> node scripts/private-check.mjs"], 1);
    assert.equal(
      fullPayload.commandClasses["node scripts/private-check.mjs --api-key <redacted>"],
      1,
    );
    assert.equal(
      fullPayload.commandClasses["node scripts/private-check.mjs --client-secret <redacted>"],
      1,
    );
    assert.equal(
      fullPayload.commandClasses["node scripts/private-check.mjs --api-key=<redacted>"],
      1,
    );
    assert.equal(JSON.stringify(fullPayload.commandClasses).includes("abcdefghijklmnop"), false);
    assert.equal(JSON.stringify(fullPayload).includes("abcdefghijklmnop"), false);
    for (const rawSecret of [
      "abc$def%ghi",
      "abc def ghijkl",
      "abc:def:ghijkl",
      "flagsecretvalue123",
      "flag secret value 456",
      "flag:secret:value789",
    ]) {
      assert.equal(JSON.stringify(fullPayload).includes(rawSecret), false);
    }
    assert.equal(Array.isArray(fullPayload.productSignals), true);

    const reapplied = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "session-019e",
      "--apply",
    ]);
    assert.equal(reapplied.code, 0, reapplied.stderr);
    const evidenceAfter = JSON.parse(
      await readFile(path.join(researchRoot, "evidence-index.json"), "utf8"),
    );
    const claimIds = new Set(
      (evidenceAfter.claims || []).map((claim: { id?: string }) => claim.id).filter(Boolean),
    );
    const gapsAfter = await readFile(path.join(researchRoot, "quality-gaps.md"), "utf8");
    const referencedIds = [...gapsAfter.matchAll(/\[evidence:(ev-[^\]]+)\]/g)].map(
      (match) => match[1],
    );
    assert.equal(referencedIds.length > 0, true);
    for (const evidenceId of referencedIds) {
      assert.equal(claimIds.has(evidenceId), true, evidenceId);
    }
    assert.equal((evidenceAfter.claims || []).length >= (evidence.claims || []).length, true);
  });
});

test("session-forensics routes context distillation to apply despite stale safe hints", () => {
  const script = path.join(pluginRoot, "state", "scripts", "autoresearch.mjs");
  const subcommandFor = (command: string) => {
    const launcherIndex = command.indexOf("autoresearch.mjs");
    assert.notEqual(launcherIndex, -1);
    const tokens = command
      .slice(launcherIndex + "autoresearch.mjs".length)
      .trim()
      .split(/\s+/);
    return tokens[0];
  };
  const commands = {
    state: `node ${script} state --cwd C:\\repo --compact`,
    recommendNext: `node ${script} recommend-next --cwd C:\\repo --compact`,
    benchmarkLint: `node ${script} benchmark-lint --cwd C:\\repo`,
    applyForensics: `node ${script} session-forensics --cwd C:\\repo --session-jsonl rollout.jsonl --research-slug session-019e --apply`,
  };

  for (const commandHint of [
    "node scripts/autoresearch.mjs recommend-next --cwd <project> --compact",
    "node scripts/autoresearch.mjs state --cwd <project> --compact",
  ]) {
    const command = commandForDecisionCapsule(
      {
        enforcement: {
          commandHint,
          triggeredBy: ["sessionDecisionCapsule", "contextDistillation"],
        },
      },
      commands,
    );

    assert.match(command, /session-forensics/);
    assert.equal(subcommandFor(command), "session-forensics");
    assert.match(command, /--apply/);
    assert.match(command, /--session-jsonl rollout\.jsonl/);
    assert.match(command, /--research-slug session-019e/);
  }
});

test("session-forensics preserves advisory capsule command hints", async () => {
  await withTempDir("session-forensics-advisory-hint", async (dir) => {
    const sessionPath = path.join(dir, "advisory-rollout.jsonl");
    const rows = [
      JSON.stringify({
        timestamp: "2026-06-12T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "019eadvisory" },
      }),
      JSON.stringify({
        timestamp: "2026-06-12T10:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Reviewed the imported session signals and found no blocker.",
            },
          ],
        },
      }),
    ];
    await writeFile(sessionPath, rows.join("\n"));

    const dryRun = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "advisory",
      "--dry-run",
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.decisionCapsule.enforcement.mode, "advisory");
    assert.equal(dryPayload.canonicalNextAction.kind, "next-packet");
    assert.equal(dryPayload.canonicalNextAction.command || "", "");
    assert.match(dryPayload.decisionCapsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.match(dryPayload.decisionCapsule.enforcement.commandHint || "", /recommend-next/);
    assert.match(dryPayload.decisionCapsule.enforcement.commandHint || "", /--compact/);
    assert.doesNotMatch(
      dryPayload.decisionCapsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );

    const applied = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "advisory",
      "--apply",
    ]);
    assert.equal(applied.code, 0, applied.stderr);
    const applyPayload = JSON.parse(applied.stdout);
    assert.equal(applyPayload.decisionCapsule.enforcement.mode, "advisory");
    assert.equal(applyPayload.canonicalNextAction.kind, "next-packet");
    assert.equal(applyPayload.canonicalNextAction.command || "", "");
    assert.match(applyPayload.decisionCapsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.match(applyPayload.decisionCapsule.enforcement.commandHint || "", /recommend-next/);
    assert.match(applyPayload.decisionCapsule.enforcement.commandHint || "", /--compact/);
    assert.doesNotMatch(
      applyPayload.decisionCapsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );

    const capsule = JSON.parse(
      await readFile(
        path.join(dir, "autoresearch.research", "advisory", "decision-capsule.json"),
        "utf8",
      ),
    );
    assert.equal(capsule.enforcement.mode, "advisory");
    assert.match(capsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.match(capsule.enforcement.commandHint || "", /recommend-next/);
    assert.match(capsule.enforcement.commandHint || "", /--compact/);
    assert.doesNotMatch(
      capsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
  });
});

test("session-forensics dry run surfaces goal-frame correction capsule", async () => {
  await withTempDir("session-forensics-goal-frame", async (dir) => {
    const sessionPath = path.join(dir, "goal-frame-rollout.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-06-01T13:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "That's not the goal of the autoresearch, that's my prompt. Keep the real research goal from the project state.",
              },
            ],
          },
        }),
      ].join("\n"),
    );

    const result = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "goal-frame-correction",
      "--dry-run",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.wrote, false);
    assert.equal(payload.canonicalNextAction.kind, "decision-capsule");
    assert.equal(payload.decisionCapsule.enforcement.mode, "bounded-next");
    assert.equal(payload.decisionCapsule.enforcement.canRunNextPacket, false);
    assert.equal(payload.decisionCapsule.enforcement.allowBoundedNext, true);
    assert.equal(
      payload.productSignals.some((signal) => signal.kind === "goal_frame_mismatch"),
      true,
    );
    assert.match(payload.decisionCapsule.bottleneck, /goal-frame drift/i);
    assert.match(payload.nextAction, /durable Autoresearch goal/i);
  });
});

test("session-forensics requires an explicit gate for outside-workdir JSONL", async () => {
  await withTempDir("session-forensics-boundary", async (dir) => {
    const projectDir = path.join(dir, "project");
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(dir, "outside-rollout.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-25T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Segments UX is not the best." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.000Z",
          type: "compacted",
          payload: {},
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:02.000Z",
          type: "compacted",
          payload: {},
        }),
        JSON.stringify({
          timestamp: "2026-05-25T00:00:03.000Z",
          type: "compacted",
          payload: {},
        }),
      ].join("\n"),
    );

    const blocked = await runCli([
      "session-forensics",
      "--cwd",
      projectDir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "outside-session",
      "--dry-run",
    ]);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /--allow-outside-workdir/);

    const allowed = await runCli([
      "session-forensics",
      "--cwd",
      projectDir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "outside-session",
      "--dry-run",
      "--allow-outside-workdir",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    const payload = JSON.parse(allowed.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.sourcePath, "<outside-workdir>/outside-rollout.jsonl");
    assert.equal(payload.canonicalNextAction.kind, "decision-capsule");
    assert.match(payload.canonicalNextAction.command || "", /session-forensics/);
    assert.match(payload.canonicalNextAction.command || "", /--apply/);
    assert.match(payload.canonicalNextAction.command || "", /--allow-outside-workdir/);
    assert.doesNotMatch(payload.canonicalNextAction.command || "", /<outside-workdir>/);
    assert.equal((payload.canonicalNextAction.command || "").includes(sessionPath), true);
    assert.doesNotMatch(
      payload.canonicalNextAction.command || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.match(payload.canonicalNextAction.reason || "", /context capsule/i);
    assert.deepEqual(payload.snippets, []);
  });
});

test("session-forensics keeps secondary overfit blockers visible in compact output", async () => {
  await withTempDir("session-forensics-real-shape", async (dir) => {
    const sessionPath = path.join(dir, "real-shape-rollout.jsonl");
    const rows = [
      JSON.stringify({
        timestamp: "2026-06-11T20:24:14.000Z",
        type: "session_meta",
        payload: { id: "019eb85a" },
      }),
      ...Array.from({ length: 6 }, (_item, index) =>
        JSON.stringify({
          timestamp: `2026-06-12T20:00:0${index}.000Z`,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "benchmark-lint timed out and parses zero primary METRIC lines; the benchmark contract is broken.",
              },
            ],
          },
        }),
      ),
      JSON.stringify({
        timestamp: "2026-06-12T22:40:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "The targeted row wins are substantially overfit benchmark-specific retrieval steering through task-family detectors, protected probes, and static citations.",
            },
          ],
        },
      }),
    ];
    await writeFile(sessionPath, rows.join("\n"));

    const result = await runCli([
      "session-forensics",
      "--cwd",
      dir,
      "--session-jsonl",
      sessionPath,
      "--research-slug",
      "real-shape",
      "--dry-run",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const productKinds = new Map(payload.productSignals.map((signal) => [signal.kind, signal]));

    assert.equal(payload.compact, true);
    assert.equal(payload.canonicalNextAction.kind, "decision-capsule");
    assert.match(payload.canonicalNextAction.command || "", /benchmark-lint/);
    assert.doesNotMatch(
      payload.canonicalNextAction.command || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.doesNotMatch(
      payload.decisionCapsule.enforcement.commandHint || "",
      /node scripts[\\/]autoresearch\.mjs/i,
    );
    assert.match(payload.decisionCapsule.enforcement.commandHint || "", /autoresearch\.mjs/);
    assert.equal(productKinds.has("benchmark_contract_broken"), true);
    assert.equal(productKinds.has("benchmark_overfit_steering"), true);
    assert.match(payload.decisionCapsule.evidence.join("\n"), /overfit row wins/i);
    assert.equal(Object.hasOwn(payload, "commandClasses"), false);
  });
});

test("state and recommend-next surface active decision capsules as loop brakes", async () => {
  await withTempDir("active-decision-capsule-state", async (dir) => {
    await setupFixture(dir, { name: "capsule state" });
    await writeDecisionCapsule(dir, "benchmark-contract");

    const state = await runCli(["state", "--cwd", dir, "--compact"]);
    assert.equal(state.code, 0, state.stderr);
    const statePayload = JSON.parse(state.stdout);
    assert.equal(statePayload.resolvedDecision.canonicalNextAction.kind, "decision-capsule");
    assert.notEqual(statePayload.resolvedDecision.canonicalNextAction.toolName, "decision_capsule");
    assert.equal(statePayload.resolvedDecision.canonicalNextAction.toolName, "recommend_next");
    assert.equal(statePayload.resolvedDecision.loopContract.canRunNextPacket, false);
    const stateActionCommand = statePayload.resolvedDecision.canonicalNextAction.command || "";
    assert.match(
      stateActionCommand,
      /autoresearch\.mjs (?:recommend-next|state|benchmark-lint)\b/,
      JSON.stringify({
        resolvedDecision: statePayload.resolvedDecision,
        commands: statePayload.commands,
      }),
    );
    assert.doesNotMatch(stateActionCommand, /node scripts[\\/]autoresearch\.mjs/i);

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    const recommendPayload = JSON.parse(recommend.stdout);
    assert.equal(recommendPayload.resolvedDecision.canonicalNextAction.kind, "decision-capsule");
    assert.notEqual(
      recommendPayload.resolvedDecision.canonicalNextAction.toolName,
      "decision_capsule",
    );
    assert.equal(recommendPayload.resolvedDecision.canonicalNextAction.toolName, "recommend_next");
    const recommendActionCommand =
      recommendPayload.resolvedDecision.canonicalNextAction.command || "";
    assert.match(
      recommendActionCommand,
      /autoresearch\.mjs (?:recommend-next|state|benchmark-lint)\b/,
      JSON.stringify({
        resolvedDecision: recommendPayload.resolvedDecision,
        commands: recommendPayload.commands,
      }),
    );
    assert.doesNotMatch(recommendActionCommand, /node scripts[\\/]autoresearch\.mjs/i);
    assert.match(recommendPayload.nextAction, /benchmark-lint|primary METRIC/i);

    const doctor = await runCli(["doctor", "--cwd", dir, "--explain", "--json-full"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.ok, false);
    assert.equal(doctorPayload.resolvedDecision.loopContract.canRunNextPacket, false);
    assert.equal(doctorPayload.resolvedDecision.canonicalNextAction.kind, "decision-capsule");
    assert.equal(doctorPayload.state.resolvedDecision.canonicalNextAction.kind, "decision-capsule");
    assert.equal(doctorPayload.state.sessionDecisionCapsule.kind, "session-decision-capsule");
    assert.match(doctorPayload.issues.join("\n"), /benchmark-lint|primary METRIC/i);
    assert.match(doctorPayload.nextAction, /benchmark-lint|primary METRIC/i);
    assert.doesNotMatch(doctorPayload.explanation.verdict, /no blocking/i);

    const { toolSchemas } = await import("../../lib/tool-schemas.js");
    const doctorSchema = toolSchemas.find((tool) => tool.name === "doctor_session");
    assert.ok(doctorSchema);
    for (const field of Object.keys(doctorPayload)) {
      assert.ok(
        doctorSchema.outputSchema.properties[field],
        `doctor_session schema should cover doctor --explain field ${field}`,
      );
    }
    assert.equal(doctorSchema.outputSchema.properties.resolvedDecision.type, "object");
    assert.equal(doctorSchema.outputSchema.properties.runtimeProvenance.type, "object");
    assert.equal(doctorSchema.outputSchema.properties.decisionEnvelope, undefined);
    assert.equal(doctorSchema.outputSchema.properties.sessionDecisionCapsule.type, "object");
    assert.match(doctorSchema.outputSchema.properties.state.description, /machine diagnostic/);
  });
});

test("recommend-next compact bounds noisy session evidence", async () => {
  await withTempDir("recommend-next-noisy-session", async (dir) => {
    await setupFixture(dir, { name: "noisy compact" });
    const rawBody = [
      "RAW_TOOL_OUTPUT_BODY_SENTINEL",
      "Chunk ID: noisy",
      "Original token count: 65601",
      "Output:",
      "x".repeat(9000),
    ].join("\n");
    await writeDecisionCapsule(dir, "noisy-session", {
      evidence: [
        "User rejected the product bar after accuracy was not tested.",
        "Assistant admitted the loop-complete signal was treated as enough.",
        "Tool output exceeded the compact handoff budget.",
        rawBody,
      ],
      commandBudgetWarnings: [rawBody],
    });

    const recommend = await runCli(["recommend-next", "--cwd", dir, "--compact"]);
    assert.equal(recommend.code, 0, recommend.stderr);
    assert.equal(recommend.stdout.length < 7000, true, String(recommend.stdout.length));
    assert.doesNotMatch(recommend.stdout, /RAW_TOOL_OUTPUT_BODY_SENTINEL/);
    const payload = JSON.parse(recommend.stdout);
    assert.ok((payload.evidenceNotes || []).length <= 3);
  });
});

test("next refuses hard decision capsules before running a packet", async () => {
  await withTempDir("next-hard-decision-capsule", async (dir) => {
    await setupFixture(dir, { name: "hard capsule" });
    await writeDecisionCapsule(dir, "benchmark-contract");

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const result = await runCli(["next", "--cwd", dir, "--command", command, "--compact"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.refused, true);
    assert.equal(payload.code, "next_blocked_by_loop_contract");
    assert.equal(payload.blockingAction.kind, "decision-capsule");
    assert.equal(payload.sessionDecisionCapsule.enforcement.mode, "hard-block");
    assert.match(payload.clearingCondition, /benchmark-lint/i);
  });
});

test("next refuses fixed-control rerun commands without override", async () => {
  await withTempDir("fixed-control-next", async (dir) => {
    const secret = "sk-fixed-control-next-secret-123";
    const sentinel = path.join(dir, "next-sentinel.txt");
    await setupFixture(dir, { name: "fixed control", metricName: "score" });
    const command = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC score=1')" ${quoteForShell(sentinel)} --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        benchmarkCommand: command,
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: "The no-CodeStory control is fixed for this round.",
          forbiddenCommandPatterns: [`--mode no-codestory --token=${secret}`],
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json`,
        },
      }),
    );

    const blocked = await runCli(["next", "--cwd", dir, "--compact"]);
    assert.equal(blocked.code, 0, blocked.stderr);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.refused, true);
    assert.equal(blockedPayload.code, "fixed_control_rerun_blocked");
    assert.match(blockedPayload.nextAction, /target\/control\/no-codestory\.json/);
    assert.doesNotMatch(blocked.stdout, new RegExp(secret));
    assert.equal(await pathExists(sentinel), false);

    const allowed = await runCli([
      "next",
      "--cwd",
      dir,
      "--compact",
      "--allow-fixed-control-rerun",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await pathExists(sentinel), true);
  });
});

test("doctor check-benchmark refuses fixed-control rerun commands without executing", async () => {
  await withTempDir("fixed-control-doctor", async (dir) => {
    const secret = "sk-fixed-control-doctor-secret-123";
    const sentinel = path.join(dir, "doctor-sentinel.txt");
    const command = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC score=1')" ${quoteForShell(sentinel)} --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        benchmarkCommand: command,
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: "The no-CodeStory control is fixed for this round.",
          forbiddenCommandPatterns: [`--mode no-codestory --token=${secret}`],
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json`,
        },
      }),
    );

    const blocked = await runCli(["doctor", "--cwd", dir, "--check-benchmark", "--json-full"]);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(await pathExists(sentinel), false);
    assert.doesNotMatch(blocked.stdout, new RegExp(secret));
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.benchmark.checked, true);
    assert.equal(payload.benchmark.exitCode, null);
    assert.equal(payload.benchmark.fixedControlViolation.code, "fixed_control_rerun_blocked");
    assert.match(payload.issues.join("\n"), /fixed_control_rerun_blocked/);

    const allowed = await runCli([
      "doctor",
      "--cwd",
      dir,
      "--check-benchmark",
      "--json",
      "--allow-fixed-control-rerun",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await pathExists(sentinel), true);
  });
});

test("benchmark-lint refuses fixed-control explicit commands without override", async () => {
  await withTempDir("fixed-control-benchmark-lint", async (dir) => {
    const secret = "sk-fixed-control-lint-secret-123";
    const sentinel = path.join(dir, "lint-sentinel.txt");
    const command = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC score=1')" ${quoteForShell(sentinel)} --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: "The no-CodeStory control is fixed for this round.",
          forbiddenCommandPatterns: [`--mode no-codestory --token=${secret}`],
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json`,
        },
      }),
    );

    const blocked = await runCli(["benchmark-lint", "--cwd", dir, "--command", command]);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(await pathExists(sentinel), false);
    assert.doesNotMatch(blocked.stdout, new RegExp(secret));
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "fixed_control_rerun_blocked");
    assert.equal(payload.fixedControlViolation.code, "fixed_control_rerun_blocked");
    assert.match(payload.issues.join("\n"), /fixed_control_rerun_blocked/);

    const allowed = await runCli([
      "benchmark-lint",
      "--cwd",
      dir,
      "--command",
      command,
      "--allow-fixed-control-rerun",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await pathExists(sentinel), true);
  });
});

test("benchmark-inspect refuses fixed-control explicit commands without override", async () => {
  await withTempDir("fixed-control-benchmark-inspect", async (dir) => {
    const secret = "sk-fixed-control-inspect-secret-123";
    const sentinel = path.join(dir, "inspect-sentinel.txt");
    const command = `${quoteForShell(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('METRIC score=1')" ${quoteForShell(sentinel)} --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: "The no-CodeStory control is fixed for this round.",
          forbiddenCommandPatterns: [`--mode no-codestory --token=${secret}`],
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json`,
        },
      }),
    );

    const blocked = await runCli(["benchmark-inspect", "--cwd", dir, "--command", command]);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(await pathExists(sentinel), false);
    assert.doesNotMatch(blocked.stdout, new RegExp(secret));
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "fixed_control_rerun_blocked");
    assert.equal(payload.fixedControlViolation.code, "fixed_control_rerun_blocked");
    assert.match(payload.warnings.join("\n"), /fixed_control_rerun_blocked/);

    const allowed = await runCli([
      "benchmark-inspect",
      "--cwd",
      dir,
      "--command",
      command,
      "--allow-fixed-control-rerun",
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await pathExists(sentinel), true);
  });
});

test("state exposes fixed-control config", async () => {
  await withTempDir("fixed-control-state", async (dir) => {
    const secret = "sk-fixed-control-state-secret-123";
    const longReason = "The no-CodeStory control is fixed for this round. " + "r".repeat(500);
    const forbiddenCommandPatterns = Array.from(
      { length: 16 },
      (_, index) => `--mode no-codestory-${index} --token=${secret}`,
    );
    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC score=1')" --mode no-codestory --token=${secret}`;
    await writeFile(
      path.join(dir, "autoresearch.config.json"),
      JSON.stringify({
        name: "fixed control",
        goal: "preserve baseline",
        metricName: "score",
        metricUnit: "points",
        bestDirection: "higher",
        benchmarkCommand: command,
        fixedControl: {
          artifact: "target/control/no-codestory.json",
          reason: longReason,
          validUntilChanged: Array.from({ length: 13 }, (_, index) => `benchmarks/${index}.mjs`),
          forbiddenCommandPatterns,
          reuseCommandHint: `OPENAI_API_KEY=${secret} node bench.mjs --reuse-control target/control/no-codestory.json ${"x".repeat(500)}`,
        },
      }),
    );

    const full = await runCli(["state", "--cwd", dir, "--json-full"]);
    assert.equal(full.code, 0, full.stderr);
    assert.doesNotMatch(full.stdout, new RegExp(secret));

    const compact = await runCli(["state", "--cwd", dir, "--compact", "--json"]);
    assert.equal(compact.code, 0, compact.stderr);
    assert.doesNotMatch(compact.stdout, new RegExp(secret));

    const payload = JSON.parse(full.stdout);
    assert.equal(payload.fixedControl.artifact, "target/control/no-codestory.json");
    assert.equal(payload.fixedControl.reason.length <= 240, true);
    assert.equal(payload.fixedControl.validUntilChanged.length, 10);
    assert.equal(payload.fixedControl.forbiddenCommandPatterns.length, 10);
    assert.equal(payload.fixedControl.reuseCommandHint.length <= 240, true);
    assert.doesNotMatch(payload.fixedControl.reuseCommandHint, new RegExp(secret));
    assert.equal(payload.fixedControl.truncated, true);
    assert.equal(payload.fixedControl.truncation.validUntilChanged, 3);
    assert.equal(payload.fixedControl.truncation.forbiddenCommandPatterns, 6);
    assert.equal(payload.fixedControl.truncation.reasonChars > 0, true);
  });
});

test("next allows explicitly bounded packet work for bounded-next capsules", async () => {
  await withTempDir("next-bounded-decision-capsule", async (dir) => {
    await setupFixture(dir, { name: "bounded capsule" });
    await writeDecisionCapsule(dir, "search-latency", {
      enforcement: {
        mode: "bounded-next",
        canRunNextPacket: false,
        allowBoundedNext: true,
        blocksFinalization: false,
        clearingCondition: "Run a bounded packet that measures search latency.",
        commandHint:
          "node scripts/autoresearch.mjs next --cwd <project> --timeout-seconds <n> --command-file <path>",
        triggeredBy: ["sessionDecisionCapsule"],
      },
      bottleneck: "Initial retrieval/search latency dominates packet wall time.",
      evidence: ["Search latency dominated the long session."],
      nextExperiment: "Run a bounded search-latency packet.",
      wrongNextActions: ["Do not run a broad packet."],
    });

    const defaultTimeoutOnly = await runCli([
      "next",
      "--cwd",
      dir,
      "--timeout-seconds",
      "5",
      "--compact",
    ]);
    assert.equal(defaultTimeoutOnly.code, 0, defaultTimeoutOnly.stderr);
    const blockedPayload = JSON.parse(defaultTimeoutOnly.stdout);
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.refused, undefined);
    assert.match(blockedPayload.doctor.issues.join("\n"), /No benchmark command/i);
    assert.match(blockedPayload.nextAction, /benchmark/i);

    const command = `${quoteForShell(process.execPath)} -e "console.log('METRIC seconds=1')"`;
    const result = await runCli([
      "next",
      "--cwd",
      dir,
      "--command",
      command,
      "--timeout-seconds",
      "5",
      "--compact",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.refused, undefined);
    assert.equal(payload.decision.metric, 1);
  });
});
