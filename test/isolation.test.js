'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, BIN } = require('./helpers');
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
  put('.agents/skills/planted-user-skill/SKILL.md', '---\nname: planted-user-skill\n---\nPLANTED-SKILL\n');
  put('.gitconfig', '[user]\n\tname = planted user\n');

  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)})(${JSON.stringify(name)});\n`, { mode: 0o755 });
  }
  // gh is not on every CI runner; this one stands in for the real program
  // the agent's gh shim hands allowed calls to.
  // Like a gh whose login is in the system keyring: `auth token` answers
  // outside a sandbox, and a write without GH_TOKEN gets the 401 a sandboxed
  // agent got when the keyring was out of its reach.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1" = auth ] && [ "$2" = token ]; then echo stub-gh-token; exit 0; fi',
    'if [ "$1" = pr ] && [ "$2" = comment ] && [ "$GH_TOKEN" != stub-gh-token ]; then echo "HTTP 401: Requires authentication" >&2; exit 1; fi',
    'echo fake gh', '',
  ].join('\n'), { mode: 0o755 });
  // A test nested inside an agent must not cycle through the parent and
  // child git shims. Delegate local work through the parent's guarded PATH;
  // network pushes return a fixture error without contacting a remote.
  const parentPath = process.env.PATH;
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const cp = require('node:child_process');
const args = process.argv.slice(2);
const env = { ...process.env, PATH: ${JSON.stringify(parentPath)} };
if (args[0] === 'push') {
  const target = args.find((a, i) => i > 0 && !a.startsWith('-')) || 'origin';
  const remote = cp.spawnSync('git', ['remote', 'get-url', '--push', target], { env, encoding: 'utf8', timeout: 10000 });
  if (/^(?:https?|ssh|git):|^[^/]*@/.test((remote.stdout || '').trim())) {
    process.stderr.write('fixture remote unavailable\\n');
    process.exit(1);
  }
}
const result = cp.spawnSync('git', args, { env, stdio: 'inherit', timeout: 10000 });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const out = path.join(h.base, 'stub.json');
  const runEnv = { ...h.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out };
  // The developer's own harness homes and gh tokens must not leak in: the
  // fixture's gh login lives in its stub keyring. The tokens are emptied, not
  // deleted, since the caller's own env would fill a missing key back in.
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) runEnv[k] = '';
  runEnv.CLAUDE_CONFIG_DIR = '';
  runEnv.CODEX_HOME = '';
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
  if (role === 'review' && h.readState('tasks.json').tasks[0].status !== 'submitted') {
    h.ok(['task', 'update', 'T1', '--kind', 'docs']);
    h.ok(['claim', 'T1', '--agent', 'builder']);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'builder']);
  }
  const r = h.run(['spawn', '--role', role, '--task', 'T1', '--wait', '--json'], { env: { ...u.env, ...env } });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const isolated = (h, rung, harness) => {
  const model = harness === 'claude' ? ['--model', 'opus', '--clear', 'profile'] : ['--profile', 'sol', '--clear', 'model'];
  h.ok(['ladder', 'set', rung, '--harness', harness, ...model, '--clear', 'effort', '--clear', 'args']);
};

test('a spawned claude agent loads none of the user memory, settings hooks, MCP servers or rules, and reaches auth through a link', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
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
  assert.equal(seen.home, path.join(home, 'home'), 'HOME is the agent\'s own');
  // Bash is approved only because it runs in claude's sandbox, which stops
  // the agent when it cannot start; the small role writes the state only.
  const box = seen.settings.sandbox;
  assert.equal(seen.args[seen.args.indexOf('--allowedTools') + 1], 'Bash,Read,Grep,Glob');
  assert.deepEqual([box.enabled, box.failIfUnavailable, box.allowUnsandboxedCommands, box.network.allowAllUnixSockets], [true, true, false, true]);
  assert.deepEqual(box.filesystem.allowWrite, [h.state]);
  assert.deepEqual(box.filesystem.denyWrite, [path.join(h.state, 'homes'), wt]);
  for (const p of ['/var/run/docker.sock', '/run/docker.sock', path.join(u.home, '.ssh'), path.join(u.home, '.aws')]) assert.ok(box.filesystem.denyRead.includes(p), p);
  assert.match(fs.readFileSync(path.join(h.repo, '.git', 'info', 'exclude'), 'utf8'), /^\.claude\/\.cc-writes\/$/m, 'the sandbox marker is never committed');
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
  assert.equal(seen.home, path.join(home, 'home'), 'HOME is the agent\'s own');
  assert.deepEqual(seen.skills, [], 'no user skill from ~/.agents/skills, and the small role has none of its own');
  assert.equal(fs.readlinkSync(path.join(home, 'home', '.gitconfig')), path.join(u.home, '.gitconfig'), 'git config is linked into its HOME');
  spawn(h, u, 'review');
  assert.deepEqual(u.report().skills, ['tower-crane-review'], 'the reviewer gets its own skill only');
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

test('a codex agent writes only where its agent file says; a worker writes its git metadata, reviewer and small checks cannot write the worktree', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  // A worker fetches, adds, commits and pushes: it writes the repository's
  // git directory and its worktree's admin directory inside it.
  const common = fs.realpathSync(h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt));
  const own = fs.realpathSync(h.git(['rev-parse', '--path-format=absolute', '--git-dir'], wt));
  for (const [rung, worktree] of [['hard', 'write'], ['review', 'read'], ['small', 'read']]) {
    isolated(h, rung, 'codex');
    spawn(h, u, rung);
    const { config } = u.report();
    const rules = config.permissions['tower-crane'].filesystem;
    for (const d of [common, own]) assert.equal(rules[d], worktree === 'write' ? 'write' : undefined, `${rung}: ${d}`);
    assert.deepEqual(rules[':workspace_roots'], { '.': worktree }, rung);
    assert.equal(rules[':root'], 'read', rung);
    assert.equal(rules[h.state], 'write', `${rung}: state through the CLI`);
    assert.equal(rules[path.join(h.state, 'homes')], 'read', `${rung}: agent homes are not writable`);
    assert.equal(config.permissions['tower-crane'].network.enabled, true);
  }
  for (const [rung, writes] of [['hard', true], ['small', false]]) {
    isolated(h, rung, 'claude');
    spawn(h, u, rung);
    const allow = u.report().settings.sandbox.filesystem.allowWrite;
    for (const d of [common, own]) assert.equal(allow.includes(d), writes, `claude ${rung}: ${d}`);
  }
});

test('git and gh allow git commands, local pushes and the role\'s own writes, and refuse everything else', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const local = path.join(h.base, 'local.git');
  h.git(['init', '-q', '--bare', local]);
  // A remote on another machine; nothing listens there, so a push the shim
  // lets through fails in git itself, not with the shim's 126.
  h.git(['remote', 'add', 'origin', 'https://127.0.0.1:9/r.git']);
  const NET = 'net';
  const cases = [
    [['git', 'status'], 0, 0],
    [['git', '-C', wt, 'log', '-1'], 0, 0],
    [['git', 'commit', '--allow-empty', '-q', '-m', 'probe'], 0, 0],
    [['git', 'push', local, '+HEAD:refs/heads/fixture'], 0, 0],
    [['git', 'push', '--force', local, 'HEAD:refs/heads/fixture'], 126, 126],
    [['git', 'push', local, ':refs/heads/fixture'], 0, 0],
    [['git', 'push', 'origin', ':refs/heads/gone'], 126, 126],
    [['git', 'push', 'origin', '--delete', 'gone'], 126, 126],
    [['git', 'push', '-d', 'origin', 'gone'], 126, 126],
    [['git', 'push', '--prune', 'origin', 'refs/heads/*:refs/heads/*'], 126, 126],
    // git takes abbreviated options; a push to another machine may use only
    // exact, harmless ones.
    ...['--del', '--pru', '--forc', '--mir', '--all', '--tags', '--no-verify'].map((o) => [['git', 'push', o, 'origin', 'HEAD:refs/heads/x'], 126, 126]),
    [['git', 'push', '-o', 'x', 'origin', 'HEAD:refs/heads/x'], 126, 126],
    [['git', 'push', 'origin', '--del', 'x'], 126, 126],
    [['git', 'push', '-u', 'origin', 'HEAD:refs/heads/ok'], 'net', 126],
    [['git', 'push', '--set-upstream', '-q', 'origin', 'HEAD:refs/heads/ok'], 'net', 126],
    // Configuration that turns a plain push into a mirror.
    ...['true', 'yes', 'on', '1'].flatMap((v) => [
      [['git', 'config', 'remote.origin.mirror', v], 0, 0],
      [['git', 'push', 'origin', 'HEAD:refs/heads/ok'], 126, 126],
      [['git', 'config', '--unset', 'remote.origin.mirror'], 0, 0],
    ]),
    [['git', 'push', 'origin', 'HEAD:refs/heads/ok'], NET, 126],
    [['git', 'push', 'origin', 'HEAD:refs/heads/forced', '--force'], 126, 126],
    [['git', '-C', wt, 'push', '--force-with-lease', 'origin', 'HEAD:refs/heads/forced'], 126, 126],
    [['git', 'push', 'origin', '+HEAD:refs/heads/forced'], 126, 126],
    [['git', '-c', 'alias.p=push', 'p', 'origin', 'HEAD:refs/heads/alias'], 126, 126],
    [['git', 'p'], 126, 126],
    [['gh', 'pr', 'view', '1'], 0, 0],
    [['gh', 'pr', 'create', '--fill'], 0, 126],
    [['gh', '--repo', 'o/r', 'pr', 'merge', '1'], 126, 126],
    [['gh', 'pr', '-R', 'o/r', 'merge', '1'], 126, 126],
    [['gh', 'pr', 'lock', '1'], 126, 126],
    [['gh', 'pr', 'update-branch', '1'], 126, 126],
    [['gh', 'cache', 'delete', 'x'], 126, 126],
    [['gh', 'co', '1'], 126, 126],
  ];
  for (const harness of ['claude', 'codex']) {
    for (const [rung, column] of [['hard', 1], ['small', 2]]) {
      isolated(h, rung, harness);
      spawn(h, u, rung, { STUB_RUN: JSON.stringify(cases.map((c) => c[0])) });
      const ran = u.report().ran;
      const codes = ran.map((r, i) => (cases[i][column] === NET && r.code !== 126 && r.code !== 0 ? NET : r.code));
      assert.deepEqual(codes, cases.map((c) => c[column]), `${harness} ${rung}: ${JSON.stringify(ran.map((r) => r.stderr))}`);
    }
  }
  // A mirror key with no value, which git reads as true.
  const config = path.join(h.repo, '.git', 'config');
  const before = fs.readFileSync(config, 'utf8');
  fs.appendFileSync(config, '[remote "origin"]\n\tmirror\n');
  isolated(h, 'hard', 'codex');
  spawn(h, u, 'hard', { STUB_RUN: JSON.stringify([['git', 'push', 'origin', 'HEAD:refs/heads/ok']]) });
  assert.deepEqual(u.report().ran.map((r) => r.code), [126], 'a valueless mirror key');
  fs.writeFileSync(config, before);
});

test('an isolated Codex worker can publish its task branch with an allow rule and guarded git', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const remote = path.join(h.base, 'publish.git');
  h.git(['init', '-q', '--bare', remote]);
  h.git(['remote', 'add', 'origin', remote]);
  const branch = h.git(['branch', '--show-current'], wt);
  isolated(h, 'hard', 'codex');
  spawn(h, u, 'hard', { STUB_RUN: JSON.stringify([
    ['git', 'push', '-u', 'origin', branch],
    ['git', 'push', '--force', 'origin', branch],
  ]) });
  const seen = u.report();
  assert.match(seen.rules.join('\n'), /pattern = \["git", "push"\],\n {4}decision = "allow"/);
  assert.match(seen.rules.join('\n'), /pattern = \["git", "push", "--force"\],\n {4}decision = "forbidden"/);
  assert.deepEqual(seen.ran.map((r) => r.code), [0, 126]);
  assert.equal(h.git(['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`]), h.git(['rev-parse', 'HEAD'], wt));
  spawn(h, u, 'review');
  assert.doesNotMatch(u.report().rules.join('\n'), /decision = "allow"/);
});

test('an isolated reviewer posts through gh, records evidence in a symlinked state dir and runs a git fixture', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  // The state directory reached through a symlink, as .tower-crane -> .gishra was.
  const realState = path.join(h.base, 'real-state');
  fs.renameSync(h.state, realState);
  fs.symlinkSync(realState, h.state);
  h.ok(['task', 'update', 'T1', '--kind', 'docs']);
  for (const name of ['easy', 'medium', 'hard', 'research']) {
    h.ok(['ladder', 'set', name, '--model', 'builder', '--clear', 'profile']);
  }
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker-T1-1']);
  const fixture = path.join(h.base, 'fixture');
  const run = [
    ['gh', 'pr', 'comment', '1', '--body', 'Review (tower-crane, clean context)'],
    [process.execPath, BIN, 'evidence', 'T1', '--type', 'review', '--ok', '--sha', 'abcdef1', '--summary', 'nothing blocks'],
    ['git', 'init', '-q', fixture],
    ['git', '-C', fixture, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'fixture'],
    ['git', 'init', '-q', '--bare', `${fixture}.git`],
    ['git', '-C', fixture, 'push', `${fixture}.git`, 'HEAD:refs/heads/main'],
  ];
  const real = fs.realpathSync(realState);
  for (const harness of ['claude', 'codex']) {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(`${fixture}.git`, { recursive: true, force: true });
    isolated(h, 'medium', harness);
    const dry = h.json(['spawn', '--role', 'review', '--task', 'T1', '--dry-run'], { env: u.env });
    assert.ok(!JSON.stringify(dry).includes('stub-gh-token'), 'the token is not in the command or its shown env');
    spawn(h, u, 'review', { STUB_RUN: JSON.stringify(run) });
    const seen = u.report();
    assert.deepEqual(seen.ran.map((r) => r.code), run.map(() => 0), `${harness}: ${JSON.stringify(seen.ran.map((r) => r.stderr))}`);
    if (harness === 'claude') assert.ok(seen.settings.sandbox.filesystem.allowWrite.includes(real), 'claude may write the real state dir');
    else assert.equal(seen.config.permissions['tower-crane'].filesystem[real], 'write', 'codex may write the real state dir');
  }
  assert.equal(h.json(['task', 'show', 'T1']).evidence.filter((e) => e.type === 'review').length, 2);
  for (const f of walk(realState)) assert.ok(!fs.readFileSync(f, 'utf8').includes('stub-gh-token'), `${f} holds the gh token`);
});

test('a gh token in the spawning environment passes through, and the keyring is asked only without one', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'medium', harness);
    spawn(h, u, 'review');
    assert.equal(u.report().ghToken, 'stub-gh-token', `${harness}: the keyring's token`);
    spawn(h, u, 'review', { GH_TOKEN: 'spawner-token' });
    assert.equal(u.report().ghToken, 'spawner-token', `${harness}: the spawner's own token`);
    spawn(h, u, 'review', { GITHUB_TOKEN: 'spawner-github-token' });
    assert.equal(u.report().ghToken, null, `${harness}: GITHUB_TOKEN is left for gh to read`);
  }
});

test('a push counts as local only when every URL git would use is local, so rewriting cannot reach another machine', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const local = path.join(h.base, 'local.git');
  h.git(['init', '-q', '--bare', local]);
  const away = 'https://127.0.0.1:9/away.git';
  // A fixture repo the agent may write, with a rewrite rule and a remote
  // whose second push URL is on another machine.
  const fx = path.join(h.base, 'fx');
  h.git(['init', '-q', fx]);
  h.git(['-C', fx, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  h.git(['-C', fx, 'remote', 'add', 'two', local]);
  h.git(['-C', fx, 'remote', 'set-url', '--add', '--push', 'two', local]);
  h.git(['-C', fx, 'remote', 'set-url', '--add', '--push', 'two', away]);
  h.git(['-C', fx, 'remote', 'add', 'loc', local]);
  h.git(['-C', fx, 'remote', 'add', 'up', away]);
  const rewritten = path.join(h.base, 'rewritten.git');
  const cases = [
    [['git', '-C', fx, 'push', local, '+HEAD:refs/heads/plain'], 0, 0],
    [['git', '-C', fx, 'push', 'loc', 'HEAD:refs/heads/named'], 0, 0],
    // An abbreviated option takes the next argument as its value; any option
    // voids the local exception, so `loc` cannot vouch for `up`.
    [['git', '-C', fx, 'push', '--push-opt', 'loc', 'up', 'HEAD:refs/heads/x', '--force'], 126, 126],
    [['git', '-C', fx, '-c', `url.${away}.insteadOf=${rewritten}`, 'push', rewritten, 'HEAD:refs/heads/x'], 126, 126],
    [['git', '-C', fx, '-c', 'remote.two.pushurl=' + away, 'push', 'two', 'HEAD'], 126, 126],
    [['git', '-C', fx, 'config', `url.${away}.insteadOf`, rewritten], 0, 0],
    [['git', '-C', fx, 'push', rewritten, '+HEAD:refs/heads/x'], 126, 126],
    [['git', '-C', fx, 'push', 'two', '+HEAD:refs/heads/x'], 126, 126],
    [['git', '-C', fx, 'config', '--unset', `url.${away}.insteadOf`], 0, 0],
    [['git', '-C', fx, 'config', `url.${away}.pushInsteadOf`, local], 0, 0],
    [['git', '-C', fx, 'push', local, '+HEAD:refs/heads/x'], 126, 126],
  ];
  for (const harness of ['claude', 'codex']) {
    for (const rung of ['hard', 'small']) {
      try {
        h.git(['-C', fx, 'config', '--unset-all', `url.${away}.pushInsteadOf`]);
      } catch {
        // Not set yet.
      }
      isolated(h, rung, harness);
      spawn(h, u, rung, { STUB_RUN: JSON.stringify(cases.map((c) => c[0])) });
      const ran = u.report().ran;
      assert.deepEqual(ran.map((r) => r.code), cases.map((c) => c[rung === 'hard' ? 1 : 2]), `${harness} ${rung}: ${JSON.stringify(ran.map((r) => r.stderr))}`);
    }
  }
});

test('a codex rework resumes in a fresh isolated home and finds its first session', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'medium', 'codex');
  const first = spawn(h, u, 'medium');
  const home = path.join(h.state, 'homes', first.agent);
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'PLANTED-BY-AGENT\n');
  h.ok(['claim', 'T1', '--agent', first.agent]);
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', first.agent]);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', 'abcdef1', '--agent', 'reviewer-T1-1', '--summary', 'redo']);
  h.ok(['rework', 'T1', '--reason', 'redo']);
  const next = spawn(h, u, 'medium');
  assert.equal(next.resumed, true);
  assert.equal(next.agent, first.agent);
  const seen = u.report();
  assert.ok(seen.resumed, 'codex runs exec resume');
  assert.equal(seen.home, path.join(home, 'home'), 'the resume runs in the agent\'s isolated home');
  assert.deepEqual(seen.sessions, [`rollout-${first.agent}.jsonl`], 'the first session is there');
  assert.ok(!seen.memory.join('\n').includes('PLANTED'), 'the home was rebuilt');
});

test('a spawn started inside another agent links to the user\'s own files, so removing the parent home breaks nothing', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'small', 'claude');
  const parent = path.join(h.state, 'homes', spawn(h, u, 'small').agent);
  // A spawned orchestrator runs with its own home in these variables.
  const inside = { CLAUDE_CONFIG_DIR: parent, HOME: path.join(parent, 'home'), USERPROFILE: path.join(parent, 'home') };
  const child = path.join(h.state, 'homes', spawn(h, u, 'small', inside).agent);
  for (const f of ['.credentials.json']) assert.equal(fs.readlinkSync(path.join(child, f)), path.join(u.home, '.claude', f), f);
  assert.equal(fs.readlinkSync(path.join(child, 'home', '.gitconfig')), path.join(u.home, '.gitconfig'));
  const helper = JSON.parse(fs.readFileSync(path.join(child, 'settings.json'), 'utf8')).apiKeyHelper;
  assert.ok(helper.includes(path.join(u.home, '.claude', 'settings.json')), 'the helper reads the user\'s settings');
  fs.rmSync(parent, { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(child, '.credentials.json'), 'utf8'), `{"token":"${SECRET}-CRED"}`, 'auth still resolves');
  assert.equal(cp.execSync(helper, { encoding: 'utf8', env: u.env }).trim(), `${SECRET}-HELPER`);
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

test('only the owner widens a rung, and args hold only allowlisted flags', (t) => {
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
  assert.equal(as('owner', ['--args', '["--verbose","--max-turns","40"]']).code, 0);
  const refused = [
    ['claude', '["--dangerously-skip-permissions"]'], ['claude', '["--settings","{}"]'], ['claude', '["--setting-sources=user,project"]'],
    ['codex', '["--sandbox","danger-full-access"]'], ['codex', '["-s","danger-full-access"]'], ['codex', '["-cmodel_verbosity=low"]'],
    ['codex', '["-c","sandbox_mode=\\"danger-full-access\\""]'], ['codex', '["--ignore-rules"]'], ['codex', '["--enable","x"]'],
  ];
  for (const [harness, args] of refused) {
    if (harness === 'codex') isolated(h, 'small', 'codex');
    const r = as('owner', ['--args', args]);
    assert.equal(r.code, 1, args);
    assert.match(r.stderr, /args may only use .*; refused /, args);
  }
  assert.equal(as('owner', ['--args', '["-c","model_reasoning_effort=\\"high\\"","--disable","memories","--skip-git-repo-check"]']).code, 0);
});

test('TOML tables have no prototype, so __proto__ and inherited names are plain keys', () => {
  const doc = TOML.parse('a.__proto__.polluted = true\nconstructor = 1\ntoString = 2\n[__proto__]\nx = 1\n[[b]]\n__proto__ = 3\n');
  assert.equal(({}).polluted, undefined, 'Object.prototype is untouched');
  assert.deepEqual(Object.keys(doc), ['a', 'constructor', 'toString', '__proto__', 'b']);
  assert.equal(doc.constructor, 1);
  assert.equal(Object.getPrototypeOf(doc), null);
  assert.equal(doc.a.__proto__.polluted, true);
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
    ];
    for (const d of derived) assert.ok(a.disallowedTools.includes(d), `${job}: disallowedTools lacks ${d}`);
    for (const g of a.ghWrite) assert.ok(!a.disallowedTools.includes(`Bash(gh ${g}:*)`), `${job}: ${g} is both allowed and denied`);
    assert.ok(A.policy(a).gh.includes('pr view') && a.ghWrite.every((g) => A.policy(a).gh.includes(g)), `${job}: the gh allowlist is reads plus ghWrite`);
  }
  // The parsed config the codex filter works on survives a round trip.
  const doc = TOML.parse('a = 1\n[b]\nc = { d = [1, "x"] }\n');
  assert.deepEqual(TOML.parse(TOML.stringify(doc)), doc);
});
