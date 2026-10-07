'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const STUB = path.join(__dirname, 'fixtures', 'harness-stub.js');
// The stubs are shebang scripts; Windows starts only .exe and .com files.
const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';

// A user home with global rules for both harnesses (claude's importing a
// shared file), an ancestor AGENTS.md above the repository, the
// repository's own AGENTS.md and a CLAUDE.md that imports a docs file.
function setup(t, brief = 'probe\n') {
  const h = makeRepo(t);
  const home = path.join(h.base, 'home');
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  put(path.join(home, '.claude', 'CLAUDE.md'), '@~/.config/agents/SHARED.md\n\nCLAUDE-GLOBAL\n');
  put(path.join(home, '.config', 'agents', 'SHARED.md'), 'SHARED-RULES\n');
  put(path.join(home, '.codex', 'AGENTS.md'), 'CODEX-GLOBAL\n');
  put(path.join(h.base, 'AGENTS.md'), 'ANCESTOR-RULES\n');
  put(path.join(h.repo, 'AGENTS.md'), 'REPO-RULES\n');
  put(path.join(h.repo, 'CLAUDE.md'), 'See @docs/extra.md for more.\n');
  put(path.join(h.repo, 'docs', 'extra.md'), 'EXTRA-RULES\n');
  // A user MCP server the agent did not opt into.
  put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { planted: { command: 'planted-mcp' } } }));
  h.git(['add', '.']);
  h.git(['commit', '-q', '-m', 'rules']);
  h.init();
  h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'the agent knows the goal', '--acceptance', 'and the rules']);
  h.ok(['brief', 'set', 'T1', '-'], { input: brief });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)})(${JSON.stringify(name)});\n`, { mode: 0o755 });
  }
  const out = path.join(h.base, 'stub.json');
  const env = { ...h.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GH_TOKEN: 'x' };
  return { h, home, env, report: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

const rung = (h, harness) => {
  const model = harness === 'claude' ? ['--model', 'opus', '--clear', 'profile'] : ['--profile', 'sol', '--clear', 'model'];
  h.ok(['ladder', 'set', 'small', '--harness', harness, ...model, '--clear', 'effort', '--clear', 'args']);
};

const ours = (h, rules) => rules.filter((r) => r.path.startsWith(h.base + path.sep)).map((r) => [path.relative(h.base, r.path), r.scope, r.loaded]);

test('a claude spawn imports the user rules and the repository chain by path, and records a startup receipt', { skip: NO_STUBS }, (t) => {
  const { h, env, report } = setup(t);
  rung(h, 'claude');
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env });
  const wt = dry.cwd;
  h.ok(['worktree', 'T1']);
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env });
  assert.equal(r.code, 0, r.stderr);
  const seen = report();
  const rel = path.relative(h.base, wt);
  const expected = [
    [path.join('home', '.claude', 'CLAUDE.md'), 'global', 'harness'],
    [path.join('home', '.config', 'agents', 'SHARED.md'), 'import', 'harness'],
    ['AGENTS.md', 'project', 'harness'],
    [path.join(rel, 'AGENTS.md'), 'project', 'harness'],
    [path.join(rel, 'CLAUDE.md'), 'project', 'harness'],
    [path.join(rel, 'docs', 'extra.md'), 'import', 'harness'],
  ];
  const startup = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.cmd === 'startup');
  assert.equal(startup.length, 1, 'one startup receipt');
  assert.deepEqual(ours(h, startup[0].detail.rules), expected);
  assert.equal(startup[0].detail.goal, 'prove the engine');
  assert.deepEqual(startup[0].detail.target, { id: 'T1', title: 'Probe', acceptance: 2 });
  assert.equal(startup[0].detail.rules_tokens, Math.ceil(startup[0].detail.rules_bytes / 4));
  assert.ok(startup[0].detail.prompt_bytes > 0);
  const memory = seen.memory.join('\n');
  for (const text of ['CLAUDE-GLOBAL', 'SHARED-RULES', 'ANCESTOR-RULES', 'REPO-RULES', 'EXTRA-RULES']) assert.ok(memory.includes(text), `claude loads ${text}`);
  const instructions = fs.readFileSync(path.join(h.state, 'homes', JSON.parse(r.stdout).agent, 'CLAUDE.md'), 'utf8');
  assert.ok(!/RULES|GLOBAL/.test(instructions), 'the home names the files, never copies them');
  assert.deepEqual(seen.mcp, {}, 'no MCP server it did not opt into');
  assert.match(seen.prompt, /## Goal\n\nProject goal: prove the engine\nTask target: T1, "Probe"/);
  assert.match(seen.prompt, /Begin your first message by restating the project goal and this target/);
  assert.ok(seen.prompt.includes(`- ${path.join(h.base, 'AGENTS.md')} (project, loaded in your context)`));
  assert.ok(!seen.prompt.includes('read it'), 'claude has every file in its context');
  assert.ok(dry.startup.rules.length >= 4, 'dry-run measures the rules before the worktree exists');
});

test('a codex spawn is told to read the rules its harness does not load, and its startup receipt says which', { skip: NO_STUBS }, (t) => {
  const { h, home, env, report } = setup(t);
  rung(h, 'codex');
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env });
  assert.equal(r.code, 0, r.stderr);
  const seen = report();
  const wt = JSON.parse(r.stdout).cwd;
  const rel = path.relative(h.base, wt);
  const startup = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'startup');
  assert.deepEqual(ours(h, startup.detail.rules), [
    [path.join('home', '.codex', 'AGENTS.md'), 'global', 'read'],
    ['AGENTS.md', 'project', 'read'],
    [path.join(rel, 'AGENTS.md'), 'project', 'harness'],
    [path.join(rel, 'CLAUDE.md'), 'project', 'read'],
    [path.join(rel, 'docs', 'extra.md'), 'import', 'read'],
  ]);
  assert.ok(!startup.detail.rules.some((f) => f.path === path.join(home, '.claude', 'CLAUDE.md')), 'claude\'s global file is not codex\'s rules');
  assert.deepEqual(seen.projectDocs, ['REPO-RULES\n'], 'codex itself loads the worktree AGENTS.md');
  assert.ok(seen.prompt.includes(`- ${path.join(home, '.codex', 'AGENTS.md')} (global, read it)`));
  assert.ok(seen.prompt.includes(`- ${path.join(h.base, 'AGENTS.md')} (project, read it)`));
  assert.ok(seen.prompt.includes(`- ${path.join(wt, 'AGENTS.md')} (project, loaded in your context)`));
  assert.match(seen.prompt, /Read every file marked "read it" before you change anything/);
  assert.match(seen.prompt, /Project goal: prove the engine/);
  assert.deepEqual(seen.mcp, {}, 'no MCP server it did not opt into');
});

test('a command harness keeps its own HOME rules and is told to read the repository chain', (t) => {
  const { h, env } = setup(t);
  h.ok(['ladder', 'set', 'small', '--harness', 'command', '--clear', 'profile', '--clear', 'effort', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}'])]);
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env });
  assert.deepEqual(ours(h, dry.startup.rules).map(([p, scope, loaded]) => [path.basename(p), scope, loaded]), [
    ['AGENTS.md', 'project', 'read'], ['AGENTS.md', 'project', 'read'], ['CLAUDE.md', 'project', 'read'], ['extra.md', 'import', 'read'],
  ]);
  const prompt = dry.argv[dry.argv.length - 1];
  assert.match(prompt, /## Goal[\s\S]*## House rules[\s\S]*probe[\s\S]*## Task/);
  assert.ok(prompt.includes('"the agent knows the goal"'), 'the acceptance travels with the brief');
});

// The fixture brief names a directory and a file; the diff touches those, a test, the
// changelog and two files the task never named.
function scoped(t, brief) {
  const { h } = setup(t, brief);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  const wt = h.json(['worktree', 'T1']).path;
  for (const [f, text] of [['lib/a.js', 'a'], ['docs/guide.md', 'g'], ['test/a.test.js', 't'], ['CHANGELOG.md', 'c'], ['other/b.js', 'b'], ['README.md', 'changed']]) {
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.writeFileSync(path.join(wt, f), text);
  }
  h.git(['add', '.'], wt);
  h.git(['commit', '-q', '-m', 'work'], wt);
  return { h, sha: h.git(['rev-parse', 'HEAD'], wt), wt };
}

test('the scope gate flags submitted changes outside the paths the brief and acceptance name', (t) => {
  const { h, sha, wt } = scoped(t, 'Change `lib/` and docs/guide.md; see and/or AGENTS.md/CLAUDE.md for context.\n');
  const r = h.run(['submit', 'T1', '--sha', sha, '--agent', 'builder'], { cwd: wt });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /scope: 2 changed files outside the paths the brief and acceptance name \(lib\/, docs\/guide\.md\): README\.md, other\/b\.js/);
  const event = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).findLast((e) => e.cmd === 'submit');
  assert.deepEqual(event.detail.scope, { basis: 'named', named: ['lib/', 'docs/guide.md'], outside: ['README.md', 'other/b.js'] });
  const task = h.readState('tasks.json').tasks[0];
  assert.ok(task.notes.some((n) => n.text.startsWith('scope: 2 changed files outside')), 'the orchestrator sees it in the task notes');
});

test('a task that names no repository path is scoped to the whole repository', (t) => {
  const { h, sha, wt } = scoped(t, 'Make it better.\n');
  const out = h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder'], { cwd: wt });
  assert.match(out, /scope: the brief and acceptance name no repository path; the whole repository is in scope/);
  assert.ok(!h.readState('tasks.json').tasks[0].notes.some((n) => n.text.startsWith('scope:')));
});
