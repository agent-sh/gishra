'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, real, BIN, PTY_AVAILABLE } = require('./helpers');

function setup(t) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Idempotency key on retries', '--acceptance', 'processed once', '--acceptance', 'test proves it']);
  h.ok(['brief', 'set', 'T1', '-'], { input: '- start from the webhook handler\n' });
  return h;
}

const dry = (h, rung, env) => h.json(['spawn', ...(rung ? ['--role', rung] : []), '--task', 'T1', '--dry-run'], { env });

const FIELDS = ['harness', 'model', 'profile', 'provider', 'effort', 'args', 'command'];

// Sets a rung to exactly these flags: every field they leave out is cleared.
function setRung(h, rung, flags) {
  const given = flags.filter((f) => f.startsWith('--')).map((f) => f.slice(2));
  h.ok(['ladder', 'set', rung, ...flags, ...FIELDS.filter((k) => !given.includes(k)).flatMap((k) => ['--clear', k])]);
}

const commandRung = (h, rung, argv) => setRung(h, rung, ['--harness', 'command', '--command', JSON.stringify(argv)]);

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
    [['--harness', 'claude', '--model', 'opus', '--effort', 'high'], (p) => ['claude', '-p', p, '--model', 'opus', '--effort', 'high', '--output-format', 'json']],
    [['--harness', 'codex', '--profile', 'sol'], (p) => ['codex', 'exec', '-p', 'sol', p]],
    [['--harness', 'codex', '--model', 'gpt-x', '--effort', 'high', '--args', '["--skip-git-repo-check"]'], (p) => ['codex', 'exec', '-m', 'gpt-x', '-c', 'model_reasoning_effort=high', p, '--skip-git-repo-check']],
    [['--harness', 'opencode', '--model', 'anthropic/claude'], (p) => ['opencode', 'run', '-m', 'anthropic/claude', p]],
    [['--harness', 'opencode', '--model', 'openai/gpt-x', '--effort', 'high'], (p) => ['opencode', 'run', '-m', 'openai/gpt-x', '--variant', 'high', p]],
    [['--harness', 'agy', '--model', 'gemini-3-pro'], (p) => ['agy', '-p', p, '--mode', 'accept-edits', '--model', 'gemini-3-pro']],
    [['--harness', 'agy', '--model', 'gemini-3-pro', '--effort', 'max', '--args', '["--output-format","json"]'], (p) => ['agy', '-p', p, '--mode', 'accept-edits', '--model', 'gemini-3-pro', '--effort', 'max', '--output-format', 'json']],
    [['--harness', 'pi', '--model', 'openai/gpt-5.5'], (p) => ['pi', '-p', p, '--model', 'openai/gpt-5.5']],
    [['--harness', 'pi', '--model', 'openai/gpt-5.5', '--provider', 'openai', '--effort', 'xhigh', '--args', '["--no-session"]'], (p) => ['pi', '-p', p, '--model', 'openai/gpt-5.5', '--provider', 'openai', '--thinking', 'xhigh', '--no-session']],
  ];
  const empty = path.join(h.base, 'no-plugin');
  fs.mkdirSync(empty);
  for (const [flags, expected] of cases) {
    setRung(h, 'small', flags);
    const out = dry(h, 'small', { GISHRA_PLUGIN_ROOT: empty });
    const prompt = out.argv.find((a) => a.includes('## Task'));
    assert.ok(prompt, `prompt present for ${flags.join(' ')}`);
    assert.deepEqual(out.argv, expected(prompt), flags.join(' '));
  }
  const out = dry(h, 'small');
  assert.equal(out.agent, 'small-T1-1');
  assert.equal(out.rung, 'small');
  assert.deepEqual(Object.keys(out.env).sort(), ['GISHRA_AGENT', 'GISHRA_STATE', 'GISHRA_TASK']);
  assert.equal(out.env.GISHRA_AGENT, 'small-T1-1');
  assert.equal(out.env.GISHRA_TASK, 'T1');
  assert.equal(real(out.env.GISHRA_STATE), real(h.state));
  assert.equal(out.worktree_exists, false);
  assert.ok(!fs.existsSync(path.join(h.base, 'repo-worktrees')), 'a dry run creates nothing');
});

test('the prompt is the brief, then the task, then how to use gishra', (t) => {
  const h = setup(t);
  setRung(h, 'medium', ['--harness', 'opencode', '--model', 'a/b']);
  const p = dry(h).argv[4];
  assert.ok(p.startsWith('\n- start from the webhook handler'), 'a leading dash is not read as a flag');
  const iBrief = p.indexOf('start from the webhook handler');
  const iTask = p.indexOf('"acceptance": [');
  const iUse = p.indexOf('Use the gishra CLI for every state change');
  assert.ok(iBrief < iTask && iTask < iUse, 'brief, task JSON, instruction in order');
  const json = JSON.parse(p.slice(p.indexOf('```json\n') + 8, p.indexOf('\n```', p.indexOf('```json'))));
  assert.deepEqual(json, { id: 'T1', title: 'Idempotency key on retries', acceptance: ['processed once', 'test proves it'], kind: 'code' });
  assert.match(p, /GISHRA_STATE, GISHRA_TASK and GISHRA_AGENT are set/);
  assert.ok(p.includes('you are not the owner; never pass --agent owner'));
  assert.ok(p.endsWith('run gishra with --agent worker-T1-1 if GISHRA_AGENT is missing.'));
});

test('a spawned reviewer that loses all GISHRA variables cannot record evidence as owner', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'lost-agent.json');
  const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const env = { ...process.env };
const agent = env.GISHRA_AGENT;
const task = env.GISHRA_TASK;
const state = env.GISHRA_STATE;
for (const key of Object.keys(env)) if (key.startsWith('GISHRA_')) delete env[key];
const r = cp.spawnSync(process.execPath, [process.argv[1], 'evidence', 'T1', '--type', 'review', '--ok', '--sha', 'abcdef1', '--state', state], {
  env, encoding: 'utf8', timeout: 10000,
});
fs.writeFileSync(process.argv[2], JSON.stringify({ agent, task, remaining: Object.keys(env).filter((key) => key.startsWith('GISHRA_')), code: r.status, stderr: r.stderr }));
process.exit(r.status === null ? 1 : r.status);
`;
  commandRung(h, 'review', [process.execPath, '-e', script, BIN, out]);
  const r = h.run(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
  assert.equal(r.code, 2, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(seen, {
    agent: 'reviewer-T1-1',
    task: 'T1',
    remaining: [],
    code: 2,
    stderr: 'gishra: no agent: pass --agent NAME or set GISHRA_AGENT\n',
  });
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.cmd === 'evidence'));
});

test('a spawned reviewer losing all GISHRA variables in a terminal cannot clear owner work', { skip: !PTY_AVAILABLE }, (t) => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Owner action', '--acceptance', 'approved', '--needs-owner', 'approve access']);
  const out = path.join(h.base, 'lost-agent-terminal.json');
  const script = `
const fs = require('node:fs');
const { runPty } = require(process.argv[1]);
const env = { ...process.env };
const agent = env.GISHRA_AGENT;
const task = env.GISHRA_TASK;
const state = env.GISHRA_STATE;
for (const key of Object.keys(env)) if (key.startsWith('GISHRA_')) delete env[key];
const r = runPty(['owner-done', 'T2', '--state', state], { cwd: process.cwd(), env });
fs.writeFileSync(process.argv[2], JSON.stringify({ agent, task, remaining: Object.keys(env).filter((key) => key.startsWith('GISHRA_')), ...r }));
process.exit(r.code === null ? 99 : r.code);
`;
  commandRung(h, 'review', [process.execPath, '-e', script, require.resolve('./helpers'), out]);
  const r = h.run(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
  assert.equal(r.code, 1, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(seen.agent, 'reviewer-T1-1');
  assert.equal(seen.task, 'T1');
  assert.deepEqual(seen.remaining, []);
  assert.equal(seen.code, 1, seen.stdout + seen.stderr);
  assert.match(seen.stdout, /only the owner/);
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.needs_owner, 'approve access');
  assert.deepEqual(task.notes, []);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.cmd === 'owner-done'));
});

test('pi rungs load the gishra skill for workers and reviewers when it is installed', (t) => {
  const h = setup(t);
  const plugin = path.join(h.base, 'plugin');
  for (const s of ['gishra-work', 'gishra-review']) fs.mkdirSync(path.join(plugin, 'skills', s), { recursive: true });
  const env = { GISHRA_PLUGIN_ROOT: plugin };
  for (const rung of ['easy', 'medium', 'review', 'small']) setRung(h, rung, ['--model', 'm']);
  h.ok(['ladder', 'harness', 'pi']);
  const at = (argv) => argv.slice(argv.indexOf('--skill'));
  assert.deepEqual(at(dry(h, 'medium', env).argv), ['--skill', path.join(plugin, 'skills', 'gishra-work')]);
  assert.deepEqual(at(dry(h, 'easy', env).argv), ['--skill', path.join(plugin, 'skills', 'gishra-work')]);
  assert.deepEqual(at(dry(h, 'review', env).argv), ['--skill', path.join(plugin, 'skills', 'gishra-review')]);
  assert.ok(!dry(h, 'small', env).argv.includes('--skill'), 'other rungs get no skill');
  const missing = path.join(h.base, 'empty-plugin');
  fs.mkdirSync(missing);
  assert.ok(!dry(h, 'medium', { GISHRA_PLUGIN_ROOT: missing }).argv.includes('--skill'), 'no skill when it is not installed');
});

test('spawn --wait runs the command rung in the task worktree with the gishra environment', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'seen.json');
  const script = 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), task: process.argv[2], brief: process.argv[3], cwdArg: process.argv[4], prompt: process.argv[5], env: { s: process.env.GISHRA_STATE, t: process.env.GISHRA_TASK, a: process.env.GISHRA_AGENT } })); process.exit(7)';
  commandRung(h, 'medium', [process.execPath, '-e', script, out, '{task}', '{brief}', '{cwd}', 'P:{prompt}']);
  const r = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(r.code, 7, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  const wt = path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');
  assert.equal(real(seen.cwd), real(wt));
  assert.equal(real(seen.cwdArg), real(wt));
  assert.equal(seen.task, 'T1');
  assert.equal(real(seen.brief), real(path.join(h.state, 'briefs', 'T1.md')));
  assert.match(seen.prompt, /^P:\n- start from the webhook handler/);
  assert.deepEqual([real(seen.env.s), seen.env.t, seen.env.a], [real(h.state), 'T1', 'worker-T1-1']);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const spawnEv = events.find((e) => e.cmd === 'spawn');
  assert.equal(spawnEv.detail.agent, 'worker-T1-1');
  assert.equal(spawnEv.detail.rung, 'medium');
  assert.ok(Number.isInteger(spawnEv.detail.pid));
  assert.equal(events.find((e) => e.cmd === 'spawn exit').detail.code, 7);
});

test('spawn in the background detaches, logs output and numbers agents', async (t) => {
  const h = setup(t);
  commandRung(h, 'small', [process.execPath, '-e', 'console.log("hello from " + process.env.GISHRA_AGENT)']);
  const started = h.json(['spawn', '--role', 'small', '--task', 'T1']);
  assert.equal(started.agent, 'small-T1-1');
  assert.ok(Number.isInteger(started.pid));
  assert.equal(real(path.dirname(started.log)), real(path.join(h.state, 'logs')));
  assert.equal(path.basename(started.log), 'T1-small-T1-1.log');
  const deadline = Date.now() + 10000;
  while (!(fs.existsSync(started.log) && fs.readFileSync(started.log, 'utf8').includes('hello'))) {
    if (Date.now() > deadline) throw new Error('the background agent wrote nothing to its log');
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(fs.readFileSync(started.log, 'utf8'), /hello from small-T1-1/);
  assert.equal(h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run']).agent, 'small-T1-2');

  commandRung(h, 'review', ['gishra-no-such-program']);
  const missing = h.run(['spawn', '--role', 'review', '--task', 'T1']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /could not start gishra-no-such-program/);
  h.ok(['task', 'add', '--title', 'No brief', '--acceptance', 'x']);
  const noBrief = h.run(['spawn', '--role', 'small', '--task', 'T2', '--dry-run']);
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
    commandRung(h, 'small', command);
    const before = footprint(h);
    assert.equal(h.readState('tasks.json').tasks[0].branch, null);
    for (const mode of [[], ['--wait']]) {
      const r = h.run(['spawn', '--role', 'small', '--task', 'T1', ...mode]);
      assert.equal(r.code, 1, r.stderr);
      assert.deepEqual(footprint(h), before, `${command[0]} ${mode.join(' ')}`);
      assert.ok(r.stderr.includes(`could not start ${command[0]}: no executable file by that name`), r.stderr);
    }
  }
});

const leftover = (h) => path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');

test('a spawn whose program fails to start records nothing and leaves its worktree for the next spawn', (t) => {
  const h = setup(t);
  commandRung(h, 'small', [process.execPath, '-e', 'process.exit(0)']);
  const { tasks, events } = footprint(h);
  for (const mode of [[], ['--wait']]) {
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1', ...mode], { hooks: { HOOK_SPAWN_FAIL: '1' } });
    assert.equal(r.code, 1, r.stderr);
    const now = footprint(h);
    assert.ok(fs.existsSync(leftover(h)), 'the worktree stays');
    assert.equal(now.branches.replace(/^[*+ ]+/, ''), 'gishra/T1-idempotency-key-on-retries', 'the branch stays');
    assert.deepEqual([now.tasks, now.events, now.logs || []], [tasks, events, []], `${mode.join(' ') || 'background'}: no spawn is recorded`);
    assert.match(r.stderr, /could not start .*; its worktree stays at .*T1-idempotency-key-on-retries for the next spawn/);
  }
  const next = h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait']);
  assert.equal(next.code, 0);
  assert.equal(real(next.cwd), real(leftover(h)), 'the next spawn reuses it');
  assert.equal(h.readState('tasks.json').tasks[0].branch, 'gishra/T1-idempotency-key-on-retries');
});

test('a spawn that cannot take the lock leaves its worktree, names it and exits 3', async (t) => {
  const h = setup(t);
  commandRung(h, 'small', [process.execPath, '-e', 'process.exit(0)']);
  const { tasks } = footprint(h);
  const paused = path.join(h.base, 'holder');
  const holder = h.runAsync(['task', 'note', 'T1', 'holding the lock'], { hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: paused } });
  await waitForFile(paused);
  try {
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1']);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /state is locked by .*; its worktree stays at .*T1-idempotency-key-on-retries for the next spawn/);
    assert.equal(footprint(h).tasks, tasks);
    assert.ok(fs.existsSync(leftover(h)));
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
  }
  assert.equal((await holder).code, 0);
  assert.equal(real(h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait']).cwd), real(leftover(h)));
});

async function waitForFile(file, ms = 20000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`${file} never appeared`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a failed spawn never deletes a worktree another command took up', async (t) => {
  const h = setup(t);
  const output = 'worker-output.txt';
  const release = path.join(h.base, 'worker-may-write');
  // The worker stays alive with nothing written until the test releases it,
  // then writes into its working directory.
  const worker = `const fs = require("fs"); const end = Date.now() + 20000;
while (!fs.existsSync(process.argv[1]) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
fs.writeFileSync(${JSON.stringify(output)}, "work in progress");`;
  commandRung(h, 'small', [process.execPath, '-e', worker, release]);
  const branchExists = (b) => h.git(['branch', '--list', b]).replace(/^[*+ ]+/, '') === b;

  // A creates T1's worktree and stops before it takes the lock; its program
  // will fail to start. B spawns into the same worktree and its worker starts.
  const aCreated = path.join(h.base, 'a-created');
  const a = h.runAsync(['spawn', '--role', 'small', '--task', 'T1'], { hooks: { HOOK_STOP_WORKTREE_ADD: aCreated, HOOK_SPAWN_FAIL: '1' } });
  await waitForFile(aCreated);
  const b = h.json(['spawn', '--role', 'small', '--task', 'T1']);
  fs.writeFileSync(`${aCreated}.go`, '');
  assert.equal((await a).code, 1);
  assert.ok(fs.existsSync(b.cwd), "B's worktree is still there");
  assert.ok(branchExists(h.readState('tasks.json').tasks[0].branch), "T1's recorded branch still exists");
  fs.writeFileSync(release, '');
  await waitForFile(path.join(b.cwd, output));

  // T2 already names a branch but has no worktree. A creates the worktree
  // and stops; B gets it from gishra worktree, claims T2 and works there
  // before writing anything. Then A fails.
  h.git(['branch', 'feature/second']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'b']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'second brief\n' });
  h.ok(['claim', 'T2', '--agent', 'w-1']);
  h.ok(['submit', 'T2', '--sha', 'abcdef1', '--branch', 'feature/second', '--agent', 'w-1']);
  h.ok(['rework', 'T2', '--reason', 'again']);
  const a2Created = path.join(h.base, 'a2-created');
  const a2 = h.runAsync(['spawn', '--role', 'small', '--task', 'T2'], { hooks: { HOOK_STOP_WORKTREE_ADD: a2Created, HOOK_SPAWN_FAIL: '1' } });
  await waitForFile(a2Created);
  const handed = h.json(['worktree', 'T2']).path;
  h.ok(['claim', 'T2', '--agent', 'w-b']);
  fs.writeFileSync(`${a2Created}.go`, '');
  assert.equal((await a2).code, 1);
  assert.ok(fs.existsSync(handed), "the claimant's worktree is still there");
  assert.ok(branchExists('feature/second'));
  fs.writeFileSync(path.join(handed, 'claimant-output.txt'), 'work');
});
