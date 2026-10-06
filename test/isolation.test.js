'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const A = require('../lib/agents');
const TOML = require('../lib/toml');

const STUB = path.join(__dirname, 'fixtures', 'harness-stub.js');
// The stubs are scripts started through a shebang; Windows starts only .exe
// and .com files from a rung, so the end-to-end runs are POSIX only.
const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';
const SECRET = 'PLANTED-SECRET';

// A user home holding what must never reach a tower-crane agent: memory and
// instruction files, hooks, an MCP server, approved-command rules, and
// credentials that must reach it only through a link.
function plant(h) {
  const home = path.join(h.base, 'home');
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  };
  put('.claude/CLAUDE.md', 'PLANTED-MEMORY\n');
  put('.claude/settings.json', JSON.stringify({
    permissions: { allow: ['Bash(planted-rule:*)'] },
    env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: `${SECRET}-ENV` },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'planted-user-hook' }] }] },
    apiKeyHelper: `echo ${SECRET}-HELPER`,
  }));
  put('.claude.json', JSON.stringify({ mcpServers: { planted: { command: 'planted-mcp', args: ['x'], env: { TOKEN: `${SECRET}-MCP` } } } }));
  put('.claude/.credentials.json', `{"token":"${SECRET}-CRED"}`);
  put('instructions.md', 'PLANTED-INSTRUCTIONS\n');
  put('.codex/config.toml', [
    'model = "m"', 'model_provider = "p"', 'approval_policy = "never"', 'notify = ["planted-notify"]',
    `model_instructions_file = ${JSON.stringify(path.join(home, 'instructions.md'))}`, '',
    '[model_providers.p]', 'name = "P"', `experimental_bearer_token = "${SECRET}-TOKEN"`, 'env_key = "P_KEY"', '',
    '[model_providers]', `q = { name = "Q", env_key = "Q_KEY", wire_api = "responses", experimental_bearer_token = "${SECRET}-INLINE" }`, '',
    '[mcp_servers.planted]', 'command = "planted-mcp"', '',
    '[mcp_servers.planted.env]', `TOKEN = "${SECRET}-MCP"`, '',
  ].join('\n'));
  put('.codex/sol.config.toml', [
    'model = "s"', `experimental_bearer_token = "${SECRET}-PROFILE"`,
    `model_instructions_file = ${JSON.stringify(path.join(home, 'instructions.md'))}`,
    `model_providers = { r = { name = "R", experimental_bearer_token = "${SECRET}-PROFILE-INLINE" } }`, '',
  ].join('\n'));
  put('.codex/AGENTS.md', 'PLANTED-MEMORY\n');
  put('.codex/memories/m.md', 'PLANTED-MEMORY-2\n');
  put('.codex/rules/default.rules', 'prefix_rule(pattern = ["planted-rule"], decision = "allow")\n');
  put('.codex/auth.json', `{"token":"${SECRET}-CRED"}`);
  put('.codex/.env', `AWS_BEARER_TOKEN_BEDROCK=${SECRET}-ENV\n`);

  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)})(${JSON.stringify(name)});\n`, { mode: 0o755 });
  }
  // gh is not on every CI runner; this one stands in for the real program
  // the agent's gh shim hands allowed calls to.
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho fake gh\n', { mode: 0o755 });
  const out = path.join(h.base, 'stub.json');
  const runEnv = { ...h.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out };
  // The developer's own harness homes must not leak in.
  delete runEnv.CLAUDE_CONFIG_DIR;
  delete runEnv.CODEX_HOME;
  return { home, out, env: runEnv, report: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

function setup(t) {
  const h = makeRepo(t);
  // A repository whose own claude settings carry a hook.
  fs.mkdirSync(path.join(h.repo, '.claude'));
  fs.writeFileSync(path.join(h.repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'planted-project-hook' }] }] } }));
  h.git(['add', '.']);
  h.git(['commit', '-q', '-m', 'project settings']);
  h.init();
  h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'nothing planted reaches the agent']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'probe\n' });
  const wt = h.json(['worktree', 'T1']).path;
  fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'planted-local-hook' }] }] } }));
  return { h, u: plant(h), wt };
}

// Every regular file under dir, without following links into the user's home.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function noSecretsCopied(h) {
  for (const f of walk(h.state)) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), `${f} holds a copied credential`);
}

function spawn(h, u, role, env = {}) {
  const r = h.run(['spawn', '--role', role, '--task', 'T1', '--wait', '--json'], { env: { ...u.env, ...env } });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const isolated = (h, rung, harness) => {
  const model = harness === 'claude' ? ['--model', 'opus', '--clear', 'profile'] : ['--profile', 'sol', '--clear', 'model'];
  h.ok(['ladder', 'set', rung, '--harness', harness, ...model, '--clear', 'effort']);
};

test('a spawned claude agent loads none of the user memory, settings hooks, MCP servers or rules, and reaches auth through a link', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'small', 'claude');
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.ok(!JSON.stringify(dry).includes(SECRET), 'no credential in the command or its env');
  const started = spawn(h, u, 'small');
  const seen = u.report();
  assert.ok(!seen.memory.join('\n').includes('PLANTED'), 'user memory stays out');
  assert.match(seen.memory.join('\n'), /^# tower-crane-small/m, 'the role instructions load instead');
  assert.deepEqual(seen.hooks, [], 'no user, project or local hooks');
  assert.deepEqual(seen.mcp, {}, 'no MCP server');
  assert.deepEqual(seen.rules, [], 'no approved-command rules');
  assert.deepEqual(seen.settings.env, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' }, 'provider settings only, never a credential');
  assert.equal(seen.auth, `{"token":"${SECRET}-CRED"}`, 'auth reaches the agent');
  // The helper is named, not copied, and still yields the user's credential.
  const helper = cp.execSync(seen.settings.apiKeyHelper, { encoding: 'utf8', env: u.env }).trim();
  assert.equal(helper, `${SECRET}-HELPER`);
  const home = path.join(h.state, 'homes', started.agent);
  assert.ok(fs.lstatSync(path.join(home, '.credentials.json')).isSymbolicLink(), 'credentials are linked');
  assert.equal(fs.statSync(home).mode & 0o777, 0o700, 'the home is private');
  assert.equal(fs.statSync(path.join(home, 'settings.json')).mode & 0o777, 0o600);
  assert.ok(seen.args.includes('--strict-mcp-config') && seen.args.includes('--disable-slash-commands'));
  assert.equal(seen.args[seen.args.indexOf('--tools') + 1], 'Bash,Read,Grep,Glob');
  assert.equal(fs.readFileSync(path.join(h.state, 'homes', '.gitignore'), 'utf8'), '*\n');
  noSecretsCopied(h);
});

test('a spawned codex agent loads none of the user memory, instructions, MCP servers or rules, and reaches auth through a link', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'small', 'codex');
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.ok(!JSON.stringify(dry).includes(SECRET), 'no credential in the command or its env');
  const started = spawn(h, u, 'small');
  const seen = u.report();
  assert.ok(!seen.memory.join('\n').includes('PLANTED'), 'user instructions, instruction files and memories stay out');
  assert.match(seen.memory.join('\n'), /^# tower-crane-small/m);
  assert.deepEqual(seen.mcp, {}, 'no MCP server');
  assert.ok(!seen.rules.join('\n').includes('planted-rule'), 'no approved-command rules');
  assert.match(seen.rules.join('\n'), /pattern = \["gh", "pr", "merge"\],\n {4}decision = "forbidden"/, 'the role denies gh writes');
  assert.equal(seen.auth, `{"token":"${SECRET}-CRED"}`, 'auth.json reaches the agent');
  assert.equal(seen.env, `AWS_BEARER_TOKEN_BEDROCK=${SECRET}-ENV\n`, '.env reaches the agent');
  assert.equal(seen.config.model_provider, 'p', 'the provider is kept');
  assert.deepEqual(seen.config.model_providers, { p: { name: 'P', env_key: 'P_KEY' }, q: { name: 'Q', env_key: 'Q_KEY', wire_api: 'responses' } }, 'providers in any layout, without credentials');
  for (const k of ['approval_policy', 'notify', 'model_instructions_file']) assert.equal(seen.config[k], undefined, `${k} is the user's, not the role's`);
  const home = path.join(h.state, 'homes', started.agent);
  for (const f of ['auth.json', '.env']) assert.ok(fs.lstatSync(path.join(home, f)).isSymbolicLink(), `${f} is linked`);
  assert.equal(fs.readFileSync(path.join(home, 'sol.config.toml'), 'utf8'), 'model = "s"\n\n[model_providers.r]\nname = "R"\n', 'the profile without its tokens or instructions');
  assert.equal(fs.statSync(path.join(home, 'config.toml')).mode & 0o777, 0o600);
  noSecretsCopied(h);
});

test('every spawn gets a fresh home, and an exited agent\'s home is removed', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'small', harness);
    const first = spawn(h, u, 'small').agent;
    const old = path.join(h.state, 'homes', first);
    // What an agent could leave behind for the next one.
    fs.writeFileSync(path.join(old, 'CLAUDE.md'), 'PLANTED-BY-AGENT\n');
    fs.writeFileSync(path.join(old, 'AGENTS.md'), 'PLANTED-BY-AGENT\n');
    fs.mkdirSync(path.join(old, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(old, 'rules', 'previous-agent.rules'), 'prefix_rule(pattern = ["planted-by-agent"], decision = "allow")\n');
    fs.writeFileSync(path.join(old, 'rules', 'previous-agent.md'), 'PLANTED-BY-AGENT\n');
    const second = spawn(h, u, 'small').agent;
    assert.notEqual(second, first);
    const seen = u.report();
    assert.ok(!seen.memory.join('\n').includes('PLANTED'), `${harness}: nothing carries over`);
    assert.ok(!seen.rules.join('\n').includes('planted-by-agent'), `${harness}: no rules carry over`);
    assert.ok(!fs.existsSync(old), `${harness}: the exited agent's home is gone`);
  }
});

test('a codex agent writes only where its agent file says; reviewer and small checks cannot write the worktree', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  for (const [rung, worktree] of [['hard', 'write'], ['review', 'read'], ['small', 'read']]) {
    isolated(h, rung, 'codex');
    spawn(h, u, rung);
    const { config } = u.report();
    const rules = config.permissions.tower-crane.filesystem;
    assert.deepEqual(rules[':workspace_roots'], { '.': worktree }, rung);
    assert.equal(rules[':root'], 'read', rung);
    assert.equal(rules[h.state], 'write', `${rung}: state through the CLI`);
    assert.equal(rules[path.join(h.state, 'homes')], 'read', `${rung}: agent homes are not writable`);
    assert.equal(config.permissions.tower-crane.network.enabled, true);
  }
});

test('git and gh refuse denied operations whatever the argument order', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const remote = path.join(h.base, 'remote.git');
  h.git(['init', '-q', '--bare', remote]);
  h.git(['remote', 'add', 'origin', remote]);
  h.git(['push', '-q', 'origin', 'main']);
  const run = [
    ['git', 'push', 'origin', 'HEAD:refs/heads/ok'],
    ['git', 'push', 'origin', 'HEAD:refs/heads/forced', '--force'],
    ['git', '-C', wt, 'push', '--force-with-lease', 'origin', 'HEAD:refs/heads/forced'],
    ['git', 'push', 'origin', '+HEAD:refs/heads/forced'],
    ['git', '-c', 'alias.p=push', 'p', '-f', 'origin', 'HEAD:refs/heads/forced'],
    ['gh', '--repo', 'o/r', 'pr', 'merge', '1'],
    ['gh', 'pr', '-R', 'o/r', 'merge', '1'],
    ['gh', 'pr', 'view', '1'],
  ];
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    spawn(h, u, 'hard', { STUB_RUN: JSON.stringify(run) });
    const codes = u.report().ran.map((r) => r.code);
    assert.deepEqual(codes, [0, 126, 126, 126, 126, 126, 126, 0], `${harness}: ${JSON.stringify(u.report().ran.map((r) => r.stderr))}`);
  }
  assert.equal(h.git(['--git-dir', remote, 'branch', '--list', 'forced']), '', 'no forced push landed');
});

test('a rung opts back in to a named tool and MCP server, shown by spawn --dry-run', (t) => {
  const { h, u } = setup(t);
  h.ok(['ladder', 'set', 'small', '--harness', 'claude', '--model', 'opus', '--clear', 'profile', '--clear', 'effort', '--tools', '["WebFetch"]', '--mcp', '["planted"]']);
  let dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.equal(dry.argv[dry.argv.indexOf('--tools') + 1], 'Bash,Read,Grep,Glob,WebFetch');
  assert.ok(!dry.argv.includes('WebFetch'), 'no longer denied');
  assert.equal(dry.argv[dry.argv.indexOf('--allowedTools') + 1], 'Bash,Read,Grep,Glob,WebFetch,mcp__planted');
  assert.deepEqual([dry.home.tools, dry.home.mcp], [['WebFetch'], ['planted']]);
  const text = h.ok(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.match(text, /^# agent file .*tower-crane-small\.md; home .*small-T1-1; MCP servers: planted; opted-in tools: WebFetch$/m);
  if (!NO_STUBS) {
    spawn(h, u, 'small');
    assert.deepEqual(u.report().mcp, { planted: { command: 'planted-mcp', args: ['x'] } }, 'the server, without its env');
  }

  h.ok(['ladder', 'set', 'small', '--harness', 'codex', '--profile', 'sol', '--clear', 'model', '--tools', '["web_search","multi_agent"]', '--mcp', '["planted"]']);
  dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.ok(!dry.argv.includes('web_search="disabled"'));
  assert.ok(!dry.argv.join(' ').includes('--disable multi_agent'));
  assert.ok(dry.argv.join(' ').includes('--enable multi_agent'));
  assert.deepEqual(dry.home.mcp, ['planted']);
  if (!NO_STUBS) {
    spawn(h, u, 'small');
    const seen = u.report();
    assert.deepEqual(seen.mcp, { planted: true });
    assert.ok(!seen.configText.includes(SECRET), 'the server env stays out');
    noSecretsCopied(h);
  }

  h.ok(['ladder', 'set', 'small', '--mcp', '["missing"]']);
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /opts in MCP server missing, but .*config\.toml defines no \[mcp_servers\.missing\]/);
  const pi = h.run(['ladder', 'set', 'small', '--harness', 'pi', '--model', 'x', '--clear', 'profile']);
  assert.equal(pi.code, 1);
  assert.match(pi.stderr, /tools applies only to claude and codex, mcp applies only to claude and codex/);
});

test('only the owner widens a rung, and args cannot override the agent file', (t) => {
  const { h } = setup(t);
  isolated(h, 'small', 'claude');
  const as = (agent, flags) => h.run(['ladder', 'set', 'small', ...flags, '--agent', agent]);
  for (const flags of [['--tools', '["Agent"]'], ['--mcp', '["planted"]'], ['--args', '["--verbose"]'], ['--harness', 'command', '--command', '["sh"]', '--clear', 'model']]) {
    const r = as('worker-T1-1', flags);
    assert.equal(r.code, 1, flags.join(' '));
    assert.match(r.stderr, /only the owner can change a rung's harness, args, command, tools, mcp/);
  }
  h.ok(['ladder', 'set', 'small', '--model', 'sonnet', '--agent', 'orchestrator-1']);
  assert.equal(as('owner', ['--tools', '["Agent"]']).code, 0);
  for (const [harness, args] of [['claude', '["--dangerously-skip-permissions"]'], ['claude', '["--setting-sources=user,project"]'], ['codex', '["--sandbox","danger-full-access"]'], ['codex', '["-c","sandbox_mode=\\"danger-full-access\\""]'], ['codex', '["--ignore-rules"]']]) {
    if (harness === 'codex') isolated(h, 'small', 'codex');
    const r = as('owner', ['--args', args]);
    assert.equal(r.code, 1, args);
    assert.match(r.stderr, /args cannot set .*: the agent file decides it/, args);
  }
  assert.equal(as('owner', ['--args', '["-c","model_reasoning_effort=\\"high\\"","--disable","memories"]']).code, 0);
});

test('claude and codex rungs dispatch through spawn, never as native subagents', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'tower-crane', 'SKILL.md'), 'utf8');
  const ladder = fs.readFileSync(path.join(ROOT, 'docs', 'ladder.md'), 'utf8');
  for (const text of [skill, ladder]) {
    assert.match(text, /A rung on claude or codex always runs through `tower-crane spawn`/);
    assert.doesNotMatch(text, /dispatch natively with (that|the) rung's model/);
  }
});

test('each role has an agent file that states its tools, MCP servers, skills, web, git push, gh writes and outside paths', () => {
  const components = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
  for (const job of ['worker', 'reviewer', 'small', 'orchestrator']) {
    assert.ok(components.agents.includes(`tower-crane-${job}`), `components.json registers tower-crane-${job}`);
    const a = A.load(job);
    assert.deepEqual(a.mcpServers, [], `${job}: no MCP servers by default`);
    assert.deepEqual(a.tools.filter((x) => a.disallowedTools.includes(x)), [], `${job}: a tool is not both allowed and denied`);
    // Claude Code reads disallowedTools directly for native agents, so it
    // has to spell out every denial the other fields state.
    const derived = [
      ...(a.web ? [] : ['WebFetch', 'WebSearch']),
      ...(a.gitPush === 'none' ? ['Bash(git push:*)'] : ['Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)']),
      ...A.policy(a).ghDeny.map((g) => `Bash(gh ${g}:*)`),
    ];
    for (const d of derived) assert.ok(a.disallowedTools.includes(d), `${job}: disallowedTools lacks ${d}`);
  }
  // The parsed config the codex filter works on survives a round trip.
  const doc = TOML.parse('a = 1\n[b]\nc = { d = [1, "x"] }\n');
  assert.deepEqual(TOML.parse(TOML.stringify(doc)), doc);
});
