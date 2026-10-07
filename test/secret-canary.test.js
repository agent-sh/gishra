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
    const r = s.spawn(['--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.keys(JSON.parse(r.stdout).route.env), ['ROUTE', 'TC_RUNG_SECRET']);
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

// Runs the real claude or codex CLI, so it costs a model call and needs a
// logged-in harness: set TOWER_CRANE_LIVE_CLAUDE=1 or TOWER_CRANE_LIVE_CODEX=1
// (TOWER_CRANE_LIVE_MODEL and TOWER_CRANE_LIVE_PROFILE pick the model). Run it
// outside any agent sandbox. A holder agent keeps canaries in its environment
// while the real agent, in its own sandbox, tries to read the holder's
// /proc environ and cmdline, its home and a full process listing; then the
// real agent's transcripts, sessions and every other file are scanned.
for (const harness of ['claude', 'codex']) {
  const flag = `TOWER_CRANE_LIVE_${harness.toUpperCase()}`;
  test(`live ${harness}: another agent's sandbox cannot read a running agent's environment or home, and the run leaks no canary`, {
    skip: process.env[flag] !== '1' ? `set ${flag}=1 to run against the real ${harness} CLI` : process.platform !== 'linux' && 'reads /proc',
    timeout: 300000,
  }, async (t) => {
    const h = makeRepo(t);
    h.init();
    h.ok(['task', 'add', '--title', 'Holder', '--acceptance', 'holds secrets']);
    h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'probe runs']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'holder' });
    const c = canary.make(['rung', 'project', 'file', 'holder', 'gh']);
    const tmp = path.join(h.base, 'tmp');
    const results = path.join(h.base, 'results');
    fs.mkdirSync(tmp);
    fs.mkdirSync(results);
    const envFile = path.join(h.base, 'secrets.env');
    fs.writeFileSync(envFile, `TC_FILE_SECRET=${c.file}\n`, { mode: 0o600 });
    h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [results] }), '--env', JSON.stringify({ TC_PROJECT_SECRET: c.project }), '--env_file', envFile]);
    const holder = path.join(h.base, 'holder.js');
    fs.writeFileSync(holder, `require(${JSON.stringify(HARNESS)})('command');\n`);
    h.ok(['ladder', 'set', 'research', '--harness', 'command', '--command', JSON.stringify([process.execPath, holder]), '--clear', 'model', '--clear', 'profile', '--clear', 'effort', '--clear', 'args',
      '--env', JSON.stringify({ ROUTE: 'holder', TC_HOLDER_SECRET: c.holder })]);
    const out = path.join(h.base, 'holder.jsonl');
    const held = h.run(['spawn', '--task', 'T1', '--role', 'research'], { env: { ...h.env, TMPDIR: tmp, CANARY_OUT: out, CANARY_MODE: 'hold',
      CANARY_VARS: 'TC_HOLDER_SECRET,TC_PROJECT_SECRET,TC_FILE_SECRET' } });
    assert.equal(held.code, 0, held.stderr);
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(`${out}.ready`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const holderSpawn = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .findLast((e) => e.cmd === 'spawn' && e.task === 'T1').detail;
    const monitor = { pid: holderSpawn.monitor_pid, startTicks: holderSpawn.monitor_start_ticks };
    t.after(async () => {
      try { process.kill(monitor.pid, 'SIGTERM'); } catch { /* already gone */ }
      const stop = Date.now() + 30000;
      while (detachedAlive(monitor) && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const holderHome = path.join(h.state, 'homes', holderSpawn.agent);
    assert.ok(fs.existsSync(holderHome), 'the holder has a home');
    const result = path.join(results, 'probe.json');
    const probe = path.join(h.base, 'probe.js');
    fs.writeFileSync(probe, [
      "'use strict';",
      'const fs = require("node:fs"), cp = require("node:child_process");',
      'const out = {};',
      `for (const pid of ${JSON.stringify([Number(fs.readFileSync(`${out}.ready`, 'utf8')), monitor.pid])}) {`,
      '  for (const f of ["environ", "cmdline"]) {',
      '    try { out[`${pid}/${f}`] = fs.readFileSync(`/proc/${pid}/${f}`, "latin1"); } catch (e) { out[`${pid}/${f}`] = `ERR ${e.code}`; }',
      '  }',
      '}',
      `try { out.home = fs.readdirSync(${JSON.stringify(holderHome)}); } catch (e) { out.home = \`ERR \${e.code}\`; }`,
      'const ps = cp.spawnSync("ps", ["-eww", "-o", "pid=,args="], { encoding: "utf8" });',
      'out.ps = ps.status === 0 ? ps.stdout : `ERR ${ps.error?.code || ps.status}`;',
      `fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify(out));`,
      'console.log("probe done");', '',
    ].join('\n'));
    h.ok(['brief', 'set', 'T2', '-'], {
      input: `This task is a live secret-isolation fixture set up by the owner. Run exactly this command with your command tool, then report its exit code and stop. Do not read the script or its result, print environment variables, change files, use tower-crane, open a PR or delegate work.\n\n${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}\n`,
    });
    h.ok(['ladder', 'set', 'small', '--harness', harness,
      ...(harness === 'codex' ? ['--profile', process.env.TOWER_CRANE_LIVE_PROFILE || 'sol', '--clear', 'model'] : ['--model', process.env.TOWER_CRANE_LIVE_MODEL || 'opus', '--clear', 'profile']),
      '--clear', 'effort', '--supervision', '{"retries":0}', '--env', JSON.stringify({ TC_RUNG_SECRET: c.rung })]);
    const r = await h.runAsync(['spawn', '--task', 'T2', '--role', 'small', '--wait'], { env: { TMPDIR: tmp, GH_TOKEN: c.gh } });
    assert.equal(r.code, 0, r.stderr);
    const seen = JSON.parse(fs.readFileSync(result, 'utf8'));
    assert.match(String(seen.home), /^ERR /, 'the holder home is readable from the other agent\'s sandbox');
    const agent = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .findLast((e) => e.cmd === 'spawn' && e.task === 'T2').detail.agent;
    const transcripts = harness === 'claude' ? path.join(h.state, 'homes', agent, 'projects') : path.join(h.state, 'homes', '.codex', agent, 'sessions');
    assert.ok(fs.existsSync(transcripts) && fs.readdirSync(transcripts).length, `${transcripts} holds the agent's transcript`);
    canary.assertNoHits([
      ...canary.scanTree([h.base, path.join(require('../lib/agents').origin(process.env).home, '.cache', 'tower-crane')], c, [path.join(h.state, 'project.json'), envFile]),
      ...canary.scanText(r.stdout + r.stderr + held.stdout + held.stderr, c, 'spawn output'),
    ], `a live ${harness} run, its transcripts or another agent's probe`);
  });
}
