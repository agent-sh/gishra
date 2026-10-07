'use strict';

// A spawn with a unique secret in the rung env, the project env, an env_file
// and the harness credentials leaves that secret nowhere but the files the
// owner configured it in: not in the state directory, homes, logs, events,
// briefs, the worktree, the spawn cache, temp files, output or any process
// listing, on success, a harness crash, a fallback switch and a supervisor
// stop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeRepo, detachedAlive } = require('./helpers');
const canary = require('./canary');

const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';
const HARNESS = path.join(__dirname, 'fixtures', 'canary-harness.js');
const CREDENTIAL = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY' };
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

function setup(t, harness, mode) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Canary', '--acceptance', 'no leaks']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'canary probe' });
  const c = canary.make(['rung', 'project', 'file', 'fallback', 'gh', 'credential', 'credentialFile']);
  const home = path.join(h.base, 'user-home');
  const tmp = path.join(h.base, 'tmp');
  const bin = path.join(h.base, 'bin');
  for (const d of [path.join(home, '.codex'), path.join(home, '.claude'), tmp, bin]) fs.mkdirSync(d, { recursive: true });
  const sources = [path.join(home, '.codex', 'auth.json'), path.join(home, '.claude', '.credentials.json'), path.join(home, 'secrets.env')];
  fs.writeFileSync(sources[0], JSON.stringify({ OPENAI_API_KEY: c.credentialFile }));
  fs.writeFileSync(sources[1], JSON.stringify({ claudeAiOauth: { accessToken: c.credentialFile } }));
  fs.writeFileSync(sources[2], `TC_FILE_SECRET=${c.file}\n`);
  fs.writeFileSync(path.join(bin, harness), `#!${process.execPath}\nrequire(${JSON.stringify(HARNESS)})(${JSON.stringify(harness)});\n`, { mode: 0o755 });
  const route = harness === 'codex' ? { profile: 'sol' } : { model: 'opus' };
  h.ok(['ladder', 'set', 'medium', '--harness', harness,
    ...(harness === 'codex' ? ['--profile', 'sol', '--clear', 'model'] : ['--model', 'opus', '--clear', 'profile']),
    '--clear', 'effort', '--clear', 'args', '--supervision', '{"retries":0,"backoff_ms":1}',
    '--env', JSON.stringify({ ROUTE: 'primary', TC_RUNG_SECRET: c.rung }),
    '--fallbacks', JSON.stringify([{ harness, ...route, env: { ROUTE: 'fallback', TC_FALLBACK_SECRET: c.fallback } }])]);
  h.ok(['project', 'set', '--env', JSON.stringify({ TC_PROJECT_SECRET: c.project }), '--env_file', '~/secrets.env']);
  const out = path.join(h.base, 'canary.jsonl');
  const env = {
    ...h.env, HOME: home, USERPROFILE: home, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '',
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: tmp, TOWER_CRANE_TMP: tmp,
    GH_TOKEN: c.gh, [CREDENTIAL[harness]]: c.credential, CANARY_OUT: out, CANARY_MODE: mode,
    CANARY_VARS: ['TC_RUNG_SECRET', 'TC_PROJECT_SECRET', 'TC_FILE_SECRET', 'TC_FALLBACK_SECRET', 'GH_TOKEN', CREDENTIAL[harness]].join(','),
  };
  delete env.XDG_CACHE_HOME;
  const spawn = (args) => h.run(['spawn', '--task', 'T1', ...args], { env, hooks: { HOOK_KEEP_SPAWN_DIRS: '1' } });
  // The configured sources: the ladder and project env live in project.json.
  const allow = [path.join(h.state, 'project.json'), ...sources];
  const reports = () => fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const expected = (names) => Object.fromEntries(['TC_RUNG_SECRET', 'TC_PROJECT_SECRET', 'TC_FILE_SECRET', 'TC_FALLBACK_SECRET', 'GH_TOKEN', CREDENTIAL[harness]]
    .map((n) => [n, names.includes(n) ? sha({ TC_RUNG_SECRET: c.rung, TC_PROJECT_SECRET: c.project, TC_FILE_SECRET: c.file,
      TC_FALLBACK_SECRET: c.fallback, GH_TOKEN: c.gh, [CREDENTIAL[harness]]: c.credential }[n]) : null]));
  const primary = expected(['TC_RUNG_SECRET', 'TC_PROJECT_SECRET', 'TC_FILE_SECRET', 'GH_TOKEN', CREDENTIAL[harness]]);
  const fallback = expected(['TC_FALLBACK_SECRET', 'TC_PROJECT_SECRET', 'TC_FILE_SECRET', 'GH_TOKEN', CREDENTIAL[harness]]);
  const noLeaks = (...outputs) => {
    const cache = path.join(home, '.cache', 'tower-crane');
    assert.ok(fs.readdirSync(cache).some((d) => fs.existsSync(path.join(cache, d, 'job.json'))), 'the kept job file is scanned');
    canary.assertNoHits([
      ...canary.scanTree(h.base, c, allow),
      ...outputs.flatMap((o, i) => canary.scanText(o, c, `spawn output ${i}`)),
    ], `files or output after a ${harness} ${mode} run`);
  };
  return { h, c, out, spawn, reports, primary, fallback, noLeaks };
}

for (const harness of ['claude', 'codex']) {
  test(`${harness}: a finished run leaves the canaries only in their sources and never in a process listing`, { skip: NO_STUBS }, (t) => {
    const s = setup(t, harness, 'ok');
    const r = s.spawn(['--wait']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(s.reports(), [{ harness, route: 'primary', hashes: s.primary, listed: [] }]);
    s.noLeaks(r.stdout, r.stderr);
  });

  test(`${harness}: a harness crash leaves no canary in logs, receipts or events`, { skip: NO_STUBS }, (t) => {
    const s = setup(t, harness, 'crash');
    const r = s.spawn(['--wait']);
    assert.notEqual(r.code, 0);
    assert.deepEqual(s.reports().map((x) => x.listed), [[]]);
    s.noLeaks(r.stdout, r.stderr);
  });

  test(`${harness}: a fallback switch gives the fallback route its own secret and leaks none`, { skip: NO_STUBS }, (t) => {
    const s = setup(t, harness, 'fallback');
    const r = s.spawn(['--wait']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(s.reports(), [
      { harness, route: 'primary', hashes: s.primary, listed: [] },
      { harness, route: 'fallback', hashes: s.fallback, listed: [] },
    ]);
    s.noLeaks(r.stdout, r.stderr);
  });

  test(`${harness}: a supervisor stopped while the agent runs leaves no canary`, { skip: NO_STUBS }, async (t) => {
    const s = setup(t, harness, 'hold');
    const r = s.spawn([]);
    assert.equal(r.code, 0, r.stderr);
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(`${s.out}.ready`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(`${s.out}.ready`), 'the agent started');
    canary.assertNoHits(canary.scanText(canary.processListing(), s.c, 'the process listing'), 'a process listing');
    const started = fs.readFileSync(path.join(s.h.state, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.cmd === 'spawn').detail;
    const monitor = { pid: started.monitor_pid, startTicks: started.monitor_start_ticks };
    process.kill(monitor.pid, 'SIGTERM');
    const stopped = Date.now() + 30000;
    while (detachedAlive(monitor) && Date.now() < stopped) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(detachedAlive(monitor), false, 'the supervisor stopped');
    assert.deepEqual(s.reports().map((x) => x.listed), [[]]);
    s.noLeaks(r.stdout, r.stderr);
  });
}
