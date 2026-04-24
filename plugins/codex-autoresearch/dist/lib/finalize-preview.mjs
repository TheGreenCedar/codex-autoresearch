import { resolvePackageRoot } from "./runtime-paths.mjs";
import path from "node:path";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
//#region lib/finalize-preview.ts
const PLUGIN_ROOT = resolvePackageRoot(import.meta.url);
async function finalizePreview(args) {
	const startedAt = Date.now();
	const workDir = path.resolve(args.working_dir || args.cwd || process.cwd());
	const trunk = args.trunk || "main";
	const inside = await gitOk(["rev-parse", "--is-inside-work-tree"], workDir);
	if (!inside.ok || inside.stdout.trim() !== "true") return withProgress({
		ok: true,
		workDir,
		ready: false,
		groups: [],
		warnings: ["Working directory is not a Git repository."],
		nextAction: "Run finalization preview from a Git-backed autoresearch branch."
	}, startedAt, "blocked");
	const branch = (await git(["branch", "--show-current"], workDir)).stdout.trim();
	const dirty = (await git(["status", "--porcelain"], workDir)).stdout.trim();
	const keptRuns = await readKeptRuns(workDir);
	const groups = [];
	const warnings = [];
	let missingCommitCount = 0;
	for (const run of keptRuns) {
		const commit = String(run.commit || "");
		if (!commit) {
			missingCommitCount += 1;
			continue;
		}
		const full = await gitOk(["rev-parse", commit], workDir);
		if (!full.ok) {
			warnings.push(`Kept run #${run.run} commit ${commit} could not be resolved.`);
			continue;
		}
		const hash = full.stdout.trim();
		const files = await changedFilesForCommit(hash, workDir);
		groups.push({
			title: run.description || `Autoresearch run #${run.run}`,
			run: run.run,
			commit: hash,
			shortCommit: hash.slice(0, 12),
			files,
			metric: run.metric,
			asi: run.asi || {},
			slug: safeSlug(run.description || `run-${run.run}`)
		});
	}
	const seen = /* @__PURE__ */ new Map();
	const overlaps = [];
	for (const group of groups) for (const file of group.files) if (seen.has(file)) overlaps.push({
		file,
		first: seen.get(file),
		second: group.run
	});
	else seen.set(file, group.run);
	let base = "";
	const baseResult = await gitOk([
		"merge-base",
		trunk,
		"HEAD"
	], workDir);
	if (baseResult.ok) base = baseResult.stdout.trim();
	else warnings.push(`Could not find merge-base with ${trunk}.`);
	if (dirty) warnings.push("Working tree is dirty; finalization branch creation will refuse to run.");
	if (!branch) warnings.push("Detached HEAD; switch to the autoresearch source branch before finalizing.");
	if (branch === trunk) warnings.push(`On trunk (${trunk}); switch to the autoresearch source branch before finalizing.`);
	if (overlaps.length) warnings.push("Some kept runs touch the same files; finalization may need collapsed groups.");
	const ready = groups.length > 0 && !dirty && branch && branch !== trunk && baseResult.ok;
	const planOutput = await defaultPlanOutput(workDir, branch || "autoresearch");
	const planArgv = [
		process.execPath,
		path.join(PLUGIN_ROOT, "scripts", "finalize-autoresearch.mjs"),
		"plan",
		"--output",
		planOutput,
		"--goal",
		safeSlug(branch || "autoresearch"),
		"--trunk",
		trunk
	];
	const nextAction = ready ? "Review the preview, then run the suggested finalizer plan command." : groups.length === 0 && keptRuns.length > 0 && missingCommitCount === keptRuns.length ? "Review branches need commit-backed keep logs. Log a keep with --commit, configure commitPaths, or rerun keep after committing the experiment." : "Resolve preview warnings before creating review branches.";
	return withProgress({
		ok: true,
		workDir,
		trunk,
		branch,
		base,
		ready,
		groups,
		missingCommitCount,
		overlaps,
		warnings,
		suggestedCommand: planArgv.map(shellQuote).join(" "),
		suggestedCommands: { finalizerPlan: {
			argv: planArgv,
			cwd: workDir,
			display: planArgv.map(shellQuote).join(" "),
			purpose: "Write a review-branch plan without dirtying the source branch.",
			mutates: false
		} },
		nextAction
	}, startedAt, ready ? "completed" : "blocked");
}
async function defaultPlanOutput(workDir, branch) {
	const gitPath = await gitOk([
		"rev-parse",
		"--git-path",
		`autoresearch-finalize/${safeSlug(branch)}.groups.json`
	], workDir);
	if (gitPath.ok && gitPath.stdout.trim()) return path.resolve(workDir, gitPath.stdout.trim());
	return path.join(workDir, ".git", "autoresearch-finalize", `${safeSlug(branch)}.groups.json`);
}
function withProgress(result, startedAt, status) {
	const durationSeconds = Number(((Date.now() - startedAt) / 1e3).toFixed(3));
	return {
		...result,
		progress: {
			mode: "synchronous",
			status,
			cancellable: false,
			cancelStatus: "not_requested",
			elapsedSeconds: durationSeconds,
			stages: [{
				stage: "finalize-preview",
				label: "Preview review branch readiness",
				status,
				durationSeconds,
				exitCode: null,
				timedOut: false,
				outputTail: result.nextAction || ""
			}],
			latestOutputTail: result.nextAction || ""
		}
	};
}
async function readKeptRuns(cwd) {
	try {
		return (await fsp.readFile(path.join(cwd, "autoresearch.jsonl"), "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.status === "keep");
	} catch {
		return [];
	}
}
async function changedFilesForCommit(hash, cwd) {
	return (await git([
		"show",
		"--name-only",
		"--format=",
		hash
	], cwd)).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((file) => !isSessionFile(file));
}
function isSessionFile(file) {
	const normalized = file.replace(/\\/g, "/");
	return normalized.startsWith("autoresearch.") || normalized.startsWith("autoresearch.research/");
}
function safeSlug(value) {
	return String(value || "autoresearch").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "autoresearch";
}
function shellQuote(value) {
	const text = String(value);
	if (/^--[A-Za-z0-9-]+$/.test(text) || text === "plan") return text;
	return `"${text.replace(/"/g, "\\\"")}"`;
}
async function git(args, cwd) {
	const result = await gitOk(args, cwd);
	if (!result.ok) throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
	return result;
}
async function gitOk(args, cwd) {
	const result = await new Promise((resolve) => {
		const child = spawn("git", args, {
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
	return {
		...result,
		ok: result.code === 0
	};
}
//#endregion
export { finalizePreview };
