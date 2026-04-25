import { runShell } from "./runner.mjs";
import { RESEARCH_DIR, parseQualityGaps, researchDirPath, safeSlug } from "./session-core.mjs";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
//#region lib/research-gaps.ts
const MAX_MODEL_CANDIDATES = 100;
const MAX_CANDIDATE_TEXT_LENGTH = 1e3;
async function gapCandidates(args) {
	const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
	const slugResolution = resolveResearchSlugForQualityGapSync(args, workDir);
	const slug = slugResolution.slug;
	const researchDir = researchDirPath(workDir, slug);
	const modelTimeoutSeconds = numberOption(args.model_timeout_seconds ?? args.modelTimeoutSeconds, 60);
	const candidates = [...await candidatesFromSynthesis(researchDir), ...await candidatesFromModelCommand(args.model_command || args.modelCommand, researchDir, modelTimeoutSeconds)];
	const gapsPath = path.join(researchDir, "quality-gaps.md");
	const existingText = await readIfExists(gapsPath);
	const manualExistingText = stripGeneratedCandidateSection(existingText);
	const existing = new Set(manualExistingText.split(/\r?\n/).map(normalizeCandidateText).filter(Boolean));
	const deduped = [];
	const seen = new Set(existing);
	for (const candidate of candidates.map(validateCandidate)) {
		const key = normalizeCandidateText(candidate.text);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		deduped.push(candidate);
	}
	let applied = false;
	let qualityGap = existingText ? parseQualityGaps(existingText) : {
		open: 0,
		closed: 0,
		total: 0
	};
	if (args.apply) {
		await appendCandidates(gapsPath, deduped);
		applied = true;
		qualityGap = parseQualityGaps(await readIfExists(gapsPath));
	}
	const stopStatus = candidateStopStatus({
		candidates: deduped,
		qualityGap,
		applied: Boolean(args.apply)
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
		warnings: deduped.some((candidate) => !candidate.source) ? ["Some candidates have no source reference."] : []
	};
}
function resolveResearchSlugForQualityGapSync(args = {}, workDir = process.cwd()) {
	const requestedSlug = args.research_slug ?? args.researchSlug ?? args.slug ?? args.name;
	if (requestedSlug != null && requestedSlug !== "") return {
		slug: safeSlug(requestedSlug),
		inferred: false,
		candidates: []
	};
	const candidates = activeQualityGapSlugCandidatesSync(workDir);
	if (candidates.length === 1) return {
		slug: candidates[0].slug,
		inferred: true,
		candidates
	};
	if (candidates.length > 1) {
		const slugs = candidates.map((candidate) => candidate.slug);
		const error = /* @__PURE__ */ new Error(`Ambiguous research slug inference for ${path.resolve(workDir)}; pass research_slug explicitly. Candidates: ${slugs.join(", ")}`);
		error.code = "ambiguous_research_slug";
		error.candidates = candidates;
		throw error;
	}
	const error = /* @__PURE__ */ new Error("No research slug was provided and no active quality-gaps.md file was found under autoresearch.research/.");
	error.code = "missing_research_slug";
	error.candidates = [];
	throw error;
}
function activeQualityGapSlugCandidatesSync(workDir = process.cwd()) {
	const researchRoot = path.join(path.resolve(workDir), RESEARCH_DIR);
	if (!fs.existsSync(researchRoot)) return [];
	return fs.readdirSync(researchRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
		const slug = entry.name;
		const researchDir = path.join(researchRoot, slug);
		return {
			slug,
			researchDir,
			qualityGapsPath: path.join(researchDir, "quality-gaps.md")
		};
	}).filter((candidate) => fs.existsSync(candidate.qualityGapsPath)).sort((a, b) => a.slug.localeCompare(b.slug));
}
function researchRoundGuidance() {
	return {
		unit: "research-round",
		metricScope: "quality_gap counts accepted checklist gaps in quality-gaps.md; it does not discover fresh recommendations by itself.",
		requiredRefresh: "Before declaring completion or starting another implementation round, rerun the project-study prompt, update sources.md and synthesis.md, then preview gap-candidates.",
		hallucinationFilter: [
			"Keep candidates only when they are grounded in repo evidence, primary sources, direct measurements, or explicitly dated external sources.",
			"Reject candidates that describe unavailable APIs, duplicate existing behavior, or cannot name a validation path.",
			"Keep small QoL and bug-fix ideas separate unless they materially advance the round goal."
		],
		stopRule: "Stop only after a fresh research round yields no credible high-impact candidates, all accepted gaps are closed or explicitly rejected, and checks pass."
	};
}
async function candidatesFromSynthesis(researchDir) {
	const text = await readIfExists(path.join(researchDir, "synthesis.md"));
	if (!text.trim()) return [];
	const fenced = parseFencedCandidates(text);
	if (fenced.length) return fenced;
	const lines = text.split(/\r?\n/);
	const out = [];
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
			validationHint: "Convert this finding into an acceptance check or explicit rejection evidence.",
			origin: "synthesis"
		});
	}
	return out;
}
function parseFencedCandidates(text) {
	const match = text.match(/```(?:autoresearch-gap-candidates|json)\s*([\s\S]*?)```/i);
	if (!match) return [];
	const parsed = JSON.parse(match[1]);
	if (!Array.isArray(parsed)) throw new Error("Gap candidate fenced block must contain a JSON array.");
	return parsed;
}
async function candidatesFromModelCommand(command, cwd, timeoutSeconds) {
	if (!command) return [];
	const result = await runShell(command, cwd, timeoutSeconds);
	if (result.exitCode !== 0 || result.timedOut) throw new Error(`model-command failed${result.timedOut ? " (timed out)" : ""}: ${result.output}`);
	let parsed;
	try {
		parsed = JSON.parse(result.output);
	} catch (error) {
		throw new Error(`model-command must print a JSON array of candidates: ${error.message}`);
	}
	if (!Array.isArray(parsed)) throw new Error("model-command must print a JSON array of candidates.");
	if (parsed.length > MAX_MODEL_CANDIDATES) throw new Error(`model-command returned ${parsed.length} candidates; limit is ${MAX_MODEL_CANDIDATES}.`);
	return parsed.map((candidate) => ({
		...candidate,
		origin: candidate.origin || "model-command"
	}));
}
function numberOption(value, fallback) {
	if (value == null || value === "") return fallback;
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : fallback;
}
function validateCandidate(candidate) {
	const text = String(candidate.text || candidate.title || "").trim();
	if (!text) throw new Error("Gap candidate is missing text.");
	if (text.length > MAX_CANDIDATE_TEXT_LENGTH) throw new Error(`Gap candidate text exceeds ${MAX_CANDIDATE_TEXT_LENGTH} characters.`);
	return {
		text: printableText(text),
		source: printableText(String(candidate.source || "")).slice(0, 300),
		confidence: String(candidate.confidence || "medium"),
		impact: String(candidate.impact || "medium"),
		validationHint: printableText(String(candidate.validationHint || candidate.validation_hint || "Add evidence before closing this gap.")).slice(0, 700),
		origin: String(candidate.origin || "manual")
	};
}
function printableText(value) {
	return Array.from(String(value || ""), (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 ? "" : char;
	}).join("");
}
async function appendCandidates(gapsPath, candidates) {
	const existing = stripGeneratedCandidateSection(await readIfExists(gapsPath)).trimEnd();
	const lines = [];
	if (existing) lines.push(existing, "");
	if (candidates.length) lines.push("## Candidate Gaps", "<!-- codex-autoresearch:generated-candidates -->", "", ...candidates.map((candidate) => `- [ ] ${candidate.text} (source: ${candidate.source || "unknown"}; confidence: ${candidate.confidence}; impact: ${candidate.impact}; validation: ${candidate.validationHint})`), "", "<!-- /codex-autoresearch:generated-candidates -->", "");
	await fsp.mkdir(path.dirname(gapsPath), { recursive: true });
	const content = lines.join("\n").trimEnd();
	await fsp.writeFile(gapsPath, content ? `${content}\n` : "", "utf8");
}
function stripGeneratedCandidateSection(text) {
	const start = "<!-- codex-autoresearch:generated-candidates -->";
	const end = "<!-- /codex-autoresearch:generated-candidates -->";
	if (text.includes(start) && text.includes(end)) return text.replace(new RegExp(`\\n?## Candidate Gaps\\n${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`, "g"), "\n");
	const legacy = text.match(/\n## Candidate Gaps\n[\s\S]*$/);
	if (legacy) return text.slice(0, legacy.index).trimEnd() + "\n";
	return text;
}
function escapeRegex(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function readIfExists(file) {
	try {
		return await fsp.readFile(file, "utf8");
	} catch {
		return "";
	}
}
function normalizeCandidateText(text) {
	return String(text || "").replace(/^\s*-\s*\[[ xX]\]\s*/, "").replace(/(?:[.;]\s+|\s+-\s+)Evidence:\s+.*$/i, "").replace(/\s*\(source:.*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function candidateStopStatus({ candidates, qualityGap, applied }) {
	const candidateCount = Array.isArray(candidates) ? candidates.length : 0;
	const open = Number(qualityGap?.open ?? 0);
	const total = Number(qualityGap?.total ?? 0);
	const researchExhausted = candidateCount === 0 && open === 0 && total > 0;
	let reason = "No accepted quality-gap checklist exists yet.";
	if (candidateCount > 0) reason = `${candidateCount} candidate${candidateCount === 1 ? "" : "s"} survived filtering.`;
	else if (open > 0) reason = `${open} accepted gap${open === 1 ? "" : "s"} remain open.`;
	else if (researchExhausted) reason = "No candidate survived filtering and no accepted quality gaps are open.";
	return {
		mode: applied ? "apply" : "preview",
		recommended: researchExhausted,
		researchExhausted,
		requiresPassingChecks: true,
		checksKnown: false,
		reason
	};
}
//#endregion
export { activeQualityGapSlugCandidatesSync, gapCandidates, researchRoundGuidance, resolveResearchSlugForQualityGapSync };
