# From baseline to a reviewable change

This example improves `src/parser.mjs` while keeping `bench/parser.mjs` and the independent assertions in `tests/parser.test.mjs` protected. Follow [Start](start.md#start-from-the-cli) to create the scaffold, identify check authority, review the derived contract, and accept it with `new-segment --yes`. Continue from the plugin package with the same `project` variable. Do not repeat setup over an existing session.

The numbers below are illustrative. They are not measurements of this repository.

## Establish the reference

Start's two unchanged baseline packets produce, for example, `seconds=14.20` and `seconds=14.24`, with the accepted checks passing both times. Both are logged as `measure`. They consume two packets and establish the reference sample cohort used to judge candidate variation.

If you have not run those packets yet:

```bash
node scripts/autoresearch.mjs state --cwd "$project" --report
node scripts/autoresearch.mjs next --cwd "$project"
node scripts/autoresearch.mjs log --cwd "$project" --from-last --status measure --description "Parser baseline 1"
node scripts/autoresearch.mjs state --cwd "$project" --report
node scripts/autoresearch.mjs next --cwd "$project"
node scripts/autoresearch.mjs log --cwd "$project" --from-last --status measure --description "Parser baseline 2"
node scripts/autoresearch.mjs state --cwd "$project" --report
```

Inspect each packet and its checks, and follow the returned action before the next command. A failed or blocked result is a reason to stop this sequence and resolve the reported condition.

## Try one idea twice

Suppose profiling identifies repeated construction of an unchanged lookup table inside the parser's hot path. Change only `src/parser.mjs` to reuse that table. Keep the input workload, benchmark, and correctness assertions unchanged.

Measure the candidate once and record qualification evidence without committing it:

```bash
git -C "$project" status --short
node scripts/autoresearch.mjs state --cwd "$project" --report
node scripts/autoresearch.mjs next --cwd "$project"
node scripts/autoresearch.mjs log --cwd "$project" --from-last --status measure --description "Parser candidate qualification 1"
node scripts/autoresearch.mjs state --cwd "$project" --report
```

Assume this packet reports `seconds=10.80` and passing checks. Leave the candidate source unchanged so the next packet measures the same candidate:

```bash
node scripts/autoresearch.mjs next --cwd "$project"
node scripts/autoresearch.mjs state --cwd "$project" --report
git -C "$project" diff -- src/parser.mjs
git -C "$project" status --short --branch
```

Suppose the repeat reports `seconds=10.84` and passing checks. Two candidate samples and two reference samples now exist. The accepted contract decides whether their spread and improvement qualify; two repeats alone do not guarantee a keep. If the saved packet permits `keep` and the diff contains only the intended parser change, record it:

```bash
node scripts/autoresearch.mjs log --cwd "$project" --from-last --status keep --description "Reuse the parser lookup table without changing parsed output"
node scripts/autoresearch.mjs state --cwd "$project" --report
```

The scoped keep can commit `src/parser.mjs`. Four packets have been consumed: two baselines and two candidate evaluations. The first candidate's `measure` did not authorize a keep; its evidence supplies a repeat for the unchanged candidate. There is no reason to spend the fifth packet merely because budget remains.

## Hand off the change

Follow the canonical state action. When it permits finalization, request the complete preview to include the evidence receipt:

```bash
git -C "$project" status --short --branch
node scripts/autoresearch.mjs finalize-preview --cwd "$project" --json-full
```

The preview is read-only. Its `evidenceReceipt` identifies current accepted commits, files, measurements, contract/check identities where proven, and limitations. Check the preview's blockers and exclusions before handoff. Use the existing branch when it already contains only the intended review unit; mixed experiment history may need the branch separation described in [Finish](finish.md).

For the illustrative values above, the supported claim is that the specified parser workload ran in 10.80–10.84 seconds versus 14.20–14.24 seconds, while the accepted parser assertions passed. That does not establish performance on other workloads or product readiness.
