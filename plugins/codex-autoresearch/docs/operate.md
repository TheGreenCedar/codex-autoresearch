# Run or resume a session

Autoresearch is designed to survive a closed terminal, a compacted Codex task, or a week away from the project. When you come back, start with one canonical state report. Chat history can explain context, but it is not experiment authority.

## Resume from the current state

These commands are for a source checkout and run from `plugins/codex-autoresearch`. If you installed through Codex, ask `@Codex Autoresearch` to run them for you.

```bash
node scripts/autoresearch.mjs state --cwd <project> --report
```

Read the phase, blocker code, action, loop disposition, parent disposition, contract digest, evaluator identity, and capability states before supporting detail. A normal result may send you to another experiment, direct work, contract clarification, transaction recovery, a segment transition, or finalization. Follow that action before reaching for `next` out of habit. Run doctor only when the decision asks for that diagnostic or you explicitly want one.

State and doctor default to bounded, human-sized JSON. Pass `--json-full` only when a tool or maintainer needs the complete machine diagnostic. `decisionPlanProjection` is the canonical bounded authority. `resolvedDecision`, `loopContract`, `nextAction`, and continuation fields are compatibility outputs from that plan; they never feed it.

Do not reread raw session files and ask state, recommendation, doctor, watchdog, and finalization to vote independently. The coherent loader reads the ledger, config, packet, transaction receipt, process state, and Git identity together and retries if they change during the read.

For a compact handoff to another Codex session, use:

```bash
node scripts/autoresearch.mjs onboarding-packet --cwd <project> --compact
```

If the terminal report, compact state, and dashboard disagree on decision ID, phase, action kind, blocker code, parent disposition, contract digest, or evaluator identity, stop mutation. They are projections of the same decision and should agree even though the dashboard redacts commands.

## Run and log an experiment

Before a benchmark run, check the tree and ask the canonical decision whether another packet is allowed:

```bash
git status --short
node scripts/autoresearch.mjs state --cwd <project> --report
```

Then run one packet:

```bash
node scripts/autoresearch.mjs next --cwd <project>
```

`next` is the command that writes a reusable last-run packet. It may execute only the evaluator and checks in the accepted contract. An override is compatible only when it parses to the exact accepted execution digest; changing evaluator meaning requires an explicit replacement contract. Use `benchmark-inspect` for a bounded diagnostic probe. The old `run` name now fails fast with that migration and is scheduled for removal after 2026-10-01.

After the command finishes, inspect the metric, the checks, the diff, and `git status`. Then record the decision from the saved packet:

```bash
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Reuse the parsed config between test files"
```

The five statuses have deliberately narrow meanings:

| Status          | When it fits                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `measure`       | A baseline, environment check, no-change result, or diagnostic. It never commits or reverts work.                                     |
| `keep`          | An accepted-contract candidate satisfies the metric comparison, all accepted checks, and noise qualification.                        |
| `discard`       | The packet measured successfully, but the change is not worth keeping. Logging may clean the configured or explicit experiment paths. |
| `crash`         | The benchmark failed before it produced usable metric evidence. Logging may clean the configured or explicit experiment paths.        |
| `checks_failed` | A metric exists, but the correctness check failed. Logging may clean the configured or explicit experiment paths.                     |

Pass `--revert-paths` when the cleanup scope should be narrower than configured commit paths. Check `git status --short --branch` before logging any status that may mutate Git.

Use `--from-last` rather than copying a metric out of the terminal. If inline JSON is awkward in the current shell, put metrics or the structured experiment note in a file and pass `--metrics-file` or `--asi-json-file`.

Detailed output stores that structured experiment note in the `asi` field. It should say what Codex expected, what the evidence showed, why a rejected path should stay rejected, and what experiment would be sensible next. Learning defaults to `none`; `causal` or `discriminating` requires evidence and a concrete changed belief.

Every mutation returns a precondition decision, a mutation receipt, and a resulting decision. The resulting plan decides what happens next. A budget stop or no-learning pause can block packets while permitting direct completion; a pending transaction blocks unsafe session mutation and session-dependent final claims.

If `log` is interrupted, rerun the exact same arguments. Its version-2 receipt verifies completed commit and ledger stages, resumes tracked and untracked cleanup independently, and converges to at most one commit and one ledger event. Different arguments reject while the receipt is pending.

## Repair the layer that failed

Do not rerun an expensive benchmark until you know what the previous run failed to answer. The CLI has cheaper commands for that:

- `benchmark-lint` checks whether the primary metric can be parsed.
- `benchmark-inspect` shows what the benchmark command actually does.
- `checks-inspect --cwd <project> --command "<checks>"` isolates the correctness command.
- `partial-results --cwd <project> --from-last` looks for useful artifacts from a timed-out packet.
- `session-forensics --cwd <project> --session-jsonl <path> --research-slug <slug> --dry-run` distills a bounded decision from an older Codex session.
- `research-fanout --dry-run` proposes bounded lanes only when a person explicitly chooses fanout for an accepted loop.

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

Packet count, evaluator invocations, and plugin wall-clock time are enforced experiment limits. Model token and call limits are enforced only when trusted host telemetry exists; estimates stay advisory and never report authoritative remaining or exhaustion. When an enforced budget is exhausted, decide whether to extend it, narrow the work, finalize what is useful, or stop.

Start a new segment with a complete replacement contract when evaluator, checks, metric semantics, protected inputs, scope, or phase changes enough that the old numbers are no longer comparable:

```bash
node scripts/autoresearch.mjs new-segment --cwd <project> --dry-run
node scripts/autoresearch.mjs new-segment --cwd <project> --reason "New benchmark phase" --yes
```

The old history stays in the ledger. Run doctor again before the first packet in the new segment.

## Explicit research sessions and parallel lanes

A qualitative request stays direct unless fit selects an explicit repeated checklist contract. Such a session keeps evidence in `sources.md`, judgment in `synthesis.md`, and accepted work in `quality-gaps.md`. The main commands are:

```bash
node scripts/autoresearch.mjs research-start --cwd <project> --slug <slug> --goal "<goal>" --checks-command "<checks>" --commit-paths "<editable-paths>"
node scripts/autoresearch.mjs quality-gap --cwd <project> --research-slug <slug> --list
node scripts/autoresearch.mjs gap-candidates --cwd <project> --research-slug <slug>
node scripts/autoresearch.mjs gap-decide --cwd <project> --research-slug <slug> --gap-id <id> --decision implemented --evidence <ref> --validation <result>
```

Raw checkbox edits stay provisional. `gap-decide` appends the evidence-bearing acceptance decision for a stable gap ID. Closing the accepted checklist ends that round. Read `researchIntegrity` and its missing-proof warnings before deciding whether the larger question is finished or needs another discovery round.

Two eligible no-learning candidates or two failures in the same registered layer pause packet work unless that failure class's relevant preconditions changed. A pause hands control back to direct work and never starts fanout. If a person later approves fanout, `research-fanout --dry-run` can propose independent scouts. Scout commands run only when their parsed argv matches the strict Git read-only allowlist; Git porcelain is post-run detection, not containment. An implementation lane needs a separate worktree or an explicit write scope, neither of which contains arbitrary process or outside-root effects. The parent session still owns the accepted contract and keep/discard decision.

## Use the dashboard when it helps

```bash
node scripts/autoresearch.mjs serve --cwd <project>
```

The printed loopback URL shows live state. `export` writes a static snapshot that is useful for review but cannot prove the current packet is fresh. Neither form runs experiments or changes the session.

The live readout opens in the focused operate view: read status, blocker, and next action first. Audit exposes the decision identity and evidence trail, not a different decision. The dashboard omits executable commands. During refresh, existing evidence remains visible with its last validated time. A refresh failure leaves that last known good readout in place. Static exports provide file-sharing guidance instead of presenting a local `file://` path as a shareable URL.

Once accepted work is starting to pile up, stop adding packets and move to [Finish](finish.md).
