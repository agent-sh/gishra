'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN } = require('./helpers');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

function setup(t, workers = 1, tasks = 3) {
  const h = makeRepo(t);
  h.init(['--workers', String(workers)]);
  for (let i = 1; i <= tasks; i++) {
    h.ok(['task', 'add', '--title', `Slot ${i}`, '--tier', 'easy', '--acceptance', 'slot is held']);
    h.ok(['brief', 'set', `T${i}`, '-'], { input: 'Work in this task.\n' });
  }
  return h;
}

async function until(fn, message) {
  const deadline = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function controlledHarness(h) {
  const script = path.join(h.base, 'worker.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const task = process.env.TOWER_CRANE_TASK;
const base = process.argv[3];
fs.writeFileSync(path.join(base, task + '.started'), '');
if (process.env.SLOT_RETRY && process.env.TOWER_CRANE_RETRY === '0') process.exit(75);
const timer = setInterval(() => {
  if (fs.existsSync(path.join(base, task + '.claim'))) {
    fs.unlinkSync(path.join(base, task + '.claim'));
    const r = cp.spawnSync(process.execPath, [process.argv[2], 'claim', task], { encoding: 'utf8', timeout: 10000 });
    fs.writeFileSync(path.join(base, task + '.claimed'), JSON.stringify({ code: r.status, stderr: r.stderr }));
  }
  if (fs.existsSync(path.join(base, task + '.exit'))) {
    clearInterval(timer);
    process.exit(0);
  }
}, 25);
`);
  h.ok(['ladder', 'set', 'easy', '--harness', 'command',
    '--command', JSON.stringify([process.execPath, script, BIN, h.base]), '--clear', 'profile', '--clear', 'effort']);
}

test('five held worker slots refuse dispatch before process, home or spend', (t) => {
  const h = setup(t, 5, 6);
  for (let i = 1; i <= 5; i++) h.ok(['claim', `T${i}`, '--agent', `held-${i}`]);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex' + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
  const opts = {
    env: { PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), CODEX_HOME: path.join(h.base, 'codex') },
    hooks: { HOOK_USAGE_HARNESS: 'codex', HOOK_USAGE_FILE: path.join(__dirname, 'fixtures', 'usage', 'codex-stream.jsonl') },
  };
  const beforeTasks = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
  const beforeEvents = events(h);
  for (const role of [[], ['--role', 'easy']]) {
    const r = h.run(['spawn', '--task', 'T6', ...role, '--wait'], opts);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /workers limit is reached/);
    for (let i = 1; i <= 5; i++) assert.match(r.stderr, new RegExp(`T${i}.*held-${i}`));
    assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), beforeTasks);
    assert.deepEqual(events(h), beforeEvents);
    assert.equal(h.detached().length, 0, 'no harness starts');
    assert.ok(!fs.existsSync(path.join(h.state, 'homes')), 'no home is written');
    assert.ok(!fs.existsSync(path.join(h.state, 'logs')), 'no log is written');
  }
});

test('concurrent dispatch reserves the last slot until claim and does not double count it', async (t) => {
  const h = setup(t, 1, 3);
  controlledHarness(h);
  h.ok(['worktree', 'T1', 'T2']);
  const results = await Promise.all(['T1', 'T2'].map((id) => h.runAsync(['spawn', '--task', id, '--json'])));
  assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results));
  const winner = JSON.parse(results.find((r) => r.code === 0).stdout);
  const task = winner.agent.includes('T1') ? 'T1' : 'T2';
  const loser = task === 'T1' ? 'T2' : 'T1';
  assert.match(results.find((r) => r.code !== 0).stderr, new RegExp(`${task}.*${winner.agent}`));
  await until(() => fs.existsSync(path.join(h.base, `${task}.started`)), 'worker did not start');
  assert.ok(!fs.existsSync(path.join(h.base, `${loser}.started`)));
  assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 1);
  const claim = h.run(['claim', 'T3', '--agent', 'manual']);
  assert.equal(claim.code, 1, claim.stderr);
  assert.match(claim.stderr, new RegExp(`${task}.*${winner.agent}`));
  h.ok(['claim', task, '--agent', winner.agent]);
  h.ok(['project', 'set', '--workers', '2']);
  h.ok(['claim', 'T3', '--agent', 'manual']);
  h.ok(['release', task, '--agent', winner.agent, '--reason', 'finished slot test']);
  h.ok(['claim', loser, '--agent', 'replacement']);
  fs.writeFileSync(path.join(h.base, `${task}.exit`), '');
});

test('a delayed child claim consumes its reservation when every slot is held', async (t) => {
  const h = setup(t, 2, 3);
  controlledHarness(h);
  h.ok(['claim', 'T3', '--agent', 'manual']);
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(() => fs.existsSync(path.join(h.base, 'T1.started')), 'worker did not start');
  const stranger = h.run(['claim', 'T1', '--agent', 'stranger']);
  assert.equal(stranger.code, 1, stranger.stderr);
  assert.match(stranger.stderr, /T1.*worker-T1-1.*reservation/);
  fs.writeFileSync(path.join(h.base, 'T1.claim'), '');
  await until(() => fs.existsSync(path.join(h.base, 'T1.claimed')), 'worker did not claim');
  const claim = JSON.parse(fs.readFileSync(path.join(h.base, 'T1.claimed'), 'utf8'));
  assert.equal(claim.code, 0, claim.stderr);
  assert.equal(h.readState('tasks.json').tasks[0].claim.agent, spawned.agent);
  assert.equal(h.run(['claim', 'T2', '--agent', 'another']).code, 1);
  fs.writeFileSync(path.join(h.base, 'T1.exit'), '');
});

test('an unclaimed exit and a failed launch both free the reserved slot', async (t) => {
  const h = setup(t);
  controlledHarness(h);
  const failed = h.run(['spawn', '--task', 'T1'], { hooks: { HOOK_SPAWN_FAIL: '1' } });
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 0);
  const spawned = h.json(['spawn', '--task', 'T1']);
  assert.equal(spawned.agent, 'worker-T1-1');
  await until(() => fs.existsSync(path.join(h.base, 'T1.started')), 'worker did not start');
  assert.equal(h.run(['claim', 'T2', '--agent', 'manual']).code, 1);
  fs.writeFileSync(path.join(h.base, 'T1.exit'), '');
  await until(() => events(h).some((e) => e.cmd === 'spawn exit' && e.detail.agent === spawned.agent), 'exit was not recorded');
  h.ok(['claim', 'T2', '--agent', 'manual']);
});

test('reviewer dispatch is unaffected when worker reservations fill the limit', async (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T2', '--kind', 'docs']);
  h.ok(['claim', 'T2', '--agent', 'builder']);
  h.ok(['submit', 'T2', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'builder']);
  controlledHarness(h);
  h.json(['spawn', '--task', 'T1']);
  await until(() => fs.existsSync(path.join(h.base, 'T1.started')), 'worker did not start');
  fs.writeFileSync(path.join(h.base, 'T2.exit'), '');
  const reviewer = h.json(['spawn', '--task', 'T2', '--role', 'review', '--wait']);
  assert.equal(reviewer.role, 'reviewer');
  assert.equal(reviewer.code, 0);
  assert.equal(h.run(['claim', 'T3', '--agent', 'manual']).code, 1);
  fs.writeFileSync(path.join(h.base, 'T1.exit'), '');
});

test('dispatch rechecks slots under the lock after worktree preparation', async (t) => {
  const h = setup(t);
  controlledHarness(h);
  const paused = path.join(h.base, 'prepared');
  const spawning = h.runAsync(['spawn', '--task', 'T1'], { hooks: { HOOK_STOP_WORKTREE_ADD: paused } });
  try {
    await until(() => fs.existsSync(paused), 'spawn did not prepare its worktree');
    h.ok(['claim', 'T2', '--agent', 'late-holder']);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    fs.writeFileSync(path.join(h.base, 'T1.exit'), '');
  }
  const r = await spawning;
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /T2.*late-holder/);
  assert.equal(h.detached().length, 0);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 0);
});

test('an unclaimed retry holds its slot through backoff and expired-lease renewal', async (t) => {
  const h = setup(t, 1);
  h.ok(['claim', 'T3', '--agent', 'expired']);
  const doc = h.readState('tasks.json');
  doc.tasks[2].claim.until = new Date(Date.now() - 1000).toISOString();
  h.writeState('tasks.json', doc);
  controlledHarness(h);
  h.ok(['ladder', 'set', 'easy', '--supervision', JSON.stringify({ retries: 1, backoff_ms: 3000, max_backoff_ms: 3000 })]);
  const spawned = h.json(['spawn', '--task', 'T1'], { env: { SLOT_RETRY: '1' } });
  await until(() => events(h).some((e) => e.cmd === 'spawn phase' && e.detail.phase === 'retrying'), 'worker did not enter backoff');
  const renew = h.run(['renew', 'T3', '--agent', 'expired']);
  assert.equal(renew.code, 1, renew.stderr);
  assert.match(renew.stderr, /T1.*worker-T1-1.*reservation/);
  const refused = h.run(['spawn', '--task', 'T2']);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /T1.*worker-T1-1.*reservation/);
  await until(() => events(h).some((e) => e.cmd === 'spawn retry'), 'worker did not retry');
  h.ok(['claim', 'T1', '--agent', spawned.agent]);
  assert.equal(h.run(['claim', 'T2', '--agent', 'manual']).code, 1);
  h.ok(['release', 'T1', '--agent', spawned.agent, '--reason', 'slot returned']);
  h.ok(['renew', 'T3', '--agent', 'expired']);
  fs.writeFileSync(path.join(h.base, 'T1.exit'), '');
});

test('an expired pre-claim holds the only slot before supervision can renew', async (t) => {
  const h = setup(t, 1);
  controlledHarness(h);
  h.ok(['worktree', 'T1', 'T3']);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  const doc = h.readState('tasks.json');
  doc.tasks[0].claim.until = new Date(Date.now() - 1000).toISOString();
  h.writeState('tasks.json', doc);
  const original = h.readState('tasks.json').tasks[0].claim;
  const audit = events(h);
  const failed = h.run(['spawn', '--task', 'T1'], { hooks: { HOOK_SPAWN_FAIL: '1' } });
  assert.equal(failed.code, 1, failed.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].claim, original, 'failed launch does not renew');
  assert.deepEqual(events(h), audit);
  const paused = path.join(h.base, 'supervisor-paused');
  try {
    const spawned = h.json(['spawn', '--task', 'T1'], {
      hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSE_PROCESS: 'spawn-monitor.js', HOOK_PAUSED: paused },
    });
    await until(() => fs.existsSync(paused), 'supervisor did not pause before renewal');
    const rivals = await Promise.all([
      h.runAsync(['claim', 'T2', '--agent', 'rival']),
      h.runAsync(['spawn', '--task', 'T3']),
    ]);
    for (const r of rivals) {
      assert.equal(r.code, 1, JSON.stringify(rivals));
      assert.match(r.stderr, /T1.*worker-T1-1/);
    }
    const restored = h.readState('tasks.json').tasks[0].claim;
    assert.ok(Date.parse(restored.until) > Date.now(), 'dispatch restores the lease under the lock');
    assert.equal(restored.since, original.since);
    assert.equal(restored.from, original.from);
    assert.equal(restored.agent, spawned.agent);
    h.ok(['renew', 'T1', '--agent', spawned.agent]);
    h.ok(['project', 'set', '--workers', '2']);
    h.ok(['claim', 'T2', '--agent', 'rival']);
    h.ok(['release', 'T1', '--agent', spawned.agent, '--reason', 'slot returned']);
    h.ok(['claim', 'T3', '--agent', 'replacement']);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    fs.writeFileSync(path.join(h.base, 'T1.exit'), '');
  }
});
