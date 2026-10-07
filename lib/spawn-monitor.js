'use strict';

const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { performance } = require('node:perf_hooks');
const P = require('./processes');
const S = require('./state');
const T = require('./tasks');
const L = require('./ladder');
const Sessions = require('./spawn-session');
const RETRY_MS = 10 * 60 * 1000;
const SAMPLE_MS = 1000;
const TERM_GRACE_MS = 5000;

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

function transient(code, signal, providerError) {
  if (code === 75 || ['SIGTERM', 'SIGINT'].includes(signal)) return true;
  if (code === 0) return false;
  return providerError;
}

function providerFailure(text) {
  return /\b(?:HTTP(?:Error)?|status(?:[_ ]code)?|api_error_status|API(?: error)?|error)\s*["':= ]*\s*5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)\b|\b(?:service unavailable|provider outage|overloaded_error|internal_server_error|server overloaded)\b/i.test(text);
}

// Only harness error envelopes and stderr are evidence of an outage. Tool
// output and assistant messages may quote the same errors while doing work.
function errorReader(harness, stderr) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let oversized = false;
  let failed = false;
  function line(text) {
    let value;
    try { value = JSON.parse(text); } catch {
      if (stderr) failed ||= providerFailure(text);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (['codex', 'command'].includes(harness) && ['error', 'turn.failed'].includes(value.type)) {
      failed ||= providerFailure(JSON.stringify(value.error || value.message || ''));
    } else if (['claude', 'command'].includes(harness)
      && (value.is_error === true || value.type === 'error' || value.api_error_status !== undefined)) {
      failed ||= providerFailure(JSON.stringify({
        api_error_status: value.api_error_status, error: value.error, errors: value.errors,
        result: value.is_error ? value.result : undefined, message: value.message,
      }));
    } else if (stderr && value.type === undefined) {
      failed ||= providerFailure(text);
    }
  }
  return (chunk, final = false) => {
    const text = chunk ? decoder.write(chunk) : final ? decoder.end() : '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      pending += lines[i];
      // Bound memory when agent output contains a huge JSON record, and
      // discard its whole line so a truncated quote cannot become an error.
      if (pending.length > 65536) { oversized = true; pending = ''; }
      if (i < lines.length - 1 || final) {
        if (!oversized) line(pending);
        pending = '';
        oversized = false;
      }
    }
    return failed;
  };
}

function resume(spawn, id, reason) {
  const warm = Sessions.resumable(spawn.harness);
  if ((!warm && spawn.harness !== 'claude') || (warm && !id)) return null;
  const rung = { ...spawn.rung_config, args: [...(spawn.rung_config.args || [])] };
  const note = `Previous attempt exited with ${reason}; continue.`;
  const prompt = warm ? note : `${spawn.prompt}\n\n${note}`;
  if (spawn.harness === 'claude') {
    for (let i = 0; i < rung.args.length;) {
      if (['--resume', '--session-id'].includes(rung.args[i])) rung.args.splice(i, 2);
      else if (rung.args[i] === '--fork-session' || /^--(?:resume|session-id)=/.test(rung.args[i])) rung.args.splice(i, 1);
      else i++;
    }
    rung.args.push('--session-id', crypto.randomUUID());
  }
  return require('./spawn').buildCommand(spawn.role, rung, prompt, { ...spawn.subs, prompt }, process.env, spawn.owned_flags || [], warm ? id : null);
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
  let providerError = false;
  let stoppedBy;
  let groupComplete = true;
  let cleanupGroup;
  let committed = false;
  let retired = false;
  let timer;
  let retryTimer;
  let watcher;
  let wake = () => {};
  let stateStamp;
  let state;
  let nextSample = 0;
  let initialDetail;
  let sessionRecorded = false;
  let readSession = Sessions.logReader(spawn.log, spawn.harness);
  let observedSession = spawn.session_id;
  const sessionFromLog = (final) => {
    try { return readSession(final); } catch { return null; }
  };
  const monitor = { monitor_pid: process.pid, monitor_start_ticks: P.identity(process.pid).start_ticks };
  const detail = () => ({
    role: spawn.role, rung: spawn.rung, harness: spawn.harness, agent: spawn.agent, cwd: spawn.cwd,
    pid: child?.pid, ...childIdentity, log: spawn.log, ...monitor,
    active: !exit || !captureComplete || !groupComplete || nextRetry !== undefined,
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
  const groupAlive = (pid) => {
    try { process.kill(-pid, 0); } catch (e) {
      if (e.code === 'ESRCH') return false;
      throw e;
    }
    if (process.platform !== 'linux') return true;
    // Orphan zombies cannot execute or hold a pipe open. A live descendant
    // with redirected stdio still has to exit before another attempt starts.
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0])) return true;
      } catch (e) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(e.code)) throw e; }
    }
    return false;
  };
  const terminateGroup = (current) => {
    if (cleanupGroup) return;
    groupComplete = false;
    const signal = (name) => {
      if (process.platform === 'win32') {
        cp.spawnSync('taskkill', ['/PID', String(current.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
      } else {
        try { process.kill(-current.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
    };
    // Windows cannot address descendants by process group after the parent
    // exits. Its released pid may already identify another CLI invocation.
    if (process.platform !== 'win32' || !exit) signal('SIGTERM');
    cleanupGroup = (async () => {
      const deadline = performance.now() + TERM_GRACE_MS;
      while (process.platform !== 'win32' && groupAlive(current.pid)) {
        if (performance.now() >= deadline) {
          signal('SIGKILL');
          const killDeadline = performance.now() + 2000;
          while (groupAlive(current.pid)) {
            if (performance.now() >= killDeadline) throw new Error(`process group ${current.pid} did not stop after SIGKILL`);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      groupComplete = true;
      wake();
    })();
    cleanupGroup.catch((e) => {
      retired = true;
      process.stderr.write(`tower-crane: supervisor failed: ${e.message}\n`);
      wake();
    });
  };
  const launch = (argv, initial = false) => {
    const start = (emit) => {
      exit = undefined;
      captureComplete = false;
      groupComplete = false;
      cleanupGroup = undefined;
      providerError = false;
      attemptOffset = fs.statSync(spawn.log).size;
      if (!initial && spawn.harness === 'claude') {
        spawn.session_id = argv[argv.indexOf('--session-id') + 1];
        observedSession = spawn.session_id;
        readSession = Sessions.logReader(spawn.log, spawn.harness, attemptOffset);
      }
      const stdoutError = errorReader(spawn.harness, false);
      const stderrError = errorReader(spawn.harness, true);
      child = cp.spawn(argv[0], argv.slice(1), {
        cwd: spawn.cwd, env: { ...process.env, TOWER_CRANE_SESSION: spawn.session_id || spawn.agent, TOWER_CRANE_RETRY: String(attempt) },
        stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true,
      });
      const current = child;
      let captureError;
      const capture = (dest, readError) => (data) => {
        providerError = readError(data) || providerError;
        if (!captureError) {
          try { fs.writeFileSync(3, data); } catch (e) {
            captureError = e;
            process.stderr.write(`tower-crane: usage log capture failed: ${e.message}; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
          }
        }
        if (spawn.wait) dest.write(data);
      };
      child.stdout.on('data', capture(process.stdout, stdoutError));
      child.stderr.on('data', capture(process.stderr, stderrError));
      child.on('error', (e) => {
        if (child !== current) return;
        exit = { code: 1, signal: null, error: e.message };
        if (initial) S.writeAtomic(spawn.receipt, JSON.stringify({ error: e.message }));
      });
      const ended = (code, signal) => {
        if (child === current) {
          exit = { ...exit, code: exit?.error ? 1 : code, signal };
          if (current.pid) terminateGroup(current);
          else groupComplete = true;
          wake();
        }
      };
      child.on('exit', ended);
      child.on('close', (code, signal) => {
        ended(code, signal);
        if (child === current) {
          providerError = stdoutError(null, true) || stderrError(null, true) || providerError;
          captureComplete = true;
          wake();
        }
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
      nextSample = performance.now() + SAMPLE_MS;
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
    const eventStat = fs.statSync(path.join(spawn.state, 'events.jsonl'));
    const signature = `${eventStat.ino}:${eventStat.size}:${eventStat.mtimeMs}`;
    if (!state || signature !== stateStamp) {
      state = S.loadState(spawn.state);
      stateStamp = signature;
    }
    const st = state;
    if (!committed) {
      initialDetail = st.events.find((e) => e.cmd === 'spawn' && e.task === spawn.task
        && e.detail.agent === spawn.agent && e.detail.monitor_pid === process.pid)?.detail;
      committed = !!initialDetail;
      if (!committed) {
        if (performance.now() >= startupDeadline) {
          terminateGroup(child);
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
    if (task.claim?.agent === spawn.agent && (!exit || !captureComplete || !groupComplete || nextRetry !== undefined)) {
      const grant = st.events.findLast((e) => e.task === task.id && e.agent === spawn.agent && ['claim', 'renew'].includes(e.cmd));
      const duration = grant ? Date.parse(grant.detail.until) - Date.parse(grant.at) : st.project.limits.lease_minutes * 60000;
      if (Date.parse(task.claim.until) - Date.now() <= duration / 2) {
        T.renew({ ...ctx, pos: [task.id], claimSince: claimedSince, flags: { lease: Math.max(1, Math.round(duration / 60000)) } });
      }
    }
    if (exit && (!captureComplete || !groupComplete)) return;
    if (nextRetry !== undefined) {
      if (performance.now() >= nextRetry) {
        launch(resume(spawn, spawn.session_id, exit.signal || `exit ${exit.code}`));
        nextRetry = undefined;
      }
      return;
    }
    if (!exit) {
      if (performance.now() < nextSample) return;
      nextSample = performance.now() + SAMPLE_MS;
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
    const retryable = transient(exit.code, exit.signal, providerError);
    if (retryable && !spawn.session_id && spawn.harness === 'command') spawn.session_id = spawn.agent;
    if (retryable && attempt < config.retries && resume(spawn, spawn.session_id, exit.signal || `exit ${exit.code}`)) {
      attempt++;
      const delay = Math.min(config.max_backoff_ms, config.backoff_ms * 2 ** (attempt - 1));
      nextRetry = performance.now() + delay;
      setPhase('retrying', exit.signal || `exit ${exit.code}`, { backoff_ms: delay, session_id: spawn.session_id });
      retryTimer = setTimeout(() => wake(), Math.min(delay, 2147483647));
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
  const stop = (signal) => {
    stoppedBy = signal;
    retired = true;
    nextRetry = undefined;
    terminateGroup(child);
    wake();
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  await new Promise((resolve) => {
    let queued = false;
    wake = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(async () => {
        try { if (!retired) await tick(); } catch (e) {
          if (e.code !== 3) {
            failed = true;
            retired = true;
            terminateGroup(child);
            process.stderr.write(`tower-crane: supervisor failed: ${e.message}\n`);
          }
        } finally {
          queued = false;
          if (retired) {
            clearInterval(timer);
            clearTimeout(retryTimer);
            watcher?.close();
            resolve();
          }
        }
      });
    };
    timer = setInterval(wake, SAMPLE_MS);
    try { watcher = fs.watch(spawn.state, (_, file) => { if (!file || String(file) === 'events.jsonl') wake(); }); } catch {
      // The seconds-scale sampler also observes state when watching is unavailable.
    }
    watcher?.on('error', () => watcher.close());
    wake();
  });
  // A submit ends lease keeping and reruns. The process can still be writing
  // its final usage, so collection waits for stream closure.
  await closed;
  await cleanupGroup;
  if (committed && !sessionRecorded && fs.existsSync(path.join(spawn.state, 'project.json'))) {
    const id = observedSession || sessionFromLog(true);
    if (id) Sessions.record({ ...ctx, task: spawn.task }, initialDetail, id);
  }
  process.removeListener('SIGTERM', onTerm);
  process.removeListener('SIGINT', onInt);
  if (committed && fs.existsSync(path.join(spawn.state, 'project.json'))) {
    S.mutate(ctx, 'spawn exit', (st, emit) => {
      if ((stoppedBy || failed) && valid(st)) {
        st.rerender = true;
        emit(spawn.task, { ...detail(), phase: 'blocked', retry: attempt,
          reason: stoppedBy ? `supervisor stopped by ${stoppedBy}` : 'supervisor failed' }, 'spawn phase');
      }
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
