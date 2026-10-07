'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tower-crane.js');
const HOOKS = path.join(__dirname, 'fixtures', 'hooks.js');
const TMP_ROOT = process.env.TOWER_CRANE_TEST_TMP || os.tmpdir();

// Tests must not see the developer's git config (hooks, signing), an
// agent's TOWER_CRANE_* variables or the developer's own ladder defaults, so every
// child gets a clean, explicit env. The user file path is in the temp dir and
// absent between calls unless a test writes it.
function baseEnv(home) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('TOWER_CRANE_') || k.startsWith('GIT_')) delete env[k];
  // Existing fixtures act as the owner, so they must provide that identity.
  env.TOWER_CRANE_AGENT = 'owner';
  env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.TOWER_CRANE_CONFIG = path.join(home, 'user-config', 'config.json');
  return env;
}

function git(args, cwd, env) {
  return cp.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixtureLadder() {
  return {
    harness: 'codex',
    ladder: {
      orchestrator: { harness: 'claude', model: 'fixture-large', effort: 'high' },
      easy: { profile: 'fixture-light', effort: 'medium' },
      medium: { profile: 'fixture-main', effort: 'high' },
      hard: { harness: 'claude', model: 'fixture-large', effort: 'high' },
      research: { harness: 'claude', model: 'fixture-large', effort: 'max' },
      review: { profile: 'fixture-main', effort: 'high' },
      small: { profile: 'fixture-light', effort: 'low' },
    },
  };
}

function pinRung(h, name, rung) {
  const args = ['ladder', 'set', name];
  for (const key of ['harness', 'model', 'profile', 'provider', 'effort', 'args', 'command']) {
    args.push(...(rung[key] === undefined ? ['--clear', key]
      : [`--${key}`, Array.isArray(rung[key]) ? JSON.stringify(rung[key]) : rung[key]]));
  }
  h.ok(args);
}

function pinLiveRung(h, harness) {
  const field = harness === 'codex' ? 'profile' : 'model';
  const variable = `TOWER_CRANE_LIVE_${field.toUpperCase()}`;
  assert.ok(process.env[variable], `set ${variable} to run a live ${harness} probe`);
  pinRung(h, 'small', { harness, [field]: process.env[variable] });
}

// Init copies defaults from the user layer. Seed that layer only for the call,
// so fixtures keep testing absent user files and later personal overrides.
function fixtureInit(ctx, args, opts, call) {
  if (args[0] !== 'init' || ctx.builtin) return call(args, opts);
  let original;
  try { original = fs.readFileSync(ctx.userConfig, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let user;
  try { user = original === undefined ? {} : JSON.parse(original); }
  catch { return call(args, opts); }
  if (!user || typeof user !== 'object' || Array.isArray(user)) return call(args, opts);
  if (user.ladder !== undefined && (!user.ladder || typeof user.ladder !== 'object' || Array.isArray(user.ladder))) return call(args, opts);
  const pinned = fixtureLadder();
  for (const [name, rung] of Object.entries(user.ladder || {})) {
    pinned.ladder[name] = rung && Object.keys(rung).every(k => k === 'fallbacks')
      ? { ...pinned.ladder[name], ...rung } : rung;
  }
  fs.mkdirSync(path.dirname(ctx.userConfig), { recursive: true });
  fs.writeFileSync(ctx.userConfig, JSON.stringify({ ...pinned, ...user, ladder: pinned.ladder }));
  try { return call(args, opts); }
  finally {
    if (original === undefined) fs.rmSync(ctx.userConfig);
    else fs.writeFileSync(ctx.userConfig, original);
  }
}

function makeRepo(t, options = {}) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-')));
  fs.writeFileSync(
    path.join(base, 'gitconfig'),
    '[user]\n\tname = tower-crane test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  );
  const env = baseEnv(base);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo, env);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  git(['add', '.'], repo, env);
  git(['commit', '-q', '-m', 'init'], repo, env);
  return context(t, base, options);
}

// A test context over a copy of another context's directory, for files that
// build one fixture and give each test its own copy instead of rebuilding it.
// Git and state paths still name the source; the caller repairs them.
function copyRepo(t, source) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-')));
  fs.cpSync(source, base, { recursive: true });
  return context(t, base);
}

function context(t, base, options = {}) {
  const env = baseEnv(base);
  const repo = path.join(base, 'repo');
  const ctx = {
    base,
    repo,
    env,
    builtin: options.builtin,
    userConfig: env.TOWER_CRANE_CONFIG,
    state: path.join(repo, '.tower-crane'),
    detached: () => {
      const dir = path.join(base, 'detached');
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
        try { return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]; }
        catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      }) : [];
    },
    cleanup: async () => {
      try { await stopDetached(ctx.detached()); }
      finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    },
    run: (args, opts = {}) => fixtureInit(ctx, args, opts, (a, o) => run(a, withHooks(ctx, o))),
    runAsync: (args, opts = {}) => runAsync(args, withHooks(ctx, opts)),
    json: (args, opts) => {
      const r = ctx.run([...args, '--json'], opts);
      if (r.code !== 0) throw new Error(`tower-crane ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    ok: (args, opts) => {
      const r = ctx.run(args, opts);
      if (r.code !== 0) throw new Error(`tower-crane ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return r.stdout.trim();
    },
    readState: (file) => JSON.parse(fs.readFileSync(path.join(ctx.state, file), 'utf8')),
    writeState: (file, data) => fs.writeFileSync(path.join(ctx.state, file), JSON.stringify(data, null, 2) + '\n'),
    git: (args, cwd = repo) => git(args, cwd, env),
    init: (extra = []) => ctx.ok(['init', '--name', 'demo', '--goal', 'prove the engine', ...(ctx.gateSettings || []), ...extra]),
  };
  if (t) t.after(ctx.cleanup);
  return ctx;
}

// opts.hooks preloads test/fixtures/hooks.js into the CLI with those HOOK_*
// variables, acting on this repository's state directory.
function withHooks(ctx, opts) {
  const env = { ...ctx.env, ...(opts.env || {}) };
  Object.assign(env, { HOOK_STATE: ctx.state, HOOK_PROCESSES_DIR: path.join(ctx.base, 'detached') }, opts.hooks);
  const pre = ['--require', HOOKS];
  return { cwd: ctx.repo, ...opts, env, pre };
}

function run(args, { cwd, env, input, pre = [], timeout = 60000 } = {}) {
  const r = cp.spawnSync(process.execPath, [...pre, BIN, ...args], { cwd, env, input, encoding: 'utf8', timeout });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

const PTY_AVAILABLE = process.platform === 'linux'
  && cp.spawnSync('script', ['--version'], { timeout: 10000 }).status === 0;

function runPty(args, { cwd, env, timeout = 10000 } = {}) {
  // script uses a shell, so quote each argument to preserve names and paths.
  const command = [process.execPath, BIN, ...args].map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(' ');
  const r = cp.spawnSync('script', ['-qec', command, '/dev/null'], { cwd, env, encoding: 'utf8', timeout });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

function runAsync(args, { cwd, env, pre = [] } = {}) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [...pre, BIN, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const real = (p) => fs.realpathSync.native(p);

function detachedAlive(child) {
  if (child.exited) return false;
  try { process.kill(child.pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
  if (process.platform === 'linux') {
    let stat;
    try { stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8'); }
    catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return false; throw e; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (['Z', 'X'].includes(fields[0]) || (child.startTicks && fields[19] !== child.startTicks)) return false;
  }
  return true;
}

function killDetached(child) {
  if (!detachedAlive(child)) return;
  if (process.platform === 'win32') {
    cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}

async function stopDetached(children) {
  const monitors = children.filter((c) => c.kind === 'monitor');
  try {
    for (const child of children.filter((c) => c.kind === 'worker')) killDetached(child);
    const deadline = Date.now() + 10000;
    while (monitors.some(detachedAlive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(monitors.filter(detachedAlive).map((c) => c.pid), [], 'detached usage monitors outlived test teardown');
  } finally {
    for (const monitor of monitors) killDetached(monitor);
    const deadline = Date.now() + 10000;
    while (monitors.some(detachedAlive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(monitors.every((c) => !detachedAlive(c)), 'usage monitors survived forced cleanup');
  }
}

module.exports = { makeRepo, copyRepo, fixtureLadder, pinRung, pinLiveRung, run, runPty, PTY_AVAILABLE, runAsync, BIN, ROOT, HOOKS, real, TMP_ROOT, detachedAlive };
