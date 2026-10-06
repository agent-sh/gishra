'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');

const holder = (pid, host = os.hostname()) => JSON.stringify({ pid, host, at: new Date().toISOString(), nonce: 'held-by-test' });

test('a held lock makes a write wait 10 s, then exit 3 without writing', (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = path.join(h.state, 'lock');
  const held = holder(process.pid);
  fs.writeFileSync(lock, held);
  const started = Date.now();
  const r = h.run(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  const waited = Date.now() - started;
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, new RegExp(`locked by pid ${process.pid}`));
  assert.ok(waited >= 9500, `waited ${waited} ms`);
  assert.equal(h.readState('tasks.json').tasks.length, 0);
  assert.deepEqual(h.json(['task', 'list']), [], 'reads do not need the lock');
  assert.equal(fs.readFileSync(lock, 'utf8'), held, 'the holder keeps its lock');
});

test('a stale lock is broken: its holder is gone, or it is older than 60 s', (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = path.join(h.state, 'lock');
  const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(lock, holder(dead));
  let started = Date.now();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  assert.ok(Date.now() - started < 5000, 'a dead holder is not waited for');
  assert.ok(!fs.existsSync(lock));

  fs.writeFileSync(lock, holder(process.pid, 'some-other-host'));
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  started = Date.now();
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b']);
  assert.ok(Date.now() - started < 5000, 'an old lock is not waited for');
  assert.equal(h.readState('tasks.json').tasks.length, 2);
  assert.ok(!fs.existsSync(lock), 'the lock is released after the write');
});
