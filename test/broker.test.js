'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TMP_ROOT, detachedAlive } = require('./helpers');
const B = require('../lib/broker');
const { resolveCommand, parseOptions, GLOBAL } = require('../bin/tower-crane');

function scratch(t) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-broker-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const state = path.join(base, 'state');
  const home = path.join(base, 'home');
  fs.mkdirSync(state);
  fs.mkdirSync(home);
  return { base, state, job: { state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: base, broker: path.join(home, B.FILE) } };
}

function parse(argv) {
  const r = resolveCommand(argv);
  return parseOptions([...r.lead, ...r.rest], { ...(r.cmd.flags || {}), ...GLOBAL }, r.cmd.name);
}

test('option names from a request cannot reach Object.prototype', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
    assert.throws(() => parseOptions([`--${name}`, 'x'], {}, 'task note'), /unknown option/, name);
    assert.throws(() => parseOptions([`--${name}=x`], { ...GLOBAL }), /unknown option/, name);
  }
  const { flags } = parseOptions(['--agent', 'a'], { ...GLOBAL });
  assert.equal(Object.getPrototypeOf(flags), Object.prototype);
  assert.deepEqual(flags, { agent: 'a' });
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  assert.throws(() => B.authorize(job, ['task', 'note', 'T1', '--__proto__', 'x']), /unknown option --__proto__/);
});

test('the broker names the agent and state before the agent\'s own "--"', () => {
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  const note = parse(B.authorize(job, ['task', 'note', 'T1', '--', '--flag', 'text']));
  assert.deepEqual(note.pos, ['T1', '--flag', 'text'], 'the note keeps the agent\'s text, and only it');
  assert.equal(note.flags.agent, 'worker-T1-1');
  assert.equal(note.flags.state, '/s');
  const claim = parse(B.authorize(job, ['claim', 'T1', '--']));
  assert.deepEqual(claim.pos, ['T1']);
  assert.deepEqual([claim.flags.agent, claim.flags.state], ['worker-T1-1', '/s']);
  const named = parse(B.authorize(job, ['task', 'note', '--agent', 'worker-T1-1', 'T1', '--', '--agent', 'owner']));
  assert.deepEqual(named.pos, ['T1', '--agent', 'owner'], 'text after "--" is the note, not an identity');
  assert.equal(named.flags.agent, 'worker-T1-1');
});

test('closing the broker stops the commands it is running and what they started', async (t) => {
  const { base, state, job } = scratch(t);
  const pids = path.join(base, 'pids.json');
  // Preloaded into the CLI the broker runs: it starts a process in a group of
  // its own, as a check's test run does, records both and never returns.
  const preload = path.join(base, 'hang.js');
  fs.writeFileSync(preload, `
const cp = require('node:child_process');
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.BROKER_TEST_PIDS;
const run = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { env, detached: process.platform !== 'win32', stdio: 'ignore' });
require('node:fs').writeFileSync(process.env.BROKER_TEST_PIDS, JSON.stringify([process.pid, run.pid]));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, BROKER_TEST_PIDS: process.env.BROKER_TEST_PIDS };
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  process.env.BROKER_TEST_PIDS = pids;
  let started = [];
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    // Only a test that failed leaves them running.
    for (const pid of started.filter((p) => detachedAlive({ pid: p }))) process.kill(pid, 'SIGKILL');
  });

  const broker = await B.start(job);
  const answer = B.forward(job.broker, ['task', 'note', 'T1', 'slow'], state).then((r) => ({ r }), (e) => ({ e }));
  const until = async (ok, what) => {
    const deadline = Date.now() + 15000;
    while (!ok()) {
      assert.ok(Date.now() < deadline, what);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await until(() => fs.existsSync(pids) && fs.readFileSync(pids, 'utf8').length > 0, 'the brokered command started');
  started = JSON.parse(fs.readFileSync(pids, 'utf8'));
  broker.close();
  await until(() => started.every((pid) => !detachedAlive({ pid })), 'the command and its own process group stop with the broker');
  const { r, e } = await answer;
  assert.ok(e || r.code !== 0, 'the agent gets no success for a command the broker stopped');
  assert.ok(!fs.existsSync(job.broker), 'broker.json is gone');
});
