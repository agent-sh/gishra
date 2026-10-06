'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { GishraError, refuse, nowIso, sleepSync } = require('./util');
const L = require('./ladder');

const KINDS = ['code', 'docs', 'research', 'design', 'ops'];
const SIZES = ['S', 'M', 'L'];
const STATUSES = ['todo', 'in_progress', 'submitted', 'accepted', 'rework', 'cancelled'];
const EVIDENCE_TYPES = ['tests', 'clean', 'review', 'ci', 'merge', 'note'];
const { HARNESSES, TIERS } = L;

const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 60000;

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function repoAt(dir) {
  if (!isDir(dir)) return null;
  const out = git(['rev-parse', '--git-common-dir'], dir);
  if (!out) return null;
  const commonDir = path.resolve(dir, out);
  // A bare repository has no main checkout, so its common dir stands in for one.
  const root = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return { root, commonDir };
}

function locateStateDir(flag, env, cwd) {
  if (flag) return path.resolve(cwd, flag);
  if (env.GISHRA_STATE) return path.resolve(cwd, env.GISHRA_STATE);
  const repo = repoAt(cwd);
  if (!repo) {
    throw refuse('not inside a git repository; run gishra from the repo, or pass --state DIR or set GISHRA_STATE');
  }
  return path.join(repo.root, '.gishra');
}

// The repository gishra runs in wins; outside one, fall back to the repository
// that holds the state directory.
function findRepo(stateDir, cwd) {
  return repoAt(cwd) || (stateDir ? repoAt(path.dirname(stateDir)) : null);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// The lock is a directory, `lock`, holding one marker file named after its
// holder's random nonce, with the holder's pid, host and time inside.
//
// - Taking it: the writer prepares a private directory with its marker and
//   renames it to `lock`. The rename fails while `lock` holds a marker, so a
//   holder's marker is in the lock from the moment it holds it, and no other
//   writer's rename can land until that marker is gone.
// - Breaking a stale one: unlink the stale marker by its own name, then rmdir
//   `lock`. Nonces are never reused, so a breaker that lost a race to another
//   breaker unlinks nothing; it cannot reach the marker of whoever took the
//   lock since. rmdir removes only an empty directory.
// - Releasing: the same two steps on the holder's own marker.
//
// Every removal names exactly what it removes, so no process acts on a lock it
// looked at earlier that has since been replaced, whatever the interleaving.
const MARKER_BYTES = 8;
const STAGING_RE = /^lock\.([0-9a-f]{16})\.new$/;
// The errors a rename onto a held lock gives. Windows cannot rename onto any
// existing directory and reports that, and a directory still pending delete,
// as EPERM or EACCES.
const LOCK_BUSY = process.platform === 'win32'
  ? ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM', 'EACCES', 'EBUSY']
  : ['EEXIST', 'ENOTEMPTY', 'ENOTDIR'];
const LOCK_BACKOFF_MIN_MS = 10;
const LOCK_BACKOFF_MAX_MS = 100;

function readMarker(file) {
  let stat;
  let raw;
  try {
    stat = fs.statSync(file);
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let holder = {};
  try {
    holder = JSON.parse(raw) || {};
  } catch {
    // Markers are complete before the lock appears, so only a hand edit gets here.
  }
  return { holder, mtimeMs: stat.mtimeMs };
}

function lockIsStale(marker) {
  if (Date.now() - marker.mtimeMs > LOCK_STALE_MS) return true;
  const { pid, host } = marker.holder;
  return host === os.hostname() && Number.isInteger(pid) && !pidAlive(pid);
}

function holderText(h) {
  return h && h.pid ? `pid ${h.pid} on ${h.host} since ${h.at}` : 'another process';
}

function removeQuietly(fn, target) {
  try {
    fn(target);
    return true;
  } catch {
    return false;
  }
}

// One look at a lock we could not take: who holds it, and clear what is stale.
// progress is true when this call removed something, so the caller retries at
// once; stuck names a stale holder whose marker could not be removed.
function clearStale(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    // A plain file here is not a lock this version takes or breaks.
    if (e.code === 'ENOTDIR') return { progress: false, holder: (readMarker(dir) || {}).holder || null };
    return { progress: false, holder: null };
  }
  let progress = false;
  let holder = null;
  let stuck = null;
  for (const name of names) {
    const file = path.join(dir, name);
    const marker = readMarker(file);
    if (!marker) continue;
    if (!lockIsStale(marker)) {
      holder = marker.holder;
      continue;
    }
    try {
      fs.unlinkSync(file);
      progress = true;
    } catch (e) {
      if (e.code === 'ENOENT') progress = true;
      else stuck = { holder: marker.holder, code: e.code };
    }
  }
  if (!holder && !stuck && removeQuietly(fs.rmdirSync, dir)) progress = true;
  return { progress, holder, stuck };
}

function lockTimeout(dir, seen) {
  if (seen.stuck) {
    return new GishraError(3, `state is locked by ${holderText(seen.stuck.holder)}, which is gone, but its lock could not be removed (${seen.stuck.code}); remove ${dir} by hand`);
  }
  return new GishraError(3, `state is locked by ${holderText(seen.holder)}; retry, or remove ${dir} if that process is gone`);
}

// A writer killed while it waited leaves its prepared directory behind. A
// live waiter rewrites its marker on every attempt and gives up after
// LOCK_WAIT_MS, so one untouched for LOCK_STALE_MS is litter.
function sweepStaging(stateDir) {
  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = STAGING_RE.exec(name);
    if (!m) continue;
    const dir = path.join(stateDir, name);
    const marker = readMarker(path.join(dir, m[1]));
    let mtimeMs = marker ? marker.mtimeMs : null;
    if (mtimeMs === null) {
      try {
        mtimeMs = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (Date.now() - mtimeMs <= LOCK_STALE_MS) continue;
    removeQuietly(fs.unlinkSync, path.join(dir, m[1]));
    removeQuietly(fs.rmdirSync, dir);
  }
}

function acquireLock(stateDir) {
  const dir = path.join(stateDir, 'lock');
  const nonce = crypto.randomBytes(MARKER_BYTES).toString('hex');
  const staging = path.join(stateDir, `lock.${nonce}.new`);
  const marker = path.join(staging, nonce);
  const mine = path.join(dir, nonce);
  const prepare = () => {
    try {
      fs.mkdirSync(staging);
    } catch (e) {
      if (e.code === 'ENOENT') throw refuse(`no gishra state at ${stateDir}; run gishra init --name N --goal G (or point --state at the right directory)`);
      if (e.code !== 'EEXIST') throw e;
    }
  };
  prepare();
  const deadline = Date.now() + LOCK_WAIT_MS;
  let backoff = LOCK_BACKOFF_MIN_MS;
  try {
    for (;;) {
      // Rewritten on every attempt, so the lock's age counts from when it is taken.
      fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, host: os.hostname(), at: nowIso(), nonce }));
      let moved = false;
      try {
        fs.renameSync(staging, dir);
        moved = true;
      } catch (e) {
        if (!LOCK_BUSY.includes(e.code)) throw e;
      }
      if (moved) {
        // The rename can land on an empty directory, so the lock is ours only
        // if our marker arrived with it.
        if (fs.existsSync(mine)) {
          sweepStaging(stateDir);
          return { dir, nonce, file: mine };
        }
        removeQuietly(fs.rmdirSync, dir);
        prepare();
        continue;
      }
      const seen = clearStale(dir);
      if (Date.now() >= deadline) throw lockTimeout(dir, seen);
      if (!seen.progress) {
        sleepSync(backoff + Math.floor(Math.random() * backoff));
        backoff = Math.min(backoff * 2, LOCK_BACKOFF_MAX_MS);
      }
    }
  } catch (e) {
    removeQuietly(fs.unlinkSync, marker);
    removeQuietly(fs.rmdirSync, staging);
    throw e;
  }
}

// Windows refuses to delete a file another process has open without
// FILE_SHARE_DELETE (a virus scanner, say), so retry briefly.
function unlinkRetry(file) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() > deadline) return false;
      sleepSync(25);
    }
  }
}

function releaseLock(lock) {
  unlinkRetry(lock.file);
  // Removes only an empty directory: a holder that took over since keeps its lock.
  removeQuietly(fs.rmdirSync, lock.dir);
}

function withLock(stateDir, fn) {
  const lock = acquireLock(stateDir);
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}

// Windows refuses to replace a file another process has open (a reader or
// fs.watch), so retry the rename briefly before giving up.
function renameRetry(from, to) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() > deadline) {
        try {
          fs.unlinkSync(from);
        } catch {
          // Nothing to clean up.
        }
        throw e;
      }
      sleepSync(25);
    }
  }
}

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameRetry(tmp, file);
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw refuse(`${path.basename(file)} is missing from ${path.dirname(file)}; restore it or run gishra init in a fresh state directory`);
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw refuse(`${file} is not valid JSON (${e.message}); fix it by hand or restore it from version control`);
  }
}

const isStr = (v) => typeof v === 'string';
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isNullOr = (v, check) => v === null || check(v);
const isInt = (v) => Number.isInteger(v);
const isNonNegNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function validateProject(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['project.json must hold an object'];
  if (p.version !== 1) errs.push('version must be 1');
  if (!isNonEmpty(p.name)) errs.push('name must be a non-empty string');
  if (!isNonEmpty(p.goal)) errs.push('goal must be a non-empty string');
  if (!isNullOr(p.repo, isNonEmpty)) errs.push('repo must be null or "owner/repo"');
  if (!isNonEmpty(p.base)) errs.push('base must be a branch name');
  if (!isNonEmpty(p.standards)) errs.push('standards must be "default" or a path');
  if (p.roles !== undefined) errs.push('roles was replaced by harness and ladder (docs/state.md); remove roles, and add a ladder if the defaults do not fit');
  // Shape only: whether a rung can run may depend on the user file, which
  // can change under a project; spawn, ladder writes and validate check that.
  errs.push(...L.shapeErrors(p));
  const l = p.limits || {};
  if (!isInt(l.workers) || l.workers < 1) errs.push('limits.workers must be a positive integer');
  if (!isInt(l.lease_minutes) || l.lease_minutes < 1) errs.push('limits.lease_minutes must be a positive integer');
  const b = p.budget || {};
  if (!isNullOr(b.hours, isNonNegNum)) errs.push('budget.hours must be null or a non-negative number');
  if (!isNullOr(b.tokens, isNonNegNum)) errs.push('budget.tokens must be null or a non-negative number');
  return errs;
}

function validateTask(t, errs) {
  const at = t && t.id ? t.id : 'a task';
  const bad = (m) => errs.push(`${at}: ${m}`);
  if (!t || typeof t !== 'object') return errs.push('every task must be an object');
  if (!/^T\d+$/.test(t.id)) bad('id must look like T1');
  if (!isNonEmpty(t.title)) bad('title must be a non-empty string');
  if (!KINDS.includes(t.kind)) bad(`kind must be one of ${KINDS.join(', ')}`);
  if (!Array.isArray(t.acceptance) || !t.acceptance.every(isStr)) bad('acceptance must be an array of strings');
  if (!Array.isArray(t.depends_on) || !t.depends_on.every(isStr)) bad('depends_on must be an array of task ids');
  if (!isNullOr(t.needs_owner, isNonEmpty)) bad('needs_owner must be null or a reason');
  if (!SIZES.includes(t.size)) bad(`size must be one of ${SIZES.join(', ')}; split anything larger`);
  if (!TIERS.includes(t.tier)) bad(`tier must be one of ${TIERS.join(', ')}`);
  if (!STATUSES.includes(t.status)) bad(`status must be one of ${STATUSES.join(', ')}`);
  if (t.claim !== null) {
    const c = t.claim;
    if (!c || !isNonEmpty(c.agent) || !isStr(c.since) || !isStr(c.until)) bad('claim must be null or { agent, since, until }');
  }
  if (t.status === 'in_progress' && !t.claim) bad('an in_progress task needs a claim');
  if (!isNullOr(t.branch, isNonEmpty)) bad('branch must be null or a branch name');
  if (!isNullOr(t.pr, (v) => isInt(v) && v > 0)) bad('pr must be null or a pull request number');
  if (!isNullOr(t.sha, isNonEmpty)) bad('sha must be null or a commit hash');
  if (!isNullOr(t.submitted_by, isNonEmpty)) bad('submitted_by must be null or an agent');
  if (!Array.isArray(t.evidence)) bad('evidence must be an array');
  else {
    for (const e of t.evidence) {
      if (!e || !EVIDENCE_TYPES.includes(e.type) || typeof e.ok !== 'boolean' || !isNonEmpty(e.agent) || !isInt(e.revision)) {
        bad(`evidence entries need type (${EVIDENCE_TYPES.join(', ')}), ok, agent and revision`);
        break;
      }
    }
  }
  if (!isInt(t.revision) || t.revision < 1) bad('revision must be a positive integer');
  if (!t.spend || !isNonNegNum(t.spend.minutes) || !isNonNegNum(t.spend.tokens)) bad('spend must be { minutes, tokens }');
  if (!Array.isArray(t.notes)) bad('notes must be an array');
}

function validateTasks(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['tasks.json must hold an object'];
  if (doc.version !== 1) errs.push('version must be 1');
  if (!isInt(doc.next) || doc.next < 1) errs.push('next must be a positive integer');
  if (!Array.isArray(doc.tasks)) return errs.concat('tasks must be an array');
  const seen = new Set();
  for (const t of doc.tasks) {
    validateTask(t, errs);
    if (t && t.id) {
      if (seen.has(t.id)) errs.push(`${t.id}: duplicate id`);
      seen.add(t.id);
    }
  }
  return errs;
}

function validateDecisions(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['decisions.json must hold an object'];
  if (doc.version !== 1) errs.push('version must be 1');
  if (!isInt(doc.next) || doc.next < 1) errs.push('next must be a positive integer');
  if (!Array.isArray(doc.decisions)) return errs.concat('decisions must be an array');
  const seen = new Set();
  for (const d of doc.decisions) {
    const at = d && d.id ? d.id : 'a decision';
    if (!d || !/^D\d+$/.test(d.id)) errs.push(`${at}: id must look like D1`);
    else if (seen.has(d.id)) errs.push(`${d.id}: duplicate id`);
    else seen.add(d.id);
    if (!d) continue;
    if (!isNonEmpty(d.question)) errs.push(`${at}: question must be a non-empty string`);
    if (!Array.isArray(d.options) || !d.options.every(isNonEmpty)) errs.push(`${at}: options must be an array of strings`);
    if (!Array.isArray(d.blocks) || !d.blocks.every(isStr)) errs.push(`${at}: blocks must be an array of task ids`);
    if (!['open', 'answered'].includes(d.status)) errs.push(`${at}: status must be open or answered`);
    if (d.status === 'answered' && !isNonEmpty(d.answer)) errs.push(`${at}: an answered decision needs an answer`);
  }
  return errs;
}

// Fields added after the first files were written default here, so older
// files keep loading.
function normalizeTask(t) {
  if (!t || typeof t !== 'object') return t;
  const defaults = {
    kind: 'code', acceptance: [], depends_on: [], needs_owner: null, size: 'M',
    claim: null, branch: null, pr: null, sha: null, submitted_by: null, evidence: [], revision: 1, notes: [],
  };
  for (const [k, v] of Object.entries(defaults)) if (t[k] === undefined) t[k] = Array.isArray(v) ? [] : v;
  if (t.tier === undefined) t.tier = L.defaultTier(t.kind, t.size);
  // tier replaced role; a stale role would read as if it still chose the model.
  delete t.role;
  if (!t.spend) t.spend = { minutes: 0, tokens: 0 };
  return t;
}

function normalizeDecision(d) {
  if (!d || typeof d !== 'object') return d;
  const defaults = { options: [], recommendation: null, why: null, blocks: [], answer: null, note: null, answered_by: null, answered_at: null };
  for (const [k, v] of Object.entries(defaults)) if (d[k] === undefined) d[k] = Array.isArray(v) ? [] : v;
  return d;
}

function checkOrRefuse(file, errs) {
  if (errs.length) throw refuse(`${file} is invalid: ${errs.join('; ')}; fix it by hand or restore it from version control`);
}

function loadState(dir) {
  if (!fs.existsSync(path.join(dir, 'project.json'))) {
    throw refuse(`no gishra state at ${dir}; run gishra init --name N --goal G (or point --state at the right directory)`);
  }
  const project = readJson(path.join(dir, 'project.json'));
  checkOrRefuse('project.json', validateProject(project));
  const tasks = readJson(path.join(dir, 'tasks.json'));
  if (tasks && Array.isArray(tasks.tasks)) tasks.tasks.forEach(normalizeTask);
  checkOrRefuse('tasks.json', validateTasks(tasks));
  const decisions = readJson(path.join(dir, 'decisions.json'));
  if (decisions && Array.isArray(decisions.decisions)) decisions.decisions.forEach(normalizeDecision);
  checkOrRefuse('decisions.json', validateDecisions(decisions));
  return { dir, project, tasks, decisions };
}

const json = (v) => JSON.stringify(v, null, 2) + '\n';

function appendEvents(dir, events) {
  if (!events.length) return;
  fs.appendFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
}

function readEvents(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn final line from a crash; the rest of the log still counts.
    }
  }
  return out;
}

function renderSafely(st) {
  try {
    require('./render').renderFiles(st);
  } catch (e) {
    process.stderr.write(`gishra: state written, but rendering the sketch failed: ${e.message}\n`);
  }
}

// Every write: take the lock, re-read, let fn change the in-memory state,
// validate, write changed files atomically, log events, re-render. A refused
// command throws inside fn and nothing is written.
function mutate(ctx, cmd, fn) {
  const dir = ctx.stateDir;
  return withLock(dir, () => {
    const st = loadState(dir);
    const before = { project: json(st.project), tasks: json(st.tasks), decisions: json(st.decisions) };
    const events = [];
    const emit = (task, detail, name) => {
      events.push({ at: nowIso(), agent: ctx.agent, cmd: name || cmd, task: task || null, detail: detail || {} });
    };
    const result = fn(st, emit);
    checkOrRefuse('project.json', validateProject(st.project));
    checkOrRefuse('tasks.json', validateTasks(st.tasks));
    checkOrRefuse('decisions.json', validateDecisions(st.decisions));
    let changed = false;
    for (const key of ['project', 'tasks', 'decisions']) {
      const text = json(st[key]);
      if (text !== before[key]) {
        writeAtomic(path.join(dir, `${key}.json`), text);
        changed = true;
      }
    }
    appendEvents(dir, events);
    if (changed || st.rerender) renderSafely(st);
    return result;
  });
}

module.exports = {
  KINDS, SIZES, STATUSES, EVIDENCE_TYPES, HARNESSES, TIERS, LOCK_WAIT_MS, LOCK_STALE_MS,
  git, repoAt, locateStateDir, findRepo, acquireLock, releaseLock, withLock, writeAtomic, readJson,
  validateProject, validateTasks, validateDecisions, loadState, mutate, appendEvents, readEvents, json, renderSafely,
};
