'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { GishraError, refuse, usage } = require('./util');
const S = require('./state');
const R = require('./render');
const L = require('./ladder');
const P = require('./project');
const T = require('./tasks');
const D = require('./decisions');
const { renderSettings, nav } = require('./settings');

const WATCHED = ['tasks.json', 'decisions.json', 'project.json', 'events.jsonl'];
const RELOAD = `<meta name="gishra-token" content="__GISHRA_TOKEN__">
<style>
.owner-actions { padding: 16px; }
.owner-actions form { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; align-items: center; }
.owner-actions label { flex: 1; min-width: 180px; }
.owner-actions input, .owner-actions select, .owner-actions button { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; }
.owner-actions input { width: 100%; }
.owner-actions button { cursor: pointer; font-weight: 600; }
.owner-actions button:hover { border-color: var(--fg); }
.owner-actions :focus-visible { outline: 2px solid var(--in_progress); outline-offset: 2px; }
.owner-actions output { color: var(--muted); }
.owner-actions li { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
<script>
const reloads = new EventSource("events");
reloads.addEventListener("reload", function () {
  if (!document.querySelector("form[data-api]:focus-within")) location.reload();
});
document.addEventListener("submit", async function (event) {
  const form = event.target;
  if (!form.dataset.api) return;
  event.preventDefault();
  const output = form.querySelector("output");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch(form.dataset.api, { method: "POST", headers: { "content-type": "application/json", "x-gishra-token": document.querySelector('meta[name="gishra-token"]').content }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    location.reload();
  } catch (error) {
    output.textContent = error.message;
    button.disabled = false;
  }
});
</script>\n`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function form(url, fields, button) {
  return `<form data-api="${url}">${fields}<button type="submit">${button}</button><output role="status"></output></form>`;
}

function ownerActions(st, canWrite) {
  const tasks = canWrite ? st.tasks.tasks.map((t) => {
    const base = `/api/tasks/${t.id}`;
    return `<h3>${esc(t.id)} ${esc(t.title)}</h3>` +
      form(`${base}/comments`, '<label>Comment<input name="text" required></label>', 'Comment') +
      (t.needs_owner ? form(`${base}/owner-done`, `<label>${esc(t.needs_owner)}<input name="note" placeholder="What was done"></label>`, 'Mark done') : '');
  }).join('') : '';
  const decisions = canWrite ? st.decisions.decisions.map((d) => {
    const base = `/api/decisions/${d.id}`;
    const choice = d.options.length ? `<select name="choice">${d.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>` : '<input name="choice" required>';
    return `<h3>${esc(d.id)} ${esc(d.question)}</h3>` +
      form(`${base}/comments`, '<label>Comment<input name="text" required></label>', 'Comment') +
      (d.status === 'open' ? form(`${base}/answer`, `<label>Answer ${choice}</label><label>Context<input name="note"></label>`, 'Answer') : `<p>Answered: ${esc(d.answer)}</p>`);
  }).join('') : '';
  const messages = S.readEvents(st.dir).filter((e) => e.cmd === 'msg' || ['task note', 'decision note'].includes(e.cmd)).slice(-20);
  return (canWrite ? `<section><h2>Owner actions</h2><div class="card owner-actions">${tasks}${decisions}</div></section>` : '') + `
<section><h2>Messages and comments</h2><div class="card owner-actions"><ul>${messages.map((e) => `<li>${esc(e.agent)}${e.task ? ` on ${esc(e.task)}` : ''}${e.detail.decision ? ` on ${esc(e.detail.decision)}` : ''}${e.detail.to ? ` to ${esc(e.detail.to)}` : ''}: ${esc(e.detail.text)}</li>`).join('')}</ul></div></section>`;
}

function ownerWrite(url) {
  const route = /^\/api\/(tasks|decisions)\/([TD]\d+)\/(comments|answer|owner-done)$/.exec(url);
  if (!route || (route[1] === 'tasks' && route[3] === 'answer') || (route[1] === 'decisions' && route[3] === 'owner-done')) {
    return null;
  }
  return (ctx, body) => {
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.values(body).some((v) => typeof v !== 'string')) throw usage('body must contain string fields');
    const actor = { ...ctx, flags: {}, pos: [route[2]] };
    let result;
    if (route[3] === 'comments') {
      actor.pos.push(body.text || '');
      result = route[1] === 'tasks' ? T.taskNote(actor) : D.comment(actor);
    } else if (route[3] === 'answer') {
      actor.flags = { choice: body.choice, note: body.note };
      result = D.answer(actor);
    } else {
      actor.flags = { note: body.note };
      result = T.ownerDone(actor);
    }
    return result.data;
  };
}

function signature(dir) {
  return WATCHED.map((f) => {
    try {
      const s = fs.statSync(path.join(dir, f));
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return '-';
    }
  }).join('|');
}

// The signature as an opaque token, for the page: it travels in reload
// events and save replies.
const version = (dir) => crypto.createHash('sha256').update(signature(dir)).digest('hex').slice(0, 16);

const BODY_LIMIT = 64 * 1024;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Pages are rendered from the state on each request rather than read from
// sketch.html, so a reload never races the CLI's own re-render.
function page(dir, draw) {
  try {
    return { code: 200, body: draw(S.loadState(dir)) };
  } catch (e) {
    return { code: 500, body: `<!doctype html><meta charset="utf-8"><title>gishra</title>${RELOAD}<pre>${String(e.message).replace(/</g, '&lt;')}</pre>` };
  }
}

// The Settings form sends every field of a rung it changed; an empty field
// is cleared. The patch is built by the same function ladder set uses. base
// is the default harness and each sent rung's own fields as the page loaded
// them; the write is refused if any changed since, because the form's other
// fields would silently undo that change.
function saveLadder(ctx, body) {
  if (!isObject(body) || Object.keys(body).some((k) => !['harness', 'rungs', 'base'].includes(k))) throw usage('send { "harness", "rungs", "base" }');
  const base = body.base;
  if (!isObject(base) || typeof base.harness !== 'string' || (base.rungs !== undefined && !isObject(base.rungs))) {
    throw usage('send base: { "harness", "rungs" } as the page loaded them, so a change made elsewhere since is not overwritten');
  }
  const changes = {};
  if (body.harness !== undefined) {
    if (typeof body.harness !== 'string') throw usage('harness must be a string');
    changes.harness = body.harness;
  }
  if (body.rungs !== undefined) {
    if (!isObject(body.rungs)) throw usage('rungs must be an object of rung fields');
    changes.rungs = {};
    for (const [name, fields] of Object.entries(body.rungs)) {
      if (!L.RUNGS.includes(name)) throw usage(`unknown rung "${name}"; the rungs are ${L.RUNGS.join(', ')}`);
      if (!isObject(fields)) throw usage(`ladder ${name}: send its fields as an object`);
      if (!base.rungs || !isObject(base.rungs[name])) throw usage(`ladder ${name}: send base.rungs.${name}, the rung as the page loaded it`);
      const values = {};
      const clear = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!L.FIELDS.includes(k)) throw usage(`ladder ${name}: unknown field ${k}; a rung takes ${L.FIELDS.join(', ')}`);
        if (typeof v === 'string' && v.trim() === '') clear.push(k);
        else values[k] = v;
      }
      try {
        changes.rungs[name] = P.rungPatch(values, clear, false);
      } catch (e) {
        e.message = `ladder ${name}: ${e.message}`;
        throw e;
      }
    }
  }
  if (changes.harness === undefined && !(changes.rungs && Object.keys(changes.rungs).length)) throw usage('nothing to save');
  // The reply is what gishra ladder show --json prints, so a page can redraw
  // from it without another request.
  changes.expect = { harness: base.harness, rungs: Object.fromEntries(Object.keys(changes.rungs || {}).map((n) => [n, base.rungs[n]])) };
  return { ok: true, ...P.showData(P.updateLadder(ctx, changes, 'serve')) };
}

// base holds each sent task's tier as the page loaded it, for the same reason
// as the ladder's.
function saveTiers(ctx, body) {
  if (!isObject(body) || !isObject(body.tiers) || !Object.keys(body.tiers).length) throw usage('send { "tiers": { "T1": "hard" }, "base": { "T1": "medium" } }');
  for (const [id, tier] of Object.entries(body.tiers)) {
    if (!L.TIERS.includes(tier)) throw usage(`${id}: tier must be one of ${L.TIERS.join(', ')}, got ${JSON.stringify(tier)}`);
    if (!isObject(body.base) || typeof body.base[id] !== 'string') throw usage(`${id}: send base.${id}, its tier as the page loaded it`);
  }
  return { ok: true, tiers: T.setTiers(ctx, body.tiers, 'serve', body.base) };
}

const POSTS = { '/api/ladder': saveLadder, '/api/tiers': saveTiers };

function reply(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data) + '\n');
}

function serve(ctx) {
  const dir = ctx.stateDir;
  S.loadState(dir);
  const port = ctx.flags.port !== undefined ? ctx.flags.port : 4747;
  if (port < 0 || port > 65535) throw usage('--port must be between 0 and 65535');
  const clients = new Set();
  // A fresh token per run, embedded in the Settings page and required on
  // every POST. Pages from other origins cannot read it, so they cannot
  // write the state through this server.
  const token = crypto.randomBytes(24).toString('hex');
  const writer = { ...ctx, flags: {}, pos: [] };
  const canWriteOwner = ctx.agent === 'owner' && ctx.agentExplicit;
  const local = () => {
    const p = server.address().port;
    return [`127.0.0.1:${p}`, `localhost:${p}`];
  };

  const post = (req, res, url) => {
    const owner = ownerWrite(url);
    const fn = POSTS[url] || owner;
    if (!fn) return reply(res, 404, { error: 'not found' });
    if (owner && !canWriteOwner) return reply(res, 403, { error: 'owner routes require serve to run with explicit owner identity' });
    const origin = req.headers.origin;
    if (origin !== undefined && !local().some((h) => origin === `http://${h}`)) return reply(res, 403, { error: 'requests from other origins are refused' });
    const given = Buffer.from(String(req.headers['x-gishra-token'] || ''));
    if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
      return reply(res, 403, { error: 'missing or wrong token; reload the Settings page' });
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reply(res, 415, { error: 'send application/json' });
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size <= BODY_LIMIT) chunks.push(d);
    });
    req.on('end', () => {
      if (size > BODY_LIMIT) return reply(res, 413, { error: `the body is over ${BODY_LIMIT} bytes` });
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return reply(res, 400, { error: `not valid JSON (${e.message})` });
      }
      try {
        // version lets the page tell the reload its own write causes from a
        // change made elsewhere.
        reply(res, 200, { ...fn(writer, body), version: version(dir) });
      } catch (e) {
        if (!(e instanceof GishraError)) return reply(res, 500, { error: e.message });
        reply(res, e.conflict ? 409 : e.code === 3 ? 503 : 400, { error: e.message });
      }
    });
  };

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    // A name rebound to 127.0.0.1 arrives with its own Host header; refusing
    // it keeps another site from reading the page and its token.
    if (!local().includes(String(req.headers.host || '').toLowerCase())) return reply(res, 403, { error: 'forbidden host' });
    if (req.method === 'POST') return post(req, res, url);
    if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed; use GET or POST' });
    if (url === '/' || url === '/sketch.html' || url === '/settings') {
      const p = url === '/settings'
        ? page(dir, (st) => renderSettings(st, token, version(dir)))
        : page(dir, (st) => R.renderHtml(st, Date.now(), RELOAD.replace('__GISHRA_TOKEN__', token), nav('sketch')).replace('</main>', ownerActions(st, canWriteOwner) + '\n</main>'));
      res.writeHead(p.code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(p.body);
    } else if (url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
    }
  });

  let last = signature(dir);
  let timer = null;
  const check = () => {
    const sig = signature(dir);
    if (sig === last) return;
    last = sig;
    const data = JSON.stringify({ version: version(dir) });
    for (const res of clients) res.write(`event: reload\ndata: ${data}\n\n`);
  };
  // Renames replace the files, so watch the directory and debounce bursts.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 60);
  };
  let watcher = null;
  let poll = null;
  const startPolling = () => {
    if (!poll) poll = setInterval(check, 1000);
  };
  try {
    watcher = fs.watch(dir, (event, name) => {
      if (!name || WATCHED.includes(String(name))) schedule();
    });
    watcher.on('error', startPolling);
  } catch {
    startPolling();
  }
  const keepAlive = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20000);

  // The watcher and timers keep the process alive, so every way out closes them.
  const quiet = () => {
    clearInterval(keepAlive);
    clearInterval(poll);
    clearTimeout(timer);
    if (watcher) watcher.close();
  };

  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      quiet();
      reject(e.code === 'EADDRINUSE' ? refuse(`port ${port} is in use; pass --port P (0 picks a free one)`) : e);
    });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      process.stdout.write(ctx.json ? JSON.stringify({ url, state: dir }) + '\n' : `serving ${url} (state ${dir}); Ctrl-C stops\n`);
      const stop = () => {
        quiet();
        for (const res of clients) res.end();
        server.close(() => resolve({ printed: true }));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });
}

module.exports = { serve };
