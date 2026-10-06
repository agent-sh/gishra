'use strict';

const fs = require('node:fs');
const read = fs.readFileSync;

// Controlled kernel states exercise PID reuse and zombies through the CLI
// without depending on the host's reaper or exhausting its PID namespace.
fs.readFileSync = function processStat(file, ...args) {
  const result = read.call(this, file, ...args);
  if (file !== `/proc/${process.env.GISHRA_TEST_PROC_PID}/stat`) return result;
  const text = String(result);
  const start = text.lastIndexOf(')') + 2;
  const fields = text.slice(start).trim().split(/\s+/);
  if (process.env.GISHRA_TEST_PROC_STATE) fields[0] = process.env.GISHRA_TEST_PROC_STATE;
  if (process.env.GISHRA_TEST_PROC_TICKS) fields[19] = process.env.GISHRA_TEST_PROC_TICKS;
  const changed = text.slice(0, start) + fields.join(' ') + '\n';
  return Buffer.isBuffer(result) ? Buffer.from(changed) : changed;
};
