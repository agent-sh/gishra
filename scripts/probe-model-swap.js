'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cache = process.env.TOWER_CRANE_TEST_TMP || path.join(os.homedir(), '.cache', 'tower-crane-tests');
fs.mkdirSync(cache, { recursive: true });
const probe = fs.mkdtempSync(path.join(cache, 'model-swap-'));
const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

try {
  for (const file of new Set(files)) {
    const dest = path.join(probe, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file), dest);
  }
  cp.execFileSync('git', ['init', '-q'], { cwd: probe });
  cp.execFileSync('git', ['add', '.'], { cwd: probe });
  const file = path.join(probe, 'lib', 'ladder.js');
  const text = fs.readFileSync(file, 'utf8');
  const builtin = {
    harness: 'pi',
    ladder: Object.fromEntries(['orchestrator', 'easy', 'medium', 'hard', 'research', 'review', 'small']
      .map(name => [name, { harness: 'pi', model: `fake-model-${name}-2099`, effort: 'high' }])),
  };
  fs.writeFileSync(file, text.replace(/const BUILTIN = \{[\s\S]*?\n\};/,
    `const BUILTIN = ${JSON.stringify(builtin, null, 2)};`));
  const tests = files.filter(f => /^test\/(?:gates\/)?[^/]+\.test\.js$/.test(f));
  const log = path.join(cache, 'model-swap-probe.tap');
  const fd = fs.openSync(log, 'w');
  let result;
  try {
    result = cp.spawnSync(process.execPath, ['--test', '--test-concurrency=4', '--test-reporter=tap',
      ...tests.map(f => path.join(probe, f))], {
      cwd: probe, env: { ...process.env, TOWER_CRANE_TEST_TMP: cache }, stdio: ['ignore', fd, fd], timeout: 600000,
    });
  } finally { fs.closeSync(fd); }
  const output = fs.readFileSync(log, 'utf8');
  const failures = [...output.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]);
  console.log(`Probe log: ${log}`);
  console.log(output.split('\n').filter(line => /^# (tests|pass|fail|skipped)|^not ok /.test(line)).join('\n'));
  const expected = 'BUILTIN matches the documented defaults and init fallback';
  if (result.error || result.status !== 1 || failures.length !== 1 || failures[0] !== expected) {
    throw new Error(`expected only "${expected}" to fail: ${JSON.stringify(failures)}; ${result.error || ''}`);
  }
  console.log('Model swap probe passed: only the documented defaults assertion failed.');
} finally {
  fs.rmSync(probe, { recursive: true, force: true });
}
