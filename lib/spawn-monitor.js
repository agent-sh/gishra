'use strict';

const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const P = require('./processes');

function running(spawn) {
  return !P.exited(spawn);
}

function record(state, task, agent) {
  return cp.spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'gishra.js'), 'spend', task, '--from-spawn', agent,
    '--state', state, '--agent', agent,
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 30000 });
}

// The original harness pid stays the job identity for T20 and recovery.
// Only this small detached process survives the dispatching CLI.
if (require.main === module) {
  const spawn = JSON.parse(process.argv[2]);
  let deadline;
  let failures = 0;
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(path.join(spawn.state, 'project.json'))) {
        clearInterval(timer);
        return;
      }
      if (running(spawn)) return;
      deadline ||= performance.now() + 10 * 60 * 1000;
      const result = record(spawn.state, spawn.task, spawn.agent);
      if (result.status === 0) {
        clearInterval(timer);
      } else if (performance.now() >= deadline) {
        clearInterval(timer);
        process.stderr.write(result.stderr || '');
        process.stderr.write(`gishra: usage not recorded after 10 min; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
      } else if (failures++ === 0) {
        process.stderr.write(`gishra: usage collection failed (${result.status ?? result.error?.code}); retrying for up to 10 min\n`);
      }
    } catch (e) {
      clearInterval(timer);
      process.stderr.write(`gishra: usage monitor failed: ${e.message}; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
      process.exitCode = 1;
    }
  }, 500);
}

module.exports = { running, record };
