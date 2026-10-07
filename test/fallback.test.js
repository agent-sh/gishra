'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const supervision = { retries: 2, backoff_ms: 10, max_backoff_ms: 20, stall_ms: 60000 };

async function until(fn, message) {
  const deadline = Date.now() + 12000;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function setup(t, { reason = 'outage', primaryHarness = 'codex', nextHarness = 'codex', chain = false } = {}) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Fallback routes', '--tier', 'easy', '--acceptance', 'fresh fallback session']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Complete the original task brief.\n' });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  for (const harness of ['codex', 'claude', 'agy']) fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
  const routes = [{ harness: nextHarness, model: 'second', env: { ROUTE_ENV: 'fallback' } }];
  if (chain) routes.push({ harness: 'claude', model: 'third' });
  h.ok(['ladder', 'set', 'easy', '--harness', primaryHarness, '--model', 'first', '--clear', 'profile', '--clear', 'effort',
    '--env', '{"ROUTE_ENV":"primary"}', '--supervision', JSON.stringify(supervision), '--fallbacks', JSON.stringify(routes)]);
  h.file = path.join(h.base, 'attempts.json');
  h.spawnEnv = {
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
    NODE_OPTIONS: `--require "${path.join(__dirname, 'fixtures', 'fallback-harness.js').replace(/\\/g, '/')}"`,
    TOWER_CRANE_TEST_FALLBACK_FILE: h.file, TOWER_CRANE_TEST_FALLBACK_REASON: reason,
    ...(chain ? { TOWER_CRANE_TEST_FALLBACK_CHAIN: '1' } : {}),
  };
  h.spawn = () => h.run(['spawn', '--task', 'T1', '--wait'], { env: h.spawnEnv, timeout: 20000 });
  h.attempts = () => JSON.parse(fs.readFileSync(h.file, 'utf8'));
  return h;
}

for (const nextHarness of ['codex', 'claude']) {
  test(`outage exhausts same-route retries before a fresh ${nextHarness} fallback and records route spend`, (t) => {
    const h = setup(t, { nextHarness });
    const result = h.spawn();
    assert.equal(result.code, 0, result.stderr);
    const attempts = h.attempts();
    assert.deepEqual(attempts.map((a) => a.model), ['first', 'first', 'first', 'second']);
    assert.deepEqual(attempts.map((a) => a.retry), ['0', '1', '2', '0']);
    assert.ok(attempts[1].args.includes('resume'));
    assert.ok(attempts[2].args.includes('resume'));
    assert.equal(attempts[3].args.includes('resume'), false);
    assert.notEqual(attempts[3].session, attempts[2].session);
    assert.ok(attempts[3].args.some((a) => a.includes('Complete the original task brief.')));
    assert.deepEqual(attempts.map((a) => a.env), ['primary', 'primary', 'primary', 'fallback']);
    for (const attempt of attempts) assert.deepEqual(attempt.claim, attempts[0].claim);
    const switches = events(h).filter((e) => e.cmd === 'spawn fallback');
    assert.equal(switches.length, 1);
    assert.equal(switches[0].detail.route_index, 1);
    assert.equal(switches[0].detail.reason, 'provider outage after 2 retries');
    const wake = h.json(['wait', '--after', '0', '--types', 'spawn-fallback', '--timeout', '1']);
    assert.equal(wake.id, switches[0].id);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.run.phase, 'waiting');
    assert.equal(task.run.model, 'second');
    assert.deepEqual(task.spend.entries.map((e) => [e.model, e.harness, e.tokens]),
      [['first', 'codex', 39], ['second', nextHarness, nextHarness === 'codex' ? 13 : 24]]);
    const tokens = task.spend.tokens;
    h.ok(['spend', 'T1', '--from-spawn', 'worker-T1-1']);
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, tokens);
    h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', 'abcdef1']);
    h.ok(['rework', 'T1', '--reason', 'fix review finding']);
    const preview = h.json(['spawn', '--task', 'T1', '--dry-run'], { env: h.spawnEnv });
    assert.equal(preview.resumed, false, 'the original route must not resume a fallback session');
  });
}

test('policy refusal on a successful exit advances the ordered routes without outage retries', (t) => {
  const h = setup(t, { reason: 'refusal', chain: true });
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.attempts().map((a) => a.model), ['first', 'second', 'third']);
  assert.ok(h.attempts().every((a) => !a.args.includes('resume')));
  assert.equal(events(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  assert.deepEqual(events(h).filter((e) => e.cmd === 'spawn fallback').map((e) => e.detail.reason), ['harness refusal', 'harness refusal']);
});

test('Claude policy refusal starts a fresh Codex route', (t) => {
  const h = setup(t, { reason: 'refusal', primaryHarness: 'claude' });
  assert.equal(h.spawn().code, 0);
  assert.deepEqual(h.attempts().map((a) => a.harness), ['claude', 'codex']);
  assert.equal(h.attempts()[1].args.includes('resume'), false);
  assert.notEqual(h.attempts()[1].session, h.attempts()[0].session);
});

for (const primaryHarness of ['agy', 'claude']) {
  test(`fresh ${primaryHarness} outage retries record each invocation without counting usage twice`, (t) => {
    const h = setup(t, { primaryHarness });
    assert.equal(h.spawn().code, 0);
    const attempts = h.attempts();
    assert.deepEqual(attempts.map((a) => a.model), ['first', 'first', 'first', 'second']);
    assert.deepEqual(attempts.map((a) => a.retry), ['0', '1', '2', '0']);
    assert.equal(new Set(attempts.map((a) => a.session)).size, 4);
    assert.ok(attempts.every((a) => !a.args.includes('resume')));
    const task = h.json(['task', 'show', 'T1']);
    const tokens = primaryHarness === 'agy' ? 12257 : 24;
    assert.deepEqual(task.spend.entries.map((e) => [e.model, e.harness, e.tokens]),
      [['first', primaryHarness, tokens], ['first', primaryHarness, tokens],
        ['first', primaryHarness, tokens], ['second', 'codex', 13]]);
    assert.equal(task.spend.tokens, tokens * 3 + 13);
    if (primaryHarness === 'agy') {
      assert.equal(task.spend.input, 30010);
      assert.equal(task.spend.cached, 6002);
      assert.equal(task.spend.output, 6774);
    }
    const spendEvents = events(h).filter((e) => e.cmd === 'spend').length;
    h.ok(['spend', 'T1', '--from-spawn', 'worker-T1-1']);
    h.ok(['spend', 'T1', '--from-spawn', 'worker-T1-1']);
    assert.deepEqual(h.json(['task', 'show', 'T1']).spend, task.spend);
    assert.equal(events(h).filter((e) => e.cmd === 'spend').length, spendEvents);
  });
}

test('rework during a live fallback refuses a second worker until the previous attempt exits', async (t) => {
  const h = setup(t);
  const cursor = events(h).at(-1).id;
  const waiting = h.runAsync(['wait', '--after', cursor, '--types', 'spawn-fallback', '--timeout', '10']);
  h.json(['spawn', '--task', 'T1'], {
    env: { ...h.spawnEnv, TOWER_CRANE_TEST_FALLBACK_HOLD: '4000' },
  });
  const wake = await waiting;
  assert.equal(wake.code, 0, wake.stderr);
  await until(() => h.attempts().length === 4, 'fallback worker did not start');
  h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', 'abcdef1']);
  h.ok(['rework', 'T1', '--reason', 'fix while worker is finishing']);
  for (const flags of [['--dry-run'], []]) {
    const result = h.run(['spawn', '--task', 'T1', ...flags], { env: h.spawnEnv });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /previous worker worker-T1-1 is still running or its exit is unverified/);
  }
  assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 1);
  assert.equal(h.attempts().length, 4);
  await until(() => events(h).some((e) => e.cmd === 'spawn exit'), 'fallback worker did not exit');
  const preview = h.json(['spawn', '--task', 'T1', '--dry-run'], { env: h.spawnEnv });
  assert.equal(preview.resumed, false);
});

test('Codex profile and provider arguments change without carrying the old session or route flags', (t) => {
  const h = setup(t);
  h.ok(['ladder', 'set', 'easy', '--profile', 'first', '--clear', 'model',
    '--args', '["-c","model_provider=bedrock"]', '--fallbacks',
    '[{"profile":"second","args":["-c","model_provider=openai"]}]']);
  assert.equal(h.spawn().code, 0);
  const attempts = h.attempts();
  assert.equal(attempts[2].args[attempts[2].args.indexOf('-p') + 1], 'first');
  const last = attempts[3];
  assert.equal(last.args[last.args.indexOf('-p') + 1], 'second');
  assert.equal(last.args.includes('resume'), false);
  assert.ok(last.args.includes('model_provider=openai'));
  assert.equal(last.args.includes('model_provider=bedrock'), false);
  assert.equal(last.env, null);
  const entries = h.json(['task', 'show', 'T1']).spend.entries;
  assert.deepEqual(entries.map((e) => [e.model, e.profile, e.tokens]), [[null, 'first', 39], [null, 'second', 13]]);
});

test('each fallback route receives a bounded retry budget of its own', (t) => {
  const h = setup(t, { chain: true });
  assert.equal(h.spawn().code, 0);
  assert.deepEqual(h.attempts().map((a) => a.model), ['first', 'first', 'first', 'second', 'second', 'second', 'third']);
  assert.deepEqual(h.attempts().map((a) => a.retry), ['0', '1', '2', '0', '1', '2', '0']);
  assert.equal(h.attempts()[3].args.includes('resume'), false);
  assert.ok(h.attempts()[4].args.includes('22222222-2222-2222-2222-222222222222'));
});

test('an outage before session creation reruns fresh within the same budget before fallback', (t) => {
  const h = setup(t, { reason: 'no-session' });
  assert.equal(h.spawn().code, 0);
  assert.deepEqual(h.attempts().map((a) => a.model), ['first', 'first', 'first', 'second']);
  assert.ok(h.attempts().every((a) => !a.args.includes('resume')));
  const task = h.json(['task', 'show', 'T1']);
  assert.deepEqual(task.spend.entries.map((e) => e.tokens), [null, null, null, 13]);
  const receipts = events(h).filter((e) => e.cmd === 'spawn session');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].detail.route_index, 1);
});

for (const reason of ['outage', 'refusal']) {
  test(`exhausted ${reason} fallback leaves a blocked claim and records the final route exit`, (t) => {
    const h = setup(t, { reason, chain: true });
    h.ok(['ladder', 'set', 'easy', '--fallbacks', '[{"harness":"codex","model":"second"}]']);
    assert.equal(h.spawn().code, 1);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.run.phase, 'blocked');
    assert.equal(task.run.model, 'second');
    assert.equal(task.claim.agent, 'worker-T1-1');
    assert.match(task.run.reason, reason === 'outage' ? /after 2 retries/ : /harness refusal/);
    const exited = h.json(['status']).exited_claims;
    assert.equal(exited.length, 1);
    assert.equal(exited[0].pid, events(h).findLast((e) => ['spawn fallback', 'spawn retry'].includes(e.cmd)).detail.pid);
    assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
  });
}

for (const reason of ['permanent', 'signal']) {
  test(`${reason} exit without provider outage does not switch routes`, (t) => {
    const h = setup(t, { reason });
    assert.equal(h.spawn().code, reason === 'permanent' ? 2 : 75);
    assert.equal(h.attempts().length, reason === 'permanent' ? 1 : 3);
    assert.equal(events(h).filter((e) => e.cmd === 'spawn fallback').length, 0);
  });
}

test('agent output quoting outage and refusal does not switch routes', (t) => {
  const h = setup(t, { reason: 'quoted' });
  assert.equal(h.spawn().code, 1);
  assert.equal(h.attempts().length, 1);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn fallback').length, 0);
});

test('fallback configuration validates every route and remains owner guarded', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const value of [{}, [null], [{ harness: 'pi', profile: 'sol' }], [{ profile: 'sol', fallbacks: [] }]]) {
    assert.notEqual(h.run(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(value)]).code, 0);
  }
  assert.equal(h.run(['ladder', 'set', 'easy', '--fallbacks', '[{"profile":"sol"}]', '--agent', 'worker']).code, 1);
  h.ok(['ladder', 'set', 'easy', '--fallbacks', '[{"profile":"sol"}]']);
  assert.match(h.ok(['ladder', 'show']), /fallbacks/);
  assert.deepEqual(h.json(['ladder', 'show']).ladder.easy.fallbacks, [{ profile: 'sol' }]);
  h.ok(['ladder', 'save-user']);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.userConfig, 'utf8')).ladder.easy.fallbacks, [{ profile: 'sol' }]);
  h.ok(['ladder', 'set', 'easy', '--clear', 'fallbacks']);
  assert.equal(h.json(['ladder', 'show']).ladder.easy.fallbacks, undefined);
});

test('a detached switch wakes a live waiter, keeps its lease, and collects route usage on exit', async (t) => {
  const h = setup(t);
  const cursor = events(h).at(-1).id;
  const waiting = h.runAsync(['wait', '--after', cursor, '--types', 'spawn-fallback', '--timeout', '10']);
  const spawn = h.json(['spawn', '--task', 'T1'], {
    env: { ...h.spawnEnv, TOWER_CRANE_TEST_FALLBACK_HOLD: '1800' },
  });
  const wake = await waiting;
  assert.equal(wake.code, 0, wake.stderr);
  const switched = JSON.parse(wake.stdout);
  assert.equal(switched.detail.model, 'second');
  assert.equal(switched.detail.monitor_pid, spawn.monitor_pid);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.equal(h.json(['task', 'show', 'T1']).claim.agent, spawn.agent);
  assert.equal(h.run(['release', 'T1', '--agent', 'recovery', '--reason', 'too early']).code, 1);
  await until(() => h.json(['task', 'show', 'T1']).spend.entries?.length === 2, 'detached route usage was not collected');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.run.phase, 'waiting');
  assert.deepEqual(task.spend.entries.map((e) => [e.model, e.tokens]), [['first', 39], ['second', 13]]);
  assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
});
