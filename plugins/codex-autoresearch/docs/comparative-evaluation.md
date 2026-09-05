# Comparative evaluation protocol

The 3.0 candidate has no demonstrated advantage over ordinary Codex or released 2.9.0. Engineering checks and the public synthetic GitHub fixture establish implementation behavior. Comparative benefit and stable release require a separately funded study.

The comparison tool prepares a fixed, randomized schedule and collects signed host receipts and blinded assessments. It does not start models. The accepted host runs the trials and must enforce the same total allowance for each task in each comparison group, called an arm. The collector pairs each task's results across arms for the independently preregistered analysis. It does not decide whether the candidate is better; its own conclusion stays inconclusive.

## Stages and ownership

1. Independently author and seal uncertain, simple benchmark, and infeasible tasks. Record the author, input digest, and sealing time before trial preparation. Task authorship must be separate from run custody.
2. Accept a separate non-scoring pilot budget: fixed tasks, seeds, maximum runs, total time and spend, and the identical aggregate allowance per task and arm. The pilot establishes harness reliability, cost, and variance. It produces no benefit score.
3. Choose and preregister the scoring design, analysis artifact digest, sample size, budget ceiling, and simple-task noninferiority margin. Power and variance estimates inform this decision; they do not authorize additional runs.
4. Execute the sealed schedule on the accepted host. Keep the arm mapping private from assessors and present outputs under the generated opaque trial IDs.
5. Collect signed usage and outcome receipts, then apply the pinned analysis to paired task-level results. A task is the independent sampling unit; repeated seeds are averaged within its arm. Report infeasible-task handling separately. Unresolved uncertainty remains inconclusive.

To pass, the candidate must produce more verified outcomes on uncertain tasks, avoid increasing cost per verified success, require less work from the operator, and meet the preregistered noninferiority margin on simple benchmarks. Test all four requirements against both ordinary Codex and released 2.9.0. Report intervals and failures, including total cost when no output succeeds. With zero successes, cost per success has no finite value. Passing only some requirements does not pass the comparative release gate.

## Harness

From the package checkout, `npm run comparison` reports that the harness is disabled. It creates no study and starts no models.

With a separately accepted protocol:

```bash
npm run comparison -- --enable --protocol-file /private/study/protocol.json --prepare --output-dir /private/study/new-run
npm run comparison -- --enable --protocol-file /private/study/protocol.json --collect --schedule-file /private/study/new-run/schedule.private.json --receipts-file /private/study/receipts.json
```

Scoring collection additionally takes `--assessments-file`. Pilot collection rejects assessments. Preparation requires a new output directory; it does not overwrite or silently expand an existing schedule. Missing executions remain incomplete. Reconcile the original host job and receipt; do not substitute a rerun under the same trial identity.

The installed package also includes `dist/scripts/comparison-harness.mjs`. Use the package's own Node runtime and entrypoint when inspecting an extracted candidate.

## Protocol fields

The protocol has `schemaVersion: 1`, an ID, stage (`pilot` or `scoring`), one model identity, and one environment SHA-256 digest. It specifies:

- `authorization`: the separate budget decision reference, `maxRuns`, `maxTotalSeconds`, and `maxTotalCostUsd`.
- `aggregatePerTaskArm`: `seconds`, `tokens`, and `costUsd` shared across all seeds, preparation, failures, reviews, interventions, recovery, and handoff for that task/arm.
- `tasks`: unique IDs, kind (`uncertain`, `simple`, or `infeasible`), independent author reference, input digest, and sealing time.
- `seeds`: the fixed seed identities.
- `arms`: exactly `ordinary-codex`, `released-2.9.0`, and `candidate-3.0`, each with a version and SHA-256 runtime fingerprint. Pin actual released 2.9.0 and the exact 3.0 prerelease artifact; a branch name is insufficient.
- `hostAuthority`: the accepted host reference, Ed25519 public key in PEM format, and reference to its actual aggregate-budget enforcement.
- `assessmentAuthority`: a distinct blinded assessor reference and Ed25519 public key.
- `preregistration` for scoring: a registry reference, SHA-256 analysis artifact digest, and simple-task noninferiority margin between zero and one.

The host must verify and attest the actual runtime, model, environment, input, and budget enforcement configuration. A signature identifies who made the statement. Host isolation, assessor blindness, and scientific independence still need separate checks before the pilot. A local declaration cannot enforce a provider spending cap.

## Receipt protocol

Both receipt types are JSON envelopes with `payload` and a base64 Ed25519 `signature`. Sign the UTF-8 hexadecimal SHA-256 returned by the package's canonical `hashOutcomeValue(payload)`.

A host payload binds `trialId`, `protocolDigest`, `model`, `environmentDigest`, `inputDigest`, `runtimeDigest`, `seed`, `enforcementReference`, and the delivered `artifactDigest`. Its `phases` object must contain all seven keys: `preparation`, `execution`, `failed-attempts`, `review`, `operator-intervention`, `recovery`, and `handoff`. Each records finite nonnegative `seconds`, `tokens`, and `costUsd`. A phase may be zero only when host telemetry establishes no consumption. Missing or unknown consumption is incomplete, not zero.

An assessor payload binds `trialId`, `protocolDigest`, and `artifactDigest`, with boolean `verifiedOutcome` and `infeasibleHandled` judgments. It must not contain the arm, runtime identity, or model. The assessment authority separately retains the factual evidence for each judgment. Infeasible tasks are not ordinary delivery failures: score the correctness of the infeasibility conclusion and handoff independently.

The collector rejects mismatched actual conditions, missing accounting phases, duplicate receipts, substituted outputs, incomplete schedules, exposed arm fields, and aggregate overages. Its output retains the fixed protocol identity and paired task results. Funding the scoring study, applying the preregistered analysis, and deciding stable release remain explicit later decisions.
