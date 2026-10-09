'use strict';

const { refuse, usage, nowIso, byId } = require('./util');
const S = require('./state');
const T = require('./tasks');
const Authority = require('./authority');

function asList(v) {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
}

function getDecision(st, id) {
  const did = T.normId(id, 'D');
  const d = st.decisions.decisions.find((x) => x.id === did);
  if (!d) throw refuse(`no decision ${id}; tower-crane decisions lists them`);
  return d;
}

function line(d) {
  const opts = d.options.length ? ` [${d.options.map((o) => (o === d.recommendation ? `${o}*` : o)).join(' | ')}]` : '';
  const blocks = d.blocks.length ? ` blocks ${d.blocks.join(', ')}` : '';
  const ans = d.status === 'answered' ? ` -> ${d.answer}` : '';
  return `${d.id.padEnd(4)} ${d.status.padEnd(8)} ${d.question}${opts}${blocks}${ans}`;
}

function create(st, emit, agent, fields) {
  const { question, options = [], blocks = [] } = fields;
  const d = {
    id: `D${st.decisions.next}`,
    question,
    options,
    recommendation: fields.recommendation ?? null,
    why: fields.why ?? null,
    blocks: [...new Set(blocks)],
    status: 'open',
    answer: null,
    note: null,
    asked_by: agent,
    asked_at: nowIso(),
    answerers: [],
    technical: fields.technical ?? false,
    answered_by: null,
    answered_at: null,
    answer_rule: null,
  };
  if (fields.escalation) d.escalation = fields.escalation;
  st.decisions.next += 1;
  st.decisions.decisions.push(d);
  const detail = { decision: d.id, question, blocks: d.blocks };
  if (d.escalation) detail.escalation = d.escalation;
  emit(null, detail, 'ask');
  return d;
}

function ask(ctx) {
  const f = ctx.flags;
  const question = (f.question || '').trim();
  if (!question) throw usage('ask needs --question');
  const options = asList(f.option);
  if (new Set(options).size !== options.length) throw usage('--option values must be distinct');
  if (f.recommend !== undefined && options.length && !options.includes(f.recommend)) {
    throw usage(`--recommend must be one of the options (${options.join(', ')})`);
  }
  const settings = asList(f.setting);
  const unknown = settings.filter((key) => !Object.hasOwn(Authority.TABLE, key));
  if (unknown.length) throw usage(`--setting names no setting in lib/authority.js: ${unknown.join(', ')}`);
  const owner = settings.filter((key) => Authority.classOf(key) === Authority.OWNER);
  const decision = S.mutate(ctx, 'ask', (st, emit) => {
    const blocks = asList(f.blocks).map((id) => T.getTask(st, id).id);
    // A question that names an owner-required setting stays with the owner. A
    // verified worker or reviewer asks technically, so the orchestrator can answer
    // once the project's decision-delegation setting allows. Any other caller,
    // including an unverified one and the owner's terminal, keeps its question
    // with the owner.
    const escalation = owner.length ? { settings: owner, change: null } : null;
    const verified = Authority.actor(ctx, st.events) !== null;
    const technical = !escalation && verified && Authority.role(ctx, st.events) === null;
    return create(st, emit, ctx.agent, {
      question, options, blocks, recommendation: f.recommend, why: f.why, technical, escalation,
    });
  });
  return { data: decision, text: decision.id };
}

function answerersArg(text) {
  let answerers;
  try {
    answerers = JSON.parse(text);
  } catch {
    throw usage('--answerers must be a JSON array of distinct agent names');
  }
  if (!Array.isArray(answerers) || !answerers.every((agent) => typeof agent === 'string' && agent.trim())) {
    throw usage('--answerers must be a JSON array of distinct agent names');
  }
  answerers = answerers.map((agent) => agent.trim());
  if (new Set(answerers).size !== answerers.length) throw usage('--answerers must contain distinct agent names');
  if (answerers.some((agent) => ['owner', 'orchestrator'].includes(agent))) {
    throw usage('--answerers cannot include owner or orchestrator; they have separate answer rules');
  }
  return answerers;
}

function technicalArg(text) {
  let technical;
  try {
    technical = JSON.parse(text);
  } catch {
    throw usage('--technical must be true or false');
  }
  if (typeof technical !== 'boolean') throw usage('--technical must be true or false');
  return technical;
}

function delegate(ctx) {
  const f = ctx.flags;
  if (f.answerers === undefined && f.technical === undefined) {
    throw usage('decision delegate needs --answerers or --technical');
  }
  const answerers = f.answerers === undefined ? undefined : answerersArg(f.answerers);
  const technical = f.technical === undefined ? undefined : technicalArg(f.technical);
  const decision = S.mutate(ctx, 'decision delegate', (st, emit) => {
    // The verified identity decides, as for answers: a raw --agent owner from a worker is refused.
    if (Authority.actor(ctx, st.events) !== 'owner') {
      throw refuse('only the owner with an explicit identity can delegate decision answers; an agent requests this with tower-crane ask or a task note');
    }
    const d = getDecision(st, ctx.pos[0]);
    if (d.status !== 'open') throw refuse(`${d.id} is already answered; delegation cannot be changed`);
    if (answerers !== undefined) d.answerers = answerers;
    if (technical !== undefined) d.technical = technical;
    emit(null, { decision: d.id, answerers: d.answerers, technical: d.technical });
    return d;
  });
  return { data: decision, text: `${decision.id} answer delegation updated` };
}

function joinNames(names) {
  if (names.length < 2) return names[0] || '';
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

function answerRule(st, decision, ctx) {
  const identity = Authority.actor(ctx, st.events);
  const owner = identity === 'owner';
  const orchestrator = Authority.isOrchestrator(identity, st.events);
  if (decision.escalation && !owner) {
    throw refuse(`${decision.id} escalates ${decision.escalation.settings.join(', ')} to the owner; only the owner answers it`);
  }
  if (owner) return 'owner';
  const technicalDelegation = decision.technical === true
    && st.project.decision_delegation?.orchestrator_technical === true;
  if (orchestrator) {
    if (technicalDelegation) return 'owner-technical-delegation';
  } else if (identity && decision.answerers.includes(identity)) {
    return 'owner-named-agent';
  }

  const named = decision.answerers.filter((agent) => !Authority.isOrchestrator(agent, st.events));
  const allowed = ['the owner with explicit identity', ...named.map((agent) => `agent ${agent}`)];
  if (technicalDelegation) allowed.push('the orchestrator under technical delegation');
  throw refuse(`only ${joinNames(allowed)} can answer ${decision.id}`);
}

function answer(ctx) {
  const choice = (ctx.flags.choice || '').trim();
  if (!choice) throw usage('answer needs --choice');
  const decision = S.mutate(ctx, 'answer', (st, emit) => {
    const d = getDecision(st, ctx.pos[0]);
    const rule = answerRule(st, d, ctx);
    if (d.status === 'answered') throw refuse(`${d.id} is already answered (${d.answer}); open a new decision with tower-crane ask to change course`);
    if (d.options.length && !d.options.includes(choice)) {
      throw refuse(`--choice must be one of ${d.options.join(', ')} for ${d.id}`);
    }
    d.status = 'answered';
    d.answer = choice;
    d.note = ctx.flags.note !== undefined ? ctx.flags.note : null;
    d.answered_by = ctx.agent;
    d.answered_at = nowIso();
    d.answer_rule = rule;
    // Workers read task notes, so the answer travels with each task it unblocks.
    for (const id of d.blocks) {
      const t = st.tasks.tasks.find((x) => x.id === id);
      if (t) t.notes.push({ at: d.answered_at, agent: ctx.agent, text: `decision ${d.id} answered: ${choice}${d.note ? ` (${d.note})` : ''}` });
    }
    emit(null, {
      decision: d.id, choice, note: d.note, blocks: d.blocks,
      answered_by: d.answered_by, answer_rule: d.answer_rule,
    });
    return d;
  });
  return { data: decision, text: `${decision.id} answered: ${decision.answer}` };
}

function list(ctx) {
  const st = S.loadState(ctx.stateDir);
  const rows = [...st.decisions.decisions].sort(byId).filter((d) => !ctx.flags.open || d.status === 'open');
  return { data: rows, text: rows.length ? rows.map(line).join('\n') : ctx.flags.open ? 'no open decisions' : 'no decisions' };
}

function comment(ctx) {
  const text = ctx.pos.slice(1).join(' ').trim();
  if (!text) throw usage('decision note needs DID TEXT');
  const data = S.mutate(ctx, 'decision note', (st, emit) => {
    const d = getDecision(st, ctx.pos[0]);
    const entry = { at: nowIso(), agent: ctx.agent, text };
    (d.notes = d.notes || []).push(entry);
    emit(null, { decision: d.id, text, blocks: d.blocks });
    return entry;
  });
  return { data, text: `noted on ${ctx.pos[0]}` };
}

module.exports = { create, ask, answer, answerRule, delegate, list, comment, getDecision, line };
