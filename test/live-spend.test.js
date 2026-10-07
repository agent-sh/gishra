'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const STUB = path.join(__dirname, 'fixtures', 'live-usage-harness.js').replace(/\\/g, '/');
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

async function until(fn, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function setup(t, harness, supervision = {}) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Spend live', '--tier', 'easy', '--acceptance', 'budget holds']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Work on T1.\n' });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
  h.ok(['ladder', 'set', 'easy', '--harness', harness, '--model', 'dispatch-model', '--clear', 'profile', '--clear', 'effort',
    '--supervision', JSON.stringify({ usage_ms: 100, stall_ms: 60000, ...supervision })]);
  h.done = path.join(h.base, 'done');
  h.liveEnv = (extra = {}) => ({
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
    NODE_OPTIONS: `--require "${STUB}"`, LIVE_DONE: h.done, ...extra,
  });
  return h;
}

const exited = (h, agent) => events(h).some((e) => e.cmd === 'spawn exit' && e.detail.agent === agent && e.detail.code !== undefined);

for (const [harness, scope] of [['claude', 'project'], ['codex', 'task']]) {
  test(`${harness} usage read while it runs crosses the ${scope} token budget and the agent is stopped before it exits`, async (t) => {
    const h = setup(t, harness);
    if (scope === 'project') h.ok(['project', 'set', '--budget-tokens', '3500']);
    else h.ok(['task', 'update', 'T1', '--budget-tokens', '3500']);
    // 60 steps of 1000 tokens over about 6 s; the budget falls at step 4.
    const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '60', LIVE_STEP_TOKENS: '1000', LIVE_EVERY: '100' }) });
    await until(() => exited(h, spawned.agent), 'the agent was not stopped');
    assert.equal(fs.existsSync(h.done), false, 'the agent was stopped before it finished on its own');

    const log = events(h);
    const live = log.filter((e) => e.cmd === 'spend live');
    // Before the harness writes any usage the reading is unavailable, not zero.
    assert.ok(live.some((e) => e.detail.live.state === 'live'), 'usage was recorded while the agent ran');
    for (const e of live) {
      if (e.detail.live.state === 'live') assert.ok(e.detail.tokens > 0);
      else assert.equal(e.detail.tokens, null);
    }
    const stop = log.find((e) => e.cmd === 'budget stop');
    assert.ok(stop, 'the stop is recorded');
    assert.equal(stop.detail.authority, 'operational');
    assert.deepEqual(stop.detail.breaches.map((b) => [b.scope, b.what, b.limit]), [[scope === 'project' ? 'project' : 'T1', 'tokens', 3500]]);
    assert.ok(log.indexOf(stop) < log.findIndex((e) => e.cmd === 'spawn exit'), 'the stop came before the exit');
    const phase = h.json(['task', 'show', 'T1']).run;
    assert.equal(phase.phase, 'blocked');
    assert.match(phase.reason, /tokens budget crossed/);
    assert.equal(log.filter((e) => e.cmd === 'spawn retry').length, 0, 'a budget stop is not retried');

    // The owner is told, through a decision only the owner can answer.
    const decision = h.readState('decisions.json').decisions.find((d) => d.escalation);
    assert.deepEqual(decision.escalation.settings, ['budget.raise']);
    assert.deepEqual(decision.blocks, scope === 'project' ? [] : ['T1']);
    assert.match(decision.question, /was stopped/);

    // The exit collection replaces the live entry: one entry, counted once.
    await until(() => {
      const s = h.json(['task', 'show', 'T1']).spend;
      return s.entries?.length === 1 && !s.entries[0].live;
    }, 'exit collection did not reconcile the live entry');
    const spend = h.json(['task', 'show', 'T1']).spend;
    assert.equal(spend.entries[0].source, `spawn:${spawned.agent}`);
    assert.ok(spend.tokens > 3500 && spend.tokens < 60000, String(spend.tokens));
    assert.equal(spend.tokens, spend.entries[0].tokens);
    h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, spend.tokens, 'recollection does not count twice');
    assert.deepEqual(h.json(['status']).spend.live, []);

    // Further spawns wait for the owner to raise the budget.
    if (scope === 'project') {
      const again = h.run(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '1' }) });
      assert.notEqual(again.code, 0);
      assert.match(again.stderr, /project tokens budget crossed.*only the owner raises a budget/);
    } else {
      const raise = h.run(['task', 'update', 'T1', '--budget-tokens', '100000', '--agent', 'orchestrator']);
      assert.notEqual(raise.code, 0);
      assert.match(raise.stderr, /budget.raise is owner-required/);
      h.ok(['task', 'update', 'T1', '--budget-tokens', '3000', '--agent', 'orchestrator']);
      assert.equal(h.readState('tasks.json').tasks[0].budget.tokens, 3000, 'lowering is operational');
    }

    const text = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    for (const secret of [path.join(h.state, 'homes'), 'projects' + path.sep, 'rollout-']) {
      assert.ok(!live.some((e) => JSON.stringify(e).includes(secret)), `live usage events name ${secret}`);
    }
    assert.ok(!text.includes('"claude_home"'), 'events never carry the claude session root');
  });
}

test('live usage shows its freshness: live, stale when no reading arrives, unavailable without harness data', async (t) => {
  const h = setup(t, 'claude');
  h.stops = [];
  t.after(() => { for (const stop of h.stops) stop(); });
  // Two readings, then a long hold: the supervisor keeps the reading fresh.
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '2', LIVE_STEP_TOKENS: '700', LIVE_HOLD: '60000' }) });
  h.stops.push(() => { try { process.kill(spawned.pid, 'SIGKILL'); } catch {} });
  await until(() => h.json(['status']).spend.live.some((l) => l.tokens === 1400), 'live usage was not shown');
  const status = h.json(['status']);
  assert.equal(status.spend.tokens, 1400, 'live usage is in the totals');
  assert.equal(status.spend.missing_usage, 0);
  assert.deepEqual(status.spend.live.map((l) => [l.task, l.agent, l.state]), [['T1', spawned.agent, 'live']]);
  assert.match(h.ok(['status']), new RegExp(`live spend: T1 ${spawned.agent}: 1400 tokens, live`));
  assert.match(h.ok(['task', 'show', 'T1']), /live spend: .*1400 tokens, live/);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /data-live-state="live"/);

  // An hour without a new reading, as when the supervisor is gone.
  const clock = path.join(h.base, 'clock');
  fs.writeFileSync(clock, String(Date.now() + 3600000));
  const later = { hooks: { HOOK_CLOCK_FILE: clock } };
  assert.equal(h.json(['status'], later).spend.live[0].state, 'stale');
  assert.match(h.run(['status'], later).stdout, /1400 tokens, stale, last read 60m ago/);
  h.ok(['render'], later);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /data-live-state="stale"/);
});

test('a harness without live usage is shown unavailable, never as zero', async (t) => {
  const h = setup(t, 'claude');
  const script = "require('node:child_process').execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']); setTimeout(() => {}, 60000);";
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', script, require('./helpers').BIN])]);
  const spawned = h.json(['spawn', '--task', 'T1']);
  t.after(() => { try { process.kill(spawned.pid, 'SIGKILL'); } catch {} });
  await until(() => h.json(['status']).spend.live.length === 1, 'no live state was recorded');
  const [live] = h.json(['status']).spend.live;
  assert.equal(live.state, 'unavailable');
  assert.equal(live.tokens, null);
  assert.equal(h.json(['status']).spend.missing_usage, 0, 'a running spawn is not yet missing usage');
  assert.match(h.ok(['status']), /usage unavailable from command while it runs/);
});
