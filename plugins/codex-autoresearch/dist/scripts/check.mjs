#!/usr/bin/env node
import { resolvePackageRoot, resolveRepoRoot } from "../lib/runtime-paths.mjs";
import path from "node:path";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
//#region scripts/check.ts
const ROOT = resolvePackageRoot(import.meta.url);
const REPO_ROOT = resolveRepoRoot(import.meta.url);
const node = process.execPath;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const BENCHMARK_SOURCE = path.join(ROOT, "scripts", "perfection-benchmark.ts");
const syntaxChecks = [
	[
		"syntax:autoresearch",
		node,
		["--check", "scripts/autoresearch.mjs"]
	],
	[
		"syntax:mcp",
		node,
		["--check", "scripts/autoresearch-mcp.mjs"]
	],
	[
		"syntax:finalize",
		node,
		["--check", "scripts/finalize-autoresearch.mjs"]
	],
	[
		"syntax:benchmark",
		node,
		["--check", "scripts/perfection-benchmark.mjs"]
	],
	[
		"syntax:check",
		node,
		["--check", "scripts/check.mjs"]
	]
];
const productChecks = [
	[
		"quality-gap",
		node,
		["scripts/perfection-benchmark.mjs", "--fail-on-gap"]
	],
	[
		"help:autoresearch",
		node,
		["scripts/autoresearch.mjs", "--help"]
	],
	[
		"help:finalize",
		node,
		["scripts/finalize-autoresearch.mjs", "--help"]
	],
	[
		"tests",
		node,
		[
			"--test",
			"dist/tests/autoresearch-cli.test.mjs",
			"dist/tests/dashboard-verification.test.mjs",
			"dist/tests/evidence-core.test.mjs",
			"dist/tests/experiment-memory.test.mjs",
			"dist/tests/finalize-report.test.mjs",
			"dist/tests/full-product.test.mjs",
			"dist/tests/perfection-benchmark.test.mjs"
		]
	]
];
const dashboardBuildChecks = [[
	"build:dashboard",
	node,
	[
		"node_modules/vite/bin/vite.js",
		"build",
		"--config",
		"vite.dashboard.config.ts",
		"--logLevel",
		"warn"
	]
]];
const dashboardAssets = ["assets/dashboard-build/dashboard-app.js", "assets/dashboard-build/dashboard-app.css"];
const sourceCheckoutRuntimePaths = [
	"plugins/codex-autoresearch/dist/lib/cli-handlers.mjs",
	"plugins/codex-autoresearch/dist/lib/mcp-cli-adapter.mjs",
	"plugins/codex-autoresearch/dist/lib/mcp-interface.mjs",
	"plugins/codex-autoresearch/dist/lib/mcp-tool-schemas.mjs",
	"plugins/codex-autoresearch/dist/lib/session-core.mjs",
	"plugins/codex-autoresearch/dist/scripts/autoresearch.mjs",
	"plugins/codex-autoresearch/dist/scripts/autoresearch-mcp.mjs",
	"plugins/codex-autoresearch/scripts/autoresearch.mjs",
	"plugins/codex-autoresearch/scripts/autoresearch-mcp.mjs"
];
const ok = await runPhase("syntax", syntaxChecks) && await runDashboardBuildWithParity() && await runSourceCheckoutArtifactCheck() && await runPackageArtifactCheck() && await runPhase("product", productChecks);
process.exit(ok ? 0 : 1);
async function runPhase(name, commands) {
	console.log(`\n== ${name} ==`);
	const results = await Promise.all(commands.map(runCommand));
	for (const result of results) {
		const marker = result.code === 0 ? "ok" : "fail";
		console.log(`${marker} ${result.label}`);
		if (result.code !== 0 || process.env.CODEX_AUTORESEARCH_CHECK_VERBOSE === "1") {
			const output = `${result.stdout}${result.stderr}`.trim();
			if (output) console.log(indent(output));
		}
		if (result.label === "quality-gap" && process.env.CODEX_AUTORESEARCH_CHECK_VERBOSE === "1") console.log(indent(`Benchmark source: ${BENCHMARK_SOURCE}`));
	}
	return results.every((result) => result.code === 0);
}
async function runDashboardBuildWithParity() {
	const before = await dashboardAssetHashes();
	if (!await runPhase("dashboard", dashboardBuildChecks)) return false;
	const after = await dashboardAssetHashes();
	const changed = dashboardAssets.filter((file) => before[file] !== after[file]);
	console.log("\n== dashboard parity ==");
	if (changed.length) {
		console.log("fail dashboard-asset-parity");
		console.log(indent(`Dashboard build changed generated assets:\n${changed.join("\n")}\nRun npm run build:dashboard and include the rebuilt assets.`));
		return false;
	}
	console.log("ok dashboard-asset-parity");
	return true;
}
async function dashboardAssetHashes() {
	const hashes = {};
	for (const file of dashboardAssets) {
		const bytes = await fsp.readFile(path.join(ROOT, file));
		hashes[file] = createHash("sha256").update(bytes).digest("hex");
	}
	return hashes;
}
async function runPackageArtifactCheck() {
	console.log("\n== package ==");
	const npmExecPath = process.env.npm_execpath;
	const result = await runCommand([
		"package-artifact",
		npmExecPath ? node : process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : npm,
		npmExecPath ? [
			npmExecPath,
			"pack",
			"--dry-run",
			"--json",
			"--silent"
		] : process.platform === "win32" ? [
			"/d",
			"/s",
			"/c",
			"npm pack --dry-run --json --silent"
		] : [
			"pack",
			"--dry-run",
			"--json",
			"--silent"
		]
	]);
	if (result.code !== 0) {
		console.log("fail package-artifact");
		const output = `${result.stdout}${result.stderr}`.trim();
		if (output) console.log(indent(output));
		return false;
	}
	const output = `${result.stdout}${result.stderr}`;
	const start = output.indexOf("[");
	const end = output.lastIndexOf("]");
	if (start === -1 || end === -1 || end < start) {
		console.log("fail package-artifact");
		console.log(indent("Could not parse npm pack --dry-run --json output."));
		if (output.trim()) console.log(indent(output.trim()));
		return false;
	}
	let packInfo;
	try {
		[packInfo] = JSON.parse(output.slice(start, end + 1));
	} catch (error) {
		console.log("fail package-artifact");
		console.log(indent(`Could not parse npm pack manifest: ${String(error)}`));
		return false;
	}
	const packedPaths = new Set((packInfo?.files || []).map((entry) => String(entry.path || "").replace(/\\/g, "/")));
	const requiredPaths = [
		".codex-plugin/plugin.json",
		".mcp.json",
		"assets/dashboard-build/dashboard-app.js",
		"dist/scripts/autoresearch.mjs",
		"dist/scripts/autoresearch-mcp.mjs",
		"scripts/autoresearch.mjs",
		"scripts/autoresearch-mcp.mjs",
		"skills/codex-autoresearch/SKILL.md"
	];
	const forbiddenPaths = [
		"dashboard/src/Dashboard.tsx",
		"lib/session-core.ts",
		"scripts/autoresearch.ts",
		"tests/autoresearch-cli.test.ts"
	];
	const missing = requiredPaths.filter((file) => !packedPaths.has(file));
	const unexpected = forbiddenPaths.filter((file) => packedPaths.has(file));
	if (missing.length || unexpected.length) {
		console.log("fail package-artifact");
		if (missing.length) console.log(indent(`Missing packaged files:\n${missing.join("\n")}`));
		if (unexpected.length) console.log(indent(`Unexpected source files in package:\n${unexpected.join("\n")}`));
		return false;
	}
	console.log("ok package-artifact");
	return true;
}
async function runSourceCheckoutArtifactCheck() {
	console.log("\n== source checkout ==");
	const missing = [];
	for (const file of sourceCheckoutRuntimePaths) try {
		await fsp.access(path.join(REPO_ROOT, file));
	} catch {
		missing.push(file);
	}
	if (missing.length) {
		console.log("fail source-runtime-files");
		console.log(indent(`Missing source checkout runtime files:\n${missing.join("\n")}`));
		return false;
	}
	if ((await runCommand([
		"git-probe",
		"git",
		[
			"-C",
			REPO_ROOT,
			"rev-parse",
			"--is-inside-work-tree"
		]
	])).code !== 0) {
		console.log("ok source-runtime-files");
		console.log("skip source-runtime-committable (not a Git checkout)");
		return true;
	}
	const committable = await runCommand([
		"source-runtime-committable",
		"git",
		[
			"-C",
			REPO_ROOT,
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"--",
			...sourceCheckoutRuntimePaths
		]
	]);
	if (committable.code !== 0) {
		console.log("ok source-runtime-files");
		console.log("fail source-runtime-committable");
		const output = `${committable.stdout}${committable.stderr}`.trim();
		if (output) console.log(indent(output));
		return false;
	}
	const committablePaths = new Set(committable.stdout.split(/\r?\n/).filter(Boolean));
	const ignoredOrInvisible = sourceCheckoutRuntimePaths.filter((file) => !committablePaths.has(file));
	if (ignoredOrInvisible.length) {
		console.log("ok source-runtime-files");
		console.log("fail source-runtime-committable");
		console.log(indent(`Runtime files are present but ignored or invisible to Git:\n${ignoredOrInvisible.join("\n")}`));
		return false;
	}
	console.log("ok source-runtime-files");
	console.log("ok source-runtime-committable");
	return true;
}
function runCommand([label, command, args]) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: ROOT,
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
		child.on("error", (error) => {
			resolve({
				label,
				code: -1,
				stdout,
				stderr: `${stderr}${error.message}\n`
			});
		});
		child.on("close", (code) => {
			resolve({
				label,
				code,
				stdout,
				stderr
			});
		});
	});
}
function indent(text) {
	return text.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}
//#endregion
export {};
