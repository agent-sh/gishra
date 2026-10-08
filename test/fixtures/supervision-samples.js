'use strict';

const path = require('node:path');
const fs = require('node:fs');

if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.TOWER_CRANE_TEST_SAMPLES) {
  const append = fs.appendFileSync;
  const note = (kind, version) => append(process.env.TOWER_CRANE_TEST_SAMPLES, JSON.stringify({ kind, at: Date.now(), version }) + '\n');
  const read = fs.readFileSync;
  fs.readFileSync = function sampledRead(file, ...args) {
    if (typeof file === 'string' && path.basename(file) === 'tasks.json') {
      const stat = fs.statSync(path.join(path.dirname(file), 'events.jsonl'));
      note('state', `${stat.ino}:${stat.size}:${stat.mtimeMs}`);
    }
    return read.call(this, file, ...args);
  };
  const stat = fs.lstatSync;
  fs.lstatSync = function sampledPath(file, ...args) {
    if (path.basename(file) === 'progress.txt') note('path');
    return stat.call(this, file, ...args);
  };
}
