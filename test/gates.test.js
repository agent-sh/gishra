'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, real } = require('./helpers');
const { gateFixture, gateEvidence, changeKind } = require('./gate-helpers');
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
  ['cargo', { submitted: {
    'Cargo.toml': '[package]\nname = "fixture-task-head"\nversion = "0.1.0"\nedition = "2021"\n',
    'Cargo.lock': 'version = 3\n\n[[package]]\nname = "fixture-task-head"\nversion = "0.1.0"\n',
  } }],
  ['go', { submitted: {
    'go.mod': 'module example.com/fixture-task-head\n\ngo 1.20\n',
    'go.sum': 'example.com/fixture-task-head v0.1.0/go.mod h1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n',
  } }],
  ['python', { submitted: {
    'pyproject.toml': '[project]\nname = "fixture-task-head"\nversion = "0.1.0"\n',
    'requirements-dev.txt': '# fixture-task-head requirements\n',
    'uv.lock': '# fixture-task-head\nversion = 1\n',
  } }],
  ['Make with tests.keep', { keep: ['Makefile', 'tools/**/*.gradle'], submitted: {
    Makefile: '# fixture-task-head\n.PHONY: test\ntest:\n\t@true\n',
    'tools/build.gradle': '// fixture-task-head\n',
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

function installTestsGate(cli) {
  fs.mkdirSync(cli.gates, { recursive: true });
  for (const name of ['common.js', 'tests.js']) {
    fs.copyFileSync(path.join(ROOT, 'lib', 'gates', name), path.join(cli.gates, name));
  }
}

function submitTestsFixture(h, sha, keep) {
  h.init(['--repo', 'acme/demo', '--base', 'main', '--tests-cmd', `${shellQuote(process.execPath)} verify-build.js`]);
  if (keep) h.ok(['project', 'set', '--tests-keep', JSON.stringify(keep)]);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'test the behavior']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--branch', 'fixture-change', '--agent', 'w-1']);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
}

for (const [ecosystem, manifests] of BUILD_MANIFEST_FIXTURES) {
  test(`check tests keeps ${ecosystem} build files and fails on the reverted code`, (t) => {
    const h = makeRepo(t);
    const sha = manifestTask(h, manifests);
    submitTestsFixture(h, sha, manifests.keep);
    const cli = cliCopy(h);
    installTestsGate(cli);
    const required = Object.keys(manifests.submitted).map(shellQuote).join(' ');
    const cmd = `${shellQuote(process.execPath)} verify-build.js ${required}`;
    h.ok(['project', 'set', '--tests-cmd', cmd]);
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

for (const [ecosystem, manifests] of BUILD_MANIFEST_FIXTURES) {
  test(`check tests accepts only tests and ${ecosystem} build files without a revert run`, (t) => {
    const h = makeRepo(t);
    const sha = manifestTask(h, { ...manifests, codeChange: false });
    submitTestsFixture(h, sha, manifests.keep);
    const required = Object.keys(manifests.submitted).map(shellQuote).join(' ');
    const cmd = `${shellQuote(process.execPath)} verify-build.js ${required}`;
    h.ok(['project', 'set', '--tests-cmd', cmd]);
    const output = h.ok(['check', 'tests', 'T1', '--cmd', cmd, '--agent', 'checker']);
    assert.match(output, /Tests: test\/value\.test\.js/);
    assert.match(output, /only tests and kept build files/);
    assert.match(output, /no non-test files to revert/);
    assert.doesNotMatch(output, /2\. .*: exit/);
    for (const file of Object.keys(manifests.submitted)) {
      assert.ok(output.includes(file), `summary omitted kept build file ${file}`);
    }
    assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
    assert.equal(h.git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  });
}

for (const file of ['Makefile', 'setup.py', 'build.bzl', 'build.gradle', 'vite.config.js', 'flake.nix', 'app.csproj', 'value.lock']) {
  test(`check tests reverts code-like file ${file} by default`, (t) => {
    const h = makeRepo(t);
    const sha = manifestTask(h, {
      base: { [file]: 'base build code\n' },
      submitted: {
        [file]: 'fixture-task-head build code\n',
        'test/value.test.js': `require('node:assert/strict').match(require('node:fs').readFileSync(${JSON.stringify(file)}, 'utf8'), /fixture-task-head/);\n`,
      },
      codeChange: false,
    });
    submitTestsFixture(h, sha);
    const cmd = `${shellQuote(process.execPath)} verify-build.js`;
    h.ok(['project', 'set', '--tests-cmd', cmd]);
    const output = h.ok(['check', 'tests', 'T1', '--cmd', cmd, '--agent', 'checker']);
    assert.match(output, /1 non-test file reverted .*: exit 1/);
    assert.ok(output.includes(file), output);
    assert.doesNotMatch(output, /Build files kept/);
  });
}

test('check tests keeps manifest-like test paths as tests, not build files', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {
    'package.json': '{"name":"fixture-task-head","private":true}\n',
    'test/package.json': '{"name":"fixture-task-head","private":true}\n',
  } });
  submitTestsFixture(h, sha, ['test/**']);
  const cmd = `${shellQuote(process.execPath)} verify-build.js package.json test/package.json`;
  h.ok(['project', 'set', '--tests-cmd', cmd]);
  const output = h.ok(['check', 'tests', 'T1', '--cmd', cmd, '--agent', 'checker']);
  assert.match(output, /Tests: test\/package\.json, test\/value\.test\.js/);
  assert.match(output, /Build files kept at submitted sha [a-f0-9]+: package\.json/);
  const kept = [...output.matchAll(/Build files kept at submitted sha [a-f0-9]+: ([^\n]+)/g)];
  assert.ok(kept.length, output);
  for (const [, files] of kept) assert.ok(!files.includes('test/package.json'), files);
});

test('check tests accepts a Cargo.lock bump and tests without reverting', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, {
    base: { 'Cargo.lock': '# old dependencies\nversion = 3\n' },
    submitted: { 'Cargo.lock': '# fixture-task-head dependencies\nversion = 3\n' },
    codeChange: false,
  });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} verify-build.js Cargo.lock`]);
  const output = h.ok(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js Cargo.lock`, '--agent', 'checker']);
  assert.match(output, /Build files kept at submitted sha [a-f0-9]+: Cargo\.lock/);
  assert.match(output, /only tests and kept build files/);
  assert.doesNotMatch(output, /2\. .*: exit/);
});

test('check tests still rejects a failing head when only tests and build files changed', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { codeChange: false, submitted: {
    'Cargo.lock': '# fixture-task-head\n',
    'test/value.test.js': "require('node:assert/strict').equal(require('../value'), 1);\n",
  } });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} verify-build.js Cargo.lock`]);
  const r = h.run(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js Cargo.lock`, '--agent', 'checker']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /at [a-f0-9]+: exit 1/);
});

for (const [name, settings, runs] of [
  ['default prove', [], 2],
  ['project run-only', ['--tests-mode', 'run-only'], 1],
  ['kind run-only overrides project none', ['--tests-mode', 'none', '--tests-by-kind', '{"code":"run-only"}'], 1],
  ['kind prove overrides project run-only', ['--tests-mode', 'run-only', '--tests-by-kind', '{"code":"prove"}'], 2],
  ['expensive prove', ['--tests-expensive', 'true'], 1],
  ['non-expensive prove', ['--tests-expensive', 'false'], 2],
  ['expensive kind prove', ['--tests-mode', 'none', '--tests-by-kind', '{"code":"prove"}', '--tests-expensive', 'true'], 1],
  ['project none', ['--tests-mode', 'none'], 0],
  ['kind none overrides project prove', ['--tests-by-kind', '{"code":"none"}', '--tests-expensive', 'true'], 0],
]) {
  test(`check tests runs the suite ${runs} times for ${name}`, (t) => {
    const h = makeRepo(t);
    const sha = manifestTask(h, { base: {
      'count-runs.js': "require('node:fs').appendFileSync(process.argv[2], 'run\\n');\nprocess.argv.length = 2;\nrequire('./verify-build.js');\n",
    }, submitted: {} });
    submitTestsFixture(h, sha);
    if (settings.length) h.ok(['project', 'set', ...settings]);
    const marker = path.join(h.base, 'suite-runs');
    const cmd = `${shellQuote(process.execPath)} count-runs.js ${shellQuote(marker)}`;
    const scoped = `${shellQuote(process.execPath)} {tests}`;
    const expensive = settings.includes('true') && runs === 1;
    h.ok(['project', 'set', '--tests-cmd', cmd, '--tests-proof-cmd', scoped]);
    const evidence = h.json(['check', 'tests', 'T1', '--cmd', cmd, ...(expensive ? ['--proof-cmd', scoped] : []), '--agent', 'checker']);
    assert.equal(evidence.ok, true, evidence.summary);
    assert.equal(evidence.sha, sha);
    assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0, runs);
    assert.equal(evidence.commands.filter((c) => c.command === cmd).length, runs);
    assert.ok(evidence.commands.length > 0, 'even none mode verifies the submitted commit');
    const shown = h.json(['task', 'show', 'T1']);
    assert.equal(shown.gates.gates.find((g) => g.type === 'tests').ok, true, 'audited tests evidence counts for acceptance');
    if (runs === 0) {
      assert.match(evidence.summary, /mode none/);
      assert.ok(!fs.existsSync(h.env.TOWER_CRANE_TMP));
    } else {
      assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
    }
    if (expensive) {
      assert.match(evidence.summary, /scoped proof/);
      assert.equal(evidence.tests_mode, 'prove');
      assert.equal(evidence.commands.filter((c) => c.command === `${shellQuote(process.execPath)} ${shellQuote('test/value.test.js')}`).length, 2);
    }
    assert.equal(h.git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  });
}

test('run-only accepts Rust inline tests in source files without a changed test path', (t) => {
  const h = makeRepo(t);
  writeFiles(h.repo, {
    'src/lib.rs': 'pub fn value() -> i32 { 0 }\n',
    'check-inline.js': "require('node:assert/strict').match(require('node:fs').readFileSync('src/lib.rs', 'utf8'), /value\\(\\) -> i32 \\{ 1 \\}/);\n",
  });
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'inline fixture base']);
  h.git(['switch', '-qc', 'fixture-change']);
  writeFiles(h.repo, {
    'src/lib.rs': 'pub fn value() -> i32 { 1 }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn returns_one() { assert_eq!(super::value(), 1); }\n}\n',
  });
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'inline fixture change']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  submitTestsFixture(h, sha);
  const cmd = `${shellQuote(process.execPath)} check-inline.js`;
  h.ok(['project', 'set', '--tests-cmd', cmd]);
  const prove = h.run(['check', 'tests', 'T1', '--cmd', cmd]);
  assert.equal(prove.code, 1);
  assert.match(prove.stdout, /no test covers this change/);
  h.ok(['project', 'set', '--tests-mode', 'run-only']);
  h.ok(['project', 'set', '--tests-cmd', cmd]);
  const evidence = h.json(['check', 'tests', 'T1', '--cmd', cmd]);
  assert.match(evidence.summary, /mode run-only/);
  assert.equal(evidence.commands.filter((c) => c.command === cmd).length, 1);
  assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
});

test('run-only still fails when the suite fails at the submitted head', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {
    'test/value.test.js': "require('node:assert/strict').equal(require('../value'), 2);\n",
  } });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-mode', 'run-only']);
  const cmd = `${shellQuote(process.execPath)} verify-build.js`;
  h.ok(['project', 'set', '--tests-cmd', cmd]);
  const result = h.run(['check', 'tests', 'T1', '--cmd', cmd, '--json']);
  assert.equal(result.code, 1, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.ok, false);
  assert.match(evidence.summary, /at [a-f0-9]+: exit 1/);
  assert.equal(evidence.commands.filter((c) => c.command === cmd).length, 1);
  assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
});

test('none mode for docs and ops needs no command but still verifies the submitted sha', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {} });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-by-kind', '{"docs":"none","ops":"none"}']);
  for (const kind of ['docs', 'ops']) {
    changeKind(h, kind);
    const evidence = h.json(['check', 'tests', 'T1']);
    assert.match(evidence.summary, new RegExp(`mode none.*tests.by_kind.${kind}`));
    assert.equal(evidence.commands.some((c) => c.command !== 'git'), false);
  }
  h.ok(['submit', 'T1', '--sha', '0123456789abcdef0123456789abcdef01234567', '--agent', 'w-1']);
  const missing = h.run(['check', 'tests', 'T1']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /is not in/);
});

test('prove and run-only require a command, and malformed policy fails before running it', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {} });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-cmd', 'null']);
  for (const mode of ['prove', 'run-only']) {
    h.ok(['project', 'set', '--tests-mode', mode]);
    const missing = h.run(['check', 'tests', 'T1']);
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /no test command pinned/);
  }
  const project = h.readState('project.json');
  for (const [key, value] of [['mode', 'skip'], ['by_kind', { docs: null }], ['by_kind', { tooling: 'none' }], ['expensive', 'true']]) {
    h.writeState('project.json', { ...project, tests: { mode: 'none', [key]: value } });
    const bad = h.run(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js`, '--json']);
    assert.equal(bad.code, 1, bad.stderr);
    const evidence = JSON.parse(bad.stdout);
    assert.ok(evidence.summary.includes(`project.json tests.${key}`), evidence.summary);
    assert.deepEqual(evidence.commands, []);
  }
  assert.ok(!fs.existsSync(h.env.TOWER_CRANE_TMP));
});

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

test('expensive prove requires a scoped command before running the full suite', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {} });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-expensive', 'true']);
  for (const extra of [[], ['--proof-cmd', 'node test/value.test.js']]) {
    h.ok(['project', 'set', '--tests-proof-cmd', extra.length ? extra[1] : 'null']);
    const r = h.run(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js`, ...extra, '--json']);
    assert.equal(r.code, 1, r.stderr);
    const evidence = JSON.parse(r.stdout);
    assert.match(evidence.summary, /tests_proof_cmd.*\{tests\}/);
    assert.equal(evidence.commands.some((c) => c.command.includes('verify-build')), false);
  }
});

test('expensive prove rejects a scoped command that fails at head or passes after reverting', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {} });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-expensive', 'true']);
  for (const [cmd, message] of [
    [`${shellQuote(process.execPath)} -e "process.exit(1)" {tests}`, /scoped proof.*at.*exit 1/],
    [`${shellQuote(process.execPath)} -e "process.exit(0)" {tests}`, /tests pass without the change/],
  ]) {
    h.ok(['project', 'set', '--tests-proof-cmd', cmd]);
    const r = h.run(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js`, '--proof-cmd', cmd, '--json']);
    assert.equal(r.code, 1, r.stderr);
    assert.match(JSON.parse(r.stdout).summary, message);
  }
  assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
});

test('scoped proof receives only changed test paths and quotes spaces', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, {
    base: { 'proof.js': "require('node:assert/strict').deepEqual(process.argv.slice(2), ['test/new value.test.js', 'test/value.test.js']);\nfor (const file of process.argv.slice(2)) require('./' + file);\n" },
    submitted: { 'test/new value.test.js': "require('node:assert/strict').equal(require('../value'), 1);\n" },
  });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-expensive', 'true']);
  h.ok(['project', 'set', '--tests-proof-cmd', `${shellQuote(process.execPath)} proof.js {tests}`]);
  const evidence = h.json(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js`, '--proof-cmd', `${shellQuote(process.execPath)} proof.js {tests}`]);
  assert.match(evidence.summary, /kept a scoped proof/);
  assert.equal(evidence.commands.filter((c) => c.command.includes('proof.js')).length, 2);
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

function readEvents(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

// An accepted task whose worktree the CLI made; merge is the only step left.
function acceptedWithWorktree(h) {
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const wt = h.json(['worktree', 'T1']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
  for (const type of ['tests', 'clean']) gateEvidence(h, type, 'checker');
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  h.ok(['accept', 'T1']);
  return wt;
}

test('merge removes the merged task worktree and records it', (t) => {
  const h = makeRepo(t);
  h.init();
  const wt = acceptedWithWorktree(h);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);

  const merged = cli.run(['merge', 'T1'], { GATE_OUT: path.join(h.base, 'gate.json'), GATE_OK: '1' });
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(!fs.existsSync(wt.path), 'the worktree directory is gone');
  assert.ok(!h.git(['worktree', 'list', '--porcelain']).includes(wt.path), 'git no longer registers it');
  const removed = readEvents(h).find((e) => e.cmd === 'worktree removed');
  assert.equal(removed.task, 'T1');
  assert.equal(removed.detail.removed, true);
});

test('merge keeps a worktree with uncommitted changes and says why', (t) => {
  const h = makeRepo(t);
  h.init();
  const wt = acceptedWithWorktree(h);
  fs.writeFileSync(path.join(wt.path, 'notes.txt'), 'unfinished\n');
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);

  const merged = cli.run(['merge', 'T1'], { GATE_OUT: path.join(h.base, 'gate.json'), GATE_OK: '1' });
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(fs.readFileSync(path.join(wt.path, 'notes.txt'), 'utf8'), 'unfinished\n');
  assert.ok(h.git(['worktree', 'list', '--porcelain']).includes(wt.path), 'git still registers it');
  const kept = readEvents(h).find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T1');
  assert.equal(kept.detail.reason, 'uncommitted changes');
});

test('merge keeps the worktree while merge.keep_branch is set', (t) => {
  const h = makeRepo(t);
  h.init(['--merge-keep-branch', 'true']);
  const wt = acceptedWithWorktree(h);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);

  const merged = cli.run(['merge', 'T1'], { GATE_OUT: path.join(h.base, 'gate.json'), GATE_OK: '1' });
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(fs.existsSync(wt.path), 'the worktree stays for its branch');
  const kept = readEvents(h).find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.detail.reason, 'merge.keep_branch is set');
});
