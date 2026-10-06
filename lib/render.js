'use strict';

const path = require('node:path');
const { byId, shortTime, truncate } = require('./util');
const S = require('./state');
const T = require('./tasks');
const L = require('./ladder');

const DISPLAY = ['ready', 'blocked', 'in_progress', 'submitted', 'rework', 'accepted', 'cancelled'];
const LABEL = { ready: 'ready', blocked: 'blocked', in_progress: 'in progress', submitted: 'submitted', rework: 'rework', accepted: 'accepted', cancelled: 'cancelled' };

// Mermaid has no theme tokens, so sketch.md carries fixed colors that read on
// both light and dark Markdown viewers.
const MERMAID = {
  ready: 'fill:#dff3e6,stroke:#1f7a4d,color:#14231a',
  blocked: 'fill:#ececea,stroke:#77776f,color:#22221f',
  in_progress: 'fill:#dde9fb,stroke:#1c5fb8,color:#14203a',
  submitted: 'fill:#efe3f9,stroke:#7f45b5,color:#2a1838',
  rework: 'fill:#fbe6d8,stroke:#b4541a,color:#3a1d0a',
  accepted: 'fill:#d8efef,stroke:#0f6e6e,color:#0d2a2a',
  cancelled: 'fill:#f3f3f1,stroke:#a3a39c,color:#6b6b66,stroke-dasharray:4 3',
};

// The views still draw when the user file is broken; the ladder table says why.
function ladderOrError(project) {
  try {
    return L.resolve(project);
  } catch (e) {
    return { error: e.message };
  }
}

function buildView(st, now = Date.now()) {
  const tasks = [...st.tasks.tasks].sort(byId);
  const display = new Map(tasks.map((t) => [t.id, T.displayStatus(st, t, now)]));
  const counts = Object.fromEntries(S.STATUSES.map((s) => [s, 0]));
  for (const t of tasks) counts[t.status] += 1;
  const ready = T.readyTasks(st, now);
  counts.ready = ready.length;
  counts.blocked = T.blockedTasks(st, now).length;
  const inProgress = tasks
    .filter((t) => t.status === 'in_progress')
    .map((t) => ({ task: t, agent: t.claim.agent, until: t.claim.until, expired: T.leaseExpired(t, now) }));
  const submitted = tasks.filter((t) => t.status === 'submitted').map((t) => ({ task: t, report: T.gateReport(t, st.events) }));
  const open = st.decisions.decisions.filter((d) => d.status === 'open').sort(byId);
  const owner = tasks.filter((t) => t.needs_owner && t.status !== 'accepted' && t.status !== 'cancelled');
  const minutes = tasks.reduce((s, t) => s + t.spend.minutes, 0);
  const tokens = tasks.reduce((s, t) => s + t.spend.tokens, 0);
  return {
    project: st.project,
    ladder: ladderOrError(st.project),
    generated_at: new Date(now).toISOString(),
    tasks,
    display,
    counts,
    ready,
    inProgress,
    submitted,
    open,
    owner,
    expired: inProgress.filter((x) => x.expired),
    spend: { minutes, hours: Math.round((minutes / 60) * 10) / 10, tokens, budget_hours: st.project.budget.hours, budget_tokens: st.project.budget.tokens },
  };
}

function pct(used, budget) {
  if (budget == null) return '-';
  if (budget === 0) return used > 0 ? 'over' : '0%';
  return `${Math.round((used / budget) * 100)}%`;
}

function compact(n) {
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 1e2) / 10}k`;
  return String(n);
}

function spendRows(v) {
  return [
    { what: 'Hours', spent: String(v.spend.hours), budget: v.spend.budget_hours == null ? '-' : String(v.spend.budget_hours), used: pct(v.spend.hours, v.spend.budget_hours) },
    { what: 'Tokens', spent: compact(v.spend.tokens), budget: v.spend.budget_tokens == null ? '-' : compact(v.spend.budget_tokens), used: pct(v.spend.tokens, v.spend.budget_tokens) },
  ];
}

// Each table is described once and drawn by both the Markdown and HTML writers.
function tables(v) {
  return [
    {
      title: 'Ready',
      head: ['Task', 'Title', 'Kind', 'Size', 'Tier', 'Unblocks'],
      rows: v.ready.map(({ task, unblocks }) => [task.id, task.title + (task.status === 'rework' ? ' (rework)' : ''), task.kind, task.size, task.tier, String(unblocks)]),
    },
    {
      title: 'In progress',
      head: ['Task', 'Title', 'Agent', 'Lease until'],
      rows: v.inProgress.map((x) => [x.task.id, x.task.title, x.agent, x.expired ? `${shortTime(x.until)} (expired)` : shortTime(x.until)]),
    },
    {
      title: 'Submitted',
      head: ['Task', 'Title', 'Sha', 'PR', 'By', 'Gates'],
      rows: v.submitted.map(({ task, report }) => [
        task.id, task.title, task.sha ? task.sha.slice(0, 7) : '-', task.pr ? `#${task.pr}` : '-', task.submitted_by || '-',
        report.ok ? 'all pass' : `missing ${report.gates.filter((g) => !g.ok).map((g) => g.type).join(', ')}`,
      ]),
    },
    {
      title: 'Decisions open',
      head: ['Decision', 'Question', 'Options', 'Recommendation', 'Blocks'],
      rows: v.open.map((d) => [d.id, d.question + (d.why ? ` (${d.why})` : ''), d.options.join(', ') || '-', d.recommendation || '-', d.blocks.join(', ') || '-']),
    },
    {
      title: 'Needs owner',
      head: ['Task', 'Title', 'Owner must'],
      rows: v.owner.map((t) => [t.id, t.title, t.needs_owner]),
    },
    {
      title: 'Spend vs budget',
      head: ['', 'Spent', 'Budget', 'Used'],
      rows: spendRows(v).map((r) => [r.what, r.spent, r.budget, r.used]),
    },
    {
      title: 'Ladder',
      head: ['Rung', 'Harness', 'Model or profile', 'Effort'],
      rows: v.ladder.error ? [['-', v.ladder.error, '-', '-']] : L.RUNGS.map((n) => {
        const r = L.rungOf(v.ladder, n);
        const what = r.harness === 'command' ? JSON.stringify(r.command) : [r.model, r.profile && `profile ${r.profile}`].filter(Boolean).join(', ');
        return [n, v.ladder.ladder[n].harness_from === 'default' ? `${r.harness} (default)` : r.harness, what || '-', r.effort || '-'];
      }),
    },
  ];
}

// ---- Markdown ----

// Markdown viewers treat <word> as HTML and drop it, so titles keep their
// angle brackets as entities.
const mdText = (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mdCell = (s) => mdText(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
// Mermaid turns #name; into an HTML entity, which keeps quotes and angle
// brackets in titles from ending the label or reading as markup.
const mermaidLabel = (s) => String(s).replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/\r?\n/g, ' ');

function mermaid(v) {
  if (!v.tasks.length) return 'No tasks yet.';
  const lines = ['```mermaid', 'flowchart LR'];
  for (const t of v.tasks) lines.push(`  ${t.id}["${mermaidLabel(`${t.id}: ${truncate(t.title, 48)}`)}"]`);
  const ids = new Set(v.tasks.map((t) => t.id));
  for (const t of v.tasks) for (const d of t.depends_on) if (ids.has(d)) lines.push(`  ${d} --> ${t.id}`);
  for (const s of DISPLAY) {
    const members = v.tasks.filter((t) => v.display.get(t.id) === s).map((t) => t.id);
    if (!members.length) continue;
    lines.push(`  classDef ${s} ${MERMAID[s]}`);
    lines.push(`  class ${members.join(',')} ${s}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function renderMarkdown(st, now) {
  const v = buildView(st, now);
  const p = v.project;
  const out = [`# ${mdText(p.name)}`, '', mdText(p.goal), '', `Rendered ${shortTime(v.generated_at)}${p.repo ? ` for ${p.repo}` : ''}, base \`${p.base}\`. ${countLine(v)}.`, '', mermaid(v), ''];
  for (const tb of tables(v)) {
    out.push(`## ${tb.title}`, '');
    if (!tb.rows.length) {
      out.push('None.', '');
      continue;
    }
    out.push(`| ${tb.head.map(mdCell).join(' | ')} |`, `|${tb.head.map(() => '---').join('|')}|`);
    for (const r of tb.rows) out.push(`| ${r.map(mdCell).join(' | ')} |`);
    out.push('');
  }
  return out.join('\n');
}

function countLine(v) {
  const c = v.counts;
  return [
    `${c.ready} ready`, `${c.blocked} blocked`, `${c.in_progress} in progress`, `${c.submitted} submitted`,
    `${c.rework} rework`, `${c.accepted} accepted`, `${c.cancelled} cancelled`,
  ].join(', ');
}

// ---- HTML ----

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const NODE_W = 248;
const NODE_H = 58;
const COL_GAP = 64;
const ROW_GAP = 14;
const PAD = 10;

// Columns by dependency depth; within a column, nodes sit near the average
// row of what they depend on, which keeps most edges short and uncrossed.
function layout(tasks) {
  const byKey = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const dep of byKey.get(id).depends_on) if (byKey.has(dep)) d = Math.max(d, depthOf(dep) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const cols = [];
  for (const t of tasks) {
    const d = depthOf(t.id);
    (cols[d] = cols[d] || []).push(t);
  }
  const row = new Map();
  cols.forEach((col, c) => {
    if (c > 0) {
      const bary = (t) => {
        const rs = t.depends_on.filter((d) => row.has(d)).map((d) => row.get(d));
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => bary(a) - bary(b) || byId(a, b));
    }
    col.forEach((t, i) => row.set(t.id, i));
  });
  const pos = new Map();
  for (const t of tasks) {
    pos.set(t.id, { x: PAD + depth.get(t.id) * (NODE_W + COL_GAP), y: PAD + row.get(t.id) * (NODE_H + ROW_GAP) });
  }
  const rows = Math.max(1, ...cols.map((c) => (c ? c.length : 0)));
  return {
    pos,
    width: PAD * 2 + cols.length * NODE_W + Math.max(0, cols.length - 1) * COL_GAP,
    height: PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP,
  };
}

function graphSvg(v) {
  if (!v.tasks.length) return '<p class="empty">No tasks yet.</p>';
  const { pos, width, height } = layout(v.tasks);
  const edges = [];
  for (const t of v.tasks) {
    const to = pos.get(t.id);
    for (const d of t.depends_on) {
      const from = pos.get(d);
      if (!from) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x - 2;
      const y2 = to.y + NODE_H / 2;
      const dx = Math.max(24, (x2 - x1) / 2);
      edges.push(`<path class="edge" d="M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}" marker-end="url(#gishra-arrow)"/>`);
    }
  }
  const nodes = v.tasks.map((t) => {
    const p = pos.get(t.id);
    const s = v.display.get(t.id);
    return [
      `<g class="node s-${s}" transform="translate(${p.x} ${p.y})">`,
      `<title>${esc(`${t.id} ${t.title} (${LABEL[s]}, tier ${t.tier})`)}</title>`,
      `<rect class="box" width="${NODE_W}" height="${NODE_H}" rx="8"/>`,
      `<rect class="bar" x="0" y="0" width="5" height="${NODE_H}" rx="2"/>`,
      `<text class="nid" x="16" y="23">${esc(t.id)}<tspan class="ntier" dx="8">${esc(t.tier)}</tspan></text>`,
      `<text class="nst" x="${NODE_W - 12}" y="23" text-anchor="end">${esc(LABEL[s])}</text>`,
      `<text class="ntt" x="16" y="44">${esc(truncate(t.title, 32))}</text>`,
      '</g>',
    ].join('');
  });
  return [
    `<svg class="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Task dependency graph">`,
    '<defs><marker id="gishra-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="arrowhead" d="M0 0 L8 4 L0 8 z"/></marker></defs>',
    ...edges,
    ...nodes,
    '</svg>',
  ].join('\n');
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f5f1; --surface: #ffffff; --fg: #1c1c1a; --muted: #67665f; --border: #e2e0d9; --edge: #9b9a92;
  --ready: #1f7a4d; --ready-bg: #e3f4ea;
  --blocked: #77776f; --blocked-bg: #efeeea;
  --in_progress: #1c5fb8; --in_progress-bg: #e3edfb;
  --submitted: #7f45b5; --submitted-bg: #f1e7fa;
  --rework: #b4541a; --rework-bg: #fcebdf;
  --accepted: #0f6e6e; --accepted-bg: #dcf0f0;
  --cancelled: #a3a39c; --cancelled-bg: #f4f4f1;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --surface: #1d1d1b; --fg: #ecebe5; --muted: #a09f97; --border: #33322e; --edge: #6f6e67;
    --ready: #5ccf92; --ready-bg: #17301f;
    --blocked: #a3a29b; --blocked-bg: #262624;
    --in_progress: #74a8f2; --in_progress-bg: #172640;
    --submitted: #c39af0; --submitted-bg: #2a1d3a;
    --rework: #f0995c; --rework-bg: #3a2414;
    --accepted: #5cc8c8; --accepted-bg: #132f2f;
    --cancelled: #75746d; --cancelled-bg: #1f1f1d;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
main { max-width: 1180px; margin: 0 auto; padding: 32px 24px 56px; }
h1 { font-size: 26px; line-height: 1.2; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.01em; }
.goal { color: var(--muted); margin: 0 0 14px; max-width: 70ch; }
.meta { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
.meta code, td.id, .mono { font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace; font-size: 13px; }
.counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 28px; padding: 0; list-style: none; }
.counts li { display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); font-size: 13px; }
.counts b { font-weight: 650; font-variant-numeric: tabular-nums; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c); flex: none; }
section { margin: 0 0 28px; }
h2 { font-size: 16px; font-weight: 650; margin: 0 0 10px; }
h2 .n { color: var(--muted); font-weight: 500; margin-left: 6px; font-variant-numeric: tabular-nums; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow-x: auto; }
.graph-wrap { padding: 8px; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 0 0 10px; padding: 0; list-style: none; font-size: 13px; color: var(--muted); }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
svg.graph { display: block; }
.edge { fill: none; stroke: var(--edge); stroke-width: 1.4; }
.arrowhead { fill: var(--edge); }
.node .box { stroke-width: 1.2; }
.node .nid { font: 600 13px ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace; fill: var(--fg); }
.node .nst { font: 500 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.node .ntier { font: 500 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: var(--muted); }
.node .ntt { font: 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: var(--fg); }
${DISPLAY.map((s) => `.s-${s} .box { fill: var(--${s}-bg); stroke: var(--${s}); } .s-${s} .bar { fill: var(--${s}); } .s-${s} .nst { fill: var(--${s}); }`).join('\n')}
.s-cancelled .ntt { text-decoration: line-through; fill: var(--muted); }
.s-cancelled .box { stroke-dasharray: 4 3; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td.id { white-space: nowrap; font-weight: 600; }
.empty { color: var(--muted); margin: 0; padding: 12px 14px; font-size: 14px; }
nav.views { display: flex; gap: 6px; margin: 0 0 22px; }
nav.views a { padding: 5px 13px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--fg); text-decoration: none; font-size: 13px; }
nav.views a:hover { border-color: var(--edge); }
nav.views a[aria-current="page"] { background: var(--fg); border-color: var(--fg); color: var(--bg); font-weight: 600; }
:focus-visible { outline: 2px solid var(--in_progress); outline-offset: 2px; }
@media (max-width: 640px) {
  main { padding: 20px 16px 40px; }
  h1 { font-size: 22px; }
  th, td { padding: 8px 10px; }
}
`;

function htmlTable(tb) {
  if (!tb.rows.length) return '<p class="empty">None.</p>';
  const head = tb.head.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = tb.rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="id"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

// serve adds its reload script to the head and its view links to the top of
// the page; the sketch.html file on disk carries neither.
function renderHtml(st, now, extraHead = '', top = '') {
  const v = buildView(st, now);
  const p = v.project;
  // Chips count what the graph colors, so a rework task is counted once.
  const shown = Object.fromEntries(DISPLAY.map((s) => [s, 0]));
  for (const s of v.display.values()) shown[s] += 1;
  const counts = DISPLAY.map((s) => `<li><span class="dot" style="--c: var(--${s})"></span><b>${shown[s]}</b> ${esc(LABEL[s])}</li>`).join('');
  const legend = DISPLAY.map((s) => `<li><span class="dot" style="--c: var(--${s})"></span>${esc(LABEL[s])}</li>`).join('');
  const sections = tables(v)
    .map((tb) => {
      const n = tb.title === 'Spend vs budget' || tb.title === 'Ladder' ? '' : `<span class="n">${tb.rows.length}</span>`;
      return `<section><h2>${esc(tb.title)}${n}</h2><div class="card">${htmlTable(tb)}</div></section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(p.name)} sketch</title>
<style>${CSS}</style>
${extraHead}</head>
<body>
<main>
${top}<h1>${esc(p.name)}</h1>
<p class="goal">${esc(p.goal)}</p>
<p class="meta">Rendered ${esc(shortTime(v.generated_at))}${p.repo ? ` for <code>${esc(p.repo)}</code>` : ''}, base <code>${esc(p.base)}</code></p>
<ul class="counts">${counts}</ul>
<section>
<h2>Tasks<span class="n">${v.tasks.length}</span></h2>
<ul class="legend">${legend}</ul>
<div class="card graph-wrap">
${graphSvg(v)}
</div>
</section>
${sections}
</main>
</body>
</html>
`;
}

function renderFiles(st) {
  const now = Date.now();
  const md = path.join(st.dir, 'sketch.md');
  const html = path.join(st.dir, 'sketch.html');
  S.writeAtomic(md, renderMarkdown(st, now));
  S.writeAtomic(html, renderHtml(st, now));
  return { md, html };
}

// Under the lock, like every write: a render that read the state before a
// concurrent write would otherwise publish that older state over the newer
// sketch the write just rendered.
function render(ctx) {
  const out = S.withLock(ctx.stateDir, () => renderFiles(S.loadState(ctx.stateDir)));
  return { data: out, text: `wrote ${out.md}\nwrote ${out.html}` };
}

function status(ctx) {
  const st = S.loadState(ctx.stateDir);
  const v = buildView(st);
  const p = v.project;
  const lines = [`${p.name}: ${p.goal}`, countLine(v)];
  lines.push(v.ready.length ? `ready: ${v.ready.map(({ task }) => `${task.id} ${truncate(task.title, 40)}`).join('; ')}` : 'ready: none');
  if (v.inProgress.length) lines.push(`in progress: ${v.inProgress.map((x) => `${x.task.id} (${x.agent})`).join(', ')}`);
  if (v.submitted.length) {
    lines.push(`submitted: ${v.submitted.map(({ task, report }) => `${task.id}${report.ok ? ' (gates pass)' : ` (missing ${report.gates.filter((g) => !g.ok).map((g) => g.type).join(', ')})`}`).join(', ')}`);
  }
  lines.push(v.open.length ? `open decisions: ${v.open.map((d) => `${d.id} ${d.question}${d.blocks.length ? ` (blocks ${d.blocks.join(', ')})` : ''}`).join('; ')}` : 'open decisions: none');
  if (v.owner.length) lines.push(`needs owner: ${v.owner.map((t) => `${t.id} ${t.needs_owner}`).join('; ')}`);
  const sr = spendRows(v);
  lines.push(`spend: ${sr.map((r) => `${r.spent} ${r.what.toLowerCase()}${r.budget !== '-' ? ` of ${r.budget} (${r.used})` : ''}`).join(', ')}`);
  if (v.expired.length) lines.push(`expired leases: ${v.expired.map((x) => `${x.task.id} (${x.agent}, ${shortTime(x.until)})`).join(', ')}`);
  return {
    data: {
      project: { name: p.name, goal: p.goal },
      counts: v.counts,
      ready: v.ready.map(({ task, unblocks }) => ({ id: task.id, title: task.title, unblocks })),
      in_progress: v.inProgress.map((x) => ({ id: x.task.id, agent: x.agent, until: x.until, expired: x.expired })),
      submitted: v.submitted.map(({ task, report }) => ({ id: task.id, sha: task.sha, gates_ok: report.ok, missing: report.missing })),
      decisions_open: v.open.map((d) => ({ id: d.id, question: d.question, blocks: d.blocks })),
      needs_owner: v.owner.map((t) => ({ id: t.id, title: t.title, needs_owner: t.needs_owner })),
      spend: v.spend,
      expired_leases: v.expired.map((x) => ({ id: x.task.id, agent: x.agent, until: x.until })),
    },
    text: lines.join('\n'),
  };
}

module.exports = { buildView, renderMarkdown, renderHtml, renderFiles, render, status, CSS, LABEL, esc };
