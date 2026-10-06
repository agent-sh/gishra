'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const { makeRepo, BIN, HOOKS, detachedAlive } = require('./helpers');

const log = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

async function until(fn, message) {
  const deadline = Date.now() + 12000;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function setup(t, { failures = 1, error = '75', hold = 0, config = {}, env = {}, busy = false, claimDelay = 0, claim = true, sessionReceipt = false } = {}) {
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
    ${['signal', 'interrupt'].includes(error) ? `process.kill(process.pid, '${error === 'signal' ? 'SIGTERM' : 'SIGINT'}');`
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

for (const error of ['75', 'outage', 'server', 'status-json', 'signal', 'interrupt']) {
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
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /retrying 1/);
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
  const h = setup(t, { failures: 0, hold: 2500, config: { stall_ms: 250, progress_paths: ['progress.txt'] } });
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'blocked', 'idle process did not stall');
  assert.match(h.ok(['task', 'show', 'T1']), /blocked: no progress paths or CPU activity/);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /blocked: no progress paths or CPU activity/);
  fs.writeFileSync(path.join(spawned.cwd, 'progress.txt'), 'progress\n');
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'running', 'path progress did not clear stall');
  assert.doesNotMatch(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /blocked: no progress paths or CPU activity/);
  assert.equal(h.json(['task', 'show', 'T1']).claim.agent, spawned.agent);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  await until(() => !detachedAlive({ pid: spawned.monitor_pid }), 'supervisor did not finish');
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

test('submitted-task reviewers resume transient exits and show their phase', (t) => {
  const h = setup(t, { claim: false });
  const rung = h.json(['ladder', 'show']).ladder.easy;
  h.ok(['ladder', 'set', 'review', '--harness', 'command', '--command', JSON.stringify(rung.command),
    '--supervision', JSON.stringify(rung.supervision), '--clear', 'profile', '--clear', 'effort']);
  h.ok(['claim', 'T1', '--agent', 'original-worker']);
  h.ok(['submit', 'T1', '--agent', 'original-worker', '--sha', 'abcdef1']);
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
  test(`${harness} transient reruns use its exact session and route arguments`, (t) => {
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
      const id = first.args[first.args.indexOf('--session-id') + 1];
      assert.match(id, /^[a-f0-9-]{36}$/);
      assert.equal(second.args[second.args.indexOf('--resume') + 1], id);
      assert.equal(second.args[second.args.indexOf('--model') + 1], 'chosen-model');
      assert.equal(second.args.includes('--fork-session'), false);
    } else {
      assert.ok(second.args.includes('resume'));
      assert.ok(second.args.includes('01a11297-1067-7831-a3bc-2c04eac9aaef'));
      assert.equal(second.args[second.args.indexOf('-p') + 1], 'chosen-profile');
    }
    assert.equal(log(h).filter((e) => e.cmd === 'spawn').length, 1);
    assert.equal(log(h).filter((e) => e.cmd === 'claim').length, 1);
  });
}

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
