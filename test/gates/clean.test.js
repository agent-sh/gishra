'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gate = require('../../lib/gates/clean');
const { scratch, isolateGit, git, commit, initRepo, worktrees, quote } = require('./helpers');

const tmp = scratch('gates-clean');
isolateGit(tmp);
process.env.GISHRA_TMP = path.join(tmp, 'gishra-tmp');
fs.mkdirSync(process.env.GISHRA_TMP);
const root = path.join(tmp, 'repo');
const base = initRepo(root, { 'lib/a.js': 'module.exports = 1;\n' });
git(root, 'checkout', '-q', '-b', 'task');
const sha = commit(root, { 'lib/a.js': 'module.exports = 2;\n' });
git(root, 'checkout', '-q', 'main');

// Stands in for deslop: records how it was called and prints the report it is given.
const fake = path.join(tmp, 'fake-clean.js');
fs.writeFileSync(fake, `const fs = require('fs');
const { spawnSync } = require('child_process');
const [dir, ...rest] = process.argv.slice(2);
const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(process.env.FAKE_CLEAN_LOG, JSON.stringify({ dir, rest, head, via: process.env.FAKE_CLEAN_VIA || 'env' }));
if (process.env.FAKE_CLEAN_MODE === 'crash') { console.error('cannot read the repository'); process.exit(1); }
if (process.env.FAKE_CLEAN_MODE === 'text') { console.log('deslop: 2 findings'); process.exit(0); }
process.stdout.write(fs.readFileSync(process.env.FAKE_CLEAN_REPORT, 'utf8'));
`);
const logFile = path.join(tmp, 'fake-clean.log');
const reportFile = path.join(tmp, 'report.json');
const fakeCmd = `${quote(process.execPath)} ${quote(fake)}`;

// Read one by one: process.env matches names case-insensitively on Windows (Path), a copy does not.
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
function restore(...keys) {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
test.beforeEach(() => {
  for (const k of ['GISHRA_CLEAN_CMD', 'FAKE_CLEAN_MODE', 'FAKE_CLEAN_VIA']) delete process.env[k];
  restore('PATH', 'HOME', 'USERPROFILE');
  process.env.FAKE_CLEAN_LOG = logFile;
  process.env.FAKE_CLEAN_REPORT = reportFile;
  fs.rmSync(logFile, { force: true });
});
test.after(() => {
  restore('PATH', 'HOME', 'USERPROFILE');
  fs.rmSync(tmp, { recursive: true, force: true });
});

function report(items, extra = {}) {
  fs.writeFileSync(reportFile, JSON.stringify({ scope: 'diff', total: items.length, shown: items.length, items, errors: [], ...extra }));
}

function ctx() {
  return { root, worktree: null, task: { id: 'T2', kind: 'code', sha, status: 'submitted' }, project: { repo: 'acme/app', base: 'main' }, args: {}, log() {} };
}

function called() {
  return JSON.parse(fs.readFileSync(logFile, 'utf8'));
}

function item(severity, check, file, line, message) {
  return { severity, check, file, line, message };
}

function assertCleanedUp() {
  assert.deepEqual(fs.readdirSync(process.env.GISHRA_TMP), []);
  assert.equal(worktrees(root), 1);
}

test('a HIGH finding: not ok, listing the first 10 HIGH items and counts by check', async () => {
  process.env.GISHRA_CLEAN_CMD = fakeCmd;
  const high = Array.from({ length: 12 }, (_, i) => item('high', i ? 'secret' : 'merge-residue', 'lib/a.js', i + 1, `finding ${i + 1}`));
  report([...high, item('review', 'no-caller', 'lib/b.js', 7, 'nothing calls b')]);
  const r = await gate.run(ctx());
  assert.equal(r.ok, false);
  assert.equal(r.sha, sha);
  assert.match(r.summary, /high 12, review 1/);
  assert.match(r.summary, /By check: merge-residue 1, secret 11, no-caller 1/);
  assert.match(r.summary, /- lib\/a\.js:1 finding 1\n/);
  assert.match(r.summary, /- lib\/a\.js:10 finding 10\n- and 2 more/);
  assert.doesNotMatch(r.summary, /finding 11/);
  // The tool ran on a checkout of the submitted commit, against the merge base, asking for JSON.
  const c = called();
  assert.equal(c.head, sha);
  assert.deepEqual(c.rest, [`--base=${base}`, '--json']);
  assert.ok(c.dir.startsWith(process.env.GISHRA_TMP));
  assertCleanedUp();
});

test('only review and verify findings: ok', async () => {
  process.env.GISHRA_CLEAN_CMD = fakeCmd;
  report([item('review', 'no-caller', 'lib/b.js', 7, 'nothing calls b'), item('verify', 'stale-mention', 'README.md', 3, 'mentions a')]);
  const r = await gate.run(ctx());
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /review 1, verify 1/);
  assertCleanedUp();
});

test('a scan with checks that did not run: not ok, naming them', async () => {
  process.env.GISHRA_CLEAN_CMD = fakeCmd;
  const cases = [
    [{ errors: ['secrets: could not read tracked files'] }, /secrets: could not read tracked files/],
    [{ detectorErrors: [{ check: 'refs', error: 'git grep failed' }] }, /git grep failed/],
    [{ failedChecks: ['unwired'] }, /unwired/],
  ];
  for (const [extra, named] of cases) {
    report([], extra);
    const r = await gate.run(ctx());
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.match(r.summary, /The scan is incomplete/);
    assert.match(r.summary, named);
  }
  report([item('review', 'no-caller', 'lib/b.js', 7, 'nothing calls b')], { errors: [], detectorErrors: [], failedChecks: [] });
  assert.equal((await gate.run(ctx())).ok, true);
  assertCleanedUp();
});

test('no cleanup tool installed: not ok', async () => {
  process.env.PATH = path.join(tmp, 'empty-bin');
  process.env.HOME = path.join(tmp, 'empty-home');
  const r = await gate.run(ctx());
  assert.equal(r.ok, false);
  assert.match(r.summary, /cleanup tool not installed/);
});

test('deslop on PATH is used when GISHRA_CLEAN_CMD is unset, and GISHRA_CLEAN_CMD wins over it', { skip: process.platform === 'win32' }, async () => {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'deslop'), `#!/bin/sh\nFAKE_CLEAN_VIA=path exec ${fakeCmd} "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  report([]);
  const r = await gate.run(ctx());
  assert.equal(r.ok, true, r.summary);
  assert.equal(called().via, 'path');
  process.env.GISHRA_CLEAN_CMD = fakeCmd;
  assert.equal((await gate.run(ctx())).ok, true);
  assert.equal(called().via, 'env');
  assertCleanedUp();
});

test('the deslop plugin script under ~/.agentsys is the last resort', async (t) => {
  const home = path.join(tmp, 'home');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (gate.findTool()) return t.skip('deslop is on PATH on this machine');
  const script = path.join(home, '.agentsys', 'plugins', 'deslop', 'scripts', 'detect.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(fake, script);
  report([item('high', 'secret', 'lib/a.js', 1, 'looks like a committed token')]);
  const r = await gate.run(ctx());
  assert.equal(r.ok, false);
  assert.match(r.summary, /lib\/a\.js:1 looks like a committed token/);
  assert.equal(called().head, sha);
});

test('a tool that fails or prints no JSON: not ok', async () => {
  process.env.GISHRA_CLEAN_CMD = fakeCmd;
  process.env.FAKE_CLEAN_MODE = 'crash';
  const crashed = await gate.run(ctx());
  assert.equal(crashed.ok, false);
  assert.match(crashed.summary, /exit 1: cannot read the repository/);
  process.env.FAKE_CLEAN_MODE = 'text';
  const text = await gate.run(ctx());
  assert.equal(text.ok, false);
  assert.match(text.summary, /did not print JSON/);
  assertCleanedUp();
});
