'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, stacked } = require('./stack-fixture');

test('an unlinked dependent targets main and merges normally when its lower PR merges before submission', (t) => {
  const f = setup(t);
  const wt = f.h.json(['worktree', 'T2']);
  f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
  fs.writeFileSync(path.join(wt.path, 'T2.txt'), 'T2\n');
  f.h.git(['add', 'T2.txt'], wt.path);
  f.h.git(['commit', '-qm', 'upper work'], wt.path);
  f.h.git(['push', 'origin', wt.branch], wt.path);
  const sha = f.h.git(['rev-parse', 'HEAD'], wt.path);
  f.write((d) => {
    d.prs[12] = { number: 12, state: 'OPEN', headRefOid: sha, headRefName: wt.branch,
      baseRefName: f.lower.branch, isCrossRepository: false, autoMergeRequest: null };
  });
  f.accept('T1');
  f.h.ok(['merge', 'T1']);
  assert.equal(f.h.git(['ls-remote', '--heads', 'origin', f.lower.branch]), '');
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.linked, false);
  f.h.ok(['submit', 'T2', '--sha', sha, '--branch', wt.branch, '--pr', '12', '--agent', 'worker-T2']);
  f.h.ok(['stack', 'link', 'T2']);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(f.read().prs[12].baseRefName, 'main');
  assert.equal(task.stack, undefined);
  assert.equal(task.sha, sha);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), sha);
  f.accept('T2');
  f.h.ok(['merge', 'T2']);
  const evidence = f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'merge');
  assert.equal(evidence.ok, true);
  assert.ok(evidence.commands.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge' && c.args.includes('--match-head-commit')));
  assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && ['link', 'sync', 'merge'].includes(c.args[1])), false);
});

test('stack merge rechecks every accepted head and records evidence for all merged tasks', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.prs[11].headRefOid = 'a'.repeat(40); });
  const moved = f.h.run(['merge', 'T2']);
  assert.equal(moved.code, 1);
  assert.match(moved.stdout, /T1: PR head moved/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'merge'), false);
  f.write((d) => { d.prs[11].headRefOid = f.sha; });
  f.h.ok(['merge', 'T2']);
  assert.deepEqual(f.read().calls.find((c) => c.args[0] === 'stack' && c.args[1] === 'merge').args,
    ['stack', 'merge', '12', '--yes', '--squash']);
  for (const id of ['T1', 'T2']) {
    const task = f.h.json(['task', 'show', id]);
    const evidence = task.evidence.findLast((e) => e.type === 'merge');
    assert.equal(evidence.ok, true);
    assert.ok(evidence.commands.some((c) => c.args[0] === 'stack' && c.args[1] === 'merge'));
    assert.match(task.phase?.label || f.h.ok(['task', 'show', id]), /merged/);
  }
  assert.equal(f.h.git(['rev-parse', 'origin/main']), f.h.git(['rev-parse', 'HEAD'], f.h.json(['worktree', 'T2']).path));
  f.write((d) => { d.linked = false; });
  f.h.ok(['merge', 'T1']);
  f.h.ok(['merge', 'T2']);
  assert.equal(f.read().calls.filter((c) => c.args[0] === 'stack' && c.args[1] === 'merge').length, 1);
});

test('an unaccepted lower task, unknown remote lower PR, or auto-merge prevents stack merge', (t) => {
  const f = stacked(t);
  f.accept('T2');
  assert.match(f.h.run(['merge', 'T2']).stdout, /T1.*accepted/);
  f.accept('T1');
  f.write((d) => { d.order.unshift(99); });
  assert.match(f.h.run(['merge', 'T2']).stdout, /untracked lower PR/);
  assert.match(f.h.run(['stack', 'sync', 'T2']).stderr, /untracked PRs/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'sync'), false);
  f.write((d) => { d.order.shift(); d.prs[11].autoMergeRequest = {}; });
  assert.match(f.h.run(['merge', 'T2']).stdout, /without auto-merge/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'merge'), false);
});

test('queued stack merges are not evidence of a merge', (t) => {
  const f = stacked(t);
  const { wt } = f.upper;
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.queued = true; });
  assert.equal(f.h.run(['merge', 'T2']).code, 1);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.some((e) => e.type === 'merge'), false);
  f.write((d) => {
    d.linked = false;
    for (const pr of Object.values(d.prs)) { pr.state = 'MERGED'; pr.mergeCommit = { oid: pr.headRefOid }; }
  });
  f.h.git(['push', 'origin', `${wt.branch}:main`]);
  f.h.ok(['merge', 'T2']);
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.equal(f.read().calls.filter((c) => c.args[0] === 'stack' && c.args[1] === 'merge').length, 1);
});

for (const [setting, cli] of [['base', ['project', 'set', '--base', 'release']], ['admin', ['project', 'set', '--merge-admin', 'true']]]) {
  test(`a project ${setting} change during the final head checks stops the stack merge`, (t) => {
    const f = stacked(t);
    f.accept('T1');
    f.accept('T2');
    f.write((d) => { d.during = { 'pr view': [cli] }; });
    const r = f.h.run(['merge', 'T2']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /changed during stack head checks/);
    assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'merge'), false);
  });
}

test('exit 9 from stack merge leaves a stack another worker claimed meanwhile', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    d.mergeUnavailable = true;
    d.during = { 'stack merge': [['rework', 'T2', '--reason', 'another worker takes over'], ['claim', 'T2', '--agent', 'worker-new']] };
  });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /stack metadata not applied/);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.claim.agent, 'worker-new');
  assert.equal(task.stack.linked, true);
  assert.equal(task.stack_disabled, undefined);
  assert.equal(f.h.json(['task', 'show', 'T1']).stack_disabled, undefined);
});

test('three dependent PRs form one stack and all accepted lower tasks get merge evidence', (t) => {
  const f = stacked(t);
  f.add('third', 'T2');
  const wt = f.h.json(['worktree', 'T3']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.h.json(['task', 'show', 'T2']).sha);
  f.submit('T3', 13, wt);
  f.h.ok(['stack', 'link', 'T3']);
  assert.deepEqual(f.read().order, [11, 12, 13]);
  for (const id of ['T1', 'T2', 'T3']) f.accept(id);
  f.h.ok(['merge', 'T3']);
  for (const id of ['T1', 'T2', 'T3']) {
    assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
  }
});

test('admin merge requires unstacking, then lower tasks land before upper PRs target main', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.h.ok(['project', 'set', '--merge-admin', 'true']);
  assert.match(f.h.run(['merge', 'T2']).stdout, /cannot use --admin/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'merge'), false);
  f.h.ok(['stack', 'unstack', 'T2']);
  assert.match(f.h.run(['merge', 'T2']).stdout, /waits for every lower task/);
  f.h.ok(['merge', 'T1']);
  f.h.ok(['merge', 'T2']);
  const merges = f.read().calls.filter((c) => c.args[1] === 'merge');
  assert.deepEqual(merges.map((c) => c.args.slice(0, 3)), [['pr', 'merge', '11'], ['pr', 'merge', '12']]);
  assert.ok(merges.every((c) => c.args.includes('--admin') && c.args.includes('--match-head-commit')));
  assert.equal(f.read().prs[12].baseRefName, 'main');
});

test('exit 9 during linking retains work and falls back to ordinary merges in dependency order', (t) => {
  const f = setup(t);
  const wt = f.h.json(['worktree', 'T2']);
  const sha = f.submit('T2', 12, wt);
  f.write((d) => { d.unavailable = true; });
  f.h.ok(['stack', 'link', 'T2']);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), sha);
  f.accept('T1');
  f.accept('T2');
  assert.equal(f.h.run(['merge', 'T2']).code, 1);
  f.h.ok(['merge', 'T1']);
  f.h.ok(['merge', 'T2']);
  assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'merge'), false);
});

test('lower acceptance cannot hide failing current gate evidence', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', f.sha, '--agent', 'reviewer-independent']);
  assert.match(f.h.run(['merge', 'T2']).stdout, /T1.*passing gates/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'merge'), false);
});

test('local CI covers each dependency base and merge rechecks lower receipts', (t) => {
  const f = stacked(t);
  f.h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], timeout: 30 })]);
  for (const id of ['T1', 'T2']) {
    f.h.ok(['check', 'ci', id]);
    f.h.ok(['accept', id, '--waive', 'review', '--reason', 'offline fixture']);
  }
  const receipt = f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'ci').receipt;
  assert.equal(receipt.base_sha, f.sha);
  f.h.git(['commit', '--allow-empty', '-qm', 'main moved']);
  f.h.git(['push', 'origin', 'main']);
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /check ci T1 before merging/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'merge'), false);
});

test('stacks disabled after acceptance select ordinary merge gates and keep dependency ordering', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.unavailable = true; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ordinary merges enabled/);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
  f.h.ok(['merge', 'T1']);
  f.h.ok(['merge', 'T2']);
  assert.equal(f.read().prs[12].baseRefName, 'main');
});

test('relinking after capability recovery restores the stack gate and refuses admin bypass', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.unavailable = true; });
  assert.equal(f.h.run(['merge', 'T2']).code, 1);
  f.write((d) => { d.unavailable = false; });
  f.h.ok(['stack', 'link', 'T2']);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, undefined);
  f.h.ok(['project', 'set', '--merge-admin', 'true']);
  assert.match(f.h.run(['merge', 'T2']).stdout, /cannot use --admin/);
  assert.equal(f.read().calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge'), false);
  f.h.ok(['project', 'set', '--merge-admin', 'false']);
  f.h.ok(['merge', 'T2']);
});

// Code tasks with a suite that logs which task files and base files its tree
// holds, open PRs GitHub reports mergeable, and main moved on the remote.
function queued(t) {
  const f = stacked(t);
  const { shellQuote } = require('../lib/gates/common');
  const log = path.join(f.h.base, 'suites.jsonl');
  const suite = path.join(f.h.base, 'suite.js');
  fs.writeFileSync(suite, `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(
  ['T1.txt', 'T2.txt', 'moved.txt'].filter((f) => require('node:fs').existsSync(f))) + '\\n');\n`);
  f.h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} ${shellQuote(suite)}`]);
  for (const id of ['T1', 'T2']) f.h.ok(['task', 'update', id, '--kind', 'code']);
  f.write((d) => { for (const n of [11, 12]) Object.assign(d.prs[n], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }); });
  fs.writeFileSync(path.join(f.h.repo, 'moved.txt'), 'main moved\n');
  f.h.git(['add', 'moved.txt']);
  f.h.git(['commit', '-qm', 'main moves']);
  f.h.git(['push', 'origin', 'main']);
  f.main = f.h.git(['rev-parse', 'main']);
  f.acceptCode = (id) => f.h.ok(['accept', id, '--waive', 'tests', '--waive', 'clean', '--waive', 'review', '--waive', 'ci',
    '--reason', 'offline stack fixture']);
  f.consume = () => f.h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  f.suites = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []);
  f.checks = () => fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter((e) => e.cmd === 'head check');
  f.merges = () => f.read().calls.filter((c) => c.args[1] === 'merge').map((c) => c.args.slice(0, 3).join(' '));
  return f;
}

test('a stack is one queue entry: its upper task waits for the lower one and the chain is checked against current main', (t) => {
  const f = queued(t);
  f.acceptCode('T2');
  f.consume();
  assert.deepEqual(f.merges(), [], 'an upper task never heads the line before its lower task is accepted');
  assert.deepEqual(f.checks(), []);
  f.acceptCode('T1');
  f.consume();
  assert.deepEqual(f.checks().map((e) => [e.task, e.detail.members, e.detail.base_sha, e.detail.ok]),
    [['T2', ['T1', 'T2'], f.main, true]], 'one check at the top of the chain merged with main');
  assert.deepEqual(f.suites(), [['T1.txt', 'T2.txt', 'moved.txt']]);
  assert.deepEqual(f.merges(), ['stack merge 12']);
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('after the lower task merges alone, the upper head check runs against main, not the deleted lower branch', (t) => {
  const f = queued(t);
  const scratch = path.join(f.upper.wt.path, 'scratch.txt');
  // A dirty upper worktree defers stack sync, so T2 still names the lower branch.
  fs.writeFileSync(scratch, 'local edit\n');
  f.acceptCode('T1');
  f.consume();
  assert.deepEqual(f.merges(), ['stack merge 11']);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.base, f.lower.branch);
  f.h.git(['push', 'origin', `:${f.lower.branch}`]);
  f.h.git(['update-ref', '-d', `refs/remotes/origin/${f.lower.branch}`]);
  f.write((d) => { d.prs[12].baseRefName = 'main'; });
  const main = f.h.git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
  f.acceptCode('T2');
  f.consume();
  assert.deepEqual(f.checks().map((e) => [e.task, e.detail.members, e.detail.base_sha]),
    [['T1', ['T1'], f.main], ['T2', ['T2'], main]]);
  const stopped = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(stopped.detail.blocked.task, 'T2');
  assert.match(stopped.detail.blocked.reason, /PR base moved; sync its stack/, 'the line records who blocks it and why');
  fs.rmSync(scratch);
  f.h.ok(['stack', 'sync', 'T2']);
  f.consume();
  assert.deepEqual(f.merges(), ['stack merge 11', 'stack merge 12']);
  assert.equal(f.suites().length, 2, 'the synced upper task reuses its check against the same main');
});
