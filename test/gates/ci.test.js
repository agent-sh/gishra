'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../../lib/gates/ci');
const { result, fakeExec } = require('./helpers');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REPO = 'acme/app';

const run = (name, conclusion = 'success', status = 'completed', app = 'github-actions') => ({ name, status, conclusion, app });
const suite = (app, conclusion = 'success', status = 'completed', runs = 1) => ({ app, status, conclusion, runs });
// gh --jq prints one JSON value per line, across all pages.
const lines = (items) => items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');

function github({ runs = [], suites = [], head = SHA, apiError = null } = {}) {
  return fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify({ headRefOid: head }));
    if (args[0] !== 'api') return null;
    assert.ok(args.includes('--paginate'), 'every page must be read');
    if (apiError) return result('', 1, apiError);
    if (args[1] === `repos/${REPO}/commits/${SHA}/check-runs?per_page=100`) return result(lines(runs));
    if (args[1] === `repos/${REPO}/commits/${SHA}/check-suites?per_page=100`) return result(lines(suites));
    return null;
  });
}

function ctx(gh, task = {}, project = {}) {
  return { root: '/repo', worktree: null, task: { id: 'T3', kind: 'code', sha: SHA, pr: null, ...task }, project: { repo: REPO, base: 'main', ...project }, args: {}, exec: gh.exec, log() {} };
}

const GREEN_RUNS = [run('build'), run('lint'), run('docs', 'skipped'), run('bench', 'neutral')];
const GREEN_SUITES = [suite('github-actions'), suite('github-actions', 'neutral')];

test('every run and suite completed, none failed: ok', async () => {
  const gh = github({ runs: GREEN_RUNS, suites: GREEN_SUITES });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.sha, SHA);
  assert.equal(r.ref, `https://github.com/${REPO}/commit/${SHA}/checks`);
  assert.match(r.summary, /4 check runs \(2 success, 1 skipped, 1 neutral\)/);
});

test('a cancelled run: not ok, naming it', async () => {
  const gh = github({ runs: [...GREEN_RUNS, run('e2e', 'cancelled')], suites: GREEN_SUITES });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.match(r.summary, /failing: e2e \(cancelled\)/);
});

test('every failing conclusion fails the gate', async () => {
  for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
    const r = await gate.run(ctx(github({ runs: [run('build'), run('test', c)], suites: GREEN_SUITES })));
    assert.equal(r.ok, false, c);
    assert.match(r.summary, new RegExp(`test \\(${c}\\)`));
  }
});

test('a run still in progress: not ok', async () => {
  const gh = github({ runs: [...GREEN_RUNS, run('e2e', null, 'in_progress')], suites: GREEN_SUITES });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.match(r.summary, /not completed: e2e \(in_progress\)/);
});

test('a suite that is queued or failed: not ok even when the listed runs are green', async () => {
  // A second workflow of the same CI app has its suite but no runs yet.
  const queued = await gate.run(ctx(github({ runs: GREEN_RUNS, suites: [...GREEN_SUITES, suite('github-actions', null, 'queued', 0)] })));
  assert.equal(queued.ok, false);
  assert.match(queued.summary, /check suites not green: github-actions \(queued, 0 runs\)/);
  const failed = await gate.run(ctx(github({ runs: GREEN_RUNS, suites: [...GREEN_SUITES, suite('github-actions', 'failure')] })));
  assert.equal(failed.ok, false);
  assert.match(failed.summary, /github-actions \(failure, 1 runs\)/);
});

test('a suite with no runs from another app is never inferred away', async () => {
  // Green Actions runs next to another provider whose suite has no runs yet: CI is still going.
  for (const status of ['queued', 'in_progress']) {
    const r = await gate.run(ctx(github({ runs: GREEN_RUNS, suites: [...GREEN_SUITES, suite('external-ci', null, status, 0)] })));
    assert.equal(r.ok, false, status);
    assert.match(r.summary, new RegExp(`external-ci \\(${status}, 0 runs\\)`));
    assert.match(r.summary, /ci\.ignore_apps/);
  }
});

test('apps listed in project.json ci.ignore_apps are skipped, and only those', async () => {
  const project = { ci: { ignore_apps: ['claude', 'cursor'] } };
  const suites = [...GREEN_SUITES, suite('claude', null, 'queued', 0), suite('cursor', null, 'in_progress', 1)];
  const runs = [...GREEN_RUNS, run('cursor review', 'failure', 'completed', 'cursor')];
  const r = await gate.run(ctx(github({ runs, suites }), {}, project));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /4 check runs/);
  assert.match(r.summary, /Ignored as listed in project\.json ci\.ignore_apps: claude \(1 suite, 0 runs\), cursor \(1 suite, 1 run\)/);
  const other = await gate.run(ctx(github({ runs, suites: [...suites, suite('external-ci', null, 'queued', 0)] }), {}, project));
  assert.equal(other.ok, false);
  assert.match(other.summary, /external-ci \(queued, 0 runs\)/);
  // Runs only from ignored apps are no CI at all.
  const none = await gate.run(ctx(github({ runs: [run('cursor review', 'success', 'completed', 'cursor')], suites }), {}, project));
  assert.equal(none.ok, false);
  assert.match(none.summary, /no check runs/);
});

test('a malformed ci.ignore_apps: not ok, naming the field', async () => {
  for (const ci of [{ ignore_apps: 'claude' }, { ignore_apps: [''] }, 'claude', [1]]) {
    const gh = github({ runs: GREEN_RUNS, suites: GREEN_SUITES });
    const r = await gate.run(ctx(gh, {}, { ci }));
    assert.equal(r.ok, false, JSON.stringify(ci));
    assert.match(r.summary, /ci\.ignore_apps must be an array/);
    assert.equal(gh.calls.length, 0);
  }
});

test('no check runs at all: not ok', async () => {
  const r = await gate.run(ctx(github({ runs: [], suites: [] })));
  assert.equal(r.ok, false);
  assert.match(r.summary, /no check runs on aaaaaaaaaa/);
});

test('the PR head moved off the submitted sha: not ok', async () => {
  const gh = github({ runs: GREEN_RUNS, suites: GREEN_SUITES, head: OTHER });
  const r = await gate.run(ctx(gh, { pr: 42 }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /PR head moved: PR #42 head is bbbbbbbbbb/);
  assert.deepEqual(gh.calls[0], ['gh', 'pr', 'view', '42', '-R', REPO, '--json', 'headRefOid']);
});

test('the PR head is the submitted sha: CI decides', async () => {
  const r = await gate.run(ctx(github({ runs: GREEN_RUNS, suites: GREEN_SUITES }), { pr: 42 }));
  assert.equal(r.ok, true, r.summary);
});

test('gh failing: not ok with its message', async () => {
  const r = await gate.run(ctx(github({ apiError: 'gh: Not Found (HTTP 404)' })));
  assert.equal(r.ok, false);
  assert.match(r.summary, /HTTP 404/);
});
