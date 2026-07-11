import fsp from "node:fs/promises";
import path from "node:path";

import { boolOption } from "./cli/args.js";
import {
  protectedBenchmarkGuardForWorkDir,
  protectedBenchmarkWarningFromGuard,
} from "./benchmark/contract-guards.js";
import { benchmarkContractSnapshot } from "./benchmark/contract-snapshot.js";
import { pendingLogTransactionWarnings } from "./commands/log.js";
import { gitDirtyPathDetails, gitPrivatePath, insideGitRepo } from "./git-private-state.js";
import { fingerprintsContainReason } from "./last-run-store.js";
import { currentState, listOption, pathExists, readConfig, readJsonl } from "./session-core.js";
import { AUTORESEARCH_DASHBOARD_FILE, AUTORESEARCH_SESSION_FILES } from "./session-paths.js";
import type { UnknownRecord } from "./types/json.js";

type CommandRecord = UnknownRecord;

const AUTORESEARCH_OWNED_DIRS = [
  "autoresearch.research",
  "target/autoresearch",
  ".autoresearch-cache",
];

export async function operatorWarningsForWorkDir(
  workDir: string,
  stateOverride: CommandRecord | null = null,
) {
  const inGit = await insideGitRepo(workDir);
  const config = readConfig(workDir);
  const state = stateOverride || currentState(workDir);
  const warnings: CommandRecord[] = [];
  warnings.push(...(await pendingLogTransactionWarnings(workDir, inGit)));
  if (inGit) {
    const dirtyPaths = await gitDirtyPathDetails(workDir);
    const sourceDirtyPaths = dirtyPaths.filter(
      (entry) => !isAutoresearchOwnedDirtyPath(entry.path),
    );
    if (sourceDirtyPaths.length > 0) {
      warnings.push({
        code: "git_dirty",
        severity: "warning",
        message: "Git worktree is dirty; review unrelated changes before logging a keep result.",
        action:
          "Inspect git status and configure commitPaths or revertPaths before trusting keep/discard automation.",
        paths: sourceDirtyPaths.map((entry) => entry.path).slice(0, 12),
      });
    } else if (dirtyPaths.length > 0) {
      warnings.push({
        code: "autoresearch_session_dirty",
        severity: "info",
        message:
          "Only Autoresearch session artifacts are dirty; source drift checks will not block the next action.",
        action: "Continue the loop, then include or exclude session artifacts during finalization.",
        paths: dirtyPaths.map((entry) => entry.path).slice(0, 12),
      });
    }
  }
  const missingCommitPaths = [];
  for (const item of listOption(config.commitPaths || config.commit_paths)) {
    if (!(await pathExists(path.resolve(workDir, item)))) missingCommitPaths.push(item);
  }
  if (missingCommitPaths.length) {
    warnings.push({
      code: "missing_commit_paths",
      severity: "warning",
      message: `Configured commitPaths do not exist: ${missingCommitPaths.slice(0, 5).join(", ")}.`,
      action:
        "Update commitPaths before relying on keep commits or use explicit --commit-paths for the next log.",
    });
  }
  const contractDrift = await benchmarkContractDrift(workDir, state);
  if (contractDrift) warnings.push(contractDrift);
  const protectedBenchmarkGuard = await protectedBenchmarkGuardForWorkDir(workDir, config, state);
  const protectedBenchmarkWarning = protectedBenchmarkWarningFromGuard(protectedBenchmarkGuard);
  if (protectedBenchmarkWarning) warnings.push(protectedBenchmarkWarning);
  warnings.push(...(await benchmarkIntegrityPreflight(workDir, config, state, { inGit })));
  return warnings;
}

export async function benchmarkIntegrityPreflight(
  workDir: string,
  config: CommandRecord,
  state: CommandRecord,
  options: { inGit?: boolean } = {},
) {
  const warnings: CommandRecord[] = [];
  const hasIntegrityGuard = Boolean(
    config.benchmarkIntegrityCommand ||
    config.benchmark_integrity_command ||
    config.contaminationCheckCommand ||
    config.contamination_check_command ||
    config.promotionBenchmarkCommand ||
    config.promotion_benchmark_command ||
    config.holdoutCommand ||
    config.holdout_command ||
    config.devHoldoutSplit ||
    config.dev_holdout_split,
  );
  const current = Array.isArray(state.current) ? state.current : [];
  if (current.length === 0 && !hasIntegrityGuard) {
    warnings.push({
      code: "benchmark_integrity_preflight_missing",
      severity: "warning",
      message:
        "No evaluator-contamination guard is configured for the first packet: benchmark leakage, stale artifacts, cache reuse, and dev/holdout split are unproven.",
      action:
        "Add a benchmarkIntegrityCommand/holdout or run benchmark-inspect plus benchmark-lint before trusting the baseline.",
    });
  }
  const staleArtifactRoots = [];
  for (const relative of ["target/autoresearch", ".autoresearch-cache"]) {
    if (await pathExists(path.join(workDir, relative))) staleArtifactRoots.push(relative);
  }
  const inGit = options.inGit ?? (await insideGitRepo(workDir).catch(() => false));
  if (inGit && (await gitPrivateDirectoryHasBenchmarkArtifacts(workDir, "autoresearch"))) {
    staleArtifactRoots.push(".git/autoresearch");
  }
  if (staleArtifactRoots.length && !boolOption(config.allowStaleArtifacts, false)) {
    warnings.push({
      code: "stale_benchmark_artifacts",
      severity: "warning",
      message: `Previous benchmark/autoresearch artifacts exist: ${staleArtifactRoots.join(", ")}.`,
      action:
        "Clear or namespace benchmark artifacts before the first packet, or set an explicit freshness guard in the benchmark contract.",
    });
  }
  return warnings;
}

export function latestBenchmarkContractEntry(
  workDir: string,
  state: CommandRecord | null | undefined,
): CommandRecord | null {
  const fromState = latestBenchmarkContractEntryFromState(state);
  if (fromState) return fromState;
  try {
    const fromCurrentState = latestBenchmarkContractEntryFromState(currentState(workDir));
    if (fromCurrentState) return fromCurrentState;
  } catch {
    // Fall back to the raw ledger below if state reconstruction is unavailable.
  }
  return (
    [...readJsonl(workDir)]
      .reverse()
      .find((entry) => record(entry.benchmarkContract).surfaceHash) || null
  );
}

async function benchmarkContractDrift(workDir: string, state: CommandRecord) {
  const latest = latestBenchmarkContractEntry(workDir, state);
  if (!latest) return null;
  const latestContract = record(latest.benchmarkContract);
  const current = await benchmarkContractSnapshot(workDir, {
    command: latestContract.command,
    checksCommand: latestContract.checksCommand,
    commandFile: latestContract.commandFile,
    envFile: latestContract.envFile,
    ...(Object.hasOwn(latestContract, "packetEnvMode")
      ? { packetEnvMode: latestContract.packetEnvMode }
      : {}),
  });
  if (
    fingerprintsContainReason(latestContract.files, "fingerprint_byte_budget") ||
    fingerprintsContainReason(current.files, "fingerprint_byte_budget")
  ) {
    return {
      code: "benchmark_contract_fingerprint_budget_exceeded",
      severity: "error",
      run: latest.run ?? null,
      message:
        "Benchmark/check/config contract files exceed the shared fingerprint byte budget, so freshness cannot be proven.",
      action: "Reduce or remove oversized contract files, then run next again.",
    };
  }
  if (current.surfaceHash === latestContract.surfaceHash) return null;
  const driftReference =
    latest.run != null
      ? `logged run #${latest.run}`
      : latest.segment != null
        ? `segment ${latest.segment} contract`
        : "the active benchmark contract";
  return {
    code: "benchmark_contract_changed",
    severity: "error",
    run: latest.run ?? null,
    message: `Benchmark/check/config contract changed since ${driftReference}. Start a new segment or explicitly invalidate old evidence before running more packets or finalizing.`,
    action: "Run new-segment --dry-run, then --yes after reviewing the changed benchmark contract.",
    previousHash: latestContract.surfaceHash,
    currentHash: current.surfaceHash,
  };
}

function latestBenchmarkContractEntryFromState(
  state: CommandRecord | null | undefined,
): CommandRecord | null {
  const activeConfigEntry = record(state?.activeConfigEntry);
  if (
    activeConfigEntry.benchmarkContractAccepted === true &&
    activeConfigEntry.benchmarkContractScope === "segment" &&
    record(activeConfigEntry.benchmarkContract).surfaceHash
  ) {
    return activeConfigEntry;
  }
  const current = Array.isArray(state?.current) ? state.current : [];
  return (
    [...current]
      .reverse()
      .map(record)
      .find((run) => record(run.benchmarkContract).surfaceHash) || null
  );
}

function isAutoresearchOwnedDirtyPath(relativePath: string) {
  return (
    AUTORESEARCH_SESSION_FILES.includes(
      relativePath as (typeof AUTORESEARCH_SESSION_FILES)[number],
    ) ||
    relativePath === AUTORESEARCH_DASHBOARD_FILE ||
    AUTORESEARCH_OWNED_DIRS.some(
      (directory) => relativePath === directory || relativePath.startsWith(`${directory}/`),
    )
  );
}

async function gitPrivateDirectoryHasBenchmarkArtifacts(workDir: string, relativePath: string) {
  try {
    const directory = await gitPrivatePath(workDir, relativePath);
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((): [] => []);
    return entries.some((entry) => entry.name !== "last-run.json");
  } catch {
    return false;
  }
}

function record(value: unknown): CommandRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CommandRecord)
    : {};
}
