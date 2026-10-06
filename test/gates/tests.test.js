'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gate = require('../../lib/gates/tests');
const { scratch, isolateGit, git, commit, initRepo, worktrees, quote } = require('./helpers');

const NODE = quote(process.execPath);
const CMD = `${NODE} run-tests.js`;

// A tiny project whose runner requires every test/*.test.js and exits 1 if any throws.
const BASE = {
  'run-tests.js': `const fs = require('fs');
const path = require('path');
let failed = 0;
for (const f of fs.readdirSync(path.join(__dirname, 'test')).sort()) {
  if (!f.endsWith('.test.js')) continue;
  try { require(path.join(__dirname, 'test', f)); console.log('ok ' + f); }
  catch (e) { failed++; console.log('not ok ' + f + ': ' + e.message); }
}
process.exit(failed ? 1 : 0);
`,
  'lib/add.js': 'module.exports = (a, b) => a - b;\n',
  'lib/mul.js': 'module.exports = (a, b) => a * b;\n',
  'test/mul.test.js': "require('assert').strictEqual(require('../lib/mul')(2, 3), 6);\n",
};
const FIX = 'module.exports = (a, b) => a + b;\n';
const ADD_TEST = "require('assert').strictEqual(require('../lib/add')(1, 2), 3);\n";
const MUL_TEST = "require('assert').strictEqual(require('../lib/mul')(3, 3), 9);\n";

const tmp = scratch('gates-tests');
isolateGit(tmp);
process.env.GISHRA_TMP = path.join(tmp, 'gishra-tmp');
fs.mkdirSync(process.env.GISHRA_TMP);
const root = path.join(tmp, 'repo');
initRepo(root, BASE);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let branches = 0;
function task(files, from = 'main') {
  git(root, 'checkout', '-q', '-b', `task-${++branches}`, from);
  const sha = commit(root, files);
  git(root, 'checkout', '-q', 'main');
  return sha;
}

function ctx(sha, { kind = 'code', args = {}, project = {} } = {}) {
  return {
    root,
    worktree: null,
    task: { id: 'T1', kind, sha, status: 'submitted' },
    project: { repo: 'acme/app', base: 'main', ...project },
    args: { cmd: CMD, ...args },
    log() {},
  };
}

function assertCleanedUp() {
  assert.deepEqual(fs.readdirSync(process.env.GISHRA_TMP), []);
  assert.equal(worktrees(root), 1);
}

test('a test that fails without the change and passes with it: ok', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.sha, sha);
  assert.match(r.summary, /run-tests\.js` at [0-9a-f]+: exit 0/);
  assert.match(r.summary, /1 non-test file reverted .*lib\/add\.js.*: exit 1/);
  assertCleanedUp();
});

test('a test that passes without the change: not ok', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/mul2.test.js': MUL_TEST });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, false);
  assert.match(r.summary, /tests pass without the change; they do not prove it/);
  assertCleanedUp();
});

test('a file the task added is removed for the run without the change', async () => {
  const sha = task({
    'lib/sub.js': 'module.exports = (a, b) => a - b;\n',
    'test/sub.test.js': "require('assert').strictEqual(require('../lib/sub')(3, 1), 2);\n",
  });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, true, r.summary);
  assertCleanedUp();
});

test('a code task that changes no test: not ok', async () => {
  const sha = task({ 'lib/add.js': FIX });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, false);
  assert.match(r.summary, /no test covers this change/);
  assertCleanedUp();
});

test('deleting a test is not a test for the change', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/mul.test.js': null });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, false);
  assert.match(r.summary, /no test covers this change/);
});

test('a docs task that changes no test: ok once the command passes', async () => {
  const sha = task({ 'README.md': '# app\n' });
  const r = await gate.run(ctx(sha, { kind: 'docs' }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /exit 0/);
  const broken = task({ 'README.md': '# app\n', 'lib/mul.js': 'module.exports = () => 0;\n' });
  assert.equal((await gate.run(ctx(broken, { kind: 'docs' }))).ok, false);
  assertCleanedUp();
});

test('a command that fails at the submitted commit: not ok, with the output tail', async () => {
  const sha = task({ 'lib/add.js': 'module.exports = (a, b) => a * b;\n', 'test/add.test.js': ADD_TEST });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, false);
  assert.match(r.summary, /run-tests\.js` at [0-9a-f]+: exit 1/);
  assert.match(r.summary, /not ok add\.test\.js/);
  assertCleanedUp();
});

test('a task that changes only tests: ok with a note', async () => {
  const sha = task({ 'test/mul2.test.js': MUL_TEST });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /only test files/);
  assertCleanedUp();
});

test('commits the task inherited from origin/<base> are not its change', async () => {
  // origin/main moved ahead of the local main; the task branched from origin/main and adds a test.
  const ahead = task({ 'lib/extra.js': 'module.exports = 1;\n' });
  git(root, 'update-ref', 'refs/remotes/origin/main', ahead);
  try {
    const sha = task({ 'test/mul2.test.js': MUL_TEST }, ahead);
    const r = await gate.run(ctx(sha));
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /only test files/);
  } finally {
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
  }
});

test('a timeout stops the command and everything it started', { skip: process.platform === 'win32' }, async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const marker = path.join(tmp, 'late-write');
  // `; true` keeps the shell alive, so the writer is a grandchild, not the shell itself.
  const cmd = `${NODE} -e "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 3000)" ${quote(marker)}; true`;
  const started = Date.now();
  const r = await gate.run(ctx(sha, { args: { cmd, timeout: 0.01 } }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /timed out/);
  assert.ok(Date.now() - started < 3000, 'the gate waited for the command instead of stopping it');
  await new Promise((resolve) => setTimeout(resolve, 4000 - (Date.now() - started)));
  assert.equal(fs.existsSync(marker), false, 'a process the command started outlived the timeout');
  assertCleanedUp();
});

test('a worktree add that fails after registering leaves no registration behind', async () => {
  // git registers the worktree, checks it out, then runs post-checkout; a failing hook makes
  // the add exit non-zero with the registration already written.
  const hooked = path.join(tmp, 'hooked');
  initRepo(hooked, BASE);
  git(hooked, 'checkout', '-q', '-b', 'task');
  const sha = commit(hooked, { 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  git(hooked, 'checkout', '-q', 'main');
  const hooks = path.join(tmp, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  git(hooked, 'config', 'core.hooksPath', hooks);
  const r = await gate.run({ ...ctx(sha), root: hooked });
  assert.equal(r.ok, false);
  assert.match(r.summary, /could not create a worktree/);
  assert.equal(worktrees(hooked), 1);
  assert.deepEqual(fs.readdirSync(process.env.GISHRA_TMP), []);
});

test('a commit that is not in the repository: not ok', async () => {
  const r = await gate.run(ctx('0123456789abcdef0123456789abcdef01234567'));
  assert.equal(r.ok, false);
  assert.match(r.summary, /is not in/);
});

test('a capitalized Tests/ directory holds tests: the gate runs them', async () => {
  const sha = task({ 'lib/add.js': FIX, 'Tests/AddTests.js': ADD_TEST });
  const r = await gate.run(ctx(sha, { args: { cmd: `${NODE} Tests/AddTests.js` } }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Tests: Tests\/AddTests\.js/);
  assertCleanedUp();
});

// One layout per language convention the default patterns must know.
for (const [layout, p] of [
  ['SwiftPM', 'Tests/AppTests/FooTests.swift'],
  ['.NET', 'MyApp.Tests/FooTests.cs'],
  ['Java outside src/test', 'src/FooTest.java'],
  ['Kotlin in Test/', 'Test/FooTest.kt'],
  ['JavaScript in Tests/', 'Tests/ValueTests.js'],
  ['Maven integration tests', 'src/it/OrderIT.java'],
  ['Android instrumented tests', 'app/src/androidTest/java/MainTest.java'],
  ['Flutter integration_test', 'integration_test/app_test.dart'],
  ['RSpec', 'lib/foo_spec.rb'],
]) {
  test(`${layout} test files are tests: ${p}`, () => {
    assert.equal(gate.isTestFile(p), true);
  });
}

test('test file patterns', () => {
  for (const p of ['test/a.js', 'src/tests/b.py', 'a/__tests__/c.ts', 'spec/d.rb', 'pkg/e_test.go', 'f.test.js', 'g.spec.ts', 'py/test_h.py', 'test_i.py', 'TestFoo.java', 'MyApp.UnitTests/A.cs']) {
    assert.equal(gate.isTestFile(p), true, p);
  }
  // A code file taken for a test would never be reverted, so near misses stay code.
  for (const p of ['lib/a.js', 'contest/b.js', 'latest/c.js', 'testdata/d.json', 'respec/h.js', 'src/latest.js', 'contest.py', 'attest.go', 'docs/testing.md', 'src/Testimony.js', 'AUDIT.md']) {
    assert.equal(gate.isTestFile(p), false, p);
  }
});

test('project.json tests.paths replaces the default layouts', async () => {
  const project = { tests: { paths: ['checks/**/*.chk.js'] } };
  const chk = task({ 'lib/add.js': FIX, 'checks/add.chk.js': ADD_TEST });
  const r = await gate.run(ctx(chk, { project, args: { cmd: `${NODE} checks/add.chk.js` } }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Tests: checks\/add\.chk\.js/);
  // With the override set, a default-layout test no longer counts.
  const dflt = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const d = await gate.run(ctx(dflt, { project }));
  assert.equal(d.ok, false);
  assert.match(d.summary, /no test covers this change: .*by project\.json tests\.paths/);
  assertCleanedUp();
});

test('globs in tests.paths', () => {
  const { match } = gate.testMatcher({ tests: { paths: ['src/test/**', '**/*Test.java', '{unit,e2e}/case?.js', 'qa/'] } });
  for (const p of ['src/test/a/B.java', 'FooTest.java', 'm/n/FooTest.java', 'unit/case1.js', 'e2e/case2.js', 'qa/x/y.txt']) assert.equal(match(p), true, p);
  for (const p of ['src/main/A.java', 'test/a.test.js', 'FooTest.kt', 'int/case1.js', 'unit/case10.js', 'qaz/x']) assert.equal(match(p), false, p);
});

test('a malformed tests.paths: not ok, naming the field', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  for (const tests of [{ paths: [] }, { paths: 'test/**' }, { paths: [''] }, ['test/**'], 'test/**']) {
    const r = await gate.run(ctx(sha, { project: { tests } }));
    assert.equal(r.ok, false, JSON.stringify(tests));
    assert.match(r.summary, /tests\.paths must be a non-empty array of globs/);
  }
});
