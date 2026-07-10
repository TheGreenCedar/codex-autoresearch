import fsp from "node:fs/promises";
import path from "node:path";
import { parseNulPathList } from "../git-paths.js";
import {
  findLooseObjectCompatibilityOffenders,
  findSourceHygieneOffenders,
  formatSourceHygieneOffenders,
  type SourceFileSnapshot,
  type SourceHygieneOffender,
} from "../cli/source-hygiene.js";
import {
  indent,
  normalizePathForGit,
  PACKAGE_ROOT_RELATIVE,
  recordValue,
  REPO_ROOT,
  ROOT,
  runCommand,
  stringValue,
} from "./check-common.js";

const requiredRootIgnoreSentinels = [
  [".cursor/", ".cursor/__codex_check__"],
  [".learnings/", ".learnings/__codex_check__"],
  ["docs/superpowers/plans/", "docs/superpowers/plans/__codex_check__"],
];

const dashboardBuildDependencies = ["react", "react-dom", "recharts"];

export type { SourceFileSnapshot };

export async function runSourceHygieneCheck(
  options: {
    sourceFiles?: Iterable<SourceFileSnapshot>;
    trackedPaths?: Iterable<string>;
  } = {},
) {
  console.log("\n== source hygiene ==");

  if (options.trackedPaths) {
    return reportSourceHygieneResult(options.trackedPaths, {
      sourceFiles: options.sourceFiles,
    });
  }

  const gitProbe = await runCommand([
    "git-probe",
    "git",
    ["-C", REPO_ROOT, "rev-parse", "--is-inside-work-tree"],
  ]);
  if (gitProbe.code !== 0) {
    console.log("skip source-hygiene (not a Git checkout)");
    return true;
  }

  const tracked = await runCommand([
    "source-hygiene:tracked-files",
    "git",
    ["-C", REPO_ROOT, "ls-files", "-z"],
  ]);
  if (tracked.code !== 0) {
    console.log("fail source-hygiene");
    const output = `${tracked.stdout}${tracked.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }

  return reportSourceHygieneResult(parseNulPathList(tracked.stdout), {
    sourceFiles: options.sourceFiles,
  });
}

async function reportSourceHygieneResult(
  trackedPaths: Iterable<string>,
  options: { sourceFiles?: Iterable<SourceFileSnapshot> } = {},
) {
  const offenders = [
    ...findSourceHygieneOffenders(trackedPaths, {
      packageRoot: PACKAGE_ROOT_RELATIVE,
    }),
    ...(await sourceHygienePolicyOffenders({ sourceFiles: options.sourceFiles })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (offenders.length) {
    console.log("fail source-hygiene");
    console.log(indent(formatSourceHygieneOffenders(offenders)));
    return false;
  }

  console.log("ok source-hygiene");
  return true;
}

async function sourceHygienePolicyOffenders(
  options: { sourceFiles?: Iterable<SourceFileSnapshot> } = {},
): Promise<SourceHygieneOffender[]> {
  const offenders: SourceHygieneOffender[] = [];

  try {
    await fsp.access(path.join(ROOT, ".prettierrc"));
    offenders.push({
      path: `${PACKAGE_ROOT_RELATIVE}/.prettierrc`,
      reason: "stale formatter config: package scripts use oxfmt",
    });
  } catch {}

  for (const [ignoreRoot, sentinel] of requiredRootIgnoreSentinels) {
    const ignored = await runCommand([
      `source-hygiene:ignore:${ignoreRoot}`,
      "git",
      ["-C", REPO_ROOT, "check-ignore", "-q", sentinel],
    ]);
    if (ignored.code !== 0) {
      offenders.push({
        path: sentinel,
        reason: `root .gitignore should ignore ${ignoreRoot}`,
      });
    }
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  } catch (error) {
    offenders.push({
      path: `${PACKAGE_ROOT_RELATIVE}/package.json`,
      reason: `package metadata could not be read: ${String(error)}`,
    });
    return offenders;
  }

  const engines = recordValue(pkg.engines);
  const nodeEngine = stringValue(engines?.node);
  if (!/>=\s*24/.test(nodeEngine)) {
    offenders.push({
      path: `${PACKAGE_ROOT_RELATIVE}/package.json`,
      reason: 'package metadata should include "engines": { "node": ">=24" }',
    });
  }

  const dependencies = recordValue(pkg.dependencies);
  const runtimeDashboardDependencies = dashboardBuildDependencies.filter(
    (name) => dependencies && Object.hasOwn(dependencies, name),
  );
  for (const name of runtimeDashboardDependencies) {
    offenders.push({
      path: `${PACKAGE_ROOT_RELATIVE}/package.json`,
      reason: `${name} is a dashboard build dependency and should be in devDependencies`,
    });
  }

  const sourceFiles = options.sourceFiles ?? (await readSourceHygieneSourceFiles());
  offenders.push(...findLooseObjectCompatibilityOffenders(sourceFiles));

  return offenders;
}

async function readSourceHygieneSourceFiles(): Promise<SourceFileSnapshot[]> {
  const roots = ["lib", "scripts", "tests", "dashboard/src"];
  const snapshots: SourceFileSnapshot[] = [];
  for (const root of roots) {
    const absoluteRoot = path.join(ROOT, root);
    for (const filePath of await listSourceFiles(absoluteRoot)) {
      snapshots.push({
        content: await fsp.readFile(filePath, "utf8"),
        path: normalizePathForGit(path.relative(REPO_ROOT, filePath)),
      });
    }
  }
  return snapshots;
}

async function listSourceFiles(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const name of names) {
    const entryPath = path.join(root, name);
    const stat = await fsp.stat(entryPath);
    if (stat.isDirectory()) {
      if (name === "dist" || name === "node_modules") continue;
      files.push(...(await listSourceFiles(entryPath)));
    } else if (stat.isFile() && name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}
