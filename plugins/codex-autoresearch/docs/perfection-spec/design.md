# Design Document

## Overview

The perfection branch should proceed as a controlled sequence of safety and architecture slices. Safety and correctness fixes come first because they protect user work. Performance and read-model unification come next because the package gate is already red. Release and documentation truth close the loop so the shipped plugin, docs, and marketplace metadata do not overclaim.

## Principles

- Fix root causes before loosening gates.
- Prefer shared local primitives over new ad hoc validators.
- Keep dashboard read-only.
- Keep source checkout behavior separate from installed runtime claims.
- Treat redaction as an output boundary, not only a persistence detail.
- Keep every task traceable to a requirement ID.

## Component Specifications

### Component: PathSafetyKernel

**Purpose**: Normalize and enforce literal, realpath-contained project paths before Git or filesystem mutation.

**Locations**:

- `plugins/codex-autoresearch/scripts/autoresearch.ts`
- `plugins/codex-autoresearch/scripts/finalize-autoresearch.ts`
- `plugins/codex-autoresearch/lib/path-containment.ts`
- new helper if needed: `plugins/codex-autoresearch/lib/path-safety.ts`

**Interface**:

```ts
export type SafeProjectPath = {
  gitPathspec: string; // literal pathspec suitable for Git argv calls
  relativePath: string; // normalized slash path for display/config
};

export function normalizeSafeProjectPaths(
  paths: unknown,
  optionName: string,
  options?: { allowSpecialLiteralNames?: boolean },
): SafeProjectPath[];

export async function assertRecursiveRemovalInsideRoot(
  root: string,
  relativePath: string,
): Promise<string>;
```

**Implements**: 1.1, 1.2, 1.3, 1.4, 1.5.

**Notes**:

- The simplest first implementation can reject any path beginning with `:`; a more complete implementation can preserve literal filenames by wrapping pathspecs with `:(literal)`.
- Git command call sites should make it visually obvious when they expect display paths and when they expect literal pathspecs.

### Component: OutputRedactionBoundary

**Purpose**: Apply one response-level redaction policy to every command and export surface that can print or embed benchmark, checks, ledger, or path data.

**Locations**:

- `plugins/codex-autoresearch/scripts/autoresearch.ts`
- `plugins/codex-autoresearch/lib/evidence-redaction.ts`
- `plugins/codex-autoresearch/lib/commands/dashboard.ts`
- dashboard export helpers near `dashboardHtml`

**Interface**:

```ts
export type RedactionContext = {
  publicExport?: boolean;
  workDir?: string;
};

export function redactCliResponse<T>(value: T, context: RedactionContext): T;
export function redactPublicDashboardData<T>(value: T, context: RedactionContext): T;
```

**Implements**: 2.1, 2.2, 2.3, 2.4.

**Notes**:

- Apply before `writeStdout(JSON.stringify(...))`.
- Keep compact output useful; do not replace every path-looking substring in non-public local output unless it matches secret/path rules.

### Component: TransactionalLogWriter

**Purpose**: Persist run decisions so successful durable writes do not surface as failed logs, and secondary note failures become recoverable warnings.

**Locations**:

- `plugins/codex-autoresearch/scripts/autoresearch.ts`
- `plugins/codex-autoresearch/lib/commands/log.ts`

**Interface**:

```ts
export type LogWarning = {
  code: "session_note_update_failed" | "pending_receipt_cleanup_failed";
  message: string;
  recovery: string;
};

export async function recordRunDecision(...): Promise<{
  ok: true;
  warnings: LogWarning[];
  lastRunCleared: boolean;
}>;
```

**Implements**: 3.1, 3.2, 3.3, 3.4.

**Notes**:

- `autoresearch.jsonl` remains authoritative.
- `autoresearch.md` failures should be visible, but not false negatives for durable log success.

### Component: SessionReadModel

**Purpose**: Build one authoritative decision/readout model used by state, recommend-next, dashboard, finalization pressure, and operator handoff.

**Locations**:

- `plugins/codex-autoresearch/lib/session-core.ts`
- `plugins/codex-autoresearch/lib/session-records.ts`
- `plugins/codex-autoresearch/lib/session-read-model.ts`
- `plugins/codex-autoresearch/lib/dashboard-view-model.ts`
- `plugins/codex-autoresearch/lib/commands/state.ts`
- `plugins/codex-autoresearch/lib/commands/recommend-next.ts`

**Interface**:

```ts
export type SessionReadModelMode = "full" | "compact" | "dashboard";

export async function buildSessionReadModel(options: {
  workDir: string;
  mode?: SessionReadModelMode;
  includeExpensiveFinalizationPreview?: boolean;
  cache?: SessionReadCache;
}): Promise<SessionReadModel>;

export function projectCompactState(model: SessionReadModel): CompactState;
export function projectDashboardViewModel(model: SessionReadModel): DashboardViewModel;
```

**Implements**: 4.1, 4.2, 4.3, 4.4.

**Notes**:

- Compute once, then project.
- Keep finalizer branch/file walking out of default compact state.

### Component: LongSessionEngine

**Purpose**: Keep ledger parsing, experiment memory, dashboard freshness, chart data, and exports bounded for large sessions.

**Locations**:

- `plugins/codex-autoresearch/lib/experiment-memory.ts`
- `plugins/codex-autoresearch/lib/session-core.ts`
- `plugins/codex-autoresearch/lib/session-records.ts`
- `plugins/codex-autoresearch/lib/live-server.ts`
- `plugins/codex-autoresearch/dashboard/src/model/chart.ts`
- `plugins/codex-autoresearch/scripts/autoresearch.ts` static export helpers

**Interface**:

```ts
export function buildExperimentMemoryLinear(...): ExperimentMemory;
export function downsampleRunsForChart(...): ChartPoint[];
export function fingerprintSessionShallow(...): Promise<string>;
```

**Implements**: 5.1, 5.2, 5.3, 5.4.

**Notes**:

- The immediate release blocker is the warm startup budget.
- Performance fixes should be measured before and after with the same fixture shape.

### Component: DashboardPrivacyServer

**Purpose**: Serve and export dashboard data with Host validation, defensive headers, debug-ledger boundaries, and public-export scrubbing.

**Locations**:

- `plugins/codex-autoresearch/lib/live-server.ts`
- `plugins/codex-autoresearch/lib/commands/dashboard.ts`
- `plugins/codex-autoresearch/assets/template.html`
- dashboard export helpers in `scripts/autoresearch.ts`

**Interface**:

```ts
export function validateDashboardHostHeader(host: string | undefined, port: number): boolean;
export function dashboardSecurityHeaders(contentType: string): Record<string, string>;
```

**Implements**: 6.1, 6.2, 6.3, 6.4.

**Notes**:

- Loopback binding stays required.
- Host rejection should be tested without needing a full browser DNS-rebinding proof.

### Component: ArtifactIngestionGuard

**Purpose**: Bound partial-results and benchmark artifact parsing by size, row count, containment, and explicit truncation notices.

**Locations**:

- `plugins/codex-autoresearch/lib/partial-results.ts`
- `plugins/codex-autoresearch/lib/commands/partial-results.ts`
- `plugins/codex-autoresearch/lib/task-artifact-indexer.ts`

**Interface**:

```ts
export type ArtifactReadLimits = {
  maxBytes: number;
  maxRows: number;
};

export async function readBoundedPartialResultArtifact(
  artifactPath: string,
  limits: ArtifactReadLimits,
): Promise<ParsedArtifactResult>;
```

**Implements**: 7.1, 7.2, 7.3, 7.4.

**Notes**:

- Reuse task-manifest cap style where practical.
- Prefer explicit skipped notices over silent truncation.

### Component: ReleaseTrustPipeline

**Purpose**: Verify package contents, pin privileged workflow dependencies, smoke all shipped launchers, and attach/check release provenance.

**Locations**:

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/workflows/auto-release.yml`
- `.github/workflows/codeql.yml`
- `plugins/codex-autoresearch/scripts/bootstrap-runtime.mjs`
- `plugins/codex-autoresearch/scripts/check.ts`

**Interface**:

```yaml
permissions:
  contents: read

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
```

**Implements**: 9.1, 9.2, 9.3, 9.4.

**Notes**:

- The release job can still use GitHub releases; the change is to make trust inputs less mutable.
- Attestation verification can begin as documented release evidence if marketplace/runtime constraints make automated bootstrap verification a separate slice.

### Component: DocsTruthSurface

**Purpose**: Keep README, docs, skill, metadata, changelog, and help text synchronized with actual runtime behavior.

**Locations**:

- `README.md`
- `CHANGELOG.md`
- `plugins/codex-autoresearch/docs/*`
- `plugins/codex-autoresearch/skills/codex-autoresearch/SKILL.md`
- `plugins/codex-autoresearch/package.json`
- `plugins/codex-autoresearch/.codex-plugin/plugin.json`

**Interface**:

```text
Every user-facing behavior, command-surface, release, docs, skill, dashboard, or metadata change updates the nearest durable surface and root CHANGELOG.md.
```

**Implements**: 8.4, 10.1, 10.2, 10.3, 10.4.

### Component: VerificationGate

**Purpose**: Prove fixes with targeted regressions, package gate checks, audit probes, and dashboard/runtime evidence.

**Locations**:

- `plugins/codex-autoresearch/tests/*`
- `plugins/codex-autoresearch/scripts/check.ts`
- `plugins/codex-autoresearch/scripts/perfection-benchmark.ts`
- GitHub workflows

**Interface**:

```bash
npm run check
npm audit --json
npm pack --dry-run --json
node scripts/autoresearch.mjs --help
node scripts/finalize-autoresearch.mjs --help
git diff --check
```

**Implements**: 1.6, 2.5, 3.5, 4.5, 5.5, 5.6, 6.5, 7.5, 8.5, 9.5, 10.5, 11.1, 11.2, 11.3, 11.4, 11.5.
