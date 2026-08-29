# From baseline to finalization preview

This walkthrough picks up where [Start](start.md) leaves off: the contract is understood, the source checkout is open at `plugins/codex-autoresearch`, and a test suite takes about fourteen seconds. The goal is not simply to make the number smaller; the tests still have to exercise the same behavior, and the change should stay inside the test configuration and helpers.

If you installed through Codex instead of cloning the source, ask `@Codex Autoresearch` to run these steps for you.

## Set up the session

From `plugins/codex-autoresearch`, create the session and configure the paths a kept result may commit:

```bash
git -C <project> status --short --branch
node scripts/autoresearch.mjs setup --cwd <project> --name "Test runtime" --metric-name seconds --direction lower --benchmark-command "npm test -- --runInBand" --benchmark-prints-metric false --checks-command "npm test" --packet-budget 5 --wall-clock-budget-seconds 1800
node scripts/autoresearch.mjs config --cwd <project> --commit-paths "vitest.config.ts,tests/helpers/"
node scripts/autoresearch.mjs doctor --cwd <project> --check-benchmark --explain
node scripts/autoresearch.mjs state --cwd <project> --report
```

The status check keeps unrelated changes visible before setup writes session files. Doctor should confirm that the accepted evaluator can produce `METRIC seconds=<number>` from the timed raw command. The state report is the authority for whether the first packet may run.

Now record the baseline:

```bash
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs log --cwd <project> --from-last --status measure --description "Baseline before test-runner changes"
node scripts/autoresearch.mjs state --cwd <project> --report
```

Assume the result is `seconds=14.2`. It is logged as `measure`, not `keep`, because no change has been made.

## Try one idea

Codex finds that an unchanged helper fixture is rebuilt for every test file. It changes `tests/helpers/cache.ts`, then measures again:

```bash
git status --short
node scripts/autoresearch.mjs next --cwd <project>
node scripts/autoresearch.mjs state --cwd <project> --compact
```

This time the benchmark reports `seconds=10.8` and the checks pass. Before keeping it, inspect the diff and make sure `git status` contains only the files owned by this experiment. Then log the result from the saved packet:

```bash
node scripts/autoresearch.mjs log --cwd <project> --from-last --status keep --description "Reuse the unchanged helper fixture across test files"
```

Because `commitPaths` is configured, Autoresearch can commit only the permitted paths. If unrelated work has appeared in the tree, separate it before logging.

## Decide whether to continue

The log result includes the precondition and resulting decisions. The resulting `DecisionPlan` says whether packet work, direct handback, repair, transition, or finalization comes next. Compatibility continuation fields do not separately authorize a packet.

Before spending another packet, read the canonical state:

```bash
node scripts/autoresearch.mjs state --cwd <project> --report
```

Another run may be useful if the accepted contract needs a cold-process repeat or there is a different low-risk hypothesis to test. A stale packet, exhausted budget, no-learning pause, evaluator drift, or failed check should send the session to its named action instead.

## Preview the review work

Once the useful experiments are done, preview finalization:

```bash
git status --short
node scripts/autoresearch.mjs state --cwd <project> --report
node scripts/autoresearch.mjs finalize-preview --cwd <project>
```

The preview does not create or switch branches. It shows which accepted results are still current, what files they cover, and what would block branch creation.

The strongest honest claim in this example may be only that the local test benchmark fell from 14.2 seconds to 10.8 while `npm test` still passed. Broader claims need broader evidence. [Finish](finish.md) explains how that evidence becomes reviewable work.
