'use strict';

// tests.host_only files are skipped by a sandboxed run and still run in the tests gate on the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, ROOT } = require('./helpers');
const { shellQuote } = require('../lib/gates/common');

const RUNNER = path.join(ROOT, 'test', 'run.js');
// Each file leaves a marker in MARK_DIR when it runs.
const mark = (name) => `require('node:fs').writeFileSync(require('node:path').join(process.env.MARK_DIR, '${name}'), 'ran');\n`;
const FILES = {
  'test/host.test.js': mark('host'),
  'test/plain.test.js': mark('plain'),
};

function submitChange(h) {
  h.git(['switch', '-qc', 'host-change']);
  for (const [name, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(h.repo, name)), { recursive: true });
    fs.writeFileSync(path.join(h.repo, name), text);
  }
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'host-only and plain tests']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'the host test runs on the host']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--branch', 'host-change', '--agent', 'w-1']);
  return sha;
}

test('a host_only test is skipped in a sandboxed run and executed by check tests', (t) => {
  const h = makeRepo(t);
  const marks = path.join(h.base, 'marks');
  fs.mkdirSync(marks);
  const env = { MARK_DIR: marks };
  const cmd = `${shellQuote(process.execPath)} ${shellQuote(RUNNER)} test/host.test.js test/plain.test.js`;
  h.init(['--repo', 'acme/demo', '--base', 'main', '--tests-mode', 'run-only', '--tests-cmd', cmd, '--tests-host-only', JSON.stringify(['test/host.test.js'])]);
  submitChange(h);

  // A sandboxed worker runs the test command with the environment its spawn gives it.
  const worker = cp.spawnSync(process.execPath, [RUNNER, 'test/host.test.js', 'test/plain.test.js'], {
    cwd: h.repo, encoding: 'utf8', env: { ...h.env, ...env, TOWER_CRANE_SANDBOX: '1', TOWER_CRANE_HOST_ONLY: JSON.stringify(['test/host.test.js']) },
  });
  assert.equal(worker.status, 0, worker.stdout + worker.stderr);
  assert.match(worker.stderr, /skipped host-only tests in this sandbox.*test\/host\.test\.js/);
  assert.deepEqual(fs.readdirSync(marks), ['plain'], 'the sandboxed run skips the host-only file and runs the rest');

  // The gate runs in the same sandboxed environment but still runs every test on the host.
  const gate = h.run(['check', 'tests', 'T1', '--agent', 'checker'], {
    env: { ...env, TOWER_CRANE_SANDBOX: '1', TOWER_CRANE_HOST_ONLY: JSON.stringify(['test/host.test.js']) },
  });
  assert.equal(gate.code, 0, gate.stdout + gate.stderr);
  assert.deepEqual(fs.readdirSync(marks).sort(), ['host', 'plain']);
  const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(evidence.type, 'tests');
  assert.equal(evidence.ok, true);
});

test('a spawned worker is told the host-only tests and gets them in its environment', (t) => {
  const h = makeRepo(t);
  h.init(['--repo', 'acme/demo', '--base', 'main', '--tests-host-only', JSON.stringify(['test/host.test.js'])]);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['brief', 'set', 'T1', '-'], { input: '- change the lab session\n' });
  const seen = h.json(['spawn', '--task', 'T1', '--dry-run']);
  const prompt = seen.argv.find((arg) => arg.includes('## Task'));
  assert.match(prompt, /## Host-only tests[\s\S]*- test\/host\.test\.js/);
  assert.equal(seen.env.TOWER_CRANE_HOST_ONLY, JSON.stringify(['test/host.test.js']));
});
