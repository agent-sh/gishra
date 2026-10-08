'use strict';

const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const T = require('./tasks');
const { refuse, usage } = require('./util');

function binding(file) {
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[A-Za-z][\w.-]*$/.test(b.agent) || b.agent === 'owner' || !b.task || !b.state) throw refuse('invalid harness hook identity');
  const expected = path.join(b.state, 'homes', b.agent, 'hook.json');
  if (fs.realpathSync(file) !== fs.realpathSync(expected)) throw refuse('hook binding must be in its own agent home');
  return b;
}

function unread(events, agent) {
  const delivered = new Set(events.filter((e) => e.cmd === 'hook inbox' && e.agent === agent)
    .flatMap((e) => e.detail.messages));
  return events.filter((e) => e.cmd === 'msg' && e.detail.to === agent && !delivered.has(e.id));
}

function context(messages) {
  return messages.map((e) => `Message from ${e.agent}${e.task ? ` for ${e.task}` : ''}:\n${e.detail.text}`).join('\n\n');
}

function hook(ctx) {
  const b = binding(ctx.flags.binding);
  if (ctx.agent !== b.agent || path.resolve(ctx.stateDir) !== path.resolve(b.state)) {
    throw refuse('hook identity and state must match its agent home');
  }
  const action = ctx.pos[0];
  if (!['inbox', 'tool', 'report', 'stop', 'git-push', 'pr-created'].includes(action)) throw usage('unknown hook action');
  let payload = {};
  if (ctx.flags.payload !== undefined) payload = JSON.parse(ctx.flags.payload === '-' ? fs.readFileSync(0, 'utf8') : ctx.flags.payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw usage('hook payload must be an object');
  const data = S.mutate(ctx, `hook ${action}`, (st, emit) => {
    const task = T.getTask(st, b.task);
    const messages = action === 'inbox' || action === 'stop' && payload.hold !== false ? unread(st.events, b.agent)
      .filter((e) => !Array.isArray(payload.ids) || payload.ids.includes(e.id)) : [];
    const text = context(messages);
    if (messages.length && !(action === 'inbox' && payload.ack === false)) emit(task.id, { messages: messages.map((e) => e.id) }, 'hook inbox');
    if (action === 'stop' && messages.length && payload.hold !== false) return { block: true, context: text };
    if (action === 'tool') emit(task.id, { harness: b.harness, tool: String(payload.tool || 'tool') }, 'hook progress');
    // The binding is the agent's own, so a call with no push or PR behind it records the same event
    // as a shim call. Nothing checked the remote: consumers verify on GitHub or in the repository.
    if (['git-push', 'pr-created'].includes(action)) emit(task.id, { harness: b.harness, unverified: true }, `hook ${action}`);
    if (action === 'report' && typeof payload.report === 'string' && payload.report.trim()) {
      emit(task.id, { report: payload.report }, 'hook report');
    }
    if (action === 'stop') {
      const report = typeof payload.report === 'string' && payload.report.trim() ? payload.report
        : st.events.findLast((e) => e.task === task.id && e.agent === b.agent && ['hook report', 'hook stop'].includes(e.cmd))?.detail.report || '';
      const submitted = task.submitted_by === b.agent && ['submitted', 'accepted'].includes(task.status);
      const source = `hook-stop:${b.agent}:${b.attempt}`;
      const previous = st.events.findLast((e) => e.cmd === 'hook stop' && e.detail.source === source);
      if (!previous || previous.detail.report !== report || previous.detail.submitted !== submitted) {
        emit(task.id, { harness: b.harness, submitted, report, source }, 'hook stop');
        emit(task.id, { to: 'orchestrator', text: `${b.agent} stopped ${submitted ? 'after submit' : 'without submit'}.${report ? `\n${report}` : '\nNo final report captured.'}` }, 'msg');
      }
    }
    return { block: false, context: text, ...(action === 'inbox' ? { ids: messages.map((e) => e.id) } : {}) };
  });
  return { data, text: data.context };
}

module.exports = { hook, binding, unread, context };
