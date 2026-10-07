'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { refuse, usage, conflict, nowIso, shaMatch, shortTime, byId, readStdin } = require('./util');
const S = require('./state');
const L = require('./ladder');
const P = require('./processes');
const B = require('./brief');

const SIZE_HOURS = { S: 1, M: 4, L: 8 };
const GATE_TYPES = ['tests', 'clean', 'review', 'ci'];
const SOFTWARE_GATES = ['tests', 'clean', 'ci', 'merge'];
const SHA_RE = /^[0-9a-f]{7,64}$/i;

function normId(id, prefix) {
  const s = String(id || '').trim();
  return new RegExp(`^${prefix}\\d+$`, 'i').test(s) ? s.toUpperCase() : s;
}

function getTask(st, id) {
  const tid = normId(id, 'T');
  const task = st.tasks.tasks.find((t) => t.id === tid);
  if (!task) throw refuse(`no task ${id}; tower-crane task list shows the ids`);
  return task;
}

const briefPath = (dir, id) => path.join(dir, 'briefs', `${id}.md`);

function leaseExpired(task, now) {
  return task.status === 'in_progress' && !!task.claim && Date.parse(task.claim.until) <= now;
}

// An expired lease frees the task: it counts as the status it had before the claim.
function effectiveStatus(task, now) {
  if (leaseExpired(task, now)) return task.claim.from || 'todo';
  return task.status;
}

function openDecisionsFor(st, id) {
  return st.decisions.decisions.filter((d) => d.status === 'open' && d.blocks.includes(id));
}

// Why a todo or rework task cannot be claimed; empty when it is ready.
function blockReasons(st, task) {
  const reasons = [];
  const byKey = new Map(st.tasks.tasks.map((t) => [t.id, t]));
  for (const dep of task.depends_on) {
    const d = byKey.get(dep);
    if (!d) reasons.push(`depends on ${dep}, which does not exist`);
    else if (d.status !== 'accepted') reasons.push(`depends on ${dep} (${d.status})`);
  }
  if (task.needs_owner) reasons.push(`needs owner: ${task.needs_owner}`);
  for (const d of openDecisionsFor(st, task.id)) reasons.push(`waits for decision ${d.id}: ${d.question}`);
  return reasons;
}

function isReady(st, task, now) {
  const eff = effectiveStatus(task, now);
  return (eff === 'todo' || eff === 'rework') && blockReasons(st, task).length === 0;
}

// Tasks whose completion frees the most outstanding work go first.
function unblockCounts(st) {
  const dependents = new Map();
  for (const t of st.tasks.tasks) {
    for (const d of t.depends_on) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(t);
    }
  }
  const counts = new Map();
  for (const t of st.tasks.tasks) {
    const seen = new Set();
    const stack = [t.id];
    while (stack.length) {
      for (const dt of dependents.get(stack.pop()) || []) {
        if (seen.has(dt.id) || dt.status === 'accepted' || dt.status === 'cancelled') continue;
        seen.add(dt.id);
        stack.push(dt.id);
      }
    }
    counts.set(t.id, seen.size);
  }
  return counts;
}

function readyTasks(st, now) {
  const counts = unblockCounts(st);
  return st.tasks.tasks
    .filter((t) => isReady(st, t, now))
    .sort((a, b) => counts.get(b.id) - counts.get(a.id) || byId(a, b))
    .map((t) => ({ task: t, unblocks: counts.get(t.id) }));
}

function blockedTasks(st, now) {
  return st.tasks.tasks
    .filter((t) => ['todo', 'rework'].includes(effectiveStatus(t, now)))
    .map((t) => ({ task: t, reasons: blockReasons(st, t) }))
    .filter((b) => b.reasons.length)
    .sort((a, b) => byId(a.task, b.task));
}

// todo splits into ready or blocked; everything else shows its stored status.
function displayStatus(st, task, now) {
  const eff = effectiveStatus(task, now);
  if (eff === 'todo') return blockReasons(st, task).length ? 'blocked' : 'ready';
  return eff;
}

function requiredGates(task) {
  const gates = task.kind === 'code' ? ['tests', 'clean', 'review'] : ['review'];
  // A PR lands through GitHub whatever the task's kind, so CI must pass on the exact commit.
  return task.pr ? [...gates, 'ci'] : gates;
}

function hasGateEvent(task, entry, events) {
  const source = entry.type === 'merge' ? 'merge' : `check ${entry.type}`;
  if (entry.source !== source || !Array.isArray(entry.commands)) return false;
  if (entry.ok && !entry.commands.length) return false;
  return events.some((event) => event && event.cmd === entry.source && event.task === task.id
    && event.agent === entry.agent && event.detail
    && event.detail.type === entry.type && event.detail.source === entry.source
    && event.detail.sha === entry.sha && event.detail.ok === entry.ok
    && event.detail.revision === entry.revision && isDeepStrictEqual(event.detail.commands, entry.commands)
    && isDeepStrictEqual(event.detail.receipt, entry.receipt)
    && isDeepStrictEqual(event.detail.ci_policy, entry.ci_policy)
    && event.detail.tests_mode === entry.tests_mode);
}

function eligibleGateEvidence(task, entry, events) {
  if (entry.waived) return entry.agent === 'owner';
  return entry.type === 'review' ? entry.agent !== task.submitted_by : hasGateEvent(task, entry, events);
}

function latestGateEvidence(task, type, events = []) {
  return task.evidence.findLast((e) => e.type === type && e.revision === task.revision
    && shaMatch(e.sha, task.sha) && eligibleGateEvidence(task, e, events));
}

function gateReport(task, events = [], st) {
  const sha7 = task.sha ? task.sha.slice(0, 7) : null;
  const merge = latestGateEvidence(task, 'merge', events);
  const merged = merge?.ok && !merge.waived;
  const gates = requiredGates(task).map((type) => {
    if (!task.sha) return { type, ok: false, reason: 'the task has no submitted sha' };
    // A marker in tasks.json alone cannot prove the gate ran; require its audit receipt too.
    const latest = latestGateEvidence(task, type, events);
    if (!latest) {
      const atSha = task.evidence.filter((e) => e.type === type && e.revision === task.revision && shaMatch(e.sha, task.sha));
      const reason = type === 'review' && atSha.length && atSha.every((e) => e.agent === task.submitted_by)
        ? `only the submitter (${task.submitted_by}) reviewed; needs an ok review from another agent`
        : `no ${type} evidence at ${sha7} for revision ${task.revision}`;
      return { type, ok: false, reason };
    }
    if (!latest.ok) return { type, ok: false, reason: `latest ${type} at ${sha7} failed${latest.summary ? `: ${latest.summary}` : ''}` };
    if (type === 'tests' && !latest.waived && st) {
      const policy = require('./tests-policy').resolve(st.project, task.kind);
      if (policy.error) return { type, ok: false, reason: policy.error };
      if (latest.tests_mode !== policy.mode) {
        return { type, ok: false, reason: `tests evidence mode ${latest.tests_mode ?? 'unrecorded'} no longer matches ${policy.mode}; run tower-crane check tests ${task.id} again` };
      }
    }
    if (type === 'ci' && (latest.receipt || st?.project.ci?.local != null) && !latest.waived && !merged) {
      const Local = require('./ci-local');
      const repo = st ? S.findRepo(st.dir, process.cwd()) : null;
      const current = Local.snapshot(repo?.root, st?.project || {}, task.sha);
      const local = Local.resolve(st?.project.ci?.local, task);
      const reason = local.error || current.error || Local.mismatch(latest.receipt, current, local, latest.commands);
      if (reason) return { type, ok: false, reason };
    } else if (type === 'ci' && st && !latest.waived && !merged) {
      const reason = require('./ci-hosted').mismatch(latest.ci_policy, st.project, task.id);
      if (reason) return { type, ok: false, reason };
    }
    return { type, ok: true, waived: !!latest.waived, agent: latest.agent, reason: latest.waived ? `waived by ${latest.agent}` : `ok by ${latest.agent}` };
  });
  return { ok: !!task.sha && gates.every((g) => g.ok), gates, missing: gates.filter((g) => !g.ok).map((g) => `${g.type}: ${g.reason}`) };
}

// The CLI is the only writer, so it never lets a dependency point nowhere or
// loop back; validate still checks files that were edited by hand.
function assertGraph(st, ids) {
  const byKey = new Map(st.tasks.tasks.map((t) => [t.id, t]));
  for (const id of ids) {
    for (const dep of byKey.get(id).depends_on) {
      if (!byKey.has(dep)) throw refuse(`${id} depends on ${dep}, which does not exist; add ${dep} first or fix the id`);
    }
  }
  for (const id of ids) {
    const cycle = cycleThrough(byKey, id);
    if (cycle) throw refuse(`dependencies would form a cycle (${cycle.join(' -> ')}, each needing the next); drop one of them`);
  }
}

function cycleThrough(byKey, id) {
  const seen = new Set();
  const trail = [id];
  const walk = (cur) => {
    for (const d of byKey.get(cur).depends_on) {
      if (d === id) return [...trail, id];
      if (seen.has(d) || !byKey.has(d)) continue;
      seen.add(d);
      trail.push(d);
      const found = walk(d);
      if (found) return found;
      trail.pop();
    }
    return null;
  };
  return walk(id);
}

function findCycles(tasks) {
  const byKey = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map();
  const stack = [];
  const cycles = new Map();
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of byKey.get(id).depends_on) {
      if (!byKey.has(d)) continue;
      if (color.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d));
        const key = [...cyc].sort().join(',');
        if (!cycles.has(key)) cycles.set(key, [...cyc, d]);
      } else if (!color.get(d)) visit(d);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const t of [...tasks].sort(byId)) if (!color.get(t.id)) visit(t.id);
  return [...cycles.values()];
}

function asList(v) {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
}

function checkEnum(name, value, list) {
  if (!list.includes(value)) throw usage(`--${name} must be one of ${list.join(', ')}, got "${value}"`);
}

function newTask(st, fields) {
  const id = `T${st.tasks.next}`;
  st.tasks.next += 1;
  const task = {
    id,
    title: fields.title,
    kind: fields.kind || 'code',
    acceptance: fields.acceptance,
    depends_on: fields.depends_on || [],
    needs_owner: fields.needs_owner || null,
    size: fields.size || 'M',
    ...L.tierSpec(fields.tier || L.defaultTier(fields.kind || 'code', fields.size || 'M')),
    status: 'todo',
    claim: null,
    branch: null,
    pr: null,
    sha: null,
    submitted_by: null,
    evidence: [],
    revision: 1,
    spend: { minutes: 0, tokens: 0 },
    notes: [],
  };
  st.tasks.tasks.push(task);
  return task;
}

function note(task, agent, text) {
  task.notes.push({ at: nowIso(), agent, text });
}

function taskLine(st, t, now) {
  return `${t.id.padEnd(5)} ${displayStatus(st, t, now).padEnd(11)} ${t.size} ${t.kind.padEnd(8)} ${t.title}`;
}

// ---- Plan ----

function checkTier(tier, fail = usage) {
  if (!L.tierSpec(tier)) throw fail(`tier must be one of ${L.TIERS.join(', ')} or an ascending range such as easy..medium`);
}

function applyTier(task, value) {
  delete task.tier_range;
  delete task.escalation_pending;
  Object.assign(task, L.tierSpec(value));
}

function taskAdd(ctx) {
  const f = ctx.flags;
  if (!f.title || !f.title.trim()) throw usage('task add needs --title');
  const acceptance = asList(f.acceptance);
  if (!acceptance.length) throw usage('task add needs at least one --acceptance line saying how to tell it is done');
  if (f.kind !== undefined) checkEnum('kind', f.kind, S.KINDS);
  if (f.size !== undefined) checkEnum('size', f.size, S.SIZES);
  if (f.tier !== undefined) checkTier(f.tier);
  const task = S.mutate(ctx, 'task add', (st, emit) => {
    const t = newTask(st, {
      title: f.title.trim(), kind: f.kind, acceptance, size: f.size, tier: f.tier,
      depends_on: asList(f.dep).map((d) => normId(d, 'T')), needs_owner: f['needs-owner'] ? f['needs-owner'] : null,
    });
    assertGraph(st, [t.id]);
    emit(t.id, { title: t.title });
    return t;
  });
  return { data: task, text: task.id };
}

function taskUpdate(ctx) {
  const f = ctx.flags;
  if (!Object.keys(f).length) throw usage('task update needs at least one change; see tower-crane task update --help');
  if (f.kind !== undefined) checkEnum('kind', f.kind, S.KINDS);
  if (f.size !== undefined) checkEnum('size', f.size, S.SIZES);
  if (f.tier !== undefined) checkTier(f.tier);
  if (f.status !== undefined && f.status !== 'cancelled') {
    throw usage('task update can only set --status cancelled; claim, submit, accept and rework move the other states');
  }
  let ciLocal;
  if (f['ci-local'] !== undefined) {
    if (ctx.agent !== 'owner' || !ctx.agentExplicit) {
      throw refuse('only the owner can set or clear a task local CI override; use tower-crane ask or a task note');
    }
    const message = '--ci-local must be JSON with command or args and optional positive timeout in seconds, or null';
    try {
      ciLocal = JSON.parse(f['ci-local']);
    } catch {
      throw usage(message);
    }
    if (ciLocal !== null && !require('./ci-local').validOverride(ciLocal)) throw usage(message);
  }
  const task = S.mutate(ctx, 'task update', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    const changes = {};
    const material = [];
    if (f.title !== undefined) {
      if (!f.title.trim()) throw usage('--title cannot be empty');
      t.title = changes.title = f.title.trim();
    }
    if (f.acceptance !== undefined) {
      const acc = asList(f.acceptance);
      if (!acc.length) throw usage('--acceptance cannot be empty; every task needs a way to tell it is done');
      if (JSON.stringify(acc) !== JSON.stringify(t.acceptance)) material.push('acceptance');
      t.acceptance = changes.acceptance = acc;
    }
    if (f.dep !== undefined) {
      const deps = asList(f.dep).map((d) => normId(d, 'T'));
      if ([...deps].sort().join() !== [...t.depends_on].sort().join()) material.push('dependencies');
      t.depends_on = changes.depends_on = deps;
    }
    if (f.size !== undefined) t.size = changes.size = f.size;
    if (f.kind !== undefined && f.kind !== t.kind) {
      const localCi = st.project.ci?.local;
      if (localCi != null) {
        const ciLocal = require('./ci-local');
        const current = ciLocal.resolve(localCi, t);
        const updated = ciLocal.resolve(localCi, { ...t, kind: f.kind });
        if (current.variant !== updated.variant && (ctx.agent !== 'owner' || !ctx.agentExplicit)) {
          throw refuse('only the owner can change task kind when it changes the selected local CI variant; use tower-crane ask or a task note');
        }
      }
      material.push('kind');
    }
    if (f.kind !== undefined) t.kind = changes.kind = f.kind;
    if (f['ci-local'] !== undefined) {
      if (!isDeepStrictEqual(t.ci_local ?? null, ciLocal)) material.push('local CI override');
      if (ciLocal === null) delete t.ci_local;
      else t.ci_local = ciLocal;
      changes.ci_local = ciLocal;
    }
    // A tier is chosen once; changing size or kind later does not move it.
    if (f.tier !== undefined) { applyTier(t, f.tier); changes.tier = f.tier; }
    if (f['needs-owner'] !== undefined) {
      const needsOwner = f['needs-owner'].trim() || null;
      // Updating the reason must not bypass owner-done's explicit owner check.
      if (t.needs_owner && needsOwner !== t.needs_owner && (ctx.agent !== 'owner' || !ctx.agentExplicit)) {
        throw refuse('only the owner can clear or replace needs_owner; an agent requests this with tower-crane ask or a task note');
      }
      t.needs_owner = changes.needs_owner = needsOwner;
    }
    if (f.status === 'cancelled') {
      if (t.status === 'accepted') throw refuse(`${t.id} is already accepted; it cannot be cancelled`);
      t.status = changes.status = 'cancelled';
      t.claim = null;
    }
    // An accepted task was reviewed and gated against its acceptance,
    // dependencies and kind. Changing one under it would leave it accepted for
    // something nobody checked, with its dependents still claimable.
    if (t.status === 'accepted' && material.length) {
      throw refuse(`${t.id} is accepted, so its ${material.join(' and ')} cannot change; send it back first with tower-crane rework ${t.id} --reason R`);
    }
    // Kind needs no new revision: the gates are worked out from the current kind.
    const bump = material.includes('acceptance') || material.includes('dependencies');
    if (bump) {
      t.revision += 1;
      changes.revision = t.revision;
    }
    assertGraph(st, [t.id]);
    emit(t.id, changes);
    return { t, bump };
  });
  return { data: task.t, text: `updated ${task.t.id}${task.bump ? `; revision is now ${task.t.revision}, so earlier evidence no longer counts` : ''}` };
}

// Tier changes from the serve Settings view: the write task update --tier
// makes, for several tasks under one lock, so a refused one writes none.
// expect maps each task to the tier the page loaded; a task whose tier moved
// since is refused, so the page cannot undo a change it never showed.
function setTiers(ctx, tiers, via, expect) {
  for (const tier of Object.values(tiers)) checkTier(tier);
  return S.mutate(ctx, 'task update', (st, emit) => {
    const tasks = Object.keys(tiers).map((id) => getTask(st, id));
    if (expect) {
      const stale = tasks.filter((t) => expect[t.id] !== t.tier).map((t) => `${t.id} is now ${t.tier}, not ${expect[t.id]}`);
      if (stale.length) throw conflict(`tiers changed since this page loaded: ${stale.join('; ')}; reload the page and make the edit again`);
    }
    return tasks.map((t) => {
      applyTier(t, tiers[t.id]);
      emit(t.id, via ? { tier: t.tier, via } : { tier: t.tier });
      return { id: t.id, tier: t.tier };
    });
  });
}

function taskNote(ctx) {
  const text = ctx.pos.slice(1).join(' ').trim();
  if (!text) throw usage('task note needs the note text: tower-crane task note T1 "what happened"');
  const task = S.mutate(ctx, 'task note', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    note(t, ctx.agent, text);
    emit(t.id, { text });
    return t;
  });
  return { data: task.notes[task.notes.length - 1], text: `noted on ${task.id}` };
}

function describeTask(st, t, now) {
  const display = displayStatus(st, t, now);
  const out = {
    ...t,
    run: P.runPhase(st, t),
    display,
    lease_expired: leaseExpired(t, now),
    blocked_by: ['todo', 'rework'].includes(effectiveStatus(t, now)) ? blockReasons(st, t) : [],
    gates: t.sha ? gateReport(t, st.events, st) : null,
  };
  return out;
}

function taskShow(ctx) {
  const st = S.loadState(ctx.stateDir);
  const now = Date.now();
  const t = getTask(st, ctx.pos[0]);
  const d = describeTask(st, t, now);
  d.spend_by_rung = require('./escalation').spendByRung(t);
  const lines = [
    `${t.id}  ${t.title}`,
    `status: ${t.status}${display(d)}  kind: ${t.kind}  size: ${t.size}  tier: ${t.tier}  revision: ${t.revision}`,
  ];
  if (t.tier_range) lines.push(`tier range: ${t.tier_range.min}..${t.tier_range.max}`);
  if (t.depends_on.length) {
    lines.push(`depends on: ${t.depends_on.map((id) => {
      const dep = st.tasks.tasks.find((x) => x.id === id);
      return `${id} (${dep ? dep.status : 'missing'})`;
    }).join(', ')}`);
  }
  if (t.needs_owner) lines.push(`needs owner: ${t.needs_owner}`);
  if (t.ci_local != null) lines.push(`ci.local override: ${JSON.stringify(t.ci_local)}`);
  if (d.blocked_by.length) lines.push(`blocked: ${d.blocked_by.join('; ')}`);
  lines.push('acceptance:', ...t.acceptance.map((a) => `  - ${a}`));
  if (t.claim) lines.push(`claim: ${t.claim.agent} until ${shortTime(t.claim.until)}${d.lease_expired ? ' (expired)' : ''}`);
  if (d.run) lines.push(`phase: ${P.phaseText(d.run)}`);
  if (t.branch || t.pr || t.sha) lines.push(`branch: ${t.branch || '-'}  pr: ${t.pr ? `#${t.pr}` : '-'}  sha: ${t.sha || '-'}${t.submitted_by ? `  submitted by ${t.submitted_by}` : ''}`);
  if (d.gates) lines.push(`gates: ${d.gates.gates.map((g) => `${g.type} ${g.ok ? 'ok' : 'missing'}`).join(', ')}`);
  if (t.evidence.length) {
    lines.push('evidence:');
    for (const e of t.evidence) {
      const stale = e.revision !== t.revision ? ` (revision ${e.revision}, does not count)`
        : SOFTWARE_GATES.includes(e.type) && (!shaMatch(e.sha, t.sha) || !eligibleGateEvidence(t, e, st.events))
          ? ' (does not count)' : '';
      lines.push(`  - ${e.type} ${e.waived ? 'waived' : e.ok ? 'ok' : 'FAIL'} at ${e.sha ? e.sha.slice(0, 7) : '-'} by ${e.agent} ${shortTime(e.at)}${stale}${e.summary ? `: ${e.summary}` : ''}`);
      for (const c of Array.isArray(e.commands) ? e.commands : []) {
        const command = [c.command, ...(Array.isArray(c.args) ? c.args : [])].map((s) => JSON.stringify(s)).join(' ');
        lines.push(`    command: ${command} (cwd: ${c.cwd || '-'}, status: ${c.status ?? '-'}${c.signal ? `, signal: ${c.signal}` : ''})`);
      }
    }
  }
  if (t.notes.length) {
    lines.push('notes:');
    for (const n of t.notes) lines.push(`  - ${shortTime(n.at)} ${n.agent}: ${n.text}`);
  }
  lines.push(`spend: ${t.spend.minutes} min, ${t.spend.tokens} tokens`);
  if (t.tier_range) for (const [rung, spend] of Object.entries(d.spend_by_rung)) lines.push(`  ${rung}: ${spend.tokens ?? 'unknown'} tokens, USD ${spend.cost_usd ?? 'unknown'}`);
  const missing = (t.spend.entries || []).filter((e) => e.tokens === null && e.source.startsWith('spawn:')).length;
  if (missing) lines.push(`spawns without usage: ${missing}; retry tower-crane spend ${t.id} --from-spawn AGENT after telemetry is available`);
  return { data: d, text: lines.join('\n') };
}

function display(d) {
  if (d.lease_expired) return ' (lease expired)';
  if (d.display === 'ready' || d.display === 'blocked') return ` (${d.display})`;
  return '';
}

function taskList(ctx) {
  const st = S.loadState(ctx.stateDir);
  const now = Date.now();
  const want = ctx.flags.status;
  if (want !== undefined) checkEnum('status', want, [...S.STATUSES, 'ready', 'blocked']);
  const rows = [...st.tasks.tasks].sort(byId).filter((t) => {
    if (!want) return true;
    if (want === 'ready') return isReady(st, t, now);
    if (want === 'blocked') return ['todo', 'rework'].includes(effectiveStatus(t, now)) && blockReasons(st, t).length > 0;
    return t.status === want;
  });
  return {
    data: rows.map((t) => describeTask(st, t, now)),
    text: rows.length ? rows.map((t) => taskLine(st, t, now)).join('\n') : 'no tasks',
  };
}

const PLAN_FIELDS = ['id', 'title', 'acceptance', 'kind', 'size', 'tier', 'depends_on', 'needs_owner'];

function planImport(ctx) {
  const file = ctx.pos[0];
  let raw;
  try {
    raw = file === '-' ? readStdin() : fs.readFileSync(path.resolve(ctx.cwd, file), 'utf8');
  } catch (e) {
    throw refuse(`cannot read ${file} (${e.code || e.message})`);
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    throw refuse(`${file} is not valid JSON (${e.message})`);
  }
  if (!Array.isArray(plan) || !plan.length) throw refuse(`${file} must hold a non-empty JSON array of task objects`);
  const added = S.mutate(ctx, 'plan import', (st, emit) => {
    const local = new Map();
    const out = [];
    plan.forEach((entry, i) => {
      const where = `plan entry ${i + 1}${entry && entry.id ? ` (${entry.id})` : ''}`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw refuse(`${where} must be an object`);
      const unknown = Object.keys(entry).filter((k) => !PLAN_FIELDS.includes(k));
      if (unknown.length) throw refuse(`${where}: unknown field ${unknown.join(', ')}; allowed: ${PLAN_FIELDS.join(', ')}`);
      if (typeof entry.title !== 'string' || !entry.title.trim()) throw refuse(`${where} needs a title`);
      const acceptance = asList(entry.acceptance);
      if (!acceptance.length) throw refuse(`${where} has no acceptance; every task needs at least one line saying how to tell it is done`);
      if (entry.kind !== undefined && !S.KINDS.includes(entry.kind)) throw refuse(`${where}: kind must be one of ${S.KINDS.join(', ')}`);
      if (entry.size !== undefined && !S.SIZES.includes(entry.size)) throw refuse(`${where}: size must be one of ${S.SIZES.join(', ')}; split anything larger`);
      if (entry.tier !== undefined) checkTier(entry.tier, refuse);
      if (entry.needs_owner !== undefined && entry.needs_owner !== null && typeof entry.needs_owner !== 'string') {
        throw refuse(`${where}: needs_owner must be a string or null`);
      }
      const name = entry.id === undefined ? null : String(entry.id);
      if (name !== null && (local.has(name) || st.tasks.tasks.some((t) => t.id === normId(name, 'T')))) {
        throw refuse(`${where}: id ${name} is already taken; give each plan entry a unique local name`);
      }
      const deps = asList(entry.depends_on).map((d) => {
        if (local.has(d)) return local.get(d);
        const tid = normId(d, 'T');
        if (st.tasks.tasks.some((t) => t.id === tid)) return tid;
        throw refuse(`${where}: unknown dependency ${d}; it must name an earlier plan entry or an existing task`);
      });
      const t = newTask(st, {
        title: entry.title.trim(), acceptance, kind: entry.kind, size: entry.size, tier: entry.tier,
        depends_on: deps, needs_owner: entry.needs_owner ? entry.needs_owner : null,
      });
      if (name !== null) local.set(name, t.id);
      emit(t.id, { title: t.title, local: name });
      out.push({ id: t.id, local: name, title: t.title });
    });
    return out;
  });
  return { data: { added }, text: added.map((a) => `${a.id}${a.local ? ` (${a.local})` : ''}  ${a.title}`).join('\n') };
}

function briefSet(ctx) {
  const [id, dash] = ctx.pos;
  const file = ctx.flags.file;
  if ((file === undefined) === (dash !== '-')) throw usage('brief set needs exactly one source: --file F, or - to read stdin');
  let text;
  try {
    text = file !== undefined ? fs.readFileSync(path.resolve(ctx.cwd, file), 'utf8') : readStdin();
  } catch (e) {
    throw refuse(`cannot read ${file || 'stdin'} (${e.code || e.message})`);
  }
  const out = S.mutate(ctx, 'brief set', (st, emit) => {
    const t = getTask(st, id);
    const target = briefPath(st.dir, t.id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    S.writeAtomic(target, text);
    emit(t.id, { bytes: Buffer.byteLength(text) });
    return { id: t.id, path: target };
  });
  if (B.hasSection(text, 'reviewer') && !B.hasSection(text, 'worker')) {
    process.stderr.write('tower-crane: brief has a ## Reviewer section without a ## Worker section\n');
  }
  return { data: out, text: `brief for ${out.id} written to ${out.path}` };
}

function briefGet(ctx) {
  const st = S.loadState(ctx.stateDir);
  const t = getTask(st, ctx.pos[0]);
  const file = briefPath(st.dir, t.id);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw refuse(`${t.id} has no brief; write one with tower-crane brief set ${t.id} --file F`);
  }
  if (ctx.flags.role !== undefined) {
    const role = String(ctx.flags.role).trim().toLowerCase();
    if (!['worker', 'reviewer'].includes(role)) throw usage('--role must be worker or reviewer');
    text = B.forRole(text, role);
  } else {
    text = B.forRole(text, B.roleForAgent(ctx.agent));
  }
  return { data: { id: t.id, path: file, brief: text }, text: text.replace(/\n$/, ''), raw: true };
}

function planIssues(st) {
  const issues = [];
  const live = st.tasks.tasks.filter((t) => t.status !== 'cancelled');
  const ids = new Set(st.tasks.tasks.map((t) => t.id));
  for (const t of [...live].sort(byId)) {
    for (const d of t.depends_on) {
      if (!ids.has(d)) issues.push({ task: t.id, kind: 'unknown-dependency', message: `${t.id} depends on ${d}, which does not exist` });
    }
    if (!t.acceptance.length) issues.push({ task: t.id, kind: 'no-acceptance', message: `${t.id} has no acceptance; add it with tower-crane task update ${t.id} --acceptance A` });
    if (t.size === 'L' && !t.notes.some((n) => /^split:/i.test(n.text.trim()))) {
      issues.push({ task: t.id, kind: 'unsplit', message: `${t.id} is size L; split it, or record why not with tower-crane task note ${t.id} "split: <reason>"` });
    }
  }
  for (const cyc of findCycles(st.tasks.tasks)) {
    issues.push({ task: cyc[0], kind: 'cycle', message: `dependency cycle ${cyc.join(' -> ')}` });
  }
  const b = st.project.budget;
  const planned = live.reduce((sum, t) => sum + SIZE_HOURS[t.size], 0);
  if (b.hours != null && planned > b.hours) {
    issues.push({ task: null, kind: 'budget', message: `planned work is about ${planned} h (S=1, M=4, L=8) against a budget of ${b.hours} h` });
  }
  const minutes = st.tasks.tasks.reduce((s, t) => s + t.spend.minutes, 0);
  const tokens = st.tasks.tasks.reduce((s, t) => s + t.spend.tokens, 0);
  if (b.hours != null && minutes / 60 > b.hours) issues.push({ task: null, kind: 'budget', message: `spend is ${round1(minutes / 60)} h, over the ${b.hours} h budget` });
  if (b.tokens != null && tokens > b.tokens) issues.push({ task: null, kind: 'budget', message: `spend is ${tokens} tokens, over the ${b.tokens} token budget` });
  return issues;
}

const round1 = (n) => Math.round(n * 10) / 10;

function ladderWarnings(st, layers, env) {
  const warnings = [];
  for (const task of st.tasks.tasks.filter((t) => !['accepted', 'cancelled'].includes(t.status))) {
    try {
      require('./reviewer').choose(st, task, layers, { lines: 0, files: [], binary: false }, env);
    } catch (e) {
      warnings.push({ task: task.id, kind: 'review-unavailable', message: e.message });
    }
  }
  return warnings;
}

function validate(ctx) {
  const st = S.loadState(ctx.stateDir);
  const issues = planIssues(st);
  // A ladder that cannot run is a broken plan: spawn would refuse it.
  let layers = null;
  try {
    layers = L.resolve(st.project, ctx.env);
    for (const e of L.check(st.project, ctx.env)) issues.push({ task: null, kind: 'ladder', message: e });
  } catch (e) {
    issues.push({ task: null, kind: 'ladder', message: e.message });
  }
  const warnings = layers ? ladderWarnings(st, layers, ctx.env) : [];
  const lines = issues.length ? issues.map((i) => i.message) : [`plan ok: ${st.tasks.tasks.length} tasks`];
  return {
    data: { ok: issues.length === 0, issues, warnings },
    text: [...lines, ...warnings.map((w) => `warning: ${w.message}`)].join('\n'),
    code: issues.length ? 1 : 0,
  };
}

// ---- Run ----

function ready(ctx) {
  const st = S.loadState(ctx.stateDir);
  const now = Date.now();
  const r = readyTasks(st, now);
  const data = {
    ready: r.map(({ task, unblocks }) => ({ id: task.id, title: task.title, kind: task.kind, size: task.size, tier: task.tier, status: effectiveStatus(task, now), unblocks })),
    exited_claims: P.exitedClaims(st),
  };
  const lines = r.length
    ? r.map(({ task, unblocks }) => `${task.id.padEnd(5)} ${task.size} ${task.kind.padEnd(8)} ${task.title}${unblocks ? `  (unblocks ${unblocks})` : ''}${effectiveStatus(task, now) === 'rework' ? '  [rework]' : ''}`)
    : ['no task is ready'];
  if (ctx.flags.all) {
    const b = blockedTasks(st, now);
    data.blocked = b.map(({ task, reasons }) => ({ id: task.id, title: task.title, reasons }));
    if (b.length) lines.push('', 'blocked:', ...b.map(({ task, reasons }) => `${task.id.padEnd(5)} ${task.title}: ${reasons.join('; ')}`));
  }
  lines.push(...P.exitLines(data.exited_claims));
  return { data, text: lines.join('\n') };
}

function leaseMinutes(ctx, st) {
  const lease = ctx.flags.lease !== undefined ? ctx.flags.lease : st.project.limits.lease_minutes;
  if (lease < 1) throw usage('--lease must be at least 1 minute');
  return lease;
}

function claim(ctx) {
  const task = S.mutate(ctx, 'claim', (st, emit) => {
    const now = Date.now();
    const t = getTask(st, ctx.pos[0]);
    const lease = leaseMinutes(ctx, st);
    if (t.status === 'in_progress' && !leaseExpired(t, now)) {
      if (t.claim.agent === ctx.agent) {
        t.claim.until = new Date(now + lease * 60000).toISOString();
        emit(t.id, { until: t.claim.until, from: t.claim.from, renewed: true });
        return t;
      }
      throw refuse(`${t.id} is claimed by ${t.claim.agent} until ${shortTime(t.claim.until)}; pick another task from tower-crane ready`);
    }
    const eff = effectiveStatus(t, now);
    if (eff !== 'todo' && eff !== 'rework') throw refuse(`${t.id} is ${eff}; only todo or rework tasks can be claimed`);
    const reasons = blockReasons(st, t);
    if (reasons.length) throw refuse(`${t.id} is blocked: ${reasons.join('; ')}`);
    checkWorkers(st, t, now, 'the workers limit is reached', ctx.agent);
    const previous = t.status === 'in_progress' ? t.claim.agent : null;
    t.claim = { agent: ctx.agent, since: new Date(now).toISOString(), until: new Date(now + lease * 60000).toISOString(), from: eff };
    t.status = 'in_progress';
    emit(t.id, { until: t.claim.until, from: eff, ...(previous ? { took_over_from: previous } : {}) });
    return t;
  });
  return { data: task, text: `claimed ${task.id} for ${task.claim.agent} until ${shortTime(task.claim.until)}` };
}

// Every observer reads the same holders from the event log: a sandboxed
// claimer cannot see peer pids, so a probe would let spawn and claim disagree.
function workerHolders(st, now) {
  const holders = st.tasks.tasks.filter((t) => t.status === 'in_progress' && !leaseExpired(t, now))
    .map((t) => ({ task: t.id, agent: t.claim.agent, kind: 'lease' }));
  const pending = new Map();
  const key = (e) => JSON.stringify([e.task, e.detail.agent, e.detail.attempt]);
  // A worker claims within minutes; a reservation unclaimed for a whole lease
  // since its monitor last wrote, or past a scheduled backoff, cannot belong to
  // a live dispatch. Once lapsed it stays lapsed: another holder may have
  // taken the slot.
  const horizon = st.project.limits.lease_minutes * 60000;
  for (const e of st.events) {
    // Spawns recorded before reservations existed carry no marker and hold nothing.
    if (e.cmd === 'spawn' && e.detail.role === 'worker' && e.detail.reserved === true && !e.detail.claim_since) {
      pending.set(key(e), { task: e.task, agent: e.detail.agent, pid: e.detail.pid, until: Date.parse(e.at) + horizon });
    } else if (e.cmd === 'claim') {
      for (const [id, slot] of pending) {
        if (slot.task === e.task && slot.agent === (e.detail.holder || e.agent)) pending.delete(id);
      }
    } else if (['spawn retry', 'spawn fallback', 'spawn phase'].includes(e.cmd) && pending.has(key(e))) {
      // Session receipts replay an earlier attempt's detail, so only the
      // monitor's own records move the pid or the horizon.
      const slot = pending.get(key(e));
      // The monitor records active false once the attempt is over with no retry pending.
      if (e.detail.active === false || Date.parse(e.at) >= slot.until) pending.delete(key(e));
      else {
        const backoff = e.cmd === 'spawn phase' && Number.isFinite(e.detail.backoff_ms) ? e.detail.backoff_ms : 0;
        Object.assign(slot, { pid: e.detail.pid ?? slot.pid, until: Math.max(slot.until, Date.parse(e.at) + backoff + horizon) });
      }
    } else if (['spawn exit', 'worker-exited'].includes(e.cmd)) {
      const spawn = P.exitSpawn(e, st.events);
      if (spawn && pending.get(key(spawn))?.pid === e.detail.pid) pending.delete(key(spawn));
    }
  }
  for (const slot of pending.values()) {
    if (slot.until <= now) continue;
    if (holders.some((h) => h.task === slot.task && h.agent === slot.agent)) continue;
    holders.push({ task: slot.task, agent: slot.agent, kind: 'reservation' });
  }
  return holders;
}

// Called under the state lock; only the same task and agent can reuse a slot.
function checkWorkers(st, t, now, lead, agent) {
  const holders = workerHolders(st, now).filter((h) => h.task !== t.id || h.agent !== agent);
  if (holders.length >= st.project.limits.workers) {
    const names = holders.map((h) => `${h.task} (${h.agent}, ${h.kind})`).join(', ');
    throw refuse(`${lead} (${holders.length} worker slots held, limit ${st.project.limits.workers}); holders: ${names}; wait for one to finish or raise it with tower-crane project set --workers N`);
  }
}

function requireClaimant(t, agent, verb) {
  if (t.status !== 'in_progress' || !t.claim) throw refuse(`${t.id} is ${t.status}, not in progress; claim it with tower-crane claim ${t.id}`);
  if (t.claim.agent !== agent) throw refuse(`only the claimant (${t.claim.agent}) can ${verb} ${t.id}; you are ${agent}`);
}

function renew(ctx) {
  const task = S.mutate(ctx, 'renew', (st, emit) => {
    const now = Date.now();
    const t = getTask(st, ctx.pos[0]);
    requireClaimant(t, ctx.agent, 'renew');
    if (ctx.claimSince !== undefined && t.claim.since !== ctx.claimSince) throw refuse(`${t.id}'s claim was replaced`);
    // An expired lease stopped counting toward the limit, so renewing it takes
    // a slot back like a new claim would.
    if (leaseExpired(t, now)) checkWorkers(st, t, now, `${t.id}'s lease expired and the workers limit is reached`, ctx.agent);
    t.claim.until = new Date(now + leaseMinutes(ctx, st) * 60000).toISOString();
    emit(t.id, { until: t.claim.until });
    return t;
  });
  return { data: task, text: `${task.id} held by ${task.claim.agent} until ${shortTime(task.claim.until)}` };
}

function release(ctx) {
  const reason = (ctx.flags.reason || '').trim();
  if (!reason) throw usage('release needs --reason so the next agent knows why');
  const task = S.mutate(ctx, 'release', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (t.status !== 'in_progress' || !t.claim) throw refuse(`${t.id} is ${t.status}, not in progress`);
    const exited = P.exitedClaims(st, st.events, { includeTail: false }).find((c) => c.id === t.id);
    if (t.claim.agent !== ctx.agent && (ctx.agent !== 'owner' || !ctx.agentExplicit) && !exited) throw refuse(`only the claimant (${t.claim.agent}) or the owner can release ${t.id} while its spawned process has not been verified exited; an agent requests this with tower-crane ask or a task note`);
    const recovery = exited ? { pid: exited.pid, log: exited.log, code: exited.code, size: exited.size } : null;
    const holder = t.claim.agent;
    t.status = t.claim.from || 'todo';
    t.claim = null;
    note(t, ctx.agent, `released claim held by ${holder}: ${reason}`);
    if (recovery) note(t, ctx.agent, `exited spawn: pid ${recovery.pid}; log: ${recovery.log || '(none)'}; exit code: ${recovery.code ?? 'unknown'}; size: ${recovery.size ?? 'unknown'} bytes`);
    emit(t.id, { reason, holder, status: t.status, ...(recovery ? { exited_spawn: recovery } : {}) });
    return t;
  });
  return { data: task, text: `released ${task.id}; it is ${task.status} again` };
}

function inspectPullRequest(ctx, project, pr) {
  const args = ['pr', 'view', String(pr)];
  if (project.repo) args.push('-R', project.repo);
  args.push('--json', 'state,headRefName');
  const result = cp.spawnSync('gh', args, {
    cwd: ctx.cwd,
    env: { ...process.env, ...ctx.env, GH_PROMPT_DISABLED: '1' },
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    let detail;
    if (result.error?.code === 'ENOENT') detail = 'gh not found on PATH; install the GitHub CLI and run gh auth login';
    else if (result.error?.code === 'ETIMEDOUT') detail = 'timed out after 60 seconds';
    else {
      detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
      if (!detail) detail = `exit ${result.status}`;
    }
    throw refuse(`could not check existing PR #${pr} before submitting: ${detail}`);
  }
  let pullRequest;
  try {
    pullRequest = JSON.parse(result.stdout);
  } catch (e) {
    throw refuse(`could not read gh pr view ${pr} output: ${e.message}`);
  }
  if (!pullRequest || !['OPEN', 'CLOSED', 'MERGED'].includes(pullRequest.state)
    || (pullRequest.state === 'OPEN' && (typeof pullRequest.headRefName !== 'string' || !pullRequest.headRefName))) {
    throw refuse(`could not read state and head branch from gh pr view ${pr} output`);
  }
  return pullRequest;
}

function submit(ctx) {
  const f = ctx.flags;
  if (!f.sha) throw usage('submit needs --sha with the commit to review');
  if (!SHA_RE.test(f.sha)) throw usage(`--sha must be a commit hash (7 to 64 hex characters), got "${f.sha}"`);
  if (f.pr !== undefined && f.pr < 1) throw usage('--pr must be a pull request number');
  let previousPr;
  let previousBranch;
  let previousTaskId;
  let submittedBranch = f.branch;
  const branchOrPrSupplied = f.branch !== undefined || f.pr !== undefined;
  if (branchOrPrSupplied) {
    const before = S.loadState(ctx.stateDir);
    const previousTask = getTask(before, ctx.pos[0]);
    previousTaskId = previousTask.id;
    previousPr = previousTask.pr;
    previousBranch = previousTask.branch;
    if (previousPr) {
      const oldPullRequest = inspectPullRequest(ctx, before.project, previousPr);
      const submittedPr = f.pr === undefined ? previousPr : f.pr;
      const prChanged = submittedPr !== previousPr;
      if (oldPullRequest.state === 'OPEN' && prChanged) {
        const branch = f.branch === undefined ? '' : ` and branch "${f.branch}"`;
        throw refuse(`${previousTask.id} already has open PR #${previousPr} from branch "${oldPullRequest.headRefName}"; refusing PR #${submittedPr}${branch}. Close PR #${previousPr} before changing the PR`);
      }
      if (oldPullRequest.state === 'OPEN' && f.branch !== undefined && f.branch !== oldPullRequest.headRefName) {
        throw refuse(`${previousTask.id} already has open PR #${previousPr} from branch "${oldPullRequest.headRefName}"; refusing submitted branch "${f.branch}". Reuse that branch or close PR #${previousPr} before submitting a new branch`);
      }
      if (prChanged) {
        const newPullRequest = inspectPullRequest(ctx, before.project, submittedPr);
        if (typeof newPullRequest.headRefName !== 'string' || !newPullRequest.headRefName) {
          throw refuse(`could not read head branch from new PR #${submittedPr}`);
        }
        if (f.branch !== undefined && f.branch !== newPullRequest.headRefName) {
          throw refuse(`${previousTask.id} PR #${submittedPr} has head branch "${newPullRequest.headRefName}"; submitted branch "${f.branch}" does not match the new PR`);
        }
        submittedBranch = newPullRequest.headRefName;
      }
    }
  }
  const task = S.mutate(ctx, 'submit', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (branchOrPrSupplied && (t.pr !== previousPr || t.branch !== previousBranch)) {
      throw refuse(`${previousTaskId}'s branch or PR changed while checking GitHub; retry the submit`);
    }
    if (t.status === 'submitted') {
      // Submission clears the lease, so submitted_by preserves who may replace the head.
      if (t.submitted_by !== ctx.agent) throw refuse(`only the submitter (${t.submitted_by}) can resubmit ${t.id}; you are ${ctx.agent}`);
    } else {
      requireClaimant(t, ctx.agent, 'submit');
    }
    const previousSha = t.sha;
    const previousClaim = t.claim;
    t.status = 'submitted';
    t.sha = f.sha.toLowerCase();
    if (submittedBranch !== undefined) t.branch = submittedBranch;
    if (f.pr !== undefined) t.pr = f.pr;
    t.submitted_by = ctx.agent;
    t.claim = null;
    if (f.summary) note(t, ctx.agent, `submitted: ${f.summary}`);
    const spawned = st.events.some((e) => e.cmd === 'spawn' && e.task === t.id && e.detail.agent === ctx.agent);
    emit(t.id, { previous_sha: previousSha, sha: t.sha, branch: t.branch, pr: t.pr, summary: f.summary || null,
      ...(spawned && previousClaim ? { claim: previousClaim } : {}) });
    return t;
  });
  return { data: task, text: `submitted ${task.id} at ${task.sha.slice(0, 7)}` };
}

async function evidence(ctx) {
  const f = ctx.flags;
  if (!S.EVIDENCE_TYPES.includes(f.type)) throw usage(`--type must be one of ${S.EVIDENCE_TYPES.join(', ')}`);
  if (!!f.ok === !!f.fail) throw usage('evidence needs exactly one of --ok or --fail');
  if (SOFTWARE_GATES.includes(f.type)) {
    const command = f.type === 'merge' ? 'merge' : `check ${f.type}`;
    throw refuse(`only tower-crane ${command} records ${f.type} evidence; run that command for ${ctx.pos[0]}`);
  }
  // A worker can move the submitted head while a reviewer is still working.
  if (f.type === 'review' && f.sha === undefined) throw usage('review evidence needs --sha with the commit reviewed');
  if (f.sha !== undefined && !SHA_RE.test(f.sha)) throw usage(`--sha must be a commit hash (7 to 64 hex characters), got "${f.sha}"`);
  const entry = S.mutate(ctx, 'evidence', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    const sha = f.sha ? f.sha.toLowerCase() : t.sha;
    if (!sha) throw refuse(`${t.id} has no submitted sha yet; pass --sha for the commit this evidence is about`);
    const e = { type: f.type, ok: !!f.ok, sha, agent: ctx.agent, at: nowIso(), summary: f.summary || null, ref: f.ref || null, revision: t.revision };
    t.evidence.push(e);
    emit(t.id, { type: e.type, ok: e.ok, sha: e.sha });
    return { task: t.id, ...e };
  });
  if (entry.type === 'review' && !entry.ok) await require('./escalation').recover({ ...ctx, pos: [entry.task], flags: {} });
  return { data: entry, text: `${entry.task}: ${entry.type} ${entry.ok ? 'ok' : 'FAIL'} at ${entry.sha.slice(0, 7)} by ${entry.agent}` };
}

async function accept(ctx) {
  const f = ctx.flags;
  const waive = asList(f.waive);
  for (const w of waive) if (!GATE_TYPES.includes(w)) throw usage(`--waive must be one of ${GATE_TYPES.join(', ')}, got "${w}"`);
  if (waive.length && !(f.reason || '').trim()) throw usage('--waive needs --reason saying why the gate does not apply');
  if (waive.length && (ctx.agent !== 'owner' || !ctx.agentExplicit)) throw refuse('only the owner can waive a gate; an agent requests this with tower-crane ask or a task note');
  let st = S.loadState(ctx.stateDir);
  let task = getTask(st, ctx.pos[0]);
  if (task.status !== 'submitted') throw refuse(`${task.id} is ${task.status}; only submitted tasks can be accepted`);
  const original = { sha: task.sha, revision: task.revision };
  for (const type of requiredGates(task).filter((g) => g !== 'review' && !waive.includes(g))) {
    const entry = latestGateEvidence(task, type, st.events);
    const attempted = task.evidence.some((e) => e.type === type && e.revision === task.revision && shaMatch(e.sha, task.sha));
    if (!entry && !attempted && (type !== 'tests' || f.cmd || require('./tests-policy').resolve(st.project, task.kind).mode === 'none')) {
      await require('./check').runGate({ ...ctx, flags: type === 'tests' ? { cmd: f.cmd, 'proof-cmd': f['proof-cmd'] } : {} }, type);
      st = S.loadState(ctx.stateDir);
      task = getTask(st, task.id);
      if (task.sha !== original.sha || task.revision !== original.revision || task.status !== 'submitted') {
        throw refuse(`${task.id} changed while its software gates ran; retry accept`);
      }
    }
    const gate = gateReport(task, st.events, st).gates.find((g) => g.type === type);
    if (!gate?.ok) break;
  }
  const software = require('./reviewer').softwareReport(st, task);
  const passed = software.gates.every((g) => g.ok || waive.includes(g.type));
  const review = task.evidence.some((e) => e.type === 'review' && e.revision === task.revision && shaMatch(e.sha, task.sha));
  if (passed && !review && !waive.includes('review')) {
    // A waiver stays atomic with acceptance; it cannot authorize a dispatch
    // that a refused accept would leave without an audit record.
    if (!software.ok) throw refuse(`${task.id}: software gates must pass before review dispatch; this accept's waivers are recorded only with acceptance`);
    const active = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'reviewer'
      && e.detail.sha === task.sha && e.detail.revision === task.revision && !require('./spawn-session').exitedAttempt(e, st.events));
    const started = active ? { data: active.detail } : await require('./spawn').spawn({ ...ctx, pos: [], flags: { task: task.id, role: 'review' } });
    return { data: { ...task, review_pending: true, reviewer: started.data.agent }, text: `${task.id}: software gates passed; review pending with ${started.data.agent}` };
  }
  const result = S.mutate(ctx, 'accept', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (t.status !== 'submitted') throw refuse(`${t.id} is ${t.status}; only submitted tasks can be accepted`);
    if (t.sha !== original.sha || t.revision !== original.revision) throw refuse(`${t.id} changed while accepting; retry accept`);
    for (const type of waive) {
      t.evidence.push({ type, ok: true, waived: true, sha: t.sha, agent: ctx.agent, at: nowIso(), summary: f.reason.trim(), ref: null, revision: t.revision });
    }
    const report = gateReport(t, st.events, st);
    if (!report.ok) throw refuse(`${t.id} cannot be accepted yet: ${report.missing.join('; ')}`);
    t.status = 'accepted';
    emit(t.id, { sha: t.sha, revision: t.revision, standards: st.project.standards, waived: waive });
    return { task: t, report };
  });
  return { data: result.task, text: `accepted ${result.task.id} at ${result.task.sha.slice(0, 7)} (${result.report.gates.map((g) => `${g.type} ${g.reason}`).join(', ')})` };
}

function appendBriefNote(dir, t, line) {
  const file = briefPath(dir, t.id);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = `# ${t.id} ${t.title}\n`;
  }
  const headings = text.match(/^## .*$/gm) || [];
  text = text.replace(/\s*$/, '\n');
  if (headings[headings.length - 1] !== '## Rework notes') text += '\n## Rework notes\n\n';
  text += `- ${line}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  S.writeAtomic(file, text);
}

function rework(ctx) {
  const reason = (ctx.flags.reason || '').trim();
  if (!reason) throw usage('rework needs --reason saying what to fix');
  const task = S.mutate(ctx, 'rework', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (t.status !== 'submitted' && t.status !== 'accepted') throw refuse(`${t.id} is ${t.status}; only submitted or accepted tasks can be sent back`);
    t.status = 'rework';
    t.claim = null;
    note(t, ctx.agent, `rework: ${reason}`);
    appendBriefNote(st.dir, t, `${shortTime(nowIso())} ${ctx.agent}: ${reason}`);
    emit(t.id, { reason, sha: t.sha });
    return t;
  });
  return { data: task, text: `${task.id} sent back for rework` };
}

function recordSpend(t, entry, old, emit, project) {
  if (entry.model) entry.model = L.modelIdentity(entry.model);
  entry.cost_usd = entry.model ? require('./reviewer').cost(entry, project.review?.prices?.[entry.model]) : null;
  t.spend.entries ||= [];
  if (old) t.spend.entries.splice(t.spend.entries.indexOf(old), 1);
  t.spend.entries.push(entry);
  t.spend.minutes += entry.minutes - (old?.minutes || 0);
  t.spend.tokens += (entry.tokens || 0) - (old?.tokens || 0);
  for (const k of ['input', 'cached', 'output']) if (entry[k] !== null) t.spend[k] = (t.spend[k] || 0) + entry[k] - (old?.[k] || 0);
  emit(t.id, entry, 'spend');
}

function collectSpawn(st, emit, ev) {
  const t = getTask(st, ev.task);
  if (P.supervised(st, t, st.events) && P.runPhase(st, t)?.agent === ev.detail.agent) throw refuse(`${ev.detail.agent} is still supervised`);
  const sessions = require('./spawn-session');
  if (!sessions.exitedAttempt(ev, st.events)) throw refuse(`${ev.detail.agent} is still running or its exit is unverified; wait for its exit, then retry tower-crane spend ${ev.task} --from-spawn ${ev.detail.agent}`);
  const next = st.events.findIndex((e, i) => i > st.events.indexOf(ev) && e.cmd === 'spawn'
    && e.task === ev.task && e.detail.agent === ev.detail.agent);
  const boundaries = st.events.slice(st.events.indexOf(ev) + 1, next < 0 ? st.events.length : next)
    .filter((e) => (e.cmd === 'spawn fallback' || e.cmd === 'spawn retry' && e.detail.fresh)
      && e.task === ev.task && e.detail.agent === ev.detail.agent
      && e.detail.attempt === ev.detail.attempt);
  const segments = [ev, ...boundaries];
  for (let i = 0; i < segments.length; i++) {
    collectRoute(st, emit, t, { ...segments[i], detail: {
      ...segments[i].detail, ...(segments[i + 1] ? { log_end: segments[i + 1].detail.log_start } : {}),
    } }, ev);
  }
}

function collectRoute(st, emit, t, ev, dispatch) {
  const source = `spawn:${ev.detail.agent}${dispatch.detail.resumed ? `:attempt:${dispatch.detail.attempt}` : ''}${ev.detail.route_index ? `:route:${ev.detail.route_index}` : ''}${ev.cmd === 'spawn retry' ? `:retry:${ev.detail.retry}` : ''}`;
  const old = (t.spend.entries || []).find((e) => e.source === source);
  const sessions = require('./spawn-session');
  const session = sessions.logReader(ev.detail.log, ev.detail.harness, ev.detail.log_start || 0, ev.detail.log_end)(true);
  if (session) sessions.receipt(st, emit, ev.task, ev.detail, session);
  let parsed = require('./usage-files').readUsage(ev.detail);
  if (parsed && ev.detail.resumed && ev.detail.harness === 'codex') {
    const baseline = ev.detail.usage_before;
    if (!baseline) parsed = null;
    else {
      parsed = { ...parsed };
      for (const key of ['tokens', 'input', 'cached', 'output']) {
        parsed[key] = parsed[key] !== null && baseline[key] !== null && parsed[key] >= baseline[key]
          ? parsed[key] - baseline[key] : null;
      }
      if (parsed.tokens === null) parsed = null;
    }
  }
  if (old && !parsed) return;
  const entry = {
    at: nowIso(), agent: ev.detail.agent, minutes: 0, tokens: null, input: null, cached: null, output: null,
    ...parsed, rung: ev.detail.rung || null, harness: ev.detail.harness,
    model: parsed?.model || old?.model || ev.detail.model || null, profile: ev.detail.profile || null,
    source,
  };
  if (old) {
    for (const key of ['tokens', 'input', 'cached', 'output']) if (entry[key] === null) entry[key] = old[key];
    if (['tokens', 'input', 'cached', 'output', 'model'].every((key) => entry[key] === old[key])) return;
  }
  recordSpend(t, entry, old, emit, st.project);
}

function spend(ctx) {
  const f = ctx.flags;
  if (!f['from-spawn'] && f.minutes === undefined && f.tokens === undefined) throw usage('spend needs --minutes N and/or --tokens N, or --from-spawn AGENT');
  for (const k of ['minutes', 'tokens', 'input', 'cached', 'cache-write', 'output']) {
    if (f[k] !== undefined && (!Number.isSafeInteger(f[k]) || f[k] < 0)) throw usage(`--${k} must be a non-negative safe integer`);
  }
  if (['input', 'cached', 'cache-write', 'output'].some((k) => f[k] !== undefined) && f.tokens === undefined) throw usage('token breakdown needs --tokens N');
  if (f['cache-write'] !== undefined && (f.input === undefined || (f.cached || 0) + f['cache-write'] > f.input)) throw usage('--cached plus --cache-write cannot exceed --input');
  if (f.cached !== undefined && f.input !== undefined && f.cached > f.input) throw usage('--cached cannot exceed --input');
  if (f.tokens !== undefined && (f.input || 0) + (f.output || 0) > f.tokens) throw usage('--input plus --output cannot exceed --tokens');
  if (f.cached !== undefined && f.tokens !== undefined && f.cached > f.tokens) throw usage('--cached cannot exceed --tokens');
  if (f.rung !== undefined && !L.RUNGS.includes(f.rung)) throw usage(`--rung must be one of ${L.RUNGS.join(', ')}`);
  if (f.harness !== undefined && !L.HARNESSES.includes(f.harness)) throw usage(`--harness must be one of ${L.HARNESSES.join(', ')}`);
  if (f.model !== undefined && !f.model.trim()) throw usage('--model cannot be empty');
  if (f['from-spawn'] && ['minutes', 'tokens', 'input', 'cached', 'cache-write', 'output', 'rung', 'harness', 'model'].some((k) => f[k] !== undefined)) throw usage('--from-spawn cannot be combined with manual spend');
  const task = S.mutate(ctx, 'spend', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    let entry;
    if (f['from-spawn']) {
      const ev = st.events.findLast((e) => e.cmd === 'spawn' && e.task === t.id && e.detail?.agent === f['from-spawn']);
      if (!ev) throw refuse(`no spawn ${f['from-spawn']} on ${t.id}`);
      require('./events').observe(st, emit, ev, ctx);
      return t;
    } else {
      const rung = f.rung ? L.rungOf(L.resolve(st.project, ctx.env), f.rung) : {};
      entry = {
        at: nowIso(), agent: ctx.agent, minutes: f.minutes || 0, tokens: f.tokens ?? null,
        input: f.input ?? null, cached: f.cached ?? null, output: f.output ?? null,
        ...(f['cache-write'] !== undefined ? { cache_write: f['cache-write'] } : {}),
        rung: f.rung || null, harness: f.harness || rung.harness || null,
        model: f.model || rung.model || null, profile: rung.profile || null, source: 'manual',
      };
    }
    recordSpend(t, entry, null, emit, st.project);
    return t;
  });
  const missing = (task.spend.entries || []).filter((e) => e.tokens === null && e.source.startsWith('spawn:')).length;
  return { data: { id: task.id, spend: task.spend }, text: `${task.id}: ${task.spend.minutes} min, ${task.spend.tokens} tokens${missing ? `; ${missing} spawn(s) without usage` : ''}` };
}

function ownerDone(ctx) {
  if (ctx.agent !== 'owner' || !ctx.agentExplicit) throw refuse('only the owner can clear needs_owner; an agent requests this with tower-crane ask or a task note');
  const task = S.mutate(ctx, 'owner-done', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (!t.needs_owner) throw refuse(`${t.id} is not waiting on the owner`);
    const was = t.needs_owner;
    t.needs_owner = null;
    note(t, ctx.agent, `owner done: ${was}${ctx.flags.note ? `; ${ctx.flags.note}` : ''}`);
    emit(t.id, { was, note: ctx.flags.note || null });
    return t;
  });
  return { data: task, text: `${task.id} no longer waits on the owner` };
}

module.exports = {
  SIZE_HOURS, GATE_TYPES, normId, getTask, briefPath, leaseExpired, effectiveStatus, blockReasons, isReady, readyTasks,
  blockedTasks, displayStatus, requiredGates, latestGateEvidence, gateReport, planIssues, findCycles, unblockCounts, describeTask, checkWorkers, workerHolders,
  taskAdd, taskUpdate, setTiers, taskNote, taskShow, taskList, planImport, briefSet, briefGet, validate,
  ready, claim, renew, release, submit, evidence, accept, rework, spend, collectSpawn, ownerDone,
};
