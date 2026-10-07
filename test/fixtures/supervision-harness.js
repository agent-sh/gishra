'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (path.resolve(process.argv[1] || '') !== __filename) {
  const spawn = cp.spawn;
  cp.spawn = function offlineHarness(file, args, options) {
    if (['codex', 'claude'].includes(file) && process.env.TOWER_CRANE_TEST_SUPERVISION_FILE) {
      return spawn.call(this, process.execPath, [__filename, file, ...args], options);
    }
    return spawn.call(this, file, args, options);
  };
} else {
  const harness = process.argv[2];
  const args = process.argv.slice(3);
  const file = process.env.TOWER_CRANE_TEST_SUPERVISION_FILE;
  let fd;
  try { fd = fs.openSync(file, 'r+'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fd = fs.openSync(file, 'wx+');
  }
  const text = fs.readFileSync(fd, 'utf8');
  const attempts = text ? JSON.parse(text) : [];
  if (!attempts.length) {
    cp.execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'tower-crane.js'), 'claim', process.env.TOWER_CRANE_TASK], { stdio: 'ignore' });
  }
  attempts.push({ harness, args, agent: process.env.TOWER_CRANE_AGENT });
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, JSON.stringify(attempts), 0, 'utf8');
  fs.closeSync(fd);
  if (harness === 'codex') console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a11297-1067-7831-a3bc-2c04eac9aaef' }));
  if (attempts.length === 1) {
    if (harness === 'claude' && process.platform !== 'win32') process.kill(process.pid, 'SIGTERM');
    else process.exit(75);
  } else process.exit(0);
}
