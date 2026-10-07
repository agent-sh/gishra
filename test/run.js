'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRepoSeed, cleanupRepoSeed } = require('./repo-seed');

const args = ['--test'];
const concurrency = process.platform === 'win32'
  ? 4
  : Math.max(1, Math.min(4, os.availableParallelism() - 1));
// Four Windows file workers leave CPU for test children that poll timers.
args.push(`--test-concurrency=${concurrency}`);
const testFiles = [
  ...fs.readdirSync(__dirname).filter((file) => file.endsWith('.test.js')).map((file) => `test/${file}`),
  ...fs.readdirSync(path.join(__dirname, 'gates')).filter((file) => file.endsWith('.test.js')).map((file) => `test/gates/${file}`),
].sort();
const windowsSlowFiles = [
  'test/reviewer.test.js',
  'test/supervision.test.js',
  'test/local-ci.test.js',
  'test/spawn-resume.test.js',
  'test/fallback.test.js',
  'test/gates.test.js',
  'test/spawn.test.js',
  'test/worktree.test.js',
  'test/evidence.test.js',
  'test/worker-slots.test.js',
  'test/usage.test.js',
  'test/harness-hooks.test.js',
  'test/stack.test.js',
  'test/gate-commands.test.js',
  'test/stack-merge.test.js',
  'test/accept.test.js',
  'test/ci-policy.test.js',
  'test/lock.test.js',
  'test/project.test.js',
  'test/task-locks.test.js',
  'test/submit.test.js',
  'test/spawn-exit.test.js',
  'test/authority.test.js',
];
const windowsPollingFiles = ['test/events.test.js'];
const orderedFiles = process.platform === 'win32'
  ? [
    ...windowsSlowFiles.filter((file) => testFiles.includes(file)),
    ...testFiles.filter((file) => !windowsSlowFiles.includes(file) && !windowsPollingFiles.includes(file)),
    ...windowsPollingFiles.filter((file) => testFiles.includes(file)),
  ]
  : testFiles;
args.push(...orderedFiles);

const seed = createRepoSeed();
let result;
try {
  result = cp.spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, TC_TEST_REPO_SEED: seed.repo },
  });
} finally {
  cleanupRepoSeed(seed);
}
if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else if (result.signal) {
  process.exitCode = 128 + (os.constants.signals[result.signal] || 0);
} else {
  process.exitCode = result.status ?? 1;
}
