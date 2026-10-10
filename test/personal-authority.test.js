'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, makeRepo } = require('./helpers');
const L = require('../lib/ladder');

const asOrchestrator = { env: { TOWER_CRANE_AGENT: 'orchestrator' } };
const decisions = h => h.readState('decisions.json').decisions;
const audits = h => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.cmd === 'setting');
const config = h => fs.existsSync(h.userConfig) ? fs.readFileSync(h.userConfig, 'utf8') : null;

function setup(t) {
  return cachedFixture(t, 'personal-authority', h => {
    h.init(['--budget-hours', '10', '--budget-tokens', '100']);
    h.env.TOWER_CRANE_STATE = h.state;
    h.ok(['ladder', 'set', 'easy', '--harness', 'codex', '--model', 'primary', '--clear', 'profile']);
  });
}

function secondProject(t, first) {
  const h = makeRepo(t);
  h.init();
  h.env.TOWER_CRANE_STATE = h.state;
  h.ok(['ladder', 'set', 'easy', '--harness', 'codex', '--model', 'second-primary', '--clear', 'profile']);
  h.env.TOWER_CRANE_CONFIG = first.userConfig;
  return h;
}

const fallback = h => L.routes(h.json(['ladder', 'show']).ladder.easy)[1];

for (const grant of ['tools', 'harness']) {
  test(`a project-local ${grant} grant cannot authorize a new personal fallback`, t => {
    const a = setup(t);
    const b = secondProject(t, a);
    if (grant === 'tools') a.ok(['ladder', 'set', 'easy', '--tools', '["computer_use"]']);
    else a.ok(['ladder', 'set', 'easy', '--harness', 'agy']);
    const route = grant === 'tools'
      ? { harness: 'codex', model: 'backup', tools: ['computer_use'] }
      : { harness: 'agy', model: 'backup' };
    const args = ['ladder', 'set', 'easy', '--fallbacks', JSON.stringify([route])];
    const before = config(a);
    const count = audits(a).length;
    const asked = a.run(args, asOrchestrator);
    assert.equal(asked.code, 1, asked.stderr);
    assert.match(asked.stderr, /opened D1/);
    assert.deepEqual(decisions(a)[0].escalation.settings, ['ladder.reach']);
    assert.equal(config(a), before);
    assert.equal(audits(a).length, count);
    assert.equal(fallback(b), undefined, 'the other project gains no fallback before approval');
    a.ok(['answer', 'D1', '--choice', 'approve']);
    a.ok(args, asOrchestrator);
    assert.deepEqual(fallback(b), route);
    assert.equal(b.json(['ladder', 'show']).ladder.easy.harness, 'codex');
    a.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify([{ ...route, model: 'tuned' }])], asOrchestrator);
    assert.equal(decisions(a).length, 1, 'existing personal grants permit operational model tuning');
    assert.ok(Object.values(audits(a).at(-1).detail.settings).every(value => value === 'operational'));
  });
}

test('an inherited personal route does not authorize forcing its harness in other projects', t => {
  const a = setup(t);
  const b = secondProject(t, a);
  a.ok(['ladder', 'set', 'easy', '--harness', 'agy']);
  a.ok(['ladder', 'set', 'easy', '--fallbacks', '[{"model":"backup"}]']);
  assert.equal(fallback(b).harness, 'codex');
  const before = config(a);
  const args = ['ladder', 'set', 'easy', '--fallbacks', '[{"harness":"agy","model":"backup"}]'];
  assert.match(a.run(args, asOrchestrator).stderr, /opened D1/);
  assert.equal(config(a), before);
  assert.equal(fallback(b).harness, 'codex');
});

test('inherited personal tools are checked beyond the invoking project harness', t => {
  const a = setup(t);
  const b = secondProject(t, a);
  a.ok(['ladder', 'set', 'easy', '--harness', 'claude', '--tools', '["Read"]']);
  const args = ['ladder', 'set', 'easy', '--fallbacks', '[{"model":"backup","tools":["Read"]}]'];
  assert.match(a.run(args, asOrchestrator).stderr, /opened D1/);
  assert.deepEqual(decisions(a)[0].escalation.settings, ['ladder.reach']);
  assert.equal(fallback(b), undefined);
});

for (const field of ['hours', 'tokens']) {
  test(`the CLI clears the ${field} budget through owner approval or a direct owner write`, t => {
    const h = setup(t);
    const flag = `--budget-${field}`;
    const args = ['project', 'set', flag, 'null'];
    const before = h.readState('project.json').budget[field];
    const asked = h.run(args, asOrchestrator);
    assert.equal(asked.code, 1, asked.stderr);
    assert.match(asked.stderr, /opened D1/);
    assert.deepEqual(decisions(h)[0].escalation, { settings: ['budget.raise'], change: { [flag.slice(2)]: null } });
    assert.equal(h.readState('project.json').budget[field], before);
    assert.equal(h.run(args, { env: { TOWER_CRANE_AGENT: 'worker' } }).code, 1);
    h.ok(['answer', 'D1', '--choice', 'approve']);
    h.ok(args, asOrchestrator);
    assert.equal(h.readState('project.json').budget[field], null);
    assert.equal(audits(h).at(-1).detail.approved_by, 'D1');
    h.ok(['project', 'set', flag, '5'], asOrchestrator);
    assert.equal(decisions(h).length, 1, 'lowering an unlimited budget stays operational');
    h.ok(args);
    assert.equal(h.readState('project.json').budget[field], null);
    assert.equal(audits(h).at(-1).detail.actor, 'owner');
  });
}

test('nullable budget flags preserve numeric validation and work at init', t => {
  const h = makeRepo(t);
  h.init(['--budget-hours', 'null', '--budget-tokens', 'null']);
  assert.deepEqual(h.readState('project.json').budget, { hours: null, tokens: null });
  h.ok(['project', 'set', '--budget-hours', '1.5', '--budget-tokens', '0']);
  const before = h.readState('project.json');
  for (const [flag, value] of [
    ['--budget-hours', 'NaN'], ['--budget-hours', '-1'],
    ['--budget-tokens', '1.5'], ['--budget-tokens', '-1'],
    ['--workers', 'null'], ['--lease-minutes', 'null'],
  ]) {
    assert.equal(h.run(['project', 'set', flag, value]).code, 2, `${flag} ${value}`);
    assert.deepEqual(h.readState('project.json'), before);
  }
});
