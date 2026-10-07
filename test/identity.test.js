'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, runPty, PTY_AVAILABLE } = require('./helpers');

const noAgent = { TOWER_CRANE_AGENT: undefined };
const message = 'tower-crane: no agent: pass --agent NAME or set TOWER_CRANE_AGENT\n';
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
const withoutTowerCrane = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('TOWER_CRANE_')));
const terminal = (h, args, env = {}) => runPty([...args, '--state', h.state], { cwd: h.repo, env: { ...withoutTowerCrane(h.env), ...env } });

function assertOwnerRequest(output) {
  assert.match(output, /tower-crane ask.*task note/);
  assert.doesNotMatch(output, /--agent owner|TOWER_CRANE_AGENT=owner/);
}

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
  const r = h.run(['owner-done', 'T1'], { env: { ...noAgent, TOWER_CRANE_TASK: 'T1' } });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stderr, message);
  assert.equal(events(h), before);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
});

test('empty agent identity names both ways to supply it', (t) => {
  const h = setup(t);
  const before = events(h);
  for (const agent of ['', '   ']) {
    const r = h.run(['owner-done', 'T1'], { env: { TOWER_CRANE_AGENT: agent } });
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.stderr, message);
    assert.equal(events(h), before);
  }
});

test('terminal fallback records owner only outside a task', { skip: !PTY_AVAILABLE }, (t) => {
  const h = setup(t);
  const r = terminal(h, ['task', 'note', 'T1', 'person at a terminal']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(h.readState('tasks.json').tasks[0].notes[0].agent, 'owner');
  const before = events(h);
  for (const task of ['T1', '']) {
    const blocked = terminal(h, ['task', 'note', 'T1', 'lost identity'], { TOWER_CRANE_TASK: task });
    assert.equal(blocked.code, 2, blocked.stdout + blocked.stderr);
    assert.ok(blocked.stdout.includes(message.trim()));
    assert.equal(events(h), before);
  }
});

test('terminal fallback cannot clear owner work without explicit owner identity', { skip: !PTY_AVAILABLE }, (t) => {
  for (const identity of ['flag', 'env']) {
    const h = setup(t);
    const before = events(h);
    const blocked = terminal(h, ['owner-done', 'T1']);
    assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /only the owner/);
    assertOwnerRequest(blocked.stdout);
    assert.equal(events(h), before);
    assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
    const done = terminal(h, ['owner-done', 'T1', ...(identity === 'flag' ? ['--agent', 'owner'] : [])],
      identity === 'env' ? { TOWER_CRANE_AGENT: 'owner' } : {});
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
  }
});

test('agents cannot clear or replace an existing owner request through task update', (t) => {
  const h = setup(t);
  const before = events(h);
  const tasksBefore = h.readState('tasks.json');
  for (const agent of ['reviewer', 'Owner']) {
    for (const reason of ['', '   ', 'approve funding']) {
      const blocked = h.run(['task', 'update', 'T1', '--title', 'Changed', '--needs-owner', reason, '--agent', agent]);
      assert.equal(blocked.code, 1, blocked.stderr);
      assert.match(blocked.stderr, /only the owner/);
      assertOwnerRequest(blocked.stderr);
      assert.equal(events(h), before);
      assert.deepEqual(h.readState('tasks.json'), tasksBefore);
    }
  }
  h.ok(['task', 'update', 'T1', '--title', 'Renamed', '--needs-owner', ' approve access ', '--agent', 'reviewer']);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'approve access');
  h.ok(['task', 'add', '--title', 'New request', '--acceptance', 'approved', '--agent', 'reviewer']);
  h.ok(['task', 'update', 'T2', '--needs-owner', 'approve funding', '--agent', 'reviewer']);
  assert.equal(h.readState('tasks.json').tasks[1].needs_owner, 'approve funding');
});

test('terminal task update needs explicit owner to clear or replace owner work', { skip: !PTY_AVAILABLE }, (t) => {
  for (const identity of ['flag', 'env']) {
    const h = setup(t);
    const before = events(h);
    const tasksBefore = h.readState('tasks.json');
    for (const reason of ['', '   ', 'approve funding']) {
      const blocked = terminal(h, ['task', 'update', 'T1', '--title', 'Changed', '--needs-owner', reason]);
      assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
      assert.match(blocked.stdout, /only the owner/);
      assertOwnerRequest(blocked.stdout);
      assert.equal(events(h), before);
      assert.deepEqual(h.readState('tasks.json'), tasksBefore);
    }
    h.ok(['task', 'add', '--title', 'New request', '--acceptance', 'approved']);
    const requested = terminal(h, ['task', 'update', 'T2', '--needs-owner', 'approve funding']);
    assert.equal(requested.code, 0, requested.stdout + requested.stderr);
    assert.equal(h.readState('tasks.json').tasks[1].needs_owner, 'approve funding');
    for (const reason of ['approve funding', '']) {
      const updated = terminal(h, ['task', 'update', 'T1', '--needs-owner', reason,
        ...(identity === 'flag' ? ['--agent', 'owner'] : [])], identity === 'env' ? { TOWER_CRANE_AGENT: 'owner' } : {});
      assert.equal(updated.code, 0, updated.stdout + updated.stderr);
      assert.equal(h.readState('tasks.json').tasks[0].needs_owner, reason || null);
      assert.equal(JSON.parse(events(h).trim().split('\n').at(-1)).agent, 'owner');
    }
  }
});

test('terminal fallback cannot waive gates without explicit owner identity', { skip: !PTY_AVAILABLE }, (t) => {
  for (const identity of ['flag', 'env']) {
    const h = setup(t);
    h.ok(['owner-done', 'T1']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', 'abcdef1', '--pr', '1', '--agent', 'worker']);
    const waive = ['accept', 'T1', '--waive', 'tests', '--waive', 'clean', '--waive', 'review', '--waive', 'ci', '--reason', 'approved'];
    const before = events(h);
    const blocked = terminal(h, waive);
    assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /only the owner can waive/);
    assertOwnerRequest(blocked.stdout);
    assert.equal(events(h), before);
    assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    const accepted = terminal(h, [...waive, ...(identity === 'flag' ? ['--agent', 'owner'] : [])],
      identity === 'env' ? { TOWER_CRANE_AGENT: 'owner' } : {});
    assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    const task = h.readState('tasks.json').tasks[0];
    assert.equal(task.status, 'accepted');
    assert.ok(task.evidence.every((e) => e.waived && e.agent === 'owner'));
  }
});

test('terminal fallback cannot release another agent claim without explicit owner identity', { skip: !PTY_AVAILABLE }, (t) => {
  for (const identity of ['flag', 'env']) {
    const h = setup(t);
    h.ok(['owner-done', 'T1']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    const release = ['release', 'T1', '--reason', 'handoff'];
    const before = events(h);
    const blocked = terminal(h, release);
    assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /only the claimant/);
    assertOwnerRequest(blocked.stdout);
    assert.equal(events(h), before);
    assert.equal(h.readState('tasks.json').tasks[0].claim.agent, 'worker');
    const released = terminal(h, [...release, ...(identity === 'flag' ? ['--agent', 'owner'] : [])],
      identity === 'env' ? { TOWER_CRANE_AGENT: 'owner' } : {});
    assert.equal(released.code, 0, released.stdout + released.stderr);
    assert.equal(h.readState('tasks.json').tasks[0].claim, null);
    assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
  }
});

test('terminal fallback cannot set tests policy on init or project set', { skip: !PTY_AVAILABLE }, (t) => {
  for (const [flag, value] of [
    ['--tests-mode', 'none'], ['--tests-by-kind', '{"code":"run-only"}'], ['--tests-expensive', 'true'],
    ['--tests-paths', '["src/**"]'], ['--tests-keep', '["lib/**"]'],
  ]) {
    const h = makeRepo(t);
    const deniedInit = terminal(h, ['init', '--name', 'demo', '--goal', 'owner policy', flag, value]);
    assert.equal(deniedInit.code, 1, deniedInit.stdout + deniedInit.stderr);
    assert.match(deniedInit.stdout, /only the owner/);
    assert.ok(!fs.existsSync(h.state));
    h.init();
    const project = h.readState('project.json');
    const before = events(h);
    const deniedSet = terminal(h, ['project', 'set', flag, value]);
    assert.equal(deniedSet.code, 1, deniedSet.stdout + deniedSet.stderr);
    assert.match(deniedSet.stdout, /only the owner/);
    assert.deepEqual(h.readState('project.json'), project);
    assert.equal(events(h), before);
    assertOwnerRequest(deniedSet.stdout);
  }
});

test('--agent owner recovers missing identity and overrides the environment', (t) => {
  const h = setup(t);
  assert.equal(h.run(['owner-done', 'T1'], { env: noAgent }).code, 2);
  const task = h.json(['owner-done', 'T1', '--agent', 'owner'], { env: { ...noAgent, TOWER_CRANE_TASK: 'T1' } });
  assert.equal(task.needs_owner, null);
  assert.equal(task.notes[0].agent, 'owner');
  h.ok(['task', 'note', 'T1', 'explicit owner', '--agent', 'owner'], { env: { TOWER_CRANE_AGENT: 'reviewer' } });
  assert.equal(h.readState('tasks.json').tasks[0].notes[1].agent, 'owner');
});

test('TOWER_CRANE_AGENT supplies the recorded identity when --agent is absent', (t) => {
  const h = setup(t);
  assert.equal(h.run(['task', 'note', 'T1', 'missing'], { env: noAgent }).code, 2);
  h.ok(['task', 'note', 'T1', 'named reviewer'], { env: { TOWER_CRANE_AGENT: 'reviewer', TOWER_CRANE_TASK: 'T1' } });
  assert.equal(h.readState('tasks.json').tasks[0].notes[0].agent, 'reviewer');
});

test('owner-done and waivers require the resolved name owner exactly', (t) => {
  const h = setup(t);
  for (const agent of ['reviewer', 'Owner']) {
    const r = h.run(['owner-done', 'T1', '--agent', agent]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /only the owner/);
    assertOwnerRequest(r.stderr);
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
    assertOwnerRequest(r.stderr);
    assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  }
  const task = h.json([...waive, '--agent', 'owner'], { env: noAgent });
  assert.equal(task.status, 'accepted');
  assert.ok(task.evidence.every((e) => e.waived && e.agent === 'owner'));
});
