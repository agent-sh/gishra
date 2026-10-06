'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const noAgent = { GISHRA_AGENT: undefined };
const message = 'gishra: no agent: pass --agent NAME or set GISHRA_AGENT\n';
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');

function setup(t) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Owner action', '--acceptance', 'approved', '--needs-owner', 'approve access']);
  return h;
}

test('a non-TTY command without an agent exits 2 and writes nothing', (t) => {
  const h = setup(t);
  const before = events(h);
  const r = h.run(['task', 'note', 'T1', 'lost identity'], { env: noAgent });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stderr, message);
  assert.equal(r.stdout, '');
  assert.equal(events(h), before);
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes, []);
});

test('a task environment without an agent is refused on a non-TTY run', (t) => {
  const h = setup(t);
  const before = events(h);
  const r = h.run(['owner-done', 'T1'], { env: { ...noAgent, GISHRA_TASK: 'T1' } });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stderr, message);
  assert.equal(events(h), before);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
});

test('--agent owner recovers missing identity and overrides the environment', (t) => {
  const h = setup(t);
  assert.equal(h.run(['owner-done', 'T1'], { env: noAgent }).code, 2);
  const task = h.json(['owner-done', 'T1', '--agent', 'owner'], { env: { ...noAgent, GISHRA_TASK: 'T1' } });
  assert.equal(task.needs_owner, null);
  assert.equal(task.notes[0].agent, 'owner');
  h.ok(['task', 'note', 'T1', 'explicit owner', '--agent', 'owner'], { env: { GISHRA_AGENT: 'reviewer' } });
  assert.equal(h.readState('tasks.json').tasks[0].notes[1].agent, 'owner');
});

test('GISHRA_AGENT supplies the recorded identity when --agent is absent', (t) => {
  const h = setup(t);
  assert.equal(h.run(['task', 'note', 'T1', 'missing'], { env: noAgent }).code, 2);
  h.ok(['task', 'note', 'T1', 'named reviewer'], { env: { GISHRA_AGENT: 'reviewer', GISHRA_TASK: 'T1' } });
  assert.equal(h.readState('tasks.json').tasks[0].notes[0].agent, 'reviewer');
});

test('owner-done and waivers require the resolved name owner exactly', (t) => {
  const h = setup(t);
  for (const agent of ['reviewer', 'Owner']) {
    const r = h.run(['owner-done', 'T1', '--agent', agent]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /only the owner/);
    assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
  }
  h.ok(['owner-done', 'T1', '--agent', 'owner']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', 'worker']);
  const waive = ['accept', 'T1', '--waive', 'tests', '--waive', 'clean', '--waive', 'review', '--reason', 'owner approved'];
  for (const agent of ['reviewer', 'Owner']) {
    const r = h.run([...waive, '--agent', agent]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /only the owner can waive/);
    assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  }
  const task = h.json([...waive, '--agent', 'owner'], { env: noAgent });
  assert.equal(task.status, 'accepted');
  assert.ok(task.evidence.every((e) => e.waived && e.agent === 'owner'));
});
