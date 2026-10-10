'use strict';

// The Windows lease gate. POSIX holds the harness behind /bin/sh; Windows has no
// sh, so Node waits for the same line on stdin, then runs the harness as its child.
// A monitor that exits before it takes the lease closes stdin, and the gate exits 1.
const { spawn } = require('node:child_process');

const [harness, ...args] = process.argv.slice(2);
let started = false;
process.stdin.once('data', () => {
  started = true;
  const child = spawn(harness, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', (e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
});
process.stdin.once('end', () => {
  if (!started) process.exit(1);
});
