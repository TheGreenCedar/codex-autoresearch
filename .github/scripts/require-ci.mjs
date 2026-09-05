import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function ciDecision(runs, repo, sha) {
  if (!Array.isArray(runs)) throw new Error('CI response has no workflow runs.');
  const run = runs
    .filter((run) => run.head_sha === sha && run.head_branch === 'main'
      && run.event === 'push' && run.path === '.github/workflows/ci.yml'
      && run.repository?.full_name === repo && run.head_repository?.full_name === repo)
    .sort((left, right) => right.id - left.id)[0];
  if (!run || run.status !== 'completed') return { ready: false };
  if (run.conclusion !== 'success') {
    throw new Error(`CI ${run.id} ended with ${run.conclusion}; release is blocked.`);
  }
  return { ready: true, runId: run.id, url: run.html_url };
}

export async function requireCi({ repo, sha, readRuns, wait, now = Date.now, timeoutMs = 900_000 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[a-f0-9]{40}$/.test(sha || '')) {
    throw new Error('An exact repository and commit SHA are required.');
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const result = ciDecision(await readRuns(), repo, sha);
    if (result.ready) return result;
    await wait(Math.min(15_000, Math.max(0, deadline - now())));
  }
  throw new Error(`No successful CI for ${sha} within ${timeoutMs / 60_000} minutes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Releases require main.');
    const repo = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_SHA;
    const result = await requireCi({
      repo,
      sha,
      readRuns: async () => JSON.parse(execFileSync('gh', [
        'api', `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`,
      ], { encoding: 'utf8', timeout: 30_000 })).workflow_runs,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    console.log(`Verified CI ${result.runId} for ${sha}: ${result.url}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
