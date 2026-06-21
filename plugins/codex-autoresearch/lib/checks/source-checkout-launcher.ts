import fsp from "node:fs/promises";
import path from "node:path";
import { indent, REPO_ROOT, ROOT, runCommand } from "./check-common.js";

const sourceCheckoutLauncherPaths = [
  "plugins/codex-autoresearch/scripts/bootstrap-runtime.mjs",
  "plugins/codex-autoresearch/scripts/autoresearch.mjs",
  "plugins/codex-autoresearch/scripts/release-integrity.mjs",
];

export async function runSourceCheckoutLauncherCheck() {
  console.log("\n== source checkout ==");
  const missing = [];
  for (const file of sourceCheckoutLauncherPaths) {
    try {
      await fsp.access(path.join(REPO_ROOT, file));
    } catch {
      missing.push(file);
    }
  }

  if (missing.length) {
    console.log("fail source-launcher-files");
    console.log(indent(`Missing source checkout launcher files:\n${missing.join("\n")}`));
    return false;
  }

  const gitProbe = await runCommand([
    "git-probe",
    "git",
    ["-C", REPO_ROOT, "rev-parse", "--is-inside-work-tree"],
  ]);
  if (gitProbe.code !== 0) {
    console.log("ok source-launcher-files");
    console.log("skip source-launcher-committable (not a Git checkout)");
    return true;
  }

  const committable = await runCommand([
    "source-launcher-committable",
    "git",
    [
      "-C",
      REPO_ROOT,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...sourceCheckoutLauncherPaths,
    ],
  ]);
  if (committable.code !== 0) {
    console.log("ok source-launcher-files");
    console.log("fail source-launcher-committable");
    const output = `${committable.stdout}${committable.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }
  const committablePaths = new Set(committable.stdout.split(/\r?\n/).filter(Boolean));
  const ignoredOrInvisible = sourceCheckoutLauncherPaths.filter(
    (file) => !committablePaths.has(file),
  );
  if (ignoredOrInvisible.length) {
    console.log("ok source-launcher-files");
    console.log("fail source-launcher-committable");
    console.log(
      indent(
        `Launcher files are present but ignored or invisible to Git:\n${ignoredOrInvisible.join("\n")}`,
      ),
    );
    return false;
  }

  const trackedDist = await runCommand([
    "source-dist-untracked",
    "git",
    ["-C", REPO_ROOT, "ls-files", "--", "plugins/codex-autoresearch/dist"],
  ]);
  if (trackedDist.code !== 0) {
    console.log("ok source-launcher-files");
    console.log("ok source-launcher-committable");
    console.log("fail source-dist-untracked");
    const output = `${trackedDist.stdout}${trackedDist.stderr}`.trim();
    if (output) console.log(indent(output));
    return false;
  }
  if (trackedDist.stdout.trim()) {
    console.log("ok source-launcher-files");
    console.log("ok source-launcher-committable");
    console.log("fail source-dist-untracked");
    console.log(indent(`Generated dist files are still tracked:\n${trackedDist.stdout.trim()}`));
    return false;
  }

  const ignoredDist = await runCommand([
    "source-dist-ignored",
    "git",
    ["-C", REPO_ROOT, "check-ignore", "-q", "plugins/codex-autoresearch/dist/__codex_check__.mjs"],
  ]);
  if (ignoredDist.code !== 0) {
    console.log("ok source-launcher-files");
    console.log("ok source-launcher-committable");
    console.log("ok source-dist-untracked");
    console.log("fail source-dist-ignored");
    console.log(indent("plugins/codex-autoresearch/dist/ is not ignored."));
    return false;
  }

  const runtimeDocs = await sourceRuntimeDocsProblems();
  if (runtimeDocs.length) {
    console.log("ok source-launcher-files");
    console.log("ok source-launcher-committable");
    console.log("ok source-dist-untracked");
    console.log("ok source-dist-ignored");
    console.log("fail source-runtime-docs");
    console.log(indent(runtimeDocs.join("\n")));
    return false;
  }

  console.log("ok source-launcher-files");
  console.log("ok source-launcher-committable");
  console.log("ok source-dist-untracked");
  console.log("ok source-dist-ignored");
  console.log("ok source-runtime-docs");
  return true;
}

async function sourceRuntimeDocsProblems(): Promise<string[]> {
  const requiredDocs: Array<[string, string[]]> = [
    ["docs/maintainers.md", ["dist/", "bootstrap-runtime", "Installed cache drift"]],
    ["docs/troubleshooting.md", ["Source checkout missing `dist/`", "Installed runtime drift"]],
  ];
  const problems: string[] = [];
  for (const [file, expected] of requiredDocs) {
    let content = "";
    try {
      content = await fsp.readFile(path.join(ROOT, file), "utf8");
    } catch (error) {
      problems.push(`${file} could not be read: ${String(error)}`);
      continue;
    }
    for (const text of expected) {
      if (!content.includes(text)) problems.push(`${file} should mention ${text}`);
    }
  }
  return problems;
}
