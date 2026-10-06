'use strict';

const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');

if (process.env.USAGE_CLAIM) {
  const result = cp.spawnSync(process.execPath, [
    path.join(__dirname, '..', '..', 'bin', 'gishra.js'), 'claim', process.env.GISHRA_TASK,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}
if (process.env.USAGE_SESSION) {
  fs.mkdirSync(path.dirname(process.env.USAGE_SESSION), { recursive: true });
  fs.copyFileSync(process.env.USAGE_SESSION_FIXTURE, process.env.USAGE_SESSION);
}
setTimeout(() => {
  process.stdout.write(fs.readFileSync(process.argv[2]));
  process.exitCode = Number(process.env.USAGE_EXIT || 0);
}, Number(process.env.USAGE_DELAY || 0));
