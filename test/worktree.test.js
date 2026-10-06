'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

function setup(t, base = 'main') {
  const h = makeRepo(t);
  if (base !== 'main') h.git(['branch', base]);
  h.init(['--base', base]);
  h.ok(['task', 'add', '--title', 'Fresh base', '--acceptance', 'starts from the freshest base']);
  const origin = path.join(h.base, 'origin.git');
  h.git(['init', '--bare', '-q', origin]);
  h.git(['remote', 'add', 'origin', origin]);
  h.git(['push', '-qu', 'origin', base]);
  const upstream = path.join(h.base, 'upstream');
  h.git(['clone', '-q', '--branch', base, origin, upstream]);
  return { ...h, origin, upstream, baseBranch: base };
}

function advance(h, cwd, file) {
  fs.writeFileSync(path.join(cwd, file), 'new base commit\n');
  h.git(['add', file], cwd);
  h.git(['commit', '-qm', file], cwd);
  return h.git(['rev-parse', 'HEAD'], cwd);
}

for (const base of ['main', 'release/next']) {
  test(`worktree fetches ${base} and starts from origin when the local base is stale`, (t) => {
    const h = setup(t, base);
    const stale = h.git(['rev-parse', base]);
    const fresh = advance(h, h.upstream, 'remote.txt');
    h.git(['push', '-q', 'origin', base], h.upstream);
    assert.equal(h.git(['rev-parse', `origin/${base}`]), stale);

    const wt = h.json(['worktree', 'T1']);
    assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
    assert.equal(h.git(['rev-parse', `origin/${base}`]), fresh);
    assert.equal(h.git(['rev-parse', base]), stale);
    assert.equal(fs.readFileSync(path.join(wt.path, 'remote.txt'), 'utf8'), 'new base commit\n');
    assert.equal(h.json(['task', 'show', 'T1']).branch, wt.branch);

    // An existing worktree must remain usable even while origin is unavailable.
    fs.renameSync(h.origin, `${h.origin}.offline`);
    const again = h.json(['worktree', 'T1']);
    assert.equal(again.created, false);
    assert.equal(again.path, wt.path);
    assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
  });
}

test('worktree keeps a local base that is ahead of origin', (t) => {
  const h = setup(t);
  const local = advance(h, h.repo, 'local.txt');
  const remote = h.git(['rev-parse', 'origin/main']);
  const r = h.run(['worktree', 'T1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`using local base main at ${local}; origin/main is at ${remote}`));
  const wt = JSON.parse(r.stdout);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), local);
});

test('worktree keeps a divergent local base while refreshing origin', (t) => {
  const h = setup(t);
  const local = advance(h, h.repo, 'local.txt');
  const remote = advance(h, h.upstream, 'remote.txt');
  h.git(['push', '-q', 'origin', 'main'], h.upstream);
  const r = h.run(['worktree', 'T1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`using local base main at ${local}; origin/main is at ${remote}`));
  const wt = JSON.parse(r.stdout);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), local);
  assert.equal(h.git(['rev-parse', 'origin/main']), remote);
});

test('worktree uses the fetched base when no local base branch exists', (t) => {
  const h = setup(t);
  const fresh = advance(h, h.upstream, 'remote.txt');
  h.git(['push', '-q', 'origin', 'main'], h.upstream);
  h.git(['checkout', '-q', '--detach']);
  h.git(['branch', '-D', 'main']);
  h.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  const wt = h.json(['worktree', 'T1']);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
});

test('worktree refreshes origin even when its configured fetch excludes the base', (t) => {
  const h = setup(t);
  h.git(['config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other']);
  const fresh = advance(h, h.upstream, 'remote.txt');
  h.git(['push', '-q', 'origin', 'main'], h.upstream);
  const wt = h.json(['worktree', 'T1']);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
  assert.equal(h.git(['rev-parse', 'origin/main']), fresh);
});

test('worktree refuses a failed origin fetch without recording or creating a task branch', (t) => {
  const h = setup(t);
  fs.renameSync(h.origin, `${h.origin}.offline`);
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const r = h.run(['worktree', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git fetch origin main failed/);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
  assert.equal(h.git(['branch', '--list', 'gishra/*']), '');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
});

test('worktree uses a local base missing from origin instead of its stale tracking ref', (t) => {
  const h = setup(t);
  h.git(['symbolic-ref', 'HEAD', 'refs/heads/other'], h.origin);
  h.git(['push', '-q', 'origin', '--delete', 'main']);
  const local = advance(h, h.repo, 'local.txt');
  h.git(['update-ref', 'refs/remotes/origin/main', h.git(['rev-parse', 'HEAD~1'])]);

  const r = h.run(['worktree', 'T1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`origin has no base branch main; using local base at ${local}`));
  const wt = JSON.parse(r.stdout);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), local);
  assert.equal(h.json(['task', 'show', 'T1']).branch, wt.branch);
});

test('worktree refuses a base missing both locally and on origin without writing state', (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--base', 'missing']);
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const r = h.run(['worktree', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /base branch missing is not in this repository/);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
  assert.equal(h.git(['branch', '--list', 'gishra/*']), '');
});

test('worktree refuses a locked tracking ref that does not match the origin tip', (t) => {
  const h = setup(t);
  const stale = h.git(['rev-parse', 'origin/main']);
  advance(h, h.upstream, 'remote.txt');
  h.git(['push', '-q', 'origin', 'main'], h.upstream);
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  fs.writeFileSync(path.join(h.repo, '.git', 'refs', 'remotes', 'origin', 'main.lock'), '');

  const r = h.run(['worktree', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git fetch origin main failed/);
  assert.equal(h.git(['rev-parse', 'origin/main']), stale);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
  assert.equal(h.git(['branch', '--list', 'gishra/*']), '');
});

for (const recovered of [true, false]) {
  test(`an unpack failure ${recovered ? 'uses a tip fetched by another caller' : 'refuses a stale tracking ref'}`, (t) => {
    const h = setup(t);
    const stale = h.git(['rev-parse', 'origin/main']);
    const fresh = advance(h, h.upstream, 'remote.txt');
    h.git(['push', '-q', 'origin', 'main'], h.upstream);
    const marker = path.join(h.base, 'upload-pack-failed');
    const uploadPack = path.join(h.base, 'upload-pack.js');
    // A peer may finish importing the new tip before this caller's object write fails.
    fs.writeFileSync(uploadPack, `
const fs = require('node:fs');
const cp = require('node:child_process');
const marker = ${JSON.stringify(marker)};
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '');
  if (${recovered}) cp.execFileSync('git', ['-c', 'remote.origin.uploadpack=git-upload-pack',
    'fetch', '--no-tags', '--no-write-fetch-head', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
    { cwd: ${JSON.stringify(h.repo)}, stdio: 'pipe' });
  process.stderr.write('fatal: unpack-objects failed\\n');
  process.exit(1);
}
const r = cp.spawnSync('git-upload-pack', process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
    const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    h.git(['config', 'remote.origin.uploadpack', `${quote(process.execPath)} ${quote(uploadPack)}`]);
    const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const result = h.run(['worktree', 'T1', '--json']);
    if (recovered) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(h.git(['rev-parse', 'HEAD'], JSON.parse(result.stdout).path), fresh);
      assert.equal(h.git(['rev-parse', 'origin/main']), fresh);
    } else {
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /git fetch origin main failed/);
      assert.equal(h.git(['rev-parse', 'origin/main']), stale);
      assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
      assert.equal(h.json(['task', 'show', 'T1']).branch, null);
      assert.equal(h.git(['branch', '--list', 'gishra/*']), '');
    }
  });
}

for (const command of ['worktree', 'spawn']) {
  test(`six parallel ${command} calls start from the freshly fetched base`, { timeout: 60000 }, async (t) => {
    const h = setup(t);
    const fresh = advance(h, h.upstream, 'remote.txt');
    h.git(['push', '-q', 'origin', 'main'], h.upstream);
    const ids = ['T1'];
    for (let i = 2; i <= 6; i++) {
      ids.push(h.ok(['task', 'add', '--title', `Parallel ${i}`, '--acceptance', 'uses fresh base']));
    }
    if (command === 'spawn') {
      h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command',
        JSON.stringify([process.execPath, '-e', 'process.exit(0)']), '--clear', 'profile', '--clear', 'effort']);
      for (const id of ids) h.ok(['brief', 'set', id, '-'], { input: 'Use the fresh base.\n' });
    }
    // Align real upload-pack processes so fetches read the same old tracking ref.
    const barrier = path.join(h.base, 'fetch-barrier');
    fs.mkdirSync(barrier);
    const uploadPack = path.join(h.base, 'upload-pack.js');
    fs.writeFileSync(uploadPack, `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const barrier = ${JSON.stringify(barrier)};
fs.writeFileSync(path.join(barrier, String(process.pid)), '');
const deadline = Date.now() + 20000;
while (fs.readdirSync(barrier).length < 6) {
  if (Date.now() >= deadline) process.exit(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const r = cp.spawnSync('git-upload-pack', process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
    const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    h.git(['config', 'remote.origin.uploadpack', `${quote(process.execPath)} ${quote(uploadPack)}`]);
    const results = await Promise.all(ids.map((id) => h.runAsync(command === 'worktree'
      ? ['worktree', id, '--json']
      : ['spawn', '--role', 'medium', '--task', id, '--wait', '--json'])));
    assert.deepEqual(results.map((r) => r.code), Array(6).fill(0), results.map((r) => r.stderr).join('\n'));
    for (let i = 0; i < results.length; i++) {
      const wt = JSON.parse(results[i].stdout);
      const dir = command === 'worktree' ? wt.path : wt.cwd;
      assert.equal(h.git(['rev-parse', 'HEAD'], dir), fresh);
      assert.ok(h.json(['task', 'show', ids[i]]).branch);
    }
    assert.equal(h.git(['rev-parse', 'origin/main']), fresh);
  });
}
