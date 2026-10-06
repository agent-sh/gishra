'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const S = require('./state');

function identity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], start_ticks: fields[19] };
  } catch {
    return null;
  }
}

function running(spawn) {
  if (spawn.host && spawn.host !== os.hostname()) return true;
  if (!S.pidAlive(spawn.pid)) return false;
  const current = identity(spawn.pid);
  return !current || (!['Z', 'X'].includes(current.state)
    && (!spawn.start_ticks || spawn.start_ticks === current.start_ticks));
}

function record(state, task, agent) {
  return cp.spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'gishra.js'), 'spend', task, '--from-spawn', agent,
    '--state', state, '--agent', agent,
  ], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 30000 });
}

// The original harness pid stays the job identity for T20 and recovery.
// Only this small detached process survives the dispatching CLI.
if (require.main === module) {
  const spawn = JSON.parse(process.argv[2]);
  const timer = setInterval(() => {
    try {
      if (running(spawn)) return;
      clearInterval(timer);
      const result = record(spawn.state, spawn.task, spawn.agent);
      if (result.status !== 0) process.stderr.write(`gishra: usage not recorded; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
    } catch (e) {
      clearInterval(timer);
      process.stderr.write(`gishra: usage monitor failed: ${e.message}; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
      process.exitCode = 1;
    }
  }, 500);
}

module.exports = { identity, running, record };
