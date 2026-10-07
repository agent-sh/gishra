'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { isDeepStrictEqual } = require('node:util');
const S = require('./state');
const P = require('./processes');
const { refuse } = require('./util');

// Native Claude resumes rewrote the measured cache. Command adapters own
// their session protocol; Codex is the measured warm native route.
function resumable(harness) {
  return ['codex', 'command'].includes(harness);
}

function exitedAttempt(attempt, events) {
  const start = events.indexOf(attempt);
  const next = events.findIndex((e, i) => i > start && e.cmd === 'spawn' && e.task === attempt.task
    && e.detail.agent === attempt.detail.agent);
  const current = events.slice(start + 1, next < 0 ? events.length : next).findLast((e) => e.cmd === 'spawn retry'
    && e.task === attempt.task && e.detail.agent === attempt.detail.agent && e.detail.attempt === attempt.detail.attempt) || attempt;
  return events.some((e, i) => i > start && e.cmd === 'spawn exit' && e.task === attempt.task
    && e.detail.agent === attempt.detail.agent && e.detail.pid === current.detail.pid
    && (e.detail.attempt === undefined || e.detail.attempt === attempt.detail.attempt))
    || P.exited(current.detail);
}

function eligible(p, cwd, events) {
  if (p.job !== 'worker' || !(p.task.status === 'rework' || p.task.claim?.from === 'rework')) return null;
  const last = events.findLast((e) => e.cmd === 'spawn' && e.task === p.task.id && e.detail.role === 'worker');
  if (!last || last.detail.agent !== p.task.submitted_by) return null;
  const prior = last.detail;
  if (!resumable(p.rung.harness)) return null;
  if (prior.rung !== p.rungName || prior.harness !== p.rung.harness
    || path.resolve(prior.cwd) !== path.resolve(cwd) || !isDeepStrictEqual(prior.route, p.rung)) return null;
  const receipt = events.findLast((e) => e.cmd === 'spawn session' && e.task === p.task.id
    && e.detail.agent === prior.agent && e.detail.pid === prior.pid && e.detail.attempt === prior.attempt);
  const exited = exitedAttempt(last, events);
  const id = receipt?.detail.session_id || prior.session_id
    || (prior.log ? logReader(prior.log, prior.harness)(exited) : null);
  if (!id) return null;
  if (!exited) throw refuse(`${p.task.id}: previous worker ${prior.agent} is still running or its exit is unverified; wait for its exit, then retry tower-crane spawn --task ${p.task.id}`);
  if (p.task.claim && p.task.claim.agent !== prior.agent) throw refuse(`${p.task.id}: cannot resume ${prior.agent} while claimed by ${p.task.claim.agent}; have the claimant release ${p.task.id}, then retry tower-crane spawn --task ${p.task.id}`);
  return { id, agent: prior.agent, previous: last };
}

function hasFile(dir, matches) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(e.code)) return false;
    throw e;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && matches(entry.name)) return true;
    if (entry.isDirectory() && hasFile(file, matches)) return true;
  }
  return false;
}

function missingCodexSession(id, isolation) {
  if (!isolation) return null;
  const sessions = isolation.usageRoot && path.join(isolation.usageRoot, 'sessions');
  if (sessions && hasFile(sessions, (name) => name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`))) return null;
  return 'recorded codex session has no rollout file in the isolated sessions directory';
}

function sessionId(text, harness) {
  try {
    const value = JSON.parse(text);
    const id = (harness === 'codex' || harness === 'command') && value.type === 'thread.started'
      ? value.thread_id
      : (harness === 'claude' || harness === 'command') && value.type === 'result'
        ? value.session_id : null;
    return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function reader(harness) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let id = null;
  return {
    push(chunk, final = false) {
      if (id) return id;
      pending += chunk ? decoder.write(chunk) : '';
      if (final) pending += decoder.end();
      const lines = pending.split(/\r?\n/);
      pending = final ? '' : lines.pop();
      for (const line of lines) {
        id = sessionId(line, harness);
        if (id) break;
      }
      return id;
    },
  };
}

function logReader(log, harness, offset = 0) {
  if (!log) return () => null;
  const parse = reader(harness);
  return (final = false) => {
    let fd;
    try {
      fd = fs.openSync(log, 'r');
      const chunk = Buffer.alloc(64 * 1024);
      let n;
      while ((n = fs.readSync(fd, chunk, 0, chunk.length, offset)) > 0) {
        offset += n;
        const id = parse.push(chunk.subarray(0, n));
        if (id) return id;
      }
      return parse.push(null, final);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
}

function receipt(st, emit, task, detail, id) {
  const attempt = st.events.find((e) => e.cmd === 'spawn' && e.task === task
    && e.detail.agent === detail.agent && e.detail.pid === detail.pid && e.detail.attempt === detail.attempt);
  if (!attempt || st.events.some((e) => e.cmd === 'spawn session' && e.task === task
    && e.detail.agent === detail.agent && e.detail.pid === detail.pid && e.detail.attempt === detail.attempt)) return;
  emit(task, { ...attempt.detail, session_id: id }, 'spawn session');
}

function record(ctx, detail, id, waitMs) {
  S.mutate(ctx, 'spawn session', (st, emit) => receipt(st, emit, ctx.task, detail, id), waitMs);
}

module.exports = { sessionId, reader, logReader, receipt, record, exitedAttempt, eligible, resumable, missingCodexSession };
