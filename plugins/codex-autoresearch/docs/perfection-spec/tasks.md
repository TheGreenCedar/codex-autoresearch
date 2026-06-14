# Implementation Plan

- [x] 1. Add the path safety kernel and literal Git path handling.
  - [x] 1.1 Create or extend a shared path-safety helper for project-relative display paths and literal Git pathspecs.
  - [x] 1.2 Update keep `commitPaths` Git add calls to use the helper.
  - [x] 1.3 Update discard `revertPaths` Git restore/clean calls to use the helper.
  - [x] 1.4 Update finalizer plan file normalization and Git calls to reject or literalize pathspec magic.
  - [x] 1.5 Guard finalizer recursive filesystem deletion with realpath containment of the nearest existing parent.
  - [x] 1.6 Add pathspec and symlink/junction regression tests.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. Add response-level redaction for CLI command results.
  - [x] 2.1 Add a response redaction helper that can process nested run/check packet objects.
  - [x] 2.2 Apply it before JSON stdout printing in CLI dispatch.
  - [x] 2.3 Verify stored packet evidence keeps existing redaction behavior.
  - [x] 2.4 Add fixtures for API keys, bearer tokens, env paths, Windows paths, UNC paths, and POSIX paths.
  - _Requirements: 2.1, 2.2, 2.3, 2.5_

- [x] 3. Fix public dashboard export redaction.
  - [x] 3.1 Apply public-export scrub to embedded ledger data as well as view-model/meta data.
  - [x] 3.2 Add showcase export tests that fail on raw local paths or command fields in generated HTML.
  - _Requirements: 2.4, 2.5, 6.5_

- [x] 4. Make log persistence transactional from the operator perspective.
  - [x] 4.1 Wrap `appendSessionRunNote` as a warning-bearing secondary update after JSONL append.
  - [x] 4.2 Keep pending receipt and last-run cleanup reporting truthful after durable persistence.
  - [x] 4.3 Add tests for unwritable `autoresearch.md`, pending cleanup warning, and `--from-last`.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 5. Extract the shared session read model.
  - [x] 5.1 Introduce `buildSessionReadModel` or equivalent around current state, control-plane contracts, operator readout, finalization pressure, and dashboard projection inputs.
  - [x] 5.2 Update `state`, `state --compact`, `recommend-next --compact`, dashboard serve/export, and terminal reports to project from the shared model.
  - [x] 5.3 Replace compact-path `workflowFriction: []` shortcuts with shared model data.
  - [x] 5.4 Split cheap finalization pressure from full Git finalizer preview.
  - [x] 5.5 Add cross-surface consistency tests.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 6. Restore long-session performance.
  - [x] 6.1 Replace spread-array family accumulation in `buildExperimentMemory` with stable arrays or incremental aggregation.
  - [x] 6.2 Extend per-invocation session read caching so JSONL records and lane-result filters are reused.
  - [x] 6.3 Replace dashboard recursive research-tree fingerprinting with shallow stamps, capped traversal, or evidence-index versions.
  - [x] 6.4 Add chart downsampling and static export bounding for large ledgers.
  - [x] 6.5 Add deterministic long-session performance fixtures and keep the warm startup budget green.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 7. Harden the dashboard live server.
  - [x] 7.1 Add Host validation for loopback hosts and the active port.
  - [x] 7.2 Add defensive headers for HTML and JSON responses.
  - [x] 7.3 Preserve debug-ledger disabled-by-default behavior and line redaction.
  - [x] 7.4 Add HTTP tests for hostile Host, normal loopback Host, debug-ledger off, and debug-ledger on.
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 8. Bound partial-results artifact ingestion.
  - [x] 8.1 Add byte and row limits for partial-results artifacts.
  - [x] 8.2 Return explicit notices for oversized, truncated, malformed, missing, and outside-workdir artifacts.
  - [x] 8.3 Preserve lexical and realpath containment behavior.
  - [x] 8.4 Add tests for oversized JSON, excessive rows, malformed JSON, symlink/junction escape, absolute outside path, and normal salvage.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 9. Reduce CLI and session-core ownership coupling.
  - [x] 9.1 Add typed command dependency interfaces for migrated command slices.
  - [x] 9.2 Move `run`, `next`, and `log` behavior behind focused command modules or helpers.
  - [x] 9.3 Split durable ledger parsing from derived evidence/governance/product-claim/operator-readout policy.
  - [x] 9.4 Label any intentionally remaining monolith boundary in maintainer docs.
  - [x] 9.5 Add typecheck and command-surface coverage for migrated slices.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 10. Harden release workflows and runtime provenance.
  - [x] 10.1 Pin third-party actions in privileged workflows to full-length SHAs or add an equivalent enforced policy.
  - [x] 10.2 Add release job timeouts and concurrency controls.
  - [x] 10.3 Add finalizer launcher smoke to the release package verification job.
  - [x] 10.4 Add artifact attestation or a documented independent provenance verification path for hydrated runtime artifacts.
  - [x] 10.5 Add package/source-dist/action-pinning/provenance checks where repeatable.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 11. Correct docs and metadata truth gaps.
  - [x] 11.1 Fix README uninstall instructions to distinguish marketplace source removal from installed plugin removal.
  - [x] 11.2 Update package/plugin metadata to use guarded language for measured loops, live readout, and approved finalization.
  - [x] 11.3 Update README logging language to cover every packet decision class.
  - [x] 11.4 Update the skill/docs/changelog for behavior, command-surface, release, or architecture changes made by this branch.
  - [x] 11.5 Add source-hygiene/help checks for repeatable docs/metadata drift where practical.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 12. Run final verification and prepare the branch for review.
  - [x] 12.1 Run `npm run check` from `plugins/codex-autoresearch`.
  - [x] 12.2 Run targeted security repros for pathspec magic, redaction, Host rejection, showcase scrub, finalizer deletion containment, and partial-results caps.
  - [x] 12.3 Run `npm audit --json`, `npm pack --dry-run --json`, extracted launcher smoke, and package content inspection.
  - [x] 12.4 Build/export or serve the dashboard and inspect the generated surface for any changed dashboard behavior.
  - [x] 12.5 Report runtime/package provenance, remaining risks, skipped checks, and incomplete migration boundaries.
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
