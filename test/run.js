'use strict';

const cp = require('node:child_process');
const os = require('node:os');

const args = ['--test'];
const concurrency = process.platform === 'win32'
  ? 6
  : Math.max(1, Math.min(4, os.availableParallelism() - 1));
// Windows pays more for process startup, so run more independent test files together.
args.push(`--test-concurrency=${concurrency}`);
args.push('test/*.test.js', 'test/gates/*.test.js');

const result = cp.spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else if (result.signal) {
  process.exitCode = 128 + (os.constants.signals[result.signal] || 0);
} else {
  process.exitCode = result.status ?? 1;
}
