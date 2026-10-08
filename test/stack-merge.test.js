'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, stacked } = require('./stack-fixture');

test('a stack that adds then modifies the same file merges without changing accepted heads', (t) => {
  const f = setup(t);
  const wt = f.h.json(['worktree', 'T2']);
  fs.writeFileSync(path.join(wt.path, 'T1.txt'), 'T2 modified T1\n');
  f.h.git(['add', 'T1.txt'], wt.path);
  const upper = f.submit('T2', 12, wt);
  f.h.ok(['stack', 'link', 'T2']);
  f.accept('T1');
  f.accept('T2');
  const merged = f.h.run(['merge', 'T2']);
  assert.equal(merged.code, 0, `${merged.stdout}\n${merged.stderr}`);
  const data = f.read();
  for (const [pr, head] of [[11, f.sha], [12, upper]]) {
    assert.equal(data.prs[pr].state, 'MERGED');
    assert.equal(data.prs[pr].headRefOid, head);
    assert.notEqual(data.prs[pr].mergeCommit.oid, head);
    assert.equal(f.h.git(['merge-base', head, 'origin/main']), head);
  }
  assert.equal(f.h.git(['show', 'origin/main:T1.txt']), 'T2 modified T1');
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), upper);
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('M4: a head pushed after the last stack check cannot land', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  fs.writeFileSync(path.join(f.lower.path, 'unaccepted.txt'), 'unaccepted\n');
  f.h.git(['add', 'unaccepted.txt'], f.lower.path);
  f.h.git(['commit', '-qm', 'unaccepted work'], f.lower.path);
  f.h.git(['push', 'origin', f.lower.branch], f.lower.path);
  const moved = f.h.git(['rev-parse', 'HEAD'], f.lower.path);
  const base = f.h.git(['ls-remote', 'origin', 'refs/heads/main']);
  f.write((d) => { d.moveOnMerge = { pr: 11, head: moved }; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  const data = f.read();
  assert.equal(data.prs[11].headRefOid, moved);
  assert.equal(data.prs[11].state, 'OPEN', 'the moved head must be refused before merging');
  assert.equal(data.prs[12].state, 'OPEN');
  assert.equal(f.h.git(['ls-remote', 'origin', 'refs/heads/main']), base);
  for (const id of ['T1', 'T2']) {
    assert.equal(f.h.json(['task', 'show', id]).evidence.some((e) => e.type === 'merge' && e.ok), false);
  }
});

test('a later head race stops the chain and records only the accepted lower merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  fs.writeFileSync(path.join(f.upper.wt.path, 'unaccepted.txt'), 'unaccepted\n');
  f.h.git(['add', 'unaccepted.txt'], f.upper.wt.path);
  f.h.git(['commit', '-qm', 'unaccepted upper work'], f.upper.wt.path);
  f.h.git(['push', 'origin', f.upper.wt.branch], f.upper.wt.path);
  const moved = f.h.git(['rev-parse', 'HEAD'], f.upper.wt.path);
  f.write((d) => { d.moveOnMerge = { pr: 12, head: moved, onPr: 12 }; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /head commit does not match/);
  const data = f.read();
  assert.equal(data.prs[11].state, 'MERGED');
  assert.equal(data.prs[11].headRefOid, f.sha);
  assert.equal(data.prs[12].state, 'OPEN');
  assert.equal(f.h.git(['rev-parse', 'origin/main']), data.prs[11].mergeCommit.oid);
  assert.equal(f.h.git(['merge-base', f.sha, 'origin/main']), f.sha);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.some((e) => e.type === 'merge' && e.ok), false);
});

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
  const squash = f.read().prs[11].mergeCommit.oid;
  assert.notEqual(squash, f.sha);
  assert.equal(f.h.git(['show', '-s', '--format=%P', squash]).split(' ').length, 1);
  assert.notEqual(f.h.git(['merge-base', f.sha, squash]), f.sha);
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
  f.h.ok(['merge', 'T2', '--method', 'merge']);
  const merges = f.read().calls.filter((c) => c.args[1] === 'merge');
  assert.deepEqual(merges.map((c) => c.args.slice(0, 3)), [['pr', 'merge', '11'], ['pr', 'merge', '12']]);
  for (const [index, head] of [f.sha, f.upper.sha].entries()) {
    assert.equal(merges[index].args[merges[index].args.indexOf('--match-head-commit') + 1], head);
    assert.ok(merges[index].args.includes('--merge'));
    assert.ok(!merges[index].args.includes('--delete-branch'));
  }
  assert.equal(f.read().prs[12].baseRefName, 'main');
  for (const id of ['T1', 'T2']) {
    const task = f.h.json(['task', 'show', id]);
    const evidence = task.evidence.findLast((e) => e.type === 'merge');
    assert.equal(evidence.ok, true);
    assert.ok(evidence.commands.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge' && c.args.includes('--match-head-commit')));
    assert.match(task.phase?.label || f.h.ok(['task', 'show', id]), /merged/);
  }
  const upper = f.h.git(['rev-parse', 'HEAD'], f.h.json(['worktree', 'T2']).path);
  assert.equal(f.h.git(['merge-base', upper, 'origin/main']), upper);
  assert.equal(f.h.git(['rev-parse', 'origin/main^{tree}']), f.h.git(['rev-parse', `${upper}^{tree}`]));
  f.write((d) => { d.linked = false; });
  f.h.ok(['merge', 'T1']);
  f.h.ok(['merge', 'T2']);
  assert.equal(f.read().calls.filter((c) => c.args[1] === 'merge').length, 2);
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
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.queued = true; });
  assert.equal(f.h.run(['merge', 'T2']).code, 1);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.some((e) => e.type === 'merge'), false);
  let base = f.h.git(['rev-parse', 'origin/main']);
  f.write((d) => {
    d.linked = false;
    for (const pr of Object.values(d.prs)) {
      const tree = f.h.git(['rev-parse', `${pr.headRefOid}^{tree}`]);
      base = f.h.git(['commit-tree', tree, '-p', base, '-p', pr.headRefOid, '-m', `Queued merge PR #${pr.number}`]);
      pr.state = 'MERGED';
      pr.mergeCommit = { oid: base };
    }
  });
  f.h.git(['push', 'origin', `${base}:main`]);
  f.h.ok(['merge', 'T2']);
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
  const merges = f.read().calls.filter((c) => c.args[1] === 'merge');
  assert.deepEqual(merges.map((c) => c.args.slice(0, 3)), [['pr', 'merge', '11']]);
});

test('linked stacks refuse squash and rebase to preserve accepted dependency ancestry', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  for (const method of ['squash', 'rebase']) {
    const r = f.h.run(['merge', 'T2', '--method', method]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /stack merges use merge commits/);
  }
  assert.equal(f.read().calls.some((c) => c.args[1] === 'merge'), false);
});

test('a refused upper merge retains lower evidence and retries without merging the lower PR again', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.refuseMergePr = 12; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Base branch policy prohibits the merge/);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.equal(f.read().prs[12].baseRefName, 'main');
  assert.equal(f.read().prs[12].state, 'OPEN');
  f.write((d) => { delete d.refuseMergePr; });
  f.h.ok(['merge', 'T2']);
  const merges = f.read().calls.filter((c) => c.args[1] === 'merge');
  assert.deepEqual(merges.map((c) => c.args.slice(0, 3)),
    [['pr', 'merge', '11'], ['pr', 'merge', '12'], ['pr', 'merge', '12']]);
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'merge').ok, true);
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

test('a task changed during the lower merge stops before the upper merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    d.during = { 'pr merge': [['rework', 'T2', '--reason', 'another worker takes over'], ['claim', 'T2', '--agent', 'worker-new']] };
  });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed during stack head checks/);
  assert.deepEqual(f.read().calls.filter((c) => c.args[1] === 'merge').map((c) => c.args.slice(0, 3)), [['pr', 'merge', '11']]);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.claim.agent, 'worker-new');
  assert.equal(task.stack.linked, true);
  assert.equal(task.stack_disabled, undefined);
  assert.equal(f.h.json(['task', 'show', 'T1']).stack_disabled, undefined);
});

test('a bottom PR with a stale local link to its dependent merges through gh stack merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  const state = f.h.readState('tasks.json');
  state.tasks.find((item) => item.id === 'T2').stack.linked = false;
  f.h.writeState('tasks.json', state);
  f.write((d) => { d.refuseStackedPrMerge = true; });

  const r = f.h.run(['merge', 'T1']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(f.read().prs[11].state, 'MERGED');
  assert.ok(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'merge' && c.args[2] === '11'));
});

test('after a lower stack merge, a dependent whose head GitHub moved takes the new head and needs its gates again', (t) => {
  const f = stacked(t);
  f.accept('T1');
  const wt = f.upper.wt;
  f.h.git(['commit', '--allow-empty', '-qm', 'T2 rebased onto main'], wt.path);
  f.h.git(['push', 'origin', wt.branch], wt.path);
  const rebased = f.h.git(['rev-parse', 'HEAD'], wt.path);
  f.write((d) => { d.rebased = { 12: rebased }; });

  const r = f.h.run(['merge', 'T1']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.sha, rebased);
  assert.equal(task.status, 'submitted');
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
