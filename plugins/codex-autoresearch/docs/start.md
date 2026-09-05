# Start with fit, then a baseline

A good Autoresearch session begins only after the request fits repeated measurement. Ask Codex to run the read-only `prompt-plan` fit check before it scans the repository or proposes setup. Architecture, documentation, UX, product study, open research, taste, and one-shot fixes normally continue directly with no Autoresearch state.

An accepted session then begins with a result you can reproduce before any code changes. You need a goal, repository and checkout identity, typed metric semantics, an evaluator, independent correctness checks, editable and protected scope, a noise model, keep and stop rules, and real budgets. An explicit loop request that lacks those essentials returns `needs-user`. Codex can first inspect up to five relevant project files to propose missing commands and paths, with their sources. Nothing discovered is accepted automatically; review the complete contract before setup or execution.

The benchmark must print the primary metric in this form:

```text
METRIC seconds=12.34
```

It may print other metrics too. If runtime is the primary metric, memory or coverage can still be recorded as guardrails, but they do not replace the number the loop is trying to improve.

## Start from Codex

Use this as a starting contract, replacing the commands and scope with those in your project:

```text
/goal @Codex Autoresearch run a measured loop to reduce parser runtime.
Benchmark: node bench/parser.mjs
Metric: seconds (s), lower is better
Checks: node --test tests/parser.test.mjs
Scope: src/parser.mjs
Protect bench/parser.mjs and tests/parser.test.mjs.
Measure two baselines and repeat each candidate before a keep.
Stop after 5 packets or 30 minutes; repeat measurements count toward that limit.
Propose the complete contract for approval before setup or execution.
```

If the benchmark is not obvious, Codex can propose one from bounded read-only discovery after `prompt-plan` identifies an explicit loop request. It should explain which workload the command measures, what the checks protect, and which files would change. `prompt-plan` writes no session files; `setup-plan` can help present the candidate. Read and approve the complete contract before setup. A command that is easy to measure but unrelated to the actual goal is worse than no benchmark at all.

## Start from the CLI

Run these commands from the plugin's source package, `plugins/codex-autoresearch`. Marketplace users can ask Codex to perform the same steps. The target project in this example already has `src/parser.mjs`, a benchmark at `bench/parser.mjs` that prints `METRIC seconds=<number>`, and independent behavior assertions in `tests/parser.test.mjs`. Review those files first. Only the parser source is editable; the benchmark and check implementation stay protected. Replace these paths with the corresponding files in your project.

Use an existing clean experiment branch, preserving unrelated changes. Setup writes the session scaffold and configuration; it does not append the accepted contract event.

```bash
project=/absolute/path/to/project
git -C "$project" status --short --branch
node scripts/autoresearch.mjs setup --cwd "$project" --name "Parser runtime" --goal "Reduce parser runtime without changing parsed output" --metric-name seconds --metric-unit s --direction lower --benchmark-command "node bench/parser.mjs" --checks-command "node --test tests/parser.test.mjs" --scope "src/parser.mjs" --commit-paths "src/parser.mjs" --protected-benchmark-paths "bench/parser.mjs,tests/parser.test.mjs" --max-iterations 5 --packet-budget 5 --wall-clock-budget-seconds 1800
```

After reviewing the independent assertions, identify their implementation in the generated configuration. These fields have no dedicated CLI options:

```bash
node --input-type=module - "$project/autoresearch.config.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const configPath = process.argv[2];
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.checksAuthoritative = true;
config.checkImplementationPaths = ["tests/parser.test.mjs"];
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
NODE
node scripts/autoresearch.mjs new-segment --cwd "$project" --reason "Accept parser runtime contract" --dry-run
```

Review the derived contract: commands, protected inputs, editable scope, check authority, metric, noise policy, and budgets. After accepting it, append the acceptance event and read the resulting action:

```bash
node scripts/autoresearch.mjs new-segment --cwd "$project" --reason "Accept parser runtime contract" --yes
node scripts/autoresearch.mjs state --cwd "$project" --report
```

Run a packet only when the state report permits it. The default unknown-noise policy requires at least two reference measurements and two measurements of an unchanged candidate before a noisy improvement can qualify. Record both initial packets as measurements:

```bash
node scripts/autoresearch.mjs next --cwd "$project"
node scripts/autoresearch.mjs log --cwd "$project" --from-last --status measure --description "Parser baseline 1"
node scripts/autoresearch.mjs state --cwd "$project" --report
node scripts/autoresearch.mjs next --cwd "$project"
node scripts/autoresearch.mjs log --cwd "$project" --from-last --status measure --description "Parser baseline 2"
node scripts/autoresearch.mjs state --cwd "$project" --report
```

Inspect each result and follow its returned decision before continuing. These two packets consume two of the five allowed packets. `measure` records evidence without committing or reverting source. [Walkthrough](walkthrough.md) continues with two candidate packets, leaving one packet unused.

Keep cleanup within the experiment paths. For `discard`, `crash`, or `checks_failed`, use explicit `--revert-paths` when cleanup should be narrower than the configured commit paths. Changes to protected benchmark or check inputs require a replacement contract before more comparable measurements.

Setup creates local session files and Git-private packet state. [Concepts](concepts.md#session-files) lists them.
