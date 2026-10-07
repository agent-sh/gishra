'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const as = (agent) => ({ env: { TOWER_CRANE_AGENT: agent } });

// A spawn record as spawn writes it, so an agent name has a recorded role.
function recordSpawn(h, agent, role) {
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(), agent: 'owner', cmd: 'spawn', task: 'T1', detail: { agent, role, rung: role === 'orchestrator' ? 'orchestrator' : 'hard', pid: 1 },
  })}\n`);
}

function setup(t) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Owner action', '--acceptance', 'done', '--needs-owner', 'approve access']);
  return h;
}

const OPERATIONAL = [
  ['project', 'set', '--tests-cmd', 'npm test', '--clean-cmd', 'node clean.js', '--tests-proof-cmd', 'node {tests}'],
  ['project', 'set', '--ci-required', '["test ("]', '--ci-ignore-apps', '["claude"]', '--ci-capped-review', '[{"app":"cursor","pattern":"usage limit"}]'],
  ['project', 'set', '--ci-local', '{"command":["node","ci.js"],"timeout":60}'],
  ['project', 'set', '--tests-mode', 'run-only', '--tests-paths', '["test/**"]', '--tests-keep', '[]', '--tests-by-kind', '{}', '--tests-expensive', 'false'],
  ['project', 'set', '--workers', '3', '--lease-minutes', '45', '--budget-hours', '10'],
  ['project', 'set', '--review-policy', '{"small_lines":50}'],
  ['ladder', 'set', 'easy', '--harness', 'codex', '--model', 'sonnet', '--effort', 'high', '--args', '[]', '--tools', '["web_search"]', '--mcp', '["docs"]'],
  ['task', 'update', 'T1', '--kind', 'docs', '--tier', 'medium'],
  ['task', 'update', 'T1', '--needs-owner', 'approve other access'],
  ['owner-done', 'T1'],
];

test('the orchestrator changes operational settings under its own identity; a worker is sent to the orchestrator', (t) => {
  const h = setup(t);
  for (const args of OPERATIONAL) {
    const before = { project: h.readState('project.json'), tasks: h.readState('tasks.json') };
    for (const worker of [as('worker-T1-1'), { env: { TOWER_CRANE_AGENT: 'worker-T1-1' }, extra: ['--agent', 'orchestrator'] }]) {
      const r = h.run([...args, ...(worker.extra || [])], { env: worker.env });
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /only the orchestrator or the owner/);
      assert.match(r.stderr, /msg --to orchestrator/);
      assert.deepEqual({ project: h.readState('project.json'), tasks: h.readState('tasks.json') }, before);
    }
    const r = h.run(args, as('orchestrator'));
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(events(h).at(-1).agent, 'orchestrator');
  }
  const p = h.readState('project.json');
  assert.equal(p.gates.tests_cmd, 'npm test');
  assert.deepEqual(p.ci.capped_review, [{ app: 'cursor', pattern: 'usage limit' }]);
  assert.equal(p.limits.workers, 3);
  assert.equal(p.ladder.easy.model, 'sonnet');
  assert.equal(events(h).findLast((e) => e.cmd === 'project set').detail.authority, 'orchestrator');
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
  assert.equal(h.readState('decisions.json').decisions.length, 0);
});

test('only a real orchestrator identity acts as orchestrator', (t) => {
  const h = setup(t);
  const args = ['project', 'set', '--workers', '2'];
  // A spawned orchestrator acts as orchestrator under its spawned name.
  recordSpawn(h, 'orchestrator-T1-1', 'orchestrator');
  assert.equal(h.run(args, as('orchestrator-T1-1')).code, 0);
  // A name some spawn started as a worker never does, even if it is called orchestrator.
  recordSpawn(h, 'orchestrator', 'worker');
  const r = h.run(args, as('orchestrator'));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /msg --to orchestrator/);
  // Brokered commands are a sandboxed agent's.
  const brokered = h.run(args, { env: { TOWER_CRANE_AGENT: 'orchestrator-T1-1', TOWER_CRANE_VIA: 'broker' } });
  assert.equal(brokered.code, 1, brokered.stderr);
});

test('owner-required changes by the orchestrator open one decision and change nothing; the owner makes them', (t) => {
  const h = setup(t);
  const cases = [
    [['project', 'set', '--merge-admin', 'true'], ['merge.admin']],
    [['project', 'set', '--sandbox', '{"write":["/tmp/x"]}'], ['sandbox']],
    [['project', 'set', '--env', '{"A":"1"}'], ['env']],
    [['project', 'set', '--budget-hours', '5'], null],
    [['ladder', 'set', 'easy', '--scope', '{}'], ['scope']],
    [['ladder', 'set', 'easy', '--command', '["node"]'], ['ladder.command']],
    [['project', 'set', '--budget-hours', '9'], ['budget.raise']],
    [['ladder', 'save-user'], ['ladder.save_user']],
    [['accept', 'T1', '--waive', 'tests', '--reason', 'flaky'], ['waive.tests']],
  ];
  let opened = 0;
  for (const [args, escalation] of cases) {
    const before = { project: h.readState('project.json'), tasks: h.readState('tasks.json') };
    const r = h.run(args, as('orchestrator'));
    if (!escalation) {
      // Lowering the budget is operational.
      assert.equal(r.code, 0, r.stderr);
      continue;
    }
    opened += 1;
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`owner-required; opened D${opened} for the owner`));
    assert.deepEqual({ project: h.readState('project.json'), tasks: h.readState('tasks.json') }, before);
    const d = h.readState('decisions.json').decisions.at(-1);
    assert.equal(d.id, `D${opened}`);
    assert.equal(d.asked_by, 'orchestrator');
    assert.deepEqual(d.escalation.settings, escalation);
    const e = events(h).at(-1);
    assert.equal(e.cmd, 'ask');
    assert.deepEqual(e.detail.escalation.settings, escalation);
    // Asking again waits on the same decision.
    const again = h.run(args, as('orchestrator'));
    assert.match(again.stderr, new RegExp(`opened D${opened} `));
    assert.equal(h.readState('decisions.json').decisions.length, opened);
    // A worker is refused without a decision.
    const worker = h.run(args, as('worker-T1-1'));
    assert.equal(worker.code, 1);
    assert.match(worker.stderr, /only the owner/);
    assert.equal(h.readState('decisions.json').decisions.length, opened);
  }
  // Only the owner answers an escalation.
  const answer = h.run(['answer', 'D1', '--choice', 'approved'], as('orchestrator'));
  assert.equal(answer.code, 1, answer.stderr);
  assert.match(answer.stderr, /only the owner answers it/);
  h.ok(['project', 'set', '--merge-admin', 'true', '--budget-hours', '9']);
  h.ok(['answer', 'D1', '--choice', 'done']);
  h.ok(['ladder', 'set', 'easy', '--scope', '{}']);
  assert.equal(h.readState('project.json').merge.admin, true);
  assert.equal(h.readState('project.json').budget.hours, 9);
});

test('an unpinned project does not block: the orchestrator pins detected gate commands and the owner sees it', (t) => {
  const h = makeRepo(t);
  h.init();
  gateFixture(h);
  h.ok(['project', 'set', '--tests-cmd', 'null', '--clean-cmd', 'null']);
  fs.writeFileSync(path.join(h.repo, 'package.json'), `${JSON.stringify({ name: 'fixture', scripts: { test: 'node test/value.test.js' } })}\n`);
  h.git(['add', 'package.json']);
  h.git(['commit', '-qm', 'test script']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);

  // A worker pins nothing; the gate still names the missing pin.
  const worker = h.run(['check', 'tests', 'T1'], as('worker'));
  assert.equal(worker.code, 1, worker.stderr);
  assert.match(worker.stdout, /no test command pinned/);
  assert.equal(h.readState('project.json').gates, undefined);

  for (const type of ['tests', 'clean']) {
    const r = h.run(['check', type, 'T1'], as('orchestrator'));
    assert.equal(r.code, 0, r.stderr + r.stdout);
  }
  assert.deepEqual(h.readState('project.json').gates, { tests_cmd: 'npm test', clean_cmd: h.env.TOWER_CRANE_CLEAN_CMD });
  const pins = events(h).filter((e) => e.cmd === 'gates pin');
  assert.deepEqual(pins.map((e) => [e.agent, e.detail.key, e.detail.from, e.detail.authority]), [
    ['orchestrator', 'tests_cmd', 'package.json scripts.test', 'orchestrator'],
    ['orchestrator', 'clean_cmd', 'TOWER_CRANE_CLEAN_CMD', 'orchestrator'],
  ]);
  const status = h.ok(['status']);
  assert.match(status, /pinned gate commands: tests_cmd "npm test" by orchestrator from package\.json scripts\.test/);
});
