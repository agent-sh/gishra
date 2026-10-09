'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const { shellQuote } = require('../lib/gates/common');

function orphan(h, name = 'orphan') {
  const dir = path.join(h.repo, '.git', 'worktrees', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['commondir', 'config.worktree']) {
    fs.writeFileSync(path.join(dir, file), '', { mode: 0o444 });
  }
  return dir;
}

function gateTask(h, script) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  h.init(['--tests-cmd', command, '--tests-mode', 'run-only']);
  h.ok(['task', 'add', '--title', 'Gate', '--acceptance', 'temporary checkout stays consistent']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
}

test('preparation prunes empty sandbox admin placeholders without removing a locked initialization', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Prepared', '--acceptance', 'valid registration']);
  const broken = orphan(h);
  const locked = orphan(h, 'initializing');
  fs.writeFileSync(path.join(locked, 'locked'), 'initializing');
  const wt = h.json(['worktree', 'T1']);
  assert.equal(fs.existsSync(broken), false);
  assert.ok(fs.existsSync(path.join(locked, 'locked')));
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), h.git(['rev-parse', 'main']));
  assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 2);
});

for (const code of [0, 1]) {
  test(`gate cleanup prunes sandbox admin placeholders after a command exits ${code}`, (t) => {
    const h = makeRepo(t);
    const script = path.join(h.base, 'gate.js');
    const broken = path.join(h.repo, '.git', 'worktrees', 'orphan');
    fs.writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(broken)};
fs.mkdirSync(dir, { recursive: true });
for (const file of ['commondir', 'config.worktree']) fs.writeFileSync(path.join(dir, file), '', { mode: 0o444 });
process.exit(${code});
`);
    gateTask(h, script);
    assert.equal(h.run(['check', 'tests', 'T1']).code, code);
    assert.equal(fs.existsSync(broken), false);
    assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
    assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  });
}

async function waitFor(file) {
  const deadline = performance.now() + 15000;
  while (!fs.existsSync(file)) {
    assert.ok(performance.now() < deadline, `waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('two preparations overlap a gate removal without pruning their initializing registrations', { timeout: 30000 }, async (t) => {
  const h = makeRepo(t);
  const script = path.join(h.base, 'gate.js');
  const ready = path.join(h.base, 'gate-ready');
  const release = path.join(h.base, 'gate-release');
  const addRelease = path.join(h.base, 'add-release');
  const hook = path.join(h.base, 'hook.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, '');
const deadline = performance.now() + 20000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (performance.now() > deadline) process.exit(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`);
  gateTask(h, script);
  h.ok(['task', 'add', '--title', 'First', '--acceptance', 'valid registration']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'valid registration']);
  fs.writeFileSync(hook, `
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.cwd());
if (name === 'wt') process.exit(0);
fs.writeFileSync(path.join(${JSON.stringify(h.base)}, name + '-ready'), '');
const deadline = performance.now() + 20000;
while (!fs.existsSync(${JSON.stringify(addRelease)})) {
  if (performance.now() > deadline) process.exit(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`);
  fs.writeFileSync(path.join(h.repo, '.git', 'hooks', 'post-checkout'),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hook)}\n`, { mode: 0o755 });
  const gate = h.runAsync(['check', 'tests', 'T1']);
  const additions = [];
  try {
    await waitFor(ready);
    additions.push(h.runAsync(['worktree', 'T2', '--json']), h.runAsync(['worktree', 'T3', '--json']));
    await Promise.all(['T2-first-ready', 'T3-second-ready'].map((name) => waitFor(path.join(h.base, name))));
    const broken = orphan(h);
    fs.writeFileSync(release, '');
    const removed = await gate;
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(fs.existsSync(broken), false);
    fs.writeFileSync(addRelease, '');
    for (const result of await Promise.all(additions)) {
      assert.equal(result.code, 0, result.stderr);
      const wt = JSON.parse(result.stdout);
      assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), h.git(['rev-parse', 'main']));
    }
    const listing = h.git(['worktree', 'list', '--porcelain']);
    assert.equal(listing.match(/^worktree /gm).length, 3);
    assert.doesNotMatch(listing, /locked|prunable/);
    for (const name of fs.readdirSync(path.join(h.repo, '.git', 'worktrees'))) {
      const admin = path.join(h.repo, '.git', 'worktrees', name);
      assert.ok(fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim());
      assert.ok(fs.readFileSync(path.join(admin, 'HEAD'), 'utf8').trim());
      assert.equal(fs.readFileSync(path.join(admin, 'commondir'), 'utf8').trim(), '../..');
    }
  } finally {
    fs.writeFileSync(release, '');
    fs.writeFileSync(addRelease, '');
    await Promise.all([gate, ...additions]);
  }
});

// Removal needs /proc to show that no process holds the lock; without it the placeholder is kept.
test('a sandboxed git push clears an empty read-only lock placeholder that would block its upstream config', { skip: !fs.existsSync('/proc/self/fd') && 'needs /proc to see which process holds the lock' }, (t) => {
  const h = makeRepo(t);
  h.init();
  h.git(['checkout', '-q', '-b', 'task-T1']);
  const remote = path.join(h.base, 'origin.git');
  h.git(['init', '-q', '--bare', remote]);
  // What a sandbox mask leaves behind in the main checkout's git directory.
  const lock = path.join(h.repo, '.git', 'config.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const policy = path.join(h.base, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'branch', branch: 'task-T1', repo: null, gh: [] }));
  const shimDir = path.join(h.base, 'shim');
  fs.mkdirSync(shimDir);
  const push = cp.spawnSync(process.execPath, [path.join(ROOT, 'lib', 'shim.js'), policy, shimDir, 'git', 'push', '-u', remote, 'HEAD:refs/heads/task-T1'],
    { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(push.status, 0, push.stderr);
  // Git reports a blocked upstream write without a failing status.
  assert.doesNotMatch(push.stderr, /could not lock config/);
  assert.match(push.stderr, /removed empty read-only placeholder .*config\.lock/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(h.git(['config', '--get', 'branch.task-T1.remote']), remote);
});
