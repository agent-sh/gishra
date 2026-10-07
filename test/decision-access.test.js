'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

function events(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('only the owner or a named agent can answer, and the answer event records its rule', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Named answerer task', '--acceptance', 'the named answerer can unblock it']);
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--agent', 'worker-ask']);

  const before = events(h);
  const denied = h.run(['answer', 'D1', '--choice', 'redis', '--agent', 'worker-other']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /owner/);
  assert.equal(h.readState('decisions.json').decisions[0].status, 'open');
  assert.deepEqual(events(h), before, 'a refused answer writes no event');

  const delegateDenied = h.run([
    'decision', 'delegate', 'D1', '--answerers', '["worker-allowed"]', '--agent', 'worker-allowed',
  ]);
  assert.equal(delegateDenied.code, 1, delegateDenied.stderr);
  assert.match(delegateDenied.stderr, /only the owner/);
  assert.deepEqual(events(h), before, 'a worker cannot name itself');

  h.ok(['decision', 'delegate', 'D1', '--answerers', '["worker-allowed"]', '--agent', 'owner']);
  for (const startedAs of ['worker-other', 'orchestrator']) {
    const beforeSpoof = events(h);
    const spoofed = h.run(
      ['answer', 'D1', '--choice', 'redis', '--agent', 'worker-allowed'],
      { env: { TOWER_CRANE_AGENT: startedAs, TOWER_CRANE_TASK: 'T1' } },
    );
    assert.equal(spoofed.code, 1, `${startedAs}: ${spoofed.stderr}`);
    assert.match(spoofed.stderr, /worker-allowed/);
    assert.deepEqual(events(h), beforeSpoof, `${startedAs} cannot impersonate the named answerer`);
  }
  const stillDenied = h.run(['answer', 'D1', '--choice', 'redis', '--agent', 'worker-other']);
  assert.equal(stillDenied.code, 1, stillDenied.stderr);
  assert.match(stillDenied.stderr, /worker-allowed/);
  assert.match(stillDenied.stderr, /owner/);

  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'worker-allowed'], {
    env: { TOWER_CRANE_AGENT: 'worker-allowed', TOWER_CRANE_TASK: 'T1' },
  });
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.status, decision.answer, decision.answered_by, decision.answer_rule], [
    'answered', 'redis', 'worker-allowed', 'owner-named-agent',
  ]);
  const answerEvent = events(h).findLast((event) => event.cmd === 'answer');
  assert.equal(answerEvent.agent, 'worker-allowed');
  assert.deepEqual(
    [answerEvent.detail.answered_by, answerEvent.detail.answer_rule],
    ['worker-allowed', 'owner-named-agent'],
  );
});

test('the orchestrator answers only owner-marked technical decisions when project policy allows it', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);

  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  const unmarked = h.run(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  assert.equal(unmarked.code, 1, unmarked.stderr);
  assert.match(unmarked.stderr, /owner/);

  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);
  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.technical, decision.answered_by, decision.answer_rule], [
    true, 'orchestrator', 'owner-technical-delegation',
  ]);
  const answerEvent = events(h).findLast((event) => event.cmd === 'answer');
  assert.deepEqual(
    [answerEvent.agent, answerEvent.detail.answer_rule],
    ['orchestrator', 'owner-technical-delegation'],
  );
});

test('a worker cannot answer under a forged orchestrator identity', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Answer a technical decision', '--acceptance', 'answer is authorized']);
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);
  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);

  const before = events(h);
  const forged = h.run(
    ['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator'],
    { env: { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' } },
  );
  assert.equal(forged.code, 1, forged.stderr);
  assert.match(forged.stderr, /only the owner.*can answer D1/);
  assert.equal(h.readState('decisions.json').decisions[0].status, 'open');
  assert.deepEqual(events(h), before, 'a worker cannot use a selected identity to authorize an answer');
});

test('the owner can always answer explicitly, and technical classification alone does not delegate', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);
  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);

  const denied = h.run(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /owner/);

  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'owner']);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.answered_by, decision.answer_rule], ['owner', 'owner']);
});

test('technical delegation recognizes generated orchestrators by their recorded spawn role', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Answer a technical decision', '--acceptance', 'answer is authorized']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
  const spawned = {};
  for (const rung of ['easy', 'orchestrator']) {
    h.ok(['ladder', 'set', rung, '--harness', 'command',
      '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)']),
      ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((field) => ['--clear', field])]);
    spawned[rung] = h.json(['spawn', '--task', 'T1', '--role', rung, '--wait']).agent;
  }
  assert.match(spawned.orchestrator, /^orchestrator-T1-\d+$/);
  assert.equal(events(h).findLast((event) => event.cmd === 'spawn'
    && event.detail.agent === spawned.orchestrator).detail.role, 'orchestrator');
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);
  h.ok(['decision', 'delegate', 'D1', '--answerers', JSON.stringify([spawned.orchestrator]), '--agent', 'owner']);
  const beforeNamed = events(h);
  const namedOnly = h.run(['answer', 'D1', '--choice', 'redis', '--agent', spawned.orchestrator]);
  assert.equal(namedOnly.code, 1, namedOnly.stderr);
  assert.match(namedOnly.stderr, /only the owner with explicit identity can answer D1/);
  assert.deepEqual(events(h), beforeNamed, 'naming an orchestrator alone cannot authorize an answer');
  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);

  const noPolicy = h.run(['answer', 'D1', '--choice', 'redis', '--agent', spawned.orchestrator]);
  assert.equal(noPolicy.code, 1, noPolicy.stderr);
  assert.match(noPolicy.stderr, /only the owner with explicit identity can answer D1/);
  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  h.ok(['decision', 'delegate', 'D1', '--technical', 'false', '--agent', 'owner']);
  const unmarked = h.run(['answer', 'D1', '--choice', 'redis', '--agent', spawned.orchestrator]);
  assert.equal(unmarked.code, 1, unmarked.stderr);
  assert.match(unmarked.stderr, /only the owner with explicit identity can answer D1/);

  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);
  const before = events(h);
  for (const agent of [spawned.easy, 'orchestrator-T1-999']) {
    const denied = h.run(['answer', 'D1', '--choice', 'redis', '--agent', agent]);
    assert.equal(denied.code, 1, denied.stderr);
    assert.match(denied.stderr, /owner/);
    assert.match(denied.stderr, /orchestrator under technical delegation/);
  }
  assert.deepEqual(events(h), before, 'refused answers write no events');

  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', spawned.orchestrator]);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.answered_by, decision.answer_rule], [
    spawned.orchestrator, 'owner-technical-delegation',
  ]);
  const answerEvent = events(h).findLast((event) => event.cmd === 'answer');
  assert.deepEqual(
    [answerEvent.agent, answerEvent.detail.answered_by, answerEvent.detail.answer_rule],
    [spawned.orchestrator, spawned.orchestrator, 'owner-technical-delegation'],
  );
});
