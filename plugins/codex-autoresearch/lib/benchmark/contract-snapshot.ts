import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { packetEnvModeFromArgs, resolveOptionPath } from "./command-input.js";
import { pathExists } from "../session-core.js";
import type { UnknownRecord } from "../types/json.js";

const FINGERPRINT_TOTAL_BYTE_LIMIT = 16 * 1024 * 1024;

export async function benchmarkContractSnapshot(
  workDir: string,
  context: UnknownRecord = {},
): Promise<UnknownRecord> {
  const fixedFiles = [
    "autoresearch.sh",
    "autoresearch.ps1",
    "autoresearch.checks.sh",
    "autoresearch.checks.ps1",
    "autoresearch.config.json",
    "package.json",
    "Cargo.toml",
  ];
  const fingerprintBudget = { remaining: FINGERPRINT_TOTAL_BYTE_LIMIT };
  const fileFingerprints: UnknownRecord[] = [];
  for (const relative of fixedFiles) {
    const filePath = path.join(workDir, relative);
    if (!(await pathExists(filePath))) continue;
    fileFingerprints.push(
      await contractFileFingerprint(workDir, filePath, relative, fingerprintBudget),
    );
  }
  const command = String(context.command || "").trim();
  const checksCommand = String(context.checksCommand || "").trim();
  const commandFile = contractPathLabel(workDir, context.commandFile);
  const envFile = contractPathLabel(workDir, context.envFile);
  const hasPacketEnvMode = Object.hasOwn(context, "packetEnvMode");
  const packetEnvMode = hasPacketEnvMode ? packetEnvModeFromArgs(context) : "";
  for (const [label, filePath] of [
    [commandFile, context.commandFile],
    [envFile, context.envFile],
  ] as const) {
    if (filePath) {
      fileFingerprints.push(
        await contractFileFingerprint(workDir, String(filePath), label, fingerprintBudget),
      );
    }
  }
  const contractSurface: UnknownRecord = {
    command: command.replace(/\s+/g, " "),
    checksCommand: checksCommand.replace(/\s+/g, " "),
    commandFile,
    envFile,
    files: fileFingerprints,
  };
  if (hasPacketEnvMode) contractSurface.packetEnvMode = packetEnvMode;
  const snapshot: UnknownRecord = {
    command,
    checksCommand,
    commandFile,
    envFile,
    surfaceHash: hashText(JSON.stringify(contractSurface)),
    files: fileFingerprints,
    fingerprintByteBudgetExceeded: containsFingerprintReason(
      fileFingerprints,
      "fingerprint_byte_budget",
    ),
    capturedAt: new Date().toISOString(),
  };
  if (hasPacketEnvMode) snapshot.packetEnvMode = packetEnvMode;
  return snapshot;
}

async function contractFileFingerprint(
  workDir: string,
  filePath: string,
  label = "",
  budget: { remaining: number } = { remaining: FINGERPRINT_TOTAL_BYTE_LIMIT },
): Promise<UnknownRecord> {
  const resolved = resolveOptionPath(filePath, workDir);
  const display = label || contractPathLabel(workDir, resolved);
  try {
    return { path: display, ...(await hashFileWithBudget(resolved, budget)) };
  } catch (error) {
    return { path: display, missing: true, error: errorCodeOrMessage(error) };
  }
}

function contractPathLabel(workDir: string, filePath: unknown): string {
  const input = String(filePath || "").trim();
  if (!input) return "";
  const resolved = resolveOptionPath(input, workDir);
  const relative = path.relative(workDir, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : resolved;
}

async function hashFileWithBudget(filePath: string, budget: { remaining: number }) {
  const stats = await fsp.stat(filePath);
  if (stats.size > budget.remaining) {
    return {
      truncated: true,
      reason: "fingerprint_byte_budget",
      maxBytes: FINGERPRINT_TOTAL_BYTE_LIMIT,
      size: stats.size,
    };
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const length = (chunk as Buffer).byteLength;
    if (length > budget.remaining) {
      return {
        truncated: true,
        reason: "fingerprint_byte_budget",
        maxBytes: FINGERPRINT_TOTAL_BYTE_LIMIT,
        size: Math.max(stats.size, bytes + length),
      };
    }
    budget.remaining -= length;
    bytes += length;
    hash.update(chunk as Buffer);
  }
  return { hash: hash.digest("hex"), size: bytes };
}

function containsFingerprintReason(value: unknown, reason: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsFingerprintReason(item, reason));
  if (!value || typeof value !== "object") return false;
  const record = value as UnknownRecord;
  if (record.truncated === true && record.reason === reason) return true;
  return Object.values(record).some((item) => containsFingerprintReason(item, reason));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorCodeOrMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const payload = error as { code?: unknown; message?: unknown };
    return String(payload.code || payload.message || error);
  }
  return String(error);
}
