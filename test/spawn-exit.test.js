'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN, runPty, PTY_AVAILABLE } = require('./helpers');

function setup(t) {
  const h = makeRepo();
  h.stopWorkers = [];
  // Windows holds directories open while a worker still uses them.
  t.after(() => {
    for (const stop of h.stopWorkers) stop();
    fs.rmSync(h.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  h.init();
  h.ok(['task', 'add', '--title', 'Recover a worker', '--tier', 'easy', '--acceptance', 'exit is reported']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Work on T1.\n' });
  return h;
}

async function until(fn, message) {
  const deadline = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function start(t, h, { claim = true, submit = false, wait = false, env = {} } = {}) {
  const marker = path.join(h.base, `started-${Date.now()}.json`);
  const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const task = process.env.GISHRA_TASK;
${claim ? "cp.execFileSync(process.execPath, [process.argv[1], 'claim', task]);" : ''}
fs.writeSync(1, Array.from({ length: 30 }, (_, i) => 'progress ' + i).join('\\n') + '\\n');
fs.writeSync(2, 'last diagnostic before exit\\n');
${submit ? "cp.execFileSync(process.execPath, [process.argv[1], 'submit', task, '--sha', 'abcdef1']);" : ''}
fs.writeFileSync(process.argv[2], JSON.stringify({ agent: process.env.GISHRA_AGENT, pid: process.pid }));
${wait ? 'process.exit(7);' : 'setInterval(() => {}, 1000);'}
`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, BIN, marker]),
    '--clear', 'profile', '--clear', 'effort']);
  if (wait) return h.run(['spawn', '--role', 'easy', '--task', 'T1', '--wait']);
  const spawned = h.json(['spawn', '--task', 'T1'], { env });
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try { process.kill(spawned.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  h.stopWorkers.push(kill);
  await until(() => fs.existsSync(marker), 'stand-in did not claim the task');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { agent: spawned.agent, pid: spawned.pid });
  return { ...spawned, kill };
}

test('a killed spawned claimant is reported with its log tail and released for recovery', async (t) => {
  const h = setup(t);
  const spawned = await start(t, h);
  const events = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const event = events().find((e) => e.cmd === 'spawn');
  assert.equal(event.detail.pid, spawned.pid);
  assert.equal(event.detail.log, spawned.log);
  assert.equal(event.detail.role, 'worker');
  assert.equal(event.detail.rung, 'easy');
  assert.equal(spawned.rung, 'easy');
  assert.doesNotMatch(h.ok(['status']), /exited without submit/);
  assert.doesNotMatch(h.ok(['ready']), /exited without submit/);

  spawned.kill();
  await until(() => (h.json(['status']).exited_claims || []).length === 1, 'killed spawned claimant was not reported');
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  for (const args of [['status'], ['ready'], ['ready', '--all']]) {
    const data = h.json(args);
    assert.equal(data.exited_claims.length, 1);
    const exit = data.exited_claims[0];
    assert.deepEqual({ id: exit.id, agent: exit.agent, pid: exit.pid, log: exit.log },
      { id: 'T1', agent: spawned.agent, pid: spawned.pid, log: spawned.log });
    assert.match(exit.tail, /last diagnostic before exit/);
    assert.match(exit.tail, /progress 29/);
    assert.doesNotMatch(exit.tail, /progress 0\n/);
    assert.ok(exit.tail.split('\n').length <= 20);
    const text = h.ok(args);
    assert.match(text, /exited without submit/);
    assert.ok(text.includes(spawned.log), text);
    assert.match(text, /last diagnostic before exit/);
    assert.match(text, /release T1 with --reason using the claimant identity/);
    assert.doesNotMatch(text, /--agent owner/);
    const workerText = h.ok([...args, '--agent', 'orchestrator']);
    assert.match(workerText, /request owner action/);
    assert.doesNotMatch(workerText, /--agent owner/);
    assert.deepEqual(data.ready, [], 'the claim stays held until release or lease expiry');
  }
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before, 'views do not change state');

  const refused = h.run(['release', 'T1', '--reason', 'recover killed worker', '--agent', 'another-worker']);
  assert.equal(refused.code, 1);
  const released = h.json(['release', 'T1', '--reason', 'recover killed worker']);
  assert.equal(released.status, 'todo');
  assert.equal(released.claim, null);
  assert.ok(released.notes.some((n) => n.text.includes('recover killed worker')));
  assert.ok(released.notes.some((n) => n.text.includes(spawned.log) && n.text.includes('last diagnostic before exit')));
  assert.equal(events().find((e) => e.cmd === 'release').detail.exited_spawn.pid, spawned.pid);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T1']);

  h.ok(['claim', 'T1', '--agent', spawned.agent]);
  assert.deepEqual(h.json(['status']).exited_claims, [], 'an old spawn is not attached to a new claim');
  h.ok(['release', 'T1', '--agent', spawned.agent, '--reason', 'start a replacement']);
  const replacement = await start(t, h);
  assert.notEqual(replacement.agent, spawned.agent);
  assert.deepEqual(h.json(['ready']).exited_claims, [], 'the replacement is alive');
});

test('submitted workers and claims without a matching spawn are not reported', async (t) => {
  const h = setup(t);
  const spawned = await start(t, h, { submit: true });
  spawned.kill();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.deepEqual(h.json(['ready']).exited_claims, []);

  h.ok(['task', 'add', '--title', 'Manual worker', '--acceptance', 'claim stays held']);
  h.ok(['claim', 'T2', '--agent', 'manual']);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.deepEqual(h.json(['ready']).exited_claims, []);
});

test('foreground exits without submit are reported from their recorded exit', async (t) => {
  const h = setup(t);
  const result = await start(t, h, { wait: true });
  assert.equal(result.code, 7, result.stderr);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const exitEvent = events.find((e) => e.cmd === 'spawn exit');
  assert.equal(exitEvent.detail.role, 'worker');
  assert.equal(exitEvent.detail.rung, 'easy');
  for (const args of [['status'], ['ready']]) {
    const exits = h.json(args).exited_claims;
    assert.equal(exits.length, 1);
    assert.equal(exits[0].agent, 'worker-T1-1');
    assert.equal(exits[0].log, null);
    assert.match(h.ok(args), /foreground output/);
  }
});

test('a missing log does not hide an exited claimant', async (t) => {
  const h = setup(t);
  const spawned = await start(t, h);
  spawned.kill();
  fs.rmSync(spawned.log);
  await until(() => (h.json(['ready']).exited_claims || []).length === 1, 'exit was hidden by its missing log');
  const exit = h.json(['status']).exited_claims[0];
  assert.equal(exit.log, spawned.log);
  assert.match(exit.tail, /log unavailable.*ENOENT/);
});

test('a spawn on another host is not inferred dead from a local PID', async (t) => {
  const h = setup(t);
  const hook = path.join(h.base, 'other-host.js');
  fs.writeFileSync(hook, "const os = require('node:os');\nconst hostname = os.hostname;\nos.hostname = () => hostname() + '-other';\n");
  const spawned = await start(t, h, { env: { NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"` } });
  spawned.kill();
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.deepEqual(h.json(['ready']).exited_claims, []);
});

test('terminal owner recovery requires explicit identity', { skip: !PTY_AVAILABLE }, async (t) => {
  const h = setup(t);
  const spawned = await start(t, h);
  spawned.kill();
  await until(() => (h.json(['status']).exited_claims || []).length === 1, 'exit was not reported');
  const args = ['release', 'T1', '--reason', 'spawned process exited without submit'];
  const env = { ...h.env };
  delete env.GISHRA_AGENT;
  const refused = runPty(args, { cwd: h.repo, env });
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  const result = runPty([...args, '--agent', 'owner'], { cwd: h.repo, env });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
});

test('Linux zombie and reused pid diagnostics do not mistake the process for a live worker', { skip: process.platform !== 'linux' }, async (t) => {
  const h = setup(t);
  const spawned = await start(t, h);
  const hook = path.join(__dirname, 'fixtures', 'process-stat.js').replace(/\\/g, '/');
  const stat = fs.readFileSync(`/proc/${spawned.pid}/stat`, 'utf8');
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  const event = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'spawn');
  assert.equal(event.detail.start_ticks, ticks);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const baseEnv = { NODE_OPTIONS: `--require "${hook}"`, GISHRA_TEST_PROC_PID: String(spawned.pid) };
  for (const change of [{ GISHRA_TEST_PROC_STATE: 'Z' }, { GISHRA_TEST_PROC_STATE: 'X' }, { GISHRA_TEST_PROC_TICKS: String(BigInt(ticks) + 1n) }]) {
    for (const args of [['status'], ['ready']]) {
      const data = h.json(args, { env: { ...baseEnv, ...change } });
      assert.equal(data.exited_claims.length, 1);
      assert.equal(data.exited_claims[0].pid, spawned.pid);
      assert.match(data.exited_claims[0].tail, /last diagnostic before exit/);
    }
  }
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
  assert.deepEqual(h.json(['status']).exited_claims, []);
});

test('reclaiming an expired lease under the same identity does not inherit its old spawn', async (t) => {
  const h = setup(t);
  const agent = 'worker-T1-1';
  h.ok(['claim', 'T1', '--agent', agent, '--lease', '1']);
  const oldClaim = h.readState('tasks.json').tasks[0].claim;
  const spawned = await start(t, h, { claim: false });
  assert.equal(spawned.agent, agent);
  spawned.kill();
  await until(() => (h.json(['status']).exited_claims || []).length === 1, 'old claim exit was not reported');
  const hook = path.join(__dirname, 'fixtures', 'clock.js').replace(/\\/g, '/');
  h.ok(['claim', 'T1', '--agent', agent], {
    env: { NODE_OPTIONS: `--require "${hook}"`, GISHRA_TEST_NOW: String(Date.parse(oldClaim.until) + 1) },
  });
  assert.notEqual(h.readState('tasks.json').tasks[0].claim.since, oldClaim.since);
  for (const args of [['status'], ['ready'], ['ready', '--all']]) {
    assert.deepEqual(h.json(args).exited_claims, [], 'a new claim must not use the old process');
    assert.doesNotMatch(h.ok(args), /exited without submit/);
  }
  const released = h.json(['release', 'T1', '--agent', agent, '--reason', 'finish new claim']);
  assert.equal(released.status, 'todo');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find((e) => e.cmd === 'release').detail.exited_spawn, undefined);
});
