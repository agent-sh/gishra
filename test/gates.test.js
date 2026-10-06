'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, real } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { shellQuote } = require('../lib/gates/common');

// Gate internals live in lib/gates/ and ship separately, so these tests run a
// copy of the CLI whose lib/gates/ holds only what each test puts there.
function cliCopy(h) {
  const dir = path.join(h.base, 'cli');
  const gatesDir = path.join(ROOT, 'lib', 'gates');
  fs.cpSync(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), {
    recursive: true,
    filter: (src) => src !== gatesDir && !src.startsWith(gatesDir + path.sep),
  });
  const bin = path.join(dir, 'bin', 'tower-crane.js');
  return {
    gates: path.join(dir, 'lib', 'gates'),
    run: (args, env = {}) => {
      const r = cp.spawnSync(process.execPath, [bin, ...args], { cwd: h.repo, env: { ...h.env, ...env }, encoding: 'utf8' });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

const FAKE_GATE = `'use strict';
const fs = require('node:fs');
module.exports = {
  async run(ctx) {
    fs.writeFileSync(process.env.GATE_OUT, JSON.stringify({ root: ctx.root, worktree: ctx.worktree, task: ctx.task.id, sha: ctx.task.sha, args: ctx.args, base: ctx.project.base }));
    ctx.log('fake gate ran');
    return { ok: process.env.GATE_OK === '1', summary: 'fake gate', ref: 'run-1', sha: process.env.GATE_SHA || undefined };
  },
};
`;

function submittedTask(h) {
  h.init();
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', 'w-1']);
}

const BUILD_MANIFEST_FIXTURES = [
  ['npm', {
    base: {
      'package.json': '{"name":"fixture-base","version":"0.1.0","private":true}\n',
      'package-lock.json': '{"name":"fixture-base","version":"0.1.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture-base","version":"0.1.0"}}}\n',
    },
    submitted: {
      'package.json': '{"name":"fixture-task-head","version":"1.0.0","private":true}\n',
      'package-lock.json': '{"name":"fixture-task-head","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture-task-head","version":"1.0.0"}}}\n',
    },
  }],
  ['Rust', { submitted: {
    'Cargo.toml': '[package]\nname = "fixture-task-head"\nversion = "0.1.0"\nedition = "2021"\n',
    'Cargo.lock': 'version = 3\n\n[[package]]\nname = "fixture-task-head"\nversion = "0.1.0"\n',
  } }],
  ['Go', { submitted: {
    'go.mod': 'module example.com/fixture-task-head\n\ngo 1.20\n',
    'go.sum': 'example.com/fixture-task-head v0.1.0/go.mod h1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n',
  } }],
  ['Python', { submitted: {
    'pyproject.toml': '[project]\nname = "fixture-task-head"\nversion = "0.1.0"\n',
    'requirements-dev.txt': '# fixture-task-head requirements\n',
  } }],
  ['Make', { submitted: {
    Makefile: '# fixture-task-head\n.PHONY: test\ntest:\n\t@true\n',
  } }],
];

const VERIFY_BUILD = `const fs = require('node:fs');
const path = require('node:path');
for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(path.join(__dirname, file))) {
    console.error('missing build file: ' + file);
    process.exit(2);
  }
  if (!fs.readFileSync(path.join(__dirname, file), 'utf8').includes('fixture-task-head')) {
    console.error('stale build file: ' + file);
    process.exit(2);
  }
}
try {
  require('./test/value.test.js');
  console.log('ok value.test.js');
} catch (error) {
  console.error('not ok value.test.js: ' + error.message);
  process.exitCode = 1;
}
`;

function writeFiles(root, files) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

function manifestTask(h, { base = {}, submitted }) {
  writeFiles(h.repo, {
    'value.js': 'module.exports = 0;\n',
    'verify-build.js': VERIFY_BUILD,
    'test/value.test.js': "require('node:assert/strict').equal(require('../value'), 0);\n",
    ...base,
  });
  h.git(['add', 'value.js', 'verify-build.js', 'test/value.test.js']);
  h.git(['commit', '-qm', 'fixture base']);
  h.git(['switch', '-qc', 'fixture-change']);
  writeFiles(h.repo, {
    'value.js': 'module.exports = 1;\n',
    'test/value.test.js': "require('node:assert/strict').equal(require('../value'), 1);\n",
    ...submitted,
  });
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'fixture change and build files']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  return sha;
}

function installTestsGate(cli) {
  fs.mkdirSync(cli.gates, { recursive: true });
  for (const name of ['common.js', 'tests.js']) {
    fs.copyFileSync(path.join(ROOT, 'lib', 'gates', name), path.join(cli.gates, name));
  }
}

for (const [ecosystem, manifests] of BUILD_MANIFEST_FIXTURES) {
  test(`check tests keeps ${ecosystem} build files and fails on the reverted code`, (t) => {
    const h = makeRepo(t);
    const sha = manifestTask(h, manifests);
    h.init(['--repo', 'acme/demo', '--base', 'main']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'test the behavior']);
    h.ok(['claim', 'T1', '--agent', 'w-1']);
    h.ok(['submit', 'T1', '--sha', sha, '--branch', 'fixture-change', '--agent', 'w-1']);

    h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
    const cli = cliCopy(h);
    installTestsGate(cli);
    const required = Object.keys(manifests.submitted).map(shellQuote).join(' ');
    const cmd = `${shellQuote(process.execPath)} verify-build.js ${required}`;
    const result = cli.run(['check', 'tests', 'T1', '--cmd', cmd, '--agent', 'checker']);
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.code, 0, output);
    assert.match(output, /tests pass with the change and fail without it/);
    assert.match(output, /with \d+ non-test files? reverted .*value\.js.*build files kept at submitted sha .*: exit 1/i);
    assert.doesNotMatch(output, /missing build file:|stale build file:/);
    assert.match(output, /build files kept at submitted sha/i);
    for (const file of Object.keys(manifests.submitted)) assert.ok(output.includes(file), `summary omitted kept build file ${file}`);
  });
}

test('gate commands exit 1 when the gate module is not installed', (t) => {
  const h = makeRepo(t);
  submittedTask(h);
  const cli = cliCopy(h);
  for (const args of [['check', 'tests', 'T1', '--cmd', 'npm test'], ['check', 'clean', 'T1'], ['check', 'ci', 'T1'], ['merge', 'T1']]) {
    const r = cli.run(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /gate not installed/);
  }
  assert.equal(cli.run(['check', 'tests', 'T1']).code, 2, '--cmd is required');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 0);
});

test('a gate gets its context and its result is recorded as evidence', (t) => {
  const h = makeRepo(t);
  submittedTask(h);
  const wt = h.json(['worktree', 'T1']).path;
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates);
  for (const g of ['tests', 'ci', 'merge']) fs.writeFileSync(path.join(cli.gates, `${g}.js`), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');

  const pass = cli.run(['check', 'tests', 'T1', '--cmd', 'npm test', '--agent', 'checker', '--json'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stderr, /\[tests\] fake gate ran/);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(real(seen.root), real(h.repo));
  assert.equal(real(seen.worktree), real(wt));
  assert.deepEqual([seen.task, seen.sha, seen.args.cmd, seen.base], ['T1', 'abcdef1', 'npm test', 'main']);
  const recorded = JSON.parse(pass.stdout);
  assert.deepEqual([recorded.type, recorded.ok, recorded.agent, recorded.sha, recorded.ref, recorded.revision], ['tests', true, 'checker', 'abcdef1', 'run-1', 1]);

  const fail = cli.run(['check', 'ci', 'T1', '--agent', 'checker'], { GATE_OUT: out, GATE_OK: '0', GATE_SHA: 'ABCDEF1234567' });
  assert.equal(fail.code, 1);
  assert.match(fail.stdout, /ci FAIL at abcdef1: fake gate/);
  const ev = h.readState('tasks.json').tasks[0].evidence;
  assert.deepEqual(ev.map((e) => [e.type, e.ok, e.sha]), [['tests', true, 'abcdef1'], ['ci', false, 'abcdef1234567']]);

  const merge = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(merge.code, 1);
  assert.match(merge.stderr, /T1 is submitted; merge needs an accepted task/);
});

test('merge refuses a task of any kind whose PR has no passing ci at the submitted sha', (t) => {
  const h = makeRepo(t);
  const sha = gateFixture(h);
  h.init();
  h.ok(['project', 'set', '--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--pr', '9', '--agent', 'w-1']);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  gateEvidence(h, 'ci', 'ci');
  h.ok(['accept', 'T1']);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates);
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');

  // A later failed run must stop a merge even after acceptance.
  gateEvidence(h, 'ci', 'ci', false);
  const refused = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /its gates no longer pass: ci: latest ci at .* failed:/);
  assert.ok(!fs.existsSync(out), 'the merge gate did not run');
});

test('merge checks the gates as they stand, not only the accepted status', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
  for (const type of ['tests', 'clean']) gateEvidence(h, type, 'checker');
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  h.ok(['accept', 'T1']);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates);
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');

  // A later failed run must stop a merge even after acceptance.
  gateEvidence(h, 'tests', 'checker', false);
  const refused = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /T1 is accepted, but its gates no longer pass: tests: latest tests at .* failed:/);
  assert.ok(!fs.existsSync(out), 'the merge gate did not run');
  assert.ok(!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'));

  gateEvidence(h, 'tests', 'checker');
  const merged = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(fs.existsSync(out), 'with the gates passing again, the merge gate runs');
});
