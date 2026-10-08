'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, detachedAlive, BIN } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail('escalation did not finish');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function setup(t, trigger = 'exit', range = 'easy..medium', prepare = null) {
  const h = makeRepo();
  t.after(async () => {
    try {
      // Stop background usage and gate retries before removing fixture state.
      for (const child of h.detached()) {
        if (child.kind === 'monitor' && detachedAlive(child)) process.kill(child.pid, 'SIGTERM');
      }
      await until(() => h.detached().filter((child) => child.kind === 'monitor').every((child) => !detachedAlive(child)), 60000);
    } finally {
      await h.cleanup();
    }
  });
  h.init();
  if (prepare) prepare(h);
  h.ok(['task', 'add', '--title', 'Start low', '--tier', range, '--acceptance', 'climbs on quality failure']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Finish the task.\n' });
  h.attempts = path.join(h.base, 'attempts.json');
  for (const [index, rung] of ['easy', 'medium', 'hard'].entries()) {
    const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const cli = (args) => cp.execFileSync(process.execPath, [process.argv[1], ...args], { encoding: 'utf8' });
${index === 0 && trigger === 'preclaim' ? '' : "cli(['claim', 'T1']);"}
const attempts = fs.existsSync(process.argv[2]) ? JSON.parse(fs.readFileSync(process.argv[2])) : [];
attempts.push({ rung: '${rung}', agent: process.env.TOWER_CRANE_AGENT, session: process.env.TOWER_CRANE_SESSION,
  previous: process.argv[3], cwd: process.cwd() });
fs.writeFileSync(process.argv[2], JSON.stringify(attempts));
console.log(JSON.stringify({ type: 'thread.started', thread_id: '${rung}-thread' }));
console.log(JSON.stringify({ type: 'result', modelUsage: { luna: {} },
  usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 } }));
${index === 0 && ['cleanup', 'orphan'].includes(trigger) ? `
cp.spawn(process.execPath, ['-e', \`
const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync(process.argv[1] + '.term', 'stopping'));
fs.writeFileSync(process.argv[1] + '.ready', String(process.pid));
setInterval(() => {}, 1000);
\`, process.argv[2]], { stdio: 'ignore' });
` : ''}
${index === 0 && ['stall', 'hold', 'orphan'].includes(trigger) ? 'setInterval(() => {}, 1000);'
    : index === 0 && trigger === 'outage' ? "console.error('HTTP 503 service unavailable'); process.exit(1);"
      : index === 0 && trigger === 'refusal' ? "console.log(JSON.stringify({ type: 'refusal' })); process.exit(1);"
        : trigger === 'top' || index === 0 && ['exit', 'preclaim'].includes(trigger) ? 'process.exit(0);'
      : `cli(['submit', 'T1', '--sha', '${h.git(['rev-parse', 'HEAD'])}']);`}
${index === 0 && trigger === 'cleanup' ? "setInterval(() => { if (fs.existsSync(process.argv[2] + '.exit')) process.exit(0); }, 25);" : ''}
`;
    h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
      JSON.stringify([process.execPath, '-e', script, BIN, h.attempts, '{session}', '{prompt}']),
      '--clear', 'profile', '--clear', 'effort', '--clear', 'model', '--supervision',
      JSON.stringify({ retries: 0, ...(index === 0 && trigger === 'stall' ? { stall_ms: 100 } : {}), backoff_ms: 10, max_backoff_ms: 10 })]);
  }
  h.readAttempts = () => fs.existsSync(h.attempts) ? JSON.parse(fs.readFileSync(h.attempts)) : [];
  return h;
}

test('tier ranges start low; invalid and reversed ranges are refused without state writes', (t) => {
  const h = setup(t);
  const preview = h.json(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(preview.rung, 'easy');
  assert.equal(preview.resumed, false);
  assert.deepEqual(h.json(['task', 'show', 'T1']).tier_range, { min: 'easy', max: 'medium' });
  const before = events(h).length;
  for (const tier of ['hard..easy', 'easy..unknown', 'easy..medium..hard']) {
    assert.notEqual(h.run(['task', 'update', 'T1', '--tier', tier]).code, 0);
  }
  assert.equal(events(h).length, before);
  h.ok(['task', 'update', 'T1', '--tier', 'hard']);
  assert.equal(h.json(['task', 'show', 'T1']).tier_range, undefined);
  const plan = [{ title: 'Imported range', tier: 'medium..research', acceptance: ['starts medium'] }];
  h.ok(['plan', 'import', '-'], { input: JSON.stringify(plan) });
  assert.equal(h.json(['task', 'show', 'T2']).tier, 'medium');
});

test('manual range changes use tier authority even when clearing the range at its current rung', (t) => {
  const h = setup(t);
  const before = events(h).length;
  for (const tier of ['easy', 'easy..hard']) {
    const result = h.run(['task', 'update', 'T1', '--tier', tier, '--agent', 'worker-bounds']);
    assert.equal(result.code, 1, 'workers must not change a planned range');
    assert.match(result.stderr, /task.tier.*operational/);
  }
  assert.equal(events(h).length, before);
  assert.deepEqual(h.json(['task', 'show', 'T1']).tier_range, { min: 'easy', max: 'medium' });
  h.ok(['task', 'update', 'T1', '--tier', 'easy', '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', 'T1']).tier_range, undefined);
});

for (const trigger of ['exit', 'preclaim', 'stall', 'review']) {
  test(`${trigger} climbs one rung automatically with a fresh session and unknown adapter spend`, {
    skip: trigger === 'stall' && process.platform !== 'linux' && 'CPU stall observation needs Linux',
  }, async (t) => {
    const h = setup(t, trigger);
    h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices: {
      luna: { input: 1, cache_write: 1, cache_read: 1, output: 1 },
    } })]);
    h.ok(['spawn', '--task', 'T1']);
    if (trigger === 'review') {
      await until(() => h.json(['task', 'show', 'T1']).status === 'submitted');
      h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', 'abcdef1', '--agent', 'reviewer']);
      h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
        '--agent', 'worker-T1-1']);
      assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
      h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
        '--agent', 'reviewer', '--summary', 'incorrect boundary']);
    }
    await until(() => h.readAttempts().length === 2 && h.json(['task', 'show', 'T1']).status === 'submitted');
    const attempts = h.readAttempts();
    assert.deepEqual(attempts.map((a) => a.rung), ['easy', 'medium']);
    assert.equal(attempts[1].previous, '');
    assert.notEqual(attempts[1].agent, attempts[0].agent);
    assert.notEqual(attempts[1].session, attempts[0].session);
    assert.equal(attempts[1].cwd, attempts[0].cwd);
    const climb = events(h).find((e) => e.cmd === 'escalate');
    assert.equal(climb.detail.trigger, trigger === 'preclaim' ? 'exit' : trigger);
    assert.equal(climb.detail.from, 'easy');
    assert.equal(climb.detail.to, 'medium');
    const task = h.json(['task', 'show', 'T1']);
    assert.deepEqual(task.spend_by_rung.easy, { tokens: null, cost_usd: null });
    assert.ok(task.escalations[0].reason);
    h.ok(['recover', 'T1']);
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
  });
}

for (const trigger of ['outage', 'refusal']) {
  test(`${trigger} exhaustion stays at the same rung, including after exit observation`, async (t) => {
    const h = setup(t, trigger);
    h.ok(['spawn', '--task', 'T1']);
    await until(() => events(h).some((e) => e.cmd === 'spawn exit'));
    h.run(['wait', '--after', '0', '--types', 'worker-exited', '--agent', 'orchestrator', '--timeout', '1']);
    h.ok(['recover', 'T1']);
    assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
    assert.equal(h.readAttempts().length, 1);
  });
}

test('a refused climb stays pending and concurrent recovery dispatches only one replacement', async (t) => {
  const h = setup(t);
  const command = h.readState('project.json').ladder.medium.command;
  h.ok(['ladder', 'set', 'medium', '--command', JSON.stringify([path.join(h.base, 'missing-worker')])]);
  h.ok(['spawn', '--task', 'T1']);
  await until(() => h.json(['task', 'show', 'T1']).escalation_pending === true);
  h.ok(['ladder', 'set', 'medium', '--command', JSON.stringify(command)]);
  const results = await Promise.all([
    h.runAsync(['recover', 'T1', '--agent', 'recovery-a']),
    h.runAsync(['recover', 'T1', '--agent', 'recovery-b']),
  ]);
  assert.ok(results.every((r) => r.code === 0), results.map((r) => r.stderr).join('\n'));
  await until(() => h.json(['task', 'show', 'T1']).status === 'submitted');
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
});

test('wait recovers a verified worker exit after its supervisor is lost', {
  skip: process.platform !== 'linux' && 'independent POSIX worker and monitor termination',
}, async (t) => {
  const h = setup(t, 'hold');
  const spawn = h.json(['spawn', '--task', 'T1']);
  await until(() => h.readAttempts().length === 1);
  process.kill(spawn.monitor_pid, 'SIGKILL');
  process.kill(spawn.pid, 'SIGKILL');
  h.ok(['wait', '--after', '0', '--types', 'worker-exited', '--agent', 'orchestrator', '--timeout', '10']);
  await until(() => h.json(['task', 'show', 'T1']).status === 'submitted');
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
});

test('lost-supervisor recovery waits for redirected orphan descendants to stop', {
  skip: process.platform !== 'linux' && 'Linux process group observation',
}, async (t) => {
  const h = setup(t, 'orphan');
  h.ok(['ladder', 'set', 'easy', '--supervision', '{"stall_ms":60000}']);
  const spawn = h.json(['spawn', '--task', 'T1']);
  await until(() => fs.existsSync(h.attempts + '.ready'));
  const P = require('../lib/processes');
  const pid = Number(fs.readFileSync(h.attempts + '.ready', 'utf8'));
  const child = { pid, ...P.identity(pid) };
  try {
    process.kill(spawn.monitor_pid, 'SIGKILL');
    process.kill(spawn.pid, 'SIGKILL');
    await until(() => h.run(['spend', 'T1', '--from-spawn', spawn.agent]).code === 0);
    assert.equal(P.processState(child), 'running');
    const result = h.run(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator', '--timeout', '2']);
    assert.equal(result.code, 2, 'a parent exit must not dispatch while its orphan descendant is alive');
    const waiting = h.json(['recover', 'T1', '--agent', 'orchestrator']);
    assert.match(waiting.waiting, /process group.*still running/i);
    assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
    assert.equal(events(h).filter((e) => e.cmd === 'spawn exit' && e.detail.agent === spawn.agent).length, 0);
    assert.ok(events(h).some((e) => e.cmd === 'recover waiting' && /process group/.test(e.detail.reason)));
    process.kill(child.pid, 'SIGKILL');
    await until(() => P.processState(child) === 'exited');
    h.ok(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator', '--timeout', '10']);
    assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
    assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
  } finally {
    if (P.processState(child) !== 'exited') process.kill(child.pid, 'SIGKILL');
  }
});

test('a failed review waits for the monitor to finish cleaning submitted worker descendants', {
  skip: process.platform !== 'linux' && 'Linux process group cleanup',
}, async (t) => {
  const h = setup(t, 'cleanup');
  h.ok(['spawn', '--task', 'T1']);
  await until(() => fs.existsSync(h.attempts + '.ready') && h.json(['task', 'show', 'T1']).status === 'submitted');
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
    '--agent', 'reviewer', '--summary', 'wrong result']);
  fs.writeFileSync(h.attempts + '.exit', '');
  await until(() => fs.existsSync(h.attempts + '.term'));
  assert.equal(events(h).filter((e) => e.cmd === 'spawn exit').length, 0);
  h.ok(['recover', 'T1', '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy', 'the parent exit cannot release a live process group');
  await until(() => h.readAttempts().length === 2 && h.json(['task', 'show', 'T1']).status === 'submitted');
  const log = events(h);
  assert.ok(log.findIndex((e) => e.cmd === 'spawn exit' && e.detail.agent === 'worker-T1-1')
    < log.findIndex((e) => e.cmd === 'escalate'));
});

test('rework records the review climb before pending worker cleanup finishes', {
  skip: process.platform !== 'linux' && 'Linux process group cleanup',
}, async (t) => {
  const h = setup(t, 'cleanup');
  h.ok(['spawn', '--task', 'T1']);
  await until(() => fs.existsSync(h.attempts + '.ready') && h.json(['task', 'show', 'T1']).status === 'submitted');
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
    '--agent', 'reviewer', '--summary', 'wrong result']);
  h.ok(['rework', 'T1', '--reason', 'correct the reviewed result', '--agent', 'orchestrator']);
  const pending = h.json(['task', 'show', 'T1']);
  assert.equal(pending.tier, 'medium', 'rework must preserve the failed attempt before cleanup');
  assert.equal(pending.escalation_pending, true);
  assert.equal(pending.escalations[0].trigger, 'review');
  assert.equal(h.readAttempts().length, 1);
  h.ok(['recover', 'T1', '--agent', 'orchestrator']);
  assert.equal(h.readAttempts().length, 1, 'recording the climb does not release the worktree');
  fs.writeFileSync(h.attempts + '.exit', '');
  // Cleanup, a contended state lock and the spawn handshake have separate deadlines.
  await until(() => h.readAttempts().length === 2 && h.json(['task', 'show', 'T1']).status === 'submitted', 30000);
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
});

for (const route of ['tests', 'clean', 'ci', 'local-ci']) {
  const type = route === 'local-ci' ? 'ci' : route;
  test(`a confirmed ${route} gate failure climbs and reaches the owner at the range ceiling`, async (t) => {
    const h = setup(t, 'review', 'easy..medium', (repo) => {
      gateFixture(repo);
      // Spawn exit runs every software gate, so each fails only where the check asks it to.
      const exit = "process.exit(process.env.FIXTURE_GATE_OK === '0' ? 1 : 0)";
      repo.ok(['project', 'set', '--repo', 'acme/demo', '--tests-mode', 'run-only',
        '--tests-cmd', `node -e "${exit}"`]);
      if (route === 'local-ci') repo.ok(['project', 'set', '--ci-local', JSON.stringify({
        command: [process.execPath, '-e', exit], timeout: 5,
      })]);
    });
    // The monitor runs automated gates after spawn exit; check only once each reaction has ended.
    const settled = (agent) => {
      const log = events(h);
      const exit = log.findIndex((e) => e.cmd === 'spawn exit' && e.detail.agent === agent);
      const runs = log.filter((e) => e.cmd === 'automation' && e.detail.phase === 'running');
      return exit >= 0 && log.slice(exit).some((e) => runs.includes(e))
        && runs.every((r) => log.some((e) => e.cmd === 'automation' && e.detail.source === r.detail.source && e.detail.phase !== 'running'));
    };
    h.ok(['spawn', '--task', 'T1']);
    await until(() => settled('worker-T1-1'));
    for (const rung of ['medium', null]) {
      const result = h.run(['check', type, 'T1'], { env: { FIXTURE_GATE_OK: '0' } });
      assert.equal(result.code, 1, result.stderr);
      if (rung) {
        await until(() => h.readAttempts().length === 2 && h.json(['task', 'show', 'T1']).status === 'submitted');
        assert.equal(h.json(['task', 'show', 'T1']).tier, rung);
        await until(() => settled('worker-T1-2'));
      } else {
        await until(() => h.json(['decisions', '--open']).length === 1);
      }
    }
    const task = h.json(['task', 'show', 'T1']);
    assert.deepEqual(task.escalations.map((e) => e.trigger), [type, type]);
    assert.deepEqual(task.escalations.map((e) => e.to), ['medium', null]);
    assert.ok(task.evidence.filter((e) => e.type === type && !e.ok).every((e) => e.confirmed_failure === true));
    assert.equal(task.evidence.filter((e) => e.type === type && !e.ok).length, 2);
    assert.equal(h.readAttempts().length, 2);
  });
}

for (const type of ['tests', 'clean', 'ci']) {
  test(`unconfirmed ${type} observation failures do not climb`, async (t) => {
    const h = setup(t, 'review', 'easy..medium', (repo) => {
      gateFixture(repo);
      repo.ok(['project', 'set', '--repo', 'acme/demo']);
      if (type === 'tests') {
        repo.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', 'tower-crane-missing-test-program']);
      } else if (type === 'clean') {
        fs.writeFileSync(path.join(repo.base, 'tools', 'scanner.js'),
          'console.log(JSON.stringify({items:[{severity:"HIGH"}],errors:["scan incomplete"]}));');
      } else {
        const file = path.join(repo.base, 'tools', 'gh');
        const script = fs.readFileSync(file, 'utf8').replace("status: 'completed', conclusion: ok ? 'success' : 'failure'",
          "status: 'in_progress', conclusion: null");
        fs.writeFileSync(file, script);
      }
    });
    h.ok(['spawn', '--task', 'T1']);
    await until(() => events(h).some((e) => e.cmd === 'spawn exit'));
    assert.equal(h.run(['check', type, 'T1']).code, 1);
    h.ok(['recover', 'T1']);
    assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
  });
}

test('a later eligible passing review supersedes a failure before worker exit', async (t) => {
  const h = setup(t, 'hold');
  h.ok(['ladder', 'set', 'easy', '--supervision', '{"stall_ms":60000}']);
  const spawn = h.json(['spawn', '--task', 'T1']);
  await until(() => h.readAttempts().length === 1);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', spawn.agent]);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', sha, '--agent', 'reviewer', '--summary', 'first verdict']);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer', '--summary', 'corrected verdict']);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', 'abcdef1', '--agent', 'reviewer']);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', sha, '--agent', spawn.agent]);
  process.kill(spawn.pid, 'SIGKILL');
  await until(() => events(h).some((e) => e.cmd === 'spend' && e.detail.source === `spawn:${spawn.agent}`));
  assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
});

for (const prior of ['spent', 'lock-timeout']) {
  test(`wait retries an unhandled exit after its notification was recorded (${prior})`, {
    skip: process.platform !== 'linux' && 'independent POSIX worker and monitor termination',
  }, async (t) => {
    const h = setup(t, 'hold');
    h.ok(['ladder', 'set', 'easy', '--supervision', '{"stall_ms":60000}']);
    const spawn = h.json(['spawn', '--task', 'T1']);
    await until(() => h.readAttempts().length === 1);
    process.kill(spawn.monitor_pid, 'SIGKILL');
    process.kill(spawn.pid, 'SIGKILL');
    const opts = {};
    if (prior === 'spent') {
      await until(() => h.run(['spend', 'T1', '--from-spawn', spawn.agent]).code === 0);
      assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
    } else {
      const hook = path.join(__dirname, 'fixtures', 'escalation-lock-timeout.js').replace(/\\/g, '/');
      opts.env = { NODE_OPTIONS: `--require "${hook}"`, TOWER_CRANE_TEST_RECOVERY_LOCK: path.join(h.base, 'lock-timeout') };
    }
    const result = h.run(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator', '--timeout', '5'], opts);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    if (prior === 'lock-timeout') assert.ok(fs.existsSync(opts.env.TOWER_CRANE_TEST_RECOVERY_LOCK));
    assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
    assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
  });
}

test('a sandboxed reviewer waits for a hidden live worker to exit before climbing', async (t) => {
  const h = setup(t, 'hold');
  h.ok(['ladder', 'set', 'easy', '--supervision', '{"stall_ms":60000}']);
  const spawn = h.json(['spawn', '--task', 'T1']);
  await until(() => h.readAttempts().length === 1);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', spawn.agent]);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', sha, '--agent', 'reviewer',
    '--summary', 'wrong result'], {
    hooks: { HOOK_HIDDEN_PIDS: JSON.stringify([spawn.pid, spawn.monitor_pid]) },
  });
  assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
  process.kill(spawn.pid, 'SIGKILL');
  await until(() => {
    const task = h.json(['task', 'show', 'T1']);
    return task.status === 'submitted' && task.tier === 'medium' && h.readAttempts().length === 2;
  });
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
});

test('a reviewer without permission to create a worker home leaves the climb for a host observer', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const h = setup(t, 'review');
  h.ok(['spawn', '--task', 'T1']);
  await until(() => events(h).some((e) => e.cmd === 'spawn exit'));
  const homes = path.join(h.state, 'homes');
  fs.chmodSync(homes, 0o500);
  try {
    h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
      '--agent', 'reviewer', '--summary', 'needs rework']);
    assert.equal(h.json(['task', 'show', 'T1']).escalation_pending, true);
  } finally {
    fs.chmodSync(homes, 0o700);
  }
  h.ok(['recover', 'T1', '--agent', 'orchestrator']);
  await until(() => h.readAttempts().length === 2 && h.json(['task', 'show', 'T1']).status === 'submitted');
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
});

test('a brokered failed review records the climb and leaves dispatch to its host', async (t) => {
  const h = setup(t, 'review');
  const spawn = h.json(['spawn', '--task', 'T1']);
  await until(() => events(h).some((e) => e.cmd === 'spawn exit'));
  const B = require('../lib/broker');
  const binding = path.join(h.base, 'review-broker', B.FILE);
  const broker = await B.start({
    state: h.state, task: 'T1', agent: 'reviewer-T1-1', role: 'reviewer', cwd: spawn.cwd, broker: binding,
  });
  try {
    const result = await B.forward(binding, ['evidence', 'T1', '--type', 'review', '--fail',
      '--sha', h.git(['rev-parse', 'HEAD']), '--summary', 'wrong result'], h.state);
    assert.equal(result.code, 0, result.stderr);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.tier, 'medium');
    assert.equal(task.escalation_pending, true);
    assert.equal(h.readAttempts().length, 1);
    h.ok(['recover', 'T1', '--agent', 'orchestrator']);
    await until(() => h.readAttempts().length === 2 && h.json(['task', 'show', 'T1']).status === 'submitted');
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
  } finally {
    broker.close();
  }
});

test('a resource lock delays dispatch while retaining the recorded climb for wait to retry', async (t) => {
  const h = setup(t, 'review');
  h.ok(['spawn', '--task', 'T1']);
  await until(() => events(h).some((e) => e.cmd === 'spawn exit'));
  h.ok(['task', 'update', 'T1', '--lock', 'lab']);
  h.ok(['task', 'add', '--title', 'Hold the lab', '--lock', 'lab', '--acceptance', 'exclusive use']);
  h.ok(['claim', 'T2', '--agent', 'lab-holder']);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
    '--agent', 'reviewer', '--summary', 'wrong result']);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.tier, 'medium');
  assert.equal(task.escalation_pending, true);
  assert.equal(h.readAttempts().length, 1);
  h.ok(['release', 'T2', '--agent', 'lab-holder', '--reason', 'lab free']);
  h.ok(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator', '--timeout', '10']);
  await until(() => h.readAttempts().length === 2 && h.json(['task', 'show', 'T1']).status === 'submitted');
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
});

test('failure at the range top opens one owner decision and blocks further dispatch', async (t) => {
  const h = setup(t, 'top', 'easy..hard');
  h.ok(['spawn', '--task', 'T1']);
  await until(() => h.json(['decisions', '--open']).length === 1);
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium', 'hard']);
  const decision = h.json(['decisions', '--open'])[0];
  assert.deepEqual(decision.blocks, ['T1']);
  assert.match(decision.question, /hard.*exit/i);
  h.ok(['recover', 'T1']);
  assert.equal(h.json(['decisions', '--open']).length, 1);
  assert.notEqual(h.run(['spawn', '--task', 'T1']).code, 0);
  assert.equal(h.readAttempts().length, 3);
});

test('a native harness climb records captured tokens and configured cost for the failed rung', async (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices: {
    luna: { input: 1, cache_write: 1, cache_read: 1, output: 1 },
  } })]);
  h.ok(['ladder', 'set', 'easy', '--harness', 'claude', '--model', 'luna', '--clear', 'command']);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), '', { mode: 0o755 });
  const usage = path.join(h.base, 'usage.json');
  fs.writeFileSync(usage, JSON.stringify({ type: 'result', modelUsage: { luna: {} },
    usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 } }));
  h.ok(['spawn', '--task', 'T1'], {
    env: { PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), USAGE_CLAIM: '1', USAGE_EXIT: '1' },
    hooks: { HOOK_USAGE_HARNESS: 'claude', HOOK_USAGE_FILE: usage },
  });
  await until(() => h.json(['task', 'show', 'T1']).status === 'submitted');
  const task = h.json(['task', 'show', 'T1']);
  assert.deepEqual(task.spend_by_rung.easy, { tokens: 120, cost_usd: 0.00012 });
  assert.deepEqual(task.escalations[0].spend_by_rung.easy, task.spend_by_rung.easy);
});
