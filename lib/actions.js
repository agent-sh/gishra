'use strict';

const S = require('./state');
const T = require('./tasks');
const I = require('./inbox');
const { usage } = require('./util');

async function batch(ids, action, limit = Infinity) {
  const results = [];
  let completed = 0;
  for (const id of ids) {
    if (completed >= limit) break;
    try {
      const result = await action(id);
      results.push({ task: id, ok: !result.code, ...result });
      if (!result.code) completed += 1;
    } catch (e) { results.push({ task: id, ok: false, error: e.message }); }
  }
  return { data: { results }, text: results.map((r) => `${r.task}: ${r.error || r.text || 'done'}`).join('\n') || 'nothing to do',
    code: results.some((r) => !r.ok) ? 1 : 0 };
}

async function spawn(ctx) {
  if (!ctx.flags.ready) return require('./spawn').spawn(ctx);
  if (ctx.flags.task || ctx.flags.role || ctx.flags.wait) throw usage('spawn --ready cannot combine with --task, --role or --wait');
  const st = S.loadState(ctx.stateDir);
  I.authorized(ctx, st);
  const slots = Math.max(0, st.project.limits.workers - T.workerHolders(st, Date.now()).length);
  const ids = I.dispatchable(st).map((t) => t.id);
  return batch(ids, (id) => require('./spawn').spawn({ ...ctx, readyBatch: true,
    flags: { task: id, 'dry-run': !!ctx.flags['dry-run'] } }), slots);
}

async function merge(ctx) {
  if (!ctx.flags.accepted) {
    if (!ctx.pos.length) throw usage('merge needs ID or --accepted');
    return require('./automation').merge(ctx);
  }
  if (ctx.pos.length || Object.keys(ctx.flags).some((k) => k !== 'accepted')) throw usage('merge --accepted takes no ID or merge overrides');
  const st = S.loadState(ctx.stateDir);
  I.authorized(ctx, st);
  // Keep one executor and current-base checks while leaving refused
  // entries for the next batch, so independent mergeable PRs can land.
  await require('./automation').queue({ ...ctx, queueSkip: new Set() });
  const current = S.loadState(ctx.stateDir);
  const accepted = new Set(current.tasks.tasks.filter((t) => t.status === 'accepted').map((t) => t.id));
  const data = await I.snapshot(ctx, current);
  const remaining = data.items.filter((i) => accepted.has(i.task) && ['accepted_unmerged', 'github_error'].includes(i.kind));
  return { data: { remaining }, text: remaining.length ? remaining.map((i) => `${i.task}: ${i.reason}`).join('\n') : 'accepted merge queue drained',
    code: remaining.length ? 1 : 0 };
}

function release(ctx) {
  if (!ctx.flags.dead) {
    if (!ctx.pos.length) throw usage('release needs ID or --dead');
    return T.release(ctx);
  }
  if (ctx.pos.length || ctx.flags.reason) throw usage('release --dead takes no ID or reason');
  const st = S.loadState(ctx.stateDir);
  I.authorized(ctx, st);
  return batch(require('./processes').exitedClaims(st, st.events, { includeTail: false }).map((t) => t.id),
    (id) => T.release({ ...ctx, deadOnly: true, pos: [id], flags: { reason: 'spawned process exited without submit' } }));
}

function rework(ctx) {
  if (!ctx.flags['from-review']) return T.rework(ctx);
  if (ctx.pos.length || ctx.flags.reason) throw usage('rework --from-review ID takes no positional ID or reason');
  return T.rework({ ...ctx, pos: [ctx.flags['from-review']], fromReview: true });
}

module.exports = { spawn, merge, release, rework };
