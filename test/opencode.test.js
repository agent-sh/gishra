'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const { promisify } = require('node:util');
const { makeRepo } = require('./helpers');
const A = require('../lib/agents');

const STUB = path.join(__dirname, 'fixtures', 'opencode-stub.js');
const NO_STUBS = process.platform === 'win32' && 'harness stub is a shebang script';

function setup(t, rung = 'medium', inheritedPathName = null) {
  const h = makeRepo(t);
  const home = path.join(h.base, 'user');
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const global = path.join(home, '.config', 'opencode');
  const memory = path.join(home, 'memory.md');
  const rules = path.join(global, 'rules', 'approved.json');
  const descriptions = path.join(home, 'mcp-tools.txt');
  put(memory, 'PLANTED-MEMORY\n' + 'm'.repeat(8192));
  put(descriptions, 'PLANTED-MCP\n' + 't'.repeat(4096));
  put(path.join(global, 'AGENTS.md'), 'OPENCODE-HOUSE-RULE\n');
  put(rules, '{"PLANTED-RULE":"allow"}\n');
  const userConfig = {
    instructions: [memory, rules], plugin: ['planted-plugin'],
    permission: { bash: { 'planted-command *': 'allow' } },
    mcp: { planted: { type: 'local', command: ['node', descriptions], enabled: true, environment: { TOKEN: 'PLANTED-SECRET' } } },
  };
  put(path.join(global, 'opencode.json'), JSON.stringify(userConfig));
  put(path.join(global, 'skills', 'planted', 'SKILL.md'), '---\nname: planted\ndescription: PLANTED-SKILL ' + 's'.repeat(512) + '\n---\nuser skill body\n');
  put(path.join(home, '.local', 'share', 'opencode', 'auth.json'), '{"fixture":{"type":"api","key":"PLANTED-SECRET"}}');
  put(path.join(h.base, 'AGENTS.md'), 'ANCESTOR-RULE\n');
  put(path.join(h.repo, 'AGENTS.md'), 'REPO-RULE\n');
  put(path.join(h.repo, 'CLAUDE.md'), 'REPO-CLAUDE-RULE\n');
  put(path.join(h.repo, 'opencode.json'), JSON.stringify({ instructions: [memory], mcp: { project: userConfig.mcp.planted }, plugin: ['project-plugin'] }));
  put(path.join(h.repo, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { directory: userConfig.mcp.planted } }));
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'fixture config']);
  h.init();
  h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'isolate opencode']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'probe\n' });
  h.ok(['ladder', 'set', rung, '--harness', 'opencode', '--model', 'fixture/model', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
  const bin = path.join(h.base, 'bin');
  put(path.join(bin, 'opencode'), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)});\n`);
  fs.chmodSync(path.join(bin, 'opencode'), 0o755);
  const out = path.join(h.base, 'stub.json');
  if (inheritedPathName) {
    const key = Object.keys(h.env).find((name) => name.toUpperCase() === 'PATH');
    if (key && key !== inheritedPathName) {
      h.env[inheritedPathName] = h.env[key];
      delete h.env[key];
    }
  }
  const pathKey = Object.keys(h.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...h.env, HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCODE_CONFIG: path.join(global, 'opencode.json'), OPENCODE_CONFIG_DIR: global,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(userConfig), OPENCODE_PERMISSION: '{"*":"allow"}',
    [pathKey]: `${bin}${path.delimiter}${h.env[pathKey] || ''}`, STUB_OUT: out, GH_TOKEN: 'fixture-gh',
  };
  return { h, home, env, out, rung, global, report: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

const dry = (f) => f.h.json(['spawn', '--task', 'T1', '--role', f.rung, '--dry-run'], { env: f.env });
const spawn = (f, env = {}) => f.h.ok(['spawn', '--task', 'T1', '--role', f.rung, '--wait'], { env: { ...f.env, ...env } });

test('opencode dry-run preserves Git lookup with an inherited mixed-case Path', (t) => {
  const f = setup(t, 'small', 'Path');
  // Node on Windows sorts environment keys and passes only the first
  // case-insensitive PATH entry. Reproduce that selection on POSIX too.
  const keys = Object.keys(f.env).filter((key) => key.toUpperCase() === 'PATH').sort();
  const env = { ...f.env };
  for (const key of keys) delete env[key];
  env.PATH = f.env[keys[0]];
  const preview = f.h.json(['spawn', '--task', 'T1', '--role', 'small', '--dry-run'], { env });
  assert.equal(preview.startup.target.id, 'T1');
  assert.ok(preview.argv.includes('gishra-small'));
});

test('opencode isolates config, memory, skills, MCP, approved rules and credentials; measures startup', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const before = [];
  const after = [];
  for (let i = 0; i < 3; i++) {
    const preview = dry(f);
    const baseline = cp.spawnSync(process.execPath, [STUB, ...preview.argv.slice(1)], { cwd: f.h.repo, env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(baseline.status, 0, baseline.stderr);
    const inherited = f.report();
    assert.ok(inherited.memory.join('').includes('PLANTED-MEMORY'));
    assert.ok(inherited.memory.join('').includes('PLANTED-RULE'));
    assert.equal(inherited.config.permission.bash['planted-command *'], 'allow');
    assert.ok(inherited.mcp.planted);
    before.push(inherited.context_bytes);
    spawn(f);
    const report = f.report();
    const own = path.dirname(report.home);
    assert.ok(own.startsWith(path.join(f.h.state, 'homes') + path.sep));
    assert.equal(report.name, 'gishra-worker');
    assert.ok(report.agent.startsWith('---\n'));
    assert.deepEqual(report.mcp, {});
    assert.deepEqual(report.memory, []);
    assert.deepEqual(report.skills, ['tower-crane-work']);
    assert.equal(report.config.plugin.length, 1);
    assert.ok(report.config.plugin[0].endsWith('/hook.mjs'));
    assert.ok(!JSON.stringify(report).includes('PLANTED-'));
    assert.equal(fs.statSync(report.authSource).ino, fs.statSync(path.join(f.home, '.local', 'share', 'opencode', 'auth.json')).ino);
    assert.deepEqual(report.authKinds, { fixture: 'api' });
    assert.ok(!fs.existsSync(path.join(own, 'rules', 'approved.json')));
    after.push(report.context_bytes);
  }
  assert.ok(Math.max(...after) < Math.min(...before));
  console.log('opencode startup bytes', JSON.stringify({ before, after }));
});

test('opencode excludes credential-triggered remote instructions, plugins and MCP at startup', { skip: NO_STUBS }, async (t) => {
  const f = setup(t);
  const instruction = path.join(f.h.base, 'remote-instructions.md');
  fs.writeFileSync(instruction, 'REMOTE-INSTRUCTION-CANARY\n');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/.well-known/opencode');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ config: {
      instructions: [instruction], plugin: ['remote-plugin-canary'],
      mcp: { remoteCanary: { type: 'local', command: ['node', 'remote-server-canary'], enabled: true } },
    } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const authPath = path.join(f.home, '.local', 'share', 'opencode', 'auth.json');
  const auth = {
    [url]: { type: 'wellknown', key: 'REMOTE_TOKEN', token: 'REMOTE-SECRET-CANARY' },
    fixture: { type: 'api', key: 'API-SECRET-CANARY' },
    oauth: { type: 'oauth', access: 'ACCESS-SECRET-CANARY', refresh: 'REFRESH-SECRET-CANARY', expires: 9999999999999 },
  };
  fs.writeFileSync(authPath, JSON.stringify(auth));
  const preview = dry(f);
  await promisify(cp.execFile)(process.execPath, [STUB, ...preview.argv.slice(1)], {
    cwd: f.h.repo, env: f.env, timeout: 10000,
  });
  const baseline = f.report();
  assert.ok(baseline.memory.some((text) => text.includes('REMOTE-INSTRUCTION-CANARY')));
  assert.ok(baseline.config.plugin.includes('remote-plugin-canary'));
  assert.ok(baseline.mcp.remoteCanary);
  assert.equal(requests, 1);
  const result = await f.h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  const report = f.report();
  assert.equal(requests, 1, 'isolated dispatch must not contact the remote configuration endpoint');
  assert.deepEqual(report.remoteContacts, []);
  assert.deepEqual(report.authKinds, { fixture: 'api', oauth: 'oauth' });
  assert.ok(!report.memory.some((text) => text.includes('REMOTE-INSTRUCTION-CANARY')));
  assert.ok(!report.config.plugin.includes('remote-plugin-canary'));
  assert.deepEqual(report.mcp, {});
  assert.equal(fs.statSync(report.authSource).ino, fs.statSync(authPath).ino);
  fs.writeFileSync(report.authPath, '{"oauth":{"type":"oauth","access":"refreshed"}}');
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath)), auth, 'agent auth writes must not alter the source credential store');
  const visible = JSON.stringify(preview) + result.stdout
    + fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8')
    + fs.readFileSync(path.join(path.dirname(report.home), 'opencode.json'), 'utf8');
  assert.ok(!visible.includes('SECRET-CANARY'));
  const inherited = await f.h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: { ...f.env, OPENCODE_AUTH_CONTENT: JSON.stringify(auth) },
  });
  assert.equal(inherited.code, 0, inherited.stderr);
  assert.equal(requests, 1, 'an inherited auth override must exclude remote discovery too');
  assert.deepEqual(f.report().authKinds, { fixture: 'api', oauth: 'oauth' });
  assert.ok(!JSON.stringify(dry(f)).includes('SECRET-CANARY'));
});

test('opencode research selects its role agent and permits native web tools', { skip: NO_STUBS }, (t) => {
  const f = setup(t, 'research');
  spawn(f, { STUB_PROBES: '[["webfetch","https://example.invalid"],["websearch","query"],["task","general"]]' });
  assert.equal(f.report().name, 'gishra-researcher');
  assert.deepEqual(f.report().probes, ['allow', 'allow', 'deny']);
});

test('a fallback into opencode receives filtered auth instead of restoring remote discovery', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const auth = {
    'http://127.0.0.1:1': { type: 'wellknown', key: 'REMOTE_TOKEN', token: 'FALLBACK-SECRET-CANARY' },
    fixture: { type: 'api', key: 'API-SECRET-CANARY' },
  };
  fs.writeFileSync(path.join(f.home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify(auth));
  fs.mkdirSync(path.dirname(f.h.userConfig), { recursive: true });
  fs.writeFileSync(f.h.userConfig, JSON.stringify({
    ladder: { medium: { fallbacks: [{ harness: 'opencode', model: 'fixture/model' }] } },
  }));
  const command = [process.execPath, '-e',
    'console.log(JSON.stringify({type:"turn.failed",error:{message:"HTTP 503 service unavailable"}}));process.exit(1)', '{prompt}'];
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify(command),
    '--clear', 'model', '--supervision', '{"retries":0,"backoff_ms":1,"max_backoff_ms":1}']);
  spawn(f);
  const report = f.report();
  assert.deepEqual(report.authKinds, { fixture: 'api' });
  assert.deepEqual(report.remoteContacts, []);
  const events = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((event) => event.cmd === 'spawn fallback' && event.detail.harness === 'opencode'));
  assert.ok(!JSON.stringify(events).includes('SECRET-CANARY'));
});

test('opencode renders worker path, web, skill, git and gh permission decisions', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const preview = dry(f);
  const probes = [
    ['webfetch', 'https://example.invalid'], ['task', 'general'], ['skill', 'planted'],
    ['skill', 'tower-crane-work'], ['edit', path.join(preview.cwd, 'src', 'file.js')],
    ['edit', path.join(f.home, 'outside.js')], ['external_directory', '/unapproved/location/*'],
    ['bash', 'git push origin HEAD'], ['bash', 'git push --force origin HEAD'],
    ['bash', 'gh pr create --title probe'], ['bash', 'gh pr merge 1'], ['bash', 'gh issue list'],
    ['edit', '..\\unapproved\\outside.js'], ['edit', 'C:/unapproved/outside.js'],
  ];
  spawn(f, { STUB_PROBES: JSON.stringify(probes) });
  assert.deepEqual(f.report().probes, ['deny', 'deny', 'deny', 'allow', 'allow', 'deny', 'deny', 'allow', 'deny', 'allow', 'deny', 'allow', 'deny', 'deny']);
  assert.equal(preview.env.TOWER_CRANE_SANDBOX, '0');
  assert.equal(A.sandboxed('worker', 'opencode'), false);
  assert.ok(preview.startup.instructions_file.endsWith('/agents/gishra-worker.md'));
  assert.ok(preview.startup.rules.some((rule) => rule.path === path.join(f.global, 'AGENTS.md')));
  assert.ok(preview.startup.rules.every((rule) => rule.loaded === 'read'));
  const events = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const receipt = events.findLast((event) => event.cmd === 'startup').detail;
  assert.ok(receipt.rules.every((rule) => rule.loaded === 'read'));
  assert.match(preview.argv.find((arg) => arg.includes('## Task')), /REPO-RULE|AGENTS\.md/);
});

test('opencode rung tool and MCP opt-ins appear in dry-run and exclude copied secrets', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  f.h.ok(['ladder', 'set', 'medium', '--tools', '["WebFetch","websearch"]', '--mcp', '["planted"]']);
  const preview = dry(f);
  assert.deepEqual(preview.home.tools, ['WebFetch', 'websearch']);
  assert.deepEqual(preview.home.mcp, ['planted']);
  assert.match(f.h.ok(['spawn', '--task', 'T1', '--dry-run'], { env: f.env }), /MCP servers: planted; opted-in tools: WebFetch, websearch/);
  spawn(f, { STUB_PROBES: '[["webfetch","https://example.invalid"],["websearch","query"],["planted_search","query"]]' });
  const report = f.report();
  assert.deepEqual(report.probes, ['allow', 'allow', 'allow']);
  assert.deepEqual(report.mcp.planted, { type: 'local', command: ['node', path.join(f.home, 'mcp-tools.txt')], enabled: true });
  assert.ok(!JSON.stringify(report.config).includes('PLANTED-SECRET'));
  f.h.ok(['ladder', 'set', 'medium', '--mcp', '["missing"]']);
  assert.match(f.h.run(['spawn', '--task', 'T1', '--dry-run'], { env: f.env }).stderr, /missing.*defines no|missing.*define none/);
});

test('opencode reads JSONC opt-ins and provider choices without user plugins or provider secrets', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.global, 'opencode.jsonc'), `{
    // User-selected connection and model, with trailing commas.
    "provider": { "fixture": { "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://provider.invalid/v1", "apiKey": "PLANTED-SECRET", }, }, },
    "mcp": { "docs": { "type": "remote", "url": "https://docs.invalid/mcp",
      "headers": { "Authorization": "PLANTED-SECRET" }, "enabled": false, }, },
  }`);
  f.h.ok(['ladder', 'set', 'medium', '--mcp', '["docs"]']);
  spawn(f);
  const report = f.report();
  assert.deepEqual(report.config.provider.fixture.options, { baseURL: 'https://provider.invalid/v1' });
  assert.deepEqual(report.mcp.docs, { type: 'remote', url: 'https://docs.invalid/mcp', enabled: true });
  const own = path.dirname(report.home);
  const nested = f.h.json(['spawn', '--task', 'T1', '--dry-run'], { env: {
    ...f.env, HOME: report.home, USERPROFILE: report.home, OPENCODE_TEST_HOME: report.home,
    OPENCODE_CONFIG_DIR: own, OPENCODE_CONFIG: path.join(own, 'opencode.json'), OPENCODE_CONFIG_CONTENT: '{}',
    XDG_CONFIG_HOME: path.join(own, 'config'), XDG_DATA_HOME: path.join(own, 'data'),
  } });
  assert.ok(nested.startup.rules.some((rule) => rule.path === path.join(f.global, 'AGENTS.md')));
  assert.deepEqual(nested.home.mcp, ['docs']);
});

test('opencode recursively merges partial provider and MCP overrides across config layers', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const base = {
    provider: { fixture: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://provider.invalid/v1', timeout: 1000, apiKey: 'PLANTED-SECRET' },
      models: { fixture: { limit: { context: 32000, output: 2000 } } },
    } },
    mcp: {
      docs: { type: 'local', command: ['node', 'base-server.js'], environment: { TOKEN: 'PLANTED-SECRET' } },
      remote: { type: 'remote', url: 'https://docs.invalid/mcp', headers: { Authorization: 'PLANTED-SECRET' } },
    },
  };
  fs.writeFileSync(path.join(f.global, 'opencode.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(f.global, 'opencode.jsonc'), JSON.stringify({
    provider: { fixture: { options: { timeout: 2000 }, models: { fixture: { limit: { output: 4000 } } } } },
    mcp: { docs: { enabled: false }, remote: { timeout: 3000 } },
  }));
  const custom = path.join(f.h.base, 'custom-opencode.json');
  fs.writeFileSync(custom, JSON.stringify({
    provider: { fixture: { options: { baseURL: 'https://override.invalid/v1' } } },
    mcp: { docs: { command: ['node', 'override-server.js'] } },
  }));
  const extra = path.join(f.h.base, 'extra-opencode');
  fs.mkdirSync(extra);
  fs.writeFileSync(path.join(extra, 'opencode.json'), JSON.stringify({
    provider: { fixture: { options: { maxRetries: 2 } } },
    mcp: { remote: { timeout: 4000 } },
  }));
  f.env.OPENCODE_CONFIG = custom;
  f.env.OPENCODE_CONFIG_DIR = extra;
  f.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    provider: { fixture: { options: { timeout: 5000 } } },
    mcp: { docs: { enabled: true }, remote: { enabled: true } },
  });
  f.h.ok(['ladder', 'set', 'medium', '--mcp', '["docs","remote"]']);
  assert.deepEqual(dry(f).home.mcp, ['docs', 'remote']);
  spawn(f);
  const report = f.report();
  assert.deepEqual(report.config.provider.fixture, {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: 'https://override.invalid/v1', timeout: 5000, maxRetries: 2 },
    models: { fixture: { limit: { context: 32000, output: 4000 } } },
  });
  assert.deepEqual(report.mcp, {
    docs: { type: 'local', command: ['node', 'override-server.js'], enabled: true },
    remote: { type: 'remote', url: 'https://docs.invalid/mcp', timeout: 4000, enabled: true },
  });
  assert.ok(!JSON.stringify(report.config).includes('PLANTED-SECRET'));
});

test('opencode small denies edits, publishing and skills; args cannot override isolation', (t) => {
  const f = setup(t, 'small');
  const preview = dry(f);
  assert.ok(preview.argv.includes('--agent'));
  assert.equal(preview.argv[preview.argv.indexOf('--agent') + 1], 'gishra-small');
  assert.notEqual(preview.env.HOME, f.home);
  assert.equal(preview.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(preview.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, '0');
  assert.equal(preview.env.OPENCODE_PURE, '0');
  assert.equal(preview.startup.rules.every((rule) => rule.loaded === 'read'), true);
  const permissions = JSON.parse(preview.env.OPENCODE_PERMISSION);
  assert.equal(permissions.edit, 'deny');
  assert.equal(permissions.skill, 'deny');
  assert.equal(permissions.bash['git push *'], 'deny');
  assert.equal(permissions.bash['gh pr create *'], undefined);
  for (const args of [['--agent', 'build'], ['--attach', 'http://example.invalid'], ['--auto']]) {
    const rejected = f.h.run(['ladder', 'set', 'small', '--args', JSON.stringify(args)]);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /args may only use/);
  }
});
