'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

const ghStub = path.join(__dirname, 'fixtures', 'automation-gh.js');
const harness = path.join(__dirname, 'fixtures', 'automation-harness.js');

function setup(t, { kind = 'code', ci = 'success' } = {}) {
  const h = makeRepo(t);
  h.sha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  const preload = path.join(h.base, 'offline-gh.js');
  fs.writeFileSync(preload, `const cp=require('node:child_process'),run=cp.spawnSync;
cp.spawnSync=(cmd,args,opts)=>cmd==='gh'?run(process.execPath,[${JSON.stringify(ghStub)},...args],opts):run(cmd,args,opts);\n`);
  h.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  h.env.AUTOMATION_GITHUB = path.join(h.base, 'github.json');
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.saveGithub({ root: h.repo, prs: { 7: {
    state: 'OPEN', headRefOid: h.sha, headRefName: 'fixture-change',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main',
  } }, ci: { [h.sha]: ci } });
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', kind]);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Change\n\nImplement the acceptance.\n' });
  h.submit = (id = 'T1', sha = h.sha, pr = '7') => {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', sha, '--pr', pr, '--agent', 'worker']);
  };
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

test('submission runs real software gates once through the existing waiter', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  assert.equal(h.consume().code, 2);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true], ['ci', false]]);
  assert.ok(task.evidence.every((e) => e.commands.length && e.source === `check ${e.type}`));
  assert.equal(task.status, 'submitted');
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 3, 'duplicate event delivery runs no gate twice');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0, 'pending CI starts no model');
});

test('CI completion refreshes a pending or failed receipt at the exact head and merges after review', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const bad = h.github();
  bad.ci[h.sha] = 'failure';
  h.saveGithub(bad);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  const good = h.github();
  good.ci[h.sha] = 'success';
  h.saveGithub(good);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => e.ok), [false, false, true]);
  assert.equal(task.evidence.at(-1).type, 'merge');
  const calls = h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'merge');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--match-head-commit') + 1], h.sha);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', 'fffffff', '--agent', 'orchestrator']).code, 1);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'worker']).code, 1);
});

test('an accepted task with green gates merges in the event reaction without an agent turn', (t) => {
  const h = setup(t);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const notification = JSON.parse(h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']));
  assert.equal(notification.type, 'merged', 'startup catches up accepted PRs and retains its automatic merge event');
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1);
});

test('a merge sends another conflicting PR to rework with real filenames and preserves its worktree', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'conflicting change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: other, headRefName: 'other-change' };
  github.advanceBase = true;
  h.saveGithub(github);
  h.submit('T2', other, '8');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const before = h.git(['status', '--porcelain']);
  h.consume();
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', 'T2.md'), 'utf8'), /value\.js/);
  assert.equal(h.git(['status', '--porcelain']), before);
  assert.equal(h.git(['rev-parse', 'HEAD']), other);
  assert.equal(fs.readFileSync(path.join(h.repo, 'value.js'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('stale or unknown PR heads and missing review never merge', (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 0);
  state.prs['7'].headRefOid = h.sha;
  state.prs['7'].mergeable = 'UNKNOWN';
  state.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  state.prs['7'].mergeable = 'MERGEABLE';
  state.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted', 'green software gates still require independent review');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a completion webhook is only a hint, rejects another repository and ignores stale heads', (t) => {
  const h = setup(t, { kind: 'docs', ci: 'failure' });
  h.submit();
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const payload = { repository: { full_name: 'acme/demo' }, action: 'completed',
    check_suite: { head_sha: h.sha, status: 'completed', conclusion: 'success' } };
  const deliver = () => h.run(['ci', 'webhook', '-', '--agent', 'orchestrator'], { input: JSON.stringify(payload) });
  assert.equal(deliver().code, 0);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false, 'GitHub failure wins over payload success');
  payload.repository.full_name = 'acme/other';
  assert.equal(deliver().code, 1);
  payload.repository.full_name = 'acme/demo';
  payload.check_suite.head_sha = 'a'.repeat(40);
  assert.deepEqual(JSON.parse(h.ok(['ci', 'webhook', '-', '--json', '--agent', 'orchestrator'],
    { input: JSON.stringify(payload) })).tasks, []);
  payload.check_suite.head_sha = h.sha;
  const state = h.github();
  state.ci[h.sha] = 'success';
  h.saveGithub(state);
  assert.equal(deliver().code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('concurrent event consumers execute each submission gate only once', async (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const results = await Promise.all([
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
  ]);
  assert.ok(results.every((r) => r.code === 2), JSON.stringify(results));
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci']);
});

test('a supervised worker submission runs gates and dispatches the offline reviewer after exit', async (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
    JSON.stringify([process.execPath, harness, BIN, 'auto']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((f) => ['--clear', f])]);
  h.ok(['ladder', 'set', 'review', '--harness', 'command', '--command',
    JSON.stringify([process.execPath, harness, BIN, 'auto']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((f) => ['--clear', f])]);
  const hold = path.join(h.base, 'worker-hold');
  const spawned = h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'],
    { env: { AUTOMATION_WORKER_HOLD: hold } });
  const deadline = Date.now() + 15000;
  try {
    while (!fs.existsSync(hold)) {
      if (Date.now() > deadline) throw new Error('worker did not submit');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 0,
      'a worker still running after submit blocks review dispatch');
  } finally {
    fs.writeFileSync(`${hold}.go`, '');
    assert.equal((await spawned).code, 0);
  }
  while (!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok)) {
    if (Date.now() > deadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const events = h.logs();
  const review = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const exit = events.findIndex((e) => e.cmd === 'spawn exit' && e.detail.role === 'worker');
  assert.ok(review > exit);
  assert.equal(events.filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});
