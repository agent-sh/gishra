'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function history(h) {
  h.init();
  for (const title of ['one', 'two', 'three']) h.ok(['task', 'add', '--title', title, '--acceptance', 'done']);
  const lines = [];
  let clock = Date.parse('2026-10-07T00:00:00Z');
  const at = () => new Date(clock += 1000).toISOString();
  const evidence = { T1: [], T2: [], T3: [] };
  const gate = (task, type, sha, ok, summary = null) => {
    const time = at();
    lines.push({ at: time, agent: 'orchestrator', cmd: type === 'merge' ? 'merge' : `check ${type}`, task, detail: { type, ok, sha, source: `check ${type}` } });
    evidence[task].push({ type, ok, sha, agent: 'orchestrator', at: time, summary, ref: null, revision: 1 });
  };
  const ev = (task, cmd, detail, agent = 'orchestrator') => lines.push({ at: at(), agent, cmd, task, detail });
  // T1: a tests fail the same sha later passes, then a review blocker at that sha.
  ev('T1', 'submit', { sha: A });
  gate('T1', 'tests', A, false);
  gate('T1', 'tests', A, true);
  gate('T1', 'tests', A, true);
  ev('T1', 'evidence', { type: 'review', ok: false, sha: A }, 'reviewer-T1-1');
  // An agent's own tests note is not a gate run.
  ev('T1', 'evidence', { type: 'tests', ok: true, sha: A }, 'worker-T1-1');
  // T2: a fail that stood until a new sha, a pass a review confirms despite a
  // mergeability failure, then a pass a failing check run contradicts.
  ev('T2', 'submit', { sha: A });
  gate('T2', 'tests', A, false);
  ev('T2', 'submit', { sha: B });
  gate('T2', 'tests', B, true);
  gate('T2', 'ci', B, false, 'PR #3 mergeability is unknown or unavailable (UNKNOWN, UNKNOWN); wait for GitHub to compute it.');
  gate('T2', 'ci', B, true);
  ev('T2', 'evidence', { type: 'review', ok: true, sha: B }, 'reviewer-T2-1');
  ev('T2', 'submit', { sha: C });
  gate('T2', 'clean', C, true);
  gate('T2', 'ci', C, false, `CI not green at ${C.slice(0, 10)} in o/r:\nfailing: test (windows-latest, node 24, shard 1/2) (failure), lint (failure)\ncheck suites not green: github-actions (failure, 2 runs)`);
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const doc = h.readState('tasks.json');
  for (const task of doc.tasks) task.evidence = evidence[task.id];
  h.writeState('tasks.json', doc);
}

test('bench gates labels gate fails overturned at the same sha and passes later contradicted', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  history(h);
  const r = h.json(['bench', 'gates']);
  const tests = r.gates.find((g) => g.gate === 'tests');
  // T1's two passes at A count once; T1 and T2 fails are one fp and one tp.
  assert.deepEqual([tests.runs, tests.results, tests.tp, tests.fp, tests.fn, tests.tn, tests.open], [5, 4, 1, 1, 1, 1, 0]);
  assert.deepEqual(tests.fn_by, { review: 1, ci: 0 });
  assert.equal(tests.precision, 0.5);
  assert.equal(tests.recall, 0.5);
  const clean = r.gates.find((g) => g.gate === 'clean');
  assert.deepEqual([clean.fn, clean.fn_by.ci], [1, 1], 'a failed check run contradicts the clean pass');
  const ci = r.gates.find((g) => g.gate === 'ci');
  assert.deepEqual([ci.fp, ci.tn, ci.open], [1, 1, 1], 'the mergeability failure is overturned, not a code fault');
  assert.deepEqual(r.ci_fail_reasons, { mergeability: 1, checks: 1 });
  assert.deepEqual(r.ci_checks.map((c) => c.check).sort(), ['lint', 'test (windows-latest, node 24)']);
  assert.equal(r.labels.filter((l) => l.task === 'T1' && l.gate === 'tests').length, 3, 'manual tests evidence is not labeled');
});

test('bench gates scores deslop checks from hand verdicts, a reviewer eval and an agent report', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  h.init();
  const file = (name, text) => { const p = path.join(h.base, name); fs.writeFileSync(p, text); return p; };
  const hits = file('hits.jsonl', [
    { detector: 'debug', verdict: 'true-slop' }, { detector: 'debug', verdict: 'harmless' },
    { detector: 'debug', verdict: 'false-positive' }, { detector: 'debug', verdict: 'false-positive' },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const findings = file('findings.jsonl', [
    { source: 'o/r#1 https://x', reviewed_commit: 'abc', example: 'lib/a.js:10', deslop_caught: false },
    { source: 'o/r#1 https://y', reviewed_commit: 'abc', example: 'docs/b.md', deslop_caught: true },
    { source: 'o/r#2 https://z', reviewed_commit: 'def', example: 'x.js:1', deslop_caught: false },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const runs = file('runs.json', JSON.stringify({
    'o/r#1@abc': { items: [{ check: 'stale-mention', file: 'lib/a.js', line: 14 }, { check: 'stale-mention', file: 'lib/a.js', line: 40 }, { check: 'missing-path', file: 'docs/b.md', line: 3 }] },
    'o/r#1@head': { items: [{ check: 'stale-mention', file: 'z.js', line: 1 }] },
  }));
  const report = file('report.json', JSON.stringify({ findings: [{ check: 'missing-path' }], dismissed: [{ check: 'missing-path' }, { check: 'em-dash' }] }));
  const r = h.json(['bench', 'gates', '--deslop-hits', hits, '--deslop-findings', findings, '--deslop-runs', runs, '--deslop-report', report]);
  assert.deepEqual(r.deslop.hits, [{ check: 'debug', items: 4, tp: 1, harmless: 1, fp: 2, precision: 0.25, precision_lenient: 0.5 }]);
  const e = r.deslop.eval;
  assert.deepEqual([e.findings, e.previous_caught, e.evaluated, e.caught], [3, 1, 2, 2], 'o/r#2 has no run and is not evaluated');
  const stale = e.checks.find((c) => c.check === 'stale-mention');
  assert.deepEqual([stale.items, stale.tp, stale.unconfirmed, stale.caught, stale.recall], [2, 1, 1, 1, 0.5], 'head runs carry no labels');
  assert.deepEqual(r.deslop.report.map((c) => [c.check, c.confirmed, c.dismissed]), [['missing-path', 1, 1], ['em-dash', 0, 1]]);
  const refused = h.run(['bench', 'gates', '--deslop-runs', runs]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--deslop-runs needs --deslop-findings/);
});

test('bench tokens reports accepted-task tokens and cost by rung and escalation path', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  h.init();
  for (const title of ['climbed', 'direct', 'open']) h.ok(['task', 'add', '--title', title, '--acceptance', 'done']);
  const spend = (task, rung, model, tokens, cached) => h.ok(['spend', task, '--tokens', String(tokens), '--input', String(tokens - 10),
    '--cached', String(cached), '--output', '10', '--rung', rung, '--model', model, '--harness', 'codex']);
  spend('T1', 'easy', 'openai.gpt-6-luna', 1000010, 0);
  spend('T1', 'medium', 'openai.gpt-6.1-sol', 3000010, 2000000);
  spend('T1', 'review', 'openai.gpt-6.1-sol', 500010, 0);
  spend('T2', 'medium', 'openai.gpt-6.1-sol', 2000010, 0);
  spend('T3', 'easy', 'openai.gpt-6-luna', 7000010, 0);
  // Minute-only manual records are not missing telemetry.
  h.ok(['spend', 'T2', '--minutes', '5']);
  const spawn = (task, rung) => JSON.stringify({ at: new Date().toISOString(), agent: 'orchestrator', cmd: 'spawn', task, detail: { role: 'worker', rung, agent: `worker-${task}` } });
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), [spawn('T1', 'easy'), spawn('T1', 'easy'), spawn('T1', 'medium'), spawn('T2', 'medium')].join('\n') + '\n');
  const doc = h.readState('tasks.json');
  doc.tasks[0].status = 'accepted';
  doc.tasks[1].status = 'accepted';
  h.writeState('tasks.json', doc);
  const prices = path.join(h.base, 'prices.json');
  fs.writeFileSync(prices, JSON.stringify({ luna: { input: 0.1, cache_write: 0.1, cache_read: 0.01, output: 0.5 }, sol: { input: 2, cache_write: 2, cache_read: 0.1, output: 10 } }));
  const r = h.json(['bench', 'tokens', '--prices', prices]);
  assert.deepEqual([r.accepted, r.complete], [2, 2]);
  assert.equal(r.all_tasks_tokens, 13500050, 'spend on unaccepted tasks counts toward the cost of accepted ones');
  assert.equal(r.tokens_per_accepted, 6750025);
  assert.deepEqual(Object.keys(r.by_path), ['easy>medium', 'medium']);
  assert.equal(r.by_path['easy>medium'].median_tokens, 4500030);
  assert.equal(r.by_rung.medium.median_tokens, 2500010);
  assert.equal(r.by_rung.medium.tasks, 2);
  const t1 = r.tasks.find((x) => x.id === 'T1');
  assert.deepEqual([t1.fresh, t1.cached, t1.output], [2500000, 2000000, 30]);
  // easy 1M fresh luna, medium 1M fresh + 2M cached sol, review 0.5M fresh sol, plus output.
  const usd = 1 * 0.1 + 10e-6 * 0.5 + (1 * 2 + 2 * 0.1 + 10e-6 * 10) + (0.5 * 2 + 10e-6 * 10);
  assert.ok(Math.abs(r.by_path['easy>medium'].median_usd - usd) < 1e-9);
  const text = h.ok(['bench', 'tokens']);
  assert.match(text, /accepted tasks: 2, with complete token records: 2/);
  assert.match(text, /easy>medium\s+1\s+4\.50M/);
});
