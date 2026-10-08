'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, stacked } = require('./stack-fixture');
const { BIN } = require('./helpers');

test('lower merge refreshes upper worktrees with gh stack sync and conflicts send upper work to rework', (t) => {
  const f = stacked(t);
  const { wt, sha } = f.upper;
  f.h.ok(['evidence', 'T2', '--type', 'review', '--fail', '--sha', sha, '--revision', f.h.revision('T2'), '--agent', 'reviewer',
    '--summary', 'Resolve the upper conflict', '--ref', 'stack-conflict-review']);
  const before = f.h.json(['task', 'show', 'T2']);
  f.accept('T1');
  f.write((d) => { d.conflict = true; });
  f.h.ok(['merge', 'T1']);
  const calls = f.read().calls;
  assert.ok(calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'checkout'));
  assert.ok(calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync' && c.cwd === wt.path));
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), sha);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.status, 'rework');
  assert.equal(task.revision, before.revision + 1);
  assert.deepEqual(task.evidence, before.evidence);
  const rework = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .findLast(e => e.cmd === 'rework' && e.task === 'T2');
  assert.equal(rework.detail.previous_revision, before.revision);
  assert.equal(rework.detail.revision, task.revision);
  assert.match(task.notes.at(-1).text, /all branches restored/);
  assert.match(f.h.ok(['brief', 'get', 'T2']), /Rework notes/);
  assert.match(f.h.json(['spawn', '--task', 'T2', '--dry-run']).argv.join('\n'), /Resolve the upper conflict/);

  const prompt = path.join(f.h.base, 'worker-prompt');
  const script = `
require('node:child_process').execFileSync(process.execPath, ${JSON.stringify([BIN, 'claim', 'T2'])}, { env: process.env });
require('node:fs').writeFileSync(process.argv[1], process.argv[2]);
`;
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model', '--clear', 'profile',
    '--clear', 'provider', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, '-e', script, prompt, '{prompt}'])]);
  const spawned = f.h.json(['spawn', '--task', 'T2', '--wait']);
  const received = fs.readFileSync(prompt, 'utf8');
  assert.match(received, /Resolve the upper conflict/);
  assert.match(received, /stack-conflict-review/);
  const held = f.h.json(['task', 'show', 'T2']);
  assert.equal(held.claim.agent, spawned.agent);
  assert.equal(held.claim.from, 'rework');
  assert.ok(held.revision > task.revision, 'worker dispatch retried the unresolved stack refresh');
  assert.deepEqual(held.evidence, before.evidence);
  assert.equal(held.gates.ok, false);
  const retried = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.cmd === 'rework' && e.task === 'T2');
  assert.ok(retried.length > 1);
  assert.ok(retried.every(e => e.detail.previous_revision === before.revision));

  const clock = path.join(f.h.base, 'expired-claim-clock');
  fs.writeFileSync(clock, String(Date.parse(held.claim.until) + 1));
  assert.equal(f.h.run(['stack', 'sync', 'T2'], { hooks: { HOOK_CLOCK_FILE: clock } }).code, 1);
  const afterExpiry = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .findLast(e => e.cmd === 'rework' && e.task === 'T2');
  assert.equal(afterExpiry.detail.previous_revision, before.revision);
  f.h.ok(['claim', 'T2', '--agent', spawned.agent]);
  f.h.ok(['submit', 'T2', '--sha', sha, '--agent', spawned.agent]);
  f.h.ok(['evidence', 'T2', '--type', 'review', '--fail', '--sha', sha, '--revision', f.h.revision('T2'), '--agent', 'reviewer-next',
    '--summary', 'Resolve the next review']);
  assert.equal(f.h.run(['stack', 'sync', 'T2']).code, 1);
  f.h.json(['spawn', '--task', 'T2', '--wait']);
  const nextPrompt = fs.readFileSync(prompt, 'utf8');
  assert.match(nextPrompt, /Resolve the next review/);
  assert.doesNotMatch(nextPrompt, /Failed review by reviewer at/);
});

test('sync rework preserves a brief deletion that races its append', (t) => {
  const f = stacked(t);
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
    const f = stacked(t);
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

test('main movement refreshes an idle stack and changed heads require fresh submissions', (t) => {
  const f = stacked(t);
  f.h.git(['commit', '--allow-empty', '-qm', 'main moved']);
  f.h.git(['push', 'origin', 'main']);
  f.write((d) => { d.syncCommit = true; });
  f.h.ok(['worktree', 'T2']);
  assert.ok(f.read().calls.some((c) => c.args[1] === 'sync'));
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /submit it and rerun gates/);
});

test('stack sync refuses live workers and dirty worktrees without invoking gh sync', (t) => {
  const f = stacked(t);
  const { wt } = f.upper;
  fs.writeFileSync(path.join(wt.path, 'untracked.txt'), 'work in progress\n');
  assert.match(f.h.run(['stack', 'sync', 'T2']).stderr, /clean worktree/);
  fs.unlinkSync(path.join(wt.path, 'untracked.txt'));
  f.h.ok(['rework', 'T2', '--reason', 'more work']);
  f.h.ok(['claim', 'T2', '--agent', 'worker-live']);
  assert.match(f.h.run(['stack', 'sync', 'T2']).stderr, /live worker/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'sync'), false);
});
