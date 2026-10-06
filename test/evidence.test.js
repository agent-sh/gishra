'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

function setup(t) {
  const h = makeRepo(t);
  const sha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--pr', '1', '--agent', 'worker']);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--agent', 'reviewer']);
  return h;
}

test('manual software evidence is refused for either verdict and every agent without writing state', (t) => {
  const h = setup(t);
  const before = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  for (const type of ['tests', 'clean', 'ci', 'merge']) {
    for (const agent of ['worker', 'reviewer', 'owner']) {
      for (const verdict of ['--ok', '--fail']) {
        const r = h.run(['evidence', 'T1', '--type', type, verdict, '--agent', agent]);
        assert.equal(r.code, 1, `${type} ${agent} ${verdict}: ${r.stderr}`);
        assert.match(r.stderr, /only gishra (check|merge)/);
      }
    }
  }
  assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
  h.ok(['evidence', 'T1', '--type', 'note', '--ok', '--agent', 'worker']);
});

test('hand-written tests ok stays readable but cannot satisfy accept', (t) => {
  const h = setup(t);
  gateEvidence(h, 'clean', 'checker');
  gateEvidence(h, 'ci', 'checker');
  const doc = h.readState('tasks.json');
  // A legacy or hand-edited record must not become proof that a test command ran.
  doc.tasks[0].evidence.push({ type: 'tests', ok: true, sha: doc.tasks[0].sha, agent: 'worker', revision: 1, summary: 'tests passed' });
  h.writeState('tasks.json', doc);
  const shown = h.json(['task', 'show', 'T1']);
  assert.equal(shown.evidence.at(-1).ok, true);
  const r = h.run(['accept', 'T1', '--agent', 'reviewer']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /tests: no tests evidence/);
  assert.doesNotMatch(r.stderr, /clean:|ci:|review:/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
});

for (const type of ['clean', 'ci']) {
  test(`legacy ${type} ok stays readable but cannot satisfy accept`, (t) => {
    const h = setup(t);
    for (const gate of ['tests', 'clean', 'ci'].filter((g) => g !== type)) gateEvidence(h, gate, 'checker');
    const doc = h.readState('tasks.json');
    doc.tasks[0].evidence.push({ type, ok: true, sha: doc.tasks[0].sha, agent: 'worker', revision: 1 });
    h.writeState('tasks.json', doc);
    assert.equal(h.json(['task', 'show', 'T1']).evidence.at(-1).type, type);
    const r = h.run(['accept', 'T1']);
    assert.equal(r.code, 1, r.stdout);
    assert.ok(r.stderr.includes(`${type}: no ${type} evidence`));
  });
}

test('real gate commands record their source and executed commands, including merge', (t) => {
  const h = setup(t);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'checker');
  h.ok(['accept', 'T1', '--agent', 'reviewer']);
  h.ok(['merge', 'T1', '--agent', 'reviewer']);
  const evidence = h.readState('tasks.json').tasks[0].evidence;
  for (const type of ['tests', 'clean', 'ci', 'merge']) {
    const e = evidence.find((x) => x.type === type);
    assert.equal(e.source, type === 'merge' ? 'merge' : `check ${type}`);
    assert.ok(e.commands.length > 0, `${type} recorded no commands`);
  }
  const tests = evidence.find((e) => e.type === 'tests').commands.filter((c) => c.command === 'node test/value.test.js');
  assert.deepEqual(tests.map((c) => c.status), [0, 1]);
  assert.ok(tests.every((c) => c.cwd.startsWith(h.env.GISHRA_TMP)));
  const clean = evidence.find((e) => e.type === 'clean').commands;
  assert.ok(clean.some((c) => c.command.includes('scanner.js') && c.command.includes('--base=') && c.command.endsWith('--json')));
  const ci = evidence.find((e) => e.type === 'ci').commands;
  assert.ok(ci.some((c) => c.command === 'gh' && c.args[1].includes('/check-runs')));
  const merge = evidence.find((e) => e.type === 'merge').commands;
  assert.ok(merge.some((c) => c.command === 'gh' && c.args.includes('--match-head-commit') && c.args.includes(h.env.FIXTURE_SHA)));
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const e of evidence.filter((e) => e.source)) {
    const event = events.find((event) => event.cmd === e.source);
    assert.equal(event.detail.source, e.source);
    assert.deepEqual(event.detail.commands, e.commands);
  }
});

test('unmarked or mismatched software evidence does not override a gate failure or pass', (t) => {
  const h = setup(t);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'checker');
  gateEvidence(h, 'tests', 'checker', false);
  let doc = h.readState('tasks.json');
  const failed = doc.tasks[0].evidence.at(-1);
  doc.tasks[0].evidence.push({ ...failed, ok: true, source: 'evidence' });
  doc.tasks[0].evidence.push({ ...failed, ok: true, source: 'check ci' });
  h.writeState('tasks.json', doc);
  assert.match(h.run(['accept', 'T1']).stderr, /latest tests .* failed/);
  gateEvidence(h, 'tests', 'checker');
  doc = h.readState('tasks.json');
  doc.tasks[0].evidence.push({ ...failed, source: undefined });
  h.writeState('tasks.json', doc);
  h.ok(['accept', 'T1']);
});
