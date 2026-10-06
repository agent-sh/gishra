'use strict';

const fs = require('node:fs');
const os = require('node:os');
const S = require('./state');
const { byId } = require('./util');

const TAIL_LINES = 20;
const TAIL_BYTES = 8192;

function linuxProcess(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The executable name can contain spaces and parentheses, so fields start
    // after its closing parenthesis.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], start_ticks: fields[19] };
  } catch {
    return null;
  }
}

function identity(pid) {
  const info = linuxProcess(pid);
  return { host: os.hostname(), ...(info ? { start_ticks: info.start_ticks } : {}) };
}

function exited(spawn) {
  // A PID only identifies a process on the machine that started it.
  if (spawn.host && spawn.host !== os.hostname()) return false;
  if (!S.pidAlive(spawn.pid)) return true;
  const info = linuxProcess(spawn.pid);
  // Detached children can remain zombies under an init that does not reap them.
  // A reused PID must not hide the exit of the process we actually started.
  return !!info && (['Z', 'X'].includes(info.state)
    || (spawn.start_ticks !== undefined && spawn.start_ticks !== info.start_ticks));
}

function logTail(log) {
  if (!log) return '';
  let fd;
  try {
    fd = fs.openSync(log, 'r');
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
    let text = buffer.toString('utf8', 0, n);
    // Skip a partial first line when the byte limit cuts through a large log.
    if (offset && text.includes('\n')) text = text.slice(text.indexOf('\n') + 1);
    return text.replace(/\r?\n$/, '').split('\n').slice(-TAIL_LINES).join('\n');
  } catch (e) {
    return `[log unavailable: ${e.code || e.message}]`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function exitedClaims(st, events = S.readEvents(st.dir)) {
  const pending = new Map(st.tasks.tasks
    .filter((t) => t.status === 'in_progress' && t.claim)
    .map((t) => [t.id, { task: t, sawClaim: false, spawn: null, exits: new Set() }]));
  if (!pending.size) return [];
  const found = [];
  function finish(id, p) {
    pending.delete(id);
    const detail = p.spawn;
    if (detail && (p.exits.has(detail.pid) || exited(detail))) {
      found.push({ id, agent: detail.agent, pid: detail.pid, log: detail.log || null, tail: logTail(detail.log) });
    }
  }
  for (let i = events.length - 1; i >= 0 && pending.size; i--) {
    const e = events[i];
    const p = pending.get(e.task);
    if (!p) continue;
    const detail = e.detail || {};
    if (e.cmd === 'spawn exit' && detail.agent === p.task.claim.agent) p.exits.add(detail.pid);
    if (e.cmd === 'spawn' && detail.agent === p.task.claim.agent && Number.isInteger(detail.pid) && detail.pid > 0) {
      if (!p.spawn) p.spawn = detail;
      // A spawn before the latest claim may belong to an earlier lease held
      // by the same agent. Defer it until its lifecycle boundary is known.
      if (!p.sawClaim) finish(e.task, p);
    } else if (['release', 'submit', 'rework'].includes(e.cmd)) {
      finish(e.task, p);
    } else if (e.cmd === 'claim') {
      // Workers commonly claim after spawn. Stop at an earlier claim or
      // lifecycle boundary so a released worker's PID cannot taint a new claim.
      if (p.sawClaim) {
        // A replacement can start during another worker's expired lease,
        // but the same identity must not inherit its previous lease's spawn.
        if (e.agent !== p.task.claim.agent) finish(e.task, p);
        else pending.delete(e.task);
      } else if (e.agent !== p.task.claim.agent) pending.delete(e.task);
      else p.sawClaim = true;
    }
  }
  for (const [id, p] of pending) finish(id, p);
  return found.sort(byId);
}

function exitedWorkers(st, events = S.readEvents(st.dir)) {
  const found = exitedClaims(st, events);
  // A harness can fail before it claims. Stop at recovery boundaries so an
  // earlier spawn cannot report against a replacement.
  const pending = new Map(st.tasks.tasks.filter((t) => ['todo', 'rework'].includes(t.status)).map((t) => [t.id, { exits: new Set() }]));
  for (let i = events.length - 1; i >= 0 && pending.size; i--) {
    const e = events[i];
    const p = pending.get(e.task);
    if (!p) continue;
    const detail = e.detail || {};
    if (e.cmd === 'spawn exit') p.exits.add(`${detail.agent}:${detail.pid}`);
    if (e.cmd === 'spawn' && detail.role === 'worker' && Number.isInteger(detail.pid) && detail.pid > 0) {
      pending.delete(e.task);
      if (p.exits.has(`${detail.agent}:${detail.pid}`) || exited(detail)) {
        found.push({ id: e.task, agent: detail.agent, pid: detail.pid, log: detail.log || null, tail: logTail(detail.log), spawn: e.id || e.at });
      }
    } else if (['release', 'submit', 'rework', 'claim'].includes(e.cmd)) {
      pending.delete(e.task);
    }
  }
  return found.sort(byId);
}

function exitLines(claims) {
  if (!claims.length) return [];
  const lines = ['exited without submit:'];
  for (const c of claims) {
    lines.push(`  ${c.id} (${c.agent}, pid ${c.pid})`,
      `    log: ${c.log || '(foreground output; no log)'}`);
    if (c.log) {
      lines.push(`    tail (last ${TAIL_LINES} lines, at most ${TAIL_BYTES} bytes):`,
        ...(c.tail || '(empty)').split('\n').map((line) => `      ${line}`));
    }
    lines.push(`    recover: gishra release ${c.id} --reason "spawned process exited without submit"`);
  }
  return lines;
}

module.exports = { identity, exitedClaims, exitedWorkers, exitLines };
