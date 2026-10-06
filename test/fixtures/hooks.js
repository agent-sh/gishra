'use strict';

// Preloaded into a gishra process by tests that need to steer it from the
// outside: stop it at a point until the test lets it go, kill it while it
// holds the lock, slow it down, or make one kind of filesystem call fail.
// Each hook is off unless its HOOK_* variable is set, and acts only on paths
// under HOOK_STATE. Hooks key on file names, filesystem calls and error codes,
// not on gishra's functions, so a test built on them drives any version of
// the lock through the same schedule.

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

const env = process.env;
const STATE = env.HOOK_STATE ? path.resolve(env.HOOK_STATE) : null;
const LOCK = STATE ? path.join(STATE, 'lock') : null;
const WRAPPED = ['openSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmdirSync', 'rmSync', 'linkSync', 'statSync', 'readdirSync', 'mkdirSync', 'existsSync', 'utimesSync'];
// Calls that remove or move what is at their first argument.
const CHANGES = ['renameSync', 'unlinkSync', 'rmdirSync', 'rmSync', 'linkSync'];
const BUSY = ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM', 'EACCES'];
const real = {};
for (const name of WRAPPED) real[name] = fs[name];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const under = (root, p) => !!root && typeof p === 'string' && (path.resolve(p) === root || path.resolve(p).startsWith(root + path.sep));
const inState = (p) => under(STATE, p);
const inLock = (p) => under(LOCK, p);

// Tells the test this process reached a point (by creating SIGNAL with its
// pid), then waits until the test creates SIGNAL.go.
function stop(signal) {
  real.writeFileSync(signal, String(process.pid));
  const go = `${signal}.go`;
  const end = Date.now() + 30000;
  while (!real.existsSync(go) && Date.now() < end) sleep(10);
}

// HOOK_BARRIER=DIR with HOOK_BARRIER_N=N: the first time this process finds
// the lock taken, it waits until N processes have, so they all race for the
// same holder's lock at once.
let barrierDone = !env.HOOK_BARRIER;
function barrier() {
  if (barrierDone) return;
  barrierDone = true;
  real.writeFileSync(path.join(env.HOOK_BARRIER, String(process.pid)), '');
  const end = Date.now() + 20000;
  while (real.readdirSync(env.HOOK_BARRIER).length < Number(env.HOOK_BARRIER_N) && Date.now() < end) sleep(5);
}

const once = {};
function first(key) {
  if (once[key]) return false;
  once[key] = true;
  return true;
}

function before(name, args) {
  const target = args[0];
  // HOOK_JITTER_MS=MS: a random pause of up to MS before each call on the state.
  if (env.HOOK_JITTER_MS && (inState(target) || inState(args[1]))) sleep(Math.floor(Math.random() * Number(env.HOOK_JITTER_MS)));
  // HOOK_DIE_ON=FILE: killed when it reads FILE, which a write does while it holds the lock.
  if (env.HOOK_DIE_ON && name === 'readFileSync' && inState(target) && path.basename(target) === env.HOOK_DIE_ON) {
    process.kill(process.pid, 'SIGKILL');
    sleep(5000);
  }
  // HOOK_FAIL_LOCK=FILE: removing or moving anything at or inside the lock
  // fails with EPERM; each attempt adds a byte to FILE.
  if (env.HOOK_FAIL_LOCK && CHANGES.includes(name) && inLock(target)) {
    real.appendFileSync(env.HOOK_FAIL_LOCK, '.');
    const e = new Error(`EPERM: operation not permitted, ${name} '${target}'`);
    e.code = 'EPERM';
    throw e;
  }
}

function after(name, args) {
  const target = args[0];
  // HOOK_PAUSE_ON=FILE: stop at HOOK_PAUSED after the first read of FILE.
  if (env.HOOK_PAUSE_ON && name === 'readFileSync' && inState(target) && path.basename(target) === env.HOOK_PAUSE_ON && first('pause')) stop(env.HOOK_PAUSED);
  // HOOK_STOP_LOCK_READ=SIGNAL: stop after first reading who holds the lock.
  if (env.HOOK_STOP_LOCK_READ && name === 'readFileSync' && inLock(target) && first('lock-read')) stop(env.HOOK_STOP_LOCK_READ);
  // HOOK_STOP_LOCK_CHANGE=SIGNAL: stop after the first attempt to remove or
  // move what is at or inside the lock, whether or not it worked.
  if (env.HOOK_STOP_LOCK_CHANGE && CHANGES.includes(name) && inLock(target) && first('lock-change')) stop(env.HOOK_STOP_LOCK_CHANGE);
}

if (STATE) {
  for (const name of WRAPPED) {
    const orig = real[name];
    // The lock is taken by creating it (openSync) or by renaming onto it (renameSync).
    const lockArg = { openSync: 0, renameSync: 1 }[name];
    fs[name] = function hooked(...args) {
      before(name, args);
      let out;
      try {
        out = orig.apply(this, args);
      } catch (e) {
        if (lockArg !== undefined && path.resolve(String(args[lockArg])) === LOCK && BUSY.includes(e.code)) barrier();
        after(name, args);
        throw e;
      }
      after(name, args);
      return out;
    };
  }
}

// HOOK_SPAWN_FAIL=1: every child process fails to start, as a program that
// vanished after it was found would. git runs through execFileSync and is
// unaffected.
if (env.HOOK_SPAWN_FAIL) {
  cp.spawn = function failingSpawn(file) {
    const child = new EventEmitter();
    child.pid = undefined;
    child.unref = () => {};
    process.nextTick(() => {
      const e = new Error(`spawn ${file} ENOENT`);
      e.code = 'ENOENT';
      child.emit('error', e);
    });
    return child;
  };
}
