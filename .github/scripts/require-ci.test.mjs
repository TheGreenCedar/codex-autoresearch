import assert from 'node:assert/strict';
import test from 'node:test';
import { ciDecision, requireCi } from './require-ci.mjs';

const repo = 'owner/project';
const sha = 'a'.repeat(40);
const run = {
  id: 1, head_sha: sha, head_branch: 'main', event: 'push',
  path: '.github/workflows/ci.yml', repository: { full_name: repo },
  head_repository: { full_name: repo }, status: 'completed', conclusion: 'success',
};

test('release accepts only successful CI for the exact repository, workflow, branch and commit', () => {
  assert.equal(ciDecision([run], repo, sha).ready, true);
  for (const patch of [
    { head_sha: 'b'.repeat(40) }, { head_branch: 'dev' }, { event: 'pull_request' },
    { path: '.github/workflows/release.yml' }, { repository: { full_name: 'other/repo' } },
    { head_repository: { full_name: 'fork/project' } }, { status: 'in_progress' },
  ]) assert.equal(ciDecision([{ ...run, ...patch }], repo, sha).ready, false);
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    assert.throws(() => ciDecision([{ ...run, conclusion }], repo, sha), /release is blocked/);
  }
});

test('a newer pending or failed run cannot reuse an older success', () => {
  assert.equal(ciDecision([run, { ...run, id: 2, status: 'in_progress' }], repo, sha).ready, false);
  assert.throws(() => ciDecision([run, { ...run, id: 2, conclusion: 'failure' }], repo, sha), /blocked/);
});

test('CI wait is bounded and missing evidence never passes', async () => {
  let time = 0;
  const options = { repo, sha, now: () => time, timeoutMs: 10,
    readRuns: async () => [], wait: async (ms) => { time += ms; } };
  await assert.rejects(requireCi(options), /No successful CI/);
  await assert.rejects(requireCi({ ...options, sha: 'main' }), /exact repository and commit/);
  await assert.rejects(requireCi({ ...options, readRuns: async () => null }), /no workflow runs/);
  assert.equal((await requireCi({ ...options, readRuns: async () => [run] })).runId, 1);
});
