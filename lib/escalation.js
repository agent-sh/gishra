'use strict';

const S = require('./state');
const L = require('./ladder');
const T = require('./tasks');
const P = require('./processes');
const Sessions = require('./spawn-session');
const { nowIso, shaMatch, refuse } = require('./util');

function spendByRung(task) {
  const result = {};
  for (const entry of task.spend.entries || []) {
    if (!entry.rung) continue;
    const total = result[entry.rung] ||= { tokens: 0, cost_usd: 0 };
    total.tokens = total.tokens === null || entry.tokens === null ? null : total.tokens + entry.tokens;
    total.cost_usd = total.cost_usd === null || entry.cost_usd == null ? null : total.cost_usd + entry.cost_usd;
  }
  return result;
}

function verifiedExit(ctx, st, worker) {
  const after = st.events.slice(st.events.indexOf(worker) + 1);
  const latest = after.findLast((e) => e.task === worker.task && ['spawn retry', 'spawn fallback'].includes(e.cmd)
    && e.detail.agent === worker.detail.agent && e.detail.attempt === worker.detail.attempt) || worker;
  if (after.some((e) => e.task === worker.task && ['spawn exit', 'worker-exited'].includes(e.cmd)
    && P.exitSpawn(e, st.events) === latest)) return true;
  // A sandbox's hidden pid is not proof that a peer worker stopped.
  const canProbe = worker.detail.monitor_pid === process.pid || require('./events').canObserve(ctx, st.events, worker);
  return canProbe && Sessions.exitedAttempt(worker, st.events);
}

function failure(st, task, worker) {
  if (task.status === 'submitted') {
    const review = st.events.findLast((e) => e.task === task.id && e.cmd === 'evidence'
      && e.detail.type === 'review' && !e.detail.ok && shaMatch(e.detail.sha, task.sha)
      && e.agent !== task.submitted_by);
    const submission = st.events.findLast((e) => e.task === task.id && e.cmd === 'submit');
    if (!review || st.events.indexOf(review) < st.events.indexOf(submission)) return null;
    const entry = task.evidence.findLast((e) => e.type === 'review' && !e.ok
      && e.revision === task.revision && e.agent === review.agent && shaMatch(e.sha, task.sha));
    return entry ? { trigger: 'review', reason: `failed review: ${entry.summary || 'no summary'}`, source: review.id } : null;
  }
  if (!worker || !['todo', 'in_progress', 'rework'].includes(task.status)) return null;
  if (task.claim && task.claim.agent !== worker.detail.agent) return null;
  const after = st.events.slice(st.events.indexOf(worker) + 1);
  // A deliberate release or lifecycle change ends the dispatch's authority.
  if (after.some((e) => e.task === task.id && ['release', 'rework', 'submit'].includes(e.cmd))) return null;
  const exit = after.findLast((e) => e.task === task.id && ['spawn exit', 'worker-exited'].includes(e.cmd)
    && e.detail.agent === worker.detail.agent);
  if (!exit || after.some((e) => e.task === task.id && e.cmd === 'spawn exit'
    && e.detail.agent === worker.detail.agent && e.detail.availability_failure)) return null;
  const stall = after.findLast((e) => e.task === task.id && e.cmd === 'stall' && e.detail.agent === worker.detail.agent);
  return {
    trigger: stall ? 'stall' : 'exit',
    reason: stall ? `stall: ${stall.detail.reason || 'no progress'}` : `worker exit without submit (code ${exit.detail.code ?? 'unknown'})`,
    source: worker.id,
  };
}

async function recover(ctx) {
  const result = S.mutate(ctx, 'recover', (st, emit) => {
    const task = T.getTask(st, ctx.pos[0]);
    if (!task.tier_range || ['accepted', 'cancelled'].includes(task.status)) return { id: task.id };
    const worker = st.events.findLast((e) => e.task === task.id && e.cmd === 'spawn' && e.detail.role === 'worker');
    if (worker && (!verifiedExit(ctx, st, worker) || P.supervised(st, task))) return { id: task.id };
    const failed = failure(st, task, worker);
    if (failed && !(task.escalations || []).some((e) => e.source === failed.source)) {
      if (worker) T.collectSpawn(st, emit, worker);
      const from = task.tier;
      const to = from === task.tier_range.max ? null : L.TIERS[L.TIERS.indexOf(from) + 1];
      const record = { at: nowIso(), agent: ctx.agent, from, to, ...failed, spend_by_rung: spendByRung(task) };
      task.escalations ||= [];
      task.escalations.push(record);
      task.status = 'rework';
      task.claim = null;
      task.notes.push({ at: record.at, agent: ctx.agent, text: `escalation ${from} -> ${to || 'owner'}: ${failed.reason}` });
      emit(task.id, { reason: failed.reason, sha: task.sha }, 'rework');
      if (to) {
        task.tier = to;
        task.escalation_pending = true;
      } else {
        task.escalation_pending = false;
        const decision = require('./decisions').create(st, emit, ctx.agent, {
          question: `${task.id} exhausted ${task.tier_range.min}..${task.tier_range.max} at ${from}: ${failed.reason}. Choose the next approach.`,
          blocks: [task.id],
          why: 'The planned quality escalation range is exhausted.',
        });
        record.decision = decision.id;
      }
      emit(task.id, record, 'escalate');
    }
    return { id: task.id, pending: task.escalation_pending === true };
  });
  if (result.pending && ctx.env.TOWER_CRANE_VIA === 'broker') {
    return { data: result, text: `${result.id}: climb pending for the host observer` };
  }
  if (result.pending) {
    try {
      const started = await require('./spawn').spawn({ ...ctx, pos: [], flags: { task: result.id }, escalationOnly: true });
      return { data: started.data, text: `${result.id}: re-dispatched at ${started.data.rung}` };
    } catch (error) {
      // Keep the pending climb so configuration or capacity recovery can retry it.
      if (![1, 2, 3, 'EACCES', 'EPERM'].includes(error.code)) throw error;
      return { data: { ...result, error: error.message }, text: `${result.id}: climb pending: ${error.message}` };
    }
  }
  return { data: result, text: `${result.id}: no pending climb` };
}

function guard(ctx, st, task) {
  if (!task.tier_range) return;
  if (ctx.escalationOnly && !task.escalation_pending) throw refuse(`${task.id}: climb already dispatched`);
  const reasons = T.blockReasons(st, task);
  if (reasons.length) throw refuse(`${task.id} is blocked: ${reasons.join('; ')}`);
  if (!['todo', 'rework', 'in_progress'].includes(task.status)) throw refuse(`${task.id}: worker dispatch needs todo or rework`);
  const last = st.events.findLast((e) => e.task === task.id && e.cmd === 'spawn' && e.detail.role === 'worker');
  if (last && (!verifiedExit(ctx, st, last) || P.supervised(st, task))) throw refuse(`${task.id}: previous worker is still running or its exit is unverified`);
}

module.exports = { recover, guard, spendByRung };
