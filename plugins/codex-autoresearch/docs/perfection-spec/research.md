# Verifiable Research and Technology Proposal

## 1. Core Problem Analysis

The repository already has a strong product contract, but the audit found safety, redaction, transactionality, performance, and documentation gaps that can make Autoresearch less trustworthy under real operator load. The primary technical challenge is to repair those gaps without adding a second control plane, weakening the CLI-first workflow, or presenting benchmark-shaped improvements as product-grade proof.

## 2. Verifiable Technology Recommendations

| Technology/Pattern | Rationale and Evidence |
|---|---|
| **Literal Git pathspec boundary** | Git provides `--literal-pathspecs` to treat pathspecs literally without globbing or pathspec magic, and it also supports per-path literal magic with `:(literal)` [cite:1]. Autoresearch should make every user/config/plan path that reaches `git add`, `git restore`, `git clean`, `git rm`, `git diff`, or finalizer review commands literal so scoped mutation cannot be expanded by Git pathspec magic [cite:1]. |
| **Realpath containment before filesystem deletion** | Node's `fsPromises.rm()` with `{ recursive: true, force: true }` is the documented `rm -rf` style removal primitive, so any call using that shape is a high-trust filesystem mutation and must be guarded by realpath containment before execution [cite:2]. Autoresearch already has a realpath-aware containment helper, so finalizer cleanup should reuse that local primitive instead of relying on lexical validation before recursive removal [cite:2]. |
| **Response-level redaction as a command-output boundary** | GitHub documents that automatic secret redaction is not guaranteed and recommends auditing command output paths because secrets can appear in stdout or stderr in unexpected ways [cite:3]. Autoresearch should apply response-level redaction before printing `run`, `next`, dashboard export, partial-results, or diagnostics output because persisted evidence redaction alone does not protect copied CLI output [cite:3]. |
| **Pinned privileged workflows** | GitHub recommends pinning third-party actions to a full-length commit SHA because SHA pinning is the immutable-release option for actions and reduces the risk of a compromised action changing underneath a workflow [cite:3]. Autoresearch release workflows that can write tags or releases should pin external actions and automate update review rather than relying on floating major tags [cite:3]. |
| **Release artifact provenance** | GitHub artifact attestations create cryptographically signed claims that establish build provenance and include workflow, repository, commit SHA, and triggering event information [cite:4]. Autoresearch runtime hydration should keep checksum validation for corruption detection, but release artifacts that hydrate executable `dist/` should also have an independently verifiable provenance path [cite:4]. |
| **Local dashboard browser hardening** | CSP lets a server control which resources a browser can load for a page and helps guard against cross-site scripting attacks [cite:5]. `X-Content-Type-Options: nosniff` tells browsers to respect declared MIME types and avoid MIME sniffing [cite:6]. The dashboard is loopback-only and read-only, but it still renders local session data in a browser, so Host validation, a narrow CSP, and `nosniff` headers are appropriate defense-in-depth [cite:5] [cite:6]. |
| **Bounded artifact ingestion** | Node's normal JSON parsing and file reading APIs operate on complete inputs, so any benchmark-controlled artifact reader that does not cap bytes or rows can become a local availability risk when the artifact is large [cite:2]. Autoresearch should mirror its existing task-manifest caps for partial-results artifacts and return explicit truncation notices instead of materializing unbounded candidate rows [cite:2]. |

## 3. Local Audit Evidence Used

- F1: `npm run check` failed because `recommend-next --compact` exceeded the warm startup budget.
- F2: Git pathspec magic such as `:(top)` can bypass scoped `commitPaths`, `revertPaths`, and finalizer file lists.
- F3: `log` can append JSONL and clear last-run state before failing on `autoresearch.md`.
- F4: Immediate `run` and non-compact `next` JSON can print raw benchmark/check output while stored packets are redacted.
- F5: Compact state, full state, and dashboard readout rebuild related control-plane decisions independently.
- F6: `buildExperimentMemory()` is superlinear for long sessions.
- F7: Dashboard freshness recursively fingerprints `autoresearch.research`.
- F8: Static dashboard export and charts scale with every ledger row.
- F9: `partial-results` reads and parses artifact JSON without byte or row caps.
- F10: Live dashboard accepts arbitrary Host headers.
- F11: `--showcase` export can leak raw ledger paths because public scrub is not applied to all embedded data.
- F12: Finalizer filesystem delete uses lexical validation before recursive `fs.rm`.
- F13: `scripts/autoresearch.ts` and `session-core` remain high-coupling ownership hubs.
- F14: Release workflow action refs float by major tag and release smoke is narrower than package smoke.
- F15: README/plugin metadata contain small but user-facing truth gaps.

## 4. Browsed Sources

- [1] https://git-scm.com/docs/git
- [2] https://nodejs.org/api/fs.html
- [3] https://docs.github.com/en/actions/reference/security/secure-use
- [4] https://docs.github.com/en/actions/concepts/security/artifact-attestations
- [5] https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy
- [6] https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Content-Type-Options

