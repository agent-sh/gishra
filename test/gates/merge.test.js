'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../../lib/gates/merge');
const { result, fakeExec } = require('./helpers');

const SHA = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const MERGED = 'e'.repeat(40);
const REPO = 'acme/app';

// A PR on a fake GitHub: `merge` decides what gh pr merge does to it.
function github({ state = 'OPEN', head = SHA, merge = 'ok' } = {}) {
  const pr = { state, headRefOid: head, mergeCommit: state === 'MERGED' ? { oid: MERGED } : null };
  const gh = fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr));
    if (args[0] !== 'pr' || args[1] !== 'merge') return null;
    if (merge === 'refused') return result('', 1, 'GraphQL: Base branch policy prohibits the merge (mergePullRequest)');
    if (merge === 'queued') return result('! Pull request #42 will be added to the merge queue\n');
    Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: MERGED } });
    if (merge === 'branch-kept') return result('', 1, 'failed to delete remote branch: protected');
    return result('');
  });
  gh.merges = () => gh.calls.filter((c) => c[2] === 'merge');
  return gh;
}

function ctx(gh, { task = {}, args = {} } = {}) {
  return { root: '/repo', worktree: null, task: { id: 'T4', title: 'Change', acceptance: ['works'], kind: 'code', sha: SHA, pr: 42, status: 'accepted', ...task }, project: { repo: REPO, base: 'main' }, args, exec: gh.exec, log() {} };
}

test('a task that is not accepted is never merged', async () => {
  for (const status of ['submitted', 'in_progress', 'rework']) {
    const gh = github();
    const r = await gate.run(ctx(gh, { task: { status } }));
    assert.equal(r.ok, false);
    assert.match(r.summary, new RegExp(`is ${status}, not accepted`));
    assert.equal(gh.calls.length, 0);
  }
});

test('a task without a PR is not merged', async () => {
  const gh = github();
  const r = await gate.run(ctx(gh, { task: { pr: null } }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /has no PR/);
  assert.equal(gh.calls.length, 0);
});

test('merge ok: squash, delete the branch, match the head, confirm MERGED', async () => {
  const gh = github();
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.ref, MERGED);
  assert.equal(r.sha, SHA);
  assert.deepEqual(gh.merges(), [['gh', 'pr', 'merge', '42', '-R', REPO, '--squash', '--delete-branch', '--match-head-commit', SHA, '--subject', 'Change', '--body', 'works']]);
  assert.match(r.summary, /merged PR #42 into main in acme\/app \(squash\)/);
});

test('--method and --admin reach gh', async () => {
  const gh = github();
  const r = await gate.run(ctx(gh, { args: { method: 'rebase', admin: true } }));
  assert.equal(r.ok, true, r.summary);
  assert.deepEqual(gh.merges(), [['gh', 'pr', 'merge', '42', '-R', REPO, '--rebase', '--delete-branch', '--match-head-commit', SHA, '--admin']]);
  const bad = await gate.run(ctx(github(), { args: { method: 'octopus' } }));
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /--method must be squash, merge or rebase/);
});

test('a refused merge: not ok with gh\'s message, tried once', async () => {
  const gh = github({ merge: 'refused' });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.match(r.summary, /Base branch policy prohibits the merge/);
  assert.equal(gh.merges().length, 1);
});

test('the PR head moved: not ok, merge never attempted', async () => {
  const gh = github({ head: OTHER });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.match(r.summary, /PR head moved: PR #42 head is dddddddddd/);
  assert.equal(gh.merges().length, 0);
});

test('gh exits 0 but the PR is not merged (merge queue): not ok', async () => {
  const gh = github({ merge: 'queued' });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.match(r.summary, /PR #42 is OPEN/);
});

test('merged, but gh could not delete the branch: ok with gh\'s message', async () => {
  const gh = github({ merge: 'branch-kept' });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.ref, MERGED);
  assert.match(r.summary, /failed to delete remote branch/);
});

test('already merged at the accepted sha: ok without merging again', async () => {
  const gh = github({ state: 'MERGED' });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.ref, MERGED);
  assert.equal(gh.merges().length, 0);
  const moved = await gate.run(ctx(github({ state: 'MERGED', head: OTHER })));
  assert.equal(moved.ok, false);
  assert.match(moved.summary, /not the accepted/);
});
