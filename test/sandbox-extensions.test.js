'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeRepo } = require('./helpers');
const TOML = require('../lib/toml');

const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';
const SECRET_KEY = 'TC_PRIVATE_ENV_FILE_KEY';
const SECRET = 'private-file-value $literal `literal`';

function setup(t, harness = 'codex') {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Toolchain probe', '--acceptance', 'lock written']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'probe' });
  h.ok(['ladder', 'set', 'medium', '--harness', harness,
    ...(harness === 'codex' ? ['--profile', 'sol', '--clear', 'model'] : ['--model', 'opus', '--clear', 'profile']),
    '--clear', 'effort', '--clear', 'args']);
  return h;
}

function noFileSecrets(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) noFileSecrets(file);
    else if (entry.isFile()) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes(SECRET_KEY), `${file} contains the file key`);
      assert.ok(!text.includes(SECRET), `${file} contains the file value`);
    }
  }
}

test('project and rung spawn settings require explicit owner identity, including unchanged and cleared fields', (t) => {
  const h = setup(t);
  const changes = [['--sandbox', '{"write":["~/.cargo"]}'], ['--env', '{"CARGO_HOME":"/toolchain"}'], ['--env_file', '/private.env']];
  for (const flags of changes) {
    const before = fs.readFileSync(path.join(h.state, 'project.json'), 'utf8');
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    for (const cmd of [['project', 'set'], ['ladder', 'set', 'medium']]) {
      const r = h.run([...cmd, ...flags, '--agent', 'worker-T1-1']);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /only the owner/);
    }
    assert.equal(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
    h.ok(['project', 'set', ...flags]);
    h.ok(['ladder', 'set', 'medium', ...flags]);
    assert.equal(h.run(['project', 'set', ...flags, '--agent', 'worker-T1-1']).code, 1);
    assert.equal(h.run(['project', 'set', flags[0], 'null', '--agent', 'worker-T1-1']).code, 1);
    assert.equal(h.run(['ladder', 'set', 'medium', '--clear', flags[0].slice(2), '--agent', 'worker-T1-1']).code, 1);
  }
  const fresh = makeRepo(t);
  const r = fresh.run(['init', '--name', 'test', '--goal', 'test', '--env', '{}', '--agent', 'worker-T1-1']);
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(fresh.state), false);
});

test('spawn settings reject invalid shapes and reserved identities without partial writes', (t) => {
  const h = setup(t);
  for (const flags of [
    ['--sandbox', '{"write":"~/.cargo"}'], ['--sandbox', '{"user_bus":1}'], ['--sandbox', '{"other":true}'],
    ['--env', '{"CARGO_HOME":1}'], ['--env', '{"HOME":"/tmp"}'], ['--env', '{"TOWER_CRANE_AGENT":"owner"}'],
    ['--env_file', ''], ['--env', '{"BAD-NAME":"value"}'], ['--sandbox', '{"write":[""]}'],
  ]) {
    const before = fs.readFileSync(path.join(h.state, 'project.json'), 'utf8');
    assert.equal(h.run(['project', 'set', '--name', 'changed', ...flags]).code, 2, flags.join(' '));
    assert.equal(h.run(['ladder', 'set', 'medium', ...flags]).code, 2, flags.join(' '));
    assert.equal(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8'), before);
  }
});

for (const harness of ['codex', 'claude']) {
  test(`${harness}: toolchain env, writable cache, quoted env file and rung overrides reach only the agent`, { skip: NO_STUBS }, (t) => {
    const h = setup(t, harness);
    const home = path.join(h.base, 'user-home');
    const cargo = path.join(home, '.cargo');
    const realCargo = path.join(h.base, 'cargo-cache');
    const rustup = path.join(home, '.rustup');
    fs.mkdirSync(home);
    fs.mkdirSync(realCargo);
    fs.symlinkSync(realCargo, cargo, 'dir');
    fs.mkdirSync(rustup);
    fs.writeFileSync(path.join(rustup, 'toolchain'), 'toolchain');
    const file = path.join(home, 'private.env');
    fs.writeFileSync(file, [
      '# comment', '; comment', `${SECRET_KEY}='${SECRET}'`, 'EMPTY=',
      'DOUBLE="a \\"quote\\" \\\\ \\$dollar \\`tick\\` \\q"',
      'SINGLE=\'two', 'lines \\ literal\'', 'JOIN=first\\', 'second',
      'UNQUOTED=  hello\\ world "literal"  ', 'ESCAPED_SPACE=kept\\ ', 'FROM_FILE=original', 'COMMON=from-file', '',
    ].join('\n'));
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    const out = path.join(h.base, 'result.json');
    const stub = [
      `#!${process.execPath}`, "'use strict';",
      'const fs = require("node:fs"), path = require("node:path");',
      'if (process.env.CARGO_HOME !== process.env.EXPECT_CARGO || process.env.RUSTUP_HOME !== process.env.EXPECT_RUSTUP) throw new Error("toolchain homes not found");',
      'if (fs.readFileSync(path.join(process.env.RUSTUP_HOME, "toolchain"), "utf8") !== "toolchain") throw new Error("missing toolchain");',
      'const lock = path.join(process.env.CARGO_HOME, ".package-cache");',
      'fs.closeSync(fs.openSync(lock, "wx"));',
      `const values = Object.fromEntries(${JSON.stringify([SECRET_KEY, 'EMPTY', 'DOUBLE', 'SINGLE', 'JOIN', 'UNQUOTED', 'ESCAPED_SPACE', 'COMMON', 'FROM_FILE', 'RUNG_ONLY'])}.map(k => [k, process.env[k]]));`,
      'const dir = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR;',
      'const config = fs.readFileSync(path.join(dir, process.env.CODEX_HOME ? "config.toml" : "settings.json"), "utf8");',
      `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({values, config}));`,
      'console.log("toolchain probe passed");', '',
    ].join('\n');
    fs.writeFileSync(path.join(bin, harness), stub, { mode: 0o755 });
    const env = { ...h.env, HOME: home, USERPROFILE: home, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, EXPECT_CARGO: cargo, EXPECT_RUSTUP: rustup };
    h.ok(['project', 'set', '--sandbox', '{"write":["~/.cargo","~/.cargo/missing/cache"]}', '--env', JSON.stringify({ CARGO_HOME: cargo, RUSTUP_HOME: '/wrong', COMMON: 'project' }), '--env_file', '~/private.env']);
    h.ok(['ladder', 'set', 'medium', '--env', JSON.stringify({ RUSTUP_HOME: rustup, COMMON: 'rung', RUNG_ONLY: 'yes' })]);
    const dry = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
    assert.ok(!JSON.stringify(dry).includes(SECRET_KEY));
    assert.ok(!JSON.stringify(dry).includes(SECRET));
    // A dry-run must not even read the file.
    fs.renameSync(file, `${file}.saved`);
    h.ok(['spawn', '--task', 'T1', '--dry-run'], { env });
    fs.renameSync(`${file}.saved`, file);
    const result = h.run(['spawn', '--task', 'T1', '--wait'], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(cargo, '.package-cache')), true);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(seen.values, {
      [SECRET_KEY]: SECRET, EMPTY: '', DOUBLE: 'a "quote" \\ $dollar `tick` \\q',
      SINGLE: 'two\nlines \\ literal', JOIN: 'firstsecond', UNQUOTED: 'hello world "literal"',
      ESCAPED_SPACE: 'kept ', FROM_FILE: 'original', COMMON: 'rung', RUNG_ONLY: 'yes',
    });
    for (const granted of [realCargo, path.join(realCargo, 'missing', 'cache')]) {
      if (harness === 'codex') assert.equal(TOML.parse(seen.config).permissions['tower-crane'].filesystem[granted], 'write');
      else assert.ok(JSON.parse(seen.config).sandbox.filesystem.allowWrite.includes(granted));
    }
    if (harness === 'codex') assert.equal(TOML.parse(seen.config).permissions['tower-crane'].network.enabled, true);
    else assert.equal(JSON.parse(seen.config).sandbox.network.allowLocalBinding, true);
    const other = path.join(home, 'other.env');
    fs.writeFileSync(other, `${SECRET_KEY}='${SECRET}'\nFROM_FILE=replacement\n`);
    h.ok(['ladder', 'set', 'medium', '--env_file', '~/other.env']);
    fs.rmSync(file);
    fs.rmSync(path.join(cargo, '.package-cache'));
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).values.FROM_FILE, 'replacement');
    noFileSecrets(h.state);
    assert.ok(!result.stdout.includes(SECRET_KEY) && !result.stderr.includes(SECRET));
  });
}

test('session bus opt-in gives both harnesses the runtime path and environment; a rung can disable it', { skip: NO_STUBS || (process.platform !== 'linux' && 'Linux user session') }, (t) => {
  const h = setup(t);
  const runtime = path.join(h.base, 'runtime');
  fs.mkdirSync(runtime);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'bus.json');
  const env = { ...h.env, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', PATH: `${bin}${path.delimiter}${process.env.PATH}`, XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtime, 'bus')}` };
  for (const harness of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, harness), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  runtime: process.env.XDG_RUNTIME_DIR, bus: process.env.DBUS_SESSION_BUS_ADDRESS,
  config: fs.readFileSync(path.join(dir, process.env.CODEX_HOME ? 'config.toml' : 'settings.json'), 'utf8')
}));
`, { mode: 0o755 });
    h.ok(['ladder', 'set', 'medium', '--harness', harness,
      ...(harness === 'codex' ? ['--profile', 'sol', '--clear', 'model'] : ['--model', 'opus', '--clear', 'profile'])]);
    h.ok(['project', 'set', '--sandbox', '{"user_bus":true}']);
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(seen.runtime, runtime);
    assert.equal(seen.bus, env.DBUS_SESSION_BUS_ADDRESS);
    if (harness === 'codex') assert.equal(TOML.parse(seen.config).permissions['tower-crane'].filesystem[runtime], 'write');
    else {
      const box = JSON.parse(seen.config).sandbox.filesystem;
      assert.ok(box.allowWrite.includes(runtime));
      assert.ok(!box.denyRead.includes(runtime) && !box.denyRead.includes(`/run/user/${process.getuid()}`));
    }
    h.ok(['ladder', 'set', 'medium', '--sandbox', '{"user_bus":false,"write":[]}']);
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    const off = JSON.parse(fs.readFileSync(out, 'utf8'));
    if (harness === 'codex') assert.equal(TOML.parse(off.config).permissions['tower-crane'].filesystem[runtime], undefined);
    else assert.ok(JSON.parse(off.config).sandbox.filesystem.denyRead.includes(runtime));
    h.ok(['ladder', 'set', 'medium', '--clear', 'sandbox']);
  }
});

test('invalid or unreadable env files fail without echoing their contents', { skip: NO_STUBS }, (t) => {
  const h = setup(t);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const file = path.join(h.base, 'private.env');
  h.ok(['project', 'set', '--env_file', file]);
  for (const text of [null, `${SECRET_KEY}="${SECRET}`, `${SECRET_KEY}='${SECRET}' trailing`, `HOME='${SECRET}'`]) {
    if (text !== null) fs.writeFileSync(file, text);
    const r = h.run(['spawn', '--task', 'T1', '--wait'], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(r.code, 1, r.stderr);
    assert.ok(!r.stderr.includes(SECRET_KEY) && !r.stderr.includes(SECRET));
    noFileSecrets(h.state);
  }
});

test('real Codex worker writes the toolchain lock, receives a private env file, serves loopback and starts a user scope', {
  skip: process.env.TOWER_CRANE_LIVE_CODEX !== '1' && 'set TOWER_CRANE_LIVE_CODEX=1 to run a real Codex worker',
  timeout: 240000,
}, async (t) => {
  const fixtureRoot = process.env.TOWER_CRANE_TEST_TMP;
  const inside = (dir, target) => {
    const rel = path.relative(path.resolve(dir), path.resolve(target));
    return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  };
  assert.ok(fixtureRoot && ![os.tmpdir(), '/tmp', process.env.XDG_CACHE_HOME || path.join(require('../lib/agents').origin(process.env).home, '.cache')]
    .some((dir) => inside(dir, fixtureRoot)), 'set TOWER_CRANE_TEST_TMP outside the standard writable temp and cache directories so the live lock proves the extra write grant');
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Live sandbox probe', '--acceptance', 'probe succeeds']);
  const cargo = path.join(h.base, 'cargo');
  const rustup = path.join(h.base, 'rustup');
  fs.mkdirSync(cargo);
  fs.mkdirSync(rustup);
  fs.writeFileSync(path.join(rustup, 'toolchain'), 'toolchain');
  const file = path.join(h.base, 'private.env');
  fs.writeFileSync(file, `${SECRET_KEY}='${SECRET}'\n`, { mode: 0o600 });
  const out = path.join(h.state, 'live-result.json');
  const script = path.join(h.base, 'cargo-probe.js');
  const privateTmp = path.join(h.base, 'agent-tmp');
  fs.mkdirSync(privateTmp, { mode: 0o700 });
  const userBus = process.platform === 'linux' && fs.existsSync(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`);
  fs.writeFileSync(script, [
    "'use strict';",
    'const fs = require("node:fs"), path = require("node:path"), net = require("node:net"), cp = require("node:child_process");',
    `if (process.env[${JSON.stringify(SECRET_KEY)}] !== ${JSON.stringify(SECRET)}) throw new Error("private environment missing");`,
    `if (process.env.CARGO_HOME !== ${JSON.stringify(cargo)} || process.env.RUSTUP_HOME !== ${JSON.stringify(rustup)}) throw new Error("toolchain homes missing");`,
    'if (fs.readFileSync(path.join(process.env.RUSTUP_HOME, "toolchain"), "utf8") !== "toolchain") throw new Error("toolchain missing");',
    'fs.closeSync(fs.openSync(path.join(process.env.CARGO_HOME, ".package-cache"), "wx"));',
    'let denied = false;',
    'try { fs.writeFileSync(path.join(process.env.RUSTUP_HOME, "unconfigured-write"), "unexpected"); }',
    'catch (e) { if (!["EACCES", "EPERM", "EROFS"].includes(e.code)) throw e; denied = true; }',
    'if (!denied) throw new Error("sandbox permitted an unconfigured toolchain write");',
    `if (${userBus}) {`,
    '  const r = cp.spawnSync("systemd-run", ["--user", "--scope", "--quiet", process.execPath, "-e", "process.exit(0)"], {encoding: "utf8", timeout: 10000});',
    '  if (r.status !== 0) throw new Error("user scope failed: " + r.stderr);',
    '}',
    'const server = net.createServer(c => c.end("loopback"));',
    'const deadline = setTimeout(() => { console.error("loopback timeout"); process.exit(1); }, 10000);',
    'server.on("error", e => { throw e; });',
    'server.listen(0, "127.0.0.1", () => {',
    '  let text = "";',
    '  const client = net.connect(server.address().port, "127.0.0.1");',
    '  client.on("error", e => { throw e; });',
    '  client.on("data", d => { text += d; });',
    '  client.on("end", () => {',
    '    if (text !== "loopback") throw new Error("loopback response failed");',
    `    fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({toolchain: true, privateEnv: true, loopback: true, userScope: ${userBus}}));`,
    '    clearTimeout(deadline); server.close(); console.log("sandbox probe passed");',
    '  });',
    '});', '',
  ].join('\n'));
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [cargo], user_bus: userBus }),
    '--env', JSON.stringify({ CARGO_HOME: cargo, RUSTUP_HOME: rustup }), '--env_file', file]);
  h.ok(['ladder', 'set', 'medium', '--harness', 'codex', '--profile', process.env.TOWER_CRANE_LIVE_PROFILE || 'sol',
    '--clear', 'model', '--clear', 'effort', '--supervision', '{"retries":0}']);
  h.ok(['brief', 'set', 'T1', '-'], {
    input: `This task is a live sandbox verification fixture. Run exactly this command with your command tool, then report its exit code and stop. Do not read the script or private environment file, print environment variables, change files, use tower-crane, open a PR or delegate work.\n\n${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`,
  });
  const dry = h.ok(['spawn', '--task', 'T1', '--dry-run']);
  assert.ok(!dry.includes(SECRET_KEY) && !dry.includes(SECRET));
  const result = await h.runAsync(['spawn', '--task', 'T1', '--wait'], { env: { TMPDIR: privateTmp } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(out), true, result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { toolchain: true, privateEnv: true, loopback: true, userScope: userBus });
  assert.equal(fs.existsSync(path.join(cargo, '.package-cache')), true);
  noFileSecrets(h.state);
  assert.ok(!result.stdout.includes(SECRET_KEY) && !result.stderr.includes(SECRET));
});
