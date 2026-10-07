'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');

if (path.basename(process.argv[1] || '') === 'spawn-monitor.js') {
  const now = performance.now.bind(performance);
  const schedule = global.setTimeout;
  let elapsed = 0;
  Object.defineProperty(performance, 'now', { value: () => now() + elapsed });
  // Exercise the real supervisor's default outage budget without making CI
  // wait fifteen minutes. CLI locks and short cleanup timers stay in real time.
  global.setTimeout = function acceleratedBackoff(fn, ms, ...args) {
    if (ms < 30000 || ms > 600000) return schedule(fn, ms, ...args);
    return schedule(() => {
      elapsed += ms;
      fn(...args);
    }, ms / 1000);
  };
}
