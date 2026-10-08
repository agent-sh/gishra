'use strict';

const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const Sessions = require('./spawn-session');
const C = require('./gates/common');
const { refuse, usage, readStdin } = require('./util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function sourceOf(event) {
  const { at, cmd, agent, task, detail } = event;
  return event.id || `legacy:${createHash('sha256').update(JSON.stringify({ at, cmd, agent, task, detail })).digest('hex')}`;
}

function trusted(ctx) {
  return !!require('./authority').actor(ctx, S.readEvents(ctx.stateDir));
}

function reactionContext(ctx) {
  const env = { ...ctx.env, TOWER_CRANE_AGENT: 'orchestrator', TOWER_CRANE_VIA: 'automation' };
  delete env.TOWER_CRANE_BROKER;
  return { ...ctx, agent: 'orchestrator', agentExplicit: true, env, flags: {} };
}

function current(ctx, id) {
  const st = S.loadState(ctx.stateDir);
  return { st, task: T.getTask(st, id) };
}

function merged(st, task) {
  return require('./stack').merged(st, task);
}

function eligible(st, event) {
  if (!['submit', 'accept', 'ci completed', 'spawn exit', 'worker-exited', 'check ci', 'merge', 'automation reconcile'].includes(event.cmd)
    && !(event.cmd === 'evidence' && event.detail.type === 'review')) return false;
  const task = st.tasks.tasks.find((t) => t.id === event.task);
  if (!task || !['submitted', 'accepted'].includes(task.status)) return false;
  if (event.detail?.sha && !C.sameSha(event.detail.sha, task.sha)) return false;
  if (event.detail?.revision && event.detail.revision !== task.revision) return false;
  if (event.cmd === 'merge') return event.detail.ok === true;
  if (merged(st, task)) return false;
  return ['submit', 'accept', 'ci completed', 'spawn exit', 'worker-exited', 'automation reconcile'].includes(event.cmd)
    || event.cmd === 'check ci' || event.cmd === 'evidence' && event.detail.type === 'review';
}

const EXECUTORS = 2;

function live(detail) {
  return detail?.phase === 'running' && P.processState(detail) !== 'exited';
}

// Each reaction's running receipt is its executor lease: a done receipt
// releases it on exit and the PID identity releases it on death. Only this
// host's executors count against the cap, since the cap protects its cores.
function executors(st) {
  const last = new Map();
  for (const e of st.events) if (e.cmd === 'automation') last.set(e.task, e.detail);
  return [...last.values()].filter((d) => live(d) && (!d.host || d.host === os.hostname())).length;
}

// Queued notifications still owed a run, in submission order. A task with a
// live executor drains its own notifications, so it holds no one back.
function waiting(st) {
  const queued = new Set(st.events.filter((e) => e.cmd === 'automation queued').map((e) => e.detail.source));
  if (!queued.size) return [];
  const receipts = new Map();
  const busy = new Set();
  for (const e of st.events) {
    if (e.cmd !== 'automation') continue;
    receipts.set(e.detail.source, e.detail);
    if (live(e.detail)) busy.add(e.task);
    else busy.delete(e.task);
  }
  return st.events.filter((e) => {
    const source = sourceOf(e);
    const receipt = receipts.get(source);
    return queued.has(source) && !busy.has(e.task) && (!receipt || receipt.phase === 'running') && eligible(st, e);
  });
}

// One task reaction runs at a time, outside the state lock, and at most
// gates.executors reactions run on this host. A dead executor leaves a
// retryable start receipt; another host's unobservable PID stays busy.
// Returns 'behind' when a slot is free but older queued work owns it.
function reserve(ctx, event) {
  const source = sourceOf(event);
  return S.mutate(ctx, 'automation', (st, emit) => {
    if (!eligible(st, event)) return false;
    const own = st.events.findLast((e) => e.cmd === 'automation' && e.detail.source === source);
    if (own?.detail.phase === 'done') return false;
    const queue = (detail) => {
      if (!st.events.some((e) => e.cmd === 'automation queued' && e.detail.source === source)) {
        emit(event.task, { source, ...detail }, 'automation queued');
      }
      return false;
    };
    const last = st.events.findLast((e) => e.cmd === 'automation' && e.task === event.task);
    if (live(last?.detail)) return queue({});
    const cap = st.project.gates?.executors ?? EXECUTORS;
    if (executors(st) >= cap) return queue({ executors: cap });
    // The caller's event object comes from an earlier read, so locate both
    // events in this reload by their stable source.
    const position = (s) => {
      const i = st.events.findIndex((e) => sourceOf(e) === s);
      return i < 0 ? Infinity : i;
    };
    const first = waiting(st)[0];
    if (first && sourceOf(first) !== source && position(sourceOf(first)) < position(source)) {
      queue({ executors: cap });
      return 'behind';
    }
    emit(event.task, { source, phase: 'running', pid: process.pid, ...P.identity(process.pid) });
    return true;
  });
}

async function software(ctx, includeCI = true) {
  let { st, task } = current(ctx, ctx.pos[0]);
  const snapshot = { sha: task.sha, revision: task.revision };
  for (const type of T.requiredGates(task).filter((g) => g !== 'review' && (includeCI || g !== 'ci'))) {
    if (task.status !== 'submitted' || task.sha !== snapshot.sha || task.revision !== snapshot.revision) return;
    // Failed gates wait for an explicit retry. A CI completion is such a retry.
    const attempted = task.evidence.some((e) => e.type === type && e.revision === task.revision && C.sameSha(e.sha, task.sha));
    if (!attempted) await require('./check').runGate({ ...ctx, flags: {} }, type);
    ({ st, task } = current(ctx, task.id));
    if (!T.gateReport(task, st.events, st).gates.find((g) => g.type === type)?.ok) return;
  }
}

async function pr(ctx, st, task) {
  if (!task.pr || !st.project.repo) return null;
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const result = await C.gh({ root: repo?.root }, ['pr', 'view', String(task.pr), '-R', st.project.repo,
    '--json', 'state,headRefOid,mergeable,mergeStateStatus']);
  if (!result.ok) throw refuse(C.ghFailure(result, `inspect PR #${task.pr}`));
  try { return JSON.parse(result.stdout); }
  catch { throw refuse(`cannot read PR #${task.pr} mergeability`); }
}

async function conflicts(ctx, task, fetch) {
  const { st } = current(ctx, task.id);
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) throw refuse(`${task.id}: no repository for conflict detection`);
  const base = require('./stack').targetBase(st, task).replace(/^origin\//, '');
  const gc = { root: repo.root };
  const remote = await C.git(gc, repo.root, ['remote', 'get-url', 'origin']);
  let ref = base;
  if (remote.ok) {
    ref = `refs/remotes/origin/${base}`;
    if (fetch) {
      const result = await C.git(gc, repo.root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin',
        `+refs/heads/${base}:${ref}`], { timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      if (!result.ok) throw refuse(`cannot fetch ${base} for conflict detection: ${C.errText(result)}`);
    }
  }
  const tip = await C.resolveCommit(gc, repo.root, ref);
  if (!tip) throw refuse(`cannot resolve ${base} for conflict detection`);
  const result = await C.withWorktree(gc, repo.root, task.sha, async (dir) => {
    const trial = await C.git(gc, dir, ['merge', '--no-commit', '--no-ff', tip],
      { timeout: 60000, env: { ...process.env, GIT_MERGE_AUTOEDIT: 'no' } });
    if (trial.ok) return { files: [] };
    const diff = await C.git(gc, dir, ['diff', '--name-only', '--diff-filter=U', '-z']);
    if (!diff.ok) throw refuse(`cannot list ${task.id} conflicting files: ${C.errText(diff)}`);
    const files = diff.stdout.split('\0').filter(Boolean);
    if (!files.length) throw refuse(`${task.id}: trial merge failed without conflicting files: ${C.errText(trial)}`);
    return { files };
  });
  if (!result.files) throw refuse(result.summary);
  if (!result.files.length) return false;
  T.rework({ ...ctx, pos: [task.id], expected: { sha: task.sha, revision: task.revision, base: require('./stack').targetBase(st, task) },
    flags: { reason: `PR #${task.pr} conflicts with ${base}: ${result.files.join(', ')}. Merge the base, resolve these files and submit a new head.` } });
  return true;
}

async function advance(ctx, inspect = true) {
  let { st, task } = current(ctx, ctx.pos[0]);
  let mergeable = true;
  if (!['submitted', 'accepted'].includes(task.status) || merged(st, task)) return 'done';
  if (inspect && task.pr) {
    const remote = await pr(ctx, st, task);
    // A remote merge can precede its local receipt if the executor died.
    // The merge gate confirms the accepted head without issuing another merge.
    if (remote?.state !== 'MERGED' || task.status !== 'accepted') {
      if (!remote || remote.state !== 'OPEN') return 'deferred';
      if (!C.sameSha(remote.headRefOid, task.sha)) return 'deferred';
      if (remote.mergeable === 'CONFLICTING' || remote.mergeStateStatus === 'DIRTY') {
        return await conflicts(ctx, task, true) ? 'done' : 'deferred';
      }
      mergeable = remote.mergeable === 'MERGEABLE' && !!remote.mergeStateStatus && remote.mergeStateStatus !== 'UNKNOWN';
    }
  }
  if (task.status === 'submitted') {
    // Tests, cleanup and source verification need the matched head. CI and
    // model dispatch still require GitHub's mergeability result.
    await software(ctx, mergeable);
    ({ st, task } = current(ctx, task.id));
    if (!mergeable) return 'deferred';
    if (task.status !== 'submitted' || !require('./reviewer').softwareReport(st, task).ok) return 'done';
    const report = T.gateReport(task, st.events, st);
    // Native workers without an exit receipt use explicit accept for review
    // dispatch. A tracked worker must have exited before a model reads its diff.
    const worker = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id
      && e.detail.role === 'worker' && e.detail.agent === task.submitted_by);
    if (!report.ok && (!worker || !Sessions.exitedAttempt(worker, st.events))) return 'done';
    await T.accept({ ...ctx, flags: {} });
    ({ st, task } = current(ctx, task.id));
  }
  if (!mergeable) return 'deferred';
  if (task.status === 'accepted' && task.pr && T.gateReport(task, st.events, st).ok && !merged(st, task)) {
    const result = await require('./check').runGate({ ...ctx, flags: {} }, 'merge');
    if (result.data.ok) await sweep(ctx);
    else return 'deferred';
  }
  return 'done';
}

async function sweep(ctx) {
  const st = S.loadState(ctx.stateDir);
  for (const task of st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status) && !merged(st, t))) {
    try {
      const remote = await pr(ctx, st, task);
      if (!remote || remote.state !== 'OPEN' || !C.sameSha(remote.headRefOid, task.sha)) continue;
      await conflicts(ctx, task, true);
    } catch (e) {
      T.taskNote({ ...ctx, pos: [task.id, `automation conflict check: ${e.message}`] });
    }
  }
}

async function consume(ctx, events, supervisor = false) {
  if (!supervisor && !trusted(ctx)) return [];
  const pending = [];
  const engine = reactionContext(ctx);
  let snapshot = S.loadState(ctx.stateDir);
  const seen = new Set();
  for (const event of events) {
    const source = sourceOf(event);
    if (seen.has(source)) continue;
    seen.add(source);
    if (!eligible(snapshot, event)) continue;
    const reserved = reserve(engine, event);
    // Older queued work takes the free slot first; this event is queued
    // behind it, so the drain reaches it in submission order.
    if (reserved === 'behind') await consume(engine, waiting(S.loadState(ctx.stateDir)), true);
    if (reserved !== true) {
      const last = S.readEvents(ctx.stateDir).findLast((e) => e.cmd === 'automation' && e.detail.source === sourceOf(event));
      if (last?.detail.phase !== 'done') pending.push(event);
      continue;
    }
    let error = null;
    let phase = 'done';
    try {
      const action = { ...engine, pos: [event.task] };
      if (event.cmd === 'merge') await sweep(action);
      else {
        if (event.cmd === 'ci completed') await require('./check').runGate(action, 'ci');
        phase = await advance(action);
      }
    } catch (e) {
      error = e.message;
      phase = 'error';
      process.stderr.write(`tower-crane: automation ${event.task}: ${error}\n`);
    } finally {
      S.mutate(engine, 'automation', (st, emit) => {
        emit(event.task, { source, phase, error });
      });
    }
    // A reviewer can finish while its dispatch reaction still owns this task,
    // and other tasks may wait for this executor slot. Drain them in
    // submission order after releasing it, even without a live waiter.
    const queued = waiting(S.loadState(ctx.stateDir));
    if (queued.length) await consume(engine, queued, true);
    snapshot = S.loadState(ctx.stateDir);
  }
  return pending;
}

async function ciCompleted(ctx) {
  if (!trusted(ctx)) throw refuse('ci completed is an orchestrator or owner command');
  if (!/^[a-f\d]{7,64}$/i.test(ctx.flags.sha || '')) throw usage('ci completed needs --sha with the completed commit');
  S.mutate(ctx, 'ci completed', (st, emit) => {
    const task = T.getTask(st, ctx.pos[0]);
    if (!['submitted', 'accepted'].includes(task.status) || !C.sameSha(task.sha, ctx.flags.sha)) {
      throw refuse(`${task.id}: CI completion does not match an active submitted head`);
    }
    emit(task.id, { sha: task.sha, revision: task.revision });
  });
  // emit's event ID is assigned by mutate when it appends the audit record.
  const latest = S.readEvents(ctx.stateDir).findLast((e) => e.cmd === 'ci completed' && e.task === ctx.pos[0]);
  await consume(ctx, [latest]);
  const { st, task } = current(ctx, ctx.pos[0]);
  return { data: T.describeTask(st, task, Date.now()), text: `${task.id}: CI completion handled at ${task.sha.slice(0, 7)}` };
}

async function ciWebhook(ctx) {
  if (!trusted(ctx)) throw refuse('ci webhook is an orchestrator or owner command');
  let payload;
  try {
    const raw = ctx.pos[0] === '-' ? readStdin() : fs.readFileSync(path.resolve(ctx.cwd, ctx.pos[0]), 'utf8');
    payload = JSON.parse(raw);
  } catch (e) { throw usage(`cannot read CI webhook JSON: ${e.message}`); }
  const st = S.loadState(ctx.stateDir);
  if (payload.repository?.full_name !== st.project.repo) throw refuse('webhook repository differs from project repo');
  const check = payload.check_run || payload.check_suite || payload.workflow_run;
  if (!check || typeof check.head_sha !== 'string') throw usage('expected a check_run, check_suite or workflow_run webhook');
  if (payload.action !== 'completed' || check.status !== 'completed') {
    return { data: { ignored: true }, text: 'CI notification ignored: check is not completed' };
  }
  const tasks = st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status)
    && C.sameSha(t.sha, check.head_sha) && !merged(st, t));
  const handled = [];
  for (const task of tasks) {
    await ciCompleted({ ...ctx, pos: [task.id], flags: { sha: check.head_sha } });
    handled.push(task.id);
  }
  return { data: { tasks: handled }, text: `CI completion handled for ${handled.join(', ') || 'no active submitted heads'}` };
}

function backlog(ctx) {
  if (!trusted(ctx)) return [];
  const active = (st) => st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status) && !merged(st, t));
  if (!active(S.loadState(ctx.stateDir)).length) return [];
  const startup = randomUUID();
  // GitHub can change while no watcher runs. A fresh request bypasses old
  // event receipts while keeping the same task reservation and gate evidence.
  try {
    S.mutate(reactionContext(ctx), 'automation reconcile', (st, emit) => {
      for (const task of active(st)) emit(task.id, { sha: task.sha, revision: task.revision, startup });
    }, 0);
  } catch (e) {
    if (e.code === 3) return null;
    throw e;
  }
  return S.readEvents(ctx.stateDir).filter((e) => e.cmd === 'automation reconcile' && e.detail.startup === startup);
}

module.exports = { consume, ciCompleted, ciWebhook, backlog };
