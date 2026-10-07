'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const { makeRepo, BIN, HOOKS, detachedAlive } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const bedrockOutage = require('./fixtures/bedrock-outage.json');

const log = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

async function until(fn, message) {
  const deadline = Date.now() + 12000;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function setup(t, { failures = 1, error = '75', records = null, hold = 0, config = {}, env = {}, busy = false, claimDelay = 0, claim = true, sessionReceipt = false } = {}) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Supervise an outage', '--tier', 'easy', '--acceptance', 'same session reruns']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Finish the task.\n' });
  h.attempts = path.join(h.base, 'attempts.json');
  const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const cli = (args) => cp.execFileSync(process.execPath, [process.argv[1], ...args], { encoding: 'utf8' });
const file = process.argv[2];
const attempts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
if (!attempts.length && ${claim}) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${claimDelay});
  cli(['claim', 'T1', '--lease', '1']);
}
const task = JSON.parse(cli(['task', 'show', 'T1', '--json']));
attempts.push({ agent: process.env.TOWER_CRANE_AGENT, session: process.env.TOWER_CRANE_SESSION, retry: process.env.TOWER_CRANE_RETRY,
  cwd: process.cwd(), claim: task.claim });
fs.writeFileSync(file, JSON.stringify(attempts));
${sessionReceipt ? "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'supervised-session' }));" : ''}
${busy ? "cp.spawn(process.execPath, ['-e', 'const end = Date.now() + 2200; while (Date.now() < end) {}'], { stdio: 'ignore' });" : ''}
setTimeout(() => {
  if (attempts.length <= ${failures}) {
    ${records ? `for (const record of ${JSON.stringify(records)}) console.log(JSON.stringify(record)); process.exit(1);`
      : ['signal', 'interrupt'].includes(error) ? `process.kill(process.pid, '${error === 'signal' ? 'SIGTERM' : 'SIGINT'}');`
      : ['claude-error', 'codex-error', 'codex-failed'].includes(error)
        ? `console.log(${JSON.stringify(JSON.stringify(error === 'claude-error' ? { type: 'result', is_error: true, api_error_status: 503 }
          : error === 'codex-error' ? { type: 'error', message: 'HTTP 502 bad gateway' }
            : { type: 'turn.failed', error: { message: 'provider outage' } }))}); process.exit(1);`
        : ['outage', 'server', 'status-json'].includes(error) ? `console.error(${JSON.stringify(error === 'server' ? '500 Internal Server Error'
          : error === 'status-json' ? '{"status_code":502}' : 'API Error: 503 service unavailable')}); process.exit(1);` : `process.exit(${error});`}
  } else process.exit(0);
}, ${hold});
`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, BIN, h.attempts]),
    '--clear', 'profile', '--clear', 'effort', '--supervision',
    JSON.stringify({ retries: 2, backoff_ms: 150, max_backoff_ms: 1000, stall_ms: 60000, ...config })]);
  h.spawn = (role) => h.run(['spawn', '--task', 'T1', ...(role ? ['--role', role] : []), '--wait', '--json'], { env, timeout: 15000 });
  h.readAttempts = () => fs.existsSync(h.attempts) ? JSON.parse(fs.readFileSync(h.attempts, 'utf8')) : [];
  return h;
}

for (const attempt of bedrockOutage.attempts) {
  for (const type of ['error', 'turn.failed']) {
    test(`recorded Bedrock attempt ${attempt.attempt} ${type} reruns with the session and claim kept`, (t) => {
      const h = setup(t, { records: attempt.records.filter((record) => record.type === type) });
      const result = h.spawn();
      assert.equal(result.code, 0, result.stderr);
      const attempts = h.readAttempts();
      assert.equal(attempts.length, 2);
      for (const key of ['agent', 'session', 'cwd', 'claim']) assert.deepEqual(attempts[1][key], attempts[0][key]);
      assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 1);
      assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
    });
  }
}

for (const record of [
  { type: 'error', message: 'rate limit exceeded' },
  { type: 'turn.failed', error: { message: 'The service is temporarily unavailable.' } },
  { type: 'error', message: 'HTTP 429 Too Many Requests' },
  { type: 'turn.failed', error: { message: 'overloaded' } },
  { type: 'result', is_error: true, api_error_status: 429 },
]) {
  test(`capacity error envelope ${JSON.stringify(record)} reruns`, (t) => {
    const h = setup(t, { records: [record] });
    const result = h.spawn();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(h.readAttempts().length, 2);
    assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
  });
}

test('default retry budget waits beyond the observed ten-minute outage and remains bounded', (t) => {
  const clock = path.join(__dirname, 'fixtures', 'supervision-backoff-clock.js').replace(/\\/g, '/');
  const h = setup(t, { failures: 5, env: { NODE_OPTIONS: `--require "${clock}"` } });
  h.ok(['ladder', 'set', 'easy', '--clear', 'supervision']);
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  const attempts = h.readAttempts();
  assert.equal(attempts.length, 6);
  for (const attempt of attempts) assert.deepEqual(attempt.claim, attempts[0].claim);
  const delays = log(h).filter((e) => e.cmd === 'spawn phase' && e.detail.phase === 'retrying').map((e) => e.detail.backoff_ms);
  assert.deepEqual(delays, [30000, 60000, 120000, 240000, 480000]);
  assert.equal(delays.reduce((sum, delay) => sum + delay, 0), 930000);
  assert.ok(delays.every((delay) => delay <= 600000));
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

for (const error of ['75', 'outage', 'server', 'status-json', 'claude-error', 'codex-error', 'codex-failed', 'signal', 'interrupt']) {
  test(`transient ${error} reruns the same session, preserving the claim until success`, {
    skip: process.platform === 'win32' && ['signal', 'interrupt'].includes(error) && 'POSIX signal observations',
  }, (t) => {
    const h = setup(t, { error });
    const result = h.spawn();
    assert.equal(result.code, 0, result.stderr);
    const attempts = h.readAttempts();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].agent, 'worker-T1-1');
    for (const key of ['agent', 'session', 'cwd', 'claim']) assert.deepEqual(attempts[1][key], attempts[0][key]);
    assert.equal(attempts[1].retry, '1');
    assert.equal(log(h).filter((e) => e.cmd === 'spawn').length, 1);
    assert.equal(log(h).filter((e) => e.cmd === 'claim').length, 1);
    assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 1);
    assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
    assert.match(h.ok(['task', 'show', 'T1']), /phase: waiting/);
    assert.match(h.ok(['status']), /T1.*waiting/);
    assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /waiting/);
  });
}

test('repeated transient exits exhaust bounded retries with exponential backoff and a blocked phase', (t) => {
  const h = setup(t, { failures: 9 });
  const result = h.spawn();
  assert.equal(result.code, 75, result.stderr);
  assert.equal(h.readAttempts().length, 3);
  const retries = log(h).filter((e) => e.cmd === 'spawn phase' && e.detail.phase === 'retrying');
  assert.deepEqual(retries.map((e) => e.detail.backoff_ms), [150, 300]);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.run.phase, 'blocked');
  assert.match(task.run.reason, /after 2 retries/);
  assert.equal(task.claim.agent, 'worker-T1-1');
  assert.equal(task.status, 'in_progress');
  assert.match(h.ok(['status']), /blocked: transient exit after 2 retries/);
  assert.equal(log(h).filter((e) => e.cmd === 'worker-exited').length, 1);
  assert.equal(h.json(['status']).exited_claims.length, 1);
  h.ok(['release', 'T1', '--agent', 'recovery-worker', '--reason', 'retry budget exhausted']);
  assert.equal(h.json(['task', 'show', 'T1']).claim, null);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'todo');
});

test('detached supervision renews a short lease during backoff and does not allow premature recovery', async (t) => {
  const h = setup(t, { config: { backoff_ms: 1400, max_backoff_ms: 1400 } });
  const clockFile = path.join(h.base, 'clock');
  const now = Date.now();
  fs.writeFileSync(clockFile, String(now));
  const spawned = h.json(['spawn', '--task', 'T1'], {
    env: { NODE_OPTIONS: `--require "${HOOKS.replace(/\\/g, '/')}"`, HOOK_CLOCK_FILE: clockFile },
  });
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'retrying', 'retry was not recorded');
  await until(() => /retrying 1/.test(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8')), 'saved board did not render the retry phase');
  fs.writeFileSync(clockFile, String(now + 40000));
  await until(() => log(h).some((e) => e.cmd === 'renew'), 'supervisor did not renew the short lease');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.claim.agent, spawned.agent);
  assert.ok(Date.parse(task.claim.until) > now + 60000);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.equal(h.run(['release', 'T1', '--agent', 'other', '--reason', 'premature']).code, 1);
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'retry did not finish');
  assert.equal(h.readAttempts().length, 2);
  assert.equal(log(h).filter((e) => e.cmd === 'claim').length, 1);
});

test('later spawns preserve retrying homes through backoff, retries and queued hook writes', async (t) => {
  const h = makeRepo(t);
  h.init();
  for (const id of ['T1', 'T2', 'T3']) {
    h.ok(['task', 'add', '--title', `Task ${id}`, '--tier', 'easy', '--acceptance', 'finish the supervised run']);
    h.ok(['brief', 'set', id, '-'], { input: 'Finish the task.\n' });
  }
  const retryReady = path.join(h.base, 'retry-ready');
  const script = `
const cp = require('node:child_process');
const fs = require('node:fs');
const cli = (args) => cp.execFileSync(process.execPath, [process.argv[1], ...args], { encoding: 'utf8' });
const task = process.env.TOWER_CRANE_TASK;
const agent = process.env.TOWER_CRANE_AGENT;
const retry = Number(process.env.TOWER_CRANE_RETRY || 0);
const delay = new Int32Array(new SharedArrayBuffer(4));
const current = JSON.parse(cli(['task', 'show', task, '--json']));
if (current.claim?.agent !== agent) cli(['claim', task, '--lease', '1']);
if (task === 'T1' && retry === 0) {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'first attempt' } }));
  process.exitCode = 75;
} else {
  if (task === 'T1' && retry === 1) {
    fs.writeFileSync(${JSON.stringify(retryReady)}, '');
    while (!fs.existsSync(${JSON.stringify(`${retryReady}.go`)})) Atomics.wait(delay, 0, 0, 10);
  }
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'last report from ' + agent } }));
}
`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, BIN]),
    '--clear', 'profile', '--clear', 'effort', '--supervision', JSON.stringify({ retries: 1, backoff_ms: 3500, max_backoff_ms: 3500 })]);

  const started = h.json(['spawn', '--task', 'T1']);
  const home = path.join(h.state, 'homes', started.agent);
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'retrying', 'first attempt did not enter backoff');

  const duringBackoff = h.json(['spawn', '--task', 'T2', '--wait']);
  assert.equal(duringBackoff.code, 0);
  assert.ok(fs.existsSync(path.join(home, 'hook.json')), 'a later spawn keeps the home while the supervisor waits to retry');

  await until(() => fs.existsSync(retryReady), 'retry attempt did not start');
  assert.ok(log(h).some((e) => e.cmd === 'spawn retry' && e.task === 'T1'), 'retry event was recorded');
  const duringRetry = h.json(['spawn', '--task', 'T3', '--wait']);
  assert.equal(duringRetry.code, 0);
  assert.ok(fs.existsSync(path.join(home, 'bin', 'git')), 'a later spawn keeps the home while the retry is running');

  fs.writeFileSync(`${retryReady}.go`, '');
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'retry attempt did not finish');
  await until(() => !detachedAlive({ pid: started.monitor_pid }), 'supervisor did not finish queued hook writes');
  const audit = log(h).filter((e) => e.task === 'T1' && e.agent === started.agent);
  assert.ok(audit.some((e) => e.cmd === 'hook progress'), 'tool activity reached state');
  assert.equal(audit.findLast((e) => e.cmd === 'hook report')?.detail.report, `last report from ${started.agent}`);
  assert.equal(audit.findLast((e) => e.cmd === 'hook stop')?.detail.report, `last report from ${started.agent}`);
  assert.match(audit.find((e) => e.cmd === 'msg' && e.detail.to === 'orchestrator')?.detail.text || '', /without submit/);
});

test('a running process keeps its lease without claimant writes', async (t) => {
  const h = setup(t, { failures: 0, hold: 1800 });
  const clockFile = path.join(h.base, 'clock');
  const now = Date.now();
  fs.writeFileSync(clockFile, String(now));
  const spawned = h.json(['spawn', '--task', 'T1'], {
    env: { NODE_OPTIONS: `--require "${HOOKS.replace(/\\/g, '/')}"`, HOOK_CLOCK_FILE: clockFile },
  });
  await until(() => h.readAttempts().length === 1, 'worker did not claim');
  fs.writeFileSync(clockFile, String(now + 40000));
  await until(() => log(h).some((e) => e.cmd === 'renew'), 'live worker lease was not renewed');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.claim.since, h.readAttempts()[0].claim.since);
  assert.equal(task.claim.agent, spawned.agent);
  assert.ok(Date.parse(task.claim.until) > now + 60000);
  assert.equal(task.run.phase, 'running');
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'worker did not finish');
});

test('release during backoff fences the old supervisor from a replacement claim', async (t) => {
  const h = setup(t, { failures: 9, config: { backoff_ms: 1400, max_backoff_ms: 1400 } });
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'retrying', 'retry was not recorded');
  h.ok(['release', 'T1', '--agent', spawned.agent, '--reason', 'replace this run']);
  h.ok(['claim', 'T1', '--agent', 'replacement']);
  await until(() => !detachedAlive({ pid: spawned.monitor_pid }), 'released supervisor did not stop');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.claim.agent, 'replacement');
  assert.equal(task.run, null);
  assert.equal(h.readAttempts().length, 1);
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 0);
});

test('an expired previous claim does not stop supervision before a slow replacement claims', (t) => {
  const h = setup(t, { claimDelay: 350 });
  h.ok(['claim', 'T1', '--agent', 'previous-worker', '--lease', '1']);
  const previous = h.json(['task', 'show', 'T1']).claim;
  const clock = path.join(__dirname, 'fixtures', 'clock.js').replace(/\\/g, '/');
  const result = h.run(['spawn', '--task', 'T1', '--wait'], {
    env: { NODE_OPTIONS: `--require "${clock}"`, TOWER_CRANE_TEST_NOW: String(Date.parse(previous.until) + 1) },
    timeout: 15000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.readAttempts().length, 2);
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
  assert.equal(h.json(['task', 'show', 'T1']).claim.agent, 'worker-T1-1');
});

test('a permanent exit is blocked without retrying and submit clears its phase', (t) => {
  const h = setup(t, { failures: 9, error: '2' });
  assert.equal(h.spawn().code, 2);
  assert.equal(h.readAttempts().length, 1);
  assert.equal(h.json(['task', 'show', 'T1']).run.reason, 'exit 2');
  h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', 'abcdef1']);
  assert.equal(h.json(['task', 'show', 'T1']).run, null);
});

test('progress paths and CPU detect a stalled process without dropping its live claim', { skip: process.platform !== 'linux' }, async (t) => {
  const h = setup(t, { failures: 0, hold: 5000, config: { stall_ms: 250, progress_paths: ['progress.txt'] } });
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'blocked', 'idle process did not stall');
  assert.match(h.ok(['task', 'show', 'T1']), /blocked: no progress paths or CPU activity/);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /blocked: no progress paths or CPU activity/);
  fs.writeFileSync(path.join(spawned.cwd, 'progress.txt'), 'progress\n');
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'running', 'path progress did not clear stall');
  await until(() => !fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8').includes('blocked: no progress paths or CPU activity'),
    'saved board did not clear stall');
  assert.doesNotMatch(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /blocked: no progress paths or CPU activity/);
  assert.equal(h.json(['task', 'show', 'T1']).claim.agent, spawned.agent);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  await until(() => !detachedAlive({ pid: spawned.monitor_pid }), 'supervisor did not finish');
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

test('submitted-task reviewers resume transient exits and show their phase', (t) => {
  const h = setup(t, { claim: false });
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, 'test/value.test.js'], timeout: 30 })]);
  const rung = h.json(['ladder', 'show']).ladder.easy;
  h.ok(['ladder', 'set', 'review', '--harness', 'command', '--command', JSON.stringify(rung.command),
    '--supervision', JSON.stringify(rung.supervision), '--clear', 'profile', '--clear', 'effort']);
  h.ok(['claim', 'T1', '--agent', 'original-worker']);
  h.ok(['submit', 'T1', '--agent', 'original-worker', '--sha', sha]);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'fixture-gates');
  const result = h.spawn('review');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.readAttempts().length, 2);
  assert.equal(h.readAttempts()[0].agent, 'reviewer-T1-1');
  assert.equal(h.readAttempts()[1].agent, 'reviewer-T1-1');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.status, 'submitted');
  assert.equal(task.claim, null);
  assert.equal(task.run.phase, 'waiting');
  assert.match(h.ok(['status']), /T1 waiting/);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /reviewer-T1-1/);
});

test('a state-lock timeout preserves the pending retry without spending another attempt', async (t) => {
  const h = setup(t, { config: { retries: 1, backoff_ms: 5000, max_backoff_ms: 5000 } });
  h.json(['spawn', '--task', 'T1']);
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'retrying', 'retry was not scheduled');
  const paused = path.join(h.base, 'holder');
  const holder = h.runAsync(['task', 'note', 'T1', 'hold state lock'], { hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: paused } });
  try {
    await until(() => fs.existsSync(paused), 'holder did not acquire the lock');
    await new Promise((resolve) => setTimeout(resolve, 17000));
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    assert.equal((await holder).code, 0);
  }
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'pending retry was lost after lock timeout');
  assert.equal(h.readAttempts().length, 2);
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 1);
  assert.equal(h.readAttempts()[1].retry, '1');
});

test('rung supervision settings validate and clear through the CLI', (t) => {
  const h = setup(t);
  for (const config of [{ retries: -1 }, { backoff_ms: 0 }, { max_backoff_ms: 1 }, { progress_paths: ['../escape'] }, { typo: 1 }]) {
    assert.equal(h.run(['ladder', 'set', 'easy', '--supervision', JSON.stringify(config)]).code, 2);
  }
  h.ok(['ladder', 'set', 'easy', '--clear', 'supervision']);
  assert.equal(h.json(['ladder', 'show']).ladder.easy.supervision, undefined);
});

test('descendant CPU activity postpones stall while paths remain quiet', { skip: process.platform !== 'linux' }, async (t) => {
  const h = setup(t, { failures: 0, hold: 2500, busy: true, config: { stall_ms: 300 } });
  h.json(['spawn', '--task', 'T1']);
  await until(() => h.readAttempts().length === 1, 'CPU stub did not start');
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(log(h).filter((e) => e.cmd === 'stall').length, 0);
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'running');
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'CPU stub did not finish');
});

test('serve shows the recorded run phase on the board', async (t) => {
  const h = setup(t, { failures: 0 });
  assert.equal(h.spawn().code, 0);
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json'], { cwd: h.repo, env: h.env });
  const closed = new Promise((resolve) => server.on('close', resolve));
  let url;
  let output = '';
  server.stdout.on('data', (data) => {
    output += data;
    if (output.includes('\n')) url = JSON.parse(output.trim()).url;
  });
  try {
    await until(() => !!url || server.exitCode !== null, 'serve did not start');
    assert.ok(url);
    const body = await new Promise((resolve, reject) => {
      const request = http.get(url, (response) => {
        let html = '';
        response.on('data', (data) => { html += data; });
        response.on('end', () => resolve(html));
      });
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('serve request timed out')));
    });
    assert.match(body, /Phase/);
    assert.match(body, /waiting/);
  } finally {
    server.kill();
    await closed;
  }
});

for (const harness of ['claude', 'codex']) {
  test(`${harness} transient reruns follow the shared session policy and preserve route arguments`, (t) => {
    const h = setup(t);
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
    h.ok(['ladder', 'set', 'easy', '--harness', harness, '--clear', 'command',
      ...(harness === 'codex' ? ['--profile', 'chosen-profile'] : ['--model', 'chosen-model'])]);
    const stub = path.join(__dirname, 'fixtures', 'supervision-harness.js').replace(/\\/g, '/');
    const attemptsFile = path.join(h.base, 'harness-attempts.json');
    const result = h.run(['spawn', '--task', 'T1', '--wait'], {
      env: {
        PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
        NODE_OPTIONS: `--require "${stub}"`, TOWER_CRANE_TEST_SUPERVISION_FILE: attemptsFile,
      },
      timeout: 15000,
    });
    assert.equal(result.code, 0, result.stderr);
    const [first, second] = JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));
    assert.equal(first.agent, second.agent);
    if (harness === 'claude') {
      for (const flag of ['--permission-mode', '--tools', '--allowedTools', '--mcp-config']) {
        assert.ok(first.args.includes(flag));
        assert.equal(second.args[second.args.indexOf(flag) + 1], first.args[first.args.indexOf(flag) + 1], flag);
      }
      const id = first.args[first.args.indexOf('--session-id') + 1];
      assert.match(id, /^[a-f0-9-]{36}$/);
      assert.equal(second.args.includes('--resume'), false);
      const nextId = second.args[second.args.indexOf('--session-id') + 1];
      assert.match(nextId, /^[a-f0-9-]{36}$/);
      assert.notEqual(nextId, id);
      const prompt = second.args[second.args.indexOf('-p') + 1];
      assert.match(prompt, /Finish the task/);
      assert.match(prompt, /Previous attempt exited with (SIGTERM|exit 75); continue/);
      assert.equal(second.args[second.args.indexOf('--model') + 1], 'chosen-model');
      assert.equal(second.args.includes('--fork-session'), false);
    } else {
      for (const setting of ['default_permissions="tower-crane"', 'approval_policy="never"', 'web_search="disabled"']) {
        assert.ok(first.args.includes(setting));
        assert.ok(second.args.includes(setting), setting);
      }
      assert.ok(second.args.includes('resume'));
      assert.ok(second.args.includes('01a11297-1067-7831-a3bc-2c04eac9aaef'));
      assert.equal(second.args[second.args.indexOf('-p') + 1], 'chosen-profile');
      assert.ok(second.args.includes('Previous attempt exited with exit 75; continue.'));
      assert.equal(second.args.some((arg) => arg.includes('Finish the task')), false);
    }
    assert.equal(log(h).filter((e) => e.cmd === 'spawn').length, 1);
    assert.equal(log(h).filter((e) => e.cmd === 'claim').length, 1);
  });
}

for (const stream of ['stdout', 'stderr']) {
  test(`provider errors quoted in agent JSON on ${stream} do not trigger a rerun`, (t) => {
    const h = setup(t, { failures: 0 });
    const script = `
const cp = require('node:child_process');
cp.execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']);
const text = 'API Error: 503 service unavailable; provider outage; rate limit exceeded: The service is temporarily unavailable.; HTTP 429 Too Many Requests; overloaded';
console.${stream === 'stdout' ? 'log' : 'error'}(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: text } }));
console.${stream === 'stdout' ? 'log' : 'error'}(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
console.${stream === 'stdout' ? 'log' : 'error'}(JSON.stringify({ type: 'result', is_error: false, result: text }));
process.exit(1);
`;
    h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, BIN])]);
    const result = h.spawn();
    assert.equal(result.code, 1, result.stderr);
    assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 0);
    assert.equal(h.json(['task', 'show', 'T1']).run.reason, 'exit 1');
  });
}

for (const stream of ['stdout', 'stderr']) {
  test(`plain capacity text on ${stream} cannot substitute for a harness error envelope`, (t) => {
    const h = setup(t, { failures: 0 });
    const script = `
const cp = require('node:child_process');
cp.execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']);
console.${stream === 'stdout' ? 'log' : 'error'}('rate limit exceeded: The service is temporarily unavailable.; HTTP 429 Too Many Requests; overloaded');
process.exit(1);
`;
    h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, BIN])]);
    const result = h.spawn();
    assert.equal(result.code, 1, result.stderr);
    assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  });
}

test('quiet supervision samples state and progress paths on a seconds-scale interval', async (t) => {
  const h = setup(t, { failures: 0, hold: 3600, config: { progress_paths: ['progress.txt'] } });
  const audit = path.join(h.base, 'samples.jsonl');
  const hook = path.join(__dirname, 'fixtures', 'supervision-samples.js').replace(/\\/g, '/');
  h.json(['spawn', '--task', 'T1'], { env: {
    NODE_OPTIONS: `--require "${hook}"`, TOWER_CRANE_TEST_SAMPLES: audit,
  } });
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'quiet worker did not finish');
  const samples = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
  const walks = samples.filter((sample) => sample.kind === 'path');
  assert.ok(walks.length >= 2, JSON.stringify(samples));
  assert.ok(walks.length <= 6, `${walks.length} progress walks for a 3.6-second run`);
  assert.ok(samples.filter((sample) => sample.kind === 'state').length <= 8, 'quiet monitor repeatedly reloads state');
  for (let i = 1; i < walks.length; i++) assert.ok(walks[i].at - walks[i - 1].at >= 900, JSON.stringify(walks));
});

test('Windows natural exits do not send taskkill to an exited or reused pid', (t) => {
  const h = setup(t, { failures: 0 });
  const audit = path.join(h.base, 'taskkill.jsonl');
  const hook = path.join(__dirname, 'fixtures', 'windows-supervision.js').replace(/\\/g, '/');
  const result = h.run(['spawn', '--task', 'T1', '--wait'], { env: {
    NODE_OPTIONS: `--require "${hook}"`, TOWER_CRANE_TEST_TASKKILL: audit,
  } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(audit), false, 'taskkill can target a new process after the harness pid is released');
});

test('stopping the monitor terminates the process group and kills children that ignore SIGTERM', {
  skip: process.platform === 'win32' && 'POSIX process groups',
}, async (t) => {
  const h = setup(t, { failures: 0 });
  const pids = path.join(h.base, 'group.json');
  const terminated = path.join(h.base, 'terminated');
  const script = `
const cp = require('node:child_process');
const fs = require('node:fs');
cp.execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']);
process.on('SIGTERM', () => fs.writeFileSync(process.argv[3] + '.parent', 'parent'));
const descendant = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM', () => require('node:fs').writeFileSync(process.argv[1], 'child')); console.log('ready'); setInterval(() => {}, 1000);", process.argv[3] + '.child'], { stdio: ['ignore', 'pipe', 'inherit'] });
descendant.stdout.once('data', () => fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, descendant.pid])));
setInterval(() => {}, 1000);
`;
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, BIN, pids, terminated])]);
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(() => fs.existsSync(pids), 'process group did not start');
  const group = JSON.parse(fs.readFileSync(pids, 'utf8'));
  t.after(() => {
    try { process.kill(-group[0], 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  });
  process.kill(spawned.monitor_pid, 'SIGTERM');
  await until(() => fs.existsSync(terminated + '.parent') && fs.existsSync(terminated + '.child'), 'stop did not send SIGTERM before SIGKILL');
  await until(() => group.every((pid) => !detachedAlive({ pid })), 'stop left a process group member alive');
  await until(() => !detachedAlive({ pid: spawned.monitor_pid }), 'stopped monitor survived');
  assert.equal(fs.readFileSync(terminated + '.parent', 'utf8'), 'parent');
  assert.equal(fs.readFileSync(terminated + '.child', 'utf8'), 'child');
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  assert.equal(h.json(['task', 'show', 'T1']).run.reason, 'supervisor stopped by SIGTERM');
});

test('a rerun waits for previous descendants even when they close their output pipes', {
  skip: process.platform !== 'linux' && 'Linux process state',
}, (t) => {
  const h = setup(t, { failures: 0 });
  const groupFile = path.join(h.base, 'previous-group.json');
  const script = `
const cp = require('node:child_process');
const fs = require('node:fs');
const file = process.argv[2];
if (!fs.existsSync(file)) {
  cp.execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']);
  const child = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.once('data', () => {
    child.stdout.destroy();
    fs.writeFileSync(file, JSON.stringify({ parent: process.pid, child: child.pid }));
    process.exit(75);
  });
} else {
  const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    const stat = fs.readFileSync('/proc/' + prior.child + '/stat', 'utf8');
    if (!['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])) process.exit(2);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  process.exit(0);
}
`;
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, BIN, groupFile])]);
  let group;
  t.after(() => {
    if (!group) return;
    try { process.kill(-group.parent, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  });
  const result = h.spawn();
  group = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 1);
});

test('foreground output is durable while the dispatch CLI is blocked rendering', async (t) => {
  const h = setup(t, { error: 'outage', claim: false });
  const paused = path.join(h.base, 'render-paused');
  const completed = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], { hooks: { HOOK_STOP_RENDER: paused } });
  let result;
  try {
    await until(() => fs.existsSync(paused), 'dispatch did not pause after committing its spawn');
    await until(() => h.readAttempts().length === 1, 'harness did not emit its result');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const spawned = log(h).find((e) => e.cmd === 'spawn').detail;
    assert.match(fs.readFileSync(spawned.log, 'utf8'), /503 service unavailable/);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    result = await completed;
  }
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.readAttempts().length, 2);
});

test('job transport preserves briefs that fit a harness argument', (t) => {
  const h = setup(t, { failures: 0 });
  const rung = h.json(['ladder', 'show']).ladder.easy;
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([...rung.command, '{prompt}'])]);
  const size = process.platform === 'win32' ? 14 * 1024 : 50 * 1024;
  h.ok(['brief', 'set', 'T1', '-'], { input: 'x'.repeat(size) });
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.readAttempts().length, 1);
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

test('rework cannot resume a session while its transient rerun is still alive', async (t) => {
  const h = setup(t, { hold: 2500, sessionReceipt: true });
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(() => h.readAttempts().length === 2, 'transient rerun did not start');
  h.ok(['submit', 'T1', '--agent', spawned.agent, '--sha', 'abcdef1']);
  h.ok(['rework', 'T1', '--reason', 'review correction']);
  const result = h.run(['spawn', '--task', 'T1']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /previous worker.*still running/);
  await until(() => !detachedAlive({ pid: spawned.monitor_pid }), 'previous supervisor did not finish');
});
