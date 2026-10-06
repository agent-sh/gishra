'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, real } = require('./helpers');

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
  const bin = path.join(dir, 'bin', 'gishra.js');
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
  h.init();
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--pr', '9', '--agent', 'w-1']);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--agent', 'r-1']);
  h.ok(['evidence', 'T1', '--type', 'ci', '--ok', '--agent', 'ci']);
  h.ok(['accept', 'T1']);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates);
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');

  // CI re-run on the same commit after the accept, and it failed.
  h.ok(['evidence', 'T1', '--type', 'ci', '--fail', '--summary', 'e2e (failure)', '--agent', 'ci']);
  const refused = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /its gates no longer pass: ci: latest ci at abcdef1 failed: e2e \(failure\)/);
  assert.ok(!fs.existsSync(out), 'the merge gate did not run');
});

test('merge checks the gates as they stand, not only the accepted status', (t) => {
  const h = makeRepo(t);
  submittedTask(h);
  for (const [type, agent] of [['tests', 'w-1'], ['clean', 'w-1'], ['review', 'r-1']]) h.ok(['evidence', 'T1', '--type', type, '--ok', '--agent', agent]);
  h.ok(['accept', 'T1']);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates);
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');

  // A test run recorded after the accept fails at the same commit.
  h.ok(['evidence', 'T1', '--type', 'tests', '--fail', '--summary', 'fails on main after a rebase', '--agent', 'checker']);
  const refused = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /T1 is accepted, but its gates no longer pass: tests: latest tests at abcdef1 failed: fails on main after a rebase; send it back with gishra rework T1/);
  assert.ok(!fs.existsSync(out), 'the merge gate did not run');
  assert.ok(!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'));

  h.ok(['evidence', 'T1', '--type', 'tests', '--ok', '--agent', 'checker']);
  const merged = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(fs.existsSync(out), 'with the gates passing again, the merge gate runs');
});
