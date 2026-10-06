'use strict';

const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const P = require('./processes');
const S = require('./state');
const T = require('./tasks');
const L = require('./ladder');
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

// Usage stays keyed by the dispatch agent across transient attempts.
function collect(spawn) {
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

function tailSince(log, offset) {
  let fd;
  try {
    fd = fs.openSync(log, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(offset, size - 8192);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } catch (e) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(e.code)) return '';
    throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function transient(code, signal, text) {
  if (code === 75 || ['SIGTERM', 'SIGINT'].includes(signal)) return true;
  if (code === 0) return false;
  return /\b(?:HTTP(?:Error)?|status(?:[_ ]code)?|API(?: error)?|error)\s*["':= ]*\s*5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)\b|\b(?:service unavailable|provider outage|overloaded_error|internal_server_error|server overloaded)\b/i.test(text);
}

function resume(spawn, id) {
  if (!['claude', 'codex', 'command'].includes(spawn.harness)) return null;
  const rung = { ...spawn.rung_config, args: [...(spawn.rung_config.args || [])] };
  if (spawn.harness === 'claude') {
    if (rung.args.includes('--fork-session')) return null;
    for (const flag of ['--resume', '--session-id']) {
      const i = rung.args.indexOf(flag);
      if (i >= 0) rung.args.splice(i, 2);
    }
  }
  return require('./spawn').buildCommand(spawn.role, rung, spawn.prompt, spawn.subs, process.env, id);
}

function pathProgress(spawn, config) {
  const files = [spawn.log, ...config.progress_paths.map((p) => path.join(spawn.cwd, p))];
  const stamps = [];
  function visit(file) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return;
      stamps.push(`${file}:${stat.mtimeMs}:${stat.size}`);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(file)) if (!['.git', '.tower-crane', 'node_modules'].includes(name)) visit(path.join(file, name));
      }
    } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
  }
  for (const file of files) visit(file);
  return stamps.join('|');
}

async function supervise(spawn) {
  const config = L.supervision(spawn.rung_config || {});
  const ctx = { stateDir: spawn.state, agent: spawn.agent, env: process.env, flags: {}, pos: [] };
  let child;
  let childIdentity;
  let closed;
  let captureComplete = false;
  let attempt = 0;
  let claimedSince;
  let phase = 'running';
  let nextRetry;
  let lastProgress = performance.now();
  let stamp;
  let cpu;
  let exit;
  let attemptOffset = 0;
  let committed = false;
  let retired = false;
  let timer;
  let initialDetail;
  let sessionRecorded = false;
  const readSession = Sessions.logReader(spawn.log, spawn.harness);
  let observedSession = spawn.session_id;
  const sessionFromLog = (final) => {
    try { return readSession(final); } catch { return null; }
  };
  const monitor = { monitor_pid: process.pid, monitor_start_ticks: P.identity(process.pid).start_ticks };
  const detail = () => ({
    role: spawn.role, rung: spawn.rung, harness: spawn.harness, agent: spawn.agent, cwd: spawn.cwd,
    pid: child?.pid, ...childIdentity, log: spawn.log, ...monitor,
    active: !exit || !captureComplete || nextRetry !== undefined,
    session_id: spawn.session_id || null,
    attempt: spawn.attempt,
  });
  const valid = (st) => {
    const task = T.getTask(st, spawn.task);
    const latest = st.events.findLast((e) => e.task === task.id && e.cmd === 'spawn');
    if (!latest) return false;
    if (latest.detail.agent !== spawn.agent || latest.detail.monitor_pid !== process.pid) return false;
    if (['accepted', 'cancelled'].includes(task.status) || spawn.role === 'worker' && task.status === 'submitted') return false;
    if (spawn.task_status === 'submitted' && (task.status !== 'submitted' || task.sha !== spawn.task_sha || task.revision !== spawn.task_revision)) return false;
    if (task.claim && spawn.role === 'worker') {
      if (task.claim.agent !== spawn.agent) {
        if (claimedSince || !T.leaseExpired(task, Date.now())) return false;
      } else {
        if (claimedSince && claimedSince !== task.claim.since) return false;
        claimedSince ||= task.claim.since;
      }
    } else if (claimedSince) return false;
    return !st.events.some((e) => e.task === task.id && ['release', 'rework'].includes(e.cmd) && Date.parse(e.at) >= Date.parse(latest.at));
  };
  const setPhase = (name, reason, extra = {}) => {
    S.mutate(ctx, 'spawn phase', (st, emit) => {
      if (!valid(st)) { retired = true; return; }
      st.rerender = true;
      emit(spawn.task, { ...detail(), phase: name, retry: attempt, reason: reason || null, ...extra });
    });
    phase = name;
  };
  const launch = (argv, initial = false) => {
    const start = (emit) => {
      exit = undefined;
      captureComplete = false;
      attemptOffset = fs.statSync(spawn.log).size;
      child = cp.spawn(argv[0], argv.slice(1), {
        cwd: spawn.cwd, env: { ...process.env, TOWER_CRANE_SESSION: spawn.session_id || spawn.agent, TOWER_CRANE_RETRY: String(attempt) },
        stdio: ['ignore', spawn.wait ? 'pipe' : 'inherit', spawn.wait ? 'pipe' : 'inherit'], detached: true, windowsHide: true,
      });
      const current = child;
      if (spawn.wait) {
        let captureError;
        const capture = (dest) => (data) => {
          if (!captureError) {
            try { fs.writeFileSync(3, data); } catch (e) {
              captureError = e;
              process.stderr.write(`tower-crane: usage log capture failed: ${e.message}; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
            }
          }
          dest.write(data);
        };
        child.stdout.on('data', capture(process.stdout));
        child.stderr.on('data', capture(process.stderr));
      }
      child.on('error', (e) => {
        if (child !== current) return;
        exit = { code: 1, signal: null, error: e.message };
        if (initial) S.writeAtomic(spawn.receipt, JSON.stringify({ error: e.message }));
      });
      const ended = (code, signal) => {
        if (child === current) exit = { ...exit, code: exit?.error ? 1 : code, signal };
      };
      child.on('exit', ended);
      child.on('close', (code, signal) => {
        ended(code, signal);
        if (child === current) captureComplete = true;
      });
      closed = new Promise((resolve) => child.once('close', resolve));
      if (!child.pid) return;
      childIdentity = P.identity(child.pid);
      if (initial) {
        S.writeAtomic(spawn.receipt, JSON.stringify(detail()));
      } else {
        emit(spawn.task, { ...detail(), retry: attempt, session_id: spawn.session_id });
        emit(spawn.task, { ...detail(), phase: 'running', retry: attempt, reason: null }, 'spawn phase');
        phase = 'running';
      }
      lastProgress = performance.now();
      stamp = pathProgress(spawn, config);
      cpu = P.cpuTicks(child.pid);
    };
    if (initial) start();
    else S.mutate(ctx, 'spawn retry', (st, emit) => {
      if (!valid(st)) { retired = true; return; }
      start(emit);
      st.rerender = true;
    });
  };
  launch(spawn.argv, true);
  if (!child.pid) return 1;
  // Startup runs while the dispatch CLI holds the state lock. Its spawn event
  // commits the job before supervision can renew or rerun it.
  const startupDeadline = performance.now() + 10000;
  async function tick() {
    if (!fs.existsSync(path.join(spawn.state, 'project.json'))) {
      retired = true;
      return;
    }
    const st = S.loadState(spawn.state);
    if (!committed) {
      initialDetail = st.events.find((e) => e.cmd === 'spawn' && e.task === spawn.task
        && e.detail.agent === spawn.agent && e.detail.monitor_pid === process.pid)?.detail;
      committed = !!initialDetail;
      if (!committed) {
        if (performance.now() >= startupDeadline) {
          child.kill('SIGKILL');
          retired = true;
        }
        return;
      }
    }
    const id = observedSession || sessionFromLog(!!exit && captureComplete);
    if (id) {
      observedSession = id;
      spawn.session_id = id;
      if (!sessionRecorded) {
        try {
          Sessions.record({ ...ctx, task: spawn.task }, initialDetail, id, 0);
          sessionRecorded = true;
        } catch (e) { if (e.code !== 3) throw e; }
      }
    }
    if (!valid(st)) {
      retired = true;
      return;
    }
    const task = T.getTask(st, spawn.task);
    if (task.claim?.agent === spawn.agent && (!exit || !captureComplete || nextRetry !== undefined)) {
      const grant = st.events.findLast((e) => e.task === task.id && e.agent === spawn.agent && ['claim', 'renew'].includes(e.cmd));
      const duration = grant ? Date.parse(grant.detail.until) - Date.parse(grant.at) : st.project.limits.lease_minutes * 60000;
      if (Date.parse(task.claim.until) - Date.now() <= duration / 2) {
        T.renew({ ...ctx, pos: [task.id], claimSince: claimedSince, flags: { lease: Math.max(1, Math.round(duration / 60000)) } });
      }
    }
    if (exit && !captureComplete) return;
    if (nextRetry !== undefined) {
      if (performance.now() >= nextRetry) {
        launch(resume(spawn, spawn.session_id));
        nextRetry = undefined;
      }
      return;
    }
    if (!exit) {
      const current = pathProgress(spawn, config);
      const ticks = P.cpuTicks(child.pid);
      const progress = st.events.findLast((e) => e.task === task.id && e.agent === spawn.agent
        && !['claim', 'renew', 'spawn phase', 'spawn retry', 'stall'].includes(e.cmd))?.id;
      const signature = `${current}|${progress || ''}`;
      if (signature !== stamp || ticks !== null && ticks !== cpu) {
        lastProgress = performance.now();
        stamp = signature;
        cpu = ticks;
        if (phase === 'blocked') setPhase('running');
      } else if (phase !== 'blocked' && performance.now() - lastProgress >= config.stall_ms && ticks !== null) {
        const reason = 'no progress paths or CPU activity';
        S.mutate(ctx, 'stall', (currentState, emit) => {
          if (!valid(currentState)) return;
          currentState.rerender = true;
          emit(spawn.task, { ...detail(), reason, source: JSON.stringify(['supervisor-stall', spawn.agent, child.pid, lastProgress]) });
          emit(spawn.task, { ...detail(), phase: 'blocked', retry: attempt, reason }, 'spawn phase');
        });
        phase = 'blocked';
      }
      return;
    }
    const text = tailSince(spawn.log, attemptOffset);
    const retryable = transient(exit.code, exit.signal, text);
    if (retryable && !spawn.session_id && spawn.harness === 'command') spawn.session_id = spawn.agent;
    if (retryable && attempt < config.retries && spawn.session_id && resume(spawn, spawn.session_id)) {
      attempt++;
      const delay = Math.min(config.max_backoff_ms, config.backoff_ms * 2 ** (attempt - 1));
      nextRetry = performance.now() + delay;
      setPhase('retrying', exit.signal || `exit ${exit.code}`, { backoff_ms: delay, session_id: spawn.session_id });
      return;
    }
    const reason = retryable ? (attempt >= config.retries ? `transient exit after ${attempt} retries`
      : `cannot resume ${spawn.harness} without a supported session`) : (exit.error || exit.signal || `exit ${exit.code}`);
    S.mutate(ctx, 'spawn exit', (currentState, emit) => {
      if (!valid(currentState)) { retired = true; return; }
      currentState.rerender = true;
      emit(spawn.task, { ...detail(), phase: exit.code === 0 ? 'waiting' : 'blocked',
        retry: attempt, reason: exit.code === 0 ? null : reason }, 'spawn phase');
      emit(spawn.task, { ...detail(), code: exit.code, signal: exit.signal, retry: attempt });
    });
    retired = true;
  }
  let failed = false;
  const stop = () => {
    retired = true;
    if (!exit) child.kill('SIGKILL');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise((resolve) => {
    timer = setInterval(async () => {
      try { await tick(); } catch (e) {
        if (e.code === 3) return;
        failed = true;
        retired = true;
        process.stderr.write(`tower-crane: supervisor failed: ${e.message}\n`);
      }
      if (retired) { clearInterval(timer); resolve(); }
    }, 100);
  });
  // A submit ends lease keeping and reruns. The process can still be writing
  // its final usage, so collection waits for stream closure.
  await closed;
  if (committed && !sessionRecorded && fs.existsSync(path.join(spawn.state, 'project.json'))) {
    const id = observedSession || sessionFromLog(true);
    if (id) Sessions.record({ ...ctx, task: spawn.task }, initialDetail, id);
  }
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  if (committed && fs.existsSync(path.join(spawn.state, 'project.json'))) {
    S.mutate(ctx, 'spawn exit', (st, emit) => {
      if (!st.events.some((e) => e.task === spawn.task && e.cmd === 'spawn exit'
        && e.detail.agent === spawn.agent && e.detail.pid === child.pid)) {
        emit(spawn.task, { ...detail(), code: exit?.code ?? null, signal: exit?.signal || null, retry: attempt });
      }
    });
  }
  if (committed && !spawn.wait) collect({ ...spawn, ...detail(), host: spawn.host || detail().host });
  return failed ? 1 : exit?.code ?? 1;
}

if (require.main === module) {
  const input = process.argv[2];
  const spawn = JSON.parse(input.startsWith('{') ? input : fs.readFileSync(input, 'utf8'));
  if (spawn.argv) {
    supervise(spawn).then((code) => { process.exitCode = code; }).catch((e) => {
      process.stderr.write(`tower-crane: supervisor failed: ${e.message}\n`);
      process.exitCode = 1;
    });
  } else collect(spawn);
}

module.exports = { running, record, transient, resume };
