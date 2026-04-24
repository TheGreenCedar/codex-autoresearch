#!/usr/bin/env node
import path from "node:path";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
//#region scripts/finalize-autoresearch.ts
function usage() {
	return `Finalize an autoresearch branch into independent review branches.

Usage:
  node scripts/finalize-autoresearch.mjs plan --output groups.json [--goal short-slug] [--trunk main] [--collapse-overlap]
  node scripts/finalize-autoresearch.mjs groups.json

groups.json:
{
  "base": "<full merge-base hash>",
  "trunk": "main",
  "final_tree": "<full source branch HEAD>",
  "goal": "short-slug",
  "groups": [
    {
      "title": "Short commit title",
      "body": "Why and metric details",
      "last_commit": "<full commit hash>",
      "slug": "short-slug"
    }
  ]
}
`;
}
const SESSION_FILES = new Set([
	"autoresearch.jsonl",
	"autoresearch.md",
	"autoresearch.ideas.md",
	"autoresearch.config.json",
	"autoresearch.last-run.json",
	"autoresearch-dashboard.html",
	"autoresearch.sh",
	"autoresearch.ps1",
	"autoresearch.checks.sh",
	"autoresearch.checks.ps1"
]);
const RESEARCH_DIR = "autoresearch.research";
const CLEANUP_SESSION_PATHS = [RESEARCH_DIR, ...SESSION_FILES].sort((a, b) => a.localeCompare(b));
const REPORT_DIRNAME = "autoresearch-finalize";
function parseCliArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--") {
			out._.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			out._.push(arg);
			continue;
		}
		const equalsAt = arg.indexOf("=");
		const key = (equalsAt > 2 ? arg.slice(2, equalsAt) : arg.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if (equalsAt > 2) {
			out[key] = arg.slice(equalsAt + 1);
			continue;
		}
		const next = argv[i + 1];
		if (next == null || next.startsWith("--")) out[key] = true;
		else {
			out[key] = next;
			i += 1;
		}
	}
	return out;
}
async function run(command, args, cwd, allowFailure = false) {
	const result = await new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => resolve({
			code: -1,
			stdout,
			stderr: String(error.message || error)
		}));
		child.on("close", (code) => resolve({
			code,
			stdout,
			stderr
		}));
	});
	if (!allowFailure && result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
	return result;
}
async function git(args, cwd, allowFailure = false) {
	return await run("git", args, cwd, allowFailure);
}
function cleanLines(text) {
	return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function isSessionFile(file) {
	const normalized = file.replace(/\\/g, "/");
	return SESSION_FILES.has(normalized) || normalized === RESEARCH_DIR || normalized.startsWith(`${RESEARCH_DIR}/`);
}
function validateRepoRelativePath(file, cwd) {
	const normalized = String(file || "").trim().replace(/\\/g, "/");
	if (!normalized) throw new Error("Unsafe finalizer file path: empty path.");
	if (normalized.includes("\0")) throw new Error(`Unsafe finalizer file path contains NUL: ${file}`);
	if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//")) throw new Error(`Unsafe finalizer file path must be repo-relative: ${file}`);
	const parts = normalized.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe finalizer file path must not contain empty, dot, or parent segments: ${file}`);
	if (parts.some((part) => part.toLowerCase() === ".git")) throw new Error(`Unsafe finalizer file path must not target Git metadata: ${file}`);
	const root = path.resolve(cwd);
	const resolved = path.resolve(root, ...parts);
	const relative = path.relative(root, resolved);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe finalizer file path resolves outside the repo: ${file}`);
	return parts.join("/");
}
async function currentBranch(cwd) {
	return (await git(["branch", "--show-current"], cwd)).stdout.trim();
}
async function gitCommonDir(cwd) {
	const commonDir = (await git(["rev-parse", "--git-common-dir"], cwd)).stdout.trim();
	return path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
}
async function fullHash(ref, cwd) {
	return (await git(["rev-parse", ref], cwd)).stdout.trim();
}
async function branchExists(branch, cwd) {
	return (await git([
		"rev-parse",
		"--verify",
		branch
	], cwd, true)).code === 0;
}
async function isDirty(cwd) {
	return (await git(["status", "--porcelain"], cwd)).stdout.trim().length > 0;
}
async function changedFiles(fromRef, toRef, cwd) {
	return normalizePlanFiles(cleanLines((await git([
		"diff",
		"--name-only",
		fromRef,
		toRef
	], cwd)).stdout), cwd);
}
async function pathExistsAt(ref, file, cwd) {
	return (await git([
		"cat-file",
		"-e",
		`${ref}:${file}`
	], cwd, true)).code === 0;
}
async function applyFileFromCommit(ref, file, cwd) {
	const safeFile = validateRepoRelativePath(file, cwd);
	if (await pathExistsAt(ref, safeFile, cwd)) {
		await git([
			"checkout",
			ref,
			"--",
			safeFile
		], cwd);
		return;
	}
	await fsp.rm(path.resolve(cwd, safeFile), {
		recursive: true,
		force: true
	});
	await git([
		"rm",
		"-r",
		"--ignore-unmatch",
		"--",
		safeFile
	], cwd, true);
}
function sourceStepsForGroup(group) {
	if (Array.isArray(group.source_groups) && group.source_groups.length) return group.source_groups;
	return [{
		last_commit: group.last_commit,
		parent_commit: group.parent_commit,
		files: group.files || []
	}];
}
async function applyGroupSources(group, cwd) {
	for (const source of sourceStepsForGroup(group)) for (const file of source.files || []) await applyFileFromCommit(source.last_commit, file, cwd);
}
async function collectGroups(config, cwd) {
	const seen = /* @__PURE__ */ new Set();
	const groups = [];
	for (let i = 0; i < config.groups.length; i += 1) {
		const group = config.groups[i];
		const last = await fullHash(group.last_commit, cwd);
		const parent = group.parent_commit ? await fullHash(group.parent_commit, cwd) : await commitParent(last, config.base, cwd);
		const sourceGroups = Array.isArray(group.source_groups) && group.source_groups.length ? await collectSourceGroups(group.source_groups, config, cwd) : [{
			last_commit: last,
			parent_commit: parent,
			files: Array.isArray(group.files) && group.files.length ? normalizePlanFiles(group.files, cwd) : await changedFiles(parent, last, cwd)
		}];
		const files = normalizePlanFiles(sourceGroups.flatMap((source) => source.files || []), cwd);
		for (const file of files) {
			if (seen.has(file)) throw new Error(`File appears in multiple groups: ${file}. Merge those groups and retry.`);
			seen.add(file);
		}
		groups.push({
			...group,
			last_commit: last,
			files,
			parent_commit: parent,
			source_groups: sourceGroups
		});
	}
	await assertNoExcludedFileConflicts(config, groups, cwd);
	return groups;
}
async function collectSourceGroups(sources, config, cwd) {
	const collected = [];
	for (const source of sources) {
		const last = await fullHash(source.last_commit, cwd);
		const parent = source.parent_commit ? await fullHash(source.parent_commit, cwd) : await commitParent(last, config.base, cwd);
		const files = Array.isArray(source.files) && source.files.length ? normalizePlanFiles(source.files, cwd) : await changedFiles(parent, last, cwd);
		collected.push({
			...source,
			last_commit: last,
			parent_commit: parent,
			files
		});
	}
	return collected;
}
async function assertNoExcludedFileConflicts(config, groups, cwd) {
	const plannedFiles = new Set(groups.flatMap((group) => group.files || []));
	if (!plannedFiles.size || !Array.isArray(config.excluded_commits) || !config.excluded_commits.length) return;
	const conflicts = [];
	for (const item of config.excluded_commits) {
		if (!item?.commit) continue;
		const commit = await fullHash(item.commit, cwd);
		const overlapping = (await changedFiles(await commitParent(commit, config.base, cwd), commit, cwd)).filter((file) => plannedFiles.has(file));
		if (overlapping.length) conflicts.push({
			commit,
			subject: item.subject || "",
			files: overlapping
		});
	}
	if (!conflicts.length) return;
	const details = conflicts.slice(0, 6).map((conflict) => {
		const subject = conflict.subject ? ` ${conflict.subject}` : "";
		return `${shortHash(conflict.commit)}${subject}: ${conflict.files.slice(0, 8).join(", ")}`;
	}).join("\n");
	throw new Error(`Finalization stopped because excluded commits touch planned kept files. Rework the kept commits or finalization plan so unkept state cannot enter review branches.\n${details}`);
}
function normalizedExcludedCommits(plan) {
	return (Array.isArray(plan.excluded_commits) ? plan.excluded_commits : []).map((item) => ({
		commit: String(item?.commit || ""),
		status: String(item?.status || ""),
		subject: String(item?.subject || "")
	}));
}
function assertGeneratedPlanMetadata(config) {
	const hasExcludedCount = Object.hasOwn(config, "excluded_commit_count");
	const looksGenerated = Boolean(config.source_branch || config.planned_at || config.plan_fingerprint || hasExcludedCount || Object.hasOwn(config, "kept_run_count") || Object.hasOwn(config, "kept_commits"));
	if (hasExcludedCount) {
		const count = Number(config.excluded_commit_count);
		if (!Number.isInteger(count) || count < 0) throw new Error("Stale finalization plan: excluded_commit_count must be a non-negative integer. Rerun finalizer plan.");
		if (count !== normalizedExcludedCommits(config).length) throw new Error("Stale finalization plan: excluded_commit_count does not match excluded_commits. Rerun finalizer plan.");
	}
	if (looksGenerated && !config.plan_fingerprint) throw new Error("Stale finalization plan: generated plan fingerprint is missing. Rerun finalizer plan.");
}
function safeSlug(value) {
	return String(value || "autoresearch").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "autoresearch";
}
function shortHash(hash) {
	return String(hash || "").slice(0, 12);
}
function markdownEscape(text) {
	return String(text || "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}
function runEvidenceForCommit(keptRuns, hash) {
	for (let index = keptRuns.length - 1; index >= 0; index -= 1) {
		const run = keptRuns[index];
		if (commitMatchesHash(String(run.commit || ""), hash)) return run;
	}
	return null;
}
function commitMatchesHash(commit, hash) {
	if (!commit) return false;
	return hash.startsWith(commit) || commit.startsWith(hash.slice(0, 12));
}
async function readAutoresearchJsonl(cwd) {
	const file = path.join(cwd, "autoresearch.jsonl");
	let text;
	try {
		text = await fsp.readFile(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw new Error(`Could not read autoresearch.jsonl: ${error.message || error}`);
	}
	return text.split(/\r?\n/).map((line, index) => {
		const trimmed = line.trim();
		if (!trimmed) return null;
		try {
			return {
				...JSON.parse(trimmed),
				__line: index + 1
			};
		} catch (error) {
			throw new Error(`Corrupt autoresearch.jsonl at line ${index + 1}: ${error.message}`);
		}
	}).filter(Boolean);
}
async function commitHistory(base, cwd) {
	return cleanLines((await git([
		"log",
		"--reverse",
		"--format=%H%x1f%P%x1f%s",
		`${base}..HEAD`
	], cwd)).stdout).map((line) => {
		const [hash = "", parents = "", subject = ""] = line.split("");
		return {
			hash,
			parents: cleanLines(parents.replace(/\s+/g, "\n")),
			subject
		};
	}).filter((item) => item.hash);
}
async function commitParent(hash, base, cwd) {
	return cleanLines((await git([
		"rev-list",
		"--parents",
		"-n",
		"1",
		hash
	], cwd)).stdout.replace(/\s+/g, "\n"))[1] || base || base;
}
function parseCommitStatus(entries, hash) {
	const matching = [];
	for (const entry of entries) if (commitMatchesHash(String(entry.commit || ""), hash)) matching.push(entry);
	return matching.at(-1) || null;
}
function describeCommitStatus(entry) {
	if (!entry) return "unlogged";
	if (entry.status === "keep") return "kept";
	return String(entry.status || "unlogged");
}
function quotePathspecs(files) {
	return files.map((file) => posixQuote(file)).join(" ");
}
function normalizePlanFiles(files, cwd) {
	return [...new Set((Array.isArray(files) ? files : []).map((file) => validateRepoRelativePath(file, cwd)).filter((file) => !isSessionFile(file)))].sort((a, b) => a.localeCompare(b));
}
function draftBodyForCommit(run) {
	if (!run) return "Drafted from git history. Review metric evidence, ASI, and branch diff before opening a PR.";
	const lines = [`Experiment #${run.run}: ${run.description || "kept autoresearch change"}`, `Metric: ${run.metric}`];
	if (run.asi?.hypothesis) lines.push(`Hypothesis: ${run.asi.hypothesis}`);
	if (run.asi?.evidence) lines.push(`Evidence: ${run.asi.evidence}`);
	if (run.asi?.next_action_hint) lines.push(`Next action: ${run.asi.next_action_hint}`);
	return lines.join("\n\n");
}
function branchName(config, group, index) {
	const number = String(index + 1).padStart(2, "0");
	return `autoresearch-review/${safeSlug(config.goal)}/${number}-${safeSlug(group.slug || group.title || "change")}`;
}
async function branchStat(branch, cwd) {
	const result = await git([
		"show",
		"--stat",
		"--oneline",
		"--decorate=short",
		"--no-renames",
		branch
	], cwd, true);
	return result.code === 0 ? result.stdout.trim() : "";
}
async function reviewSummaryPath(config, cwd) {
	const dir = path.join(await gitCommonDir(cwd), REPORT_DIRNAME);
	await fsp.mkdir(dir, { recursive: true });
	const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
	return path.join(dir, `${stamp}-${safeSlug(config.goal)}.md`);
}
function renderReviewSummaryHeader({ config, sourceBranch, status, generatedAt }) {
	return [
		`# Autoresearch Finalize Review Summary`,
		"",
		`Generated: ${generatedAt}`,
		`Status: ${status}`,
		`Source branch: \`${sourceBranch}\``,
		`Base: \`${shortHash(config.base)}\``,
		`Final tree: \`${shortHash(config.final_tree)}\``,
		`Goal: \`${config.goal}\``,
		"",
		"## Review Branches",
		"",
		"| # | Branch | Title | Files |",
		"|---:|---|---|---|"
	];
}
function renderBranchRows(groups, results) {
	const lines = [];
	for (let i = 0; i < groups.length; i += 1) {
		const result = results[i];
		const branch = result?.branch || "(not created)";
		const suffix = result?.skipped ? " (skipped empty)" : "";
		lines.push(`| ${i + 1} | \`${markdownEscape(branch)}\`${suffix} | ${markdownEscape(groups[i].title)} | ${markdownEscape(groups[i].files.join(", ") || "(none)")} |`);
	}
	return lines;
}
function renderSuggestedPrBlocks(config, groups, results) {
	const lines = [
		"",
		"## Suggested PRs",
		""
	];
	for (let i = 0; i < groups.length; i += 1) {
		const result = results[i];
		if (!result || result.skipped) continue;
		const files = groups[i].files || [];
		lines.push(`### ${i + 1}. ${groups[i].title}`, "", `Branch: \`${result.branch}\``, "", "Suggested PR title:", "", "```text", groups[i].title, "```", "", "Suggested PR body:", "", "```markdown", groups[i].body || "Autoresearch kept change. Review metric evidence and branch diff.", "```", "", "Review commands:", "", "```bash", `git show --stat ${posixQuote(result.branch)}`, `git diff ${shortHash(config.base)}..${posixQuote(result.branch)} -- ${quotePathspecs(files)}`, "```", "");
		if (result.stat) lines.push("Branch stat:", "", "```text", result.stat, "```", "");
	}
	return lines;
}
function renderVerificationText(status, error) {
	return [
		"",
		"## Verification",
		"",
		status === "verified" ? "- Union verification passed: grouped files match the final tree, excluding autoresearch session artifacts." : status === "failed" ? `- Verification or branch creation failed: ${markdownEscape(error?.message || error || "unknown error")}` : "- Verification is pending.",
		"- Session artifact verification is preserved: review branches must not contain `autoresearch.*` files or `autoresearch.research/` scratchpads."
	];
}
function renderRunwayText(groups, results) {
	const fileSet = /* @__PURE__ */ new Set();
	for (const group of groups) for (const file of group.files || []) fileSet.add(file);
	return [
		"",
		"## Finalization Runway",
		"",
		"1. Preview groups and risks.",
		"2. Approve the review branch plan.",
		"3. Create review branches.",
		"4. Verify union and session-artifact checks.",
		"5. Merge the review branches into trunk.",
		"6. Cleanup source branches and autoresearch artifacts only after merge succeeds.",
		"",
		`Final file set: ${[...fileSet].sort().join(", ") || "(none)"}`,
		`Review branches created: ${results.filter((result) => result && !result.skipped).map((result) => result.branch).join(", ") || "(none)"}`
	];
}
function renderCleanupNotes(sourceBranch) {
	const psPaths = CLEANUP_SESSION_PATHS;
	return [
		"",
		"## Cleanup After Merge",
		"",
		"Do not run cleanup until the review branch merge has succeeded on trunk.",
		"",
		"PowerShell:",
		"",
		"```powershell",
		`git branch -D ${powershellQuote(sourceBranch)}`,
		`Remove-Item -LiteralPath ${psPaths.map(powershellQuote).join(", ")} -Recurse -Force -ErrorAction SilentlyContinue`,
		"```",
		"",
		"POSIX shell:",
		"",
		"```bash",
		`git branch -D ${posixQuote(sourceBranch)}`,
		`rm -rf ${psPaths.map(posixQuote).join(" ")}`,
		"```",
		"",
		`This file is generated under Git metadata (\`${REPORT_DIRNAME}\`) so it does not dirty the worktree. Remove it when no longer needed.`
	];
}
async function writeReviewSummary(file, context) {
	const { config, groups, results, sourceBranch, status, error } = context;
	const lines = [
		...renderReviewSummaryHeader({
			config,
			sourceBranch,
			status,
			generatedAt: (/* @__PURE__ */ new Date()).toISOString()
		}),
		...renderBranchRows(groups, results),
		...renderSuggestedPrBlocks(config, groups, results),
		...renderVerificationText(status, error),
		...renderRunwayText(groups, results),
		...renderCleanupNotes(sourceBranch)
	];
	await fsp.writeFile(file, `${lines.join("\n")}\n`, "utf8");
}
function phaseError(phase, error, hint) {
	const original = error instanceof Error ? error : new Error(String(error));
	const message = [
		`Finalize failed during ${phase}.`,
		hint ? `Next step: ${hint}` : "",
		"",
		original.message || String(original)
	].filter((line) => line !== "").join("\n");
	const wrapped = new Error(message);
	wrapped.cause = original;
	wrapped.finalizePhase = phase;
	return wrapped;
}
async function withPhase(phase, hint, fn) {
	try {
		return await fn();
	} catch (error) {
		if (error?.finalizePhase) throw error;
		throw phaseError(phase, error, hint);
	}
}
async function createBranchForGroup(config, group, index, cwd) {
	const branch = branchName(config, group, index);
	if (!group.files.length) return {
		branch,
		skipped: true,
		deleted: true,
		stat: ""
	};
	if (await branchExists(branch, cwd)) throw new Error(`Branch already exists: ${branch}`);
	await git([
		"switch",
		"--detach",
		config.base
	], cwd);
	await git([
		"switch",
		"-c",
		branch
	], cwd);
	try {
		await applyGroupSources(group, cwd);
		await git(["add", "-A"], cwd);
		if ((await git([
			"diff",
			"--cached",
			"--quiet"
		], cwd, true)).code === 0) {
			await git([
				"switch",
				"--detach",
				config.base
			], cwd, true);
			await git([
				"branch",
				"-D",
				branch
			], cwd, true);
			return {
				branch,
				skipped: true,
				deleted: true,
				stat: ""
			};
		}
		await git([
			"commit",
			"-m",
			group.title,
			"-m",
			group.body || ""
		], cwd);
		return {
			branch,
			skipped: false,
			deleted: false,
			stat: await branchStat(branch, cwd)
		};
	} catch (error) {
		await git([
			"switch",
			"--detach",
			config.base
		], cwd, true);
		await git([
			"branch",
			"-D",
			branch
		], cwd, true);
		throw error;
	}
}
async function verifyUnion(config, groups, sourceBranch, createdBranches, cwd) {
	const verifyBranch = `autoresearch-review/${safeSlug(config.goal)}/verify-tmp`;
	if (await branchExists(verifyBranch, cwd)) await git([
		"branch",
		"-D",
		verifyBranch
	], cwd, true);
	let nonSession = [];
	try {
		await git([
			"switch",
			"--detach",
			config.base
		], cwd);
		await git([
			"switch",
			"-c",
			verifyBranch
		], cwd);
		for (const group of groups) await applyGroupSources(group, cwd);
		await git(["add", "-A"], cwd);
		await git([
			"commit",
			"--allow-empty",
			"-m",
			"verify: union of autoresearch groups"
		], cwd);
		nonSession = cleanLines((await git([
			"diff",
			"--name-only",
			"HEAD",
			config.final_tree
		], cwd)).stdout).filter((file) => !isSessionFile(file));
	} finally {
		await git(["switch", sourceBranch], cwd, true);
		await git([
			"branch",
			"-D",
			verifyBranch
		], cwd, true);
	}
	if (nonSession.length > 0) throw new Error(`Union of groups differs from final tree:\n${nonSession.join("\n")}\nCreated branches were left intact:\n${createdBranches.join("\n")}`);
}
async function verifyNoSessionArtifacts(createdBranches, cwd) {
	for (const branch of createdBranches) {
		const sessionFiles = cleanLines((await git([
			"diff-tree",
			"--no-commit-id",
			"--name-only",
			"-r",
			branch
		], cwd)).stdout).filter(isSessionFile);
		if (sessionFiles.length > 0) throw new Error(`Session artifact found in ${branch}: ${sessionFiles.join(", ")}`);
	}
}
async function draftGroupsPlan(args, cwd) {
	const trunk = args.trunk || "main";
	const sourceBranch = await currentBranch(cwd);
	if (!sourceBranch) throw new Error("Detached HEAD. Switch to the autoresearch branch before planning.");
	const base = (await git([
		"merge-base",
		trunk,
		"HEAD"
	], cwd)).stdout.trim();
	const finalTree = await fullHash("HEAD", cwd);
	const goal = safeSlug(args.goal || sourceBranch.replace(/^.*\//, "") || "autoresearch");
	const history = await commitHistory(base, cwd);
	const entries = await readAutoresearchJsonl(cwd);
	const keptRuns = entries.filter((entry) => entry.status === "keep");
	const groups = [];
	const excludedCommits = [];
	const selectedCommits = /* @__PURE__ */ new Set();
	for (const item of history) {
		const selectedRun = runEvidenceForCommit(keptRuns, item.hash);
		if (!selectedRun) {
			const sourceEntry = parseCommitStatus(entries, item.hash);
			excludedCommits.push({
				commit: item.hash,
				subject: item.subject || "",
				status: describeCommitStatus(sourceEntry)
			});
			continue;
		}
		selectedCommits.add(item.hash);
		const parent = item.parents[0] || base;
		const files = await changedFiles(parent, item.hash, cwd);
		groups.push({
			title: item.subject || selectedRun.description || `Autoresearch change ${groups.length + 1}`,
			body: draftBodyForCommit(selectedRun),
			last_commit: item.hash,
			slug: safeSlug(item.subject || selectedRun.description || `change-${groups.length + 1}`),
			parent_commit: parent,
			files
		});
	}
	const overlapAnalysis = analyzeGroupOverlap(groups);
	const plan = {
		source_branch: sourceBranch,
		planned_at: (/* @__PURE__ */ new Date()).toISOString(),
		base,
		trunk,
		final_tree: finalTree,
		goal,
		kept_commits: [...selectedCommits],
		kept_run_count: keptRuns.length,
		excluded_commits: excludedCommits,
		excluded_commit_count: excludedCommits.length,
		overlap_files: overlapAnalysis.files,
		overlap_count: overlapAnalysis.files.length,
		collapse_overlap_recommended: overlapAnalysis.files.length > 0,
		warnings: buildPlanWarnings({
			excludedCommits,
			overlapAnalysis
		}),
		groups
	};
	return {
		...plan,
		plan_fingerprint: planFingerprint(plan)
	};
}
async function collapseOverlappingDraftGroups(plan, cwd) {
	if (plan.groups.length <= 1) return plan;
	const overlapping = new Set(plan.overlap_files || []);
	if (overlapping.size === 0) return plan;
	const lastGroup = plan.groups.at(-1);
	const overlapList = [...overlapping].sort().slice(0, 12);
	const sourceGroups = await collectSourceGroups(plan.groups.map((group) => ({
		title: group.title,
		slug: group.slug,
		last_commit: group.last_commit,
		parent_commit: group.parent_commit,
		files: group.files || []
	})), plan, cwd);
	const files = normalizePlanFiles(sourceGroups.flatMap((group) => group.files || []), cwd);
	return {
		...plan,
		groups: [{
			title: `Consolidated ${plan.goal} changes`,
			body: [
				"Autoresearch kept changes were collapsed into one review branch because multiple kept commits touched the same files.",
				"",
				`Overlapping files: ${overlapList.join(", ")}${overlapping.size > overlapList.length ? ", ..." : ""}`
			].join("\n"),
			last_commit: lastGroup.last_commit,
			parent_commit: plan.base,
			files,
			source_groups: sourceGroups,
			slug: safeSlug(`${plan.goal}-changes`),
			collapsed: true
		}]
	};
}
async function writeDraftPlan(args, cwd) {
	let plan = await draftGroupsPlan(args, cwd);
	if (args.collapseOverlap) plan = await collapseOverlappingDraftGroups(plan, cwd);
	plan = {
		...plan,
		plan_fingerprint: planFingerprint(plan)
	};
	const output = args.output ? path.resolve(args.output) : path.join(await gitCommonDir(cwd), REPORT_DIRNAME, `${safeSlug(plan.goal)}.groups.json`);
	await fsp.mkdir(path.dirname(output), { recursive: true });
	await fsp.writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
	console.log(`Wrote draft groups: ${output}`);
	console.log(`Groups: ${plan.groups.length}`);
	console.log(`Selected kept commits: ${plan.kept_commits.length}`);
	if (plan.excluded_commit_count > 0) {
		console.log(`Excluded commits: ${plan.excluded_commit_count}`);
		console.log("Excluded commits were flagged and omitted from finalization planning.");
		for (const item of plan.excluded_commits.slice(0, 5)) {
			const parts = [shortHash(item.commit), item.status];
			if (item.subject) parts.push(item.subject);
			console.log(`  - ${parts.join(" ")}`);
		}
		if (plan.excluded_commits.length > 5) console.log("  - ...");
	}
	if (plan.collapse_overlap_recommended && !args.collapseOverlap) console.log("Hint: rerun with --collapse-overlap to consolidate overlapping kept commits.");
	return plan;
}
async function main() {
	const cli = parseCliArgs(process.argv.slice(2));
	const command = cli._[0];
	const file = command;
	if (!file || file === "--help" || file === "-h") {
		console.log(usage());
		return;
	}
	const cwd = process.cwd();
	if (command === "plan") {
		await withPhase("plan generation", "Fix autoresearch.jsonl and rerun finalizer plan.", async () => {
			await writeDraftPlan(cli, cwd);
		});
		return;
	}
	const configPath = path.resolve(file);
	const config = await withPhase("configuration", "Fix groups.json and retry.", async () => {
		const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
		if (!parsed.base || !parsed.final_tree || !parsed.goal || !Array.isArray(parsed.groups)) throw new Error("groups.json is missing base, final_tree, goal, or groups.");
		parsed.trunk = parsed.trunk || "main";
		parsed.base = await fullHash(parsed.base, cwd);
		parsed.final_tree = await fullHash(parsed.final_tree, cwd);
		return parsed;
	});
	const sourceBranch = await withPhase("preflight", "Switch to a clean autoresearch source branch, then rerun finalization.", async () => {
		const branch = await currentBranch(cwd);
		if (!branch) throw new Error("Detached HEAD. Switch to the autoresearch branch first.");
		if (branch === config.trunk) throw new Error(`On trunk (${config.trunk}). Switch to the autoresearch branch first.`);
		if (await isDirty(cwd)) throw new Error("Working tree is dirty. Commit, stash, or clean changes before finalizing.");
		if (config.source_branch && branch !== config.source_branch) throw new Error(`Stale finalization plan: current branch is ${branch}, but plan was created for ${config.source_branch}. Rerun finalizer plan.`);
		if (await fullHash("HEAD", cwd) !== config.final_tree) throw new Error("Stale finalization plan: current HEAD differs from planned final_tree. Rerun finalizer plan.");
		if ((await git([
			"merge-base",
			config.trunk,
			"HEAD"
		], cwd)).stdout.trim() !== config.base) throw new Error("Stale finalization plan: trunk merge-base differs from planned base. Rerun finalizer plan.");
		assertGeneratedPlanMetadata(config);
		if (config.plan_fingerprint && config.plan_fingerprint !== planFingerprint(config)) throw new Error("Stale finalization plan: plan fingerprint does not match contents. Rerun finalizer plan.");
		return branch;
	});
	const groups = await withPhase("group analysis", "Merge overlapping groups or correct the kept commit order in groups.json.", async () => {
		return await collectGroups(config, cwd);
	});
	const created = [];
	const results = [];
	let summaryPath = "";
	try {
		await withPhase("branch creation", "Delete or rename any conflicting autoresearch-review branches, then retry.", async () => {
			for (let i = 0; i < groups.length; i += 1) {
				const result = await createBranchForGroup(config, groups[i], i, cwd);
				results.push(result);
				if (!result.skipped) created.push(result.branch);
				console.log(`${String(i + 1).padStart(2, "0")}. ${groups[i].title}`);
				console.log(`    branch: ${result.branch}${result.skipped ? " (skipped empty)" : ""}`);
				console.log(`    files: ${groups[i].files.join(", ") || "(none)"}`);
			}
		});
	} catch (error) {
		for (const branch of created) await git([
			"branch",
			"-D",
			branch
		], cwd, true);
		await git(["switch", sourceBranch], cwd, true);
		throw error;
	}
	summaryPath = await reviewSummaryPath(config, cwd);
	await writeReviewSummary(summaryPath, {
		config,
		groups,
		results,
		sourceBranch,
		status: "pending"
	});
	console.log("");
	console.log(`Review summary: ${summaryPath}`);
	try {
		await withPhase("union verification", "Inspect the generated review summary and the listed file differences before changing groups.json.", async () => {
			await verifyUnion(config, groups, sourceBranch, created, cwd);
		});
		await withPhase("session artifact verification", "Remove autoresearch.* files from review branches, then rerun finalization.", async () => {
			await verifyNoSessionArtifacts(created, cwd);
		});
		await git(["switch", sourceBranch], cwd, true);
		await writeReviewSummary(summaryPath, {
			config,
			groups,
			results,
			sourceBranch,
			status: "verified"
		});
	} catch (error) {
		await git(["switch", sourceBranch], cwd, true);
		await writeReviewSummary(summaryPath, {
			config,
			groups,
			results,
			sourceBranch,
			status: "failed",
			error
		});
		console.error("");
		console.error(`Review summary: ${summaryPath}`);
		throw error;
	}
	console.log("");
	console.log("Created review branches:");
	for (const branch of created) console.log(`  ${branch}`);
	console.log("");
	console.log("Runway: preview -> approve -> create review branch -> verify -> merge -> cleanup.");
	console.log("Cleanup after merge only:");
	console.log(`  PowerShell: git branch -D ${powershellQuote(sourceBranch)}`);
	console.log("  POSIX: see the generated review summary for quoted cleanup guidance.");
}
function planFingerprint(plan) {
	const stable = {
		source_branch: plan.source_branch || "",
		base: plan.base || "",
		trunk: plan.trunk || "",
		final_tree: plan.final_tree || "",
		goal: plan.goal || "",
		kept_commits: plan.kept_commits || [],
		kept_run_count: plan.kept_run_count || 0,
		excluded_commits: normalizedExcludedCommits(plan),
		excluded_commit_count: plan.excluded_commit_count || 0,
		overlap_files: plan.overlap_files || [],
		groups: (plan.groups || []).map((group) => ({
			title: group.title || "",
			last_commit: group.last_commit || "",
			slug: group.slug || "",
			files: group.files || [],
			source_groups: (group.source_groups || []).map((source) => ({
				last_commit: source.last_commit || "",
				parent_commit: source.parent_commit || "",
				files: source.files || []
			}))
		}))
	};
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
function analyzeGroupOverlap(groups) {
	if (!Array.isArray(groups) || groups.length <= 1) return {
		files: [],
		groups: []
	};
	const seen = /* @__PURE__ */ new Map();
	const overlappingFiles = /* @__PURE__ */ new Set();
	const overlappingGroups = /* @__PURE__ */ new Set();
	for (const group of groups) for (const file of group.files || []) if (seen.has(file)) {
		overlappingFiles.add(file);
		overlappingGroups.add(seen.get(file));
		overlappingGroups.add(group.last_commit);
	} else seen.set(file, group.last_commit);
	return {
		files: [...overlappingFiles],
		groups: [...overlappingGroups]
	};
}
function buildPlanWarnings({ excludedCommits, overlapAnalysis }) {
	const warnings = [];
	if (excludedCommits.length > 0) {
		const sample = excludedCommits.slice(0, 3).map((item) => `${shortHash(item.commit)} ${item.status}${item.subject ? ` ${item.subject}` : ""}`);
		warnings.push(`Excluded ${excludedCommits.length} unkept commit${excludedCommits.length === 1 ? "" : "s"} from base..HEAD: ${sample.join(", ")}${excludedCommits.length > sample.length ? ", ..." : ""}.`);
	}
	if (overlapAnalysis.files.length > 0) warnings.push(`Kept commits overlap on ${overlapAnalysis.files.length} file${overlapAnalysis.files.length === 1 ? "" : "s"}; rerun with --collapse-overlap to consolidate them.`);
	return warnings;
}
function powershellQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}
function posixQuote(value) {
	return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}
main().catch((error) => {
	const failure = error;
	console.error(failure.stack || failure.message || String(failure));
	process.exitCode = 1;
});
//#endregion
export {};
