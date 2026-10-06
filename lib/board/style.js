'use strict';

// The board's design system as CSS: tokens first, then components, then
// views and layout. docs/design.md section 3 is the contract for these values.

const TOKENS = `
:root {
  color-scheme: light dark;
  --paper: #eceef0; --plate: #ffffff; --plate-2: #f5f6f7; --rule: #d3d8dd; --rule-2: #a7afb7;
  --ink: #14181c; --ink-2: #48515a; --ink-3: #5c656e;
  --signal: #ffc800; --signal-edge: #c99a00; --on-signal: #14181c;
  --live: #1d5fd0; --live-wash: #e4ecfb;
  --fault: #c22b1d; --fault-wash: #fbe6e3;
  --focus: #1d5fd0;
  --shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;
  --s1: 2px; --s2: 4px; --s3: 8px; --s4: 12px; --s5: 16px; --s6: 24px; --s7: 32px; --s8: 48px;
  --r: 2px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #13171b; --plate: #1a1f24; --plate-2: #20262c; --rule: #2d353d; --rule-2: #4a5560;
    --ink: #e7ebee; --ink-2: #b2bbc3; --ink-3: #8c96a0;
    --signal-edge: #ffd84a;
    --live: #78a6ff; --live-wash: #192840;
    --fault: #ff7d6e; --fault-wash: #3a1e1b;
    --focus: #78a6ff;
    --shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  }
}
`;

const BASE = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; background: var(--paper); }
body { margin: 0; background: var(--paper); color: var(--ink); font: 14px/1.45 var(--sans); font-variant-numeric: tabular-nums; }
h1, h2, h3, h4, p, ol, ul, figure, blockquote { margin: 0; }
ol, ul { padding: 0; list-style: none; }
a { color: inherit; }
button, input, select, textarea { font: inherit; color: inherit; }
code, .mono, .id { font-family: var(--mono); font-size: 0.92em; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--r); }
.skip { position: absolute; left: var(--s4); top: -40px; z-index: 50; padding: var(--s3) var(--s4); background: var(--ink); color: var(--plate); border-radius: var(--r); }
.skip:focus { top: var(--s3); }
.vh { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
time { white-space: nowrap; }
`;

const COMPONENTS = `
/* Top bar */
.topbar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "brand proj state" "rail rail rail" "nav nav nav"; gap: var(--s3) var(--s5); padding: var(--s4) var(--s6) 0; background: var(--plate); border-bottom: 1px solid var(--rule); }
.brand { grid-area: brand; display: flex; align-items: center; gap: var(--s3); color: var(--ink-2); font-size: 13px; font-weight: 600; white-space: nowrap; }
.brand svg { width: 22px; height: 22px; flex: none; }
.proj { grid-area: proj; min-width: 0; display: flex; align-items: baseline; gap: var(--s4); }
.proj h1 { font-size: 20px; line-height: 1.25; font-weight: 600; white-space: nowrap; }
.goal { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.state { grid-area: state; display: flex; align-items: center; gap: var(--s5); white-space: nowrap; font-size: 13px; color: var(--ink-2); }
.conn { display: inline-flex; align-items: center; gap: var(--s2); }
.conn::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--rule-2); }
.conn[data-conn="live"]::before { background: var(--live); animation: breathe 2400ms ease-in-out infinite; }
.conn[data-conn="lost"] { color: var(--fault); }
.conn[data-conn="lost"]::before { background: var(--fault); }
@keyframes breathe { 50% { opacity: 0.35; } }
.railbox { grid-area: rail; display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s5); }
.rail { flex: 1 1 320px; display: flex; height: 10px; min-width: 200px; background: var(--plate-2); border: 1px solid var(--rule); }
.rail span { display: block; min-width: 0; }
.rail .r-accepted { background: var(--ink); }
.rail .r-submitted { background: var(--ink-2); }
.rail .r-in_progress { background: var(--live); }
.rail .r-rework { background: var(--fault); }
.rail .r-ready { background: repeating-linear-gradient(90deg, var(--rule-2) 0 1px, transparent 1px 6px); }
.rail .r-blocked, .rail .r-cancelled { background: transparent; }
.counts { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s4); font-size: 13px; color: var(--ink-2); }
.counts li { display: inline-flex; align-items: center; gap: var(--s2); }
.counts b { color: var(--ink); font-weight: 600; }
.views { grid-area: nav; display: flex; gap: var(--s1); overflow-x: auto; scrollbar-width: none; margin: 0 calc(-1 * var(--s3)); }
.views a { padding: var(--s3) var(--s3) calc(var(--s3) - 2px); border-bottom: 2px solid transparent; color: var(--ink-2); text-decoration: none; font-weight: 600; font-size: 13px; white-space: nowrap; }
.views a:hover { color: var(--ink); border-bottom-color: var(--rule-2); }
.views a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); }
.views .n { display: inline-block; margin-left: var(--s2); padding: 0 5px; min-width: 18px; text-align: center; border-radius: var(--r); background: var(--signal); color: var(--on-signal); font-size: 12px; }
.meter { display: inline-flex; align-items: center; gap: var(--s3); }
.meter .track { position: relative; width: 64px; height: 6px; background: var(--plate-2); border: 1px solid var(--rule); }
.meter .fill { position: absolute; inset: 0 auto 0 0; background: var(--ink-2); }
.meter.near .fill { background: var(--signal); }
.meter.over .fill { background: var(--fault); }

/* Status glyphs */
.g { width: 12px; height: 12px; flex: none; vertical-align: -1px; }
.g-ready, .g-submitted, .g-accepted { color: var(--ink); }
.g-blocked, .g-cancelled { color: var(--ink-3); }
.g-in_progress { color: var(--live); }
.g-rework { color: var(--fault); }

/* Shared text pieces */
.id { font-weight: 600; white-space: nowrap; }
.muted { color: var(--ink-2); }
.faint { color: var(--ink-3); }
.empty { color: var(--ink-2); padding: var(--s4) 0; }
.empty code { color: var(--ink); }
.tag { display: inline-block; padding: 0 var(--s2); border: 1px solid var(--rule); border-radius: var(--r); color: var(--ink-2); font-size: 12px; line-height: 18px; white-space: nowrap; }
.tag.fault { color: var(--fault); border-color: currentColor; }
.tag.live { color: var(--live); border-color: currentColor; }
.tag.signal { background: var(--signal); border-color: var(--signal-edge); color: var(--on-signal); }

/* Column headings */
.colh { display: flex; align-items: baseline; gap: var(--s3); padding: 0 0 var(--s3); font-size: 13px; font-weight: 600; color: var(--ink-2); }
.colh .n { color: var(--ink); }
.colh .aside { margin-left: auto; font-weight: 400; color: var(--ink-3); }
.grouph { margin: var(--s5) 0 var(--s3); font-size: 12px; font-weight: 600; color: var(--ink-2); }

/* Signal plates */
.plate { position: relative; margin: 0 0 var(--s3); padding: var(--s4) var(--s5); background: var(--plate); border: 1px solid var(--rule); border-radius: var(--r); }
.plate.signal { background: var(--signal); border-color: var(--signal-edge); color: var(--on-signal); }
.plate .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s1) var(--s3); font-size: 12px; }
.plate .kind { font-weight: 600; }
.plate .q { margin: var(--s2) 0 0; font-size: 16px; line-height: 1.3; font-weight: 600; max-width: 62ch; }
.plate .why { margin: var(--s2) 0 0; max-width: 70ch; }
.plate .rec { margin: var(--s2) 0 0; font-size: 13px; }
.plate.signal a { color: var(--on-signal); }
.plate.signal .now { font-style: normal; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.plate.signal .cmd { background: rgba(255, 255, 255, 0.55); border-color: rgba(20, 24, 28, 0.25); color: var(--on-signal); }
.plate.signal .cmd button { color: var(--on-signal); border-color: rgba(20, 24, 28, 0.35); }
.plate.signal :focus-visible { outline-color: var(--on-signal); }
.plate.stuck { border-left: 3px solid var(--fault); padding-left: calc(var(--s5) - 2px); }
.plate.stuck .what { color: var(--fault); font-weight: 600; }
.plate .t { font-weight: 600; }
.plate .t a, .card .t a, .row a { text-decoration: none; }
.plate .t a:hover, .card .t a:hover, .row a:hover .t { text-decoration: underline; text-underline-offset: 2px; }

/* Buttons and forms */
.btn { display: inline-flex; align-items: center; gap: var(--s2); min-height: 32px; padding: var(--s2) var(--s4); border: 1px solid var(--rule-2); border-radius: var(--r); background: var(--plate); color: var(--ink); font-size: 13px; font-weight: 600; cursor: pointer; transition: background 120ms var(--ease), border-color 120ms var(--ease), color 120ms var(--ease); }
.btn:hover { border-color: var(--ink); }
.btn.primary { background: var(--ink); border-color: var(--ink); color: var(--plate); }
.btn.primary:hover { background: var(--ink-2); border-color: var(--ink-2); }
.btn.danger { color: var(--fault); border-color: var(--fault); background: transparent; }
.btn.danger:hover { background: var(--fault); color: var(--plate); }
.btn[disabled] { opacity: 0.45; cursor: default; pointer-events: none; }
.signal .btn { background: transparent; border-color: var(--on-signal); color: var(--on-signal); }
.signal .btn:hover { background: rgba(255, 255, 255, 0.4); }
.signal .btn.primary { background: var(--on-signal); color: var(--signal); }
.signal .btn.primary:hover { background: #2c333a; }
.btn.quiet { border-color: transparent; background: transparent; padding-left: var(--s2); padding-right: var(--s2); color: var(--ink-2); }
.btn.quiet:hover { color: var(--ink); border-color: var(--rule); }
.signal .btn.quiet { color: var(--on-signal); border-color: transparent; }
.acts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3); margin: var(--s4) 0 0; }
.field { display: grid; gap: var(--s2); margin: var(--s3) 0 0; font-size: 12px; font-weight: 600; color: inherit; }
.field input, .field textarea, .field select, select.input { width: 100%; min-width: 0; padding: 6px var(--s3); background: var(--plate-2); border: 1px solid var(--rule); border-radius: var(--r); font-size: 14px; font-weight: 400; color: var(--ink); }
.field textarea { min-height: 64px; resize: vertical; line-height: 1.4; }
.field input:hover, .field textarea:hover, .field select:hover { border-color: var(--rule-2); }
.signal .field input, .signal .field textarea { background: rgba(255, 255, 255, 0.7); border-color: rgba(20, 24, 28, 0.35); color: var(--on-signal); }
[aria-invalid="true"] { border-color: var(--fault) !important; }
form output { display: block; font-size: 13px; }
form output:empty { display: none; }
form output.err { margin-top: var(--s3); padding: var(--s2) var(--s3); background: var(--fault-wash); color: var(--ink); border-left: 3px solid var(--fault); }
.signal form output.err { background: var(--plate); color: var(--ink); }
form[aria-busy="true"] { opacity: 0.75; }
details.more { margin: var(--s3) 0 0; }
details.more > summary { cursor: pointer; font-size: 13px; font-weight: 600; width: max-content; list-style: none; text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
details.more > summary::-webkit-details-marker { display: none; }

/* Commands */
.cmd { display: flex; align-items: stretch; margin: var(--s3) 0 0; max-width: 100%; border: 1px solid var(--rule); border-radius: var(--r); background: var(--plate-2); font-size: 13px; }
.cmd code { flex: 1; min-width: 0; padding: 5px var(--s3); white-space: pre-wrap; overflow-wrap: anywhere; }
.cmd button { flex: none; padding: 0 var(--s3); border: 0; border-left: 1px solid var(--rule); background: transparent; color: var(--ink-2); font-size: 12px; font-weight: 600; cursor: pointer; }
.cmd button:hover { color: var(--ink); }
html:not(.js) .cmd button { display: none; }

/* Work cards */
.card { position: relative; padding: var(--s4) var(--s5); background: var(--plate); border: 1px solid var(--rule); border-left: 3px solid var(--live); border-radius: var(--r); }
.card.submitted { border-left-color: var(--ink-2); }
.card .t { display: flex; gap: var(--s3); align-items: baseline; font-size: 16px; line-height: 1.3; font-weight: 600; }
.card .t .g { align-self: center; }
.card .t .title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card .t .id { font-size: 14px; margin-right: var(--s1); }
.card .who { margin: var(--s2) 0 0; font-size: 13px; color: var(--ink-2); }
.card .who .mono { color: var(--ink); }
.phase { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--s1); margin: var(--s4) 0 0; font-size: 11px; color: var(--ink-3); }
.phase li { padding-top: var(--s2); border-top: 3px solid var(--rule); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.phase li.done { border-color: var(--ink); color: var(--ink-2); }
.phase li.now { border-color: var(--live); color: var(--live); font-weight: 600; }
.status-line { margin: var(--s2) 0 0; font-size: 13px; }
.lease { display: flex; align-items: center; gap: var(--s3); margin: var(--s3) 0 0; font-size: 12px; color: var(--ink-2); }
.lease .track { flex: 1; height: 4px; background: var(--plate-2); border: 1px solid var(--rule); max-width: 240px; }
.lease .fill { display: block; height: 100%; background: var(--live); }
.lease.warn { color: var(--fault); }
.lease.warn .fill { background: var(--fault); }
.last { margin: var(--s4) 0 0; padding: 0 0 0 var(--s4); border-left: 2px solid var(--rule); font-size: 13px; }
.last p { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; max-width: 75ch; }
.last footer { margin-top: var(--s2); color: var(--ink-3); font-size: 12px; }
.cost { margin: var(--s3) 0 0; font-size: 12px; color: var(--ink-3); }
.cards { display: grid; gap: var(--s3); align-content: start; }

/* Gate pips */
.pips { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); margin: var(--s3) 0 0; font-size: 12px; color: var(--ink-2); }
.pip { display: inline-flex; align-items: center; gap: var(--s2); }
.pip::before { content: ""; width: 10px; height: 10px; box-sizing: border-box; border: 1.5px solid var(--ink-3); border-radius: 1px; }
.pip.pass::before { background: var(--ink); border-color: var(--ink); }
.pip.fail { color: var(--fault); font-weight: 600; }
.pip.fail::before { content: "\\00d7"; display: inline-flex; align-items: center; justify-content: center; background: var(--fault); border-color: var(--fault); color: var(--plate); font-size: 11px; line-height: 1; }
.pip.waived::before { background: var(--signal); border-color: var(--signal-edge); }
.pip.pass { color: var(--ink); }

/* Queue rows */
.rows { display: grid; background: var(--plate); border: 1px solid var(--rule); border-radius: var(--r); }
.row { display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: var(--s1) var(--s3); padding: var(--s3) var(--s4); border-top: 1px solid var(--rule); font-size: 13px; }
.row:first-child { border-top: 0; }
.row .g { margin-top: 3px; }
.row a { display: block; min-width: 0; }
.row .t { color: var(--ink); }
.row .t .id { margin-right: var(--s2); }
.row .meta { grid-column: 2; color: var(--ink-3); font-size: 12px; }
.row .meta .why { color: var(--ink-2); }
.row .meta .owner { color: var(--ink); font-weight: 600; }

/* Digest and history */
.feed { display: grid; }
.ev { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: var(--s3); padding: var(--s2) 0; border-top: 1px solid var(--rule); font-size: 13px; }
.ev:first-child { border-top: 0; }
.ev time { color: var(--ink-3); font-size: 12px; padding-top: 1px; }
.ev .txt { overflow-wrap: anywhere; }
.ev .txt a { text-decoration: none; font-family: var(--mono); font-size: 0.92em; font-weight: 600; }
.ev .txt a:hover { text-decoration: underline; }
.ev.fault .txt { color: var(--fault); }
.ev.signal .txt::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: var(--s2); background: var(--signal); border: 1px solid var(--signal-edge); }
.ev.done .txt { font-weight: 600; }
.ev.new { box-shadow: inset 3px 0 0 var(--live); padding-left: var(--s3); }
.since-sum { margin: 0 0 var(--s3); font-size: 13px; color: var(--ink-2); }
.since-sum b { color: var(--ink); }

/* Change flash: items that changed in a live update */
.changed { animation: flash 1600ms ease-out; }
@keyframes flash { from { background-color: var(--live-wash); } }

/* Toast */
.toast { position: fixed; z-index: 40; left: 50%; bottom: var(--s6); transform: translateX(-50%); padding: var(--s3) var(--s5); background: var(--ink); color: var(--plate); border-radius: var(--r); box-shadow: var(--shadow); font-size: 13px; opacity: 0; pointer-events: none; transition: opacity 200ms var(--ease); }
.toast.on { opacity: 1; }
.notice { display: none; margin: 0 0 var(--s4); padding: var(--s3) var(--s4); background: var(--plate); border: 1px solid var(--rule); border-left: 3px solid var(--live); font-size: 13px; }
.notice.on { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3); }
`;

const VIEWS = `
main { padding: var(--s5) var(--s6) var(--s8); }
.view { display: none; }
.view:target, main:not(:has(.view:target)) #board { display: block; }
html.js .view { display: none; }
html.js[data-view="board"] #board, html.js[data-view="plan"] #plan, html.js[data-view="history"] #history, html.js[data-view="spend"] #spend { display: block; }
.viewh { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s3) var(--s5); margin: 0 0 var(--s5); }
.viewh h2 { font-size: 20px; line-height: 1.25; font-weight: 600; }
.viewh p { color: var(--ink-2); max-width: 75ch; }

/* Board */
.board { display: grid; gap: var(--s6); grid-template-columns: minmax(0, 1fr); grid-template-areas: "need" "work" "next" "since"; }
.col-need { grid-area: need; }
.col-work { grid-area: work; }
.col-next { grid-area: next; }
.col-since { grid-area: since; }
.col-need.calm .colh { color: var(--ink-3); }
.next-split { display: grid; gap: var(--s5); }
.col-since .feed { max-height: 420px; overflow: auto; }
@media (min-width: 720px) {
  .board { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "need next" "work next" "since next"; align-items: start; }
}
@media (min-width: 1100px) {
  .board { grid-template-columns: minmax(300px, 1fr) minmax(0, 1.25fr) minmax(0, 1fr); grid-template-areas: "since since since" "need work next"; }
  .since-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s4); }
  .since-head .colh { padding-bottom: var(--s2); }
  .since-head .colh .aside { margin-left: var(--s3); }
  .col-since .since-sum { margin-bottom: var(--s2); }
  .col-since .feed { max-height: 86px; padding: 0 var(--s4); background: var(--plate); border: 1px solid var(--rule); }
}
@media (min-width: 1700px) {
  .board { grid-template-columns: minmax(320px, 1fr) minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "need work next since"; }
  .since-head { display: block; }
  .col-since .feed { max-height: none; padding: 0; background: none; border: 0; }
}
@media (min-width: 2600px) {
  .board { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1fr); }
  .col-work .cards { grid-template-columns: 1fr 1fr; }
  .col-next .next-split { grid-template-columns: 1fr 1fr; align-items: start; }
  .next-split .grouph { margin-top: 0; }
}
@media (min-width: 1100px) and (min-height: 700px) {
  html.js body.fit { height: 100vh; display: flex; flex-direction: column; }
  html.js body.fit main { flex: 1; min-height: 0; overflow: auto; }
  html.js[data-view="board"] body.fit main { overflow: hidden; display: flex; flex-direction: column; }
  html.js[data-view="board"] body.fit #board { flex: 1; min-height: 0; }
  html.js[data-view="board"] body.fit #board .board { height: 100%; grid-template-rows: auto minmax(0, 1fr); }
  html.js[data-view="board"] body.fit .board > .col { min-height: 0; overflow: auto; padding-right: var(--s2); scrollbar-width: thin; }
}
@media (min-width: 1700px) and (min-height: 700px) {
  html.js[data-view="board"] body.fit #board .board { grid-template-rows: minmax(0, 1fr); }
}

/* Plan */
.plan-wrap { overflow: auto; background: var(--plate); border: 1px solid var(--rule); border-radius: var(--r); }
svg.graph { display: block; }
.graph .edge { fill: none; stroke: var(--rule-2); stroke-width: 1.2; }
.graph .edge.done { stroke: var(--rule); }
.graph .edge.hot { stroke: var(--live); stroke-width: 2; }
.graph .arrow { fill: var(--rule-2); }
.graph .node rect.box { fill: var(--plate); stroke: var(--ink); stroke-width: 1.5; }
.graph .node text { fill: var(--ink); font: 13px var(--sans); }
.graph .node .nid { font: 600 12px var(--mono); }
.graph .node .nmeta { fill: var(--ink-3); font-size: 11px; }
.graph .s-blocked rect.box { stroke: var(--rule-2); stroke-dasharray: 4 3; }
.graph .s-in_progress rect.box { stroke: var(--live); stroke-width: 2.5; fill: var(--live-wash); }
.graph .s-submitted rect.box { stroke: var(--ink-2); }
.graph .s-rework rect.box { stroke: var(--fault); stroke-width: 2.5; fill: var(--fault-wash); }
.graph .s-accepted rect.box, .graph .s-cancelled rect.box { fill: var(--plate-2); stroke: var(--rule); stroke-width: 1; }
.graph .s-accepted text, .graph .s-cancelled text { fill: var(--ink-3); }
.graph .s-cancelled .ntitle { text-decoration: line-through; }
.graph .flag { fill: var(--signal); stroke: var(--signal-edge); }
.graph a:focus-visible { outline: none; }
.graph a:focus-visible rect.box, .graph a:hover rect.box { stroke: var(--focus); stroke-width: 2.5; }
.graph.hide-done .s-accepted, .graph.hide-done .s-cancelled, .graph.hide-done .edge.done { opacity: 0.25; }
.plan-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s4); margin: 0 0 var(--s4); font-size: 13px; color: var(--ink-2); }
.plan-tools label { display: inline-flex; align-items: center; gap: var(--s2); cursor: pointer; }
html:not(.js) .plan-tools label { display: none; }
.legend { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); }
.legend li { display: inline-flex; align-items: center; gap: var(--s2); }
.layers { display: none; }
.layer + .layer { margin-top: var(--s5); }
@media (max-width: 719px) {
  .plan-wrap { display: none; }
  .layers { display: block; }
}

/* History */
.filters { max-width: 1200px; display: flex; flex-wrap: wrap; gap: var(--s2); margin: 0 0 var(--s4); }
.filters input { position: absolute; opacity: 0; pointer-events: none; }
.filters input + label { padding: var(--s2) var(--s4); border: 1px solid var(--rule); border-radius: var(--r); background: var(--plate); font-size: 13px; cursor: pointer; }
.filters input + label:hover { border-color: var(--rule-2); }
.filters input:checked + label { background: var(--ink); border-color: var(--ink); color: var(--plate); font-weight: 600; }
.filters input:focus-visible + label { outline: 2px solid var(--focus); outline-offset: 2px; }
.filters .field { margin: 0 0 0 auto; display: flex; align-items: center; gap: var(--s3); }
.filters .field input { position: static; opacity: 1; pointer-events: auto; width: 120px; }
html:not(.js) .filters .field { display: none; }
${['flow', 'gates', 'decisions', 'messages', 'owner', 'trouble', 'plan'].map((k) => `#history:has(#hf-${k}:checked) .ev:not([data-kind="${k}"]) { display: none; }`).join('\n')}
#history:has(#hf-all:checked) .ev { display: grid; }
.day { margin: 0 0 var(--s5); max-width: 1200px; }
.day h3 { margin: 0 0 var(--s2); font-size: 13px; font-weight: 600; color: var(--ink-2); }
.day .feed { padding: var(--s2) var(--s4); background: var(--plate); border: 1px solid var(--rule); border-radius: var(--r); }
.day .ev { grid-template-columns: 76px minmax(0, 1fr); }
.history-note { margin: var(--s4) 0 0; color: var(--ink-3); font-size: 13px; }

/* Spend */
.totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--s3); margin: 0 0 var(--s6); }
.total { padding: var(--s4) var(--s5); background: var(--plate); border: 1px solid var(--rule); border-radius: var(--r); }
.total .big { font-size: 26px; line-height: 1.2; font-weight: 600; }
.total .sub { margin: var(--s2) 0 0; color: var(--ink-2); font-size: 13px; }
.total .meter { margin-top: var(--s3); }
.total .meter .track { width: 160px; }
.tables { display: grid; gap: var(--s6); }
@media (min-width: 1280px) { .tables { grid-template-columns: 1fr 1fr; } .tables .wide { grid-column: 1 / -1; } }
.tbl { width: 100%; border-collapse: collapse; background: var(--plate); border: 1px solid var(--rule); font-size: 13px; }
.tbl th, .tbl td { padding: var(--s3) var(--s4); text-align: left; border-top: 1px solid var(--rule); vertical-align: middle; }
.tbl thead th { border-top: 0; background: var(--plate-2); color: var(--ink-2); font-size: 12px; font-weight: 600; white-space: nowrap; }
.tbl td.num, .tbl th.num { text-align: right; white-space: nowrap; }
.tbl .barcell { width: 32%; min-width: 90px; }
.share { height: 8px; background: var(--plate-2); }
.share span { display: block; height: 100%; background: var(--ink-2); }
.tbl-wrap { overflow-x: auto; }
.tbl caption { padding: 0 0 var(--s3); text-align: left; font-size: 13px; font-weight: 600; color: var(--ink-2); }

/* Task sheet */
.sheet { display: none; position: fixed; inset: 0; z-index: 30; }
.sheet:target { display: block; }
html.js .sheet { display: none; }
html.js .sheet.open { display: block; }
.sheet .scrim { position: absolute; inset: 0; background: rgba(10, 14, 18, 0.35); }
.sheet .panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(760px, 100vw); display: flex; flex-direction: column; background: var(--paper); border-left: 1px solid var(--rule); box-shadow: var(--shadow); animation: slide 200ms var(--ease); }
@keyframes slide { from { transform: translateX(24px); opacity: 0.4; } }
.sheet .shead { padding: var(--s5) var(--s6) var(--s4); background: var(--plate); border-bottom: 1px solid var(--rule); }
.sheet .shead .top { display: flex; align-items: center; gap: var(--s3); font-size: 13px; color: var(--ink-2); }
.sheet .shead .close { margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid var(--rule); border-radius: var(--r); text-decoration: none; font-size: 18px; line-height: 1; color: var(--ink-2); }
.sheet .shead .close:hover { color: var(--ink); border-color: var(--rule-2); }
.sheet h2:focus { outline: none; }
.sheet h2 { margin: var(--s2) 0 0; font-size: 20px; line-height: 1.25; font-weight: 600; max-width: 62ch; }
.sheet h2 .id { font-size: 16px; margin-right: var(--s3); }
.sheet .facts { margin: var(--s3) 0 0; display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); font-size: 13px; color: var(--ink-2); }
.sheet .facts b { color: var(--ink); font-weight: 600; }
.sheet .sbody { flex: 1; overflow: auto; overflow-wrap: anywhere; padding: var(--s5) var(--s6) var(--s8); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s6); align-content: start; }
.sec h3 { margin: 0 0 var(--s3); font-size: 13px; font-weight: 600; color: var(--ink-2); }
.sec .box { padding: var(--s4) var(--s5); background: var(--plate); border: 1px solid var(--rule); border-radius: var(--r); }
.accept li { position: relative; padding: var(--s2) 0 var(--s2) var(--s5); max-width: 75ch; overflow-wrap: anywhere; }
.accept li::before { content: ""; position: absolute; left: 0; top: 11px; width: 6px; height: 6px; background: var(--ink-3); }
.blockers li { padding: var(--s1) 0; }
.gates-tbl td:first-child { white-space: nowrap; }
.ledger { display: grid; gap: var(--s3); }
.ledger > details { background: var(--plate); border: 1px solid var(--rule); border-radius: var(--r); }
.ledger > details > summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s3); padding: var(--s3) var(--s4); cursor: pointer; font-size: 13px; }
.ledger > details > summary .mono { font-weight: 600; }
.entry { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: var(--s2) var(--s4); padding: var(--s3) var(--s4); border-top: 1px solid var(--rule); font-size: 13px; }
.entry .type { font-weight: 600; }
.entry .type.fail { color: var(--fault); }
.entry .by { color: var(--ink-2); font-size: 12px; }
.entry .sum { grid-column: 2; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 80ch; }
.entry:has(details.more2[open]) .sum.long { max-height: none; -webkit-mask-image: none; mask-image: none; }
.entry .sum.long { max-height: 9.5em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.entry details.receipts { grid-column: 2; }
.entry details.receipts summary { padding: 0; font-size: 12px; color: var(--ink-2); }
.entry details.more2 > summary { padding: 0; font-size: 12px; color: var(--ink-2); }
.entry details.more2[open] > summary { font-size: 0; }
.entry details.more2[open] > summary::after { content: "Clip the summary"; font-size: 12px; }
.entry .receipt { margin: var(--s2) 0 0; padding: var(--s2) var(--s3); background: var(--plate-2); font: 12px/1.4 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.entry .nocount { color: var(--ink-3); }
.thread { display: grid; gap: var(--s3); }
.thread .msg { padding: var(--s3) var(--s4); background: var(--plate); border: 1px solid var(--rule); border-radius: var(--r); font-size: 13px; }
.thread .msg.owner { border-left: 3px solid var(--signal-edge); }
.thread .msg.fault { border-left: 3px solid var(--fault); }
.thread .msg header { display: flex; flex-wrap: wrap; gap: var(--s3); color: var(--ink-3); font-size: 12px; }
.thread .msg header .mono { color: var(--ink-2); }
.thread .msg p { margin: var(--s2) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 80ch; }
.links li { display: flex; gap: var(--s3); align-items: baseline; padding: var(--s1) 0; }
.links a { text-decoration: none; }
.links a:hover .t { text-decoration: underline; }
.split2 { display: grid; gap: var(--s5); }
@media (min-width: 640px) { .split2 { grid-template-columns: 1fr 1fr; } }
@media (max-width: 719px) {
  .sheet .panel { width: 100vw; border-left: 0; }
  .sheet .shead, .sheet .sbody { padding-left: var(--s5); padding-right: var(--s5); }
}

/* Narrow screens */
@media (max-width: 719px) {
  .topbar { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "brand state" "proj proj" "rail rail" "nav nav"; padding: var(--s4) var(--s5) 0; }
  .proj { flex-direction: column; gap: var(--s1); }
  .proj h1 { white-space: normal; }
  .goal { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .state .spendmini { display: none; }
  main { padding: var(--s4) var(--s5) var(--s8); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .changed { box-shadow: inset 3px 0 0 var(--live); }
}
@media print {
  .views, .skip, .acts, form, .cmd button { display: none !important; }
  .view { display: block !important; break-before: page; }
}
`;

const CSS = TOKENS + BASE + COMPONENTS + VIEWS;

module.exports = { CSS, TOKENS, BASE, COMPONENTS };
