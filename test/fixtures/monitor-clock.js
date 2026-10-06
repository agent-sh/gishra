'use strict';

// Advance monotonic time while real timers and CLI lock deadlines stay intact.
const { performance } = require('node:perf_hooks');
let elapsed = 0;
const step = Number(process.env.GISHRA_TEST_MONITOR_STEP || 10 * 60 * 1000);
Object.defineProperty(performance, 'now', { value: () => (elapsed += step) });

if (['signal', 'exited'].includes(process.env.GISHRA_TEST_MONITOR_PERMISSION)) {
  const kill = process.kill;
  process.kill = function deniedSignal(pid, signal) {
    if (pid === Number(process.env.GISHRA_TEST_MONITOR_PID) && signal === 0) {
      throw Object.assign(new Error('controlled process observation'), {
        code: process.env.GISHRA_TEST_MONITOR_PERMISSION === 'exited' ? 'ESRCH' : 'EPERM',
      });
    }
    return kill.call(this, pid, signal);
  };
}
if (process.env.GISHRA_TEST_MONITOR_PERMISSION === 'stat') {
  const fs = require('node:fs');
  const read = fs.readFileSync;
  fs.readFileSync = function deniedStat(file, ...args) {
    if (file === `/proc/${process.env.GISHRA_TEST_MONITOR_PID}/stat`) {
      throw Object.assign(new Error('process metadata denied'), { code: 'EACCES' });
    }
    return read.call(this, file, ...args);
  };
}
