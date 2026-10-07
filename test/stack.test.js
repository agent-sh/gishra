'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN } = require('./helpers');

function worker(f) {
  const script = path.join(f.h.base, 'worker.js');
  fs.writeFileSync(script, `const fs = require('node:fs');
const cp = require('node:child_process');
const bin = ${JSON.stringify(BIN)};
const task = process.env.TOWER_CRANE_TASK;
const cli = (args) => cp.execFileSync(process.execPath, [bin, ...args], {encoding: 'utf8'});
const git = (args) => cp.execFileSync('git', args, {encoding: 'utf8'}).trim();
cli(['claim', task]);
const state = JSON.parse(cli(['task', 'show', task, '--json']));
fs.writeFileSync(task + '.txt', task + '\\n');
git(['add', task + '.txt']);
git(['commit', '-qm', task]);
git(['push', 'origin', state.branch]);
const sha = git(['rev-parse', 'HEAD']);
const file = process.env.TEST_STACK_DATA;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.prs[12] = {number: 12, state: 'OPEN', headRefOid: sha, headRefName: state.branch,
  baseRefName: state.stack.base, isCrossRepository: false, autoMergeRequest: null};
fs.writeFileSync(file, JSON.stringify(data));
process.stdout.write(cli(['submit', task, '--sha', sha, '--pr', '12']));
`);
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, script])]);
}

function setup(t) {
  const h = makeRepo(t);
  const remote = path.join(h.base, 'remote.git');
  h.git(['init', '--bare', remote]);
  h.git(['remote', 'add', 'origin', remote]);
  h.git(['push', 'origin', 'main']);
  h.init(['--repo', 'acme/app']);
  const file = path.join(h.base, 'github.json');
  const data = { repo: h.repo, prs: {}, calls: [], order: [], linked: false };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (fn) => { const d = read(); fn(d); fs.writeFileSync(file, JSON.stringify(d)); };
  fs.writeFileSync(file, JSON.stringify(data));
  h.env.TEST_STACK_DATA = file;
  h.env.NODE_OPTIONS = `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'stack-gh.js'))}`;
  const add = (title, dep) => {
    const task = h.json(['task', 'add', '--title', title, '--kind', 'docs', '--acceptance', 'works', ...(dep ? ['--dep', dep] : [])]);
    h.ok(['brief', 'set', task.id, '-'], { input: `# ${task.id}\n\n## Worker\nBuild the change.\n` });
    return task.id;
  };
  const submit = (id, pr, wt) => {
    fs.writeFileSync(path.join(wt.path, `${id}.txt`), `${id}\n`);
    h.git(['add', `${id}.txt`], wt.path);
    h.git(['commit', '-qm', id], wt.path);
    h.git(['push', 'origin', wt.branch], wt.path);
    const sha = h.git(['rev-parse', 'HEAD'], wt.path);
    write((d) => { d.prs[pr] = { number: pr, state: 'OPEN', headRefOid: sha, headRefName: wt.branch,
      baseRefName: h.json(['task', 'show', id]).stack?.base || 'main', isCrossRepository: false, autoMergeRequest: null }; });
    h.ok(['claim', id, '--agent', `worker-${id}`]);
    h.ok(['submit', id, '--sha', sha, '--branch', wt.branch, '--pr', String(pr), '--agent', `worker-${id}`]);
    return sha;
  };
  const accept = (id) => h.ok(['accept', id, '--waive', 'review', '--waive', 'ci', '--reason', 'offline stack fixture']);
  add('lower');
  const lower = h.json(['worktree', 'T1']);
  const sha = submit('T1', 11, lower);
  add('upper', 'T1');
  return { h, read, write, add, submit, accept, lower, sha };
}

function upper(f) {
  const wt = f.h.json(['worktree', 'T2']);
  const sha = f.submit('T2', 12, wt);
  f.h.ok(['stack', 'link', 'T2']);
  return { wt, sha };
}

test('submitted dependencies dispatch from the exact dependency head and spawn links PRs bottom to top', (t) => {
  const f = setup(t);
  assert.match(f.h.ok(['ready']), /T2/);
  const wt = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.sha);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.base, f.lower.branch);
  worker(f);
  f.h.ok(['spawn', '--task', 'T2', '--wait']);
  const link = f.read().calls.find((c) => c.args[0] === 'stack' && c.args[1] === 'link');
  assert.deepEqual(link.args, ['stack', 'link', '11', '12', '--base', 'main']);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.linked, true);
});

test('detached spawn links the PR after its worker submits and exits', async (t) => {
  const f = setup(t);
  worker(f);
  f.h.ok(['spawn', '--task', 'T2']);
  const until = Date.now() + 15000;
  let task;
  do {
    task = f.h.json(['task', 'show', 'T2']);
    if (task.stack?.linked) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < until);
  assert.equal(task.stack.linked, true);
  assert.equal(task.status, 'submitted');
  assert.deepEqual(f.read().order, [11, 12]);
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
  const f = setup(t);
  upper(f);
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
  const f = setup(t);
  upper(f);
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
  const f = setup(t);
  const { wt } = upper(f);
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

test('lower merge refreshes upper worktrees with gh stack sync and conflicts send upper work to rework', (t) => {
  const f = setup(t);
  const { wt, sha } = upper(f);
  f.accept('T1');
  f.write((d) => { d.conflict = true; });
  f.h.ok(['merge', 'T1']);
  const calls = f.read().calls;
  assert.ok(calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'checkout'));
  assert.ok(calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync' && c.cwd === wt.path));
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), sha);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /all branches restored/);
  assert.match(f.h.ok(['brief', 'get', 'T2']), /Rework notes/);
});

test('sync rework preserves a brief deletion that races its append', (t) => {
  const f = setup(t);
  upper(f);
  f.write((d) => { d.conflict = true; });
  const brief = path.join(f.h.state, 'briefs', 'T2.md');
  const race = path.join(__dirname, 'fixtures', 'stack-brief-race.js');
  const r = f.h.run(['stack', 'sync', 'T2'], { env: {
    TEST_REMOVE_BRIEF: brief,
    NODE_OPTIONS: `${f.h.env.NODE_OPTIONS} --require=${JSON.stringify(race)}`,
  } });
  assert.equal(r.code, 1);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'rework');
  assert.equal(fs.existsSync(brief), false, 'a removed brief must not be recreated by appending rework notes');
});

for (const related of [false, true]) {
  test(`slow stack sync preserves a concurrent ${related ? 'stack member' : 'unrelated task'} claim after the lock lease expires`, async (t) => {
    const f = setup(t);
    upper(f);
    const id = related ? 'T2' : f.add('independent');
    if (related) f.h.ok(['rework', id, '--reason', 'prepare for another worker']);
    f.write((d) => { d.syncCommit = true; });
    const ready = path.join(f.h.base, 'sync-ready');
    const release = path.join(f.h.base, 'sync-release');
    const clock = path.join(f.h.base, 'clock');
    const now = Date.now();
    fs.writeFileSync(clock, String(now));
    const synced = f.h.runAsync(['stack', 'sync', 'T2'], {
      env: { TEST_STACK_SYNC_READY: ready, TEST_STACK_SYNC_RELEASE: release },
      hooks: { HOOK_CLOCK_FILE: clock },
    });
    try {
      const deadline = performance.now() + 15000;
      while (!fs.existsSync(ready)) {
        if (performance.now() > deadline) throw new Error('gh sync never started');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      fs.writeFileSync(clock, String(now + 120000));
      const claimed = f.h.json(['claim', id, '--agent', 'worker-concurrent'], { hooks: { HOOK_CLOCK_FILE: clock } });
      fs.writeFileSync(release, 'release');
      const result = await synced;
      const task = f.h.json(['task', 'show', id]);
      assert.equal(task.status, 'in_progress');
      assert.deepEqual(task.claim, claimed.claim, 'sync must preserve the new worker and its lease');
      if (related) {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /changed during stack sync/);
        assert.deepEqual(task.stack, claimed.stack);
        const events = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(events.some((e) => e.cmd === 'stack sync'), false, 'a stale sync result must not be recorded');
      } else {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(f.h.json(['task', 'show', 'T2']).status, 'rework');
      }
    } finally {
      fs.writeFileSync(release, 'release');
      await synced;
    }
  });
}

for (const related of [false, true]) {
  test(`slow PR linking preserves a concurrent ${related ? 'member' : 'unrelated'} claim after lock expiry`, async (t) => {
    const f = setup(t);
    const wt = f.h.json(['worktree', 'T2']);
    f.submit('T2', 12, wt);
    const id = related ? 'T2' : f.add('independent');
    const ready = path.join(f.h.base, 'link-ready');
    const release = path.join(f.h.base, 'link-release');
    const clock = path.join(f.h.base, 'clock');
    const now = Date.now();
    fs.writeFileSync(clock, String(now));
    const linked = f.h.runAsync(['stack', 'link', 'T2'], {
      env: { TEST_STACK_LINK_READY: ready, TEST_STACK_LINK_RELEASE: release },
      hooks: { HOOK_CLOCK_FILE: clock },
    });
    try {
      const deadline = performance.now() + 15000;
      while (!fs.existsSync(ready)) {
        if (performance.now() > deadline) throw new Error('gh link never started');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      fs.writeFileSync(clock, String(now + 120000));
      const opts = { hooks: { HOOK_CLOCK_FILE: clock } };
      if (related) f.h.ok(['rework', id, '--reason', 'another worker takes over'], opts);
      const claimed = f.h.json(['claim', id, '--agent', 'worker-concurrent'], opts);
      fs.writeFileSync(release, 'release');
      const result = await linked;
      const task = f.h.json(['task', 'show', id]);
      assert.equal(task.status, 'in_progress');
      assert.deepEqual(task.claim, claimed.claim);
      if (related) {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /changed during stack link/);
        assert.deepEqual(task.stack, claimed.stack);
      } else {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(f.h.json(['task', 'show', 'T2']).stack.linked, true);
      }
    } finally {
      fs.writeFileSync(release, 'release');
      await linked;
    }
  });
}

for (const [setting, cli] of [['base', ['project', 'set', '--base', 'release']], ['admin', ['project', 'set', '--merge-admin', 'true']]]) {
  test(`a project ${setting} change during the final head checks stops the stack merge`, (t) => {
    const f = setup(t);
    upper(f);
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
  const f = setup(t);
  upper(f);
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

test('a worktree prepared before its dependency was submitted moves onto the dependency head at dispatch', (t) => {
  const f = setup(t);
  f.add('top', 'T2');
  const early = f.h.json(['worktree', 'T3']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], early.path), f.h.git(['rev-parse', 'main']));
  const { wt, sha } = upper(f);
  const again = f.h.json(['worktree', 'T3']);
  assert.equal(again.path, early.path);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], early.path), sha);
  const task = f.h.json(['task', 'show', 'T3']);
  assert.equal(task.stack.parent, 'T2');
  assert.equal(task.stack.base, wt.branch);
});

test('a stale worktree with its own work refuses stacked dispatch', (t) => {
  const f = setup(t);
  f.add('top', 'T2');
  const early = f.h.json(['worktree', 'T3']);
  fs.writeFileSync(path.join(early.path, 'T3.txt'), 'T3\n');
  f.h.git(['add', 'T3.txt'], early.path);
  f.h.git(['commit', '-qm', 'early T3'], early.path);
  const head = f.h.git(['rev-parse', 'HEAD'], early.path);
  upper(f);
  const r = f.h.run(['worktree', 'T3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /prepared before T2 was submitted and holds its own changes/);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], early.path), head);
  assert.equal(f.h.json(['task', 'show', 'T3']).stack, undefined);
});

test('concurrent sibling dispatch on one submitted dependency records a single stack child', async (t) => {
  const f = setup(t);
  f.add('sibling', 'T1');
  const ready = path.join(f.h.base, 'view-ready');
  const release = path.join(f.h.base, 'view-release');
  const slow = f.h.runAsync(['worktree', 'T3'], {
    env: { TEST_STACK_PAUSE_VIEW: '11', TEST_STACK_PAUSE_READY: ready, TEST_STACK_PAUSE_RELEASE: release },
  });
  try {
    const deadline = performance.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (performance.now() > deadline) throw new Error('T3 preparation never read the dependency PR');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    f.h.json(['worktree', 'T2']);
  } finally {
    fs.writeFileSync(release, 'release');
  }
  const r = await slow;
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /changed during stack dispatch/);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent, 'T1');
  assert.equal(f.h.json(['task', 'show', 'T3']).stack, undefined);
  assert.match(f.h.run(['worktree', 'T3']).stderr, /one available stack chain/);
});

test('main movement refreshes an idle stack and changed heads require fresh submissions', (t) => {
  const f = setup(t);
  upper(f);
  f.h.git(['commit', '--allow-empty', '-qm', 'main moved']);
  f.h.git(['push', 'origin', 'main']);
  f.write((d) => { d.syncCommit = true; });
  f.h.ok(['worktree', 'T2']);
  assert.ok(f.read().calls.some((c) => c.args[1] === 'sync'));
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /submit it and rerun gates/);
});

test('unavailable stacks fall back for accepted dependencies and wait for submitted ones', (t) => {
  const f = setup(t);
  f.write((d) => { d.unavailable = true; });
  const waiting = f.h.run(['worktree', 'T2']);
  assert.equal(waiting.code, 1);
  assert.match(waiting.stderr, /stacks unavailable/);
  f.accept('T1');
  const wt = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.h.git(['rev-parse', 'main']));
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
});

test('same repo and one dependency chain are required for early dispatch', (t) => {
  const f = setup(t);
  f.write((d) => { d.prs[11].isCrossRepository = true; });
  assert.match(f.h.run(['worktree', 'T2']).stderr, /same-repository/);
  f.write((d) => { d.prs[11].isCrossRepository = false; });
  upper(f);
  f.add('fork', 'T1');
  assert.equal(f.h.run(['claim', 'T3']).code, 1);
  f.add('independent');
  const wt = f.h.json(['worktree', 'T4']);
  f.submit('T4', 14, wt);
  f.add('join', 'T1');
  f.h.ok(['task', 'update', 'T5', '--dep', 'T1', '--dep', 'T4']);
  assert.equal(f.h.run(['claim', 'T5']).code, 1);
  assert.match(f.h.run(['worktree', 'T5']).stderr, /one available stack chain/);
});

test('pull_request webhook stack object appears in task show and the board', (t) => {
  const f = setup(t);
  const stack = { id: 5, pull_requests: [{ number: 11 }, { number: 12 }] };
  const payload = { repository: { full_name: 'acme/app' }, action: 'stacked', pull_request: { number: 11, stack } };
  f.h.ok(['stack', 'webhook', '-'], { input: JSON.stringify(payload) });
  assert.deepEqual(f.h.json(['task', 'show', 'T1']).github_stack, stack);
  assert.match(f.h.ok(['task', 'show', 'T1']), /GitHub stack:.*pull_requests/);
  assert.match(fs.readFileSync(path.join(f.h.state, 'sketch.html'), 'utf8'), /GitHub stack.*pull_requests/);
  delete payload.pull_request.stack;
  payload.stack = { id: 8 };
  f.h.ok(['stack', 'webhook', '-'], { input: JSON.stringify(payload) });
  assert.deepEqual(f.h.json(['task', 'show', 'T1']).github_stack, payload.stack);
  payload.stack = null;
  f.h.ok(['stack', 'webhook', '-'], { input: JSON.stringify(payload) });
  assert.equal(f.h.json(['task', 'show', 'T1']).github_stack, null);
  payload.repository.full_name = 'fork/app';
  assert.equal(f.h.run(['stack', 'webhook', '-'], { input: JSON.stringify(payload) }).code, 1);
});

test('three dependent PRs form one stack and all accepted lower tasks get merge evidence', (t) => {
  const f = setup(t);
  upper(f);
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
  const f = setup(t);
  upper(f);
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

test('stack sync refuses live workers and dirty worktrees without invoking gh sync', (t) => {
  const f = setup(t);
  const { wt } = upper(f);
  fs.writeFileSync(path.join(wt.path, 'untracked.txt'), 'work in progress\n');
  assert.match(f.h.run(['stack', 'sync', 'T2']).stderr, /clean worktree/);
  fs.unlinkSync(path.join(wt.path, 'untracked.txt'));
  f.h.ok(['rework', 'T2', '--reason', 'more work']);
  f.h.ok(['claim', 'T2', '--agent', 'worker-live']);
  assert.match(f.h.run(['stack', 'sync', 'T2']).stderr, /live worker/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'sync'), false);
});

test('lower acceptance cannot hide failing current gate evidence', (t) => {
  const f = setup(t);
  upper(f);
  f.accept('T1');
  f.accept('T2');
  f.h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', f.sha, '--agent', 'reviewer-independent']);
  assert.match(f.h.run(['merge', 'T2']).stdout, /T1.*passing gates/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'merge'), false);
});

test('local CI covers each dependency base and merge rechecks lower receipts', (t) => {
  const f = setup(t);
  upper(f);
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
  const f = setup(t);
  upper(f);
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
  const f = setup(t);
  upper(f);
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

test('older gh-stack versions fall back before creating a dependency-based branch', (t) => {
  const f = setup(t);
  f.accept('T1');
  f.write((d) => { d.version = '0.1.1'; });
  const wt = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.h.git(['rev-parse', 'main']));
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
  assert.equal(f.read().calls.some((c) => c.args[0] === 'api' && c.args[1].includes('/stacks')), false);
});
