'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const entry = path.basename(process.argv[1] || '');

if (entry === 'tower-crane.js' && process.env.TOWER_CRANE_TEST_MONITOR_ARGV) {
  const original = cp.spawn;
  cp.spawn = function captureMonitorArgv(file, args, options) {
    if (args.some((arg) => path.basename(arg) === 'spawn-monitor.js')) {
      fs.writeFileSync(process.env.TOWER_CRANE_TEST_MONITOR_ARGV, JSON.stringify({ file, args }));
    }
    return original.call(this, file, args, options);
  };
}

if (entry === 'tower-crane.js'
  && process.argv.includes('spawn')
  && process.env.TOWER_CRANE_TEST_HOLD_SPAWN_SPEND
  && process.env.TOWER_CRANE_TEST_RELEASE_SPAWN_SPEND) {
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  const originalExistsSync = fs.existsSync;
  let held = false;
  fs.readFileSync = function holdForegroundSpend(file, ...args) {
    const result = originalReadFileSync.call(this, file, ...args);
    const text = Buffer.isBuffer(result) ? result.toString('utf8') : String(result);
    if (!held && typeof file === 'string' && path.basename(file) === 'events.jsonl'
      && text.includes('"cmd":"spawn exit"')) {
      held = true;
      originalWriteFileSync.call(this, process.env.TOWER_CRANE_TEST_HOLD_SPAWN_SPEND, String(process.pid));
      const deadline = Date.now() + 30000;
      while (!originalExistsSync.call(this, process.env.TOWER_CRANE_TEST_RELEASE_SPAWN_SPEND)
        && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return result;
  };
}

if (entry === 'spawn-monitor.js'
  && process.env.TOWER_CRANE_TEST_CAPTURE_EXIT
  && process.env.TOWER_CRANE_TEST_CAPTURE_CAPTURED
  && process.env.TOWER_CRANE_TEST_CAPTURE_READY
  && process.env.TOWER_CRANE_TEST_CAPTURE_CONTINUE
  && process.env.TOWER_CRANE_TEST_CAPTURE_RESUME) {
  const originalWriteFileSync = fs.writeFileSync;
  let output = '';
  let captured = false;
  fs.writeFileSync = function captureFinalLog(file, data, ...args) {
    const result = originalWriteFileSync.call(this, file, data, ...args);
    if (file === 3 && !captured) {
      output += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (output.includes('final foreground output')) {
        captured = true;
        originalWriteFileSync.call(this, process.env.TOWER_CRANE_TEST_CAPTURE_CAPTURED, JSON.stringify({ at: Date.now() }));
      }
    }
    return result;
  };
  const original = cp.spawn;
  cp.spawn = function pauseForegroundCapture(file, args, options) {
    const child = original.call(this, file, args, options);
    if (child.stdout) {
      // The worker waits for this pause before writing, leaving bytes pending at its exit.
      const pause = () => setImmediate(() => {
        child.stdout.pause();
        setImmediate(() => {
          if (!child.stdout.isPaused()) return pause();
          fs.writeFileSync(process.env.TOWER_CRANE_TEST_CAPTURE_READY, JSON.stringify({
            flowing: child.stdout.readableFlowing,
            buffered: child.stdout.readableLength,
            paused: child.stdout.isPaused(),
          }));
        });
      });
      pause();
      child.once('exit', () => {
        fs.writeFileSync(process.env.TOWER_CRANE_TEST_CAPTURE_EXIT, JSON.stringify({
          at: Date.now(),
          flowing: child.stdout.readableFlowing,
          buffered: child.stdout.readableLength,
          paused: child.stdout.isPaused(),
        }));
        // Let the test inspect the pending output before the supervisor handles exit.
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(process.env.TOWER_CRANE_TEST_CAPTURE_CONTINUE)) {
          if (Date.now() >= deadline) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        const timer = setInterval(() => {
          if (!fs.existsSync(process.env.TOWER_CRANE_TEST_CAPTURE_RESUME)) return;
          clearInterval(timer);
          child.stdout.resume();
        }, 10);
      });
    }
    return child;
  };
}
