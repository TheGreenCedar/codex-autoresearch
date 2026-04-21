import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseQualityGaps, researchDirPath, researchSlugFromArgs } from "./session-core.mjs";

export async function gapCandidates(args) {
  const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
  const slug = researchSlugFromArgs(args);
  const researchDir = researchDirPath(workDir, slug);
  const candidates = [
    ...await candidatesFromSynthesis(researchDir),
    ...await candidatesFromModelCommand(args.model_command || args.modelCommand, researchDir),
  ];
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
  let qualityGap = existingText ? parseQualityGaps(existingText) : { open: 0, closed: 0, total: 0 };
  if (args.apply) {
    await appendCandidates(gapsPath, deduped);
    applied = true;
    qualityGap = parseQualityGaps(await readIfExists(gapsPath));
  }

  return {
    ok: true,
    workDir,
    slug,
    researchDir,
    candidates: deduped,
    applied,
    qualityGap,
    warnings: deduped.some((candidate) => !candidate.source)
      ? ["Some candidates have no source reference."]
      : [],
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
      origin: "synthesis",
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

async function candidatesFromModelCommand(command, cwd) {
  if (!command) return [];
  const result = await runShell(command, cwd);
  if (result.code !== 0) throw new Error(`model-command failed: ${result.stderr || result.stdout}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`model-command must print a JSON array of candidates: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("model-command must print a JSON array of candidates.");
  return parsed.map((candidate) => ({ ...candidate, origin: candidate.origin || "model-command" }));
}

async function runShell(command, cwd) {
  return await new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error.message || error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function validateCandidate(candidate) {
  const text = String(candidate.text || candidate.title || "").trim();
  if (!text) throw new Error("Gap candidate is missing text.");
  return {
    text,
    source: String(candidate.source || ""),
    confidence: String(candidate.confidence || "medium"),
    impact: String(candidate.impact || "medium"),
    validationHint: String(candidate.validationHint || candidate.validation_hint || "Add evidence before closing this gap."),
    origin: String(candidate.origin || "manual"),
  };
}

async function appendCandidates(gapsPath, candidates) {
  const existing = stripGeneratedCandidateSection(await readIfExists(gapsPath)).trimEnd();
  const lines = [];
  if (existing) lines.push(existing, "");
  if (candidates.length) {
    lines.push(
      "## Candidate Gaps",
      "<!-- codex-autoresearch:generated-candidates -->",
      "",
      ...candidates.map((candidate) => `- [ ] ${candidate.text} (source: ${candidate.source || "unknown"}; confidence: ${candidate.confidence}; impact: ${candidate.impact}; validation: ${candidate.validationHint})`),
      "",
      "<!-- /codex-autoresearch:generated-candidates -->",
      "",
    );
  }
  await fsp.mkdir(path.dirname(gapsPath), { recursive: true });
  const content = lines.join("\n").trimEnd();
  await fsp.writeFile(gapsPath, content ? `${content}\n` : "", "utf8");
}

function stripGeneratedCandidateSection(text) {
  const start = "<!-- codex-autoresearch:generated-candidates -->";
  const end = "<!-- /codex-autoresearch:generated-candidates -->";
  if (text.includes(start) && text.includes(end)) {
    return text.replace(new RegExp(`\\n?## Candidate Gaps\\n${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`, "g"), "\n");
  }
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
  return String(text || "")
    .replace(/^\s*-\s*\[[ xX]\]\s*/, "")
    .replace(/\s*\(source:.*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
