'use strict';

const { refuse, usage, nowIso, byId } = require('./util');
const S = require('./state');
const T = require('./tasks');

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
    answered_by: null,
    answered_at: null,
  };
  st.decisions.next += 1;
  st.decisions.decisions.push(d);
  emit(null, { decision: d.id, question, blocks: d.blocks }, 'ask');
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
  const decision = S.mutate(ctx, 'ask', (st, emit) => {
    const blocks = asList(f.blocks).map((id) => T.getTask(st, id).id);
    return create(st, emit, ctx.agent, { question, options, blocks, recommendation: f.recommend, why: f.why });
  });
  return { data: decision, text: decision.id };
}

function answer(ctx) {
  const choice = (ctx.flags.choice || '').trim();
  if (!choice) throw usage('answer needs --choice');
  const decision = S.mutate(ctx, 'answer', (st, emit) => {
    const d = getDecision(st, ctx.pos[0]);
    if (d.status === 'answered') throw refuse(`${d.id} is already answered (${d.answer}); open a new decision with tower-crane ask to change course`);
    // An escalation is the owner's call; anyone else answering it would read as the owner's approval.
    if (d.escalation && require('./authority').actor(ctx, st.events) !== 'owner') throw refuse(`${d.id} escalates ${d.escalation.settings.join(', ')} to the owner; only the owner answers it`);
    if (d.options.length && !d.options.includes(choice)) {
      throw refuse(`--choice must be one of ${d.options.join(', ')} for ${d.id}`);
    }
    d.status = 'answered';
    d.answer = choice;
    d.note = ctx.flags.note !== undefined ? ctx.flags.note : null;
    d.answered_by = ctx.agent;
    d.answered_at = nowIso();
    // Workers read task notes, so the answer travels with each task it unblocks.
    for (const id of d.blocks) {
      const t = st.tasks.tasks.find((x) => x.id === id);
      if (t) t.notes.push({ at: d.answered_at, agent: ctx.agent, text: `decision ${d.id} answered: ${choice}${d.note ? ` (${d.note})` : ''}` });
    }
    emit(null, { decision: d.id, choice, note: d.note, blocks: d.blocks });
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

module.exports = { create, ask, answer, list, comment, getDecision, line };
