'use strict';

const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const P = require('./processes');
const Sessions = require('./spawn-session');
const RETRY_MS = 10 * 60 * 1000;

function running(spawn) {
  return !P.exited(spawn);
}

function record(state, task, agent, timeout = 30000) {
  return cp.spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'tower-crane.js'), 'spend', task, '--from-spawn', agent,
    '--state', state, '--agent', agent,
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout });
}

function removeFilteredBrief(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
    fs.rmdirSync(path.dirname(file));
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') {
      process.stderr.write(`tower-crane: could not remove temporary brief copy: ${error.message}\n`);
    }
  }
}

// The original harness pid stays the job identity for T20 and recovery.
// Only this small detached process survives the dispatching CLI.
if (require.main === module) {
  const spawn = JSON.parse(process.argv[2]);
  const readSession = Sessions.logReader(spawn.log, spawn.harness);
  let sessionRecorded = false;
  let deadline;
  let unknownDeadline;
  let failures = 0;
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(path.join(spawn.state, 'project.json'))) {
        clearInterval(timer);
        return;
      }
      const observed = P.processState(spawn);
      if (!sessionRecorded) {
        const id = readSession(observed === 'exited');
        if (id) {
          try {
            Sessions.record({ stateDir: spawn.state, agent: spawn.agent, task: spawn.task }, spawn, id, 0);
            sessionRecorded = true;
          } catch (e) {
            if (e.code !== 3) throw e;
          }
        }
      }
      if (observed === 'unknown') {
        unknownDeadline ??= performance.now() + RETRY_MS;
        if (performance.now() >= unknownDeadline) {
          clearInterval(timer);
          process.stderr.write(`tower-crane: cannot observe pid ${spawn.pid} after 10 min; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
          process.exitCode = 1;
        }
        return;
      }
      unknownDeadline = undefined;
      if (observed === 'running') return;
      removeFilteredBrief(spawn.filteredBriefFile);
      deadline ??= performance.now() + RETRY_MS;
      const timeout = Math.max(1, Math.min(30000, Math.floor(deadline - performance.now())));
      const result = record(spawn.state, spawn.task, spawn.agent, timeout);
      if (result.status === 0) {
        clearInterval(timer);
      } else if (performance.now() >= deadline) {
        clearInterval(timer);
        process.stderr.write(result.stderr || '');
        process.stderr.write(`tower-crane: usage not recorded after 10 min; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
        process.exitCode = 1;
      } else if (failures++ === 0) {
        process.stderr.write(`tower-crane: usage collection failed (${result.status ?? result.error?.code}); retrying for up to 10 min\n`);
      }
    } catch (e) {
      clearInterval(timer);
      process.stderr.write(`tower-crane: usage monitor failed: ${e.message}; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
      process.exitCode = 1;
    }
  }, 500);
}

module.exports = { running, record };
