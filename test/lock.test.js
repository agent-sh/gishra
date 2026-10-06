'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function waitForFile(file, ms = 20000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`${file} never appeared`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A write that is killed while it holds the lock, leaving the lock to a dead pid.
function killHolder(h) {
  const r = h.run(['task', 'add', '--title', 'never written', '--acceptance', 'x'], { hooks: { HOOK_DIE_ON: 'project.json' } });
  assert.notEqual(r.code, 0, 'the holder was killed');
  assert.ok(fs.existsSync(path.join(h.state, 'lock')), 'the dead holder left its lock');
}

test('a held lock makes a write wait 10 s, then exit 3 without writing', async (t) => {
  const h = makeRepo(t);
  h.init();
  const pausedFile = path.join(h.base, 'paused');
  const go = `${pausedFile}.go`;
  const holder = h.runAsync(['task', 'add', '--title', 'holder', '--acceptance', 'a'], {
    hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: pausedFile },
  });
  await waitForFile(pausedFile);
  const holderPid = fs.readFileSync(pausedFile, 'utf8');
  try {
    const started = Date.now();
    const r = h.run(['task', 'add', '--title', 'waiter', '--acceptance', 'a']);
    const waited = Date.now() - started;
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, new RegExp(`locked by pid ${holderPid} `));
    assert.ok(waited >= 9500, `waited ${waited} ms`);
    assert.equal(h.readState('tasks.json').tasks.length, 0);
    assert.deepEqual(h.json(['task', 'list']), [], 'reads do not need the lock');
  } finally {
    fs.writeFileSync(go, '');
  }
  const done = await holder;
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks.map((x) => x.title), ['holder'], 'the holder kept its lock and wrote');
  assert.ok(!fs.existsSync(path.join(h.state, 'lock')), 'the lock is released after the write');
});

test('a stale lock is broken: its holder is gone, or it is older than 60 s', (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = path.join(h.state, 'lock');
  killHolder(h);
  let started = Date.now();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  assert.ok(Date.now() - started < 5000, 'a dead holder is not waited for');
  assert.ok(!fs.existsSync(lock));

  // A holder on another host cannot be checked, so only age makes it stale.
  fs.mkdirSync(lock);
  const marker = path.join(lock, '00112233aabbccdd');
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, host: 'some-other-host', at: new Date().toISOString(), nonce: '00112233aabbccdd' }));
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(marker, old, old);
  started = Date.now();
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b']);
  assert.ok(Date.now() - started < 5000, 'an old lock is not waited for');
  assert.deepEqual(h.readState('tasks.json').tasks.map((x) => x.title), ['A', 'B']);
  assert.ok(!fs.existsSync(lock), 'the lock is released after the write');
  assert.deepEqual(fs.readdirSync(h.state).filter((f) => f.startsWith('lock')), [], 'no prepared lock is left behind');
});

test('a writer that saw a dead lock before another broke it cannot share the lock with the new holder', async (t) => {
  const h = makeRepo(t);
  h.init();
  killHolder(h);
  const signal = (name) => path.join(h.base, name);
  const go = (name) => fs.writeFileSync(`${signal(name)}.go`, '');
  // X reads who holds the dead lock, and stops before acting on it.
  const x = h.runAsync(['task', 'add', '--title', 'X', '--acceptance', 'a'], {
    hooks: { HOOK_STOP_LOCK_READ: signal('x-read'), HOOK_STOP_LOCK_CHANGE: signal('x-change') },
  });
  await waitForFile(signal('x-read'));
  // Y breaks the dead lock, takes it, and stops inside its write after reading tasks.json.
  const y = h.runAsync(['task', 'add', '--title', 'Y', '--acceptance', 'a'], { hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: signal('y-holds') } });
  await waitForFile(signal('y-holds'));
  // X acts on the dead holder it saw, and stops again right after.
  go('x-read');
  await waitForFile(signal('x-change'));
  // Z arrives while X is in the middle of breaking; Y still holds the lock.
  const z = h.runAsync(['task', 'add', '--title', 'Z', '--acceptance', 'a']);
  const zWhileYHeld = await Promise.race([z, new Promise((r) => setTimeout(() => r(null), 1500))]);
  go('x-change');
  go('y-holds');
  const results = await Promise.all([x, y, z]);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const ids = results.map((r) => r.stdout.trim());
  assert.equal(new Set(ids).size, 3, `X, Y and Z each got their own id: ${ids.join(' ')}`);
  assert.deepEqual(h.readState('tasks.json').tasks.map((task) => task.title).sort(), ['X', 'Y', 'Z'], 'no write was lost');
  assert.equal(zWhileYHeld, null, `Z wrote ${zWhileYHeld && zWhileYHeld.stdout.trim()} while Y held the lock`);
  assert.ok(!fs.existsSync(path.join(h.state, 'lock')), 'the lock is released');
});

test('many writers breaking one dead lock at once all write, once each', async (t) => {
  const h = makeRepo(t);
  h.init();
  const writers = 6;
  const added = [];
  for (let round = 1; round <= 2; round++) {
    killHolder(h);
    // Each writer first finds the dead lock taken and waits for the others,
    // so all of them break it together; jitter shuffles their steps.
    const barrier = path.join(h.base, `barrier-${round}`);
    fs.mkdirSync(barrier);
    const titles = Array.from({ length: writers }, (_, i) => `round ${round} writer ${i + 1}`);
    const hooks = { HOOK_BARRIER: barrier, HOOK_BARRIER_N: String(writers), HOOK_JITTER_MS: '6' };
    const results = await Promise.all(titles.map((title) => h.runAsync(['task', 'add', '--title', title, '--acceptance', 'a'], { hooks })));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const ids = results.map((r) => r.stdout.trim());
    assert.equal(new Set(ids).size, writers, `round ${round}: every write got its own id: ${ids.join(' ')}`);
    added.push(...titles);
    assert.deepEqual(h.readState('tasks.json').tasks.map((task) => task.title).sort(), [...added].sort(), `round ${round}: no write was lost`);
    assert.equal(events(h).filter((e) => e.cmd === 'task add').length, added.length);
    assert.ok(!fs.existsSync(path.join(h.state, 'lock')), `round ${round}: the lock is released`);
  }
  assert.deepEqual(fs.readdirSync(h.state).filter((f) => f.startsWith('lock')), [], 'no prepared lock is left behind');
});

test('a stale lock that cannot be removed still times out with exit 3', (t) => {
  const h = makeRepo(t);
  h.init();
  killHolder(h);
  // Windows can reuse the killed holder's PID during the 10 s removal wait.
  const lock = path.join(h.state, 'lock');
  const marker = JSON.parse(fs.readFileSync(path.join(lock, fs.readdirSync(lock)[0]), 'utf8'));
  const attempts = path.join(h.base, 'attempts');
  fs.writeFileSync(attempts, '');
  const started = Date.now();
  const r = h.run(['task', 'add', '--title', 'A', '--acceptance', 'a'], {
    hooks: { HOOK_FAIL_LOCK: attempts, HOOK_DEAD_PID: String(marker.pid) }, timeout: 25000,
  });
  const waited = Date.now() - started;
  assert.equal(r.code, 3, `exit ${r.code} (signal ${r.signal}) after ${waited} ms: ${r.stderr}`);
  assert.ok(waited >= 9500 && waited < 20000, `waited ${waited} ms`);
  assert.match(r.stderr, /locked by pid \d+ .*which is gone, but its lock could not be removed \(EPERM\); remove .*lock by hand/);
  const tries = fs.readFileSync(attempts, 'utf8').length;
  assert.ok(tries >= 5 && tries <= 400, `${tries} removal attempts in 10 s: it backs off between them`);
  assert.equal(h.readState('tasks.json').tasks.length, 0);
});
