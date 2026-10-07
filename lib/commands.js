'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const { refuse } = require('./util');

let mutations = 0;

function assertUnlocked(command) {
  if (mutations && /^(git|gh)(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(command))) {
    const e = refuse(`${command} cannot run inside a state mutation; prepare commands outside the lock and compare before applying`);
    e.lockedCommand = true;
    throw e;
  }
}

function mutation(fn) {
  mutations++;
  try { return fn(); }
  finally { mutations--; }
}

function runner(method) {
  return (command, ...args) => {
    assertUnlocked(command);
    return cp[method](command, ...args);
  };
}

module.exports = { assertUnlocked, mutation,
  execFileSync: runner('execFileSync'), execFile: runner('execFile'),
  spawnSync: runner('spawnSync'), spawn: runner('spawn') };
