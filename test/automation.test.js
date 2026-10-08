'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { shellQuote } = require('../lib/gates/common');

const ghStub = path.join(__dirname, 'fixtures', 'automation-gh.js');
const harness = path.join(__dirname, 'fixtures', 'automation-harness.js');

function setup(t, { kind = 'code', ci = 'success' } = {}) {
  const h = makeRepo(t);
  h.sha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  const tools = path.join(h.base, 'tools');
  fs.writeFileSync(path.join(tools, 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(ghStub)});\n`);
  fs.chmodSync(path.join(tools, 'gh'), 0o755);
  delete h.env.NODE_OPTIONS;
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(tools, 'gh.cmd'), `@"${process.execPath}" "${ghStub}" %*\r\n`);
    const preload = path.join(h.base, 'offline-gh.js');
    // Windows cannot spawn a .cmd directly. Resolve PATH first so agent
    // policy shims still run before the offline GitHub executable.
    fs.writeFileSync(preload, `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),run=cp.spawnSync;
cp.spawnSync=(cmd,args,opts)=>{
  if(cmd!=='gh')return run(cmd,args,opts);
  const env=opts?.env||process.env;
  for(const dir of String(env.PATH||env.Path||'').split(path.delimiter)){
    for(const ext of ['.exe','.cmd','.bat']){
      const file=path.join(dir,cmd+ext);
      if(!fs.existsSync(file))continue;
      if(ext==='.exe')return run(file,args,opts);
      const quoted=[file,...args].map(arg=>'"'+String(arg).replace(/"/g,'""')+'"').join(' ');
      return run(env.ComSpec||env.COMSPEC||'cmd.exe',['/d','/s','/c','"'+quoted+'"'],
        {...opts,windowsVerbatimArguments:true});
    }
  }
  return run(cmd,args,opts);
};\n`);
    h.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  }
  h.env.AUTOMATION_GITHUB = path.join(h.base, 'github.json');
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.saveGithub({ root: h.repo, prs: { 7: {
    state: 'OPEN', headRefOid: h.sha, headRefName: 'fixture-change',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main',
  } }, ci: { [h.sha]: ci } });
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', kind]);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Change\n\nImplement the acceptance.\n' });
  h.submit = (id = 'T1', sha = h.sha, pr = '7') => {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', sha, '--pr', pr, '--agent', 'worker']);
  };
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

test('submission runs real software gates once through the existing waiter', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  assert.equal(h.consume().code, 2);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true], ['ci', false]]);
  assert.ok(task.evidence.every((e) => e.commands.length && e.source === `check ${e.type}`));
  assert.equal(task.status, 'submitted');
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 3, 'duplicate event delivery runs no gate twice');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0, 'pending CI starts no model');
});

test('CI completion refreshes a pending or failed receipt at the exact head and merges after review', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const bad = h.github();
  bad.ci[h.sha] = 'failure';
  h.saveGithub(bad);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  const good = h.github();
  good.ci[h.sha] = 'success';
  h.saveGithub(good);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => e.ok), [false, false, true]);
  assert.equal(task.evidence.at(-1).type, 'merge');
  const calls = h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'merge');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--match-head-commit') + 1], h.sha);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', 'fffffff', '--agent', 'orchestrator']).code, 1);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'worker']).code, 1);
});

test('an accepted task with green gates merges in the event reaction without an agent turn', (t) => {
  const h = setup(t);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const notification = JSON.parse(h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']));
  assert.equal(notification.type, 'merged', 'startup catches up accepted PRs and retains its automatic merge event');
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1);
});

test('a merge sends another conflicting PR to rework with real filenames and preserves its worktree', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'conflicting change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: other, headRefName: 'other-change' };
  github.advanceBase = true;
  h.saveGithub(github);
  h.submit('T2', other, '8');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const before = h.git(['status', '--porcelain']);
  h.consume();
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', 'T2.md'), 'utf8'), /value\.js/);
  assert.equal(h.git(['status', '--porcelain']), before);
  assert.equal(h.git(['rev-parse', 'HEAD']), other);
  assert.equal(fs.readFileSync(path.join(h.repo, 'value.js'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('startup reconciles a newly conflicting PR after a merge happened without a waiter', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.consume();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'other submitted change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const state = h.github();
  state.prs['8'] = { ...state.prs['7'], headRefOid: other, headRefName: 'other-change' };
  h.saveGithub(state);
  h.submit('T2', other, '8');
  h.consume();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[1].status, 'submitted');
  const ci = h.logs().findLast((e) => e.cmd === 'check ci' && e.task === 'T2');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && e.detail.source === ci.id && e.detail.phase === 'done'));

  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const changed = h.github();
  changed.advanceBase = true;
  h.saveGithub(changed);
  h.ok(['merge', 'T1', '--agent', 'orchestrator']);
  const conflicting = h.github();
  conflicting.prs['8'].mergeable = 'CONFLICTING';
  conflicting.prs['8'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  const before = h.git(['rev-parse', 'HEAD']);
  const event = JSON.parse(h.ok(['wait', '--types', 'rework', '--timeout', '5', '--agent', 'orchestrator']));
  assert.equal(event.task, 'T2');
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /value\.js/);
  assert.equal(h.git(['rev-parse', 'HEAD']), before);
});

test('a matching UNKNOWN head runs submission gates during the same wait', async (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
  state.becomeMergeableAfterView = true;
  h.saveGithub(state);
  const result = await h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0.2', '--agent', 'orchestrator']);
  assert.equal(result.code, 2, result.stderr);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => ['tests', 'clean'].includes(e.type)).map((e) => [e.type, e.ok]),
    [['tests', true], ['clean', true]]);
  assert.equal(task.status, 'submitted');
  assert.equal(h.github().prs['7'].mergeable, 'MERGEABLE');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  const unknown = h.github();
  unknown.prs['7'].mergeable = unknown.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(unknown);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted',
    'UNKNOWN still blocks acceptance even with earlier passing CI and independent review');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('startup retains gate evidence when main moves and the submitted head stays mergeable', (t) => {
  const h = setup(t);
  h.submit();
  h.consume();
  const before = h.readState('tasks.json').tasks[0].evidence;
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-qm', 'advance main']);
  h.consume();
  const after = h.json(['task', 'show', 'T1']);
  assert.deepEqual(after.evidence, before);
  assert.ok(after.gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
});

test('stale or unknown PR heads and missing review never merge', (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 0);
  state.prs['7'].headRefOid = h.sha;
  state.prs['7'].mergeable = 'UNKNOWN';
  state.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  state.prs['7'].mergeable = 'MERGEABLE';
  state.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted', 'green software gates still require independent review');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a completion webhook is only a hint, rejects another repository and ignores stale heads', (t) => {
  const h = setup(t, { kind: 'docs', ci: 'failure' });
  h.submit();
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const payload = { repository: { full_name: 'acme/demo' }, action: 'completed',
    check_suite: { head_sha: h.sha, status: 'completed', conclusion: 'success' } };
  const deliver = () => h.run(['ci', 'webhook', '-', '--agent', 'orchestrator'], { input: JSON.stringify(payload) });
  assert.equal(deliver().code, 0);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false, 'GitHub failure wins over payload success');
  payload.repository.full_name = 'acme/other';
  assert.equal(deliver().code, 1);
  payload.repository.full_name = 'acme/demo';
  payload.check_suite.head_sha = 'a'.repeat(40);
  assert.deepEqual(JSON.parse(h.ok(['ci', 'webhook', '-', '--json', '--agent', 'orchestrator'],
    { input: JSON.stringify(payload) })).tasks, []);
  payload.check_suite.head_sha = h.sha;
  const state = h.github();
  state.ci[h.sha] = 'success';
  h.saveGithub(state);
  assert.equal(deliver().code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('concurrent event consumers execute each submission gate only once', async (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const results = await Promise.all([
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
  ]);
  assert.ok(results.every((r) => r.code === 2), JSON.stringify(results));
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci']);
});

for (const reason of ['unknown mergeability', 'transport error']) {
  test(`startup retries ${reason} without a new lifecycle event`, (t) => {
    const h = setup(t, { kind: 'docs' });
    h.submit();
    h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    const state = h.github();
    if (reason === 'transport error') state.failView = true;
    else state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
    h.saveGithub(state);
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase,
      reason === 'transport error' ? 'error' : 'deferred');
    const recovered = h.github();
    recovered.failView = false;
    recovered.prs['7'].mergeable = 'MERGEABLE';
    recovered.prs['7'].mergeStateStatus = 'CLEAN';
    h.saveGithub(recovered);
    h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).type, 'merge');
    assert.equal(h.github().prs['7'].state, 'MERGED');
  });
}

test('startup confirms the accepted head after the executor dies between remote merge and receipt', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const crash = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { AUTOMATION_CRASH_AFTER_MERGE: '1' } });
  assert.notEqual(crash.code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'), false);
  assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase, 'running');
  h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']);
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.sha, h.sha);
  assert.equal(receipt.ref, h.sha);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1, 'confirmation does not repeat the remote merge');
});

test('a remotely merged different head produces failed merge evidence', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const state = h.github();
  state.prs['7'].state = 'MERGED';
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, false);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
});

function configureHarness(h, { rules = false } = {}) {
  const home = path.join(h.base, 'home');
  fs.mkdirSync(home, { recursive: true });
  Object.assign(h.env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), XDG_CACHE_HOME: path.join(home, '.cache'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), npm_config_cache: path.join(home, 'npm'),
    GH_TOKEN: 'automation-fixture', STUB_RUN: '[]',
    AUTOMATION_CONTEXT_DIR: path.join(h.base, 'context'),
  });
  fs.mkdirSync(h.env.AUTOMATION_CONTEXT_DIR);
  if (rules) fs.writeFileSync(path.join(h.base, 'AGENTS.md'), 'Read the acceptance before changing code.\n');
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  for (const rung of ['easy', 'review']) h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
    JSON.stringify([process.execPath, harness, BIN, 'auto', '{prompt}']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((f) => ['--clear', f])]);
}

function startupContexts(h, withRules) {
  const startups = h.logs().filter((e) => e.cmd === 'startup');
  assert.deepEqual(startups.map((e) => e.detail.role), ['worker', 'reviewer']);
  for (const { task, detail } of startups) {
    const report = JSON.parse(fs.readFileSync(path.join(h.env.AUTOMATION_CONTEXT_DIR, `${detail.agent}.json`), 'utf8'));
    assert.equal(report.harness, 'command');
    assert.equal(report.args[2], report.prompt, 'the shared stub records the delivered argument');
    assert.match(report.prompt, /^## Goal\n/);
    assert.ok(report.prompt.includes(`Project goal: ${detail.goal}`));
    const target = JSON.parse(/## Task\s+```json\n([\s\S]*?)\n```/.exec(report.prompt)[1]);
    assert.equal(target.id, task);
    assert.equal(target.title, detail.target.title);
    assert.equal(target.acceptance.length, detail.target.acceptance);
    assert.equal(detail.receives_prompt, true);
    assert.equal(detail.prompt_bytes, Buffer.byteLength(report.prompt));
    assert.equal(detail.prompt_tokens, Math.ceil(detail.prompt_bytes / 4));
    assert.equal(report.prompt.includes('## House rules'), withRules);
    if (withRules) {
      assert.ok(detail.rules.some((r) => r.path === path.join(h.base, 'AGENTS.md') && r.loaded === 'read'));
      for (const rule of detail.rules) assert.ok(report.prompt.includes(rule.path));
    } else {
      assert.deepEqual(detail.rules, []);
      assert.equal(detail.rules_bytes, 0);
      assert.equal(detail.rules_tokens, 0);
    }
  }
}

test('a worker identity cannot authorize reactions by passing the orchestrator name', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const result = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { TOWER_CRANE_AGENT: 'worker', TOWER_CRANE_TASK: 'T1' } });
  assert.equal(result.code, 2);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
});

test('supervisor reactions pin unconfigured gates and bypass the real restrictive agent shims', async (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node test/value.test.js' } }));
  h.git(['add', 'package.json']);
  h.git(['commit', '-qm', 'detectable test command']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  h.saveGithub(state);
  h.ok(['project', 'set', '--tests-cmd', 'null', '--clean-cmd', 'null']);
  configureHarness(h);
  h.env.AUTOMATION_POLICY_PROBE = path.join(h.base, 'policy-probe.jsonl');
  h.ok(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  const deadline = Date.now() + 60000;
  while (!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok)) {
    if (Date.now() > deadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const pins = h.logs().filter((e) => e.cmd === 'gates pin');
  assert.deepEqual(pins.map((e) => e.detail.key), ['tests_cmd', 'clean_cmd']);
  assert.ok(pins.every((e) => e.agent === 'orchestrator' && e.detail.authority === 'orchestrator'));
  const probes = fs.readFileSync(h.env.AUTOMATION_POLICY_PROBE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((p) => p.denials.every((d) => d.status === 126 && /not allowed/.test(d.stderr))), JSON.stringify(probes));
  assert.ok(probes.every((p) => p.path.includes(path.join(h.state, 'homes'))));
  startupContexts(h, false);
});

test('review dispatch hands revuto findings to the reviewer and an ok that ignores a P1 is refused', async (t) => {
  const h = setup(t);
  configureHarness(h);
  const state = h.github();
  const comment = (id, body, extra = {}) => ({ id, in_reply_to_id: null, path: 'src.js', line: 3, original_line: 3, body,
    user: 'revuto-review[bot]', original_commit_id: h.sha, html_url: `https://github.com/acme/demo/pull/7#discussion_r${id}`, ...extra });
  state.comments = [
    comment(101, '[P1] The loop never terminates on empty input.'),
    comment(102, '[P2] Missing null check.'),
    { ...comment(103, 'Fixed by the guard above.'), in_reply_to_id: 102, user: 'worker' },
    comment(104, 'Nit: rename this.'),
    comment(105, '[P1] Outdated finding.', { line: null }),
    comment(106, '[P1] Not from revuto.', { user: 'someone' }),
  ];
  h.saveGithub(state);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  const deadline = Date.now() + 60000;
  while (!h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.role === 'reviewer')) {
    if (Date.now() > deadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.severity, f.reply]), [[101, 'P1', null], [102, 'P2', 103], [104, null, null]]);
  const brief = fs.readFileSync(path.join(h.state, 'reviews', `T1-${h.sha}.md`), 'utf8');
  assert.match(brief, /## Revuto findings/);
  assert.match(brief, /### \[P1\] src\.js:3 \(comment 101\)\n\n\[P1\] The loop never terminates on empty input\./);
  assert.match(brief, /### \[P2\] src\.js:3 \(comment 102, answered in 103\)/);
  assert.match(brief, /### src\.js:3 \(comment 104\)/);
  assert.doesNotMatch(brief, /Outdated finding|Not from revuto/);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.evidence.some((e) => e.type === 'review'), false, 'the reviewer ok was refused');
  assert.equal(task.status, 'submitted');
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', review.detail.agent]);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 101 at src\.js:3 \(https:\/\/github\.com\/acme\/demo\/pull\/7#discussion_r101\)/);
  assert.doesNotMatch(refused.stderr, /comment 10[2-6]/);
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--fail', '--agent', review.detail.agent]);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('brokered review evidence clears a revuto finding whose file changed since the comment', async (t) => {
  const h = setup(t);
  configureHarness(h);
  const state = h.github();
  const before = h.git(['rev-parse', `${h.sha}^`]);
  const comment = (id, commit) => ({ id, in_reply_to_id: null, path: 'value.js', line: 1, original_line: 1, body: `[P1] finding ${id}`,
    user: 'revuto-review[bot]', original_commit_id: commit, html_url: null });
  // value.js changed between before and the head; nothing changed after the head.
  state.comments = [comment(201, before), comment(202, h.sha)];
  h.saveGithub(state);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  const deadline = Date.now() + 60000;
  while (!h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.role === 'reviewer')) {
    if (Date.now() > deadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.changed]), [[201, true], [202, false]]);
  // The state broker runs evidence with TOWER_CRANE_VIA=broker, where tower-crane reads no repository.
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 202 at value\.js:1 has no code change/);
  assert.doesNotMatch(refused.stderr, /comment 201/);
});

test('a supervised worker submission runs gates and dispatches the offline reviewer after exit', async (t) => {
  const h = setup(t);
  configureHarness(h, { rules: true });
  const hold = path.join(h.base, 'worker-hold');
  const spawned = h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'],
    { env: { AUTOMATION_WORKER_HOLD: hold } });
  const deadline = Date.now() + 60000;
  try {
    while (!fs.existsSync(hold)) {
      if (Date.now() > deadline) throw new Error('worker did not submit');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 0,
      'a worker still running after submit blocks review dispatch');
  } finally {
    fs.writeFileSync(`${hold}.go`, '');
    assert.equal((await spawned).code, 0);
  }
  // Reviewer completion has its own CLI command deadline after worker exit.
  const reviewDeadline = Date.now() + 60000;
  while (!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok)) {
    if (Date.now() > reviewDeadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const events = h.logs();
  const review = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const exit = events.findIndex((e) => e.cmd === 'spawn exit' && e.detail.role === 'worker');
  assert.ok(review > exit);
  const workerStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'worker');
  const worker = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
  const reviewStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'reviewer');
  assert.ok(workerStartup >= 0 && workerStartup < worker && worker < exit);
  assert.ok(reviewStartup > exit && reviewStartup < review);
  startupContexts(h, true);
  assert.equal(events.filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

// A second PR that touches other files, and a suite command that logs each
// run with PR #7's state at that moment.
function queueFixture(t) {
  const h = setup(t);
  h.git(['switch', '-qc', 'second-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'other.js'), 'module.exports = 2;\n');
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'test', 'other.test.js'), "require('node:assert/strict').equal(require('../other'), 2);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'second change']);
  h.second = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'works']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: h.second, headRefName: 'second-change' };
  github.ci[h.second] = 'success';
  h.saveGithub(github);
  h.suiteLog = path.join(h.base, 'suites.jsonl');
  const suite = path.join(h.base, 'suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs'), path = require('node:path');
const gh = JSON.parse(fs.readFileSync(${JSON.stringify(h.env.AUTOMATION_GITHUB)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(h.suiteLog)}, JSON.stringify({ pr7: gh.prs['7'].state }) + '\\n');
// One run moves main while it runs, as another merge landing would.
if (fs.existsSync(${JSON.stringify(path.join(h.base, 'move-main-once'))})) {
  fs.rmSync(${JSON.stringify(path.join(h.base, 'move-main-once'))});
  const git = (a) => require('node:child_process').execFileSync('git', ['-C', ${JSON.stringify(h.repo)}, ...a], { encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/heads/main', git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'lands during the check'])]);
}
// Another CLI acting while the suite runs.
const during = ${JSON.stringify(path.join(h.base, 'during-check.js'))};
if (fs.existsSync(during)) {
  const script = during + '.ran';
  fs.renameSync(during, script);
  require(script);
}
for (const f of fs.readdirSync('test')) if (f.endsWith('.test.js')) require(path.resolve('test', f));
`);
  h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} ${shellQuote(suite)}`]);
  h.suites = () => (fs.existsSync(h.suiteLog)
    ? fs.readFileSync(h.suiteLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  h.moveMain = (file = 'README.md', text = 'Independent base update.\n') => {
    h.git(['switch', '-q', 'main']);
    fs.appendFileSync(path.join(h.repo, file), text);
    h.git(['add', file]);
    h.git(['commit', '-qm', 'advance main']);
  };
  h.submit();
  h.submit('T2', h.second, '8');
  h.consume();
  for (const id of ['T1', 'T2']) {
    const gates = h.json(['task', 'show', id]).gates.gates;
    assert.ok(gates.filter((g) => g.type !== 'review').every((g) => g.ok), JSON.stringify(gates));
  }
  return h;
}

const headChecks = (h) => h.logs().filter((e) => e.cmd === 'head check');
const softwareEvidence = (h, id) => h.readState('tasks.json').tasks.find((x) => x.id === id).evidence
  .filter((e) => ['tests', 'clean', 'ci'].includes(e.type));

function acceptBoth(h) {
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['evidence', 'T2', '--type', 'review', '--sha', h.second, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  h.ok(['accept', 'T2', '--agent', 'orchestrator']);
}

test('main moves: a mergeable PR keeps its evidence and merges after one head-of-line check', (t) => {
  const h = queueFixture(t);
  const before = softwareEvidence(h, 'T1');
  h.moveMain();
  const suites = h.suites().length;
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.deepEqual(softwareEvidence(h, 'T1'), before, 'a base move reruns no gate and resets no evidence');
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.suites().length - suites, 1);
  const checks = headChecks(h);
  assert.deepEqual(checks.map((e) => [e.task, e.detail.ok, e.detail.base_sha]), [['T1', true, h.git(['rev-parse', 'main'])]]);
  assert.ok(checks[0].detail.commands.some((c) => c.args.includes('merge')));
  h.consume();
  assert.equal(headChecks(h).length, 1, 'a repeated reaction does not run the suite again');
});

test('the head of the line that turns CONFLICTING goes to rework with its files and the next PR merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const github = h.github();
  github.prs['7'].mergeable = 'CONFLICTING';
  github.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(github);
  h.consume();
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.match(t1.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.equal(h.github().prs['7'].state, 'OPEN');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.deepEqual(headChecks(h).map((e) => e.task), ['T2']);
});

test('two queued PRs run exactly one full suite each at their turn and none before', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  h.moveMain();
  const suites = h.suites().length;
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  blocked.advanceBase = true;
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.suites().length, suites, 'nothing runs while the head of the line waits');
  assert.equal(headChecks(h).length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false, 'the second PR does not jump the line');
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(stopped.detail.blocked.task, 'T1');
  assert.match(stopped.detail.blocked.reason, /mergeability of PR #7 is UNKNOWN/);

  const ready = h.github();
  ready.prs['7'].mergeable = 'MERGEABLE';
  ready.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(ready);
  h.ok(['wait', '--types', 'merged', '--task', 'T2', '--timeout', '10', '--agent', 'orchestrator']);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['7', '8']);
  assert.deepEqual(h.suites().slice(suites), [{ pr7: 'OPEN' }, { pr7: 'MERGED' }],
    'T1 runs its suite before merging; T2 runs its suite only after T1 merged');
  assert.deepEqual(headChecks(h).map((e) => [e.task, e.detail.ok]), [['T1', true], ['T2', true]]);
  assert.equal(headChecks(h)[1].detail.base_sha, h.sha, 'T2 is checked against main after T1 landed');
});

test('a base that moves during the head check gets a new check before the merge', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  fs.writeFileSync(path.join(h.base, 'move-main-once'), '');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  const checks = headChecks(h);
  assert.equal(checks.length, 2, 'the check against the old base does not authorize the merge');
  assert.notEqual(checks[0].detail.base_sha, checks[1].detail.base_sha);
  assert.equal(checks[1].detail.base_sha, h.git(['rev-parse', 'main']));
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('a head replaced during its check is checked again at the new sha before the merge', (t) => {
  const h = queueFixture(t);
  h.git(['switch', '-q', 'fixture-change']);
  fs.writeFileSync(path.join(h.repo, 'NOTES.md'), 'Replacement head.\n');
  h.git(['add', 'NOTES.md']);
  h.git(['commit', '-qm', 'replacement head']);
  const replacement = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.moveMain();
  // Rework, resubmit and reaccept T1 at a new head while its suite runs.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process'), fs = require('node:fs');
const env = ${JSON.stringify(h.env)};
const cli = (...a) => cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, ...a], { cwd: ${JSON.stringify(h.repo)}, env, encoding: 'utf8' });
const file = env.AUTOMATION_GITHUB;
cli('rework', 'T1', '--reason', 'replace the head', '--agent', 'orchestrator');
const gh = JSON.parse(fs.readFileSync(file, 'utf8'));
gh.prs['7'].headRefOid = ${JSON.stringify(replacement)};
gh.ci[${JSON.stringify(replacement)}] = 'success';
fs.writeFileSync(file, JSON.stringify(gh));
cli('claim', 'T1', '--agent', 'worker');
cli('submit', 'T1', '--sha', ${JSON.stringify(replacement)}, '--pr', '7', '--agent', 'worker');
for (const gate of ['tests', 'clean', 'ci']) cli('check', gate, 'T1', '--agent', 'orchestrator');
cli('evidence', 'T1', '--type', 'review', '--sha', ${JSON.stringify(replacement)}, '--ok', '--agent', 'reviewer');
cli('accept', 'T1', '--agent', 'orchestrator');
`);
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the replacement ran during the check');
  assert.deepEqual(headChecks(h).map((e) => [e.detail.sha, e.detail.ok]), [[h.sha, true], [replacement, true]],
    'the check of the old head does not authorize merging the new one');
  const merges = h.github().calls.filter((a) => a[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.equal(merges[0][merges[0].indexOf('--match-head-commit') + 1], replacement);
  const order = h.logs().filter((e) => e.cmd === 'head check' || e.cmd === 'merge').map((e) => e.cmd);
  assert.deepEqual(order, ['head check', 'head check', 'merge']);
});

test('a head that stops the line and then goes to rework lets the PR behind it merge', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done').detail.blocked.task, 'T1');
  assert.equal(h.github().prs['8'].state, 'OPEN');

  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const conflicting = h.github();
  conflicting.prs['7'].mergeable = 'CONFLICTING';
  conflicting.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
});

test('a head check that fails after its settings changed checks again under the current settings', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  const cmd = h.readState('project.json').gates.tests_cmd;
  // The suite fails, but only after another CLI replaced the tests command.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process');
cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'project', 'set', '--tests-cmd', ${JSON.stringify(`${cmd} again`)}, '--agent', 'orchestrator'],
  { cwd: ${JSON.stringify(h.repo)}, env: ${JSON.stringify(h.env)}, encoding: 'utf8' });
process.exitCode = 1;
`);
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the settings changed during the check');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted', 'the stale failure sends nothing to rework');
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.match(stopped.detail.blocked.reason, /tests evidence command policy/, 'the line restarted on the current command');

  h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  h.consume();
  assert.deepEqual(headChecks(h).map((e) => [e.detail.command, e.detail.ok]), [[cmd, false], [`${cmd} again`, true]]);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});
