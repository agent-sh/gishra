'use strict';

// The Settings view gishra serve shows: the ladder and every task's tier, as
// forms that post back to serve. It reuses the sketch's tokens and layout.

const S = require('./state');
const T = require('./tasks');
const L = require('./ladder');
const R = require('./render');
const { byId, shortTime } = require('./util');

const esc = R.esc;

const COLUMNS = [
  ['harness', 'Harness'], ['model', 'Model'], ['profile', 'Profile'], ['provider', 'Provider'],
  ['effort', 'Effort'], ['args', 'Args'], ['command', 'Command'],
];

const CSS = `
input, select, button { font: inherit; font-size: 13px; color: var(--fg); }
input, select { width: 100%; min-width: 0; padding: 6px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
input { font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace; }
input::placeholder { color: var(--muted); opacity: 0.75; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
input:hover, select:hover { border-color: var(--edge); }
input.na:placeholder-shown { opacity: 0.5; }
select {
  appearance: none; padding-right: 26px; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 14px) 52%, calc(100% - 9px) 52%; background-size: 5px 5px; background-repeat: no-repeat;
}
[aria-invalid="true"] { border-color: var(--rework); }
.lead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 14px; border-bottom: 1px solid var(--border); }
.lead label { font-weight: 600; font-size: 14px; }
.lead select { width: 180px; }
.lead .hint { margin: 0; color: var(--muted); font-size: 13px; }
table.ladder { min-width: 1020px; table-layout: fixed; }
table.ladder th, table.ladder td { padding: 8px 6px; vertical-align: middle; }
table.ladder th:first-child, table.ladder td:first-child { padding-left: 14px; }
table.ladder th:last-child, table.ladder td:last-child { padding-right: 14px; }
th.rowh { text-transform: none; letter-spacing: 0; color: var(--fg); font-size: 14px; white-space: normal; box-shadow: inset 3px 0 0 transparent; }
th.rowh .rung { font: 600 13px ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace; }
th.rowh .use { display: block; color: var(--muted); font-weight: 400; font-size: 12px; line-height: 1.35; }
th.rowh .from { display: inline-block; margin-left: 6px; padding: 0 7px; vertical-align: 1px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-weight: 500; font-size: 11px; }
tr.dirty th.rowh { box-shadow: inset 3px 0 0 var(--in_progress); }
tr.invalid { background: var(--rework-bg); }
tr.invalid th.rowh { box-shadow: inset 3px 0 0 var(--rework); }
table.tiers td { vertical-align: middle; }
table.tiers select { width: 140px; }
table.tiers tr.dirty td.id { box-shadow: inset 3px 0 0 var(--in_progress); }
td .dot { display: inline-block; margin-right: 7px; vertical-align: 1px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 12px 0 0; }
button { padding: 7px 15px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); cursor: pointer; font-size: 14px; }
button:hover { border-color: var(--edge); }
button.primary { background: var(--fg); border-color: var(--fg); color: var(--bg); font-weight: 600; }
button.primary:hover { opacity: 0.88; }
.msg { margin: 0; color: var(--muted); font-size: 13px; }
.err { margin: 12px 0 0; padding: 9px 13px; border: 1px solid var(--rework); border-radius: 8px; background: var(--rework-bg); color: var(--fg); font-size: 13px; }
.err:empty { display: none; }
.err ul { margin: 0; padding-left: 18px; }
.banner { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 22px; padding: 10px 14px; border: 1px solid var(--submitted); border-radius: 10px; background: var(--submitted-bg); font-size: 14px; }
.banner[hidden] { display: none; }
`;

function nav(current) {
  const link = (href, label, id) => `<a href="${href}"${current === id ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="views" aria-label="Views">${link('./', 'Sketch', 'sketch')}${link('settings', 'Settings', 'settings')}</nav>\n`;
}

// The newest ladder or tier change, so a reload after Save shows what landed.
function lastChange(dir) {
  const events = S.readEvents(dir);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const d = e.detail || {};
    let what = null;
    if (e.cmd === 'ladder set') what = `ladder set ${d.rung}`;
    else if (e.cmd === 'ladder harness') what = `default harness ${d.harness}`;
    else if (e.cmd === 'ladder save-user') what = 'ladder saved to the user file';
    else if (e.cmd === 'task update' && d.tier) what = `${e.task} tier ${d.tier}`;
    else if (e.cmd === 'init') what = 'init';
    if (what) return `Last change: ${what} by ${e.agent}${d.via ? ` from ${d.via}` : ''}, ${shortTime(e.at)}`;
  }
  return 'No ladder or tier changes yet.';
}

function options(list, selected, labels = {}) {
  return list.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(labels[v] || v)}</option>`).join('');
}

function fieldText(rung, k) {
  const v = rung[k];
  if (v === undefined) return '';
  return Array.isArray(v) ? JSON.stringify(v) : String(v);
}

function ladderRows(layers) {
  return L.RUNGS.map((n) => {
    const e = layers.ladder[n];
    const id = `r-${n}`;
    const cells = COLUMNS.map(([k]) => {
      const label = `${id} c-${k}`;
      if (k === 'harness') {
        const own = e.own.harness || '';
        const opts = `<option value=""${own ? '' : ' selected'}>default (${esc(layers.harness)})</option>${options(L.HARNESSES, own)}`;
        return `<td><select name="harness" aria-labelledby="${label}" data-initial="${esc(own)}">${opts}</select></td>`;
      }
      const v = fieldText(e.own, k);
      return `<td><input name="${k}" value="${esc(v)}" data-initial="${esc(v)}" aria-labelledby="${label}" autocomplete="off" spellcheck="false"></td>`;
    }).join('');
    return `<tr data-rung="${n}"><th scope="row" class="rowh"><span class="rung" id="${id}">${n}</span><span class="from" title="where this rung comes from">${esc(L.SOURCE[e.from])}</span><span class="use">${esc(L.USES[n])}</span></th>${cells}</tr>`;
  }).join('\n');
}

function tierRows(st, now) {
  const tasks = st.tasks.tasks.filter((t) => t.status !== 'cancelled').sort(byId);
  if (!tasks.length) return { count: 0, html: '<p class="empty">No tasks yet.</p>' };
  const rows = tasks.map((t) => {
    const s = T.displayStatus(st, t, now);
    return `<tr data-task="${esc(t.id)}"><td class="id" id="t-${esc(t.id)}">${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc(t.kind)}</td><td>${esc(t.size)}</td>`
      + `<td><span class="dot" style="--c: var(--${s})"></span>${esc(R.LABEL[s])}</td>`
      + `<td><select name="tier" aria-labelledby="t-${esc(t.id)} c-tier" data-initial="${esc(t.tier)}">${options(L.TIERS, t.tier)}</select></td></tr>`;
  }).join('\n');
  const html = `<table class="tiers"><thead><tr><th scope="col">Task</th><th scope="col">Title</th><th scope="col">Kind</th><th scope="col">Size</th><th scope="col">Status</th><th scope="col" id="c-tier">Tier</th></tr></thead><tbody>\n${rows}\n</tbody></table>`;
  return { count: tasks.length, html };
}

// The browser half: tracks what changed, posts only that with the page's
// token and the values it was based on, and shows a refusal inline. It holds
// off the live reload while there are unsaved edits, so a write elsewhere does
// not throw them away. A form is read-only while its save is in flight, so
// nothing typed then can be lost when the reply lands; after a save the page
// reloads only when the other form has nothing unsaved, and otherwise shows
// the server's state in the saved form.
const SCRIPT = `
(function () {
  var token = document.querySelector('meta[name="gishra-token"]').content;
  var efforts = JSON.parse(document.getElementById('efforts').textContent);
  var loaded = JSON.parse(document.getElementById('loaded').textContent);
  var hint = { profile: 'codex profile', provider: 'pi provider', command: '["prog", "{prompt}"]' };
  var only = { profile: 'codex', provider: 'pi', command: 'command' };
  var defaultSel = document.getElementById('harness');
  var stale = document.getElementById('stale');
  var forms = [];
  // known is the state version this page has seen, including its own writes;
  // a reload event for any other version is a change made elsewhere.
  var known = loaded.version;
  // Saves in flight; while any is, reload events wait in heard.
  var saving = 0;
  var heard = null;

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function controls(root) { return Array.prototype.slice.call(root.querySelectorAll('input, select')); }
  function changed(el) { return el.value !== el.getAttribute('data-initial'); }
  function dirty(root) { return controls(root).some(changed); }
  function reset(el, value) { el.value = value; el.setAttribute('data-initial', value); }

  function shape(row) {
    var own = row.querySelector('select[name="harness"]').value;
    var h = own || defaultSel.value;
    Object.keys(only).forEach(function (k) {
      var input = row.querySelector('input[name="' + k + '"]');
      var fits = h === only[k];
      input.classList.toggle('na', !fits);
      input.placeholder = fits ? hint[k] : only[k] + ' only';
    });
    var effort = row.querySelector('input[name="effort"]');
    var list = efforts[h];
    if (list && list.length) { effort.setAttribute('list', 'effort-' + h); effort.placeholder = list.join(', '); }
    else { effort.removeAttribute('list'); effort.placeholder = h === 'command' ? 'n/a' : 'provider variant'; }
    effort.classList.toggle('na', h === 'command');
    row.querySelector('input[name="model"]').placeholder = h === 'command' ? 'n/a' : 'model id';
  }
  function shapeAll() { each(document.querySelectorAll('tr[data-rung]'), shape); }

  function mark(form) {
    each(form.querySelectorAll('tbody tr'), function (row) { row.classList.toggle('dirty', dirty(row)); });
  }

  function say(form, text, error) {
    form.querySelector('.msg').textContent = error ? '' : text;
    var box = form.querySelector('.err');
    box.textContent = '';
    if (!error) return;
    var parts = text.split('; ');
    if (parts.length === 1) { box.textContent = text; return; }
    var ul = document.createElement('ul');
    parts.forEach(function (p) { var li = document.createElement('li'); li.textContent = p; ul.appendChild(li); });
    box.appendChild(ul);
  }

  function flag(form, message) {
    each(form.querySelectorAll('tbody tr'), function (row) {
      var key = row.getAttribute('data-rung') ? 'ladder ' + row.getAttribute('data-rung') + ' ' : row.getAttribute('data-task') + ':';
      var bad = !!message && message.split('; ').some(function (p) { return p.indexOf(key) === 0 || p.indexOf(key.replace(/ $/, ':')) === 0; });
      row.classList.toggle('invalid', bad);
      controls(row).forEach(function (el) {
        if (bad) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', form.querySelector('.err').id); }
        else { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
      });
    });
  }

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gishra-token': token }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) { var e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
          return data;
        });
      });
  }

  function busy(form, on) {
    var button = form.querySelector('button[type="submit"]');
    if (!button.hasAttribute('data-label')) button.setAttribute('data-label', button.textContent);
    button.textContent = on ? 'Saving...' : button.getAttribute('data-label');
    Array.prototype.forEach.call(form.querySelectorAll('input, select, button'), function (el) { el.disabled = on; });
    if (on) form.setAttribute('aria-busy', 'true');
    else form.removeAttribute('aria-busy');
  }

  // A reload event heard while a save was in flight, handled once none is.
  function drain() {
    if (saving || !heard) return;
    var version = heard;
    heard = null;
    changeSeen(version);
  }

  function changeSeen(version) {
    if (version === known) return;
    if (forms.some(dirty)) stale.hidden = false;
    else location.reload();
  }

  function wire(form, build, apply, url) {
    forms.push(form);
    form.addEventListener('input', function () { mark(form); });
    form.addEventListener('change', function (e) {
      if (e.target.name === 'harness') shapeAll();
      mark(form);
    });
    form.querySelector('[data-discard]').addEventListener('click', function () {
      controls(form).forEach(function (el) { el.value = el.getAttribute('data-initial'); });
      shapeAll();
      mark(form); flag(form, ''); say(form, 'Changes discarded.');
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = build();
      if (!body) { say(form, 'Nothing to save.'); return; }
      busy(form, true);
      saving += 1;
      say(form, 'Saving...');
      post(url, body).then(function (data) {
        known = data.version;
        var others = forms.filter(function (f) { return f !== form && dirty(f); });
        if (!others.length) { location.reload(); return; }
        // Reloading would drop the other form's unsaved edits.
        apply(data);
        saving -= 1;
        busy(form, false);
        mark(form); flag(form, '');
        say(form, 'Saved. The page did not reload, so your unsaved edits in the other form stay.');
        drain();
      }, function (err) {
        saving -= 1;
        busy(form, false);
        if (err.status === 409) stale.hidden = false;
        flag(form, err.message);
        say(form, err.message, true);
        drain();
      });
    });
  }

  function text(v) { return v === undefined ? '' : Array.isArray(v) ? JSON.stringify(v) : String(v); }

  var ladderForm = document.getElementById('ladder-form');
  wire(ladderForm, function () {
    var body = { rungs: {}, base: { harness: loaded.harness, rungs: {} } };
    var any = false;
    if (changed(defaultSel)) { body.harness = defaultSel.value; any = true; }
    each(ladderForm.querySelectorAll('tr[data-rung]'), function (row) {
      if (!dirty(row)) return;
      var name = row.getAttribute('data-rung');
      var rung = {};
      controls(row).forEach(function (el) { rung[el.name] = el.value; });
      body.rungs[name] = rung;
      body.base.rungs[name] = loaded.rungs[name];
      any = true;
    });
    return any ? body : null;
  }, function (data) {
    loaded.harness = data.harness;
    reset(defaultSel, data.harness);
    each(ladderForm.querySelectorAll('tr[data-rung]'), function (row) {
      var name = row.getAttribute('data-rung');
      var e = data.ladder[name];
      var own = {};
      loaded.fields.forEach(function (k) { if (e[k] !== undefined && (k !== 'harness' || e.harness_from === 'rung')) own[k] = e[k]; });
      loaded.rungs[name] = own;
      controls(row).forEach(function (el) { reset(el, text(own[el.name])); });
      row.querySelector('select[name="harness"] option[value=""]').textContent = 'default (' + data.harness + ')';
      row.querySelector('.from').textContent = loaded.sources[e.from];
    });
    shapeAll();
  }, 'api/ladder');

  var tierForm = document.getElementById('tier-form');
  if (tierForm) wire(tierForm, function () {
    var tiers = {};
    var base = {};
    var any = false;
    controls(tierForm).forEach(function (el) {
      if (!changed(el)) return;
      var id = el.closest('tr').getAttribute('data-task');
      tiers[id] = el.value;
      base[id] = loaded.tiers[id];
      any = true;
    });
    return any ? { tiers: tiers, base: base } : null;
  }, function (data) {
    data.tiers.forEach(function (t) {
      loaded.tiers[t.id] = t.tier;
      reset(tierForm.querySelector('tr[data-task="' + t.id + '"] select'), t.tier);
    });
  }, 'api/tiers');

  shapeAll();
  document.getElementById('reload').addEventListener('click', function () { location.reload(); });
  new EventSource('events').addEventListener('reload', function (e) {
    var version = JSON.parse(e.data || '{}').version;
    if (saving) { heard = version; return; }
    changeSeen(version);
  });
})();
`;

function renderSettings(st, token, version, now = Date.now()) {
  const p = st.project;
  const layers = L.resolve(p);
  const datalists = Object.entries(L.EFFORTS)
    .filter(([, list]) => list && list.length)
    .map(([h, list]) => `<datalist id="effort-${h}">${list.map((v) => `<option value="${v}"></option>`).join('')}</datalist>`)
    .join('');
  const efforts = JSON.stringify(L.EFFORTS).replace(/</g, '\\u003c');
  // What the forms were drawn from: a save sends the part it edits back as
  // its base, so the server can refuse it if that part changed since.
  const loaded = JSON.stringify({
    version,
    harness: layers.harness,
    rungs: Object.fromEntries(L.RUNGS.map((n) => [n, layers.ladder[n].own])),
    tiers: Object.fromEntries(st.tasks.tasks.map((t) => [t.id, t.tier])),
    fields: L.FIELDS,
    sources: L.SOURCE,
  }).replace(/</g, '\\u003c');
  const tiers = tierRows(st, now);
  const head = COLUMNS.map(([k, label]) => `<th scope="col" id="c-${k}">${label}</th>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="gishra-token" content="${esc(token)}">
<title>${esc(p.name)} settings</title>
<style>${R.CSS}${CSS}</style>
</head>
<body>
<main>
${nav('settings')}<h1>Settings</h1>
<p class="goal">${esc(p.name)}: the harness, model and effort each rung runs, and the tier of each task. Saving goes through the same checks as gishra ladder set and gishra task update; a refused change writes nothing.</p>
<p class="meta">${esc(lastChange(st.dir))}</p>
<div class="banner" id="stale" role="status" hidden>The state changed on disk while you were editing. <button type="button" id="reload">Reload</button> shows it and drops your unsaved edits.</div>
<section aria-labelledby="h-ladder">
<h2 id="h-ladder">Ladder</h2>
<form id="ladder-form" novalidate>
<div class="card">
<div class="lead">
<label for="harness">Default harness</label>
<select id="harness" name="harness" data-initial="${esc(layers.harness)}" aria-describedby="harness-hint">${options(L.HARNESSES, layers.harness)}</select>
<p class="hint" id="harness-hint">Every rung without its own harness runs here. Now from ${esc(L.SOURCE[layers.harness_from])}.</p>
</div>
<table class="ladder">
<colgroup><col style="width: 196px"><col style="width: 142px"><col><col style="width: 104px"><col style="width: 104px"><col style="width: 100px"><col style="width: 156px"><col style="width: 156px"></colgroup>
<thead><tr><th scope="col">Rung</th>${head}</tr></thead>
<tbody>
${ladderRows(layers)}
</tbody>
</table>
</div>
<div class="err" id="ladder-err" role="alert"></div>
<div class="actions"><button type="submit" class="primary">Save ladder</button><button type="button" data-discard>Discard changes</button><p class="msg" role="status"></p></div>
</form>
</section>
<section aria-labelledby="h-tiers">
<h2 id="h-tiers">Task tiers<span class="n">${tiers.count}</span></h2>
${tiers.count ? `<form id="tier-form" novalidate>
<div class="card">${tiers.html}</div>
<div class="err" id="tier-err" role="alert"></div>
<div class="actions"><button type="submit" class="primary">Save tiers</button><button type="button" data-discard>Discard changes</button><p class="msg" role="status"></p></div>
</form>` : `<div class="card">${tiers.html}</div>`}
</section>
${datalists}
<script type="application/json" id="efforts">${efforts}</script>
<script type="application/json" id="loaded">${loaded}</script>
<script>${SCRIPT}</script>
</main>
</body>
</html>
`;
}

module.exports = { renderSettings, nav };
