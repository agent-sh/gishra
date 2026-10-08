'use strict';

const { createHash } = require('node:crypto');
const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const C = require('./gates/common');
const { refuse, usage } = require('./util');

function authorized(ctx, st) {
  if (!require('./authority').actor(ctx, st.events)) throw refuse('inbox and batch actions require the orchestrator or owner identity');
}

function liveWorker(st, task) {
  if (P.supervised(st, task, st.events)) return true;
  const spawn = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'worker');
  return !!spawn && !require('./spawn-session').exitedAttempt(spawn, st.events);
}

function dispatchable(st) {
  return T.readyTasks(st, Date.now()).map((x) => x.task)
    .filter((t) => ['todo', 'rework'].includes(t.status) && !liveWorker(st, t));
}

function item(kind, task, detail, argv, suffix = '') {
  return { id: `${kind}:${task || 'project'}${suffix ? `:${suffix}` : ''}`, kind, task, ...detail,
    action: { command: ['tower-crane', ...argv].map(C.shellQuote).join(' '), argv } };
}

function local(st, agent) {
  const items = [];
  for (const task of st.tasks.tasks) {
    if (['submitted', 'accepted'].includes(task.status)) {
      const review = T.latestGateEvidence(task, 'review', st.events);
      if (review?.ok === false) items.push(item('review_failed', task.id,
        { sha: task.sha, findings: review.summary, ref: review.ref || null, reviewer: review.agent },
        ['rework', '--from-review', task.id]));
    }
    if (task.status === 'rework' && !liveWorker(st, task)) {
      const reason = st.events.findLast((e) => e.cmd === 'rework' && e.task === task.id)?.detail.reason;
      items.push(item('rework_ready', task.id, { reason: reason || 'task requires rework', blockers: T.blockReasons(st, task) },
        ['spawn', '--ready']));
    } else if (task.status === 'todo' && T.isReady(st, task, Date.now()) && !liveWorker(st, task)) {
      items.push(item('ready', task.id, { reason: 'ready for a worker' }, ['spawn', '--ready']));
    }
  }
  for (const dead of P.exitedClaims(st, st.events, { includeTail: false })) {
    const { id, ...detail } = dead;
    items.push(item('dead_claim', id, detail, ['release', '--dead']));
  }
  for (const decision of st.decisions.decisions.filter((d) => d.status === 'open')) {
    items.push(item('decision', null, { decision }, ['answer', decision.id, '--choice', '<owner answer>'], decision.id));
  }
  const acknowledged = new Set(st.events.filter((e) => e.cmd === 'inbox ack').map((e) => e.detail.item));
  const events = [...st.events, ...require('./events').sources(st, st.events, Date.now()).filter((e) => e.type === 'stall')
    .map((e) => ({ ...e, cmd: 'stall', id: e.detail.source }))];
  for (const event of events) {
    if (event.cmd === 'msg' && ['orchestrator', agent].includes(event.detail.to)) {
      const id = `message:${event.task || 'project'}:${event.id}`;
      if (!acknowledged.has(id)) items.push(item('message', event.task,
        { from: event.agent, text: event.detail.text, event: event.id }, ['inbox', '--ack', id], event.id));
    }
    if (event.cmd === 'stall') {
      const task = st.tasks.tasks.find((t) => t.id === event.task);
      if (!task?.claim || task.claim.agent !== event.detail.agent || task.claim.until !== event.detail.until) continue;
      if (events.slice(events.indexOf(event) + 1).some((e) => e.task === task.id && e.agent === task.claim.agent
        && !['stall', 'worker-exited'].includes(e.cmd))) continue;
      const source = event.detail.source ? createHash('sha256').update(event.detail.source).digest('hex') : event.id;
      const id = `stall:${task.id}:${source}`;
      if (!acknowledged.has(id)) items.push(item('stall', task.id, { ...event.detail, event: event.id },
        ['inbox', '--ack', id], source));
    }
  }
  return items;
}

async function query(ctx, args, list = false) {
  const r = await C.gh({ root: ctx.cwd }, args);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh ${args.join(' ')}`));
  try {
    return list ? r.stdout.split('\n').filter((s) => s.trim()).flatMap((s) => JSON.parse(s)) : JSON.parse(r.stdout);
  } catch { throw refuse(`invalid GitHub response for ${args.join(' ')}`); }
}

async function remote(ctx, st, task) {
  const items = [];
  const { repo } = st.project;
  const pr = await query(ctx, ['pr', 'view', String(task.pr), '-R', repo, '--json', 'state,headRefOid,mergeable,mergeStateStatus,url']);
  const same = C.sameSha(pr.headRefOid, task.sha);
  if (task.status === 'accepted' && !(pr.state === 'MERGED' && same)) {
    const failure = task.evidence.findLast((e) => e.type === 'merge' && e.revision === task.revision && C.sameSha(e.sha, task.sha));
    const queue = st.events.findLast((e) => e.cmd === 'merge queue' && e.detail.blocked?.task === task.id)?.detail.blocked;
    const deferred = st.events.findLast((e) => e.cmd === 'merge deferred' && e.task === task.id
      && e.detail.revision === task.revision && C.sameSha(e.detail.sha, task.sha))?.detail;
    const gates = T.gateReport(task, st.events, st);
    const reason = !same ? `PR head moved from ${task.sha} to ${pr.headRefOid}`
      : pr.state !== 'OPEN' ? `PR is ${pr.state}`
        : pr.mergeable !== 'MERGEABLE' ? `PR mergeability is ${pr.mergeable || 'UNKNOWN'}`
          : !gates.ok ? gates.missing.join('; ')
            : deferred?.reason || queue?.reason || (failure?.ok === false ? failure.summary : 'accepted PR has not merged');
    items.push(item('accepted_unmerged', task.id, { pr: task.pr, sha: task.sha, remote: pr, reason },
      ['merge', '--accepted']));
  }
  if (task.status !== 'submitted' || pr.state !== 'OPEN') return items;
  if (!same) {
    items.push(item('head_changed', task.id, { pr: task.pr, sha: task.sha, head: pr.headRefOid,
      reason: 'the submitter must record the new head and rerun gates' },
    ['msg', '--to', task.submitted_by, '--task', task.id,
      `Submit the current PR head with tower-crane submit ${task.id} --sha ${pr.headRefOid}`]));
    return items;
  }
  const api = async (endpoint, filter) => {
    try { return await query(ctx, ['api', `repos/${repo}/${endpoint}`, '--paginate', '--jq', filter], true); }
    catch (e) {
      items.push(item('github_error', task.id, { pr: task.pr, reason: e.message }, ['inbox'], endpoint.split('?')[0]));
      return [];
    }
  };
  const { policy, error } = require('./ci-hosted').resolve(st.project);
  if (error) throw refuse(error);
  const runs = await api(`commits/${task.sha}/check-runs?per_page=100`, '.check_runs[]');
  const failed = runs.filter((run) => {
    const app = typeof run.app === 'string' ? run.app : run.app?.slug;
    if (app !== 'revuto-review' || policy.ignore_apps.includes(app) || run.status !== 'completed' || run.conclusion !== 'failure') return false;
    const text = [run.output?.title, run.output?.summary].filter(Boolean).join('\n');
    return policy.required.some((name) => run.name?.startsWith(name))
      || !policy.capped_review.some((rule) => rule.app === app && new RegExp(rule.pattern, 'i').test(text));
  });
  if (failed.length) {
    const comments = (await api(`pulls/${task.pr}/comments?per_page=100`, '.[]'))
      .filter((c) => C.sameSha(c.commit_id, task.sha) && /^revuto(?:-[\w-]+)?(?:\[bot\])?$/.test(c.user?.login || ''));
    const findings = comments.map((c) => `${c.path}:${c.line ?? c.original_line ?? '?'} ${c.body}\n${c.html_url}`).join('\n');
    const reason = `revuto failed at ${task.sha}\n${findings || failed.map((r) => r.output?.summary || r.name).join('\n')}`;
    items.push(item('revuto_failed', task.id, { pr: task.pr, sha: task.sha, checks: failed, comments, reason },
      ['rework', task.id, '--reason', reason]));
  }
  const alerts = (await api(`code-scanning/alerts?state=open&ref=${encodeURIComponent(`refs/pull/${task.pr}/head`)}&per_page=100`, '.[]'))
    .filter((a) => a.tool?.name === 'CodeQL' && C.sameSha(a.most_recent_instance?.commit_sha, task.sha));
  if (alerts.length) {
    const reason = alerts.map((a) => `CodeQL ${a.rule?.id}: ${a.most_recent_instance?.message?.text || a.rule?.description} (${a.html_url})`).join('\n');
    items.push(item('codeql_alert', task.id, { pr: task.pr, sha: task.sha, alerts, reason },
      ['rework', task.id, '--reason', reason]));
  }
  return items;
}

async function snapshot(ctx, st = S.loadState(ctx.stateDir)) {
  authorized(ctx, st);
  const items = local(st, ctx.agent);
  for (const task of st.tasks.tasks) {
    if (!['submitted', 'accepted'].includes(task.status) || require('./stack').merged(st, task)) continue;
    if (!task.pr || !st.project.repo) {
      if (task.status === 'accepted') items.push(item('accepted_unmerged', task.id,
        { reason: 'task has no PR or project repository' }, ['task', 'show', task.id]));
      continue;
    }
    try { items.push(...await remote(ctx, st, task)); }
    catch (e) { items.push(item('github_error', task.id, { pr: task.pr, reason: e.message }, ['inbox'])); }
  }
  const last = new Map();
  for (const e of st.events) if (e.cmd === 'automation') last.set(e.task, e.detail);
  const executors = [...last.entries()].filter(([, d]) => d.phase === 'running' && P.processState(d) !== 'exited')
    .map(([task, d]) => ({ task, ...d, process: P.processState(d) }));
  return { items, executors };
}

async function inbox(ctx) {
  if (ctx.flags.ack !== undefined) {
    const data = S.mutate(ctx, 'inbox ack', (st, emit) => {
      authorized(ctx, st);
      const found = local(st, ctx.agent).find((i) => i.id === ctx.flags.ack && ['message', 'stall'].includes(i.kind));
      if (!found) throw usage('inbox --ack needs a current message or stall item id');
      emit(found.task, { item: found.id });
      return { acknowledged: found.id };
    });
    return { data, text: `acknowledged ${data.acknowledged}` };
  }
  const data = await snapshot(ctx);
  return { data, text: data.items.length ? data.items.map((i) =>
    `${i.id}\n${JSON.stringify(Object.fromEntries(Object.entries(i).filter(([k]) => !['id', 'action'].includes(k))), null, 2)}\n  resolve: ${i.action.command}`).join('\n\n')
    + `\n\nlive gate executors: ${data.executors.length}` : `inbox empty; live gate executors: ${data.executors.length}` };
}

// A snapshot receipt deduplicates concurrent followers without making inbox
// reads destructive. Reappearing findings wake again after a clear snapshot.
async function observe(ctx) {
  const st = S.loadState(ctx.stateDir);
  if (!require('./authority').actor(ctx, st.events)) return;
  const data = await snapshot(ctx, st);
  const fingerprints = data.items.map((i) => ({ id: i.id, hash: createHash('sha256').update(JSON.stringify(i)).digest('hex'), task: i.task }));
  S.mutate(ctx, 'inbox snapshot', (current, emit) => {
    const previous = current.events.findLast((e) => e.cmd === 'inbox snapshot')?.detail.items || [];
    if (JSON.stringify(previous) === JSON.stringify(fingerprints)) return;
    for (const i of fingerprints) {
      if (!previous.some((old) => old.id === i.id && old.hash === i.hash)) emit(i.task, { item: i.id }, 'inbox item');
    }
    emit(null, { items: fingerprints });
  });
}

module.exports = { inbox, snapshot, observe, authorized, liveWorker, dispatchable };
