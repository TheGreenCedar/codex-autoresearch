import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { runShell as runBoundedShell } from "./runner.js";
import { safeSlug } from "./session-core.js";
import { resolveSessionPaths } from "./session-paths.js";
import {
  checkedAppendFile,
  checkedAtomicWriteFile,
  checkedEnsureDirectory,
} from "./checked-write.js";
import { resolveSafeResearchPath } from "./research-path-guard.js";

const MAX_MODEL_CANDIDATES = 100;
const MAX_CANDIDATE_TEXT_LENGTH = 1000;
export const QUALITY_GAP_DECISIONS_FILE = "quality-gap-decisions.jsonl";
const GAP_ID_MARKER = /<!--\s*codex-autoresearch:gap-id=(gap-[a-f0-9]{12})\s*-->/i;
const RESEARCH_READINESS_ITEMS = new Set(
  [
    "Project essence is accurate and source-backed.",
    "Sources are logged with dates, claims, and confidence.",
    "Synthesis separates high-impact changes from small QoL fixes.",
    "Each high-impact recommendation is implemented or rejected with evidence.",
    "Correctness checks pass after kept changes.",
    "Final handoff includes dashboard or state evidence.",
  ].map(normalizeGapIdentity),
);
type LooseObject = Record<string, any>;
type GapCandidate = {
  id: string;
  text: string;
  source: string;
  confidence: string;
  impact: string;
  validationHint: string;
  origin: string;
};
type SlugCandidate = {
  slug: string;
  researchDir: string;
  qualityGapsPath: string;
  decisionsPath: string;
};
export type QualityGapDecisionKind = "implemented" | "rejected";
export interface QualityGapDecision {
  schemaVersion: 1;
  gapId: string;
  decision: QualityGapDecisionKind;
  evidence: string;
  validation: string;
  at?: string;
}
export interface QualityGapSummary {
  open: number | null;
  closed: number;
  total: number;
  openItems: string[];
  closedItems: string[];
  gaps: Array<{
    id: string;
    text: string;
    checked: boolean;
    status: "open" | "legacy-provisional" | "decided";
    decision: QualityGapDecision | null;
  }>;
  legacyProvisionalClosed: string[];
  decisionIssues: string[];
  researchReadiness: {
    open: number;
    closed: number;
    total: number;
    openItems: string[];
    closedItems: string[];
  };
  roundDecision: {
    accepted: boolean;
    status: "needs-candidates" | "needs-evidence" | "accepted";
    reason: string;
  };
}

export async function gapCandidates(args: LooseObject) {
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const slugResolution = resolveResearchSlugForQualityGapSync(args, workDir);
  const slug = slugResolution.slug;
  const researchDir = (await resolveSafeResearchPath(workDir, slug)).outputDir;
  const modelTimeoutSeconds = numberOption(
    args.model_timeout_seconds ?? args.modelTimeoutSeconds,
    60,
  );
  const candidates = [
    ...(await candidatesFromSynthesis(researchDir)),
    ...(await candidatesFromModelCommand(
      args.model_command || args.modelCommand,
      researchDir,
      modelTimeoutSeconds,
    )),
  ];
  const gapsPath = path.join(researchDir, "quality-gaps.md");
  const decisionsText = await readIfExists(path.join(researchDir, QUALITY_GAP_DECISIONS_FILE));
  const existingText = await readIfExists(gapsPath);
  const manualExistingText = stripGeneratedCandidateSection(existingText);
  const existing = new Set(
    manualExistingText.split(/\r?\n/).map(normalizeCandidateText).filter(Boolean),
  );
  const deduped = [];
  const seen = new Set(existing);
  for (const candidate of candidates.map(validateCandidate)) {
    const key = normalizeCandidateText(candidate.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  let applied = false;
  let qualityGap = summarizeQualityGaps(existingText, decisionsText);
  if (args.apply) {
    await appendCandidates(workDir, gapsPath, deduped);
    applied = true;
    qualityGap = summarizeQualityGaps(await readIfExists(gapsPath), decisionsText);
  }

  const stopStatus = candidateStopStatus({
    candidates: deduped,
    qualityGap,
    applied: Boolean(args.apply),
  });

  return {
    ok: true,
    workDir,
    slug,
    slugInferred: slugResolution.inferred,
    slugCandidates: slugResolution.candidates,
    researchDir,
    candidates: deduped,
    applied,
    qualityGap,
    stopRecommended: stopStatus.recommended,
    stopStatus,
    roundGuidance: researchRoundGuidance(),
    warnings: deduped.some((candidate) => !candidate.source)
      ? ["Some candidates have no source reference."]
      : [],
  };
}

export function resolveResearchSlugForQualityGapSync(
  args: LooseObject = {},
  workDir = process.cwd(),
) {
  const requestedSlug = args.research_slug ?? args.researchSlug ?? args.slug ?? args.name;
  if (requestedSlug != null && requestedSlug !== "") {
    return {
      slug: safeSlug(requestedSlug),
      inferred: false,
      candidates: [],
    };
  }

  const candidates = activeQualityGapSlugCandidatesSync(workDir);
  if (candidates.length === 1) {
    return {
      slug: candidates[0].slug,
      inferred: true,
      candidates,
    };
  }
  if (candidates.length > 1) {
    const slugs = candidates.map((candidate) => candidate.slug);
    const error = new Error(
      `Ambiguous research slug inference for ${path.resolve(workDir)}; pass research_slug explicitly. Candidates: ${slugs.join(", ")}`,
    ) as Error & { candidates?: unknown[]; code?: string };
    error.code = "ambiguous_research_slug";
    error.candidates = candidates;
    throw error;
  }

  const error = new Error(
    "No research slug was provided and no active quality-gaps.md file was found under autoresearch.research/.",
  ) as Error & { candidates?: unknown[]; code?: string };
  error.code = "missing_research_slug";
  error.candidates = [];
  throw error;
}

export function activeQualityGapSlugCandidatesSync(workDir = process.cwd()): SlugCandidate[] {
  const researchRoot = resolveSessionPaths({ workDir: path.resolve(workDir) }).researchRoot;
  if (!fs.existsSync(researchRoot)) return [];
  return fs
    .readdirSync(researchRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const slug = entry.name;
      const researchDir = path.join(researchRoot, slug);
      return {
        slug,
        researchDir,
        qualityGapsPath: path.join(researchDir, "quality-gaps.md"),
        decisionsPath: path.join(researchDir, QUALITY_GAP_DECISIONS_FILE),
      };
    })
    .filter((candidate) => fs.existsSync(candidate.qualityGapsPath))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function researchRoundGuidance() {
  return {
    unit: "research-round",
    metricScope:
      "quality_gap counts outcome candidates in quality-gaps.md; research-readiness checks are reported separately, raw checked boxes remain provisional, and the metric does not discover fresh recommendations by itself.",
    requiredRefresh:
      "Before declaring completion or starting another implementation round, rerun the project-study prompt, update sources.md and synthesis.md, then preview gap-candidates.",
    hallucinationFilter: [
      "Keep candidates only when they are grounded in repo evidence, primary sources, direct measurements, or explicitly dated external sources.",
      "Reject candidates that describe unavailable APIs, duplicate existing behavior, or cannot name a validation path.",
      "Keep small QoL and bug-fix ideas separate unless they materially advance the round goal.",
    ],
    stopRule:
      "Stop only after a fresh research round yields no credible high-impact candidates, every candidate has an evidence-bearing implemented/rejected decision, and checks pass.",
  };
}

export async function currentQualityGapSummary(workDir: string) {
  const candidate = activeQualityGapSlugCandidatesSync(workDir)[0];
  if (!candidate) return null;
  const text = await readIfExists(candidate.qualityGapsPath);
  const decisionsText = await readIfExists(candidate.decisionsPath);
  const summary = summarizeQualityGaps(text, decisionsText);
  return {
    slug: candidate.slug,
    path: candidate.qualityGapsPath,
    decisionsPath: candidate.decisionsPath,
    ...summary,
    roundGuidance: researchRoundGuidance(),
  };
}

export function qualityGapId(value: unknown): string {
  const normalized = normalizeGapIdentity(value);
  return `gap-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12)}`;
}

export function validateQualityGapDecision(value: unknown): QualityGapDecision {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const gapId = printableText(String((record as LooseObject).gapId || "")).trim();
  const decision = String((record as LooseObject).decision || "").toLowerCase();
  const evidence = printableText(String((record as LooseObject).evidence || "")).trim();
  const validation = printableText(
    String(
      (record as LooseObject).validation ||
        (record as LooseObject).validationResult ||
        (record as LooseObject).validationHint ||
        "",
    ),
  ).trim();
  if (!/^gap-[a-f0-9]{12}$/.test(gapId)) {
    throw new Error("Gap decision requires a stable gapId from quality-gaps.md.");
  }
  if (decision !== "implemented" && decision !== "rejected") {
    throw new Error("Gap decision must be 'implemented' or 'rejected'.");
  }
  if (!evidence) throw new Error("Gap decision requires a non-empty evidence reference.");
  if (!validation) throw new Error("Gap decision requires a validation hint or result.");
  const at = printableText(String((record as LooseObject).at || "")).trim();
  return {
    schemaVersion: 1,
    gapId,
    decision,
    evidence,
    validation,
    ...(at ? { at } : {}),
  };
}

export async function recordQualityGapDecision(args: LooseObject): Promise<LooseObject> {
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const slugResolution = resolveResearchSlugForQualityGapSync(args, workDir);
  const slug = slugResolution.slug;
  const researchDir = (await resolveSafeResearchPath(workDir, slug)).outputDir;
  const qualityGapsPath = path.join(researchDir, "quality-gaps.md");
  const decisionsPath = path.join(researchDir, QUALITY_GAP_DECISIONS_FILE);
  const markdown = await readIfExists(qualityGapsPath);
  if (!markdown.trim()) {
    throw new Error(`No quality-gaps.md found for research slug '${slug}'.`);
  }
  const decision = validateQualityGapDecision({
    ...args,
    gapId: args.gap_id ?? args.gapId,
    validation:
      args.validation ??
      args.validation_result ??
      args.validationResult ??
      args.validation_hint ??
      args.validationHint,
    at: args.at || new Date().toISOString(),
  });
  const before = summarizeQualityGaps(markdown, await readIfExists(decisionsPath));
  const gap = before.gaps.find((candidate) => candidate.id === decision.gapId);
  if (!gap) {
    const error = new Error(
      `Gap decision references unknown gap '${decision.gapId}' in ${qualityGapsPath}.`,
    ) as Error & { code?: string; knownGapIds?: string[] };
    error.code = "unknown_quality_gap";
    error.knownGapIds = before.gaps.map((candidate) => candidate.id);
    throw error;
  }
  await checkedAppendFile(workDir, decisionsPath, `${JSON.stringify(decision)}\n`);
  const summary = summarizeQualityGaps(markdown, await readIfExists(decisionsPath));
  return {
    ok: true,
    workDir,
    slug,
    slugInferred: slugResolution.inferred,
    researchDir,
    qualityGapsPath,
    decisionsPath,
    gap: { id: gap.id, text: gap.text },
    decision,
    qualityGap: summary,
  };
}

export function summarizeQualityGaps(markdown: string, decisionsJsonl = ""): QualityGapSummary {
  const parsedDecisions = parseQualityGapDecisions(decisionsJsonl);
  const decisionsByGap = new Map<string, QualityGapDecision>();
  for (const decision of parsedDecisions.decisions) decisionsByGap.set(decision.gapId, decision);

  const readinessOpen: string[] = [];
  const readinessClosed: string[] = [];
  const productGaps: QualityGapSummary["gaps"] = [];
  let inCandidateSection = false;
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      inCandidateSection = /^candidate gaps$/i.test(heading[1].trim());
      continue;
    }
    const match = line.match(/^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/);
    if (!match) continue;
    const checked = match[1].toLowerCase() === "x";
    const rawText = match[2].trim();
    const text = displayGapText(rawText);
    const readiness =
      !inCandidateSection && RESEARCH_READINESS_ITEMS.has(normalizeGapIdentity(text));
    if (readiness) {
      (checked ? readinessClosed : readinessOpen).push(text);
      continue;
    }
    const id = rawText.match(GAP_ID_MARKER)?.[1]?.toLowerCase() || qualityGapId(text);
    const decision = decisionsByGap.get(id) || null;
    productGaps.push({
      id,
      text,
      checked,
      status: decision ? "decided" : checked ? "legacy-provisional" : "open",
      decision,
    });
  }

  const knownGapIds = new Set(productGaps.map((gap) => gap.id));
  const unknownDecisionIssues = parsedDecisions.decisions
    .filter((decision) => !knownGapIds.has(decision.gapId))
    .map((decision) => `Decision references unknown gap '${decision.gapId}'.`);
  const openGaps = productGaps.filter((gap) => !gap.decision);
  const closedGaps = productGaps.filter((gap) => gap.decision);
  const legacyProvisionalClosed = openGaps.filter((gap) => gap.checked).map((gap) => gap.text);
  const decisionIssues = [...parsedDecisions.issues, ...unknownDecisionIssues];
  const accepted = productGaps.length > 0 && openGaps.length === 0 && decisionIssues.length === 0;
  const status = accepted
    ? "accepted"
    : productGaps.length === 0
      ? "needs-candidates"
      : "needs-evidence";
  const reason = accepted
    ? "Every outcome candidate has an evidence-bearing implemented/rejected decision."
    : decisionIssues[0] ||
      (productGaps.length === 0
        ? "No outcome candidates are recorded; research-readiness checks cannot close the round."
        : `${openGaps.length} outcome candidate${openGaps.length === 1 ? " needs" : "s need"} an evidence-bearing decision.`);
  return {
    open: productGaps.length === 0 ? null : openGaps.length,
    closed: closedGaps.length,
    total: productGaps.length,
    openItems: openGaps.map((gap) => gap.text),
    closedItems: closedGaps.map((gap) => gap.text),
    gaps: productGaps,
    legacyProvisionalClosed,
    decisionIssues,
    researchReadiness: {
      open: readinessOpen.length,
      closed: readinessClosed.length,
      total: readinessOpen.length + readinessClosed.length,
      openItems: readinessOpen,
      closedItems: readinessClosed,
    },
    roundDecision: { accepted, status, reason },
  };
}

function parseQualityGapDecisions(text: string): {
  decisions: QualityGapDecision[];
  issues: string[];
} {
  const decisions: QualityGapDecision[] = [];
  const issues: string[] = [];
  for (const [index, line] of String(text || "")
    .split(/\r?\n/)
    .entries()) {
    if (!line.trim()) continue;
    try {
      decisions.push(validateQualityGapDecision(JSON.parse(line)));
    } catch (error) {
      issues.push(
        `Decision line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { decisions, issues };
}

async function candidatesFromSynthesis(researchDir: string): Promise<LooseObject[]> {
  const text = await readIfExists(path.join(researchDir, "synthesis.md"));
  if (!text.trim()) return [];
  const fenced = parseFencedCandidates(text);
  if (fenced.length) return fenced;
  const lines = text.split(/\r?\n/);
  const out: LooseObject[] = [];
  let activeHeading = "";
  for (const raw of lines) {
    const heading = raw.match(/^#{2,3}\s+(.+)/);
    if (heading) {
      activeHeading = heading[1].toLowerCase();
      continue;
    }
    const bullet = raw.match(/^\s*-\s+(?!TBD\b)(.+)/i);
    if (!bullet) continue;
    if (!/high-impact|recommend|quality-gap|gap|finding/.test(activeHeading)) continue;
    const text = bullet[1].replace(/\.$/, "").trim();
    if (text.length < 8) continue;
    out.push({
      text,
      source: "synthesis.md",
      confidence: "medium",
      impact: /high-impact|recommend/.test(activeHeading) ? "high" : "medium",
      validationHint:
        "Convert this finding into an acceptance check or explicit rejection evidence.",
      origin: "synthesis",
    });
  }
  return out;
}

function parseFencedCandidates(text: string): LooseObject[] {
  const match = text.match(/```(?:autoresearch-gap-candidates|json)\s*([\s\S]*?)```/i);
  if (!match) return [];
  const parsed = JSON.parse(match[1]);
  if (!Array.isArray(parsed))
    throw new Error("Gap candidate fenced block must contain a JSON array.");
  return parsed;
}

async function candidatesFromModelCommand(
  command: string | undefined,
  cwd: string,
  timeoutSeconds: number,
): Promise<LooseObject[]> {
  if (!command) return [];
  const result = await runBoundedShell(command, cwd, timeoutSeconds);
  if (result.exitCode !== 0 || result.timedOut) {
    const pid = result.termination?.pid;
    const error = new Error(
      result.terminationFailed
        ? `model-command failed (timed out): process-tree termination is unproven for PID ${pid || "unknown"}. Verify the reported PID and descendants are absent before removing the retained progress marker. Output: ${result.output}`
        : `model-command failed${result.timedOut ? " (timed out)" : ""}: ${result.output}`,
    ) as Error & { code?: string; termination?: unknown; terminationFailed?: boolean };
    if (result.terminationFailed) {
      error.code = "termination_failed";
      error.termination = result.termination;
      error.terminationFailed = true;
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`model-command must print a JSON array of candidates: ${message}`);
  }
  if (!Array.isArray(parsed))
    throw new Error("model-command must print a JSON array of candidates.");
  if (parsed.length > MAX_MODEL_CANDIDATES)
    throw new Error(
      `model-command returned ${parsed.length} candidates; limit is ${MAX_MODEL_CANDIDATES}.`,
    );
  return parsed.map((candidate) => ({ ...candidate, origin: candidate.origin || "model-command" }));
}

function numberOption(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function validateCandidate(candidate: LooseObject): GapCandidate {
  const text = String(candidate.text || candidate.title || "").trim();
  if (!text) throw new Error("Gap candidate is missing text.");
  if (text.length > MAX_CANDIDATE_TEXT_LENGTH)
    throw new Error(`Gap candidate text exceeds ${MAX_CANDIDATE_TEXT_LENGTH} characters.`);
  return {
    id: qualityGapId(text),
    text: printableText(text),
    source: printableText(String(candidate.source || "")).slice(0, 300),
    confidence: String(candidate.confidence || "medium"),
    impact: String(candidate.impact || "medium"),
    validationHint: printableText(
      String(
        candidate.validationHint ||
          candidate.validation_hint ||
          "Add evidence before closing this gap.",
      ),
    ).slice(0, 700),
    origin: String(candidate.origin || "manual"),
  };
}

function printableText(value: unknown): string {
  return Array.from(String(value || ""), (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "" : char;
  }).join("");
}

async function appendCandidates(
  root: string,
  gapsPath: string,
  candidates: GapCandidate[],
): Promise<void> {
  const existing = stripGeneratedCandidateSection(await readIfExists(gapsPath)).trimEnd();
  const lines: string[] = [];
  if (existing) lines.push(existing, "");
  if (candidates.length) {
    lines.push(
      "## Candidate Gaps",
      "<!-- codex-autoresearch:generated-candidates -->",
      "",
      ...candidates.map(
        (candidate) =>
          `- [ ] ${candidate.text} (source: ${candidate.source || "unknown"}; confidence: ${candidate.confidence}; impact: ${candidate.impact}; validation: ${candidate.validationHint}) <!-- codex-autoresearch:gap-id=${candidate.id} -->`,
      ),
      "",
      "<!-- /codex-autoresearch:generated-candidates -->",
      "",
    );
  }
  await checkedEnsureDirectory(root, path.dirname(gapsPath));
  const content = lines.join("\n").trimEnd();
  await checkedAtomicWriteFile(root, gapsPath, content ? `${content}\n` : "");
}

function stripGeneratedCandidateSection(text: string): string {
  const start = "<!-- codex-autoresearch:generated-candidates -->";
  const end = "<!-- /codex-autoresearch:generated-candidates -->";
  if (text.includes(start) && text.includes(end)) {
    return text.replace(
      new RegExp(
        `\\n?## Candidate Gaps\\n${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`,
        "g",
      ),
      "\n",
    );
  }
  const legacy = text.match(/\n## Candidate Gaps\n[\s\S]*$/);
  if (legacy) return text.slice(0, legacy.index).trimEnd() + "\n";
  return text;
}

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function normalizeCandidateText(text: string): string {
  return String(text || "")
    .replace(/^\s*-\s*\[[ xX]\]\s*/, "")
    .replace(GAP_ID_MARKER, "")
    .replace(/(?:[.;]\s+|\s+-\s+)Evidence:\s+.*$/i, "")
    .replace(/\s*\(source:.*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function candidateStopStatus({
  candidates,
  qualityGap,
  applied,
}: {
  candidates: GapCandidate[];
  qualityGap: QualityGapSummary;
  applied: boolean;
}) {
  const candidateCount = Array.isArray(candidates) ? candidates.length : 0;
  const open = qualityGap?.open == null ? 0 : Number(qualityGap.open);
  const total = Number(qualityGap?.total ?? 0);
  const researchExhausted =
    candidateCount === 0 && open === 0 && total > 0 && qualityGap.roundDecision.accepted === true;
  let reason = "No accepted quality-gap checklist exists yet.";
  if (candidateCount > 0) {
    reason = `${candidateCount} candidate${candidateCount === 1 ? "" : "s"} survived filtering.`;
  } else if (open > 0) {
    reason = `${open} accepted gap${open === 1 ? "" : "s"} remain open.`;
  } else if (researchExhausted) {
    reason = "No candidate survived filtering and no accepted quality gaps are open.";
  }
  return {
    mode: applied ? "apply" : "preview",
    recommended: researchExhausted,
    researchExhausted,
    requiresPassingChecks: true,
    checksKnown: false,
    reason,
  };
}

function displayGapText(value: string): string {
  return String(value || "")
    .replace(GAP_ID_MARKER, "")
    .replace(/\s*\(source:.*?;\s*confidence:.*?;\s*impact:.*?;\s*validation:.*?\)\s*$/i, "")
    .trim();
}

function normalizeGapIdentity(value: unknown): string {
  return String(value || "")
    .replace(GAP_ID_MARKER, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
