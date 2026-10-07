'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, BIN } = require('./helpers');

const REQUIRED = [
  'test (ubuntu-latest, node 26)',
  'test (ubuntu-latest, node 24)',
  'test (windows-latest, node 26)',
];
const CAP_POLICY = [{ app: 'revuto-review', pattern: 'reached the \\d+-round review limit' }];
const github = path.join(__dirname, 'fixtures', 'github.js');

test('package support, CI matrix, and required jobs target Node 24 and 26', () => {
  const root = path.resolve(__dirname, '..');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.engines.node, '>=24');

  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const matrix = [...workflow.matchAll(/^\s+- \{ os: ([^,]+), node: (\d+) \}$/gm)]
    .map(([, os, node]) => ({ os, node: Number(node) }));
  assert.deepEqual(matrix, [
    { os: 'ubuntu-latest', node: 26 },
    { os: 'ubuntu-latest', node: 24 },
    { os: 'windows-latest', node: 26 },
  ]);
  assert.deepEqual(matrix.map(({ os, node }) => `test (${os}, node ${node})`), REQUIRED);

  const requiredJson = JSON.stringify(REQUIRED);
  for (const file of ['docs/state.md', 'docs/cli.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(text.includes(requiredJson), `${file} has stale required job names`);
  }
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\bNode 24 or newer\b/);
});

function run(name, conclusion = 'success', status = 'completed', app = 'github-actions', id = 1) {
  return { name, conclusion, status, app: { slug: app }, check_suite: { id } };
}

const CODEQL = [run('CodeQL'), run('Analyze (javascript-typescript)'), run('CodeQL (javascript-typescript)')];
const CAPPED = {
  ...run('Revuto', 'failure', 'completed', 'revuto-review', 2),
  output: { title: 'Revuto did not review this pull request', summary: 'reached the 2-round review limit' },
};

function fixture(t, withPr = true) {
  const h = makeRepo(t);
  h.init(['--repo', 'acme/app']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha, ...(withPr ? ['--pr', '40'] : [])]);
  return {
    check({ pr = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, runs = REQUIRED.map((name) => run(name)), ci = {} } = {}) {
      const project = h.readState('project.json');
      h.writeState('project.json', { ...project, ci: { required: REQUIRED, capped_review: CAP_POLICY, ...ci } });
      const file = path.join(h.base, 'github.json');
      const suites = [...new Set(runs.map((c) => c.check_suite.id))].map((id) => {
        const linked = runs.filter((c) => c.check_suite.id === id);
        return {
          id, app: linked[0].app, status: 'completed',
          conclusion: linked.some((c) => c.conclusion === 'failure') ? 'failure' : 'success',
          latest_check_runs_count: linked.length,
        };
      });
      fs.writeFileSync(file, JSON.stringify({ sha, pr, runs, suites }));
      const r = cp.spawnSync(process.execPath, ['--require', github, BIN, 'check', 'ci', 'T1', '--agent', 'checker', '--json'], {
        cwd: h.repo, env: { ...h.env, TEST_GITHUB: file }, encoding: 'utf8', timeout: 60000,
      });
      assert.ok(r.stdout, r.stderr);
      const evidence = JSON.parse(r.stdout);
      assert.equal(evidence.sha, sha);
      const { task, ...stored } = evidence;
      assert.equal(task, 'T1');
      assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.at(-1), stored);
      return { code: r.status, ...evidence };
    },
  };
}

test('T71 regression: conflicts block CodeQL successes plus a capped review with no test workflow', (t) => {
  const r = fixture(t).check({
    pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    runs: [...CODEQL, CAPPED],
  });
  assert.equal(r.code, 1, r.summary);
  assert.equal(r.ok, false);
  assert.match(r.summary, /PR #40.*CONFLICTING.*conflict/i);
  assert.doesNotMatch(r.summary, /CI green/);
  assert.equal(r.commands.length, 1, 'conflicts fail before reading check runs');
  assert.equal(r.commands[0].args.at(-1), 'headRefOid,mergeable,mergeStateStatus');
});

test('unknown or absent mergeability requires a later check even with successful tests', (t) => {
  const h = fixture(t);
  for (const pr of [
    { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
    { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN' },
    { mergeable: 'MERGEABLE' },
    {},
    { mergeable: 'unexpected', mergeStateStatus: 'CLEAN' },
  ]) {
    const r = h.check({ pr });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /mergeability.*(unknown|unavailable).*retry/i);
  }
});

test('conflicts block even successful required tests or an empty required list', (t) => {
  const h = fixture(t);
  for (const pr of [
    { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' },
  ]) {
    const r = h.check({ pr, ci: { required: [] } });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /CONFLICTING.*conflict/i);
  }
});

test('a mergeable PR with only CodeQL and a capped review reports every missing matrix job', (t) => {
  const r = fixture(t).check({ runs: [...CODEQL, CAPPED] });
  assert.equal(r.code, 1, r.summary);
  assert.match(r.summary, /missing required check runs/);
  for (const name of REQUIRED) assert.ok(r.summary.includes(name), r.summary);
});

test('every named job must run, and all three successes pass even when reviews block merging', (t) => {
  const h = fixture(t);
  for (const missing of REQUIRED) {
    const r = h.check({ runs: [...CODEQL, ...REQUIRED.filter((name) => name !== missing).map((name) => run(name)), CAPPED] });
    assert.equal(r.code, 1, r.summary);
    assert.ok(r.summary.includes(missing), r.summary);
  }
  const r = h.check({
    pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
    runs: [...REQUIRED.map((name) => run(name)), CAPPED],
  });
  assert.equal(r.code, 0, r.summary);
  assert.equal(r.ok, true);
});

test('a literal required prefix needs matching jobs, all completed successfully', (t) => {
  const h = fixture(t);
  const ci = { required: ['test ('] };
  assert.equal(h.check({ ci }).code, 0);
  assert.equal(h.check({ ci, runs: CODEQL }).code, 1);
  for (const [conclusion, status] of [
    ['skipped', 'completed'], ['neutral', 'completed'], ['failure', 'completed'],
    ['cancelled', 'completed'], ['timed_out', 'completed'], [null, 'queued'], [null, 'in_progress'],
  ]) {
    const r = h.check({ ci, runs: [run(REQUIRED[0]), run(REQUIRED[1], conclusion, status)] });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /required check runs not successful/);
    assert.ok(r.summary.includes(REQUIRED[1]), r.summary);
  }
});

test('ignored apps and capped failures cannot satisfy required checks', (t) => {
  const h = fixture(t);
  const ignored = h.check({ ci: { required: ['test ('], ignore_apps: ['github-actions'] }, runs: [...REQUIRED.map((name) => run(name)), CAPPED] });
  assert.equal(ignored.code, 1, ignored.summary);
  assert.match(ignored.summary, /missing required check runs.*test \(/);
  const capped = h.check({ ci: { required: ['Revuto'] }, runs: [...CODEQL, CAPPED] });
  assert.equal(capped.code, 1, capped.summary);
  assert.match(capped.summary, /required check runs not successful.*Revuto/);
});

test('malformed required lists fail closed, while empty or absent lists preserve hosted defaults', (t) => {
  const h = fixture(t);
  for (const required of ['test (', {}, [null], [1], [''], [' \t']]) {
    const r = h.check({ ci: { required }, runs: CODEQL });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /ci\.required.*array.*non-blank strings/);
    assert.equal(r.commands.length, 0);
  }
  for (const required of [[], null, undefined]) {
    const r = h.check({ ci: { required }, runs: CODEQL });
    assert.equal(r.code, 0, r.summary);
  }
});

test('required checks also apply to a submitted head without a PR', (t) => {
  const h = fixture(t, false);
  const missing = h.check({ runs: CODEQL });
  assert.equal(missing.code, 1, missing.summary);
  assert.match(missing.summary, /missing required check runs/);
  assert.equal(h.check().code, 0);
});
