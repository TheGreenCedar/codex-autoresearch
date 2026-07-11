import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { defaultCommandShell, quoteShellArg, renderShellCommand } from "./command-rendering.js";
import { defaultBenchmarkCommandExists } from "./benchmark/command-input.js";
import {
  gitStatusShort,
  insideGitRepo,
  shortHead,
  gitPrivatePath,
  runGit,
} from "./git-private-state.js";
import { parseNulPathList, parsePorcelainV1Z } from "./git-paths.js";
import { normalizeRelativePaths } from "./literal-paths.js";
import { resolvePackageRoot } from "./runtime-paths.js";
import { currentState, listOption } from "./session-core.js";
import { resolveSessionPaths } from "./session-paths.js";
import type { UnknownRecord } from "./types/json.js";
import type { LastRunPacket, LastRunPacketFreshness } from "./types/packet.js";

const DIRECTORY_FINGERPRINT_ENTRY_LIMIT = 500;
const DIRECTORY_FINGERPRINT_DEPTH_LIMIT = 6;
const FINGERPRINT_TOTAL_BYTE_LIMIT = 16 * 1024 * 1024;
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
const CHECKS_POLICIES = new Set(["always", "on-improvement", "manual"]);

export async function replacementNextCommandForLastRun(
  workDir: string,
  packet: LastRunPacket | null,
  defaultBenchmarkCommandReady?: boolean,
): Promise<string> {
  if (!packet) return "";
  const defaultReady =
    typeof defaultBenchmarkCommandReady === "boolean"
      ? defaultBenchmarkCommandReady
      : await defaultBenchmarkCommandExists(workDir);
  const packetRecord = packet as UnknownRecord;
  const history = record(packetRecord.history);
  const run = record(packetRecord.run);
  const checks = record(run.checks);
  const argv: unknown[] = [
    "node",
    path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"),
    "next",
    "--cwd",
    workDir,
  ];
  const command = history.replayCommand || run.command;
  if (command) argv.push("--command", command);
  else if (!defaultReady) return "";
  if (CHECKS_POLICIES.has(String(run.checksPolicy || ""))) {
    argv.push("--checks-policy", run.checksPolicy);
  }
  const checksCommand = history.replayChecksCommand || checks.command;
  if (checksCommand) argv.push("--checks-command", checksCommand);
  return renderShellCommand(argv);
}

export async function resolveLastRunPath(workDir: string): Promise<string> {
  if (await insideGitRepo(workDir)) {
    return await gitPrivatePath(workDir, "autoresearch/last-run.json");
  }
  return resolveSessionPaths({ workDir }).lastRunFallbackPath;
}

export async function readLastRunPacket(workDir: string): Promise<LastRunPacket> {
  const filePath = await resolveLastRunPath(workDir);
  const legacyPath = resolveSessionPaths({ workDir }).lastRunFallbackPath;
  const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(readablePath)) {
    throw new Error(
      [
        `No last-run packet found for ${workDir}.`,
        `Recovery: run ${shellQuote("node")} ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)} --compact,`,
        `or manually log measurement evidence with log --cwd ${shellQuote(workDir)} --metric <value> --status measure --description ${shellQuote("Describe the measurement")}.`,
      ].join(" "),
    );
  }
  return JSON.parse(fs.readFileSync(readablePath, "utf8")) as LastRunPacket;
}

export async function lastRunPacketFingerprint(workDir: string): Promise<string> {
  const filePath = await resolveLastRunPath(workDir);
  const legacyPath = resolveSessionPaths({ workDir }).lastRunFallbackPath;
  const readablePath = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(readablePath)) return "";
  return createHash("sha256").update(fs.readFileSync(readablePath, "utf8")).digest("hex");
}

export async function assertFreshLastRunPacket(
  workDir: string,
  packet: LastRunPacket,
  config: UnknownRecord | null = null,
): Promise<void> {
  const freshness = await lastRunPacketFreshness(workDir, packet, config);
  if (!freshness.fresh) throw new Error(`${freshness.reason} ${lastRunRecoveryText(workDir)}`);
}

export async function lastRunPacketFreshness(
  workDir: string,
  packet: LastRunPacket,
  runtimeConfig: UnknownRecord | null = null,
): Promise<LastRunPacketFreshness> {
  const history = record(packet.history);
  const expectedNextRun = Number(history.nextRun);
  const expectedSegment = Number(history.segment);
  if (!Number.isFinite(expectedNextRun)) {
    return {
      fresh: false,
      reason: "Last-run packet is missing history metadata. Run next again before logging.",
    };
  }
  const state = currentState(workDir);
  const expectedWorkDir = history.workDir || packet.workDir;
  if (expectedWorkDir && path.resolve(String(expectedWorkDir)) !== path.resolve(workDir)) {
    return {
      fresh: false,
      expectedWorkDir,
      actualWorkDir: workDir,
      reason:
        "Last-run packet is stale: working directory changed since the packet was created. Run next again before logging.",
    };
  }
  const actualNextRun = state.results.length + 1;
  if (Number.isFinite(expectedSegment) && state.segment !== expectedSegment) {
    return {
      fresh: false,
      expectedSegment,
      actualSegment: state.segment,
      reason: `Last-run packet is stale: expected segment #${expectedSegment}, but current segment is #${state.segment}. Run next again before logging.`,
    };
  }
  const expectedConfig = history.config;
  if (!expectedConfig || typeof expectedConfig !== "object") {
    return {
      fresh: false,
      reason: "Last-run packet is missing config metadata. Run next again before logging.",
    };
  }
  const actualConfig = lastRunConfigSnapshot(state.config);
  if (JSON.stringify(expectedConfig) !== JSON.stringify(actualConfig)) {
    return {
      fresh: false,
      expectedConfig,
      actualConfig,
      reason:
        "Last-run packet is stale: session config changed since the packet was created. Run next again before logging.",
    };
  }
  if (actualNextRun !== expectedNextRun) {
    return {
      fresh: false,
      expectedNextRun,
      actualNextRun,
      reason: `Last-run packet is stale: expected next log run #${expectedNextRun}, but current history would log #${actualNextRun}. Run next again before logging.`,
    };
  }
  const trustConfigValue = history.trustConfig;
  const trustConfig = record(trustConfigValue);
  if (trustConfigValue && runtimeConfig) {
    const run = record(packet.run);
    const checks = record(run.checks);
    const benchmarkContract = record(history.benchmarkContract);
    const actualTrustConfig = lastRunTrustConfigSnapshot(workDir, runtimeConfig, {
      benchmarkContractHash: benchmarkContract.surfaceHash,
      benchmarkCommand: run.command || benchmarkContract.command || history.command,
      checksCommand: checks.command || benchmarkContract.checksCommand,
      checksPolicy: run.checksPolicy,
      packetEnvMode: history.packetEnvMode || run.packetEnvMode,
    });
    if (trustConfig.hash !== actualTrustConfig.hash) {
      return {
        fresh: false,
        expectedTrustFields: trustConfig.fields,
        actualTrustFields: actualTrustConfig.fields,
        reason:
          "Last-run packet is stale: execution, checks, scope, or recipe trust configuration changed since the packet was created. Run next again before logging.",
      };
    }
  }
  const benchmarkContract = record(history.benchmarkContract);
  if (fingerprintsContainReason(benchmarkContract.files, "fingerprint_byte_budget")) {
    return {
      fresh: false,
      expectedTrustFields: trustConfig.fields || [],
      reason:
        "Last-run packet is stale: benchmark, checks, config, command, or environment files exceeded the shared fingerprint byte budget. Reduce those files, then run next again before logging.",
    };
  }
  const expectedGit = record(history.git);
  if (expectedGit.inside) {
    const actualGit = await lastRunGitSnapshot(workDir, {
      commitPaths: expectedGit.scopedPaths || [],
    });
    if (!actualGit.inside) {
      return {
        fresh: false,
        expectedGit,
        actualGit,
        reason:
          "Last-run packet is stale: the working directory is no longer a Git worktree. Run next again before logging.",
      };
    }
    if (expectedGit.head && actualGit.head && expectedGit.head !== actualGit.head) {
      return {
        fresh: false,
        expectedGit,
        actualGit,
        reason: `Last-run packet is stale: Git HEAD changed from ${expectedGit.head} to ${actualGit.head}. Run next again before logging.`,
      };
    }
    if (
      expectedGit.statusHash &&
      actualGit.statusHash &&
      expectedGit.statusHash !== actualGit.statusHash
    ) {
      return {
        fresh: false,
        expectedGit,
        actualGit,
        reason:
          "Last-run packet is stale: Git dirty state changed since the packet was created. Run next again before logging.",
      };
    }
    if (
      gitSnapshotContainsDirtyFingerprintTruncation(expectedGit) ||
      gitSnapshotContainsDirtyFingerprintTruncation(actualGit)
    ) {
      return {
        fresh: false,
        expectedGit,
        actualGit,
        reason:
          "Last-run packet is stale: dirty file fingerprints were truncated before freshness could be proven. Clean or narrow the dirty tree, then run next again before logging.",
      };
    }
    if (expectedGit.fileFingerprints || actualGit.fileFingerprints) {
      if (
        JSON.stringify(expectedGit.fileFingerprints || []) !==
        JSON.stringify(actualGit.fileFingerprints || [])
      ) {
        return {
          fresh: false,
          expectedGit,
          actualGit,
          reason:
            "Last-run packet is stale: scoped file fingerprints changed since the packet was created. Run next again before logging.",
        };
      }
    }
    if (expectedGit.dirtyFileFingerprints || actualGit.dirtyFileFingerprints) {
      if (
        JSON.stringify(expectedGit.dirtyFileFingerprints || []) !==
        JSON.stringify(actualGit.dirtyFileFingerprints || [])
      ) {
        return {
          fresh: false,
          expectedGit,
          actualGit,
          reason:
            "Last-run packet is stale: dirty file contents changed since the packet was created. Run next again before logging.",
        };
      }
    }
  }
  return {
    fresh: true,
    expectedNextRun,
    actualNextRun,
    expectedWorkDir: expectedWorkDir || workDir,
    command: history.replayCommand || history.command || record(packet.run).command || "",
    git: history.git || null,
    reason: "Last-run packet matches the current ledger.",
  };
}

export async function lastRunGitSnapshot(
  workDir: string,
  config: UnknownRecord = {},
): Promise<UnknownRecord> {
  if (!(await insideGitRepo(workDir).catch(() => false))) return { inside: false };
  const scopedPaths = normalizeRelativePaths(config.commitPaths, "commitPaths");
  const statusShort = await gitStatusShort(workDir);
  const fingerprintBudget = { remaining: FINGERPRINT_TOTAL_BYTE_LIMIT };
  return {
    inside: true,
    head: await shortHead(workDir),
    dirty: Boolean(statusShort),
    statusHash: hashText(statusShort),
    scopedPaths,
    fileFingerprints: await scopedFileFingerprints(workDir, scopedPaths, fingerprintBudget),
    dirtyFileFingerprints: await fileFingerprintsForPaths(
      workDir,
      dirtyPathsFromStatus(statusShort),
      fingerprintBudget,
    ),
  };
}

export function gitSnapshotContainsDirtyFingerprintTruncation(git: UnknownRecord): boolean {
  return (
    fingerprintsContainReason(git.fileFingerprints, "fingerprint_byte_budget") ||
    fingerprintsContainTruncation(git.dirtyFileFingerprints)
  );
}

export function fingerprintsContainReason(value: unknown, reason: string): boolean {
  if (Array.isArray(value)) return value.some((item) => fingerprintsContainReason(item, reason));
  if (!value || typeof value !== "object") return false;
  const item = value as UnknownRecord;
  if (item.truncated === true && item.reason === reason) return true;
  return Object.values(item).some((child) => fingerprintsContainReason(child, reason));
}

async function scopedFileFingerprints(
  workDir: string,
  paths: string[],
  budget: { remaining: number },
) {
  if (paths.length === 0) return [];
  const result = await runGit(["--literal-pathspecs", "ls-files", "-z", "--", ...paths], workDir);
  if (result.code !== 0) return [];
  if (result.stdoutTruncated)
    throw new Error(
      "Git path output exceeded the capture limit; refusing an incomplete trust check.",
    );
  const files = parseNulPathList(result.stdout).sort((a, b) => a.localeCompare(b));
  const fingerprints: UnknownRecord[] = [];
  for (const file of files) {
    if (fingerprints.length >= DIRECTORY_FINGERPRINT_ENTRY_LIMIT) {
      fingerprints.push({
        path: "<scoped-files>",
        truncated: true,
        reason: "scoped_file_entry_limit",
        maxEntries: DIRECTORY_FINGERPRINT_ENTRY_LIMIT,
        totalFiles: files.length,
      });
      break;
    }
    try {
      const fingerprint = await hashFileWithBudget(path.join(workDir, file), budget);
      fingerprints.push({ path: file, ...fingerprint });
      if ("truncated" in fingerprint && fingerprint.truncated) break;
    } catch (error) {
      fingerprints.push({ path: file, missing: true, error: errorCodeOrMessage(error) });
    }
  }
  return fingerprints;
}

async function fileFingerprintsForPaths(
  workDir: string,
  paths: string[],
  budget: { remaining: number },
) {
  const fingerprints: UnknownRecord[] = [];
  const uniquePaths = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  for (const file of uniquePaths) {
    if (fingerprints.length >= DIRECTORY_FINGERPRINT_ENTRY_LIMIT) {
      fingerprints.push({
        path: "<dirty-files>",
        truncated: true,
        reason: "dirty_file_entry_limit",
        maxEntries: DIRECTORY_FINGERPRINT_ENTRY_LIMIT,
        totalFiles: uniquePaths.length,
      });
      break;
    }
    const filePath = path.join(workDir, file);
    try {
      const stats = await fsp.lstat(filePath);
      if (stats.isDirectory()) {
        fingerprints.push({
          path: file,
          directory: true,
          files: await directoryFingerprints(workDir, file, budget),
        });
      } else if (stats.isSymbolicLink()) {
        fingerprints.push({ path: file, symlink: await fsp.readlink(filePath) });
      } else {
        const fingerprint = await hashFileWithBudget(filePath, budget);
        fingerprints.push({ path: file, ...fingerprint });
        if ("truncated" in fingerprint && fingerprint.truncated) break;
      }
    } catch (error) {
      fingerprints.push({ path: file, missing: true, error: errorCodeOrMessage(error) });
    }
  }
  return fingerprints;
}

async function directoryFingerprints(
  workDir: string,
  rootPath: string,
  budget: { remaining: number },
) {
  const root = path.resolve(workDir, rootPath);
  const base = path.resolve(workDir);
  const relativeRoot = path.relative(base, root);
  if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) return [];
  const entries: UnknownRecord[] = [];
  let truncated = false;
  const visit = async (relativeDir: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > DIRECTORY_FINGERPRINT_DEPTH_LIMIT) {
      entries.push({
        path: relativeDir,
        truncated: true,
        reason: "directory_depth_limit",
        maxDepth: DIRECTORY_FINGERPRINT_DEPTH_LIMIT,
        maxEntries: DIRECTORY_FINGERPRINT_ENTRY_LIMIT,
      });
      truncated = true;
      return;
    }
    const dirents = await fsp.readdir(path.join(workDir, relativeDir), { withFileTypes: true });
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= DIRECTORY_FINGERPRINT_ENTRY_LIMIT) {
        entries.push({
          path: relativeDir,
          truncated: true,
          reason: "directory_entry_limit",
          maxDepth: DIRECTORY_FINGERPRINT_DEPTH_LIMIT,
          maxEntries: DIRECTORY_FINGERPRINT_ENTRY_LIMIT,
        });
        truncated = true;
        return;
      }
      const relativePath = path.join(relativeDir, dirent.name).replace(/\\/g, "/");
      const absolutePath = path.join(workDir, relativePath);
      if (dirent.isDirectory()) {
        entries.push({ path: relativePath, directory: true });
        await visit(relativePath, depth + 1);
      } else if (dirent.isSymbolicLink()) {
        entries.push({ path: relativePath, symlink: await fsp.readlink(absolutePath) });
      } else if (dirent.isFile()) {
        const fingerprint = await hashFileWithBudget(absolutePath, budget);
        entries.push({ path: relativePath, ...fingerprint });
        if ("truncated" in fingerprint && fingerprint.truncated) truncated = true;
      } else {
        const stats = await fsp.lstat(absolutePath);
        entries.push({ path: relativePath, type: stats.isFIFO() ? "fifo" : "other" });
      }
      if (truncated) return;
    }
  };
  await visit(rootPath, 0);
  return entries;
}

async function hashFileWithBudget(filePath: string, budget: { remaining: number }) {
  const stats = await fsp.stat(filePath);
  if (stats.size > budget.remaining)
    return {
      truncated: true,
      reason: "fingerprint_byte_budget",
      maxBytes: FINGERPRINT_TOTAL_BYTE_LIMIT,
      size: stats.size,
    };
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const length = (chunk as Buffer).byteLength;
    if (length > budget.remaining)
      return {
        truncated: true,
        reason: "fingerprint_byte_budget",
        maxBytes: FINGERPRINT_TOTAL_BYTE_LIMIT,
        size: Math.max(stats.size, bytes + length),
      };
    budget.remaining -= length;
    bytes += length;
    hash.update(chunk as Buffer);
  }
  return { hash: hash.digest("hex"), size: bytes };
}

function dirtyPathsFromStatus(status: string): string[] {
  return parsePorcelainV1Z(status)
    .flatMap((entry) => entry.paths)
    .sort((a, b) => a.localeCompare(b));
}

function fingerprintsContainTruncation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(fingerprintsContainTruncation);
  if (!value || typeof value !== "object") return false;
  const item = value as UnknownRecord;
  if (item.truncated === true) return true;
  return Object.values(item).some(fingerprintsContainTruncation);
}

export function lastRunConfigSnapshot(config: UnknownRecord) {
  return {
    name: config.name || null,
    metricName: config.metricName || "metric",
    metricUnit: config.metricUnit ?? "",
    bestDirection: config.bestDirection === "higher" ? "higher" : "lower",
  };
}

export function lastRunTrustConfigSnapshot(
  workDir: string,
  config: UnknownRecord,
  context: UnknownRecord,
) {
  const surface = {
    benchmarkContractHash: String(context.benchmarkContractHash || ""),
    benchmarkCommandHash: hashText(normalizedTrustCommand(context.benchmarkCommand)),
    checksCommandHash: hashText(normalizedTrustCommand(context.checksCommand)),
    checksPolicy: String(config.checksPolicy || context.checksPolicy || "always"),
    protectedBenchmarkPaths: normalizeStringListForTrustHash(config.protectedBenchmarkPaths),
    fixedControl: config.fixedControl || null,
    secondaryMetricConstraints: normalizeStringListForTrustHash(config.secondaryMetricConstraints),
    secondaryMetricConstraintMode: String(config.secondaryMetricConstraintMode || "advisory"),
    packetEnvMode: String(context.packetEnvMode || "minimal"),
    commitPaths: normalizeRelativePaths(config.commitPaths, "commitPaths").sort(),
    workingDirectory: path.resolve(workDir),
    recipeProvenance: config.recipeCatalogProvenance || config.recipe_catalog_provenance || null,
  };
  return { hash: hashText(stableTrustJson(surface)), fields: Object.keys(surface).sort() };
}

function normalizedTrustCommand(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}
function normalizeStringListForTrustHash(value: unknown): string[] {
  return (Array.isArray(value) ? value : listOption(value))
    .map(stableTrustJson)
    .filter(Boolean)
    .sort();
}
function stableTrustJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTrustJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as UnknownRecord)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableTrustJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
function lastRunRecoveryText(workDir: string): string {
  return [
    `Recovery: run node ${shellQuote(path.join(PLUGIN_ROOT, "scripts", "autoresearch.mjs"))} next --cwd ${shellQuote(workDir)} --compact,`,
    `or manually log measurement evidence with log --cwd ${shellQuote(workDir)} --metric <value> --status measure --description ${shellQuote("Describe the measurement")}.`,
  ].join(" ");
}
function shellQuote(value: unknown): string {
  return quoteShellArg(value, defaultCommandShell());
}
function hashText(value: unknown): string {
  return createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}
function errorCodeOrMessage(error: unknown): string {
  return error && typeof error === "object"
    ? String(
        (error as { code?: unknown; message?: unknown }).code ||
          (error as { message?: unknown }).message ||
          error,
      )
    : String(error);
}
function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}
