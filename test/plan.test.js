'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

test('task add stores the task with defaults and refuses bad input', (t) => {
  const h = makeRepo(t);
  h.init();
  assert.equal(h.ok(['task', 'add', '--title', 'Schema', '--acceptance', 'table exists', '--acceptance', 'migration runs']), 'T1');
  const t1 = h.readState('tasks.json').tasks[0];
  assert.deepEqual(
    { kind: t1.kind, size: t1.size, tier: t1.tier, status: t1.status, revision: t1.revision, acceptance: t1.acceptance },
    { kind: 'code', size: 'M', tier: 'medium', status: 'todo', revision: 1, acceptance: ['table exists', 'migration runs'] },
  );

  const noAcc = h.run(['task', 'add', '--title', 'x']);
  assert.equal(noAcc.code, 2);
  assert.match(noAcc.stderr, /--acceptance/);

  const unknownDep = h.run(['task', 'add', '--title', 'x', '--acceptance', 'a', '--dep', 'T9']);
  assert.equal(unknownDep.code, 1);
  assert.match(unknownDep.stderr, /T9, which does not exist/);

  const badSize = h.run(['task', 'add', '--title', 'x', '--acceptance', 'a', '--size', 'XL']);
  assert.equal(badSize.code, 2);
  const badTier = h.run(['task', 'add', '--title', 'x', '--acceptance', 'a', '--tier', 'ghost']);
  assert.equal(badTier.code, 2);
  assert.match(badTier.stderr, /--tier must be one of easy, medium, hard, research/);
  assert.equal(h.readState('tasks.json').tasks.length, 1, 'refused adds wrote nothing');
});

test('task update refuses a dependency cycle and bumps revision on acceptance or dependency changes', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'C', '--acceptance', 'c', '--dep', 'T2']);
  const cyc = h.run(['task', 'update', 'T1', '--dep', 'T3']);
  assert.equal(cyc.code, 1);
  assert.match(cyc.stderr, /cycle \(T1 -> T3 -> T2 -> T1/);
  assert.deepEqual(h.readState('tasks.json').tasks[0].depends_on, []);

  h.ok(['task', 'update', 'T2', '--title', 'B renamed']);
  assert.equal(h.readState('tasks.json').tasks[1].revision, 1, 'a title change keeps the revision');
  h.ok(['task', 'update', 'T2', '--acceptance', 'b2']);
  assert.equal(h.readState('tasks.json').tasks[1].revision, 2);
  h.ok(['task', 'update', 'T2', '--dep', '']);
  const t2 = h.readState('tasks.json').tasks[1];
  assert.equal(t2.revision, 3);
  assert.deepEqual(t2.depends_on, []);
  h.ok(['task', 'update', 'T3', '--status', 'cancelled']);
  assert.equal(h.readState('tasks.json').tasks[2].status, 'cancelled');
  assert.equal(h.run(['task', 'update', 'T3', '--status', 'accepted']).code, 2);
});

test('plan import resolves local names in order and is all or nothing', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'existing', '--acceptance', 'x']);
  const plan = path.join(h.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify([
    { id: 'schema', title: 'Schema', acceptance: 'table exists', size: 'S' },
    { id: 'api', title: 'API', acceptance: ['endpoint works'], depends_on: ['schema', 'T1'] },
    { title: 'Docs', acceptance: ['readme'], kind: 'docs', depends_on: ['api'], needs_owner: 'approve wording' },
  ]));
  const out = h.json(['plan', 'import', plan]);
  assert.deepEqual(out.added.map((a) => [a.id, a.local]), [['T2', 'schema'], ['T3', 'api'], ['T4', null]]);
  const tasks = h.readState('tasks.json').tasks;
  assert.deepEqual(tasks[2].depends_on, ['T2', 'T1']);
  assert.deepEqual(tasks[3].depends_on, ['T3']);
  assert.equal(tasks[3].needs_owner, 'approve wording');
  assert.equal(tasks[1].size, 'S');

  const before = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
  const cases = [
    [[{ id: 'a', title: 'A', acceptance: 'x' }, { title: 'B', acceptance: 'y', depends_on: ['later'] }, { id: 'later', title: 'L', acceptance: 'z' }], /unknown dependency later/],
    [[{ title: 'A', acceptance: 'x' }, { title: 'no acceptance' }], /plan entry 2 has no acceptance/],
    [[{ title: 'A', acceptance: 'x', deps: ['T1'] }], /unknown field deps/],
    [[{ title: 'A', acceptance: 'x', size: 'XL' }], /size must be one of S, M, L/],
  ];
  for (const [entries, msg] of cases) {
    fs.writeFileSync(plan, JSON.stringify(entries));
    const r = h.run(['plan', 'import', plan]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, msg);
    assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), before, 'a refused import adds nothing');
  }
});

test('validate reports cycles, unknown dependencies, missing acceptance, unsplit L tasks and oversize budgets', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'C', '--acceptance', 'c']);
  h.ok(['task', 'add', '--title', 'D', '--acceptance', 'd', '--size', 'L']);
  const clean = h.run(['validate']);
  assert.equal(clean.code, 1, 'the L task is reported');
  assert.match(clean.stdout, /T4 is size L/);
  h.ok(['task', 'note', 'T4', 'split: one migration, cannot land in parts']);
  assert.equal(h.run(['validate']).code, 0);

  // Files edited by hand can hold what the CLI refuses to write.
  const doc = h.readState('tasks.json');
  doc.tasks[0].depends_on = ['T2'];
  doc.tasks[2].depends_on = ['T9'];
  doc.tasks[2].acceptance = [];
  h.writeState('tasks.json', doc);
  const r = h.run(['validate', '--json']);
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  const kinds = report.issues.map((i) => `${i.kind}:${i.task}`).sort();
  assert.deepEqual(kinds, ['cycle:T1', 'no-acceptance:T3', 'unknown-dependency:T3']);
  assert.match(report.issues.find((i) => i.kind === 'cycle').message, /T1 -> T2 -> T1/);

  h.writeState('tasks.json', { ...doc, tasks: doc.tasks.map((x) => ({ ...x, depends_on: [], acceptance: ['ok'] })) });
  h.ok(['project', 'set', '--budget-hours', '10']);
  const overRun = h.run(['validate', '--json']);
  assert.equal(overRun.code, 1);
  const over = JSON.parse(overRun.stdout);
  assert.equal(over.ok, false);
  assert.deepEqual(over.issues.map((i) => i.kind), ['budget']);
  assert.match(over.issues[0].message, /about 20 h .* budget of 10 h/);
});

test('notes and briefs round-trip', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'note', 'T1', 'found', 'the', 'flaky', 'test'], { env: { GISHRA_AGENT: 'w-1' } });
  const note = h.readState('tasks.json').tasks[0].notes[0];
  assert.equal(note.text, 'found the flaky test');
  assert.equal(note.agent, 'w-1');

  const missing = h.run(['brief', 'get', 'T1']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /brief set T1/);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Context\n\nUse the retry table.\n' });
  assert.equal(h.ok(['brief', 'get', 'T1']), '# Context\n\nUse the retry table.');
  const file = path.join(h.base, 'brief.md');
  fs.writeFileSync(file, 'from a file\n');
  h.ok(['brief', 'set', 't1', '--file', file]);
  assert.equal(fs.readFileSync(path.join(h.state, 'briefs', 'T1.md'), 'utf8'), 'from a file\n');
  assert.equal(h.run(['brief', 'set', 'T1']).code, 2);
});
