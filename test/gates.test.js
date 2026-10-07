'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, real } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { shellQuote } = require('../lib/gates/common');

// The gate variants run in process in test/gates/tests.test.js; these tests
// cover what the CLI adds: audited evidence, policy at accept and merge, and
// gate loading. Gate internals live in lib/gates/ and ship separately, so
// some tests run a copy of the CLI whose lib/gates/ holds only what each test
// puts there.
function cliCopy(h) {
  const dir = path.join(h.base, 'cli');
  const gatesDir = path.join(ROOT, 'lib', 'gates');
  fs.cpSync(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), {
    recursive: true,
    filter: (src) => src !== gatesDir && !src.startsWith(gatesDir + path.sep),
  });
  fs.mkdirSync(path.join(dir, 'lib', 'gates'));
  fs.copyFileSync(path.join(gatesDir, 'common.js'), path.join(dir, 'lib', 'gates', 'common.js'));
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

function manifestTask(h, { base = {}, submitted, codeChange = true }) {
  writeFiles(h.repo, {
    'value.js': 'module.exports = 0;\n',
    'verify-build.js': VERIFY_BUILD,
    'test/value.test.js': "require('node:assert/strict').equal(require('../value'), 0);\n",
    ...base,
  });
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'fixture base']);
  h.git(['switch', '-qc', 'fixture-change']);
  writeFiles(h.repo, {
    ...(codeChange ? { 'value.js': 'module.exports = 1;\n' } : {}),
    'test/value.test.js': `require('node:assert/strict').equal(require('../value'), ${codeChange ? 1 : 0}, 'fixture regression');\n`,
    ...submitted,
  });
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'fixture change and build files']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  return sha;
}

function submitTestsFixture(h, sha, keep) {
  h.init(['--repo', 'acme/demo', '--base', 'main', '--tests-cmd', `${shellQuote(process.execPath)} verify-build.js`]);
  if (keep) h.ok(['project', 'set', '--tests-keep', JSON.stringify(keep)]);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'test the behavior']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--branch', 'fixture-change', '--agent', 'w-1']);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
}

test('tests evidence stores its mode in the audit event and stops counting when the policy changes', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {} });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-mode', 'none']);
  const skipped = h.json(['check', 'tests', 'T1']);
  assert.equal(skipped.tests_mode, 'none');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).detail.tests_mode, 'none');
  const testsGate = () => h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests');
  assert.equal(testsGate().ok, true);
  h.ok(['project', 'set', '--tests-by-kind', '{"code":"prove"}']);
  assert.equal(testsGate().ok, false);
  assert.match(testsGate().reason, /mode.*none.*prove/);
  const refused = h.run(['accept', 'T1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /tests:.*mode none.*prove/);
  const proof = h.json(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js`]);
  assert.equal(proof.tests_mode, 'prove');
  assert.equal(testsGate().ok, true);
  h.ok(['project', 'set', '--tests-by-kind', '{"code":"run-only"}']);
  assert.equal(testsGate().ok, false);
  const run = h.json(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js`]);
  assert.equal(run.tests_mode, 'run-only');
  assert.equal(testsGate().ok, true);
  const tasks = h.readState('tasks.json');
  tasks.tasks[0].evidence.at(-1).tests_mode = 'none';
  h.writeState('tasks.json', tasks);
  assert.equal(testsGate().ok, false, 'a mode edited without its matching audit event is untrusted');
  delete tasks.tasks[0].evidence.at(-1).tests_mode;
  h.writeState('tasks.json', tasks);
  const audit = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  delete audit.findLast((e) => e.cmd === 'check tests').detail.tests_mode;
  fs.writeFileSync(path.join(h.state, 'events.jsonl'), audit.map(JSON.stringify).join('\n') + '\n');
  assert.equal(testsGate().ok, false);
  assert.match(testsGate().reason, /mode unrecorded/);
});

test('acceptance and merge refuse a mode change after an audited tests pass', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
  h.ok(['project', 'set', '--tests-mode', 'none']);
  h.ok(['check', 'tests', 'T1', '--agent', 'checker']);
  gateEvidence(h, 'clean', 'checker');
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  h.ok(['project', 'set', '--tests-mode', 'prove']);
  const accept = h.run(['accept', 'T1']);
  assert.equal(accept.code, 1);
  assert.match(accept.stderr, /tests:.*mode none.*prove/);
  h.ok(['project', 'set', '--tests-mode', 'none']);
  h.ok(['accept', 'T1']);
  h.ok(['project', 'set', '--tests-mode', 'prove']);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');
  const merge = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(merge.code, 1);
  assert.match(merge.stderr, /its gates no longer pass: tests:.*mode none.*prove/);
  assert.ok(!fs.existsSync(out), 'the merge gate did not run');
});

test('gate commands exit 1 when the gate module is not installed', (t) => {
  const h = makeRepo(t);
  submittedTask(h);
  const cli = cliCopy(h);
  for (const args of [['check', 'tests', 'T1', '--cmd', 'npm test'], ['check', 'clean', 'T1'], ['check', 'ci', 'T1'], ['merge', 'T1']]) {
    const r = cli.run(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /gate not installed/);
  }
  assert.equal(cli.run(['check', 'tests', 'T1']).code, 1, 'missing modules fail before policy checks');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 0);
});

test('a gate gets its context and its result is recorded as evidence', (t) => {
  const h = makeRepo(t);
  submittedTask(h);
  const wt = h.json(['worktree', 'T1']).path;
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
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
  fs.mkdirSync(cli.gates, { recursive: true });
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
  fs.mkdirSync(cli.gates, { recursive: true });
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
