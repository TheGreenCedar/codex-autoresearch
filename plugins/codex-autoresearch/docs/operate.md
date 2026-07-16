# Run or resume a session

Autoresearch is designed to survive a closed terminal, a compacted Codex task, or a week away from the project. When you come back, start from the files and the current repository state. Chat history can explain context, but the ledger is the record.

## Resume from the current state

These commands are for a source checkout and run from `plugins/codex-autoresearch`. If you installed through Codex, ask `@Codex Autoresearch` to run them for you.

```bash
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact --operator-checklist
node scripts/autoresearch.mjs doctor --cwd <project> --explain
```

Read the blocker and next command before the supporting detail. A normal result may send you to another experiment, but it may also ask you to repair a stale packet, separate dirty files, refresh the runtime, start a new segment, or preview finalization. Follow that action before reaching for `next` out of habit.

State and doctor default to bounded, human-sized JSON. Pass `--json-full` only when a tool or maintainer needs the complete machine diagnostic. Bounded readouts expose the shared decision under `resolvedDecision`; older `decisionEnvelope` and `resumeAudit` fields are accepted as migration inputs but are not repeated as decision aliases.

The main session files are `autoresearch.md`, `autoresearch.jsonl`, and `autoresearch.ideas.md`. Research sessions also have an active folder under `autoresearch.research/<slug>/`. Read them before changing the project.

For a compact handoff to another Codex session, use:

```bash
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
```

If the terminal report, compact state, and dashboard name different next actions, stop. They are projections of the same session and should agree.

## Run and log an experiment

Before a benchmark run, check the tree and ask the session whether another packet is allowed:

```bash
git status --short
node scripts/autoresearch.mjs recommend-next --cwd <project> --compact --operator-checklist
```

Then run one packet:

```bash
node scripts/autoresearch.mjs next --cwd <project>
```

`next` is the command that writes a reusable last-run packet. Use `benchmark-inspect` for a bounded diagnostic probe. The old `run` name now fails fast with that migration and is scheduled for removal after 2026-10-01.

After the command finishes, inspect the metric, the checks, the diff, and `git status`. Then record the decision from the saved packet:

```bash
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Reuse the parsed config between test files"
```

The five statuses have deliberately narrow meanings:

| Status          | When it fits                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `measure`       | A baseline, environment check, no-change result, or diagnostic. It never commits or reverts work.                                     |
| `keep`          | The metric is finite, required checks passed, and the scoped change is worth preserving.                                              |
| `discard`       | The packet measured successfully, but the change is not worth keeping. Logging may clean the configured or explicit experiment paths. |
| `crash`         | The benchmark failed before it produced usable metric evidence. Logging may clean the configured or explicit experiment paths.        |
| `checks_failed` | A metric exists, but the correctness check failed. Logging may clean the configured or explicit experiment paths.                     |

Pass `--revert-paths` when the cleanup scope should be narrower than configured commit paths. Check `git status --short --branch` before logging any status that may mutate Git.

Use `--from-last` rather than copying a metric out of the terminal. If inline JSON is awkward in the current shell, put metrics or the structured experiment note in a file and pass `--metrics-file` or `--asi-json-file`.

Detailed output stores that structured experiment note in the `asi` field. It should say what Codex expected, what the evidence showed, why a rejected path should stay rejected, and what experiment would be sensible next. A useful note prevents the next session from rediscovering the same dead end.

Every log returns a continuation. If `continuation.shouldContinue` is true, the session is still active and another loop action is expected; it does not authorize another packet. Read `loopContract.canRunNextPacket` (also exposed as `canRunNextPacket` in compact state) before running one. If `continuation.forbidFinalAnswer` is true, Codex should not report the goal as finished. A repair, budget stop, segment change, or finalization action takes priority over another experiment.

## Repair the layer that failed

Do not rerun an expensive benchmark until you know what the previous run failed to answer. The CLI has cheaper commands for that:

- `benchmark-lint` checks whether the primary metric can be parsed.
- `benchmark-inspect` shows what the benchmark command actually does.
- `checks-inspect --cwd <project> --command "<checks>"` isolates the correctness command.
- `partial-results --cwd <project> --from-last` looks for useful artifacts from a timed-out packet.
- `session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> --dry-run` distills a bounded decision from an older Codex session.
- `research-fanout --dry-run` helps when the serial idea path has gone stale.

Partial results remain diagnostic measurements; they do not become promotion evidence simply because they were expensive to obtain.

If run numbers are duplicated, segments look wrong, or the ledger was edited by hand, inspect it before doing anything else:

```bash
node scripts/autoresearch.mjs ledger-doctor --cwd <project> --json
```

The guarded repair writes a backup first:

```bash
node scripts/autoresearch.mjs ledger-doctor --cwd <project> --repair --yes
```

Review the health summary before repair and verify the returned `backupPath` afterward.

## Budgets and segments

Packet and wall-clock budgets keep a session from quietly expanding into the rest of the week:

```bash
node scripts/autoresearch.mjs config --cwd <project> --packet-budget 5 --wall-clock-budget-seconds 1800 --budget-note "Stop after one focused pass"
```

These are experiment and elapsed-time limits, not billing meters. When a budget is exhausted, decide whether to extend it, narrow the work, finalize what is useful, or stop.

Start a new segment when the benchmark, metric, direction, protected paths, or phase of work changes enough that the old numbers are no longer directly comparable:

```bash
node scripts/autoresearch.mjs new-segment --cwd <project> --dry-run
node scripts/autoresearch.mjs new-segment --cwd <project> --reason "New benchmark phase" --yes
```

The old history stays in the ledger. Run doctor again before the first packet in the new segment.

## Research sessions and parallel lanes

A qualitative session keeps evidence in `sources.md`, judgment in `synthesis.md`, and accepted work in `quality-gaps.md`. The main commands are:

```bash
node scripts/autoresearch.mjs research-start --cwd <project> --slug <slug> --goal "<goal>"
node scripts/autoresearch.mjs quality-gap --cwd <project> --research-slug <slug> --list
node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug>
node scripts/autoresearch.mjs gap-decide --cwd <project> --research-slug <slug> --gap-id <id> --decision implemented --evidence <ref> --validation <result>
```

Raw checkbox edits stay provisional. `gap-decide` appends the evidence-bearing acceptance decision for a stable gap ID. Closing the accepted checklist ends that round. Read `researchIntegrity` and its missing-proof warnings before deciding whether the larger question is finished or needs another discovery round.

When one line of experiments keeps circling the same idea, `research-fanout --dry-run` can propose independent scouts. Scout commands run only when their parsed argv matches the strict Git read-only allowlist; Git porcelain is post-run detection, not containment. An implementation lane needs a separate worktree or an explicit write scope, neither of which contains arbitrary process or outside-root effects. A large architectural idea remains advice until a person approves a bounded implementation attempt. The parent session still owns the benchmark and the keep/discard decision.

## Use the dashboard when it helps

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

The printed loopback URL shows live state. `export` writes a static snapshot that is useful for review but cannot prove the current packet is fresh. Neither form runs experiments or changes the session.

The live readout opens in the focused operate view: read status, blocker, next action, and safe command first. Switch to audit only when you need the deeper evidence trail; both views project the same decision. During refresh, the existing evidence remains visible with its last validated time. A refresh failure leaves that last known good readout in place. Static exports provide file-sharing guidance instead of presenting a local `file://` path as a shareable URL.

Once accepted work is starting to pile up, stop adding packets and move to [Finish](finish.md).
