import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveSafeResearchPath } from "./research-path-guard.js";

export interface EvidenceIndex {
  schemaVersion: 1;
  claims: EvidenceClaim[];
}

export interface EvidenceClaim {
  id: string;
  claim: string;
  source: string;
  evidenceType: "session" | "benchmark-artifact" | "commit" | "doc" | "test" | "manual-report";
  freshness: "current" | "historical" | "stale" | "unknown";
  confidence: "low" | "medium" | "high";
  promotionRelevance: "none" | "diagnostic" | "setup-gate" | "promotion-gate";
  validatedBy?: string;
}

export interface EvidenceClaimSummary {
  id: string;
  claim: string;
  evidenceType: EvidenceClaim["evidenceType"];
  confidence: EvidenceClaim["confidence"];
  promotionRelevance: EvidenceClaim["promotionRelevance"];
}

export function claimIdFor(input: { claim: string; source: string }): string {
  const normalized = `${normalize(input.claim)}\n${normalize(input.source)}`;
  return `ev-${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

export async function readEvidenceIndex(cwd: string, slug: string): Promise<EvidenceIndex> {
  const { outputDir } = await resolveSafeResearchPath(cwd, slug);
  const filePath = path.join(outputDir, "evidence-index.json");
  try {
    return normalizeEvidenceIndex(JSON.parse(await fsp.readFile(filePath, "utf8")));
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyEvidenceIndex();
    throw new Error(`Invalid evidence-index.json: ${error.message || error}`);
  }
}

export async function mergeEvidenceClaims(
  cwd: string,
  slug: string,
  claims: EvidenceClaim[],
): Promise<EvidenceIndex> {
  const { outputDir } = await resolveSafeResearchPath(cwd, slug);
  const current = await readEvidenceIndex(cwd, slug);
  const byId = new Map(current.claims.map((claim) => [claim.id, claim]));
  for (const claim of claims.map(normalizeEvidenceClaim)) {
    const existing = byId.get(claim.id);
    if (existing && !sameClaimIdentity(existing, claim)) {
      throw new Error(`Evidence claim id collision for ${claim.id}`);
    }
    byId.set(claim.id, existing ? mergeClaim(existing, claim) : claim);
  }
  const index = normalizeEvidenceIndex({
    schemaVersion: 1,
    claims: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
  });
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(
    path.join(outputDir, "evidence-index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  return index;
}

export function validateClaimReferences(markdown: string, index: EvidenceIndex): string[] {
  const known = new Set(index.claims.map((claim) => claim.id));
  const missing = new Set<string>();
  const pattern = /\[evidence:([a-z0-9-]+)\]|\bevidence:([a-z0-9-]+)\b/g;
  for (const match of String(markdown || "").matchAll(pattern)) {
    const id = match[1] || match[2];
    if (id && !known.has(id)) missing.add(id);
  }
  return [...missing].sort();
}

export function compactEvidenceSummaries(index: EvidenceIndex): EvidenceClaimSummary[] {
  return normalizeEvidenceIndex(index).claims.map((claim) => ({
    id: claim.id,
    claim: claim.claim,
    evidenceType: claim.evidenceType,
    confidence: claim.confidence,
    promotionRelevance: claim.promotionRelevance,
  }));
}

export function evidenceClaim(input: Omit<EvidenceClaim, "id"> & { id?: string }): EvidenceClaim {
  return normalizeEvidenceClaim({
    ...input,
    id: input.id || claimIdFor({ claim: input.claim, source: input.source }),
  });
}

function emptyEvidenceIndex(): EvidenceIndex {
  return { schemaVersion: 1, claims: [] };
}

function normalizeEvidenceIndex(value: any): EvidenceIndex {
  if (!value || typeof value !== "object") return emptyEvidenceIndex();
  if (value.schemaVersion !== 1) {
    if (value.claims == null) return emptyEvidenceIndex();
    throw new Error(`unsupported schema version ${value.schemaVersion}`);
  }
  const claims = Array.isArray(value.claims) ? value.claims.map(normalizeEvidenceClaim) : [];
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.id)) throw new Error(`duplicate evidence claim id ${claim.id}`);
    seen.add(claim.id);
  }
  return { schemaVersion: 1, claims };
}

function normalizeEvidenceClaim(value: any): EvidenceClaim {
  const claim = String(value?.claim || "").trim();
  const source = String(value?.source || "").trim();
  if (!claim) throw new Error("evidence claim is required");
  if (!source) throw new Error("evidence source is required");
  const id = String(value?.id || claimIdFor({ claim, source })).trim();
  if (!/^ev-[a-f0-9]{12}$/.test(id)) throw new Error(`invalid evidence claim id: ${id}`);
  return {
    id,
    claim,
    source,
    evidenceType: enumValue(value.evidenceType, [
      "session",
      "benchmark-artifact",
      "commit",
      "doc",
      "test",
      "manual-report",
    ]),
    freshness: enumValue(value.freshness, ["current", "historical", "stale", "unknown"]),
    confidence: enumValue(value.confidence, ["low", "medium", "high"]),
    promotionRelevance: enumValue(value.promotionRelevance, [
      "none",
      "diagnostic",
      "setup-gate",
      "promotion-gate",
    ]),
    ...(value.validatedBy ? { validatedBy: String(value.validatedBy) } : {}),
  };
}

function mergeClaim(existing: EvidenceClaim, next: EvidenceClaim): EvidenceClaim {
  return {
    ...existing,
    ...next,
    confidence: maxConfidence(existing.confidence, next.confidence),
    promotionRelevance: maxPromotionRelevance(existing.promotionRelevance, next.promotionRelevance),
  };
}

function sameClaimIdentity(left: EvidenceClaim, right: EvidenceClaim): boolean {
  return (
    normalize(left.claim) === normalize(right.claim) &&
    normalize(left.source) === normalize(right.source)
  );
}

function normalize(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function enumValue<T extends string>(value: unknown, allowed: T[]): T {
  return allowed.includes(value as T) ? (value as T) : allowed[0];
}

function maxConfidence(left: EvidenceClaim["confidence"], right: EvidenceClaim["confidence"]) {
  const order = ["low", "medium", "high"];
  return order.indexOf(right) > order.indexOf(left) ? right : left;
}

function maxPromotionRelevance(
  left: EvidenceClaim["promotionRelevance"],
  right: EvidenceClaim["promotionRelevance"],
) {
  const order = ["none", "diagnostic", "setup-gate", "promotion-gate"];
  return order.indexOf(right) > order.indexOf(left) ? right : left;
}
