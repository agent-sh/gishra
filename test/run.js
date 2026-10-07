'use strict';

const cp = require('node:child_process');
const os = require('node:os');
const { createRepoSeed, cleanupRepoSeed } = require('./repo-seed');

const args = ['--test'];
const concurrency = process.platform === 'win32'
  ? 4
  : Math.max(1, Math.min(4, os.availableParallelism() - 1));
// Four Windows file workers leave CPU for test children that poll timers.
args.push(`--test-concurrency=${concurrency}`);
args.push('test/*.test.js', 'test/gates/*.test.js');

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
