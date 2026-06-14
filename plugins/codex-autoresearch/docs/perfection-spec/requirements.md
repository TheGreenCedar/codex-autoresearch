# Requirements Document

## Introduction

This document defines the acceptance criteria for the Codex Autoresearch perfection branch. The intent is not decorative cleanup. Each requirement maps to audited failure modes and must be covered by implementation tasks in `tasks.md`.

## Glossary

- **Literal pathspec**: A path passed to Git so Git treats it as a literal file path, not as pathspec magic or a glob.
- **Durable ledger**: `autoresearch.jsonl`, the authoritative record of session setup and run decisions.
- **Secondary note**: `autoresearch.md`, the human-readable companion ledger.
- **Read model**: The derived state used by compact state, full state, recommend-next, dashboard, and operator handoff.
- **Public export**: A static dashboard artifact intended for checked-in demos, docs, or sharing outside the local workstation.

## Requirements

### Requirement 1: Literal Mutation Path Safety

#### Acceptance Criteria

1.1 WHEN a user, config file, tool call, or finalizer plan provides a path list, THE **PathSafetyKernel** SHALL reject or literalize Git pathspec magic before any Git mutation command receives the path.

1.2 WHEN keep logging runs with `commitPaths`, THE **PathSafetyKernel** SHALL ensure `git add` cannot expand the scope beyond the listed literal paths.

1.3 WHEN discard cleanup runs with `revertPaths`, THE **PathSafetyKernel** SHALL ensure `git restore` and `git clean` cannot expand the scope beyond the listed literal paths.

1.4 WHEN finalizer branch creation applies a plan file, THE **PathSafetyKernel** SHALL ensure finalizer `files` and `source_groups.files` cannot trigger Git pathspec magic.

1.5 WHEN finalizer cleanup needs to remove an absent path from the working tree, THE **PathSafetyKernel** SHALL verify realpath containment of the nearest existing parent before recursive filesystem removal.

1.6 WHEN path safety regressions are tested, THE **VerificationGate** SHALL include cases for `:(top)`, glob magic, literal filenames beginning with special characters where supported, symlink/junction parents, and `.git` rejection.

### Requirement 2: Redacted Command and Export Output

#### Acceptance Criteria

2.1 WHEN `run` returns JSON, THE **OutputRedactionBoundary** SHALL redact benchmark and checks tail output before stdout printing.

2.2 WHEN `next` returns a non-compact packet, THE **OutputRedactionBoundary** SHALL redact all benchmark/check output fields before stdout printing.

2.3 WHEN command output is stored in `autoresearch.last-run.json`, packet evidence, or dashboard model data, THE **OutputRedactionBoundary** SHALL preserve existing redaction and avoid double-redaction artifacts that hide useful nonsecret diagnostics.

2.4 WHEN a public or showcase dashboard export embeds ledger data, THE **OutputRedactionBoundary** SHALL apply public-export path scrubbing to every embedded data surface, not only the view model.

2.5 WHEN redaction is tested, THE **VerificationGate** SHALL include API key, bearer token, Windows absolute path, UNC path, POSIX absolute path, and env-file path fixtures.

### Requirement 3: Transactional Log Semantics

#### Acceptance Criteria

3.1 WHEN `log` appends a run to the durable ledger successfully, THE **TransactionalLogWriter** SHALL not return a failed command solely because the secondary note update failed.

3.2 WHEN `log --from-last` clears a last-run packet after durable persistence, THE **TransactionalLogWriter** SHALL report that cleanup truthfully even if a secondary note warning exists.

3.3 WHEN `appendSessionRunNote` fails, THE **TransactionalLogWriter** SHALL return a warning with a recovery action and enough detail to repair `autoresearch.md`.

3.4 WHEN pending log receipt cleanup fails, THE **TransactionalLogWriter** SHALL preserve the existing warning behavior and not mask the persisted run decision.

3.5 WHEN transactional logging is tested, THE **VerificationGate** SHALL simulate unwritable `autoresearch.md`, pending receipt cleanup failure, and `--from-last` cleanup.

### Requirement 4: Single Authoritative Read Model

#### Acceptance Criteria

4.1 WHEN `state`, `state --compact`, `recommend-next`, `recommend-next --compact`, `serve`, or `export` need control-plane facts, THE **SessionReadModel** SHALL compute those facts through one shared builder.

4.2 WHEN compact output is requested, THE **SessionReadModel** SHALL project from the shared model instead of recomputing or dropping decision inputs such as workflow friction.

4.3 WHEN dashboard and terminal reports describe blockers, canonical next action, finalization pressure, runtime provenance, source cleanliness, or operator handoff, THE **SessionReadModel** SHALL keep them semantically consistent.

4.4 WHEN finalization pressure is needed for ordinary readout, THE **SessionReadModel** SHALL use a cheap pressure summary and defer expensive Git branch/file walking to explicit finalization commands or full reports.

4.5 WHEN read-model changes are tested, THE **VerificationGate** SHALL compare compact state, full state, recommend-next compact, and dashboard view-model output for the same session.

### Requirement 5: Long-Session Performance

#### Acceptance Criteria

5.1 WHEN experiment memory is built for large ledgers, THE **LongSessionEngine** SHALL avoid superlinear array copying and keep family aggregation near linear in run count.

5.2 WHEN one CLI invocation needs session records multiple times, THE **LongSessionEngine** SHALL reuse parsed JSONL records and derived filters instead of rereading the same ledger.

5.3 WHEN live dashboard freshness is checked, THE **LongSessionEngine** SHALL avoid unbounded recursive fingerprinting of `autoresearch.research` on every short TTL cycle.

5.4 WHEN static dashboard export or chart data includes many runs, THE **LongSessionEngine** SHALL cap, downsample, paginate, or externalize full-detail data so exports and browser rendering remain bounded.

5.5 WHEN `npm run check` executes, THE **VerificationGate** SHALL pass the warm startup budget for compact read commands with a documented margin.

5.6 WHEN performance fixes are tested, THE **VerificationGate** SHALL include synthetic long-session fixtures for 1k, 10k, and 50k run shapes or a cheaper deterministic equivalent.

### Requirement 6: Dashboard Browser and Public Export Safety

#### Acceptance Criteria

6.1 WHEN the live dashboard receives an HTTP request, THE **DashboardPrivacyServer** SHALL reject Host headers outside the supported loopback host list for the active port.

6.2 WHEN the live dashboard serves HTML or JSON, THE **DashboardPrivacyServer** SHALL include defensive headers such as `X-Content-Type-Options: nosniff`, an appropriate CSP for HTML, and a same-origin resource policy where compatible.

6.3 WHEN `/autoresearch.jsonl` is requested without debug-ledger mode, THE **DashboardPrivacyServer** SHALL continue returning a non-success response.

6.4 WHEN debug-ledger mode is enabled, THE **DashboardPrivacyServer** SHALL keep line-by-line redaction before serving ledger data.

6.5 WHEN public export safety is tested, THE **VerificationGate** SHALL assert that showcase HTML contains no local absolute paths, UNC paths, command fields, or raw secret fixtures.

### Requirement 7: Bounded Artifact Ingestion

#### Acceptance Criteria

7.1 WHEN `partial-results` reads a benchmark artifact, THE **ArtifactIngestionGuard** SHALL stat the artifact before reading and reject or truncate artifacts above a configured byte cap.

7.2 WHEN `partial-results` parses rows, THE **ArtifactIngestionGuard** SHALL process no more than a configured row cap.

7.3 WHEN an artifact is too large, truncated, invalid, missing, or outside containment, THE **ArtifactIngestionGuard** SHALL return an explicit skipped-artifact notice.

7.4 WHEN artifact containment is checked, THE **ArtifactIngestionGuard** SHALL preserve the current lexical and realpath workdir containment behavior.

7.5 WHEN artifact ingestion is tested, THE **VerificationGate** SHALL cover oversized JSON, excessive rows, malformed JSON, symlink/junction escape, absolute outside path, and normal bounded salvage.

### Requirement 8: Architecture Ownership Reduction

#### Acceptance Criteria

8.1 WHEN command modules receive dependencies, THE **SessionReadModel** and command handler layer SHALL use typed dependency interfaces instead of broad `Record<string, any>` bags for migrated slices.

8.2 WHEN `run`, `next`, and `log` behavior is modified, THE **TransactionalLogWriter**, **OutputRedactionBoundary**, and **SessionReadModel** SHALL be extracted or isolated enough that the main CLI script no longer owns the whole behavior.

8.3 WHEN `session-core` changes, THE **SessionReadModel** SHALL separate durable ledger parsing from derived evidence, governance, product-claim, and operator-readout policy.

8.4 WHEN architectural migration is incomplete, THE **DocsTruthSurface** SHALL label remaining monolith boundaries and avoid claiming the split is done.

8.5 WHEN architecture work is verified, THE **VerificationGate** SHALL include typecheck, command-surface checks, and focused tests for migrated command slices.

### Requirement 9: Release and Supply-Chain Trust

#### Acceptance Criteria

9.1 WHEN privileged release or auto-release workflows use third-party actions, THE **ReleaseTrustPipeline** SHALL pin them to full-length commit SHAs or enforce an approved equivalent policy.

9.2 WHEN release artifacts are produced, THE **ReleaseTrustPipeline** SHALL preserve checksum verification and add an independently verifiable provenance or attestation path for executable runtime artifacts.

9.3 WHEN package smoke runs in release workflows, THE **ReleaseTrustPipeline** SHALL smoke both `scripts/autoresearch.mjs --help` and `scripts/finalize-autoresearch.mjs --help` from the extracted package.

9.4 WHEN workflows can run for a long time or race on release state, THE **ReleaseTrustPipeline** SHALL set reasonable timeouts and concurrency controls.

9.5 WHEN release trust is tested, THE **VerificationGate** SHALL verify package contents, source-dist ignored/untracked status, action pinning policy, release smoke commands, and provenance documentation.

### Requirement 10: Documentation and Metadata Truth

#### Acceptance Criteria

10.1 WHEN the README describes uninstall behavior, THE **DocsTruthSurface** SHALL distinguish marketplace-source removal from installed-plugin removal.

10.2 WHEN package or plugin metadata describes Autoresearch, THE **DocsTruthSurface** SHALL use guarded language that matches the CLI/skill-only, dashboard-readout, approval-gated finalization contract.

10.3 WHEN the README front door describes logging, THE **DocsTruthSurface** SHALL mention every packet decision class or use a decision-neutral phrase.

10.4 WHEN behavior, docs, metadata, or release trust changes are made, THE **DocsTruthSurface** SHALL update the nearest durable docs surface and root `CHANGELOG.md`.

10.5 WHEN docs truth is tested, THE **VerificationGate** SHALL run `git diff --check`, relevant help/metadata checks, and any source-hygiene rule added to prevent repeat drift.

### Requirement 11: Final Verification and Branch Readiness

#### Acceptance Criteria

11.1 WHEN the branch is considered ready, THE **VerificationGate** SHALL pass `npm run check` from `plugins/codex-autoresearch`.

11.2 WHEN security fixes are considered ready, THE **VerificationGate** SHALL rerun targeted repros for pathspec magic, raw output redaction, Host-header rejection, showcase scrub, and oversized partial-results artifacts.

11.3 WHEN packaging fixes are considered ready, THE **VerificationGate** SHALL run `npm audit --json`, `npm pack --dry-run --json`, extracted launcher smoke, and package content inspection.

11.4 WHEN dashboard-visible behavior changes, THE **VerificationGate** SHALL build/export or serve the dashboard and inspect the actual generated surface.

11.5 WHEN the implementation branch is finalized, THE **VerificationGate** SHALL report remaining risks, skipped checks, runtime/package provenance, and any migration boundaries left intentionally incomplete.

