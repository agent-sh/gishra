'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, real } = require('./helpers');

function setup(t) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Idempotency key on retries', '--acceptance', 'processed once', '--acceptance', 'test proves it']);
  h.ok(['brief', 'set', 'T1', '-'], { input: '- start from the webhook handler\n' });
  return h;
}

const dry = (h, role, env) => h.json(['spawn', '--role', role, '--task', 'T1', '--dry-run'], { env });

test('worktree creates the task branch from base and is idempotent', (t) => {
  const h = setup(t);
  const first = h.json(['worktree', 'T1']);
  const expected = path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');
  assert.equal(real(first.path), real(expected));
  assert.equal(first.branch, 'gishra/T1-idempotency-key-on-retries');
  assert.equal(first.created, true);
  assert.equal(h.git(['rev-parse', '--abbrev-ref', 'HEAD'], first.path), first.branch);
  assert.equal(h.git(['rev-parse', 'HEAD'], first.path), h.git(['rev-parse', 'main']));
  assert.equal(h.readState('tasks.json').tasks[0].branch, first.branch);

  h.ok(['task', 'update', 'T1', '--title', 'Renamed task']);
  const again = h.json(['worktree', 'T1']);
  assert.equal(again.created, false);
  assert.equal(real(again.path), real(first.path));
  assert.equal(h.ok(['worktree', 'T1']), again.path);
});

test('spawn --dry-run builds each harness command', (t) => {
  const h = setup(t);
  const cases = [
    [['--harness', 'claude', '--model', 'claude-opus-5-5'], (p) => ['claude', '-p', p, '--model', 'claude-opus-5-5', '--output-format', 'json']],
    [['--harness', 'claude', '--effort', 'high'], (p) => ['claude', '-p', p, '--effort', 'high', '--output-format', 'json']],
    [['--harness', 'codex', '--profile', 'sol'], (p) => ['codex', 'exec', '-p', 'sol', p]],
    [['--harness', 'codex', '--model', 'gpt-x', '--effort', 'high', '--args', '["--skip-git-repo-check"]'], (p) => ['codex', 'exec', '-m', 'gpt-x', '-c', 'model_reasoning_effort=high', p, '--skip-git-repo-check']],
    [['--harness', 'opencode'], (p) => ['opencode', 'run', p]],
    [['--harness', 'opencode', '--model', 'anthropic/claude'], (p) => ['opencode', 'run', '-m', 'anthropic/claude', p]],
    [['--harness', 'agy'], (p) => ['agy', '-p', p, '--mode', 'accept-edits']],
    [['--harness', 'agy', '--model', 'gemini-3-pro', '--effort', 'max', '--args', '["--output-format","json"]'], (p) => ['agy', '-p', p, '--mode', 'accept-edits', '--model', 'gemini-3-pro', '--effort', 'max', '--output-format', 'json']],
    [['--harness', 'pi'], (p) => ['pi', '-p', p]],
    [['--harness', 'pi', '--model', 'openai/gpt-5.5', '--provider', 'openai', '--effort', 'xhigh', '--args', '["--no-session"]'], (p) => ['pi', '-p', p, '--model', 'openai/gpt-5.5', '--provider', 'openai', '--thinking', 'xhigh', '--no-session']],
  ];
  const empty = path.join(h.base, 'no-plugin');
  fs.mkdirSync(empty);
  for (const [flags, expected] of cases) {
    h.ok(['role', 'set', 'small', ...flags]);
    const out = dry(h, 'small', { GISHRA_PLUGIN_ROOT: empty });
    const prompt = out.argv.find((a) => a.includes('## Task'));
    assert.ok(prompt, `prompt present for ${flags.join(' ')}`);
    assert.deepEqual(out.argv, expected(prompt), flags.join(' '));
  }
  const out = dry(h, 'small');
  assert.equal(out.agent, 'small-T1-1');
  assert.deepEqual(Object.keys(out.env).sort(), ['GISHRA_AGENT', 'GISHRA_STATE', 'GISHRA_TASK']);
  assert.equal(out.env.GISHRA_AGENT, 'small-T1-1');
  assert.equal(out.env.GISHRA_TASK, 'T1');
  assert.equal(real(out.env.GISHRA_STATE), real(h.state));
  assert.equal(out.worktree_exists, false);
  assert.ok(!fs.existsSync(path.join(h.base, 'repo-worktrees')), 'a dry run creates nothing');
});

test('the prompt is the brief, then the task, then how to use gishra', (t) => {
  const h = setup(t);
  h.ok(['role', 'set', 'worker', '--harness', 'opencode']);
  const p = dry(h, 'worker').argv[2];
  assert.ok(p.startsWith('\n- start from the webhook handler'), 'a leading dash is not read as a flag');
  const iBrief = p.indexOf('start from the webhook handler');
  const iTask = p.indexOf('"acceptance": [');
  const iUse = p.indexOf('Use the gishra CLI for every state change');
  assert.ok(iBrief < iTask && iTask < iUse, 'brief, task JSON, instruction in order');
  const json = JSON.parse(p.slice(p.indexOf('```json\n') + 8, p.indexOf('\n```', p.indexOf('```json'))));
  assert.deepEqual(json, { id: 'T1', title: 'Idempotency key on retries', acceptance: ['processed once', 'test proves it'], kind: 'code' });
  assert.match(p, /GISHRA_STATE, GISHRA_TASK and GISHRA_AGENT are set/);
});

test('pi roles load the gishra skill for workers and reviewers when it is installed', (t) => {
  const h = setup(t);
  const plugin = path.join(h.base, 'plugin');
  for (const s of ['gishra-work', 'gishra-review']) fs.mkdirSync(path.join(plugin, 'skills', s), { recursive: true });
  const env = { GISHRA_PLUGIN_ROOT: plugin };
  for (const role of ['worker', 'reviewer', 'small']) h.ok(['role', 'set', role, '--harness', 'pi', '--model', 'm']);
  const at = (argv) => argv.slice(argv.indexOf('--skill'));
  assert.deepEqual(at(dry(h, 'worker', env).argv), ['--skill', path.join(plugin, 'skills', 'gishra-work')]);
  assert.deepEqual(at(dry(h, 'reviewer', env).argv), ['--skill', path.join(plugin, 'skills', 'gishra-review')]);
  assert.ok(!dry(h, 'small', env).argv.includes('--skill'), 'other roles get no skill');
  const missing = path.join(h.base, 'empty-plugin');
  fs.mkdirSync(missing);
  assert.ok(!dry(h, 'worker', { GISHRA_PLUGIN_ROOT: missing }).argv.includes('--skill'), 'no skill when it is not installed');
});

test('role validation names the valid harnesses and rejects gemini', (t) => {
  const h = setup(t);
  const r = h.run(['role', 'set', 'worker', '--harness', 'gemini']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /claude, codex, opencode, agy, pi, command/);
  const p = h.readState('project.json');
  p.roles.worker = { harness: 'gemini', model: 'x' };
  h.writeState('project.json', p);
  const load = h.run(['status']);
  assert.equal(load.code, 1);
  assert.match(load.stderr, /role worker: harness must be one of claude, codex, opencode, agy, pi, command/);

  const h2 = setup(t);
  assert.equal(h2.run(['role', 'set', 'x', '--harness', 'claude', '--profile', 'p']).code, 2);
  assert.equal(h2.run(['role', 'set', 'x', '--harness', 'codex', '--provider', 'p']).code, 2);
  assert.equal(h2.run(['role', 'set', 'x', '--harness', 'command']).code, 2);
  assert.equal(h2.run(['role', 'set', 'x', '--harness', 'pi', '--args', '"--x"']).code, 2);
  assert.equal(h2.run(['spawn', '--role', 'ghost', '--task', 'T1', '--dry-run']).code, 1);
});

test('spawn --wait runs the command role in the task worktree with the gishra environment', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'seen.json');
  const script = 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), task: process.argv[2], brief: process.argv[3], cwdArg: process.argv[4], prompt: process.argv[5], env: { s: process.env.GISHRA_STATE, t: process.env.GISHRA_TASK, a: process.env.GISHRA_AGENT } })); process.exit(7)';
  h.ok(['role', 'set', 'runner', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, out, '{task}', '{brief}', '{cwd}', 'P:{prompt}'])]);
  const r = h.run(['spawn', '--role', 'runner', '--task', 'T1', '--wait']);
  assert.equal(r.code, 7, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  const wt = path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');
  assert.equal(real(seen.cwd), real(wt));
  assert.equal(real(seen.cwdArg), real(wt));
  assert.equal(seen.task, 'T1');
  assert.equal(real(seen.brief), real(path.join(h.state, 'briefs', 'T1.md')));
  assert.match(seen.prompt, /^P:\n- start from the webhook handler/);
  assert.deepEqual([real(seen.env.s), seen.env.t, seen.env.a], [real(h.state), 'T1', 'runner-T1-1']);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const spawnEv = events.find((e) => e.cmd === 'spawn');
  assert.equal(spawnEv.detail.agent, 'runner-T1-1');
  assert.ok(Number.isInteger(spawnEv.detail.pid));
  assert.equal(events.find((e) => e.cmd === 'spawn exit').detail.code, 7);
});

test('spawn in the background detaches, logs output and numbers agents', async (t) => {
  const h = setup(t);
  h.ok(['role', 'set', 'runner', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', 'console.log("hello from " + process.env.GISHRA_AGENT)'])]);
  const started = h.json(['spawn', '--role', 'runner', '--task', 'T1']);
  assert.equal(started.agent, 'runner-T1-1');
  assert.ok(Number.isInteger(started.pid));
  assert.equal(real(path.dirname(started.log)), real(path.join(h.state, 'logs')));
  assert.equal(path.basename(started.log), 'T1-runner-T1-1.log');
  const deadline = Date.now() + 10000;
  while (!(fs.existsSync(started.log) && fs.readFileSync(started.log, 'utf8').includes('hello'))) {
    if (Date.now() > deadline) throw new Error('the background agent wrote nothing to its log');
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(fs.readFileSync(started.log, 'utf8'), /hello from runner-T1-1/);
  assert.equal(h.json(['spawn', '--role', 'runner', '--task', 'T1', '--dry-run']).agent, 'runner-T1-2');

  h.ok(['role', 'set', 'ghost', '--harness', 'command', '--command', '["gishra-no-such-program"]']);
  const missing = h.run(['spawn', '--role', 'ghost', '--task', 'T1']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /could not start gishra-no-such-program/);
  h.ok(['task', 'add', '--title', 'No brief', '--acceptance', 'x']);
  const noBrief = h.run(['spawn', '--role', 'runner', '--task', 'T2', '--dry-run']);
  assert.equal(noBrief.code, 1);
  assert.match(noBrief.stderr, /T2 has no brief; write one with gishra brief set T2/);
});

// Everything a spawn could leave behind: state files, events, logs, the
// worktree and its branch.
function footprint(h) {
  const read = (f) => (fs.existsSync(path.join(h.state, f)) ? fs.readFileSync(path.join(h.state, f), 'utf8') : null);
  return {
    tasks: read('tasks.json'),
    events: read('events.jsonl'),
    logs: fs.existsSync(path.join(h.state, 'logs')) ? fs.readdirSync(path.join(h.state, 'logs')) : null,
    worktrees: fs.existsSync(path.join(h.base, 'repo-worktrees')),
    branches: h.git(['branch', '--list', 'gishra/*']),
  };
}

test('a spawn refused for a missing program creates and writes nothing', (t) => {
  const h = setup(t);
  for (const command of [['gishra-no-such-program', '{prompt}'], [path.join(h.base, 'missing', 'agent')]]) {
    h.ok(['role', 'set', 'ghost', '--harness', 'command', '--command', JSON.stringify(command)]);
    const before = footprint(h);
    assert.equal(h.readState('tasks.json').tasks[0].branch, null);
    for (const mode of [[], ['--wait']]) {
      const r = h.run(['spawn', '--role', 'ghost', '--task', 'T1', ...mode]);
      assert.equal(r.code, 1, r.stderr);
      assert.deepEqual(footprint(h), before, `${command[0]} ${mode.join(' ')}`);
      assert.ok(r.stderr.includes(`could not start ${command[0]}: no executable file by that name`), r.stderr);
    }
  }
});

test('a spawn whose program fails to start undoes the worktree it made', (t) => {
  const h = setup(t);
  h.ok(['role', 'set', 'runner', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)'])]);
  const before = footprint(h);
  for (const mode of [[], ['--wait']]) {
    const r = h.run(['spawn', '--role', 'runner', '--task', 'T1', ...mode], { hooks: { HOOK_SPAWN_FAIL: '1' } });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /could not start/);
    assert.deepEqual(footprint(h), before, mode.join(' ') || 'background');
  }
  // An existing worktree is the task's own and stays.
  const wt = h.json(['worktree', 'T1']).path;
  const r = h.run(['spawn', '--role', 'runner', '--task', 'T1'], { hooks: { HOOK_SPAWN_FAIL: '1' } });
  assert.equal(r.code, 1, r.stderr);
  assert.ok(fs.existsSync(wt), 'the worktree made by gishra worktree is kept');
});
