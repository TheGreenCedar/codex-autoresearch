import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  commitReferencesMatch,
  finalizationPlanFingerprint,
  readAutoresearchLedger,
} from "../lib/finalization-plan.js";
import { finalizePreview } from "../lib/finalize-preview.js";
import { resolvePackageRoot } from "../lib/runtime-paths.js";
import { isAutoresearchSessionArtifact } from "../lib/session-artifacts.js";
import { AUTORESEARCH_DASHBOARD_FILE, AUTORESEARCH_SESSION_FILES } from "../lib/session-paths.js";
import {
  configureTestGitRepo,
  runProcess,
  testGitArgs,
  withTempDir as withNamedTempDir,
} from "./helpers/process.js";
import test from "./helpers/sharded-test.js";

const pluginRoot = resolvePackageRoot(import.meta.url);
const finalizer = path.join(pluginRoot, "scripts", "finalize-autoresearch.mjs");
const cli = path.join(pluginRoot, "scripts", "autoresearch.mjs");

async function run(command, args, cwd, allowFailure = false) {
  const result = await runProcess(command, args, cwd);
  if (!allowFailure && result.code !== 0) {
    const commandLine = command + " " + args.join(" ");
    throw new Error(commandLine + " failed:\n" + result.stdout + result.stderr);
  }
  return result;
}

async function git(args, cwd) {
  const result = await run("git", testGitArgs(args), cwd);
  if (args[0] === "init") await configureTestGitRepo(cwd);
  return result;
}

async function writeFile(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents, "utf8");
}

async function withTempRoot(prefix, body) {
  return await withNamedTempDir(prefix.replace(/-$/, ""), "root", body);
}

function testWithTempRoot(name, prefix, body) {
  test(name, async () => {
    await withTempRoot(prefix, body);
  });
}

test("finalizer CLI validates aliases, booleans, unknown options, and debug stacks", async () => {
  const help = await run(process.execPath, [finalizer, "-h"], pluginRoot, true);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Finalize an autoresearch branch/);

  const aliases = await run(
    process.execPath,
    [finalizer, "plan", "--workingDir=repo path", "--collapseOverlap=false", "--help"],
    pluginRoot,
    true,
  );
  assert.equal(aliases.code, 0, aliases.stderr);

  for (const args of [
    ["--help", "plan"],
    ["--debug", "plan", "--help"],
  ]) {
    const leading = await run(process.execPath, [finalizer, ...args], pluginRoot, true);
    assert.equal(leading.code, 0, leading.stderr);
    assert.match(leading.stdout, /Finalize an autoresearch branch/);
  }

  for (const args of [
    ["plan", "--bogus"],
    ["plan", "--collapse-overlap=perhaps"],
    ["plan", "--collapse-overlap", "perhaps"],
    ["--collapse-overlap", "perhaps", "plan"],
  ]) {
    const result = await run(process.execPath, [finalizer, ...args], pluginRoot, true);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /\n\s+at\s/);
    assert.doesNotMatch(
      result.stderr,
      new RegExp(pluginRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    );
  }

  const debug = await run(
    process.execPath,
    [finalizer, "plan", "--bogus", "--debug"],
    pluginRoot,
    true,
  );
  assert.equal(debug.code, 1, debug.stderr);
  assert.match(debug.stderr, /\n\s+at\s/);

  const leadingDebug = await run(
    process.execPath,
    [finalizer, "--debug", "missing.groups.json"],
    pluginRoot,
    true,
  );
  assert.equal(leadingDebug.code, 1, leadingDebug.stderr);
  assert.match(leadingDebug.stderr, /\n\s+at\s/);

  for (const option of ["cwd", "output", "goal", "trunk"]) {
    const missingValue = await run(
      process.execPath,
      [finalizer, `--${option}`, "--debug", "plan"],
      pluginRoot,
      true,
    );
    assert.equal(missingValue.code, 1, missingValue.stderr);
    assert.match(missingValue.stderr, new RegExp(`${option}.*argument missing`, "i"));
    assert.match(missingValue.stderr, /\n\s+at\s/);
  }

  const debugThenMalformed = await run(
    process.execPath,
    [finalizer, "plan", "--bogus", "--debug=true", "--debug=perhaps"],
    pluginRoot,
    true,
  );
  assert.equal(debugThenMalformed.code, 1, debugThenMalformed.stderr);
  assert.match(debugThenMalformed.stderr, /\n\s+at\s/);
});

test("session artifact modes preserve finalization, dirty tree, and source checkout policy", () => {
  const cases: Array<[string, boolean, boolean, boolean]> = [
    ["autoresearch.jsonl", true, true, true],
    ["autoresearch-dashboard.html", true, true, true],
    ["autoresearch.research/study/quality-gaps.md", true, true, true],
    [".git/autoresearch-runtime/state.json", true, true, true],
    ["autoresearch-finalize/scratch.groups.json", true, true, true],
    [".gitattributes", false, true, false],
    ["src/autoresearch-dashboard.html", false, false, false],
    ["src/value.txt", false, false, false],
  ];
  for (const [file, finalization, dirtyTree, sourceCheckout] of cases) {
    assert.equal(
      isAutoresearchSessionArtifact(file, "finalization"),
      finalization,
      `${file} finalization`,
    );
    assert.equal(
      isAutoresearchSessionArtifact(file, "dirty-tree"),
      dirtyTree,
      `${file} dirty-tree`,
    );
    assert.equal(
      isAutoresearchSessionArtifact(file, "source-checkout"),
      sourceCheckout,
      `${file} source-checkout`,
    );
  }

  for (const file of [...AUTORESEARCH_SESSION_FILES, AUTORESEARCH_DASHBOARD_FILE]) {
    assert.equal(isAutoresearchSessionArtifact(file, "finalization"), true, `${file} constant`);
    assert.equal(isAutoresearchSessionArtifact(file, "dirty-tree"), true, `${file} dirty-tree`);
    assert.equal(
      isAutoresearchSessionArtifact(file, "source-checkout"),
      true,
      `${file} source-checkout`,
    );
  }
});

testWithTempRoot(
  "finalization plan helpers keep fingerprint and ledger contracts stable",
  "autoresearch-finalization-plan-",
  async (root) => {
    const fullHash = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(commitReferencesMatch(fullHash.slice(0, 12), fullHash), true);
    assert.equal(commitReferencesMatch(fullHash.slice(0, 12).toUpperCase(), fullHash), true);
    assert.equal(commitReferencesMatch(fullHash.slice(0, 6), fullHash), false);
    assert.equal(commitReferencesMatch(`${fullHash.slice(0, 12)}not-a-hash`, fullHash), false);
    assert.equal(commitReferencesMatch(`${fullHash}abcd`, fullHash), false);

    const plan = {
      source_branch: "codex/autoresearch",
      planned_at: "ignored",
      base: "base",
      trunk: "main",
      final_tree: "head",
      goal: "goal",
      kept_commits: ["abc"],
      kept_run_count: 1,
      excluded_commits: [{ commit: "def", status: "discard", subject: "Discarded" }],
      excluded_commit_count: 1,
      overlap_files: ["src/a.ts"],
      current_tree_coverage: {
        review_unit: "current_tree",
        file_count: 1,
        all_file_count: 2,
        exclude_session_artifacts: true,
        include_session_artifacts: false,
        included_files: ["src/a.ts"],
        excluded_session_artifacts: ["autoresearch.jsonl"],
        current_tree_fingerprint: "tree-fingerprint",
      },
      groups: [
        {
          title: "Change",
          body: "ignored",
          last_commit: "abc",
          slug: "change",
          files: ["src/a.ts"],
          source_groups: [
            {
              title: "ignored",
              last_commit: "abc",
              parent_commit: "base",
              files: ["src/a.ts"],
            },
          ],
        },
      ],
    };
    assert.equal(
      finalizationPlanFingerprint({ ...plan, warnings: ["ignored"] }),
      finalizationPlanFingerprint(plan),
    );
    assert.notEqual(
      finalizationPlanFingerprint({
        ...plan,
        groups: [{ ...plan.groups[0], files: ["src/a.ts", "src/b.ts"] }],
      }),
      finalizationPlanFingerprint(plan),
    );
    assert.notEqual(
      finalizationPlanFingerprint({
        ...plan,
        product_claim_coverage: {
          productGradeReady: true,
          maturity: "product_grade",
          missingRequiredProof: [],
          requirements: [],
        },
      }),
      finalizationPlanFingerprint({
        ...plan,
        product_claim_coverage: {
          productGradeReady: false,
          maturity: "experimental",
          missingRequiredProof: [
            { id: "retrieval_accuracy", label: "Retrieval accuracy validation" },
          ],
          requirements: [{ id: "retrieval_accuracy", label: "Retrieval accuracy validation" }],
        },
      }),
    );

    await writeFile(path.join(root, "autoresearch.jsonl"), "{ not json\n");
    await assert.rejects(
      () => readAutoresearchLedger(root, { mode: "silent-empty" }),
      /Corrupt autoresearch\.jsonl at line 1/,
    );
    await assert.rejects(
      () => readAutoresearchLedger(root, { mode: "strict" }),
      /Corrupt autoresearch\.jsonl at line 1/,
    );

    await writeFile(path.join(root, "autoresearch.jsonl"), '{}\n\n"wrong shape"\n');
    await assert.rejects(
      () => readAutoresearchLedger(root, { mode: "strict" }),
      /Corrupt autoresearch\.jsonl at line 3 .*Observed JSON kind: string.*ledger-doctor/,
    );
  },
);

testWithTempRoot(
  "finalize-preview fails on corrupt autoresearch ledger",
  "autoresearch-finalize-preview-corrupt-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src.txt"), "initial\n");
    await git(["add", "src.txt"], repo);
    await git(["commit", "-m", "initial"], repo);
    await writeFile(path.join(repo, "autoresearch.jsonl"), "{ not json\n");

    await assert.rejects(
      () => finalizePreview({ cwd: repo, trunk: "main" }),
      /Corrupt autoresearch\.jsonl at line 1/,
    );

    const result = await run(
      process.execPath,
      [cli, "finalize-preview", "--cwd", repo, "--trunk", "main"],
      repo,
      true,
    );
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Corrupt autoresearch\.jsonl at line 1/);
  },
);

testWithTempRoot(
  "finalization treats review-required keeps as provisional until ASI acknowledgement",
  "autoresearch-finalize-review-required-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "base.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-review-required"], repo);
    await writeFile(path.join(repo, "src", "review-required.txt"), "review\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "review required keep"], repo);
    const reviewHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "acknowledged.txt"), "ack\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "acknowledged keep"], repo);
    const acknowledgedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "review required loop",
          metricName: "quality_gap",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          evidenceStatus: "accepted",
          metric: 0,
          metrics: { quality_gap: 0, review_required: 1 },
          description: "Review required keep",
          commit: reviewHash,
        }),
        JSON.stringify({
          run: 2,
          status: "keep",
          evidenceStatus: "accepted",
          metric: 0,
          metrics: { quality_gap: 0, review_required: 1 },
          asi: { review_acknowledged: true },
          description: "Acknowledged review keep",
          commit: acknowledgedHash,
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const preview = await finalizePreview({ cwd: repo, trunk: "main" });
    assert.equal(preview.groups.length, 1);
    assert.equal(preview.groups[0].commit, acknowledgedHash);
    assert.notEqual(preview.groups[0].commit, reviewHash);
  },
);

testWithTempRoot(
  "product-grade finalization preview blocks under-proven retrieval claims",
  "autoresearch-product-grade-preview-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "retrieval.ts"), "export const value = 'base';\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/retrieval-product-claim"], repo);
    await writeFile(
      path.join(repo, "src", "retrieval.ts"),
      "export const value = 'bounded foreground embedding';\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "bound foreground embedding work"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "semantic retrieval",
          goal: "Deliver a shippable lazy semantic retrieval performance improvement.",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "Bound foreground embedding work.",
          evidence: "foreground embedding work can be bounded",
          commit: kept,
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const preview = await finalizePreview({ cwd: repo, trunk: "main" });
    assert.equal(preview.productGradeReady, false);
    assert.match(preview.blockers.join("\n"), /retrieval accuracy/i);
    assert.match(preview.blockers.join("\n"), /lazy/i);
    assert.doesNotMatch(preview.summary, /ready to merge|shippable/i);

    const planPath = path.join(root, "groups.json");
    const planResult = await run(
      process.execPath,
      [finalizer, "plan", "--cwd", repo, "--output", planPath, "--goal", "retrieval-claim"],
      repo,
    );
    assert.match(
      planResult.stdout,
      /Experimental review branch only: product-grade proof is missing\./,
    );
    const plan = JSON.parse(await fsp.readFile(planPath, "utf8"));
    assert.equal(plan.product_grade_ready, false);
    assert.equal(
      plan.product_grade_summary,
      "Experimental review branch only: product-grade proof is missing.",
    );
  },
);

testWithTempRoot(
  "finalizer writes an ignored review summary and preserves verification",
  "autoresearch-finalize-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    if (process.platform === "win32") await git(["config", "core.autocrlf", "true"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await writeFile(path.join(repo, "src", "other.txt"), "base other\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/autoresearch-test"], repo);
    await writeFile(path.join(repo, "src", "space path.txt"), "kept\n");
    await writeFile(
      path.join(repo, "scripts", "autoresearch.ts"),
      "console.log('legitimate source change');\n",
    );
    await writeFile(
      path.join(repo, "autoresearch-dashboard.html"),
      "<html>ignored export</html>\n",
    );
    await writeFile(path.join(repo, "autoresearch.md"), "# session\n");
    await writeFile(
      path.join(repo, "autoresearch.research", "study", "quality-gaps.md"),
      "- [ ] session scratchpad\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "keep value change"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "ux-test",
          groups: [
            {
              title: "Keep value change",
              body: "Exercise finalization report generation.",
              last_commit: finalTree,
              slug: "value-change",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo);
    assert.match(result.stdout, /Review summary: .+autoresearch-finalize.+\.md/);
    assert.match(result.stdout, /Review branches:/);
    assert.match(result.stdout, /autoresearch-review\/ux-test\/01-value-change \(created\)/);
    assert.match(result.stdout, /Cleanup after verified merge/);
    assert.doesNotMatch(result.stdout, /git branch -D/);
    assert.doesNotMatch(result.stdout, /Remove-Item/);
    assert.doesNotMatch(result.stdout, /rm -rf/);

    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("Review summary: "));
    const summaryPath = summaryLine.slice("Review summary: ".length).trim();
    const summary = await fsp.readFile(summaryPath, "utf8");

    assert.match(summary, /Status: verified/);
    assert.match(summary, /\| # \| Branch \| Provenance \| Title \| Files \|/);
    assert.match(summary, /\| 1 \| `autoresearch-review\/ux-test\/01-value-change` \| created \|/);
    assert.match(summary, /autoresearch-review\/ux-test\/01-value-change/);
    assert.match(summary, /git show --stat 'autoresearch-review\/ux-test\/01-value-change'/);
    assert.match(summary, /git diff [^\n]+ -- 'scripts\/autoresearch\.ts' 'src\/space path\.txt'/);
    assert.match(summary, /src\/space path\.txt/);
    assert.match(summary, /scripts\/autoresearch\.ts/);
    assert.match(summary, /Suggested PR/);
    assert.match(summary, /git show --stat/);
    assert.match(summary, /## Finalization Runway/);
    assert.match(
      summary,
      /Final file set: .*scripts\/autoresearch\.ts.*src\/space path\.txt|Final file set: .*src\/space path\.txt.*scripts\/autoresearch\.ts/,
    );
    assert.match(summary, /Cleanup commands are intentionally omitted/);
    assert.match(summary, /until the review branches have been merged into trunk/);
    assert.match(summary, /autoresearch\.last-run\.json/);
    assert.match(summary, /autoresearch-dashboard\.html/);
    assert.doesNotMatch(summary, /git branch -D/);
    assert.doesNotMatch(summary, /Remove-Item/);
    assert.doesNotMatch(summary, /rm -rf/);
    const runwayOrder = [
      "Preview groups and risks",
      "Approve the review branch plan",
      "Create review branches",
      "Verify union",
      "Merge the review branches",
      "Cleanup source branches",
    ].map((text) => summary.indexOf(text));
    assert.ok(
      runwayOrder.every((index) => index >= 0),
      runwayOrder.join(", "),
    );
    assert.deepEqual(
      runwayOrder,
      [...runwayOrder].sort((a, b) => a - b),
    );

    const branchFiles = (
      await git(
        ["show", "--name-only", "--format=", "autoresearch-review/ux-test/01-value-change"],
        repo,
      )
    ).stdout;
    assert.doesNotMatch(branchFiles, /autoresearch\.research/);
    assert.doesNotMatch(branchFiles, /autoresearch-dashboard\.html/);

    const reusedResult = await run(process.execPath, [finalizer, groupsPath], repo);
    assert.match(reusedResult.stdout, /autoresearch-review\/ux-test\/01-value-change \(reused\)/);
    const reusedSummaryLine = reusedResult.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("Review summary: "));
    const reusedSummary = await fsp.readFile(
      reusedSummaryLine.slice("Review summary: ".length).trim(),
      "utf8",
    );
    assert.match(
      reusedSummary,
      /\| 1 \| `autoresearch-review\/ux-test\/01-value-change` \| reused \|/,
    );

    const status = (await run("git", ["status", "--porcelain"], repo)).stdout.trim();
    assert.equal(status, "");
  },
);

testWithTempRoot(
  "finalizer rejects wildcard Git pathspecs in plan files",
  "autoresearch-finalize-pathspec-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "a.txt"), "base\n");
    await writeFile(path.join(repo, "b.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/pathspec-plan"], repo);
    await writeFile(path.join(repo, "a.txt"), "kept\n");
    await git(["commit", "-am", "keep a"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "pathspec-plan",
          groups: [
            {
              title: "Pathspec plan",
              body: "Should reject wildcard expansion.",
              last_commit: finalTree,
              slug: "pathspec-plan",
              files: ["*.txt"],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /literal.*wildcard|wildcard.*pathspec/i);
    const branches = (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout.trim();
    assert.equal(branches, "");
  },
);

test("finalizer refuses cleanup through linked directory parents", async (t) => {
  await withTempRoot("autoresearch-finalize-linked-parent-", async (root) => {
    const repo = path.join(root, "repo");
    const outside = path.join(root, "outside");
    const linkPath = path.join(repo, "linked-output");
    const outsideVictim = path.join(outside, "victim.txt");
    await fsp.mkdir(repo, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(outsideVictim, "outside data\n", "utf8");

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, ".gitignore"), "linked-output\n");
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/linked-parent-plan"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["commit", "-am", "keep value"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    try {
      await fsp.symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`directory links are unavailable in this environment: ${String(error)}`);
      return;
    }

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "linked-parent-plan",
          groups: [
            {
              title: "Linked parent plan",
              body: "Should not delete outside the repo.",
              last_commit: finalTree,
              slug: "linked-parent-plan",
              files: ["linked-output/victim.txt"],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /outside the working directory/);
    assert.equal(await fsp.readFile(outsideVictim, "utf8"), "outside data\n");
    const branches = (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout.trim();
    assert.equal(branches, "");
  });
});

testWithTempRoot(
  "finalizer refuses existing review branch with same files but stale content",
  "finalize-stale-review-branch-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init"], repo);
    await git(["config", "user.email", "codex@example.test"], repo);
    await git(["config", "user.name", "Codex"], repo);
    await fsp.mkdir(path.join(repo, "src"), { recursive: true });
    await fsp.writeFile(path.join(repo, "src", "value.txt"), "base\n", "utf8");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "base"], repo);
    await git(["branch", "-M", "main"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/session"], repo);
    await fsp.writeFile(path.join(repo, "src", "value.txt"), "planned\n", "utf8");
    await git(["commit", "-am", "planned value"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "--detach", base], repo);
    await git(["switch", "-c", "autoresearch-review/stale-test/01-planned-value"], repo);
    await fsp.writeFile(path.join(repo, "src", "value.txt"), "stale\n", "utf8");
    await git(["commit", "-am", "stale review value"], repo);
    await git(["switch", "codex/session"], repo);

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "stale-test",
          groups: [
            {
              title: "Planned value",
              body: "Exercise stale branch detection.",
              last_commit: finalTree,
              slug: "planned-value",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr + result.stdout,
      /divergent|differs from the planned review content/i,
    );
  },
);

testWithTempRoot(
  "finalizer rollback preserves pre-existing equivalent, divergent, and verification branches",
  "finalize-owned-branches-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await writeFile(path.join(repo, "src", "a.txt"), "base a\n");
    await writeFile(path.join(repo, "src", "b.txt"), "base b\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/ownership-test"], repo);
    await writeFile(path.join(repo, "src", "a.txt"), "planned a\n");
    await git(["commit", "-am", "planned a"], repo);
    const first = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeFile(path.join(repo, "src", "b.txt"), "planned b\n");
    await git(["commit", "-am", "planned b"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const equivalent = "autoresearch-review/ownership-test/01-planned-a";
    await git(["switch", "--detach", base], repo);
    await git(["switch", "-c", equivalent], repo);
    await writeFile(path.join(repo, "src", "a.txt"), "planned a\n");
    await git(["commit", "-am", "existing equivalent review"], repo);
    const equivalentHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const divergent = "autoresearch-review/ownership-test/02-planned-b";
    await git(["switch", "--detach", base], repo);
    await git(["switch", "-c", divergent], repo);
    await writeFile(path.join(repo, "src", "b.txt"), "wrong b\n");
    await git(["commit", "-am", "existing divergent review"], repo);
    const divergentHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const verificationCollision = "autoresearch-review/ownership-test/verify-planned-a";
    await git(["branch", verificationCollision, base], repo);
    const verificationHead = (await git(["rev-parse", verificationCollision], repo)).stdout.trim();
    await git(["switch", "codex/ownership-test"], repo);

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "ownership-test",
          groups: [
            {
              title: "Planned a",
              body: "Reuse the equivalent branch.",
              last_commit: first,
              slug: "planned-a",
            },
            {
              title: "Planned b",
              body: "Reject the divergent branch.",
              last_commit: finalTree,
              slug: "planned-b",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /divergent/i);
    assert.equal((await git(["rev-parse", equivalent], repo)).stdout.trim(), equivalentHead);
    assert.equal((await git(["rev-parse", divergent], repo)).stdout.trim(), divergentHead);
    assert.equal(
      (await git(["rev-parse", verificationCollision], repo)).stdout.trim(),
      verificationHead,
    );
    const verificationBranches = (
      await git(["branch", "--list", "autoresearch-review/ownership-test/verify-*"], repo)
    ).stdout
      .trim()
      .replace(/^\*?\s*/, "");
    assert.equal(verificationBranches, verificationCollision);
    assert.equal(
      (await git(["branch", "--show-current"], repo)).stdout.trim(),
      "codex/ownership-test",
    );
  },
);

testWithTempRoot(
  "finalizer makes source restoration and temporary cleanup failures blocking",
  "finalize-restore-failure-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const sourceBranch = "codex/restore-test";
    await git(["switch", "-c", sourceBranch], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "planned\n");
    await git(["commit", "-am", "planned value"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const hooks = path.join(root, "hooks");
    const postCommit = path.join(hooks, "post-commit");
    await writeFile(
      postCommit,
      `#!/bin/sh\ngit branch -D ${sourceBranch} >/dev/null 2>&1 || true\n`,
    );
    await fsp.chmod(postCommit, 0o755);
    await git(["config", "core.hooksPath", hooks.replace(/\\/g, "/")], repo);

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "restore-test",
          groups: [
            {
              title: "Planned value",
              body: "Force source restoration failure after branch creation.",
              last_commit: finalTree,
              slug: "planned-value",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
    const output = result.stderr + result.stdout;
    assert.notEqual(result.code, 0);
    assert.match(output, /Source branch restoration failed|Verification state restoration failed/);
    assert.match(output, /git switch codex\/restore-test failed/);
    assert.match(output, /Temporary branch cleanup failed/);
  },
);

testWithTempRoot(
  "finalize preview blocks unlogged non-session commits from the final tree",
  "autoresearch-finalize-preview-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-preview"], repo);
    await writeFile(path.join(repo, "src", "guardrails.txt"), "leakage guard\n");
    await git(["add", "src/guardrails.txt"], repo);
    await git(["commit", "-m", "add leakage guardrails"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "preview",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.finalTreeCoverage.covered, false);
    assert.equal(payload.excludedCommits.length, 1);
    assert.match(payload.warnings.join("\n"), /Excluded 1 unkept non-session commit/);
    assert.deepEqual(payload.excludedCommits[0].files, ["src/guardrails.txt"]);
  },
);

testWithTempRoot(
  "finalize preview suggested plan command keeps the target cwd",
  "autoresearch-finalize-preview-cwd-",
  async (root) => {
    const repo = path.join(root, "repo");
    const otherCwd = path.join(root, "other-cwd");
    await fsp.mkdir(repo, { recursive: true });
    await fsp.mkdir(otherCwd, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-preview-cwd"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "preview cwd",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept,
        }),
        "",
      ].join("\n"),
    );

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    const command = payload.suggestedCommands.finalizerPlan.argv;
    assert.deepEqual(command.slice(0, 5), [process.execPath, finalizer, "plan", "--cwd", repo]);

    const result = await run(command[0], command.slice(1), otherCwd);
    assert.match(result.stdout, /Wrote draft groups/);

    const outputFlag = command.indexOf("--output");
    assert.ok(outputFlag > -1);
    const plan = JSON.parse(await fsp.readFile(command[outputFlag + 1], "utf8"));
    assert.equal(plan.source_branch, "codex/autoresearch-preview-cwd");
    assert.equal(plan.final_tree, kept);
    assert.equal(plan.groups[0].last_commit, kept);
  },
);

testWithTempRoot(
  "finalize preview refuses hard decision capsules",
  "autoresearch-finalize-capsule-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    await git(["switch", "-c", "codex/autoresearch-capsule"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          timestamp: "2026-06-01T13:00:00.000Z",
          name: "preview",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          timestamp: "2026-06-01T13:05:00.000Z",
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repo, "autoresearch.research", "benchmark-contract", "decision-capsule.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "session-decision-capsule",
        status: "active",
        enforcement: {
          mode: "hard-block",
          canRunNextPacket: false,
          allowBoundedNext: false,
          blocksFinalization: true,
          clearingCondition: "Run benchmark-lint successfully before finalization.",
          commandHint: "node scripts/autoresearch.mjs benchmark-lint --cwd <project>",
          triggeredBy: ["sessionDecisionCapsule", "benchmarkContract"],
        },
        bottleneck: "Benchmark wrapper cannot prove the primary METRIC.",
        evidence: ["benchmark-lint timed out and parsed zero primary METRIC lines."],
        nextExperiment: "Repair benchmark-lint until the primary METRIC is emitted.",
        wrongNextActions: ["Do not run next or finalize."],
        doNotRepeat: [],
        commandBudgetWarnings: [],
        generatedFrom: {
          compactions: 0,
          first: "2026-06-01T13:00:00.000Z",
          last: "2026-06-01T13:10:00.000Z",
          toolCounts: {},
          topCommandHeads: [],
        },
        importedAt: "2026-06-01T13:10:00.000Z",
      }),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const payload = await finalizePreview({ cwd: repo, trunk: "main" });
    assert.equal(payload.ready, false);
    assert.equal(payload.sessionDecisionCapsule.kind, "session-decision-capsule");
    assert.match(payload.nextAction, /Repair benchmark-lint/);
    assert.match(payload.warnings.join("\n"), /primary METRIC/);
  },
);

testWithTempRoot(
  "finalize preview blocks kept commits that were later explicitly invalidated",
  "autoresearch-finalize-discard-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-discard"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "discarded keep",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        JSON.stringify({
          run: 2,
          status: "discard",
          metric: 1,
          description: "invalidated evaluator contamination for kept metric improvement",
          commit: kept.slice(0, 12),
          asi: { rollback_reason: "Evaluator contamination invalidated the keep." },
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log invalidation"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.semanticSafety.ok, false);
    assert.ok(
      payload.semanticSafety.blockers.some((blocker) => blocker.code === "later_invalidated_keep"),
    );
    assert.match(payload.warnings.join("\n"), /discarded|invalidated/i);
  },
);

testWithTempRoot(
  "finalize preview allows ordinary same-commit discard rollback",
  "autoresearch-finalize-normal-discard-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-normal-discard"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "normal discard",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        JSON.stringify({
          run: 2,
          status: "discard",
          metric: 0.9,
          description: "discarded dirty experiment",
          commit: kept.slice(0, 12),
          asi: { rollback_reason: "reverted scoped experiment changes" },
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log ordinary discard"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.semanticSafety.ok, true);
    assert.deepEqual(payload.semanticSafety.blockers, []);
  },
);

testWithTempRoot(
  "finalize preview detects reverted kept commits",
  "autoresearch-finalize-revert-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-revert"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await git(["revert", "--no-edit", kept], repo);

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "reverted keep",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log reverted keep"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.semanticSafety.ok, false);
    assert.ok(payload.semanticSafety.blockers.some((blocker) => blocker.code === "reverted_keep"));
    assert.match(payload.warnings.join("\n"), /reverted/i);
  },
);

testWithTempRoot(
  "finalize preview blocks excluded commits that touch planned files",
  "autoresearch-finalize-overlap-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-overlap-excluded"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept metric improvement"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "value.txt"), "unkept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "unkept overlapping edit"], repo);

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "overlap excluded",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "kept metric improvement",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.finalTreeCoverage.covered, true);
    assert.equal(payload.finalTreeCoverage.excludedPlannedFileConflictCount, 1);
    assert.equal(payload.excludedPlannedFileConflicts.length, 1);
    assert.deepEqual(payload.excludedPlannedFileConflicts[0].files, ["src/value.txt"]);
    assert.match(payload.warnings.join("\n"), /excluded commits touch planned files/i);
  },
);

testWithTempRoot(
  "finalization preserves both hostile paths in a rename",
  "autoresearch-finalize-hostile-rename-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(path.join(repo, "src"), { recursive: true });
    const original =
      process.platform === "win32" ? "src/old 雪.txt" : 'src/ old " -> 雪\\line\n.txt ';
    const current =
      process.platform === "win32" ? "src/new 雪.txt" : 'src/ new " -> 雪\\line\n.txt ';

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, original), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-hostile-rename"], repo);
    await fsp.rename(path.join(repo, original), path.join(repo, current));
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "rename hostile path"], repo);
    const kept = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "hostile rename",
          metricName: "score",
          bestDirection: "higher",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "rename hostile path",
          commit: kept.slice(0, 12),
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log kept rename"], repo);

    const preview = await run(process.execPath, [cli, "finalize-preview", "--cwd", repo], repo);
    const payload = JSON.parse(preview.stdout);
    assert.deepEqual(payload.groups[0].files, [current, original].sort());
    assert.equal(payload.finalTreeCoverage.covered, true);

    const planPath = path.join(repo, "groups.json");
    const planned = await run(
      process.execPath,
      [finalizer, "plan", "--cwd", repo, "--output", planPath],
      repo,
    );
    assert.equal(planned.code, 0, planned.stderr);
    const plan = JSON.parse(await fsp.readFile(planPath, "utf8"));
    assert.deepEqual(plan.groups[0].files, [current, original].sort());
  },
);

testWithTempRoot(
  "finalize-current-tree packages the current non-session diff",
  "autoresearch-finalize-current-tree-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-tree"], repo);
    await writeFile(path.join(repo, "src", "guardrails.txt"), "supporting safety change\n");
    await git(["add", "src/guardrails.txt"], repo);
    await git(["commit", "-m", "add supporting guardrails"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await writeFile(
      path.join(repo, "autoresearch-dashboard.html"),
      "<html>session export</html>\n",
    );
    await writeFile(path.join(repo, "autoresearch.jsonl"), "{}\n");
    await writeFile(
      path.join(repo, "autoresearch.research", "study", "quality-gaps.md"),
      "- [ ] gap\n",
    );
    await writeFile(path.join(repo, "autoresearch-finalize", "scratch.groups.json"), "{}\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.progress.stages[0].stage, "finalize-current-tree");
    assert.equal(payload.currentTreeCoverage.covered, true);
    assert.ok(payload.files.includes("src/guardrails.txt"));
    assert.ok(payload.files.includes("src/value.txt"));
    assert.ok(!payload.files.includes("autoresearch-dashboard.html"));
    assert.deepEqual(payload.includedFiles.sort(), ["src/guardrails.txt", "src/value.txt"]);
    assert.deepEqual(payload.excludedFiles.sort(), [
      "autoresearch-dashboard.html",
      "autoresearch-finalize/scratch.groups.json",
      "autoresearch.jsonl",
      "autoresearch.research/study/quality-gaps.md",
    ]);
    assert.match(payload.reviewUnit.message, /current branch tree, not older kept commits/);
    assert.ok(payload.planOutput);
    assert.ok(payload.planFingerprint);
    assert.ok(payload.currentTreeFingerprint);
    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    assert.equal(plan.mode, "current-final-tree");
    assert.ok(plan.plan_fingerprint);
    assert.ok(plan.accepted_evidence_fingerprint?.fingerprint);
    assert.equal(plan.current_tree_coverage.exclude_session_artifacts, true);
    assert.equal(plan.current_tree_coverage.review_unit, "current_tree");
    assert.deepEqual(plan.current_tree_coverage.excluded_session_artifacts.sort(), [
      "autoresearch-dashboard.html",
      "autoresearch-finalize/scratch.groups.json",
      "autoresearch.jsonl",
      "autoresearch.research/study/quality-gaps.md",
    ]);
    assert.deepEqual(plan.groups[0].files.sort(), ["src/guardrails.txt", "src/value.txt"]);

    const finalizeResult = await run(process.execPath, [finalizer, payload.planOutput], repo);
    assert.match(finalizeResult.stdout, /Review branches:/);
  },
);

testWithTempRoot(
  "current-tree finalization plan carries product claim coverage and experimental wording",
  "autoresearch-finalize-current-tree-claim-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "retrieval.ts"), "export const value = 'base';\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/retrieval-current-tree"], repo);
    await writeFile(
      path.join(repo, "src", "retrieval.ts"),
      "export const value = 'bounded foreground embedding';\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "bound foreground embedding work"], repo);

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "semantic retrieval",
          goal: "Deliver a shippable lazy semantic retrieval performance improvement.",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "Bound foreground embedding work.",
          evidence: "foreground embedding work can be bounded",
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "log autoresearch session"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, true);
    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    assert.equal(plan.product_grade_ready, false);
    assert.match(plan.product_grade_summary, /Experimental review branch only/i);
    assert.ok(Array.isArray(plan.product_claim_coverage?.missingRequiredProof));
    assert.ok(plan.product_claim_coverage.missingRequiredProof.length > 0);

    const finalizeResult = await run(process.execPath, [finalizer, payload.planOutput], repo);
    assert.match(
      finalizeResult.stdout,
      /Experimental review branch only: product-grade proof is missing\./,
    );
    assert.doesNotMatch(finalizeResult.stdout, /Cleanup After Merge/);
    assert.match(finalizeResult.stdout, /Cleanup after accepted review/i);
  },
);

testWithTempRoot(
  "finalizer rejects current-tree plans when product claim coverage is tampered",
  "autoresearch-finalize-current-tree-claim-tamper-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-tree-tamper"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          goal: "Deliver a shippable lazy semantic retrieval performance improvement.",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 1,
          description: "speed only",
          evidence: "faster",
        }),
        "",
      ].join("\n"),
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    plan.product_claim_coverage.productGradeReady = true;
    plan.product_grade_ready = true;
    plan.product_claim_coverage.missingRequiredProof = [];
    await fsp.writeFile(payload.planOutput, JSON.stringify(plan, null, 2) + "\n", "utf8");

    const stale = await run(process.execPath, [finalizer, payload.planOutput], repo, true);
    assert.notEqual(stale.code, 0);
    assert.match(
      stale.stderr,
      /plan fingerprint does not match contents|product claim coverage does not match/i,
    );
  },
);

testWithTempRoot(
  "finalize-preview progress writes heartbeat lines to stderr without corrupting JSON stdout",
  "autoresearch-finalize-preview-progress-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/progress-preview"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "src/value.txt"], repo);
    await git(["commit", "-m", "kept update"], repo);

    const result = await run(
      process.execPath,
      [cli, "finalize-preview", "--cwd", repo, "--progress"],
      repo,
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.match(result.stderr, /\[autoresearch:finalize-preview]/);
  },
);

testWithTempRoot(
  "finalize-current-tree can explicitly include session artifacts",
  "autoresearch-finalize-current-include-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-include"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await writeFile(
      path.join(repo, "autoresearch-dashboard.html"),
      "<html>session export</html>\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);

    const result = await run(
      process.execPath,
      [cli, "finalize-current-tree", "--cwd", repo, "--include-session-artifacts"],
      repo,
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.currentTreeCoverage.excludeSessionArtifacts, false);
    assert.ok(payload.files.includes("autoresearch-dashboard.html"));
    assert.deepEqual(payload.excludedFiles, []);

    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    assert.equal(plan.current_tree_coverage.exclude_session_artifacts, false);
    assert.equal(plan.current_tree_coverage.include_session_artifacts, true);
    assert.ok(plan.groups[0].files.includes("autoresearch-dashboard.html"));
  },
);

testWithTempRoot(
  "finalize-current-tree refuses dirty source trees without writing a plan",
  "autoresearch-finalize-current-dirty-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-dirty"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);
    await writeFile(path.join(repo, "src", "dirty.txt"), "uncommitted\n");

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.planOutput, "");
    assert.match(payload.warnings.join("\n"), /dirty/i);
  },
);

testWithTempRoot(
  "finalizer rejects stale current-tree plans when coverage is tampered",
  "autoresearch-finalize-current-stale-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-stale"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    const plan = JSON.parse(await fsp.readFile(payload.planOutput, "utf8"));
    plan.current_tree_coverage.included_files = [];
    await fsp.writeFile(payload.planOutput, JSON.stringify(plan, null, 2) + "\n", "utf8");

    const stale = await run(process.execPath, [finalizer, payload.planOutput], repo, true);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /plan fingerprint does not match contents/i);
  },
);

testWithTempRoot(
  "finalizer rejects current-tree plans after the source branch advances",
  "autoresearch-finalize-current-head-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-current-head"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "final tree update"], repo);

    const result = await run(process.execPath, [cli, "finalize-current-tree", "--cwd", repo], repo);
    const payload = JSON.parse(result.stdout);
    await writeFile(path.join(repo, "src", "late.txt"), "late\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "advance source after plan"], repo);

    const stale = await run(process.execPath, [finalizer, payload.planOutput], repo, true);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /current HEAD differs from planned final_tree/i);
  },
);

testWithTempRoot(
  "finalizer rejects crafted plan paths before filesystem deletion",
  "autoresearch-finalize-path-",
  async (root) => {
    const repo = path.join(root, "repo");
    const sentinel = path.join(root, "sentinel.txt");
    await fsp.mkdir(repo, { recursive: true });
    await fsp.writeFile(sentinel, "outside repo\n", "utf8");

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/autoresearch-path"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "keep value"], repo);
    const head = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: head,
          goal: "path-safety",
          groups: [
            {
              title: "Unsafe crafted path",
              last_commit: head,
              files: ["../sentinel.txt"],
              slug: "unsafe",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unsafe finalizer file path/);
    assert.equal(await fsp.readFile(sentinel, "utf8"), "outside repo\n");

    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: head,
          goal: "metadata-safety",
          groups: [
            {
              title: "Unsafe metadata path",
              last_commit: head,
              files: [".git/config"],
              slug: "unsafe-git",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const metadataResult = await run(process.execPath, [finalizer, groupsPath], repo, true);
    assert.notEqual(metadataResult.code, 0);
    assert.match(metadataResult.stderr, /Git metadata/);
    assert.equal(
      (await git(["config", "user.email"], repo)).stdout.trim(),
      "codex@example.invalid",
    );
  },
);

testWithTempRoot(
  "finalizer plan keeps only kept commits and flags excluded history",
  "autoresearch-plan-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "base.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-test"], repo);
    await writeFile(path.join(repo, "src", "kept.txt"), "kept\n");
    await writeFile(
      path.join(repo, "autoresearch-dashboard.html"),
      "<html>ignored export</html>\n",
    );
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "keep value change"], repo);
    const keptHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "discarded.txt"), "discarded\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "discard value change"], repo);
    const discardHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "crash.txt"), "crash\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "crash value change"], repo);
    const crashHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "unlogged.txt"), "unlogged\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "unlogged value change"], repo);
    const unloggedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "speed loop",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 10,
          description: "Kept",
          commit: keptHash,
          asi: { hypothesis: "keep the source file" },
        }),
        JSON.stringify({
          run: 2,
          status: "discard",
          metric: 11,
          description: "Discarded",
          commit: discardHash,
          asi: { rollback_reason: "Regression" },
        }),
        JSON.stringify({
          run: 3,
          status: "crash",
          description: "Crash",
          commit: crashHash,
          asi: { evidence: "crashed" },
        }),
      ].join("\n") + "\n",
    );

    const output = path.join(root, "groups.json");
    const result = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "speed-loop"],
      repo,
    );
    assert.match(result.stdout, /Wrote draft groups/);
    assert.match(result.stdout, /Selected kept commits: 1/);
    assert.match(result.stdout, /Excluded commits: 3/);
    assert.match(result.stdout, /discard value change/);
    assert.match(result.stdout, /crash value change/);
    assert.match(result.stdout, /unlogged/);

    const plan = JSON.parse(await fsp.readFile(output, "utf8"));
    assert.equal(plan.goal, "speed-loop");
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.kept_commits.length, 1);
    assert.equal(plan.excluded_commit_count, 3);
    assert.equal(plan.groups[0].last_commit, keptHash);
    assert.match(plan.groups[0].files.join("\n"), /src\/kept\.txt/);
    assert.deepEqual(plan.excluded_commits.map((item) => item.status).sort(), [
      "crash",
      "discard",
      "unlogged",
    ]);
    assert.doesNotMatch(plan.groups[0].files.join("\n"), /autoresearch-dashboard\.html/);
    assert.match(plan.warnings.join("\n"), /Excluded 3 unkept commits/);
    assert.ok(unloggedHash);
  },
);

testWithTempRoot(
  "finalization ignores rejected keeps while preserving legacy accepted keeps",
  "autoresearch-finalize-evidence-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);
    await writeFile(path.join(repo, "src", "base.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-evidence"], repo);
    await writeFile(path.join(repo, "src", "rejected.txt"), "rejected\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "rejected keep"], repo);
    const rejectedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "superseded.txt"), "superseded\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "superseded keep"], repo);
    const supersededHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "accepted.txt"), "accepted\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "legacy accepted keep"], repo);
    const acceptedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "evidence loop",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          evidenceStatus: "rejected",
          metric: 1,
          description: "Rejected keep",
          commit: rejectedHash,
        }),
        JSON.stringify({
          run: 2,
          status: "keep",
          evidenceStatus: "superseded",
          metric: 0.5,
          description: "Superseded keep",
          commit: supersededHash,
        }),
        JSON.stringify({
          run: 3,
          status: "keep",
          metric: 2,
          description: "Legacy accepted keep",
          commit: acceptedHash,
        }),
      ].join("\n") + "\n",
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "session log"], repo);

    const preview = await finalizePreview({ cwd: repo, trunk: "main" });
    assert.equal(preview.groups.length, 1);
    assert.equal(preview.groups[0].commit, acceptedHash);

    const output = path.join(root, "groups.json");
    const result = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "evidence-loop"],
      repo,
    );
    assert.match(result.stdout, /Selected kept commits: 1/);

    const plan = JSON.parse(await fsp.readFile(output, "utf8"));
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.kept_commits.length, 1);
    assert.equal(plan.groups[0].last_commit, acceptedHash);
    assert.deepEqual(plan.kept_commits, [acceptedHash]);
    assert.equal(
      plan.excluded_commits.some(
        (item) => item.commit === rejectedHash && item.status === "rejected",
      ),
      true,
    );
    assert.equal(
      plan.excluded_commits.some(
        (item) => item.commit === supersededHash && item.status === "superseded",
      ),
      true,
    );
  },
);

testWithTempRoot(
  "finalizer rejects plans after hostile accepted-current evidence changes",
  "autoresearch-finalize-stale-evidence-",
  async (root) => {
    const variants = [
      {
        name: "rejected",
        entry: (commit) => ({
          run: 2,
          status: "keep",
          evidenceStatus: "rejected",
          commit,
          description: "Rejected after review",
        }),
      },
      {
        name: "superseded",
        entry: (commit) => ({
          run: 2,
          status: "keep",
          evidenceStatus: "superseded",
          commit,
          description: "Superseded by later evidence",
        }),
      },
      {
        name: "invalidated",
        entry: (commit) => ({
          run: 2,
          status: "discard",
          commit,
          description: "Invalidated after evaluator contamination",
          asi: { rollback_reason: "Evaluator contamination invalidated the keep." },
        }),
      },
      {
        name: "reverted",
        entry: (commit) => ({
          run: 2,
          status: "discard",
          commit,
          description: "Reverted after verification",
          asi: { rollback_reason: "Reverted the accepted change." },
        }),
      },
    ];

    for (const variant of variants) {
      const { commit, output, repo } = await createEvidencePlanFixture(root, variant.name);
      const plannedHead = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
      await fsp.appendFile(
        path.join(repo, "autoresearch.jsonl"),
        `${JSON.stringify(variant.entry(commit))}\n`,
        "utf8",
      );

      const result = await run(process.execPath, [finalizer, output], repo, true);
      assert.notEqual(result.code, 0, variant.name);
      assert.match(result.stderr, /accepted-current evidence changed/i, variant.name);
      assert.match(result.stderr, /accepted commit membership/i, variant.name);
      assert.match(result.stderr, /evidence status/i, variant.name);
      assert.match(result.stderr, /Regenerate the finalizer plan/i, variant.name);
      assert.equal((await git(["rev-parse", "HEAD"], repo)).stdout.trim(), plannedHead);
      assert.equal(
        (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout.trim(),
        "",
        variant.name,
      );
    }
  },
);

testWithTempRoot(
  "finalizer fingerprints accepted ordering and product-claim inputs but ignores audit-only rows",
  "autoresearch-finalize-evidence-fingerprint-",
  async (root) => {
    const stale = await createEvidencePlanFixture(root, "claim-inputs");
    await fsp.appendFile(
      path.join(stale.repo, "autoresearch.jsonl"),
      `${JSON.stringify({
        run: 2,
        status: "keep",
        evidenceStatus: "accepted",
        commit: stale.commit,
        metric: 0.9,
        description: "Accepted with revised claim evidence",
        evidence: "correctness checks passed",
      })}\n`,
      "utf8",
    );
    const staleResult = await run(process.execPath, [finalizer, stale.output], stale.repo, true);
    assert.notEqual(staleResult.code, 0);
    assert.match(staleResult.stderr, /accepted ledger ordering/i);
    assert.match(staleResult.stderr, /product-claim coverage inputs/i);

    const audit = await createEvidencePlanFixture(root, "audit-only");
    const malformedCommit = `${audit.commit.slice(0, 12)}not-a-hash`;
    await fsp.appendFile(
      path.join(audit.repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "diagnostic",
          status: "discard",
          commit: audit.commit,
          note: "Audit context only",
        }),
        JSON.stringify({
          type: "context",
          status: "keep",
          evidenceStatus: "rejected",
          commit: audit.commit,
          note: "Context only",
        }),
        JSON.stringify({
          type: "run",
          run: 99,
          status: "measure",
          commit: audit.commit,
          metric: 1,
          description: "Audit probe",
        }),
        JSON.stringify({
          type: "run",
          run: 100,
          status: "keep",
          evidenceStatus: "rejected",
          commit: malformedCommit,
          description: "Malformed rejection reference",
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    const auditResult = await run(process.execPath, [finalizer, audit.output], audit.repo);
    assert.match(auditResult.stdout, /Review branches:/);

    const malformedKeep = await createEvidencePlanFixture(root, "malformed-keep", {
      commitRef: (commit) => `${commit.slice(0, 12)}not-a-hash`,
    });
    assert.deepEqual(malformedKeep.plan.kept_commits, []);
    assert.deepEqual(malformedKeep.plan.groups, []);
    assert.equal(malformedKeep.plan.excluded_commits[0]?.status, "unlogged");
  },
);

async function createEvidencePlanFixture(root, name, options = {}) {
  const repo = path.join(root, name);
  await fsp.mkdir(repo, { recursive: true });
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "codex@example.invalid"], repo);
  await git(["config", "user.name", "Codex Test"], repo);
  await writeFile(path.join(repo, ".gitignore"), "autoresearch.jsonl\n");
  await writeFile(path.join(repo, "src", "value.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);
  await git(["switch", "-c", `codex/${name}`], repo);
  await writeFile(path.join(repo, "src", "value.txt"), "accepted\n");
  await git(["add", "src/value.txt"], repo);
  await git(["commit", "-m", "accepted change"], repo);
  const commit = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
  await writeFile(
    path.join(repo, "autoresearch.jsonl"),
    [
      JSON.stringify({
        type: "config",
        goal: "Deliver a shippable correctness improvement.",
      }),
      JSON.stringify({
        run: 1,
        status: "keep",
        evidenceStatus: "accepted",
        metric: 1,
        commit: options.commitRef ? options.commitRef(commit) : commit,
        description: "Accepted change",
        evidence: "correctness checks passed",
      }),
      "",
    ].join("\n"),
  );
  const output = path.join(root, `${name}.groups.json`);
  await run(process.execPath, [finalizer, "plan", "--output", output, "--goal", name], repo);
  const plan = JSON.parse(await fsp.readFile(output, "utf8"));
  assert.ok(plan.accepted_evidence_fingerprint?.fingerprint);
  return { commit, output, plan, repo };
}

testWithTempRoot(
  "finalizer plan recommends collapsing overlap and can collapse on request",
  "autoresearch-plan-collapse-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-overlap"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "first\n");
    await writeFile(path.join(repo, "src", "other.txt"), "first other\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "first value change"], repo);
    const firstHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "value.txt"), "second\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "second value change"], repo);
    const secondHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "overlap loop",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 10,
          description: "First kept change",
          commit: firstHash,
          asi: { hypothesis: "first" },
        }),
        JSON.stringify({
          run: 2,
          status: "keep",
          metric: 9,
          description: "Second kept change",
          commit: secondHash,
          asi: { hypothesis: "second" },
        }),
      ].join("\n") + "\n",
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "session log"], repo);

    const output = path.join(root, "plans", "nested", "groups.json");
    const preview = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "overlap-loop"],
      repo,
    );
    assert.match(
      preview.stdout,
      /Hint: rerun with --collapse-overlap to consolidate overlapping kept commits\./,
    );

    const plan = JSON.parse(await fsp.readFile(output, "utf8"));
    assert.equal(plan.groups.length, 2);
    assert.equal(plan.collapse_overlap_recommended, true);
    assert.ok(plan.overlap_count > 0);

    const collapsedOutput = path.join(root, "plans", "nested", "collapsed.groups.json");
    const result = await run(
      process.execPath,
      [
        finalizer,
        "plan",
        "--output",
        collapsedOutput,
        "--goal",
        "overlap-loop",
        "--collapse-overlap",
      ],
      repo,
    );
    assert.match(result.stdout, /Groups: 1/);

    const collapsed = JSON.parse(await fsp.readFile(collapsedOutput, "utf8"));
    assert.equal(collapsed.groups.length, 1);
    assert.match(collapsed.groups[0].title, /Consolidated overlap-loop changes/);
    assert.match(collapsed.groups[0].body, /src\/value\.txt/);
    assert.match(collapsed.groups[0].files.join("\n"), /src\/value\.txt/);
    assert.match(collapsed.groups[0].files.join("\n"), /src\/other\.txt/);
    assert.equal(collapsed.groups[0].parent_commit, collapsed.base);

    const finalizeResult = await run(process.execPath, [finalizer, collapsedOutput], repo);
    assert.match(finalizeResult.stdout, /Review branches/);
    const summaryLine = finalizeResult.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("Review summary: "));
    const summary = await fsp.readFile(summaryLine.slice("Review summary: ".length).trim(), "utf8");
    assert.match(summary, /Status: verified/);

    const branchFiles = (
      await git(
        [
          "show",
          "--name-only",
          "--format=",
          "autoresearch-review/overlap-loop/01-overlap-loop-changes",
        ],
        repo,
      )
    ).stdout;
    assert.match(branchFiles, /src\/value\.txt/);
    assert.match(branchFiles, /src\/other\.txt/);
    assert.equal(
      (
        await git(
          ["show", "autoresearch-review/overlap-loop/01-overlap-loop-changes:src/value.txt"],
          repo,
        )
      ).stdout,
      "second\n",
    );
    assert.equal(
      (
        await git(
          ["show", "autoresearch-review/overlap-loop/01-overlap-loop-changes:src/other.txt"],
          repo,
        )
      ).stdout,
      "first other\n",
    );
  },
);

testWithTempRoot(
  "collapsed finalizer fails closed when excluded commits touch planned kept files",
  "autoresearch-collapse-conflict-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "a.txt"), "base a\n");
    await writeFile(path.join(repo, "src", "x.txt"), "base x\n");
    await writeFile(path.join(repo, "src", "c.txt"), "base c\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-collapse-conflict"], repo);
    await writeFile(path.join(repo, "src", "a.txt"), "kept a\n");
    await writeFile(path.join(repo, "src", "x.txt"), "first x\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "first kept"], repo);
    const firstHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "a.txt"), "discarded a\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "discarded a"], repo);
    const discardedHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(path.join(repo, "src", "x.txt"), "second x\n");
    await writeFile(path.join(repo, "src", "c.txt"), "kept c\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "second kept"], repo);
    const secondHash = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "collapse conflict",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        JSON.stringify({
          run: 1,
          status: "keep",
          metric: 10,
          description: "First kept",
          commit: firstHash,
          asi: { hypothesis: "first" },
        }),
        JSON.stringify({
          run: 2,
          status: "discard",
          metric: 11,
          description: "Discarded a",
          commit: discardedHash,
          asi: { evidence: "bad" },
        }),
        JSON.stringify({
          run: 3,
          status: "keep",
          metric: 9,
          description: "Second kept",
          commit: secondHash,
          asi: { hypothesis: "second" },
        }),
      ].join("\n") + "\n",
    );
    await git(["add", "autoresearch.jsonl"], repo);
    await git(["commit", "-m", "session log"], repo);

    const output = path.join(root, "groups.json");
    const preview = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "collapse-conflict", "--collapse-overlap"],
      repo,
    );
    assert.match(preview.stdout, /Groups: 1/);

    const tamperedOutput = path.join(root, "tampered-groups.json");
    const tamperedPlan = JSON.parse(await fsp.readFile(output, "utf8"));
    assert.ok(tamperedPlan.excluded_commit_count > 0);
    tamperedPlan.excluded_commits = [];
    await fsp.writeFile(tamperedOutput, JSON.stringify(tamperedPlan, null, 2) + "\n", "utf8");
    const tamperedResult = await run(process.execPath, [finalizer, tamperedOutput], repo, true);
    assert.notEqual(tamperedResult.code, 0);
    assert.match(tamperedResult.stderr, /excluded_commit_count does not match excluded_commits/);

    const result = await run(process.execPath, [finalizer, output], repo, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /excluded commits touch planned kept files/);
    const reviewBranches = (
      await git(["branch", "--list", "autoresearch-review/*"], repo)
    ).stdout.trim();
    assert.equal(reviewBranches, "");
  },
);

testWithTempRoot(
  "finalizer surfaces corrupt autoresearch.jsonl with an actionable error",
  "autoresearch-bad-jsonl-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);

    await git(["switch", "-c", "codex/autoresearch-test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "keep value change"], repo);

    await writeFile(
      path.join(repo, "autoresearch.jsonl"),
      [
        JSON.stringify({
          type: "config",
          name: "speed loop",
          metricName: "seconds",
          bestDirection: "lower",
        }),
        "{ not valid json",
      ].join("\n") + "\n",
    );

    const output = path.join(root, "groups.json");
    const result = await run(
      process.execPath,
      [finalizer, "plan", "--output", output, "--goal", "speed-loop"],
      repo,
      true,
    );
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Corrupt autoresearch\.jsonl at line 2/);
    assert.match(`${result.stdout}\n${result.stderr}`, /Fix autoresearch\.jsonl/i);
  },
);

testWithTempRoot(
  "finalizer removes empty skipped branches and sanitizes branch names",
  "autoresearch-empty-",
  async (root) => {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo, { recursive: true });

    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "codex@example.invalid"], repo);
    await git(["config", "user.name", "Codex Test"], repo);

    await writeFile(path.join(repo, "src", "value.txt"), "base\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "base"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    await git(["switch", "-c", "codex/autoresearch-test"], repo);
    await writeFile(path.join(repo, "src", "value.txt"), "kept\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-m", "keep value change"], repo);
    const finalTree = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const groupsPath = path.join(root, "groups.json");
    await fsp.writeFile(
      groupsPath,
      JSON.stringify(
        {
          base,
          trunk: "main",
          final_tree: finalTree,
          goal: "UX Test With Spaces",
          groups: [
            {
              title: "Empty group",
              body: "No diff from base.",
              last_commit: base,
              slug: "Empty Group",
            },
            {
              title: "Keep value change",
              body: "Real diff.",
              last_commit: finalTree,
              slug: "Value Change",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await run(process.execPath, [finalizer, groupsPath], repo);
    assert.match(result.stdout, /autoresearch-review\/ux-test-with-spaces\/02-value-change/);

    const branches = (await git(["branch", "--list", "autoresearch-review/*"], repo)).stdout;
    assert.doesNotMatch(branches, /01-empty-group/);
    assert.match(branches, /02-value-change/);

    const current = (await git(["branch", "--show-current"], repo)).stdout.trim();
    assert.equal(current, "codex/autoresearch-test");
  },
);
