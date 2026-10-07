'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TMP_ROOT, detachedAlive, makeRepo } = require('./helpers');
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

test('the broker rejects an identity that differs from its spawn', () => {
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  for (const agent of ['owner', 'worker-T2-1']) {
    assert.throws(() => B.authorize(job, ['task', 'note', 'T1', 'text', '--agent', agent]), new RegExp(`cannot act as ${agent}`));
  }
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

test('a brokered command runs no git, whose repository config and commits the agent writes', async (t) => {
  const h = makeRepo(t);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
  h.init(['--ci-local', JSON.stringify({ command: [process.execPath, '-e', ''], timeout: 5 })]);
  h.git(['switch', '-qc', 'change']);
  fs.writeFileSync(path.join(h.repo, 'change.txt'), 'change\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'change']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.ok(['task', 'add', '--title', 'gated', '--kind', 'docs', '--acceptance', 'checked']);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', sha, '--branch', 'change', '--pr', '1']);
  // With ok local CI evidence on a submitted task, the sketch's gate report
  // reads the repository with git (merge-tree, whose merge drivers the
  // repository's config names).
  assert.equal(h.json(['check', 'ci', 'T1', '--agent', 'checker']).ok, true);

  const log = path.join(h.base, 'git.log');
  const preload = path.join(h.base, 'git-log.js');
  fs.writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
for (const name of ['spawnSync', 'execFileSync', 'spawn', 'execFile']) {
  const original = cp[name];
  cp[name] = function (command, args, ...rest) {
    if (process.env.TOWER_CRANE_VIA === 'broker' && /(^|[\\\\/])git(\\.exe)?$/.test(command)) fs.appendFileSync(process.env.BROKER_GIT_LOG, JSON.stringify(args) + '\\n');
    return original.call(this, command, args, ...rest);
  };
}
`);
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, BROKER_GIT_LOG: process.env.BROKER_GIT_LOG };
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  process.env.BROKER_GIT_LOG = log;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const r = await B.forward(job.broker, ['task', 'note', 'T1', 'brokered'], h.state);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes.map((n) => [n.agent, n.text]), [['worker-T1-1', 'brokered']]);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', 'the broker ran git');
});

test('a worker cannot have the broker run its tests, its cleanup or git', () => {
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  for (const argv of [['check', 'tests', 'T1', '--cmd', 'cat ~/.ssh/id_ed25519'], ['check', 'tests', 'T1'], ['check', 'clean', 'T1'], ['check', 'ci', 'T1'], ['worktree', 'T1']]) {
    assert.throws(() => B.authorize(job, argv), /changes state only with/, argv.join(' '));
  }
  for (const role of Object.keys(B.ROLES)) for (const cmd of B.ROLES[role]) assert.ok(!/^(check|worktree|merge|spawn)\b/.test(cmd), `${role}: ${cmd}`);
});

test('a broker for claude and codex routes listens on both, and an agent that cannot use the socket uses TCP', { skip: process.platform === 'win32' && 'Windows uses a named pipe for both' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'routes', '--acceptance', 'noted']);
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', harness: 'claude', broker_harnesses: ['claude', 'codex'], cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const address = JSON.parse(fs.readFileSync(job.broker, 'utf8'));
  assert.deepEqual([typeof address.socket, address.host, Number.isInteger(address.port)], ['string', '127.0.0.1', true]);
  // As in codex's sandbox, where connecting to the socket fails.
  fs.writeFileSync(job.broker, JSON.stringify({ ...address, socket: path.join(h.base, 'refused.sock') }));
  const r = await B.forward(job.broker, ['task', 'note', 'T1', 'over tcp'], h.state);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes.map((n) => n.text), ['over tcp']);
});

test('a brokered resubmit asks gh about its PR by name, with no repository for git', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'pr', '--acceptance', 'checked']);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', 'abcdef1', '--branch', 'change', '--pr', '7']);
  const log = path.join(h.base, 'gh.log');
  const preload = path.join(h.base, 'gh.js');
  fs.writeFileSync(preload, `
const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = function (command, args, opts) {
  if (command !== 'gh' || process.env.TOWER_CRANE_VIA !== 'broker') return original.call(this, command, args, opts);
  require('node:fs').appendFileSync(process.env.BROKER_GH_LOG, JSON.stringify({ args, cwd: opts.cwd, git_dir: opts.env.GIT_DIR || null }) + '\\n');
  return { status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefName: 'change' }), stderr: '' };
};
`);
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, BROKER_GH_LOG: process.env.BROKER_GH_LOG };
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  process.env.BROKER_GH_LOG = log;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const refused = await B.forward(job.broker, ['submit', 'T1', '--sha', 'abcdef2', '--pr', '7'], h.state);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /needs the project's repo/);
  assert.ok(!fs.existsSync(log), 'gh did not run without a repository name');
  h.ok(['project', 'set', '--repo', 'acme/demo', '--agent', 'owner']);
  const r = await B.forward(job.broker, ['submit', 'T1', '--sha', 'abcdef2', '--pr', '7'], h.state);
  assert.equal(r.code, 0, r.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 5), ['pr', 'view', '7', '-R', 'acme/demo']);
  assert.equal(calls[0].cwd, h.state);
  assert.ok(calls[0].git_dir && !fs.existsSync(calls[0].git_dir), 'git finds no repository');
  assert.equal(h.readState('tasks.json').tasks[0].sha, 'abcdef2');
});
