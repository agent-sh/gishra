'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');
const stub = path.join(__dirname, 'fixtures', 'agy-stub.js');
const noStub = process.platform === 'win32' && 'harness stub uses a shebang';

test('agy dry-run renders a config home and locks permission flags on every platform', t => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Agy dry-run', '--acceptance', 'render native isolation']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Render agy.\n' });
  h.ok(['ladder', 'set', 'medium', '--harness', 'agy', '--model', 'gemini-3-pro', '--clear', 'profile']);
  const dry = h.json(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(dry.env.HOME, path.join(dry.home.path, 'home'));
  if (process.platform === 'win32') assert.equal(dry.env.USERPROFILE, dry.env.HOME);
  assert.ok(dry.argv.includes('--sandbox'));
  assert.equal(dry.argv[dry.argv.indexOf('--agent') + 1], 'gishra-worker');
  for (const args of [['--agent', 'user-agent'], ['--add-dir', '..'], ['--dangerously-skip-permissions']]) {
    const refused = h.run(['ladder', 'set', 'medium', '--args', JSON.stringify(args)]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /args may only use/);
  }
});

function setup(t) {
  const h = makeRepo(t);
  const home = path.join(h.base, 'user');
  const put = (file, text) => {
    const at = path.join(home, file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text);
  };
  put('.gemini/config/mcp_config.json', JSON.stringify({ mcpServers: {
    planted: { command: 'planted-server', args: ['x'], env: { TOKEN: 'PLANTED-SECRET' } },
    approved: { serverUrl: 'https://example.invalid/mcp', headers: { Authorization: 'PLANTED-SECRET' } },
  } }));
  put('.gemini/GEMINI.md', 'PLANTED-MEMORY\n'.repeat(1000));
  put('.gemini/config/rules/user.md', '---\ntrigger: always_on\n---\nPLANTED-RULE\n'.repeat(1000));
  put('.gemini/antigravity-cli/settings.json', JSON.stringify({
    modelProvider: 'gemini',
    permissions: { allow: ['command(planted-rule)'] },
    hooks: { Stop: 'planted-hook' },
  }));
  put('.gemini/antigravity/mcp_oauth_tokens.json', '{"token":"PLANTED-SECRET"}');
  put('.gemini/antigravity-cli/plugins/planted/plugin.json', '{}');
  put('.gemini/config/hooks.json', '{"planted":"hook"}');
  put('.cache/keep', '');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'agy'), `#!${process.execPath}\nrequire(${JSON.stringify(stub)});\n`, { mode: 0o755 });
  const out = path.join(h.base, 'seen.json');
  const env = { ...h.env, HOME: home, USERPROFILE: home, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '',
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out };
  h.init();
  h.ok(['task', 'add', '--title', 'Agy isolation', '--acceptance', 'no user configuration loads']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Probe agy isolation.\n' });
  h.ok(['ladder', 'set', 'medium', '--harness', 'agy', '--model', 'gemini-3-pro', '--clear', 'profile', '--clear', 'args']);
  return { h, home, env, out, report: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('agy isolates planted user context and reports only house rules requested by path', { skip: noStub }, t => {
  const { h, home, env, report } = setup(t);
  const before = [];
  for (let n = 0; n < 3; n++) {
    const r = cp.spawnSync(process.execPath, [stub], { env, cwd: h.repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const seen = report();
    assert.ok(seen.memory.join('').includes('PLANTED-MEMORY'));
    assert.ok(seen.mcp.planted);
    assert.ok(seen.rules.allow.includes('command(planted-rule)'));
    before.push(seen.contextBytes);
  }
  const dry = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
  assert.deepEqual(dry.home.mcp, []);
  assert.ok(dry.argv.includes('--agent'));
  assert.ok(dry.argv.includes('--sandbox'));
  const spawned = h.json(['spawn', '--task', 'T1', '--wait'], { env });
  const seen = report();
  assert.equal(seen.home, path.join(h.state, 'homes', spawned.agent, 'home'));
  assert.deepEqual(seen.memory, []);
  assert.deepEqual(seen.mcp, {});
  assert.ok(!seen.rules.allow.includes('command(planted-rule)'));
  assert.ok(seen.rules.deny.includes('unsandboxed(*)'));
  assert.ok(seen.tools.includes('run_command'));
  assert.ok(!seen.tools.includes('search_web'));
  assert.ok(!seen.tools.includes('invoke_subagent'));
  assert.equal(seen.settings.modelProvider, 'gemini');
  assert.ok(!fs.existsSync(path.join(seen.home, '.gemini', 'config', 'hooks.json')));
  assert.ok(!fs.existsSync(path.join(seen.home, '.gemini', 'antigravity-cli', 'plugins')));
  assert.ok(seen.skills.every(s => s.endsWith('tower-crane-work')));
  const startup = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).find(e => e.cmd === 'startup').detail;
  assert.equal(startup.instructions_file, seen.agentFile);
  const global = startup.rules.find(r => r.path === path.join(home, '.gemini', 'GEMINI.md'));
  assert.equal(global.loaded, 'read');
  assert.ok(startup.rules.every(r => r.loaded === 'read'));
  const after = [];
  for (let n = 0; n < 3; n++) {
    const r = cp.spawnSync(process.execPath, [stub, '--agent', 'gishra-worker'], {
      cwd: h.repo, env: { ...env, HOME: seen.home, USERPROFILE: seen.home }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    after.push(report().contextBytes);
  }
  assert.ok(after[1] < before[1]);
  t.diagnostic(`agy startup config bytes: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
});

test('agy rung tool and MCP opt-ins render in dry-run and native config without copied secrets', { skip: noStub }, t => {
  const { h, home, env, report } = setup(t);
  h.ok(['ladder', 'set', 'medium', '--tools', '["search_web"]', '--mcp', '["approved"]'], { env });
  const dry = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
  assert.deepEqual(dry.home.tools, ['search_web']);
  assert.deepEqual(dry.home.mcp, ['approved']);
  h.json(['spawn', '--task', 'T1', '--wait'], { env });
  const seen = report();
  assert.ok(seen.tools.includes('search_web'));
  assert.deepEqual(seen.mcp, { approved: { serverUrl: 'https://example.invalid/mcp' } });
  assert.ok(seen.rules.allow.includes('mcp(approved/*)'));
  assert.equal(fs.realpathSync(path.join(seen.home, '.gemini', 'antigravity', 'mcp_oauth_tokens.json')),
    fs.realpathSync(path.join(home, '.gemini', 'antigravity', 'mcp_oauth_tokens.json')));
  assert.ok(!seen.agent.includes('PLANTED-SECRET'));
  const refused = h.run(['ladder', 'set', 'medium', '--args', '["--dangerously-skip-permissions"]'], { env });
  assert.notEqual(refused.code, 0);
});

test('agy small role denies file writes, push, gh writes and sandbox escape', { skip: noStub }, t => {
  const { h, env, report } = setup(t);
  h.ok(['ladder', 'set', 'small', '--harness', 'agy', '--model', 'gemini-3-pro', '--clear', 'profile', '--clear', 'args']);
  const spawned = h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait'], {
    env: { ...env, STUB_RUN: JSON.stringify([['git', 'push', '--force'], ['gh', 'pr', 'merge']]) },
  });
  const seen = report();
  assert.ok(seen.args.includes('gishra-small'));
  assert.ok(!seen.tools.includes('write_to_file'));
  assert.ok(!seen.tools.includes('replace_file_content'));
  assert.ok(seen.rules.deny.includes(`write_file(${spawned.cwd})`));
  assert.ok(seen.rules.deny.includes('command(git push)'));
  assert.ok(seen.rules.deny.includes('command(gh pr merge)'));
  assert.ok(seen.rules.deny.includes('unsandboxed(*)'));
  assert.ok(seen.ran.every(r => r.code !== 0 && /refus|allow|forbid/i.test(r.stderr)));
});

test('agy refuses workspace MCP and role overrides before starting the harness', { skip: noStub }, t => {
  const { h, env, out } = setup(t);
  const wt = h.json(['worktree', 'T1']).path;
  const config = path.join(wt, '.agents');
  fs.mkdirSync(path.join(config, 'agents'), { recursive: true });
  const mcp = path.join(config, 'mcp_config.json');
  fs.writeFileSync(mcp, '{"mcpServers":{"planted":{"command":"planted-server"}}}');
  let refused = h.run(['spawn', '--task', 'T1', '--wait'], { env });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /cannot load workspace/);
  assert.ok(!fs.existsSync(out));
  fs.rmSync(mcp);
  fs.writeFileSync(path.join(config, 'agents', 'gishra-worker.md'), 'override');
  refused = h.run(['spawn', '--task', 'T1', '--wait'], { env });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /workspace agent.*overrides/);
  assert.ok(!fs.existsSync(out));
});
