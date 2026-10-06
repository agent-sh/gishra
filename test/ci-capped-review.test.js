'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, BIN } = require('./helpers');

const APP = 'revuto-review';
const CAP = { title: 'Revuto did not review this pull request', summary: 'reached the 2-round review limit', text: null };
const POLICY = [{ app: APP, pattern: 'review limit' }];
const github = path.join(__dirname, 'fixtures', 'github.js');

function run(name, app, id, output = null, conclusion = 'success', status = 'completed') {
  return { name, app: { slug: app }, check_suite: { id }, output, conclusion, status };
}

function suite(app, id, conclusion = 'success', status = 'completed', runs = 1) {
  return { app: { slug: app }, id, conclusion, status, latest_check_runs_count: runs };
}

function fixture(t) {
  const h = makeRepo(t);
  h.init(['--repo', 'acme/app']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha, '--pr', '9']);
  return {
    check({ policy = POLICY, runs = [run('Revuto', APP, 2, CAP, 'failure')], suites = [suite(APP, 2, 'failure')], ci = {} } = {}) {
      const project = h.readState('project.json');
      project.ci = { ...ci, ...(policy === null ? {} : { capped_review: policy }) };
      h.writeState('project.json', project);
      const file = path.join(h.base, 'github.json');
      fs.writeFileSync(file, JSON.stringify({
        sha, runs: [run('build', 'github-actions', 1), ...runs],
        suites: [suite('github-actions', 1), ...suites],
      }));
      const r = cp.spawnSync(process.execPath, ['--require', github, BIN, 'check', 'ci', 'T1', '--agent', 'checker', '--json'], {
        cwd: h.repo, env: { ...h.env, TEST_GITHUB: file }, encoding: 'utf8', timeout: 60000,
      });
      const evidence = JSON.parse(r.stdout);
      assert.equal(evidence.sha, sha);
      assert.equal(evidence.type, 'ci');
      assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.at(-1), {
        type: evidence.type, ok: evidence.ok, sha: evidence.sha, agent: evidence.agent,
        at: evidence.at, summary: evidence.summary, ref: evidence.ref, revision: evidence.revision,
      });
      return { code: r.status, ...evidence };
    },
  };
}

test('configured review cap passes the real CLI gate and is named in recorded evidence', (t) => {
  const h = fixture(t);
  for (const output of [CAP, { title: 'review limit' }, { text: 'review limit' }]) {
    const r = h.check({ runs: [run('Revuto', APP, 2, output, 'failure')] });
    assert.equal(r.code, 0, r.summary);
    assert.equal(r.ok, true);
    assert.match(r.summary, /ci\.capped_review: Revuto \(revuto-review\)/);
  }
});

test('the same app still blocks for other failures and other unsuccessful conclusions', (t) => {
  const h = fixture(t);
  for (const [output, conclusion, status] of [
    [{ title: 'Review found a bug', summary: 'HIGH finding' }, 'failure', 'completed'],
    [null, 'failure', 'completed'],
    [CAP, 'cancelled', 'completed'],
    [CAP, 'timed_out', 'completed'],
    [CAP, null, 'in_progress'],
  ]) {
    const r = h.check({ runs: [run('Revuto', APP, 2, output, conclusion, status)] });
    assert.equal(r.code, 1, r.summary);
    assert.equal(r.ok, false);
    assert.match(r.summary, /Revuto \(/);
    assert.doesNotMatch(r.summary, /ci\.capped_review:/);
  }
});

test('matching output needs a configured app and defaults to no cap exceptions', (t) => {
  const h = fixture(t);
  for (const policy of [null, [], [{ app: 'another-reviewer', pattern: 'review limit' }]]) {
    const r = h.check({ policy });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /failing: Revuto \(failure\)/);
  }
});

test('a capped run never hides other failed or pending runs in its suite', (t) => {
  const h = fixture(t);
  for (const [conclusion, status] of [['failure', 'completed'], [null, 'queued']]) {
    const r = h.check({
      runs: [run('Revuto', APP, 2, CAP, 'failure'), run('other review', APP, 2, null, conclusion, status)],
      suites: [suite(APP, 2, 'failure', 'completed', 2)],
    });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /other review \(/);
    assert.match(r.summary, /check suites not green: revuto-review/);
    assert.match(r.summary, /ci\.capped_review: Revuto \(revuto-review\)/);
  }
  const greenSibling = h.check({
    runs: [run('Revuto', APP, 2, CAP, 'failure'), run('other review', APP, 2)],
    suites: [suite(APP, 2, 'failure', 'completed', 2)],
  });
  assert.equal(greenSibling.code, 0, greenSibling.summary);
});

test('only the completed failure suite linked to the capped run can pass', (t) => {
  const h = fixture(t);
  for (const suites of [
    [suite(APP, 2, 'failure'), suite(APP, 3, 'failure')],
    [suite(APP, 2, null, 'queued')],
    [suite(APP, 2, 'cancelled')],
    [suite(APP, 2, 'failure', 'completed', 2)],
    [suite(APP, null, 'failure')],
  ]) {
    const r = h.check({ suites });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /check suites not green: revuto-review/);
  }
});

test('capped review patterns are case-insensitive regular expressions', (t) => {
  const r = fixture(t).check({
    policy: [{ app: APP, pattern: 'REVIEW\\s+LIMIT' }],
  });
  assert.equal(r.code, 0, r.summary);
});

test('malformed capped review rules fail the CLI gate with the field named', (t) => {
  const h = fixture(t);
  for (const policy of ['review limit', [null], [{}], [{ app: '', pattern: 'review limit' }], [{ app: APP, pattern: '' }], [{ app: APP, pattern: '[' }]]) {
    const r = h.check({ policy });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /ci\.capped_review/);
  }
});
