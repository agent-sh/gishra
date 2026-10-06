'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

function events(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('the claimant resubmits a newer head and its gates need evidence at that head', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const oldSha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', oldSha, '--branch', 'feature/change', '--pr', '7', '--agent', 'w-1']);
  assert.deepEqual(
    events(h).find((event) => event.cmd === 'submit').detail,
    { previous_sha: null, sha: oldSha, branch: 'feature/change', pr: 7, summary: null },
  );
  const gates = [['tests', 'w-1'], ['clean', 'w-1'], ['review', 'r-1'], ['ci', 'ci']];
  for (const [type, agent] of gates) h.ok(['evidence', 'T1', '--type', type, '--ok', '--agent', agent]);
  const before = h.json(['task', 'show', 'T1']);
  assert.equal(before.gates.ok, true);

  fs.appendFileSync(path.join(h.repo, 'README.md'), 'The newer change.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-q', '-m', 'newer change']);
  const newSha = h.git(['rev-parse', 'HEAD']);
  const submitted = h.json(['submit', 'T1', '--sha', newSha.toUpperCase(), '--summary', 'fixed review feedback', '--agent', 'w-1']);
  assert.deepEqual(
    [submitted.status, submitted.sha, submitted.branch, submitted.pr, submitted.submitted_by, submitted.claim, submitted.revision],
    ['submitted', newSha, 'feature/change', 7, 'w-1', null, before.revision],
  );
  assert.deepEqual(submitted.evidence, before.evidence);
  assert.equal(submitted.notes.at(-1).text, 'submitted: fixed review feedback');
  const resubmit = events(h).filter((event) => event.cmd === 'submit').at(-1);
  assert.deepEqual(
    [resubmit.task, resubmit.agent, resubmit.detail.previous_sha, resubmit.detail.sha],
    ['T1', 'w-1', oldSha, newSha],
  );

  const shown = h.json(['task', 'show', 'T1']);
  assert.equal(shown.gates.ok, false);
  assert.deepEqual(shown.gates.gates.map((gate) => [gate.type, gate.ok]), gates.map(([type]) => [type, false]));
  const stale = h.run(['accept', 'T1']);
  assert.equal(stale.code, 1);
  for (const [type] of gates) assert.match(stale.stderr, new RegExp(`no ${type} evidence at ${newSha.slice(0, 7)}`));
  assert.equal(h.json(['task', 'show', 'T1']).status, 'submitted');

  for (const [type, agent] of [['tests', 'w-1'], ['clean', 'w-1'], ['review', 'w-1'], ['ci', 'ci']]) {
    h.ok(['evidence', 'T1', '--type', type, '--ok', '--agent', agent]);
  }
  const selfReview = h.run(['accept', 'T1']);
  assert.equal(selfReview.code, 1);
  assert.match(selfReview.stderr, /only the submitter \(w-1\) reviewed/);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--agent', 'r-1']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  h.ok(['accept', 'T1']);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'accepted');
});

test('resubmission belongs to the current submitter and stops after acceptance or rework', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--branch', 'feature/old', '--pr', '7', '--agent', 'w-1']);
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);
  for (const agent of ['w-2', 'owner']) {
    const denied = h.run(['submit', 'T1', '--sha', 'abcdef2', '--agent', agent]);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /only the claimant \(w-1\)/);
  }
  assert.equal(h.run(['submit', 'T1', '--sha', 'not-a-sha', '--agent', 'w-1']).code, 2);
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);

  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--agent', 'r-1']);
  const again = h.json(['submit', 'T1', '--sha', 'ABCDEF1', '--branch', 'feature/new', '--pr', '8', '--agent', 'w-1']);
  assert.deepEqual([again.sha, again.branch, again.pr], ['abcdef1', 'feature/new', 8]);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((gate) => gate.type === 'review').ok, true);
  h.ok(['evidence', 'T1', '--type', 'ci', '--ok', '--agent', 'ci']);
  h.ok(['accept', 'T1']);
  const accepted = h.json(['task', 'show', 'T1']);
  const acceptedEvents = events(h);
  assert.equal(h.run(['submit', 'T1', '--sha', 'abcdef2', '--agent', 'w-1']).code, 1);
  assert.deepEqual(h.json(['task', 'show', 'T1']), accepted);
  assert.deepEqual(events(h), acceptedEvents);

  h.ok(['rework', 'T1', '--reason', 'another change', '--agent', 'r-1']);
  assert.equal(h.run(['submit', 'T1', '--sha', 'abcdef2', '--agent', 'w-1']).code, 1);
  h.ok(['claim', 'T1', '--agent', 'w-2']);
  assert.equal(h.run(['submit', 'T1', '--sha', 'abcdef2', '--agent', 'w-1']).code, 1);
  h.ok(['submit', 'T1', '--sha', 'abcdef2', '--agent', 'w-2']);
  assert.equal(h.run(['submit', 'T1', '--sha', 'abcdef3', '--agent', 'w-1']).code, 1);
  assert.equal(h.json(['submit', 'T1', '--sha', 'abcdef3', '--agent', 'w-2']).submitted_by, 'w-2');
});
