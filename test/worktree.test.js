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
  const wt = h.json(['worktree', 'T1']);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), local);
});

test('worktree keeps a divergent local base while refreshing origin', (t) => {
  const h = setup(t);
  const local = advance(h, h.repo, 'local.txt');
  const remote = advance(h, h.upstream, 'remote.txt');
  h.git(['push', '-q', 'origin', 'main'], h.upstream);
  const wt = h.json(['worktree', 'T1']);
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
