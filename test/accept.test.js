'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

function submitted(h, extra = [], kind = 'code') {
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', kind]);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', h.sha.slice(0, 10), '--agent', 'w-1', ...extra]);
}

const ev = (h, type, agent, ok = true) => ['tests', 'clean', 'ci'].includes(type)
  ? gateEvidence(h, type, agent, ok)
  : h.ok(['evidence', 'T1', '--type', type, ok ? '--ok' : '--fail', '--agent', agent]);

test('accept refuses a code task without gates, and a review by the submitter does not count', (t) => {
  const h = makeRepo(t);
  h.init();
  submitted(h);
  const none = h.run(['accept', 'T1']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /tests: no tests evidence/);
  assert.match(none.stderr, /clean: no clean evidence/);
  assert.match(none.stderr, /review: no review evidence/);
  assert.doesNotMatch(none.stderr, /ci:/, 'ci is required only with a PR');

  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'w-1');
  const self = h.run(['accept', 'T1']);
  assert.equal(self.code, 1);
  assert.match(self.stderr, /only the submitter \(w-1\) reviewed/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');

  ev(h, 'review', 'r-1');
  h.ok(['accept', 'T1']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

test('the latest evidence at the submitted sha decides, and other shas do not count', (t) => {
  const h = makeRepo(t);
  h.init();
  submitted(h, ['--pr', '7']);
  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'r-1');
  ev(h, 'ci', 'ci');
  const doc = h.readState('tasks.json');
  // Keep a genuine receipt at another sha to exercise commit matching independently of provenance.
  doc.tasks[0].evidence.at(-1).sha = 'fffffff';
  h.writeState('tasks.json', doc);
  const r = h.run(['accept', 'T1']);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(`ci: no ci evidence at ${h.sha.slice(0, 7)}`));
  ev(h, 'ci', 'ci');
  ev(h, 'tests', 'w-1', false);
  const failed = h.run(['accept', 'T1']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /latest tests at .* failed:/);
  ev(h, 'tests', 'w-1');
  h.ok(['accept', 'T1']);
});

test('a revision bump invalidates earlier evidence', (t) => {
  const h = makeRepo(t);
  h.init();
  submitted(h);
  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'r-1');
  h.ok(['task', 'update', 'T1', '--acceptance', 'it works', '--acceptance', 'and logs it']);
  const r = h.run(['accept', 'T1']);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(`no tests evidence at ${h.sha.slice(0, 7)} for revision 2`));
  assert.match(h.ok(['task', 'show', 'T1']), /revision 1, does not count/);
  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'r-1');
  h.ok(['accept', 'T1']);
});

test('an accepted task keeps its acceptance, dependencies and kind until it is sent back', (t) => {
  const h = makeRepo(t);
  h.init();
  submitted(h);
  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'r-1');
  h.ok(['accept', 'T1']);
  h.ok(['task', 'add', '--title', 'Uses the change', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'Unrelated', '--acceptance', 'c']);
  const before = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
  for (const [flags, what] of [
    [['--acceptance', 'a new unmet criterion'], 'acceptance'],
    [['--dep', 'T3'], 'dependencies'],
    [['--kind', 'docs'], 'kind'],
  ]) {
    const r = h.run(['task', 'update', 'T1', ...flags]);
    assert.equal(r.code, 1, `${flags.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`T1 is accepted, so its ${what} cannot change; send it back first with gishra rework T1`));
  }
  assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), before, 'a refused update writes nothing');
  const t1 = h.json(['task', 'show', 'T1']);
  assert.deepEqual([t1.status, t1.revision, t1.gates.ok], ['accepted', 1, true]);

  h.ok(['task', 'update', 'T1', '--title', 'Change, renamed', '--size', 'S']);
  h.ok(['task', 'update', 'T1', '--acceptance', 'it works']);
  assert.equal(h.readState('tasks.json').tasks[0].revision, 1, 'unchanged acceptance is not a change');

  h.ok(['rework', 'T1', '--reason', 'it must also log retries']);
  h.ok(['task', 'update', 'T1', '--acceptance', 'it works', '--acceptance', 'it logs retries']);
  const reworked = h.readState('tasks.json').tasks[0];
  assert.deepEqual([reworked.status, reworked.revision], ['rework', 2]);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T1', 'T3'], 'T2 waits for T1 again');
});

test('other kinds need only a review from another agent', (t) => {
  const h = makeRepo(t);
  h.init();
  submitted(h, [], 'docs');
  ev(h, 'review', 'w-1');
  assert.equal(h.run(['accept', 'T1']).code, 1);
  ev(h, 'review', 'r-1');
  h.ok(['accept', 'T1']);
});

test('a task of any kind with a PR needs ci ok at the submitted sha', (t) => {
  const h = makeRepo(t);
  h.init();
  submitted(h, ['--pr', '7'], 'docs');
  ev(h, 'review', 'r-1');
  const r = h.run(['accept', 'T1']);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(`ci: no ci evidence at ${h.sha.slice(0, 7)}`));
  ev(h, 'ci', 'ci');
  h.ok(['accept', 'T1']);
});

test('only the owner can waive a gate, and a refused accept records no waiver', (t) => {
  const h = makeRepo(t);
  h.init();
  submitted(h);
  ev(h, 'review', 'r-1');
  const notOwner = h.run(['accept', 'T1', '--waive', 'tests', '--reason', 'no test harness', '--agent', 'orchestrator']);
  assert.equal(notOwner.code, 1);
  assert.match(notOwner.stderr, /only the owner can waive/);
  assert.equal(h.run(['accept', 'T1', '--waive', 'tests', '--agent', 'owner']).code, 2, '--reason is required');

  const partial = h.run(['accept', 'T1', '--waive', 'tests', '--reason', 'no test harness yet']);
  assert.equal(partial.code, 1);
  assert.match(partial.stderr, /clean: no clean evidence/);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.filter((e) => e.waived).length, 0);

  h.ok(['accept', 'T1', '--waive', 'tests', '--waive', 'clean', '--reason', 'generated code']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.deepEqual(task.evidence.filter((e) => e.waived).map((e) => [e.type, e.agent, e.summary]), [
    ['tests', 'owner', 'generated code'],
    ['clean', 'owner', 'generated code'],
  ]);
});

test('rework sends the task back with the reason in the brief, and it can be claimed again', (t) => {
  const h = makeRepo(t);
  h.init();
  submitted(h);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Brief\n\nDo the change.\n' });
  assert.equal(h.run(['rework', 'T1']).code, 2);
  h.ok(['rework', 'T1', '--reason', 'handle the empty key case', '--agent', 'r-1']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  const brief = fs.readFileSync(path.join(h.state, 'briefs', 'T1.md'), 'utf8');
  assert.match(brief, /^# Brief\n\nDo the change\.\n\n## Rework notes\n\n- .* r-1: handle the empty key case\n$/);
  assert.deepEqual(h.json(['ready']).ready.map((x) => [x.id, x.status]), [['T1', 'rework']]);
  h.ok(['claim', 'T1', '--agent', 'w-2']);
  h.ok(['release', 'T1', '--reason', 'not me', '--agent', 'w-2']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'rework', 'release returns to the prior status');
  assert.equal(h.run(['rework', 'T1', '--reason', 'again']).code, 1, 'only submitted or accepted tasks go back');
});

test('evidence needs a sha and exactly one verdict', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  const r = h.run(['evidence', 'T1', '--type', 'review', '--ok']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pass --sha/);
  assert.equal(h.run(['evidence', 'T1', '--type', 'review', '--ok', '--fail', '--sha', 'abcdef1']).code, 2);
  assert.equal(h.run(['evidence', 'T1', '--type', 'vibes', '--ok', '--sha', 'abcdef1']).code, 2);
  h.ok(['evidence', 'T1', '--type', 'note', '--ok', '--sha', 'abcdef1', '--ref', 'run 42']);
  assert.equal(h.readState('tasks.json').tasks[0].evidence[0].ref, 'run 42');
});
