import fsp from "node:fs/promises";
import path from "node:path";

import {
  evidenceClaim,
  mergeEvidenceClaims,
  type EvidenceClaim,
  type EvidenceIndex,
} from "./evidence-index.js";
import { resolveSafeResearchPath } from "./research-path-guard.js";
import { type SessionForensicsSummary } from "./session-forensics.js";

export interface ContextCapsuleWriteOptions {
  cwd: string;
  researchSlug: string;
  summary: SessionForensicsSummary;
  apply: boolean;
}

export interface ContextCapsuleResult {
  dryRun: boolean;
  outputDir: string;
  files: string[];
  warnings: string[];
  evidenceIndex?: EvidenceIndex;
}

const CAPSULE_FILES = [
  "session-digest.md",
  "decisions.jsonl",
  "quality-gaps.md",
  "evidence-index.json",
];

export async function writeContextCapsule(
  options: ContextCapsuleWriteOptions,
): Promise<ContextCapsuleResult> {
  const safe = await resolveSafeResearchPath(options.cwd, options.researchSlug);
  const files = CAPSULE_FILES.map((file) => path.join(safe.outputDir, file));
  if (!options.apply) {
    return { dryRun: true, outputDir: safe.outputDir, files, warnings: [] };
  }
  const claims = claimsForSummary(options.summary);
  const digest = digestMarkdown(options.summary, claims);
  const gaps = qualityGapsMarkdown(options.summary, claims);
  await fsp.mkdir(safe.outputDir, { recursive: true });
  await appendMarkdown(path.join(safe.outputDir, "session-digest.md"), digest);
  await appendJsonl(path.join(safe.outputDir, "decisions.jsonl"), {
    type: "session_forensics_import",
    sourcePath: options.summary.sourcePath,
    importedAt: new Date().toISOString(),
    claimIds: claims.map((claim) => claim.id),
  });
  await appendMarkdown(path.join(safe.outputDir, "quality-gaps.md"), gaps);
  const evidenceIndex = await mergeEvidenceClaims(options.cwd, safe.slug, claims);
  return { dryRun: false, outputDir: safe.outputDir, files, warnings: [], evidenceIndex };
}

function claimsForSummary(summary: SessionForensicsSummary): EvidenceClaim[] {
  const source = summary.sourcePath;
  const signals = [
    ...summary.userCorrections,
    ...summary.productSignals,
    ...summary.repeatedFamilies,
    ...summary.workflowWaste,
    ...summary.blockers,
  ];
  const claims = signals.slice(0, 40).map((signal) =>
    evidenceClaim({
      claim: `${signal.kind}: ${signal.message}`,
      source,
      evidenceType: "session",
      freshness: "current",
      confidence: signal.severity === "blocker" ? "high" : "medium",
      promotionRelevance: "diagnostic",
    }),
  );
  claims.unshift(
    evidenceClaim({
      claim: `Session import covered ${summary.counts.response_item || 0} response items and ${summary.compactions} compactions.`,
      source,
      evidenceType: "session",
      freshness: "current",
      confidence: "high",
      promotionRelevance: "diagnostic",
    }),
  );
  return dedupeClaims(claims);
}

function digestMarkdown(summary: SessionForensicsSummary, claims: EvidenceClaim[]): string {
  const topTools = topEntries(summary.toolCounts, 8);
  const topCommands = topEntries(summary.commandClasses, 8);
  return [
    `## Session Forensics Import - ${new Date().toISOString()}`,
    "",
    `Source: \`${summary.sourcePath}\``,
    `Window: ${summary.timeWindow.first || "unknown"} to ${summary.timeWindow.last || "unknown"}`,
    `Compactions: ${summary.compactions}`,
    `Goal: ${summary.goal.status || "unknown"}; tokens=${summary.goal.tokensUsed ?? "unknown"}; seconds=${summary.goal.timeUsedSeconds ?? "unknown"}`,
    "",
    "### Counts",
    "",
    `- Event types: ${JSON.stringify(summary.counts)}`,
    `- Response item types: ${JSON.stringify(summary.responseCounts)}`,
    `- Top tools: ${JSON.stringify(Object.fromEntries(topTools))}`,
    `- Top command heads: ${JSON.stringify(Object.fromEntries(topCommands))}`,
    "",
    "### Evidence Claims",
    "",
    ...claims.map((claim) => `- [evidence:${claim.id}] ${claim.claim}`),
    "",
  ].join("\n");
}

function qualityGapsMarkdown(summary: SessionForensicsSummary, claims: EvidenceClaim[]): string {
  const signals = [
    ...summary.productSignals,
    ...summary.workflowWaste,
    ...summary.blockers,
    ...summary.userCorrections,
  ].slice(0, 24);
  if (!signals.length) {
    return [
      `## Imported Session Quality Gaps - ${new Date().toISOString()}`,
      "",
      "- [x] No imported quality gaps were detected by the allowlist parser.",
      "",
    ].join("\n");
  }
  const claimByMessage = new Map(claims.map((claim) => [claim.claim, claim.id]));
  return [
    `## Imported Session Quality Gaps - ${new Date().toISOString()}`,
    "",
    ...signals.map((signal) => {
      const claim = `Claim from ${signal.kind}: ${signal.message}`;
      const claimId =
        claimByMessage.get(`${signal.kind}: ${signal.message}`) ||
        claimByMessage.get(claim) ||
        "missing";
      return `- [ ] ${signal.kind}: ${signal.message} [evidence:${claimId}]`;
    }),
    "",
  ].join("\n");
}

async function appendMarkdown(filePath: string, text: string) {
  const existing = await fsp.readFile(filePath, "utf8").catch(() => "");
  const prefix = existing.trim() ? "\n\n" : "";
  await fsp.writeFile(filePath, `${existing}${prefix}${text}`);
}

async function appendJsonl(filePath: string, value: unknown) {
  await fsp.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

function topEntries(values: Record<string, number>, limit: number): [string, number][] {
  return Object.entries(values)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
}

function dedupeClaims(claims: EvidenceClaim[]): EvidenceClaim[] {
  const seen = new Set<string>();
  const out = [];
  for (const claim of claims) {
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    out.push(claim);
  }
  return out;
}
