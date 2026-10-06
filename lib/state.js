'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { GishraError, refuse, nowIso, sleepSync } = require('./util');

const KINDS = ['code', 'docs', 'research', 'design', 'ops'];
const SIZES = ['S', 'M', 'L'];
const STATUSES = ['todo', 'in_progress', 'submitted', 'accepted', 'rework', 'cancelled'];
const EVIDENCE_TYPES = ['tests', 'clean', 'review', 'ci', 'merge', 'note'];
const HARNESSES = ['claude', 'codex', 'opencode', 'agy', 'pi', 'command'];

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

function readLock(file) {
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
    // A holder that has created the file but not yet written to it.
  }
  return { holder, mtimeMs: stat.mtimeMs };
}

function lockIsStale(lock) {
  if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) return true;
  const { pid, host } = lock.holder;
  return host === os.hostname() && Number.isInteger(pid) && !pidAlive(pid);
}

function breakLock(file, lock) {
  const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return;
  }
  // Between our staleness check and the rename another process may have
  // broken the same lock and taken a fresh one; if so, hand it back.
  const moved = readLock(aside);
  if (lock.holder.nonce && moved && moved.holder.nonce && moved.holder.nonce !== lock.holder.nonce) {
    try {
      fs.linkSync(aside, file);
    } catch {
      // Someone else already holds a new lock; theirs stands.
    }
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    // Already gone.
  }
}

function acquireLock(stateDir) {
  const file = path.join(stateDir, 'lock');
  const nonce = crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), at: nowIso(), nonce });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      return { file, nonce };
    } catch (e) {
      // On Windows a lock file deleted while someone still reads it stays
      // pending delete for a moment and refuses creation with EPERM.
      const busy = e.code === 'EEXIST' || (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES'));
      if (!busy) throw e;
    }
    const lock = readLock(file);
    if (lock && lockIsStale(lock)) {
      breakLock(file, lock);
      continue;
    }
    if (Date.now() >= deadline) {
      const h = (lock && lock.holder) || {};
      const who = h.pid ? `pid ${h.pid} on ${h.host} since ${h.at}` : 'another process';
      throw new GishraError(3, `state is locked by ${who}; retry, or delete ${file} if that process is gone`);
    }
    sleepSync(40 + Math.floor(Math.random() * 40));
  }
}

function releaseLock(lock) {
  const current = readLock(lock.file);
  if (current && current.holder.nonce === lock.nonce) {
    try {
      fs.unlinkSync(lock.file);
    } catch {
      // Already removed.
    }
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

function validateRole(name, r, errs) {
  if (!r || typeof r !== 'object') return errs.push(`role ${name} must be an object`);
  if (!HARNESSES.includes(r.harness)) errs.push(`role ${name}: harness must be one of ${HARNESSES.join(', ')}`);
  if (r.harness === 'command' && (!Array.isArray(r.command) || r.command.length === 0 || !r.command.every(isNonEmpty))) {
    errs.push(`role ${name}: a command harness needs a non-empty command array of strings`);
  }
  for (const k of ['model', 'profile', 'provider', 'effort']) if (r[k] !== undefined && r[k] !== null && !isNonEmpty(r[k])) errs.push(`role ${name}: ${k} must be a string`);
  if (r.args !== undefined && (!Array.isArray(r.args) || !r.args.every(isStr))) errs.push(`role ${name}: args must be an array of strings`);
}

function validateProject(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['project.json must hold an object'];
  if (p.version !== 1) errs.push('version must be 1');
  if (!isNonEmpty(p.name)) errs.push('name must be a non-empty string');
  if (!isNonEmpty(p.goal)) errs.push('goal must be a non-empty string');
  if (!isNullOr(p.repo, isNonEmpty)) errs.push('repo must be null or "owner/repo"');
  if (!isNonEmpty(p.base)) errs.push('base must be a branch name');
  if (!isNonEmpty(p.standards)) errs.push('standards must be "default" or a path');
  if (!p.roles || typeof p.roles !== 'object') errs.push('roles must be an object');
  else for (const [name, r] of Object.entries(p.roles)) validateRole(name, r, errs);
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
  if (!isNonEmpty(t.role)) bad('role must name a role');
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
    kind: 'code', acceptance: [], depends_on: [], needs_owner: null, size: 'M', role: 'worker',
    claim: null, branch: null, pr: null, sha: null, submitted_by: null, evidence: [], revision: 1, notes: [],
  };
  for (const [k, v] of Object.entries(defaults)) if (t[k] === undefined) t[k] = Array.isArray(v) ? [] : v;
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
  const lock = acquireLock(dir);
  try {
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
  } finally {
    releaseLock(lock);
  }
}

module.exports = {
  KINDS, SIZES, STATUSES, EVIDENCE_TYPES, HARNESSES, LOCK_WAIT_MS, LOCK_STALE_MS,
  git, repoAt, locateStateDir, findRepo, acquireLock, releaseLock, writeAtomic, readJson,
  validateProject, validateTasks, validateDecisions, loadState, mutate, appendEvents, readEvents, json, renderSafely,
};
