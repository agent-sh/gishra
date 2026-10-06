'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { refuse, usage, nowIso, shaMatch, shortTime, byId, readStdin } = require('./util');
const S = require('./state');

const SIZE_HOURS = { S: 1, M: 4, L: 8 };
const GATE_TYPES = ['tests', 'clean', 'review', 'ci'];
const SHA_RE = /^[0-9a-f]{7,64}$/i;

function normId(id, prefix) {
  const s = String(id || '').trim();
  return new RegExp(`^${prefix}\\d+$`, 'i').test(s) ? s.toUpperCase() : s;
}

function getTask(st, id) {
  const tid = normId(id, 'T');
  const task = st.tasks.tasks.find((t) => t.id === tid);
  if (!task) throw refuse(`no task ${id}; gishra task list shows the ids`);
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

function gateReport(task) {
  const sha7 = task.sha ? task.sha.slice(0, 7) : null;
  const gates = requiredGates(task).map((type) => {
    if (!task.sha) return { type, ok: false, reason: 'the task has no submitted sha' };
    const atSha = task.evidence.filter((e) => e.type === type && e.revision === task.revision && shaMatch(e.sha, task.sha));
    const counted = type === 'review' ? atSha.filter((e) => e.waived || e.agent !== task.submitted_by) : atSha;
    const latest = counted[counted.length - 1];
    if (!latest) {
      const reason = type === 'review' && atSha.length
        ? `only the submitter (${task.submitted_by}) reviewed; needs an ok review from another agent`
        : `no ${type} evidence at ${sha7} for revision ${task.revision}`;
      return { type, ok: false, reason };
    }
    if (!latest.ok) return { type, ok: false, reason: `latest ${type} at ${sha7} failed${latest.summary ? `: ${latest.summary}` : ''}` };
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

function checkRole(st, role) {
  if (!st.project.roles[role]) throw refuse(`role ${role} is not in project.json; add it with gishra role set ${role} --harness H`);
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
    role: fields.role || 'worker',
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

function taskAdd(ctx) {
  const f = ctx.flags;
  if (!f.title || !f.title.trim()) throw usage('task add needs --title');
  const acceptance = asList(f.acceptance);
  if (!acceptance.length) throw usage('task add needs at least one --acceptance line saying how to tell it is done');
  if (f.kind !== undefined) checkEnum('kind', f.kind, S.KINDS);
  if (f.size !== undefined) checkEnum('size', f.size, S.SIZES);
  const task = S.mutate(ctx, 'task add', (st, emit) => {
    checkRole(st, f.role || 'worker');
    const t = newTask(st, {
      title: f.title.trim(), kind: f.kind, acceptance, size: f.size, role: f.role,
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
  if (!Object.keys(f).length) throw usage('task update needs at least one change; see gishra task update --help');
  if (f.kind !== undefined) checkEnum('kind', f.kind, S.KINDS);
  if (f.size !== undefined) checkEnum('size', f.size, S.SIZES);
  if (f.status !== undefined && f.status !== 'cancelled') {
    throw usage('task update can only set --status cancelled; claim, submit, accept and rework move the other states');
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
    if (f.kind !== undefined && f.kind !== t.kind) material.push('kind');
    if (f.kind !== undefined) t.kind = changes.kind = f.kind;
    if (f.role !== undefined) {
      checkRole(st, f.role);
      t.role = changes.role = f.role;
    }
    if (f['needs-owner'] !== undefined) {
      const needsOwner = f['needs-owner'].trim() || null;
      // Updating the reason must not bypass owner-done's explicit owner check.
      if (t.needs_owner && needsOwner !== t.needs_owner && (ctx.agent !== 'owner' || !ctx.agentExplicit)) {
        throw refuse('only the owner can clear or replace needs_owner; an agent requests this with gishra ask or a task note');
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
      throw refuse(`${t.id} is accepted, so its ${material.join(' and ')} cannot change; send it back first with gishra rework ${t.id} --reason R`);
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

function taskNote(ctx) {
  const text = ctx.pos.slice(1).join(' ').trim();
  if (!text) throw usage('task note needs the note text: gishra task note T1 "what happened"');
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
    display,
    lease_expired: leaseExpired(t, now),
    blocked_by: ['todo', 'rework'].includes(effectiveStatus(t, now)) ? blockReasons(st, t) : [],
    gates: t.sha ? gateReport(t) : null,
  };
  return out;
}

function taskShow(ctx) {
  const st = S.loadState(ctx.stateDir);
  const now = Date.now();
  const t = getTask(st, ctx.pos[0]);
  const d = describeTask(st, t, now);
  const lines = [
    `${t.id}  ${t.title}`,
    `status: ${t.status}${display(d)}  kind: ${t.kind}  size: ${t.size}  role: ${t.role}  revision: ${t.revision}`,
  ];
  if (t.depends_on.length) {
    lines.push(`depends on: ${t.depends_on.map((id) => {
      const dep = st.tasks.tasks.find((x) => x.id === id);
      return `${id} (${dep ? dep.status : 'missing'})`;
    }).join(', ')}`);
  }
  if (t.needs_owner) lines.push(`needs owner: ${t.needs_owner}`);
  if (d.blocked_by.length) lines.push(`blocked: ${d.blocked_by.join('; ')}`);
  lines.push('acceptance:', ...t.acceptance.map((a) => `  - ${a}`));
  if (t.claim) lines.push(`claim: ${t.claim.agent} until ${shortTime(t.claim.until)}${d.lease_expired ? ' (expired)' : ''}`);
  if (t.branch || t.pr || t.sha) lines.push(`branch: ${t.branch || '-'}  pr: ${t.pr ? `#${t.pr}` : '-'}  sha: ${t.sha || '-'}${t.submitted_by ? `  submitted by ${t.submitted_by}` : ''}`);
  if (d.gates) lines.push(`gates: ${d.gates.gates.map((g) => `${g.type} ${g.ok ? 'ok' : 'missing'}`).join(', ')}`);
  if (t.evidence.length) {
    lines.push('evidence:');
    for (const e of t.evidence) {
      const stale = e.revision !== t.revision ? ` (revision ${e.revision}, does not count)` : '';
      lines.push(`  - ${e.type} ${e.waived ? 'waived' : e.ok ? 'ok' : 'FAIL'} at ${e.sha ? e.sha.slice(0, 7) : '-'} by ${e.agent} ${shortTime(e.at)}${stale}${e.summary ? `: ${e.summary}` : ''}`);
    }
  }
  if (t.notes.length) {
    lines.push('notes:');
    for (const n of t.notes) lines.push(`  - ${shortTime(n.at)} ${n.agent}: ${n.text}`);
  }
  lines.push(`spend: ${t.spend.minutes} min, ${t.spend.tokens} tokens`);
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

const PLAN_FIELDS = ['id', 'title', 'acceptance', 'kind', 'size', 'depends_on', 'role', 'needs_owner'];

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
      if (entry.role !== undefined) checkRole(st, entry.role);
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
        title: entry.title.trim(), acceptance, kind: entry.kind, size: entry.size, role: entry.role,
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
    throw refuse(`${t.id} has no brief; write one with gishra brief set ${t.id} --file F`);
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
    if (!t.acceptance.length) issues.push({ task: t.id, kind: 'no-acceptance', message: `${t.id} has no acceptance; add it with gishra task update ${t.id} --acceptance A` });
    if (t.size === 'L' && !t.notes.some((n) => /^split:/i.test(n.text.trim()))) {
      issues.push({ task: t.id, kind: 'unsplit', message: `${t.id} is size L; split it, or record why not with gishra task note ${t.id} "split: <reason>"` });
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

function validate(ctx) {
  const st = S.loadState(ctx.stateDir);
  const issues = planIssues(st);
  return {
    data: { ok: issues.length === 0, issues },
    text: issues.length ? issues.map((i) => i.message).join('\n') : `plan ok: ${st.tasks.tasks.length} tasks`,
    code: issues.length ? 1 : 0,
  };
}

// ---- Run ----

function ready(ctx) {
  const st = S.loadState(ctx.stateDir);
  const now = Date.now();
  const r = readyTasks(st, now);
  const data = {
    ready: r.map(({ task, unblocks }) => ({ id: task.id, title: task.title, kind: task.kind, size: task.size, role: task.role, status: effectiveStatus(task, now), unblocks })),
  };
  const lines = r.length
    ? r.map(({ task, unblocks }) => `${task.id.padEnd(5)} ${task.size} ${task.kind.padEnd(8)} ${task.title}${unblocks ? `  (unblocks ${unblocks})` : ''}${effectiveStatus(task, now) === 'rework' ? '  [rework]' : ''}`)
    : ['no task is ready'];
  if (ctx.flags.all) {
    const b = blockedTasks(st, now);
    data.blocked = b.map(({ task, reasons }) => ({ id: task.id, title: task.title, reasons }));
    if (b.length) lines.push('', 'blocked:', ...b.map(({ task, reasons }) => `${task.id.padEnd(5)} ${task.title}: ${reasons.join('; ')}`));
  }
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
      if (t.claim.agent === ctx.agent) throw refuse(`you already hold ${t.id}; extend it with gishra renew ${t.id}`);
      throw refuse(`${t.id} is claimed by ${t.claim.agent} until ${shortTime(t.claim.until)}; pick another task from gishra ready`);
    }
    const eff = effectiveStatus(t, now);
    if (eff !== 'todo' && eff !== 'rework') throw refuse(`${t.id} is ${eff}; only todo or rework tasks can be claimed`);
    const reasons = blockReasons(st, t);
    if (reasons.length) throw refuse(`${t.id} is blocked: ${reasons.join('; ')}`);
    checkWorkers(st, t, now, 'the workers limit is reached');
    const previous = t.status === 'in_progress' ? t.claim.agent : null;
    t.claim = { agent: ctx.agent, since: new Date(now).toISOString(), until: new Date(now + lease * 60000).toISOString(), from: eff };
    t.status = 'in_progress';
    emit(t.id, { until: t.claim.until, from: eff, ...(previous ? { took_over_from: previous } : {}) });
    return t;
  });
  return { data: task, text: `claimed ${task.id} for ${task.claim.agent} until ${shortTime(task.claim.until)}` };
}

// Workers are the tasks in progress at once: those with a live lease.
function checkWorkers(st, t, now, lead) {
  const active = st.tasks.tasks.filter((x) => x.id !== t.id && x.status === 'in_progress' && !leaseExpired(x, now)).length;
  if (active >= st.project.limits.workers) {
    throw refuse(`${lead} (${active} tasks in progress, limit ${st.project.limits.workers}); wait for one to finish or raise it with gishra project set --workers N`);
  }
}

function requireClaimant(t, agent, verb) {
  if (t.status !== 'in_progress' || !t.claim) throw refuse(`${t.id} is ${t.status}, not in progress; claim it with gishra claim ${t.id}`);
  if (t.claim.agent !== agent) throw refuse(`only the claimant (${t.claim.agent}) can ${verb} ${t.id}; you are ${agent}`);
}

function renew(ctx) {
  const task = S.mutate(ctx, 'renew', (st, emit) => {
    const now = Date.now();
    const t = getTask(st, ctx.pos[0]);
    requireClaimant(t, ctx.agent, 'renew');
    // An expired lease stopped counting toward the limit, so renewing it takes
    // a slot back like a new claim would.
    if (leaseExpired(t, now)) checkWorkers(st, t, now, `${t.id}'s lease expired and the workers limit is reached`);
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
    if (t.claim.agent !== ctx.agent && (ctx.agent !== 'owner' || !ctx.agentExplicit)) throw refuse(`only the claimant (${t.claim.agent}) or the owner can release ${t.id}; an agent requests this with gishra ask or a task note`);
    const holder = t.claim.agent;
    t.status = t.claim.from || 'todo';
    t.claim = null;
    note(t, ctx.agent, `released by ${holder}: ${reason}`);
    emit(t.id, { reason, holder, status: t.status });
    return t;
  });
  return { data: task, text: `released ${task.id}; it is ${task.status} again` };
}

function submit(ctx) {
  const f = ctx.flags;
  if (!f.sha) throw usage('submit needs --sha with the commit to review');
  if (!SHA_RE.test(f.sha)) throw usage(`--sha must be a commit hash (7 to 64 hex characters), got "${f.sha}"`);
  if (f.pr !== undefined && f.pr < 1) throw usage('--pr must be a pull request number');
  const task = S.mutate(ctx, 'submit', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (t.status === 'submitted') {
      // Submission clears the lease, so submitted_by preserves who may replace the head.
      if (t.submitted_by !== ctx.agent) throw refuse(`only the submitter (${t.submitted_by}) can resubmit ${t.id}; you are ${ctx.agent}`);
    } else {
      requireClaimant(t, ctx.agent, 'submit');
    }
    const previousSha = t.sha;
    t.status = 'submitted';
    t.sha = f.sha.toLowerCase();
    if (f.branch !== undefined) t.branch = f.branch;
    if (f.pr !== undefined) t.pr = f.pr;
    t.submitted_by = ctx.agent;
    t.claim = null;
    if (f.summary) note(t, ctx.agent, `submitted: ${f.summary}`);
    emit(t.id, { previous_sha: previousSha, sha: t.sha, branch: t.branch, pr: t.pr, summary: f.summary || null });
    return t;
  });
  return { data: task, text: `submitted ${task.id} at ${task.sha.slice(0, 7)}` };
}

function evidence(ctx) {
  const f = ctx.flags;
  if (!S.EVIDENCE_TYPES.includes(f.type)) throw usage(`--type must be one of ${S.EVIDENCE_TYPES.join(', ')}`);
  if (!!f.ok === !!f.fail) throw usage('evidence needs exactly one of --ok or --fail');
  // A worker can move the submitted head while a reviewer or checker is still working.
  if (f.type !== 'note' && f.sha === undefined) throw usage(`${f.type} evidence needs --sha with the commit reviewed or checked`);
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
  return { data: entry, text: `${entry.task}: ${entry.type} ${entry.ok ? 'ok' : 'FAIL'} at ${entry.sha.slice(0, 7)} by ${entry.agent}` };
}

function accept(ctx) {
  const f = ctx.flags;
  const waive = asList(f.waive);
  for (const w of waive) if (!GATE_TYPES.includes(w)) throw usage(`--waive must be one of ${GATE_TYPES.join(', ')}, got "${w}"`);
  if (waive.length && !(f.reason || '').trim()) throw usage('--waive needs --reason saying why the gate does not apply');
  if (waive.length && (ctx.agent !== 'owner' || !ctx.agentExplicit)) throw refuse('only the owner can waive a gate; an agent requests this with gishra ask or a task note');
  const result = S.mutate(ctx, 'accept', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (t.status !== 'submitted') throw refuse(`${t.id} is ${t.status}; only submitted tasks can be accepted`);
    for (const type of waive) {
      t.evidence.push({ type, ok: true, waived: true, sha: t.sha, agent: ctx.agent, at: nowIso(), summary: f.reason.trim(), ref: null, revision: t.revision });
    }
    const report = gateReport(t);
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

function spend(ctx) {
  const f = ctx.flags;
  if (f.minutes === undefined && f.tokens === undefined) throw usage('spend needs --minutes N and/or --tokens N');
  for (const k of ['minutes', 'tokens']) if (f[k] !== undefined && f[k] < 0) throw usage(`--${k} cannot be negative`);
  const task = S.mutate(ctx, 'spend', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    t.spend.minutes += f.minutes || 0;
    t.spend.tokens += f.tokens || 0;
    emit(t.id, { minutes: f.minutes || 0, tokens: f.tokens || 0 });
    return t;
  });
  return { data: { id: task.id, spend: task.spend }, text: `${task.id}: ${task.spend.minutes} min, ${task.spend.tokens} tokens` };
}

function ownerDone(ctx) {
  if (ctx.agent !== 'owner' || !ctx.agentExplicit) throw refuse('only the owner can clear needs_owner; an agent requests this with gishra ask or a task note');
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
  blockedTasks, displayStatus, requiredGates, gateReport, planIssues, findCycles, unblockCounts, describeTask,
  taskAdd, taskUpdate, taskNote, taskShow, taskList, planImport, briefSet, briefGet, validate,
  ready, claim, renew, release, submit, evidence, accept, rework, spend, ownerDone,
};
