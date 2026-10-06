'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gishra.js');
const HOOKS = path.join(__dirname, 'fixtures', 'hooks.js');
const TMP_ROOT = process.env.GISHRA_TEST_TMP || os.tmpdir();

// Tests must not see the developer's git config (hooks, signing), an
// agent's GISHRA_* variables or the developer's own ladder defaults, so every
// child gets a clean, explicit env. The user file path is in the temp dir and
// absent until a test writes it.
function baseEnv(home) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GISHRA_') || k.startsWith('GIT_')) delete env[k];
  // Existing fixtures act as the owner, so they must provide that identity.
  env.GISHRA_AGENT = 'owner';
  env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GISHRA_CONFIG = path.join(home, 'user-config', 'config.json');
  return env;
}

function git(args, cwd, env) {
  return cp.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(t) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'gishra-')));
  fs.writeFileSync(
    path.join(base, 'gitconfig'),
    '[user]\n\tname = gishra test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  );
  const env = baseEnv(base);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo, env);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  git(['add', '.'], repo, env);
  git(['commit', '-q', '-m', 'init'], repo, env);
  const ctx = {
    base,
    repo,
    env,
    userConfig: env.GISHRA_CONFIG,
    state: path.join(repo, '.gishra'),
    detached: () => {
      const dir = path.join(base, 'detached');
      return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
    },
    cleanup: async () => {
      try { await stopDetached(ctx.detached()); }
      finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    },
    run: (args, opts = {}) => run(args, withHooks(ctx, opts)),
    runAsync: (args, opts = {}) => runAsync(args, withHooks(ctx, opts)),
    json: (args, opts) => {
      const r = ctx.run([...args, '--json'], opts);
      if (r.code !== 0) throw new Error(`gishra ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    ok: (args, opts) => {
      const r = ctx.run(args, opts);
      if (r.code !== 0) throw new Error(`gishra ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return r.stdout.trim();
    },
    readState: (file) => JSON.parse(fs.readFileSync(path.join(ctx.state, file), 'utf8')),
    writeState: (file, data) => fs.writeFileSync(path.join(ctx.state, file), JSON.stringify(data, null, 2) + '\n'),
    git: (args, cwd = repo) => git(args, cwd, env),
    init: (extra = []) => ctx.ok(['init', '--name', 'demo', '--goal', 'prove the engine', ...extra]),
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
  try { process.kill(child.pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
  if (process.platform === 'linux') {
    let stat;
    try { stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
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

module.exports = { makeRepo, run, runPty, PTY_AVAILABLE, runAsync, BIN, ROOT, HOOKS, real, TMP_ROOT, detachedAlive };
