'use strict';

const cp = require('node:child_process');
const S = require('./state');
const { refuse } = require('./util');

// A harness whose login failed is paused: no spawn takes it until a probe
// finds the login working. The latest `harness health` event per harness is
// the state, so a pause survives restarts and shows in the event log.
const PROBE_MS = 5 * 60 * 1000;
// A login check that runs longer than this counts as failed, so dispatch never
// waits on a hung CLI.
const PROBE_TIMEOUT_MS = 30000;
// Cheap local login checks. A harness without one has no probe: one spawn per
// interval goes through instead, and its exit decides the pause.
const PROBES = {
  claude: { argv: ['claude', 'auth', 'status'], ok: (out) => JSON.parse(out).loggedIn === true },
  codex: { argv: ['codex', 'login', 'status'], ok: () => true },
};
const RELOGIN = {
  claude: '`claude auth login`',
  codex: '`codex login`',
};

function last(st, harness) {
  return st.events.findLast((e) => e.cmd === 'harness health' && e.detail.harness === harness) || null;
}

function status(st, harness) {
  return last(st, harness)?.detail.status ?? null;
}

function paused(st, harness) {
  return status(st, harness) === 'unavailable';
}

function due(st, harness, now = Date.now()) {
  const event = last(st, harness);
  return !event || now - Date.parse(event.at) >= PROBE_MS;
}

// Routes a spawn may take, in ladder order. A paused harness with a probe
// takes nothing until the probe clears it; one without takes a spawn per interval.
function usable(st, routes, now = Date.now()) {
  return routes.filter((route) => !paused(st, route.harness) || !PROBES[route.harness] && due(st, route.harness, now));
}

function refusal(st, routes) {
  const harness = (routes.find((route) => paused(st, route.harness)) || routes[0]).harness;
  const reason = last(st, harness)?.detail.reason || 'login failed';
  const relogin = RELOGIN[harness] ? `re-login with ${RELOGIN[harness]}` : `sign in to ${harness} again`;
  const next = PROBES[harness] ? `the next probe clears it, at most every ${PROBE_MS / 60000} min`
    : `one spawn is let through every ${PROBE_MS / 60000} min to test it`;
  return `${harness} is paused after a login failure (${reason}); ${relogin}; ${next}`;
}

function notice(harness, reason) {
  const relogin = RELOGIN[harness] ? `re-login with ${RELOGIN[harness]}` : `sign in to ${harness} again`;
  const clears = PROBES[harness] ? 'at the next successful login check' : 'after a spawn on it succeeds';
  return `${harness} login failed: ${reason}. Tower Crane stopped dispatching to ${harness}, and attempts lost to it are not counted against any task. To continue, ${relogin}; the pause clears ${clears}.`;
}

// Records a login failure seen by a supervisor. Only the first failure of a
// pause notifies the owner.
function failed(st, emit, { harness, agent, reason }) {
  const notify = !paused(st, harness);
  emit(null, { harness, status: 'unavailable', reason, agent, source: 'exit' }, 'harness health');
  if (notify) emit(null, { to: 'owner', text: notice(harness, reason) }, 'msg');
}

function cleared(emit, harness, source) {
  emit(null, { harness, status: 'available', source }, 'harness health');
}

function check(harness) {
  const { argv, ok } = PROBES[harness];
  const name = argv.join(' ');
  const res = cp.spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.error) return { ok: false, reason: `${name} did not run (${res.error.code || res.error.message})` };
  if (res.status !== 0) return { ok: false, reason: `${name} ${res.signal ? `stopped by ${res.signal}` : `exited ${res.status}`}` };
  let logged = false;
  try { logged = ok(res.stdout); } catch { logged = false; }
  return logged ? { ok: true } : { ok: false, reason: `${name} reports no login` };
}

// Runs the due probe of each paused harness. Returns whether it wrote anything,
// so the caller reloads state before dispatch reads it.
function probe(ctx, st) {
  let recorded = false;
  for (const harness of Object.keys(PROBES)) {
    if (!paused(st, harness) || !due(st, harness)) continue;
    const result = check(harness);
    S.mutate(ctx, 'harness probe', (current, emit) => {
      if (!paused(current, harness) || !due(current, harness)) return;
      if (result.ok) cleared(emit, harness, 'probe');
      else emit(null, { harness, status: 'unavailable', reason: result.reason, source: 'probe' }, 'harness health');
    });
    recorded = true;
  }
  return recorded;
}

module.exports = { PROBE_MS, usable, refusal, paused, status, failed, cleared, probe };
